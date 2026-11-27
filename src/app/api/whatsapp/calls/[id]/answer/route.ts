import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendCallAction } from '@/lib/whatsapp/calling-api'
import {
  callingErrorResponse,
  loadCallingConfig,
  withRecordingFallback,
} from '@/lib/whatsapp/calling-server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls/[id]/answer — take a ringing inbound call.
 *
 * Body: { sdp } — the WebRTC answer the agent's browser built from the
 * call's `sdp_offer`. The claim is an atomic UPDATE guarded on
 * status='ringing', so when several agents click Answer at once exactly
 * one wins; the rest get 409 and their popups close.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { sdp?: unknown } | null
    const sdp = typeof body?.sdp === 'string' ? body.sdp : ''
    if (!sdp.trim()) {
      return NextResponse.json({ error: t('badRequest') }, { status: 400 })
    }

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }

    const { data: claimed } = await supabase
      .from('calls')
      .update({ status: 'answering', answered_by: userId })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('direction', 'inbound')
      .eq('status', 'ringing')
      .select('id, wa_call_id')
    const call = claimed?.[0]
    if (!call || !call.wa_call_id) {
      return NextResponse.json({ error: t('alreadyTaken') }, { status: 409 })
    }

    try {
      // pre_accept sets the media path up while accept is in flight,
      // which avoids clipping the caller's first words.
      await sendCallAction({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        callId: call.wa_call_id,
        action: 'pre_accept',
        sdp,
      })
      const [, recorded] = await withRecordingFallback(config.recording, (recording) =>
        sendCallAction({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          callId: call.wa_call_id as string,
          action: 'accept',
          sdp,
          callbackData: call.id,
          recording,
        }),
      )

      const { data: updated } = await supabase
        .from('calls')
        .update({
          status: 'in_progress',
          answered_at: new Date().toISOString(),
          sdp_offer: null,
          ...(recorded ? { recording_status: 'requested' } : {}),
        })
        .eq('id', call.id)
        .eq('status', 'answering')
        .select('*')
      return NextResponse.json({ call: updated?.[0] ?? null })
    } catch (err) {
      // Give the call back so another agent (or this one, retrying)
      // can still take it. If the caller already hung up, the terminate
      // webhook closes the row.
      await supabase
        .from('calls')
        .update({ status: 'ringing', answered_by: null })
        .eq('id', call.id)
        .eq('status', 'answering')
      return callingErrorResponse(err)
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
