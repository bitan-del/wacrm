/**
 * Database side of WhatsApp calling, run with the service-role client
 * from the webhook (and from the call routes where RLS can't express
 * the write). The state machine itself lives in `call-events.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Call } from '@/types'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { getMediaUrl, downloadMedia } from './meta-api'
import {
  patchForCallEvent,
  type CallEvent,
  type CallStateRow,
} from './call-events'

export const CALL_RECORDINGS_BUCKET = 'call-recordings'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CallRow = Pick<
  Call,
  'id' | 'account_id' | 'wa_call_id' | 'status' | 'direction' | 'answered_at' | 'ended_at'
>

const ROW_COLUMNS = 'id, account_id, wa_call_id, status, direction, answered_at, ended_at'

/**
 * Find the call a webhook event is about: by Meta's call id, falling
 * back to our own row id echoed in `biz_opaque_callback_data` (an
 * outbound call's first webhook can beat the UPDATE that stores Meta's
 * id on the row).
 */
export async function findCallRow(
  admin: SupabaseClient,
  accountId: string,
  ref: { callId: string; callbackData?: string | null },
): Promise<CallRow | null> {
  const { data: byWa } = await admin
    .from('calls')
    .select(ROW_COLUMNS)
    .eq('account_id', accountId)
    .eq('wa_call_id', ref.callId)
    .maybeSingle()
  if (byWa) return byWa as CallRow

  const own = ref.callbackData?.trim()
  if (own && UUID_RE.test(own)) {
    const { data: byOwn } = await admin
      .from('calls')
      .select(ROW_COLUMNS)
      .eq('account_id', accountId)
      .eq('id', own)
      .maybeSingle()
    if (byOwn) return byOwn as CallRow
  }
  return null
}

export interface RecordIncomingCallArgs {
  accountId: string
  phoneNumberId: string
  callId: string
  contactId: string | null
  conversationId: string | null
  customerWaId: string | null
  sdpOffer: string
  startedAt: string | null
}

/**
 * Insert a ringing inbound call and return its row id. Meta retries are
 * absorbed by the unique wa_call_id (and return null — already handled).
 */
export async function recordIncomingCall(
  admin: SupabaseClient,
  args: RecordIncomingCallArgs,
): Promise<string | null> {
  const { data, error } = await admin.from('calls').insert({
    account_id: args.accountId,
    wa_call_id: args.callId,
    phone_number_id: args.phoneNumberId,
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    direction: 'inbound',
    status: 'ringing',
    customer_wa_id: args.customerWaId,
    sdp_offer: args.sdpOffer,
    started_at: args.startedAt ?? new Date().toISOString(),
  }).select('id').single()
  if (error) {
    if (!isUniqueViolation(error)) {
      console.error('[calls] failed to record incoming call', args.callId, error.message)
    }
    return null
  }
  return (data as { id: string }).id
}

/**
 * Apply a state-moving event to its call row. The UPDATE is guarded on
 * the status we read, so a concurrent writer (an agent answering while
 * the caller hangs up) is never overwritten blindly — on a lost race we
 * re-read once and re-derive the patch from the fresh row.
 */
export async function applyCallEvent(
  admin: SupabaseClient,
  accountId: string,
  event: Exclude<CallEvent, { kind: 'incoming' } | { kind: 'recording' }>,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await findCallRow(admin, accountId, event)
    if (!row) {
      console.warn(`[calls] ${event.kind} for unknown call ${event.callId}`)
      return
    }
    const patch: Record<string, unknown> = {
      ...patchForCallEvent(row as CallStateRow, event),
    }
    if (!row.wa_call_id) patch.wa_call_id = event.callId
    if (Object.keys(patch).length === 0) return

    const { data, error } = await admin
      .from('calls')
      .update(patch)
      .eq('id', row.id)
      .eq('status', row.status)
      .select('id')
    if (error) {
      console.error(`[calls] failed to apply ${event.kind} to ${row.id}:`, error.message)
      return
    }
    if (data && data.length > 0) return
  }
  console.warn(`[calls] ${event.kind} for ${event.callId} lost two status races; skipped`)
}

function extensionFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4') || m.includes('aac')) return 'm4a'
  if (m.includes('webm')) return 'webm'
  if (m.includes('wav')) return 'wav'
  return 'ogg'
}

/** Storage content type without codec params (the bucket allow-list matches bare types). */
function bareMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase() || 'audio/ogg'
}

/**
 * Mirror Meta's recording into the private bucket. Meta's URL lives 5
 * minutes and the file 7 days, so this runs straight from the webhook.
 */
export async function storeCallRecording(
  admin: SupabaseClient,
  accountId: string,
  event: Extract<CallEvent, { kind: 'recording' }>,
  accessToken: string,
): Promise<void> {
  const row = await findCallRow(admin, accountId, { callId: event.callId })
  if (!row) {
    console.warn(`[calls] recording for unknown call ${event.callId}`)
    return
  }

  try {
    let file: { buffer: Buffer; contentType: string } | null = null
    if (event.audio.url) {
      file = await downloadMedia({ downloadUrl: event.audio.url, accessToken }).catch(() => null)
    }
    if (!file && event.audio.id) {
      const fresh = await getMediaUrl({ mediaId: event.audio.id, accessToken })
      file = await downloadMedia({ downloadUrl: fresh.url, accessToken })
    }
    if (!file) throw new Error('recording webhook carried neither a usable url nor a media id')

    const mime = bareMime(event.audio.mimeType ?? file.contentType)
    const path = `account-${accountId}/${row.id}.${extensionFor(mime)}`
    const { error: uploadError } = await admin.storage
      .from(CALL_RECORDINGS_BUCKET)
      .upload(path, file.buffer, { contentType: mime, upsert: true })
    if (uploadError) throw new Error(uploadError.message)

    await admin
      .from('calls')
      .update({ recording_status: 'available', recording_path: path, recording_mime: mime })
      .eq('id', row.id)
  } catch (err) {
    console.error(
      `[calls] could not store recording for ${row.id}:`,
      err instanceof Error ? err.message : err,
    )
    await admin.from('calls').update({ recording_status: 'failed' }).eq('id', row.id)
  }
}
