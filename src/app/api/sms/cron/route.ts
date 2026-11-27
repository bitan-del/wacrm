import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deliverDueSmsRecipients } from '@/lib/sms/broadcast'
import { resolvePublicOrigin } from '@/lib/sms/config'

export const maxDuration = 300

/**
 * GET /api/sms/cron
 *
 * Delivers SMS broadcast recipients that are due: those held for quiet
 * hours, rate-limit retries, and anything the first after() pass of a
 * campaign didn't reach. Run it every few minutes (Vercel Cron or any
 * pinger) with `x-cron-secret: $SMS_CRON_SECRET`. Falls back to
 * AUTOMATION_CRON_SECRET so an existing automations pinger can be
 * pointed here without a second secret.
 *
 * Safe to overlap: recipients are claimed with FOR UPDATE SKIP LOCKED.
 */
export async function GET(request: Request) {
  const expected = process.env.SMS_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const want = Buffer.from(expected)
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const report = await deliverDueSmsRecipients(supabaseAdmin(), {
    origin: resolvePublicOrigin(request),
    timeBudgetMs: 240_000,
  })
  return NextResponse.json(report)
}
