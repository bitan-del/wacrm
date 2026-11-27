import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { getCallPermission, sendCallPermissionRequest } from '@/lib/whatsapp/calling-api'
import { outboundCallingSupport } from '@/lib/whatsapp/calling-availability'
import { callingErrorResponse, loadCallingConfig } from '@/lib/whatsapp/calling-server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

async function loadTarget(db: SupabaseClient, accountId: string, conversationId: string) {
  const { data } = await db
    .from('conversations')
    .select('id, contact:contacts(id, phone, wa_user_id)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) return null
  const contact = (data as unknown as {
    contact: { id: string; phone: string | null; wa_user_id: string | null } | null
  }).contact
  const target = resolveContactSendTarget(contact)
  return target ? { conversationId: data.id as string, target: target.target } : null
}

/**
 * GET /api/whatsapp/calls/permission?conversation_id=…
 *
 * Can an agent call this customer right now? Combines Meta's per-user
 * call permission with whether the business number's country allows
 * business-initiated calls at all.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    if (!conversationId) {
      return NextResponse.json({ error: t('badRequest') }, { status: 400 })
    }

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }
    const recipient = await loadTarget(supabase, accountId, conversationId)
    if (!recipient) {
      return NextResponse.json({ error: t('noRecipient') }, { status: 400 })
    }

    const phone = await verifyPhoneNumber({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
    }).catch(() => null)
    const outbound = outboundCallingSupport(phone?.display_phone_number)

    if (!outbound.supported) {
      return NextResponse.json({
        outbound,
        calling_enabled: config.callingEnabled,
        permission: null,
      })
    }

    try {
      const permission = await getCallPermission({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        user: recipient.target,
      })
      return NextResponse.json({
        outbound,
        calling_enabled: config.callingEnabled,
        permission,
      })
    } catch (err) {
      return callingErrorResponse(err)
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/whatsapp/calls/permission — ask the customer for permission
 * to call them. Body: { conversation_id, body_text? }.
 *
 * Free-form request, so it only works inside the 24-hour window after
 * the customer's last message; Meta rejects it otherwise (131047).
 * The request is saved to the thread like any agent message.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      conversation_id?: unknown
      body_text?: unknown
    } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    const bodyText =
      (typeof body?.body_text === 'string' ? body.body_text.trim() : '') ||
      t('permissionRequestDefaultBody')
    if (!conversationId) {
      return NextResponse.json({ error: t('badRequest') }, { status: 400 })
    }

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }
    const recipient = await loadTarget(supabase, accountId, conversationId)
    if (!recipient) {
      return NextResponse.json({ error: t('noRecipient') }, { status: 400 })
    }

    let wamid: string
    try {
      wamid = await sendCallPermissionRequest({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        to: recipient.target,
        bodyText,
      })
    } catch (err) {
      return callingErrorResponse(err)
    }

    const threadText = t('permissionRequestThreadText', { text: bodyText })
    const now = new Date().toISOString()
    const { error: insertError } = await supabase.from('messages').insert({
      conversation_id: recipient.conversationId,
      sender_type: 'agent',
      sender_id: userId,
      content_type: 'text',
      content_text: threadText,
      message_id: wamid,
      status: 'sent',
    })
    if (insertError) {
      console.error('[calls] permission request sent but not saved:', insertError.message)
    }
    await supabase
      .from('conversations')
      .update({ last_message_text: threadText, last_message_at: now, updated_at: now })
      .eq('id', recipient.conversationId)

    return NextResponse.json({ success: true, message_id: wamid })
  } catch (error) {
    return toErrorResponse(error)
  }
}
