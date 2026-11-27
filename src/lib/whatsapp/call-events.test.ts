import { describe, expect, it } from 'vitest'
import {
  isLiveCallStatus,
  parseCallsWebhookValue,
  patchForCallEvent,
  type CallStateRow,
} from './call-events'

const NOW = new Date('2026-11-27T10:00:00.000Z')

function row(partial: Partial<CallStateRow>): CallStateRow {
  return {
    status: 'ringing',
    direction: 'inbound',
    answered_at: null,
    ended_at: null,
    ...partial,
  }
}

describe('parseCallsWebhookValue', () => {
  it('reads a customer-initiated connect as an incoming call with the SDP offer', () => {
    const events = parseCallsWebhookValue({
      calls: [
        {
          id: 'wacid.ABC',
          from: '919876543210',
          to: '15550001111',
          event: 'connect',
          timestamp: '1795600000',
          direction: 'USER_INITIATED',
          session: { sdp_type: 'offer', sdp: 'v=0\r\n...' },
        },
      ],
    })
    expect(events).toEqual([
      {
        kind: 'incoming',
        callId: 'wacid.ABC',
        from: '919876543210',
        fromUserId: null,
        fromParentUserId: null,
        sdpOffer: 'v=0\r\n...',
        at: new Date(1795600000 * 1000).toISOString(),
      },
    ])
  })

  it('reads a business-initiated connect as the SDP answer, keeping our callback data', () => {
    const [event] = parseCallsWebhookValue({
      calls: [
        {
          id: 'wacid.OUT',
          event: 'connect',
          direction: 'BUSINESS_INITIATED',
          session: { sdp_type: 'answer', sdp: 'v=0 answer' },
          biz_opaque_callback_data: 'row-uuid',
        },
      ],
    })
    expect(event).toEqual({
      kind: 'outbound_answer',
      callId: 'wacid.OUT',
      callbackData: 'row-uuid',
      sdpAnswer: 'v=0 answer',
    })
  })

  it('falls back to connection.webrtc.sdp when session is missing', () => {
    const [event] = parseCallsWebhookValue({
      calls: [
        {
          id: 'wacid.OUT',
          event: 'connect',
          direction: 'BUSINESS_INITIATED',
          connection: { webrtc: { sdp: 'v=0 via connection' } },
        },
      ],
    })
    expect(event).toMatchObject({ kind: 'outbound_answer', sdpAnswer: 'v=0 via connection' })
  })

  it('parses terminate with duration, and status as either a string or an array', () => {
    const events = parseCallsWebhookValue({
      calls: [
        {
          id: 'wacid.1',
          event: 'terminate',
          status: 'COMPLETED',
          duration: 61,
          start_time: '1795600000',
          end_time: '1795600061',
        },
        {
          id: 'wacid.2',
          event: 'terminate',
          status: ['FAILED'],
          errors: [{ code: 138021, title: 'Call failed', error_data: { details: 'ICE failed' } }],
        },
      ],
    })
    expect(events[0]).toMatchObject({
      kind: 'terminate',
      failed: false,
      durationSeconds: 61,
      startedAt: new Date(1795600000 * 1000).toISOString(),
      endedAt: new Date(1795600061 * 1000).toISOString(),
      error: null,
    })
    expect(events[1]).toMatchObject({
      kind: 'terminate',
      failed: true,
      durationSeconds: null,
      error: { code: 138021, title: 'Call failed', details: 'ICE failed' },
    })
  })

  it('parses call statuses and ignores message statuses', () => {
    const events = parseCallsWebhookValue({
      statuses: [
        { id: 'wacid.X', type: 'call', status: 'RINGING', timestamp: '1795600000' },
        { id: 'wacid.X', type: 'call', status: 'accepted' },
        { id: 'wamid.Y', type: 'message', status: 'RINGING' },
        { id: 'wacid.Z', type: 'call', status: 'SOMETHING_NEW' },
      ],
    })
    expect(events.map((e) => (e.kind === 'status' ? e.status : e.kind))).toEqual([
      'RINGING',
      'ACCEPTED',
    ])
  })

  it('parses a recording-available event', () => {
    const [event] = parseCallsWebhookValue({
      calls: [
        {
          id: 'wacid.R',
          event: 'call_recording_available',
          call_recording: {
            type: 'audio',
            audio: { id: 'media-1', url: 'https://example/rec', mime_type: 'audio/ogg; codecs=opus' },
          },
        },
      ],
    })
    expect(event).toEqual({
      kind: 'recording',
      callId: 'wacid.R',
      audio: { id: 'media-1', url: 'https://example/rec', mimeType: 'audio/ogg; codecs=opus' },
    })
  })

  it('skips entries without an id or without SDP on connect', () => {
    expect(
      parseCallsWebhookValue({
        calls: [{ event: 'connect', session: { sdp: 'x' } }, { id: 'wacid.N', event: 'connect' }],
      }),
    ).toEqual([])
  })
})

describe('patchForCallEvent', () => {
  it('moves an outbound call from dialing to ringing to in progress', () => {
    expect(
      patchForCallEvent(row({ status: 'dialing', direction: 'outbound' }), {
        kind: 'status',
        callId: 'c',
        callbackData: null,
        status: 'RINGING',
        at: null,
      }),
    ).toEqual({ status: 'ringing' })

    expect(
      patchForCallEvent(
        row({ status: 'ringing', direction: 'outbound' }),
        { kind: 'status', callId: 'c', callbackData: null, status: 'ACCEPTED', at: null },
        NOW,
      ),
    ).toEqual({ status: 'in_progress', answered_at: NOW.toISOString() })
  })

  it('records the SDP answer only while the call is live', () => {
    const event = { kind: 'outbound_answer', callId: 'c', callbackData: null, sdpAnswer: 'v=0' } as const
    expect(patchForCallEvent(row({ status: 'dialing', direction: 'outbound' }), event)).toEqual({
      sdp_answer: 'v=0',
    })
    expect(patchForCallEvent(row({ status: 'canceled', direction: 'outbound' }), event)).toEqual({})
  })

  it('marks a customer rejection as rejected and clears SDP', () => {
    expect(
      patchForCallEvent(
        row({ status: 'ringing', direction: 'outbound' }),
        { kind: 'status', callId: 'c', callbackData: null, status: 'REJECTED', at: null },
        NOW,
      ),
    ).toEqual({ status: 'rejected', ended_at: NOW.toISOString(), sdp_offer: null, sdp_answer: null })
  })

  const terminate = (over: Partial<{ failed: boolean; durationSeconds: number | null }> = {}) =>
    ({
      kind: 'terminate',
      callId: 'c',
      callbackData: null,
      failed: false,
      durationSeconds: null,
      startedAt: null,
      endedAt: '2026-11-27T10:05:00.000Z',
      error: null,
      ...over,
    }) as const

  it('ends a connected call as completed with Meta\'s duration', () => {
    expect(patchForCallEvent(row({ status: 'in_progress' }), terminate({ durationSeconds: 300 }))).toEqual({
      status: 'completed',
      ended_at: '2026-11-27T10:05:00.000Z',
      duration_seconds: 300,
      sdp_offer: null,
      sdp_answer: null,
    })
  })

  it('ends an unanswered inbound call as missed', () => {
    expect(patchForCallEvent(row({ status: 'ringing' }), terminate())).toMatchObject({
      status: 'missed',
    })
    // An agent was mid-answer when the caller hung up.
    expect(patchForCallEvent(row({ status: 'answering' }), terminate())).toMatchObject({
      status: 'missed',
    })
  })

  it('ends an unanswered outbound call as failed only when Meta gave a reason', () => {
    const outbound = row({ status: 'ringing', direction: 'outbound' })
    expect(patchForCallEvent(outbound, terminate())).toMatchObject({ status: 'missed' })
    expect(
      patchForCallEvent(outbound, {
        ...terminate({ failed: true }),
        error: { code: 138006, title: 'No permission', details: null },
      }),
    ).toMatchObject({ status: 'failed', error_code: 138006, error_title: 'No permission' })
  })

  it('never reopens a finished call, but still records the final duration', () => {
    const patch = patchForCallEvent(
      row({ status: 'completed', ended_at: '2026-11-27T10:04:59.000Z', answered_at: 'x' }),
      terminate({ durationSeconds: 299 }),
    )
    expect(patch.status).toBeUndefined()
    expect(patch.ended_at).toBeUndefined()
    expect(patch.duration_seconds).toBe(299)

    expect(
      patchForCallEvent(row({ status: 'rejected' }), {
        kind: 'status',
        callId: 'c',
        callbackData: null,
        status: 'ACCEPTED',
        at: null,
      }),
    ).toEqual({})
  })
})

describe('isLiveCallStatus', () => {
  it('treats only dialing/ringing/answering/in_progress as live', () => {
    expect(['dialing', 'ringing', 'answering', 'in_progress'].every((s) => isLiveCallStatus(s as never))).toBe(true)
    expect(['completed', 'missed', 'rejected', 'canceled', 'failed'].some((s) => isLiveCallStatus(s as never))).toBe(false)
  })
})
