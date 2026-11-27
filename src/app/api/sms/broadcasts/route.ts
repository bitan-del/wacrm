import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { createSmsBroadcast, deliverDueSmsRecipients, SMS_BROADCAST_MAX_RECIPIENTS } from '@/lib/sms/broadcast'
import { prepareSmsBroadcast, SmsBroadcastRequestError, summarizePrepared } from '@/lib/sms/broadcast-request'
import { resolvePublicOrigin } from '@/lib/sms/config'

const t = getT('Api')

// The first delivery pass runs in after(); recipients it can't reach in
// time (or that are in quiet hours) are picked up by /api/sms/cron.
export const maxDuration = 300

/**
 * POST /api/sms/broadcasts
 *   { name, body, audience, prefix_brand?, append_opt_out? }
 *
 * Creates an SMS broadcast for the consented part of the audience and
 * starts delivering it server-side. Responds 202 once the campaign and
 * its recipients are persisted; poll the broadcast row for progress.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`sms-broadcast:${userId}`, RATE_LIMITS.smsBroadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 200) : ''
    if (!name) return NextResponse.json({ error: t('sms.nameRequired') }, { status: 400 })

    const admin = supabaseAdmin()
    let prepared
    try {
      prepared = await prepareSmsBroadcast(supabase, admin, accountId, body)
    } catch (err) {
      if (err instanceof SmsBroadcastRequestError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const { plan } = prepared.preview
    if (plan.recipients.length === 0) {
      return NextResponse.json({ error: t('sms.noEligibleRecipients') }, { status: 400 })
    }
    if (plan.recipients.length > SMS_BROADCAST_MAX_RECIPIENTS) {
      return NextResponse.json(
        { error: t('sms.tooManyRecipients', { max: SMS_BROADCAST_MAX_RECIPIENTS }) },
        { status: 400 },
      )
    }

    let broadcastId: string
    try {
      broadcastId = await createSmsBroadcast(admin, {
        accountId,
        userId,
        name,
        template: prepared.template,
        audience: prepared.audience,
        plan,
      })
    } catch (err) {
      console.error('[sms/broadcasts] create failed:', err)
      return NextResponse.json({ error: t('sms.createFailed') }, { status: 500 })
    }

    const origin = resolvePublicOrigin(request)
    after(async () => {
      try {
        await deliverDueSmsRecipients(admin, { origin, broadcastId, timeBudgetMs: 240_000 })
      } catch (err) {
        console.error('[sms/broadcasts] first delivery pass failed:', err)
      }
    })

    return NextResponse.json(
      { success: true, broadcast_id: broadcastId, ...summarizePrepared(prepared) },
      { status: 202 },
    )
  } catch (err) {
    console.error('[sms/broadcasts] error:', err)
    return toErrorResponse(err)
  }
}
