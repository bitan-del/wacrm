import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { connectCall } from '@/lib/whatsapp/calling-api'
import {
  callingErrorResponse,
  explainCallingError,
  loadCallingConfig,
  withRecordingFallback,
} from '@/lib/whatsapp/calling-server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { aiCallingReady, aiEventsCallbackUrl, loadCallAiConfig } from '@/lib/whatsapp/call-ai'
import { createVoiceSession, endVoiceSession, voiceServerConfig } from '@/lib/whatsapp/voice-server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls — place a call to a customer.
 *
 * Body: { conversation_id, sdp } where `sdp` is the WebRTC offer the
 * agent's browser produced — or { conversation_id, ai: true } to have the
 * AI agent place the call (the voice server produces the offer and does
 * the talking). The row is inserted first and its id sent
 * to Meta as `biz_opaque_callback_data`, so Meta's SDP answer (which can
 * arrive before Meta's call id is stored) still finds the row.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, account } = await requireRole('agent')

    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      conversation_id?: unknown
      sdp?: unknown
      ai?: unknown
    } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    const byAi = body?.ai === true
    const browserSdp = typeof body?.sdp === 'string' ? body.sdp : ''
    if (!conversationId || (!byAi && !browserSdp.trim())) {
      return NextResponse.json({ error: t('badRequest') }, { status: 400 })
    }

    const ai = byAi ? await loadCallAiConfig(supabase, accountId) : null
    const voice = voiceServerConfig()
    if (byAi && (!aiCallingReady(ai) || !voice)) {
      return NextResponse.json({ error: t('aiNotReady') }, { status: 400 })
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact_id, contact:contacts(id, name, phone, wa_user_id)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: t('conversationNotFound') }, { status: 404 })
    }
    const contact = (conversation as unknown as {
      contact: { id: string; name: string | null; phone: string | null; wa_user_id: string | null } | null
    }).contact
    const target = resolveContactSendTarget(contact)
    if (!contact || !target) {
      return NextResponse.json({ error: t('noRecipient') }, { status: 400 })
    }

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }

    // One live call per customer at a time — Meta enforces it too
    // (138003), but checking here gives a clearer message.
    const { data: live } = await supabase
      .from('calls')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .in('status', ['dialing', 'ringing', 'answering', 'in_progress'])
      .limit(1)
    if (live && live.length > 0) {
      return NextResponse.json({ error: t('alreadyInCall') }, { status: 409 })
    }

    const { data: row, error: insertError } = await supabase
      .from('calls')
      .insert({
        account_id: accountId,
        phone_number_id: config.phoneNumberId,
        contact_id: contact.id,
        conversation_id: conversation.id,
        direction: 'outbound',
        status: 'dialing',
        customer_wa_id: target.target,
        placed_by: userId,
        handled_by_ai: byAi,
      })
      .select('*')
      .single()
    if (insertError || !row) {
      console.error('[calls] could not create outbound call row:', insertError?.message)
      return NextResponse.json({ error: t('unexpected') }, { status: 500 })
    }

    try {
      // The offer comes from the agent's browser, or from the voice
      // server when the AI is placing the call.
      const sdp =
        byAi && ai && voice
          ? await createVoiceSession(voice, {
              sessionId: row.id,
              direction: 'outbound',
              persona: ai.persona,
              context: {
                customer_name: contact.name?.trim() || undefined,
                customer_phone: contact.phone || target.target,
                business_name: account.name,
              },
              geminiApiKey: ai.geminiApiKey as string,
              callbackUrl: aiEventsCallbackUrl(),
            })
          : browserSdp
      const [waCallId, recorded] = await withRecordingFallback(config.recording, (recording) =>
        connectCall({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          to: target.target,
          sdp,
          callbackData: row.id,
          recording,
        }),
      )
      // Service role: the webhook may already be moving this row, and
      // this write must land regardless of the agent's RLS view.
      const { data: updated } = await supabaseAdmin()
        .from('calls')
        .update({
          wa_call_id: waCallId,
          ...(recorded ? { recording_status: 'requested' } : {}),
        })
        .eq('id', row.id)
        .select('*')
        .single()
      return NextResponse.json({ call: updated ?? { ...row, wa_call_id: waCallId } })
    } catch (err) {
      if (byAi && voice) await endVoiceSession(voice, row.id, 'connect_failed')
      const { body: explained } = explainCallingError(err)
      await supabaseAdmin()
        .from('calls')
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          error_code: explained.meta?.code ?? null,
          error_title: explained.error,
          error_details: explained.meta?.message ?? null,
        })
        .eq('id', row.id)
      return callingErrorResponse(err)
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
