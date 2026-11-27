import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deliverDueSmsRecipients } from '@/lib/sms/broadcast'
import { resolvePublicOrigin } from '@/lib/sms/config'

export const maxDuration = 300

function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * GET /api/sms/cron
 *
 * Delivers SMS broadcast recipients that are due: those held for quiet
 * hours, rate-limit retries, and anything the first after() pass of a
 * campaign didn't reach. Two triggers:
 *   - any pinger, every few minutes, with `x-cron-secret:
 *     $SMS_CRON_SECRET` (falls back to AUTOMATION_CRON_SECRET);
 *   - Vercel Cron (vercel.json — once a day on Hobby), which sends
 *     `Authorization: Bearer $CRON_SECRET`.
 *
 * Safe to overlap: recipients are claimed with FOR UPDATE SKIP LOCKED.
 */
export async function GET(request: Request) {
  // Two ways in: our own header (any pinger), or Vercel Cron, which sends
  // `Authorization: Bearer $CRON_SECRET` when that env var is set.
  const headerSecret = process.env.SMS_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET
  const vercelSecret = process.env.CRON_SECRET
  if (!headerSecret && !vercelSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorized =
    secretMatches(request.headers.get('x-cron-secret') ?? '', headerSecret) ||
    (bearer !== '' && secretMatches(bearer, vercelSecret))
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const report = await deliverDueSmsRecipients(supabaseAdmin(), {
    origin: resolvePublicOrigin(request),
    timeBudgetMs: 240_000,
  })
  return NextResponse.json(report)
}
