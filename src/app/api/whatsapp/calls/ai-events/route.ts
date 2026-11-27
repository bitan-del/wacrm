import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { sendCallAction } from '@/lib/whatsapp/calling-api'
import { loadCallingConfig } from '@/lib/whatsapp/calling-server'
import { isLiveCallStatus } from '@/lib/whatsapp/call-events'
import { verifyVoiceSignature, voiceServerConfig } from '@/lib/whatsapp/voice-server'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import type { CallStatus, CallTranscriptLine } from '@/types'

export const maxDuration = 30

interface VoiceEvent {
  session_id?: string
  type?: 'hangup_requested' | 'ended' | 'error'
  reason?: string
  message?: string
  duration_seconds?: number
  transcript?: CallTranscriptLine[]
  notes?: Record<string, string>
  summary?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Keep stored transcripts bounded and well-formed. */
function cleanTranscript(lines: unknown): CallTranscriptLine[] | null {
  if (!Array.isArray(lines)) return null
  return lines
    .filter(
      (l): l is CallTranscriptLine =>
        !!l &&
        typeof l === 'object' &&
        ((l as CallTranscriptLine).role === 'agent' || (l as CallTranscriptLine).role === 'customer') &&
        typeof (l as CallTranscriptLine).text === 'string',
    )
    .slice(0, 2000)
    .map((l) => ({ role: l.role, text: l.text.slice(0, 4000), ...(l.at ? { at: String(l.at) } : {}) }))
}

function cleanNotes(notes: unknown): Record<string, string> | null {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(notes as Record<string, unknown>).slice(0, 100)) {
    out[String(k).slice(0, 100)] = String(v ?? '').slice(0, 2000)
  }
  return out
}

/** Hang the call up at Meta and close the row. */
async function endCallAtMeta(
  call: { id: string; account_id: string; wa_call_id: string | null; status: CallStatus; answered_at: string | null },
  status: CallStatus,
  extra: Record<string, unknown> = {},
) {
  const admin = supabaseAdmin()
  if (call.wa_call_id) {
    const config = await loadCallingConfig(admin, call.account_id)
    if (config) {
      try {
        await sendCallAction({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          callId: call.wa_call_id,
          action: 'terminate',
        })
      } catch (err) {
        console.warn('[calls] AI hang-up terminate failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  await admin
    .from('calls')
    .update({ status, ended_at: new Date().toISOString(), sdp_offer: null, sdp_answer: null, ...extra })
    .eq('id', call.id)
    .eq('status', call.status)
}

/**
 * POST /api/whatsapp/calls/ai-events — callbacks from the voice server,
 * signed with VOICE_SERVER_SECRET (X-Voice-Signature).
 */
export async function POST(request: Request) {
  const voice = voiceServerConfig()
  if (!voice) return NextResponse.json({ error: 'voice server not configured' }, { status: 503 })

  const raw = await readCappedBody(request)
  if (raw === null) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  if (!verifyVoiceSignature(raw, request.headers.get('x-voice-signature'), voice.secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: VoiceEvent
  try {
    event = JSON.parse(raw) as VoiceEvent
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const sessionId = event.session_id ?? ''
  if (!UUID_RE.test(sessionId)) return NextResponse.json({ error: 'Unknown session' }, { status: 404 })

  after(async () => {
    try {
      const admin = supabaseAdmin()
      const { data } = await admin
        .from('calls')
        .select('id, account_id, wa_call_id, status, answered_at, handled_by_ai')
        .eq('id', sessionId)
        .maybeSingle()
      const call = data as
        | { id: string; account_id: string; wa_call_id: string | null; status: CallStatus; answered_at: string | null; handled_by_ai: boolean }
        | null
      if (!call || !call.handled_by_ai) return
      const live = isLiveCallStatus(call.status)
      const connected = call.status === 'in_progress' || call.answered_at !== null

      if (event.type === 'hangup_requested') {
        if (live) await endCallAtMeta(call, connected ? 'completed' : 'missed')
      } else if (event.type === 'ended') {
        const transcript = cleanTranscript(event.transcript)
        const notes = cleanNotes(event.notes)
        const summary = typeof event.summary === 'string' ? event.summary.slice(0, 4000) : null
        await admin
          .from('calls')
          .update({
            ...(transcript ? { ai_transcript: transcript } : {}),
            ...(notes ? { ai_notes: notes } : {}),
            ...(summary ? { ai_summary: summary } : {}),
          })
          .eq('id', call.id)
        if (live) await endCallAtMeta(call, connected ? 'completed' : 'missed')
      } else if (event.type === 'error') {
        console.error(`[calls] voice server error on ${call.id}: ${event.message ?? 'unknown'}`)
        if (live) {
          await endCallAtMeta(call, connected ? 'completed' : 'failed', {
            error_title: 'AI agent error',
            error_details: String(event.message ?? '').slice(0, 1000) || null,
          })
        }
      }
    } catch (err) {
      console.error('[calls] failed to handle voice event:', err instanceof Error ? err.message : err)
    }
  })

  return NextResponse.json({ ok: true })
}
