import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { isStaffOptInSource } from '@/lib/sms/consent'
import { applySmsConsent } from '@/lib/sms/consent-store'

const t = getT('Api')

const MAX_CONTACTS = 1000

/**
 * POST /api/sms/consent
 *   { contact_ids: string[], action: 'opt_in' | 'opt_out', source? }
 *
 * Record SMS consent captured outside the platform (web form, paper,
 * verbal…) or a manual opt-out. Runs under the caller's RLS through
 * `apply_sms_consent`, which refuses to re-opt-in anyone who opted out
 * themselves (they must text START) — those come back in `skipped`.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`sms-consent:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const ids: string[] = Array.isArray(body?.contact_ids)
      ? [...new Set<string>(body.contact_ids.filter((id: unknown) => typeof id === 'string'))]
      : []
    if (ids.length === 0) {
      return NextResponse.json({ error: t('sms.contactIdsRequired') }, { status: 400 })
    }
    if (ids.length > MAX_CONTACTS) {
      return NextResponse.json({ error: t('sms.tooManyContacts', { max: MAX_CONTACTS }) }, { status: 400 })
    }

    const action = body?.action
    if (action !== 'opt_in' && action !== 'opt_out') {
      return NextResponse.json({ error: t('sms.consentActionInvalid') }, { status: 400 })
    }

    let source: string
    if (action === 'opt_in') {
      if (!isStaffOptInSource(body?.source)) {
        return NextResponse.json({ error: t('sms.consentSourceInvalid') }, { status: 400 })
      }
      source = body.source
    } else {
      source = 'manual'
    }

    const changed = await applySmsConsent(supabase, accountId, ids, {
      action,
      source: source as 'manual',
    })
    const changedSet = new Set(changed)
    return NextResponse.json({
      success: true,
      updated: changed.length,
      skipped: ids.filter((id) => !changedSet.has(id)),
    })
  } catch (err) {
    console.error('[sms/consent] error:', err)
    return toErrorResponse(err)
  }
}
