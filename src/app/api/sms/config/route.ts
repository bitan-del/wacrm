import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { getT } from '@/lib/i18n/translate'
import {
  createSmsProvider,
  loadSmsConfigForAccount,
  resolvePublicOrigin,
  smsWebhookUrls,
  toPublicSmsConfig,
  SMS_REGISTRATION_TYPES,
  SmsConfigUnreadableError,
  type SmsConfigRow,
  type SmsRegistrationType,
} from '@/lib/sms/config'
import { smsPhoneFor } from '@/lib/sms/consent'
import { isValidTimeZone } from '@/lib/sms/quiet-hours'
import { TWILIO_ACCOUNT_SID_RE, TWILIO_MESSAGING_SERVICE_SID_RE } from '@/lib/sms/twilio'
import { SmsProviderError } from '@/lib/sms/types'

const t = getT('Api')

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function optionalText(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v ? v.slice(0, max) : null
}

/**
 * GET /api/sms/config
 *
 * Admins get the full (token-free) config plus the webhook URLs to paste
 * into Twilio. Everyone else gets only whether SMS is usable — the
 * inbox composer and the broadcast wizard need that, and the table's
 * admin-only RLS means they couldn't read the row themselves.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, role } = await getCurrentAccount()

    if (!hasMinRole(role, 'admin')) {
      const row = await loadSmsConfigForAccount(supabaseAdmin(), accountId)
      return NextResponse.json({
        configured: Boolean(row),
        is_active: Boolean(row?.is_active),
        sender: row ? (row.from_number ?? row.messaging_service_sid) : null,
        brand_name: row?.brand_name ?? null,
      })
    }

    const row = await loadSmsConfigForAccount(supabase, accountId)
    if (!row) return NextResponse.json({ configured: false })
    const origin = resolvePublicOrigin(request)
    return NextResponse.json({
      ...toPublicSmsConfig(row),
      webhook_urls: origin ? smsWebhookUrls(origin, row) : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/sms/config  (admin+)
 *
 * Upsert the account's SMS provider config. Credentials + sender are
 * verified against the provider before saving (the sender must belong
 * to the given provider account). `auth_token` may be omitted to keep
 * the stored one.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`sms-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad(t('common.invalidRequestBody'))

    const accountSid = typeof body.account_sid === 'string' ? body.account_sid.trim() : ''
    if (!TWILIO_ACCOUNT_SID_RE.test(accountSid)) return bad(t('sms.accountSidInvalid'))

    const messagingServiceSid = optionalText(body.messaging_service_sid, 64)
    if (messagingServiceSid && !TWILIO_MESSAGING_SERVICE_SID_RE.test(messagingServiceSid)) {
      return bad(t('sms.messagingServiceInvalid'))
    }
    const rawFrom = optionalText(body.from_number, 32)
    const fromNumber = rawFrom ? smsPhoneFor(rawFrom) : null
    if (rawFrom && (!fromNumber || !rawFrom.trim().startsWith('+'))) {
      return bad(t('sms.fromNumberInvalid'))
    }
    if (!messagingServiceSid && !fromNumber) return bad(t('sms.senderRequired'))

    const defaultTimezone =
      typeof body.default_timezone === 'string' ? body.default_timezone.trim() : 'America/New_York'
    if (!isValidTimeZone(defaultTimezone)) return bad(t('sms.timezoneInvalid'))

    const quietStart = Number(body.quiet_hours_start ?? 21)
    const quietEnd = Number(body.quiet_hours_end ?? 8)
    if (![quietStart, quietEnd].every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) {
      return bad(t('sms.quietHoursInvalid'))
    }

    const costPerSegment = Number(body.cost_per_segment ?? 0.0083)
    if (!Number.isFinite(costPerSegment) || costPerSegment < 0 || costPerSegment > 10) {
      return bad(t('sms.costInvalid'))
    }
    const costCurrency =
      typeof body.cost_currency === 'string' && /^[A-Z]{3}$/.test(body.cost_currency.trim())
        ? body.cost_currency.trim()
        : 'USD'

    const registrationType: SmsRegistrationType | null = SMS_REGISTRATION_TYPES.includes(
      body.registration_type,
    )
      ? body.registration_type
      : null

    const existing = await loadSmsConfigForAccount(supabase, accountId)
    const rawToken = typeof body.auth_token === 'string' ? body.auth_token.trim() : ''

    // Reuse the stored token only for the same provider account — a new
    // Account SID needs its own token.
    const plaintextToken: string | undefined = rawToken || undefined
    let storedToken: string | null = null
    if (!plaintextToken) {
      if (!existing || existing.account_sid !== accountSid) return bad(t('sms.authTokenRequired'))
      storedToken = existing.auth_token
    }

    // A sender may belong to one workspace only (inbound routing).
    const admin = supabaseAdmin()
    const conflicts: string[] = []
    if (fromNumber) conflicts.push(`from_number.eq.${fromNumber}`)
    if (messagingServiceSid) conflicts.push(`messaging_service_sid.eq.${messagingServiceSid}`)
    const { data: clash } = await admin
      .from('sms_config')
      .select('account_id')
      .or(conflicts.join(','))
      .neq('account_id', accountId)
      .limit(1)
    if (clash && clash.length > 0) return bad(t('sms.senderInUse'), 409)

    const candidate = {
      provider: 'twilio' as const,
      account_sid: accountSid,
      auth_token: storedToken ?? '',
      messaging_service_sid: messagingServiceSid,
      from_number: fromNumber,
    }
    let verifiedAt: string | null = null
    try {
      const provider = createSmsProvider(candidate, plaintextToken)
      await provider.verifyCredentials()
      verifiedAt = new Date().toISOString()
    } catch (err) {
      if (err instanceof SmsConfigUnreadableError) return bad(t('sms.credentialsUnreadable'))
      if (err instanceof SmsProviderError) {
        return bad(t('sms.verifyFailed', { reason: err.message }))
      }
      throw err
    }

    const row: Partial<SmsConfigRow> & { account_id: string } = {
      account_id: accountId,
      provider: 'twilio',
      account_sid: accountSid,
      auth_token: plaintextToken ? encrypt(plaintextToken) : storedToken!,
      messaging_service_sid: messagingServiceSid,
      from_number: fromNumber,
      brand_name: optionalText(body.brand_name, 80),
      help_reply_text: optionalText(body.help_reply_text, 480),
      opt_out_reply_text: optionalText(body.opt_out_reply_text, 480),
      opt_in_reply_text: optionalText(body.opt_in_reply_text, 480),
      default_timezone: defaultTimezone,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
      cost_per_segment: costPerSegment,
      cost_currency: costCurrency,
      registration_type: registrationType,
      registration_reference: optionalText(body.registration_reference, 120),
      is_active: body.is_active === true,
      last_verified_at: verifiedAt,
    }
    if (!existing) row.created_by = userId

    const { data: saved, error } = await supabase
      .from('sms_config')
      .upsert(row, { onConflict: 'account_id' })
      .select('*')
      .single()

    if (error || !saved) {
      console.error('[sms/config POST] save failed:', error)
      if (error?.code === '23505') return bad(t('sms.senderInUse'), 409)
      return bad(t('sms.saveFailed'), 500)
    }

    const origin = resolvePublicOrigin(request)
    return NextResponse.json({
      ...toPublicSmsConfig(saved as SmsConfigRow),
      webhook_urls: origin ? smsWebhookUrls(origin, saved as SmsConfigRow) : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/sms/config (admin+) — disconnect the provider. */
export async function DELETE() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`sms-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await supabase.from('sms_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[sms/config DELETE] failed:', error)
      return bad(t('sms.saveFailed'), 500)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
