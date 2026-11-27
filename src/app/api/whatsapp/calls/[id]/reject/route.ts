import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendCallAction } from '@/lib/whatsapp/calling-api'
import { callingErrorResponse, loadCallingConfig } from '@/lib/whatsapp/calling-server'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls/[id]/reject — decline a ringing inbound call
 * for everyone (the caller hears it rejected). An agent who just wants
 * to stop their own ringing dismisses the popup client-side instead.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const config = await loadCallingConfig(supabase, accountId)
    if (!config) {
      return NextResponse.json({ error: t('notConnected') }, { status: 400 })
    }

    const { data: claimed } = await supabase
      .from('calls')
      .update({
        status: 'rejected',
        answered_by: userId,
        ended_at: new Date().toISOString(),
        sdp_offer: null,
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('direction', 'inbound')
      .eq('status', 'ringing')
      .select('id, wa_call_id')
    const call = claimed?.[0]
    if (!call) {
      return NextResponse.json({ error: t('alreadyTaken') }, { status: 409 })
    }

    if (call.wa_call_id) {
      try {
        await sendCallAction({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          callId: call.wa_call_id,
          action: 'reject',
        })
      } catch (err) {
        return callingErrorResponse(err)
      }
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
