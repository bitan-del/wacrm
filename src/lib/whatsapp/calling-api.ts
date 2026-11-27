/**
 * Meta WhatsApp Cloud API — Calling endpoints.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/calling/
 *
 * Signalling only. The audio itself is WebRTC (ICE + DTLS-SRTP, Opus)
 * between Meta and the agent's browser; the server relays the SDP that
 * the browser produced (or that Meta sent) through these calls.
 *
 * Same conventions as `meta-api.ts`: one named-args object per helper,
 * failures thrown as `MetaApiError` so `meta-error-explain.ts` and the
 * routes can read Meta's code / subcode / fbtrace_id.
 */

import { isBusinessScopedUserId } from './wa-identity'
import { readMetaError } from './meta-api'
import { CALLING_LIMITS, type RecordingAnnouncementLanguage } from './calling-constants'

/**
 * Calling shipped in Graph v23; pin a version that has it rather than
 * the older default `meta-api.ts` uses for messaging.
 */
const CALLING_API_VERSION = 'v24.0'
const CALLING_API_BASE = `https://graph.facebook.com/${CALLING_API_VERSION}`

export {
  CALLING_LIMITS,
  RECORDING_ANNOUNCEMENT_LANGUAGES,
  isRecordingAnnouncementLanguage,
  type RecordingAnnouncementLanguage,
} from './calling-constants'
export interface CallRecordingRequest {
  purpose: string
  announcementLanguage: RecordingAnnouncementLanguage
}

function recordingField(recording: CallRecordingRequest | null | undefined) {
  if (!recording) return {}
  return {
    recording: {
      status: 'ENABLED',
      purpose: recording.purpose.slice(0, CALLING_LIMITS.recordingPurpose),
      announcement_language: recording.announcementLanguage,
    },
  }
}

/** `to` for a phone number, `recipient` for a business-scoped user id. */
function callRecipientFields(to: string): Record<string, string> {
  return isBusinessScopedUserId(to) ? { recipient: to.trim() } : { to }
}

async function postJson(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw await readMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json().catch(() => ({}))
}

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw await readMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

// ============================================================
// Settings
// ============================================================

export type CallingStatus = 'ENABLED' | 'DISABLED'
export type CallIconVisibility = 'DEFAULT' | 'DISABLE_ALL'

export interface MetaCallingSettings {
  status?: CallingStatus
  call_icon_visibility?: CallIconVisibility
  callback_permission_status?: CallingStatus
  call_hours?: { status?: CallingStatus; timezone_id?: string }
  sip?: { status?: CallingStatus }
}

export interface PhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
}

/** GET /{phone_number_id}/settings → the `calling` block (or null). */
export async function getCallingSettings(
  args: PhoneNumberArgs,
): Promise<MetaCallingSettings | null> {
  const data = (await getJson(
    `${CALLING_API_BASE}/${args.phoneNumberId}/settings`,
    args.accessToken,
  )) as { calling?: MetaCallingSettings }
  return data?.calling ?? null
}

export interface UpdateCallingSettingsArgs extends PhoneNumberArgs {
  calling: Partial<
    Pick<
      MetaCallingSettings,
      'status' | 'call_icon_visibility' | 'callback_permission_status'
    >
  >
}

/**
 * POST /{phone_number_id}/settings with a partial `calling` block.
 * Fields left out keep their current value at Meta.
 */
export async function updateCallingSettings(
  args: UpdateCallingSettingsArgs,
): Promise<void> {
  await postJson(`${CALLING_API_BASE}/${args.phoneNumberId}/settings`, args.accessToken, {
    calling: args.calling,
  })
}

// ============================================================
// Call actions (user-initiated: pre_accept / accept / reject;
// any call: terminate)
// ============================================================

export type CallAction = 'pre_accept' | 'accept' | 'reject' | 'terminate'

export interface CallActionArgs extends PhoneNumberArgs {
  callId: string
  action: CallAction
  /** SDP answer — required for pre_accept and accept. */
  sdp?: string
  /** Echoed back on later webhooks for this call. */
  callbackData?: string
  /** Only honoured on `accept`. */
  recording?: CallRecordingRequest | null
}

export async function sendCallAction(args: CallActionArgs): Promise<void> {
  const { phoneNumberId, accessToken, callId, action, sdp, callbackData } = args
  const needsSdp = action === 'pre_accept' || action === 'accept'
  if (needsSdp && !sdp) {
    throw new Error(`Call action ${action} requires an SDP answer`)
  }
  await postJson(`${CALLING_API_BASE}/${phoneNumberId}/calls`, accessToken, {
    messaging_product: 'whatsapp',
    call_id: callId,
    action,
    ...(needsSdp ? { session: { sdp_type: 'answer', sdp } } : {}),
    ...(callbackData && action === 'accept'
      ? { biz_opaque_callback_data: callbackData.slice(0, CALLING_LIMITS.callbackData) }
      : {}),
    ...(action === 'accept' ? recordingField(args.recording) : {}),
  })
}

// ============================================================
// Business-initiated calls
// ============================================================

export interface ConnectCallArgs extends PhoneNumberArgs {
  /** Customer phone (E.164 digits) or business-scoped user id. */
  to: string
  /** SDP offer produced by the agent's browser. */
  sdp: string
  callbackData?: string
  recording?: CallRecordingRequest | null
}

/** POST /{phone_number_id}/calls action=connect → Meta's call id. */
export async function connectCall(args: ConnectCallArgs): Promise<string> {
  const data = (await postJson(
    `${CALLING_API_BASE}/${args.phoneNumberId}/calls`,
    args.accessToken,
    {
      messaging_product: 'whatsapp',
      ...callRecipientFields(args.to),
      action: 'connect',
      session: { sdp_type: 'offer', sdp: args.sdp },
      ...(args.callbackData
        ? { biz_opaque_callback_data: args.callbackData.slice(0, CALLING_LIMITS.callbackData) }
        : {}),
      ...recordingField(args.recording),
    },
  )) as { calls?: Array<{ id?: string }> }
  const id = data?.calls?.[0]?.id
  if (!id) throw new Error('Meta did not return a call id for connect')
  return id
}

// ============================================================
// Call permissions
// ============================================================

export type CallPermissionStatus = 'no_permission' | 'temporary' | 'permanent'

export interface CallPermissionState {
  status: CallPermissionStatus
  /** Unix seconds, for a temporary permission. */
  expiresAt: number | null
  canStartCall: boolean
  canRequestPermission: boolean
}

interface RawPermissionAction {
  action_name?: string
  can_perform_action?: boolean
}

/** Pure — exported for tests. */
export function parseCallPermissionResponse(raw: unknown): CallPermissionState {
  const data = (raw ?? {}) as {
    permission?: { status?: string; expiration_time?: number; expiration?: number }
    actions?: RawPermissionAction[]
  }
  const rawStatus = data.permission?.status
  const status: CallPermissionStatus =
    rawStatus === 'temporary' || rawStatus === 'permanent' ? rawStatus : 'no_permission'
  const expiry = data.permission?.expiration_time ?? data.permission?.expiration
  const action = (name: string) =>
    (data.actions ?? []).find((a) => a.action_name === name)?.can_perform_action
  const start = action('start_call')
  const request = action('send_call_permission_request')
  return {
    status,
    expiresAt: typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : null,
    // When Meta leaves the actions list out, fall back on the status.
    canStartCall: start ?? status !== 'no_permission',
    canRequestPermission: request ?? status === 'no_permission',
  }
}

export interface GetCallPermissionArgs extends PhoneNumberArgs {
  /** Customer phone or business-scoped user id. */
  user: string
}

export async function getCallPermission(
  args: GetCallPermissionArgs,
): Promise<CallPermissionState> {
  const param = isBusinessScopedUserId(args.user) ? 'recipient' : 'user_wa_id'
  const url =
    `${CALLING_API_BASE}/${args.phoneNumberId}/call_permissions` +
    `?${param}=${encodeURIComponent(args.user.trim())}`
  return parseCallPermissionResponse(await getJson(url, args.accessToken))
}

export interface SendCallPermissionRequestArgs extends PhoneNumberArgs {
  to: string
  bodyText: string
}

/**
 * Free-form interactive call-permission request. Only allowed inside
 * the 24-hour customer service window; outside it Meta rejects the send
 * and a template with a call-permission component is needed instead.
 * Returns the wamid.
 */
export async function sendCallPermissionRequest(
  args: SendCallPermissionRequestArgs,
): Promise<string> {
  const recipient = isBusinessScopedUserId(args.to)
    ? { recipient: args.to.trim() }
    : { recipient_type: 'individual', to: args.to }
  const data = (await postJson(
    `${CALLING_API_BASE}/${args.phoneNumberId}/messages`,
    args.accessToken,
    {
      messaging_product: 'whatsapp',
      ...recipient,
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        ...(args.bodyText.trim() ? { body: { text: args.bodyText.trim().slice(0, 1024) } } : {}),
      },
    },
  )) as { messages?: Array<{ id?: string }> }
  const id = data?.messages?.[0]?.id
  if (!id) throw new Error('Meta did not return a message id')
  return id
}
