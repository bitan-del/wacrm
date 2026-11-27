import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { prepareSmsBroadcast, SmsBroadcastRequestError, summarizePrepared } from '@/lib/sms/broadcast-request'

/**
 * POST /api/sms/broadcasts/preview
 *   { body, audience, prefix_brand?, append_opt_out? }
 *
 * Read-only dry run of a create: how many contacts are eligible (and
 * why the rest aren't), segments, estimated cost, and how many would be
 * held for quiet hours. Writes nothing.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`sms-preview:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    try {
      const prepared = await prepareSmsBroadcast(supabase, supabaseAdmin(), accountId, body)
      return NextResponse.json(summarizePrepared(prepared))
    } catch (err) {
      if (err instanceof SmsBroadcastRequestError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
  } catch (err) {
    console.error('[sms/broadcasts/preview] error:', err)
    return toErrorResponse(err)
  }
}
