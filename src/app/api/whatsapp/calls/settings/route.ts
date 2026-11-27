import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api'
import { parseMessagingLimit } from '@/lib/whatsapp/phone-health'
import {
  CALLING_LIMITS,
  getCallingSettings,
  isRecordingAnnouncementLanguage,
  updateCallingSettings,
  type MetaCallingSettings,
} from '@/lib/whatsapp/calling-api'
import {
  CALLING_MIN_DAILY_LIMIT,
  meetsCallingTier,
  outboundCallingSupport,
} from '@/lib/whatsapp/calling-availability'
import {
  explainCallingError,
  loadCallingConfig,
  type CallingErrorBody,
} from '@/lib/whatsapp/calling-server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * GET /api/whatsapp/calls/settings — everything the Calling settings
 * panel shows: whether the number qualifies (messaging tier, country),
 * Meta's current calling settings, and this account's preferences.
 * Any member may read it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ connected: false })
    }

    const [health, metaSettings] = await Promise.all([
      getPhoneNumberHealth({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
      }).catch(() => null),
      getCallingSettings({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
      }).then(
        (calling) => ({ calling, error: null as CallingErrorBody | null }),
        (err) => ({ calling: null as MetaCallingSettings | null, error: explainCallingError(err).body }),
      ),
    ])

    const limit = parseMessagingLimit(health?.whatsapp_business_manager_messaging_limit)
    return NextResponse.json({
      connected: true,
      display_phone_number: health?.display_phone_number ?? null,
      messaging_limit: limit,
      min_daily_limit: CALLING_MIN_DAILY_LIMIT,
      meets_tier: meetsCallingTier(limit),
      outbound: outboundCallingSupport(health?.display_phone_number),
      meta: metaSettings.calling,
      meta_error: metaSettings.error,
      local: {
        calling_enabled: config.callingEnabled,
        recording_enabled: config.recordingEnabled,
        recording_purpose: config.recordingPurpose,
        recording_language: config.recordingLanguage,
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * POST /api/whatsapp/calls/settings — admins only.
 * Body (all optional): { enabled, call_icon_visibility,
 * callback_permission, recording_enabled, recording_purpose,
 * recording_language }. Meta-side fields are pushed to Meta first; local
 * preferences are saved only when that succeeds.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: t('badRequest') }, { status: 400 })

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }

    const metaPatch: Partial<Pick<
      MetaCallingSettings,
      'status' | 'call_icon_visibility' | 'callback_permission_status'
    >> = {}
    if (typeof body.enabled === 'boolean') metaPatch.status = body.enabled ? 'ENABLED' : 'DISABLED'
    if (body.call_icon_visibility === 'DEFAULT' || body.call_icon_visibility === 'DISABLE_ALL') {
      metaPatch.call_icon_visibility = body.call_icon_visibility
    }
    if (typeof body.callback_permission === 'boolean') {
      metaPatch.callback_permission_status = body.callback_permission ? 'ENABLED' : 'DISABLED'
    }

    const localPatch: Record<string, unknown> = {}
    if (typeof body.enabled === 'boolean') localPatch.calling_enabled = body.enabled
    if (typeof body.recording_enabled === 'boolean') {
      localPatch.call_recording_enabled = body.recording_enabled
    }
    if (typeof body.recording_purpose === 'string') {
      const purpose = body.recording_purpose.trim()
      if (purpose.length > CALLING_LIMITS.recordingPurpose) {
        return NextResponse.json({ error: t('purposeTooLong') }, { status: 400 })
      }
      localPatch.call_recording_purpose = purpose || null
    }
    if (body.recording_language !== undefined) {
      if (!isRecordingAnnouncementLanguage(body.recording_language)) {
        return NextResponse.json({ error: t('badLanguage') }, { status: 400 })
      }
      localPatch.call_recording_language = body.recording_language
    }

    // Recording needs a purpose and a language (Meta reads it out).
    const willRecord =
      (localPatch.call_recording_enabled ?? config.recordingEnabled) === true
    const purposeAfter =
      'call_recording_purpose' in localPatch
        ? (localPatch.call_recording_purpose as string | null)
        : config.recordingPurpose
    const languageAfter =
      (localPatch.call_recording_language as string | undefined) ?? config.recordingLanguage
    if (willRecord && (!purposeAfter || !isRecordingAnnouncementLanguage(languageAfter))) {
      return NextResponse.json({ error: t('recordingNeedsPurpose') }, { status: 400 })
    }

    if (Object.keys(metaPatch).length > 0) {
      try {
        await updateCallingSettings({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          calling: metaPatch,
        })
      } catch (err) {
        const { status, body: errBody } = explainCallingError(err)
        return NextResponse.json(errBody, { status })
      }
    }

    if (Object.keys(localPatch).length > 0) {
      const { error } = await supabase
        .from('whatsapp_config')
        .update(localPatch)
        .eq('account_id', accountId)
      if (error) {
        console.error('[calls] could not save calling preferences:', error.message)
        return NextResponse.json({ error: t('unexpected') }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
