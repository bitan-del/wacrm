import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendCallAction } from '@/lib/whatsapp/calling-api'
import { loadCallingConfig } from '@/lib/whatsapp/calling-server'
import { endVoiceSession, voiceServerConfig } from '@/lib/whatsapp/voice-server'
import type { CallStatus } from '@/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls/[id]/hangup — end a live call.
 *
 * Also the target of `navigator.sendBeacon` when an agent closes the tab
 * mid-call, so it takes no body and never rate-limits: a hang-up that is
 * refused leaves the customer on a dead line until Meta's media timeout.
 *
 * The row is closed optimistically here; Meta's terminate webhook then
 * fills in the authoritative duration.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('agent')

    const { data: call } = await supabase
      .from('calls')
      .select('id, wa_call_id, status, direction, answered_at, handled_by_ai')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!call) {
      return NextResponse.json({ error: t('callNotFound') }, { status: 404 })
    }

    const live = ['dialing', 'ringing', 'answering', 'in_progress'].includes(call.status)
    if (!live) return NextResponse.json({ success: true, status: call.status })

    const config = await loadCallingConfig(supabase, accountId)
    if (config && call.wa_call_id) {
      try {
        await sendCallAction({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          callId: call.wa_call_id,
          action: 'terminate',
        })
      } catch (err) {
        // Most often the call already ended on Meta's side. Close our
        // row anyway so the agent isn't stuck on a phantom call.
        console.warn('[calls] terminate failed:', err instanceof Error ? err.message : err)
      }
    }

    const voice = voiceServerConfig()
    if (call.handled_by_ai && voice) await endVoiceSession(voice, call.id, 'agent_hangup')

    const connected = call.status === 'in_progress' || call.answered_at !== null
    const next: CallStatus = connected
      ? 'completed'
      : call.direction === 'outbound'
        ? 'canceled'
        : 'missed'
    await supabase
      .from('calls')
      .update({
        status: next,
        ended_at: new Date().toISOString(),
        sdp_offer: null,
        sdp_answer: null,
      })
      .eq('id', call.id)
      .eq('status', call.status)

    return NextResponse.json({ success: true, status: next })
  } catch (error) {
    return toErrorResponse(error)
  }
}
