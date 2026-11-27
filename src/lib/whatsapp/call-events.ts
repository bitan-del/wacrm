/**
 * WhatsApp `calls` webhook → normalized events → call row updates.
 *
 * Pure (no I/O) so the state machine is unit-testable; the webhook route
 * and `call-store.ts` do the database work. See call-events.test.ts.
 *
 * Payload shapes follow Meta's Calling docs (user-initiated-calls,
 * business-initiated-calls, call-recording). Every field is treated as
 * optional and loosely typed — Meta has shipped strings where the docs
 * say arrays (terminate `status`) and vice versa.
 */

import type { CallDirection, CallStatus } from '@/types'

export interface WaCallError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

export interface WaCallPayload {
  id?: string
  from?: string
  to?: string
  from_user_id?: string
  from_parent_user_id?: string
  to_user_id?: string
  event?: string
  timestamp?: string
  direction?: string
  session?: { sdp_type?: string; sdp?: string }
  connection?: { webrtc?: { sdp?: string } }
  status?: string | string[]
  start_time?: string
  end_time?: string
  duration?: number | string
  biz_opaque_callback_data?: string
  errors?: WaCallError[]
  call_recording?: {
    type?: string
    audio?: { id?: string; sha256?: string; mime_type?: string; url?: string }
  }
}

export interface WaCallStatusPayload {
  id?: string
  type?: string
  status?: string
  timestamp?: string
  recipient_id?: string
  recipient_user_id?: string
  biz_opaque_callback_data?: string
  errors?: WaCallError[]
}

export interface NormalizedCallError {
  code: number | null
  title: string | null
  details: string | null
}

export type CallEvent =
  | {
      kind: 'incoming'
      callId: string
      from: string | null
      fromUserId: string | null
      fromParentUserId: string | null
      sdpOffer: string
      at: string | null
    }
  | { kind: 'outbound_answer'; callId: string; callbackData: string | null; sdpAnswer: string }
  | {
      kind: 'terminate'
      callId: string
      callbackData: string | null
      failed: boolean
      durationSeconds: number | null
      startedAt: string | null
      endedAt: string | null
      error: NormalizedCallError | null
    }
  | {
      kind: 'status'
      callId: string
      callbackData: string | null
      status: 'RINGING' | 'ACCEPTED' | 'REJECTED'
      at: string | null
    }
  | {
      kind: 'recording'
      callId: string
      audio: { id: string | null; url: string | null; mimeType: string | null }
    }

function unixToIso(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

function normalizeError(errors: WaCallError[] | undefined): NormalizedCallError | null {
  const e = errors?.[0]
  if (!e) return null
  return {
    code: typeof e.code === 'number' ? e.code : null,
    title: e.title ?? null,
    details: e.error_data?.details ?? e.message ?? null,
  }
}

function terminateFailed(status: WaCallPayload['status']): boolean {
  const values = Array.isArray(status) ? status : status ? [status] : []
  return values.some((s) => String(s).toUpperCase() === 'FAILED')
}

/** Turn one `value` of a `calls` webhook change into events. */
export function parseCallsWebhookValue(value: {
  calls?: WaCallPayload[]
  statuses?: WaCallStatusPayload[]
}): CallEvent[] {
  const events: CallEvent[] = []

  for (const call of value.calls ?? []) {
    const callId = call.id?.trim()
    if (!callId) continue
    const event = (call.event ?? '').toLowerCase()
    const direction = (call.direction ?? '').toUpperCase()
    const callbackData = call.biz_opaque_callback_data ?? null

    if (event === 'connect') {
      const sdp = call.session?.sdp ?? call.connection?.webrtc?.sdp ?? null
      if (!sdp) continue
      const sdpType = (call.session?.sdp_type ?? '').toLowerCase()
      const isOutbound = direction === 'BUSINESS_INITIATED' || sdpType === 'answer'
      if (isOutbound) {
        events.push({ kind: 'outbound_answer', callId, callbackData, sdpAnswer: sdp })
      } else {
        events.push({
          kind: 'incoming',
          callId,
          from: call.from ?? null,
          fromUserId: call.from_user_id ?? null,
          fromParentUserId: call.from_parent_user_id ?? null,
          sdpOffer: sdp,
          at: unixToIso(call.timestamp),
        })
      }
    } else if (event === 'terminate') {
      const duration = Number(call.duration)
      events.push({
        kind: 'terminate',
        callId,
        callbackData,
        failed: terminateFailed(call.status),
        durationSeconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
        startedAt: unixToIso(call.start_time),
        endedAt: unixToIso(call.end_time) ?? unixToIso(call.timestamp),
        error: normalizeError(call.errors),
      })
    } else if (event === 'call_recording_available' || call.call_recording) {
      const audio = call.call_recording?.audio
      events.push({
        kind: 'recording',
        callId,
        audio: {
          id: audio?.id ?? null,
          url: audio?.url ?? null,
          mimeType: audio?.mime_type ?? null,
        },
      })
    }
  }

  for (const status of value.statuses ?? []) {
    const callId = status.id?.trim()
    if (!callId) continue
    if (status.type && status.type.toLowerCase() !== 'call') continue
    const s = (status.status ?? '').toUpperCase()
    if (s !== 'RINGING' && s !== 'ACCEPTED' && s !== 'REJECTED') continue
    events.push({
      kind: 'status',
      callId,
      callbackData: status.biz_opaque_callback_data ?? null,
      status: s,
      at: unixToIso(status.timestamp),
    })
  }

  return events
}

// ============================================================
// State machine
// ============================================================

export const LIVE_CALL_STATUSES: readonly CallStatus[] = [
  'dialing',
  'ringing',
  'answering',
  'in_progress',
]

export function isLiveCallStatus(status: CallStatus): boolean {
  return LIVE_CALL_STATUSES.includes(status)
}

/** What a call row looks like to the state machine. */
export interface CallStateRow {
  status: CallStatus
  direction: CallDirection
  answered_at: string | null
  ended_at: string | null
}

/** Columns to write. Empty object = nothing to change. */
export interface CallRowPatch {
  status?: CallStatus
  sdp_offer?: null
  sdp_answer?: string | null
  answered_at?: string
  ended_at?: string
  duration_seconds?: number
  error_code?: number | null
  error_title?: string | null
  error_details?: string | null
}

/**
 * Apply a webhook event (other than `incoming` and `recording`, which
 * create rows / files rather than move state) to the current row.
 * Never moves a finished call back to a live state.
 */
export function patchForCallEvent(
  row: CallStateRow,
  event: Exclude<CallEvent, { kind: 'incoming' } | { kind: 'recording' }>,
  now: Date = new Date(),
): CallRowPatch {
  const live = isLiveCallStatus(row.status)

  switch (event.kind) {
    case 'outbound_answer':
      return live ? { sdp_answer: event.sdpAnswer } : {}

    case 'status': {
      if (!live) return {}
      if (event.status === 'RINGING') {
        return row.status === 'dialing' ? { status: 'ringing' } : {}
      }
      if (event.status === 'ACCEPTED') {
        return {
          status: 'in_progress',
          ...(row.answered_at ? {} : { answered_at: event.at ?? now.toISOString() }),
        }
      }
      // REJECTED
      return {
        status: 'rejected',
        ended_at: event.at ?? now.toISOString(),
        sdp_offer: null,
        sdp_answer: null,
      }
    }

    case 'terminate': {
      const endedAt = event.endedAt ?? now.toISOString()
      const errorCols = event.error
        ? {
            error_code: event.error.code,
            error_title: event.error.title,
            error_details: event.error.details,
          }
        : {}
      const durationCol =
        event.durationSeconds !== null ? { duration_seconds: event.durationSeconds } : {}
      const base = {
        ...(row.ended_at ? {} : { ended_at: endedAt }),
        ...durationCol,
        ...errorCols,
        sdp_offer: null,
        sdp_answer: null,
      } satisfies CallRowPatch

      if (!live) return base

      const connected =
        row.status === 'in_progress' ||
        row.answered_at !== null ||
        (event.durationSeconds ?? 0) > 0
      let status: CallStatus
      if (connected) status = 'completed'
      else if (row.direction === 'inbound') status = 'missed'
      else status = event.failed && event.error ? 'failed' : 'missed'

      return { ...base, status }
    }
  }
}
