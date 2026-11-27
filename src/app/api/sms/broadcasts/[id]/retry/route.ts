import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { deliverDueSmsRecipients } from '@/lib/sms/broadcast'
import { resolvePublicOrigin } from '@/lib/sms/config'

const t = getT('Api')

export const maxDuration = 300

/**
 * POST /api/sms/broadcasts/[id]/retry
 *
 * Puts an SMS broadcast's failed recipients back in the queue and starts
 * a delivery pass. Safe by construction: every recipient is re-checked
 * for consent and quiet hours at send time, so contacts that failed for
 * having opted out simply fail again with the same reason.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`sms-broadcast:${userId}`, RATE_LIMITS.smsBroadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { data: broadcast } = await supabase
      .from('broadcasts')
      .select('id, channel')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!broadcast || broadcast.channel !== 'sms') {
      return NextResponse.json({ error: t('common.notFound') }, { status: 404 })
    }

    const now = new Date().toISOString()
    const { data: reset, error } = await supabase
      .from('broadcast_recipients')
      .update({
        status: 'pending',
        error_message: null,
        sms_message_id: null,
        claimed_at: null,
        scheduled_for: now,
      })
      .eq('broadcast_id', id)
      .eq('status', 'failed')
      .select('id')
    if (error) {
      console.error('[sms/broadcasts/retry] reset failed:', error)
      return NextResponse.json({ error: t('sms.createFailed') }, { status: 500 })
    }
    const retrying = reset?.length ?? 0
    if (retrying === 0) return NextResponse.json({ success: true, retrying: 0 })

    await supabase
      .from('broadcasts')
      .update({ status: 'sending', updated_at: now })
      .eq('id', id)
      .eq('account_id', accountId)

    const admin = supabaseAdmin()
    const origin = resolvePublicOrigin(request)
    after(async () => {
      try {
        await deliverDueSmsRecipients(admin, { origin, broadcastId: id, timeBudgetMs: 240_000 })
      } catch (err) {
        console.error('[sms/broadcasts/retry] delivery pass failed:', err)
      }
    })

    return NextResponse.json({ success: true, retrying }, { status: 202 })
  } catch (err) {
    console.error('[sms/broadcasts/retry] error:', err)
    return toErrorResponse(err)
  }
}
