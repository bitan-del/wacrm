import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { deliverDueSmsRecipients } from '@/lib/sms/broadcast'
import { resolvePublicOrigin } from '@/lib/sms/config'

export const maxDuration = 300

/**
 * Without a configured secret the endpoint is open, so cap how often it
 * can be made to run. Per instance — enough to stop a loop from burning
 * function time, while Vercel Cron and an occasional pinger pass.
 */
const OPEN_CRON_LIMIT = { limit: 6, windowMs: 60_000 }

function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * GET /api/sms/cron
 *
 * Delivers SMS broadcast recipients that are due: those held for quiet
 * hours, rate-limit retries, and anything the first after() pass of a
 * campaign didn't reach. Triggered by Vercel Cron (vercel.json) and,
 * optionally, by any external pinger.
 *
 * Works with ZERO configuration — no env var to set, because this is a
 * SaaS and everything a customer configures lives in the app. That is
 * safe because the job can only do what is already scheduled to happen:
 * it sends nothing that isn't due, consented, and outside quiet hours
 * (all re-checked at send time), and recipients are claimed with
 * FOR UPDATE SKIP LOCKED so overlapping runs never double-send. Calling
 * it early just delivers due messages a little sooner.
 *
 * If an operator does set a secret — `SMS_CRON_SECRET` /
 * `AUTOMATION_CRON_SECRET` (as `x-cron-secret`) or `CRON_SECRET` (Vercel
 * Cron's `Authorization: Bearer`) — it is enforced.
 */
export async function GET(request: Request) {
  const headerSecret = process.env.SMS_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET
  const vercelSecret = process.env.CRON_SECRET

  if (headerSecret || vercelSecret) {
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const authorized =
      secretMatches(request.headers.get('x-cron-secret') ?? '', headerSecret) ||
      secretMatches(bearer, vercelSecret)
    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    const limit = checkRateLimit('sms-cron:open', OPEN_CRON_LIMIT)
    if (!limit.success) return rateLimitResponse(limit)
  }

  const report = await deliverDueSmsRecipients(supabaseAdmin(), {
    origin: resolvePublicOrigin(request),
    timeBudgetMs: 240_000,
  })
  return NextResponse.json(report)
}
