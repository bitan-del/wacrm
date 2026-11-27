import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { resolvePublicOrigin } from '@/lib/sms/config'
import { sendSmsToConversation, SmsSendError, SMS_MAX_BODY_CHARS, type SmsSendErrorCode } from '@/lib/sms/send'

const t = getT('Api')

function errorText(code: SmsSendErrorCode, fallback: string): string {
  switch (code) {
    case 'sms_not_configured':
      return t('sms.notConfigured')
    case 'opted_out':
      return t('sms.optedOut')
    case 'invalid_phone':
      return t('sms.invalidPhone')
    case 'not_found':
      return t('common.conversationNotFound')
    case 'db_error':
      return t('sms.sentNotSaved')
    case 'provider_error':
      return t('sms.providerError', { reason: fallback })
    case 'bad_request':
      return fallback
  }
}

/**
 * POST /api/sms/send  { conversation_id, content_text }
 *
 * Agent reply by SMS from the inbox. Same role gate and per-user send
 * budget as `/api/whatsapp/send` — the two share the `send:` bucket.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    const text = typeof body?.content_text === 'string' ? body.content_text : ''
    if (!conversationId) {
      return NextResponse.json({ error: t('common.conversationNotFound') }, { status: 400 })
    }
    if (!text.trim()) return NextResponse.json({ error: t('sms.textRequired') }, { status: 400 })
    if (text.length > SMS_MAX_BODY_CHARS) {
      return NextResponse.json(
        { error: t('sms.textTooLong', { max: SMS_MAX_BODY_CHARS }) },
        { status: 400 },
      )
    }

    try {
      const result = await sendSmsToConversation(supabase, supabaseAdmin(), accountId, {
        conversationId,
        text,
        senderId: userId,
        origin: resolvePublicOrigin(request),
      })
      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        sms_message_id: result.providerMessageId,
      })
    } catch (err) {
      if (err instanceof SmsSendError) {
        return NextResponse.json(
          { error: errorText(err.code, err.message), code: err.code },
          { status: err.status },
        )
      }
      throw err
    }
  } catch (err) {
    console.error('[sms/send] error:', err)
    return toErrorResponse(err)
  }
}
