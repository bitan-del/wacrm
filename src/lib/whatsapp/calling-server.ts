/**
 * Shared server helpers for the /api/whatsapp/calls/* routes.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { MetaApiError } from './meta-api'
import {
  isRecordingAnnouncementLanguage,
  type CallRecordingRequest,
} from './calling-api'
import { getT } from '@/lib/i18n/translate'
import { VoiceServerError } from './voice-server'

const t = getT('Api.calls')

export interface CallingConfig {
  phoneNumberId: string
  accessToken: string
  callingEnabled: boolean
  recording: CallRecordingRequest | null
  /** Raw settings, for the Settings screen. */
  recordingEnabled: boolean
  recordingPurpose: string | null
  recordingLanguage: string | null
}

/**
 * The account's WhatsApp connection with the token decrypted. Null when
 * there is no connected number. Reads under the caller's RLS (every
 * member may read whatsapp_config).
 */
export async function loadCallingConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<CallingConfig | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select(
      'phone_number_id, access_token, status, calling_enabled, call_recording_enabled, call_recording_purpose, call_recording_language',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data || !data.phone_number_id || !data.access_token) return null

  const purpose = (data.call_recording_purpose as string | null)?.trim() || null
  const language = data.call_recording_language as string | null
  const recording =
    data.call_recording_enabled && purpose && isRecordingAnnouncementLanguage(language)
      ? { purpose, announcementLanguage: language }
      : null

  return {
    phoneNumberId: data.phone_number_id,
    accessToken: decrypt(data.access_token),
    callingEnabled: data.calling_enabled === true,
    recording,
    recordingEnabled: data.call_recording_enabled === true,
    recordingPurpose: purpose,
    recordingLanguage: language,
  }
}

/**
 * Run a Meta call that carries an optional recording request. If Meta
 * rejects the request while recording was asked for, retry once without
 * it: a call that connects unrecorded beats a lost customer call. The
 * second element reports whether recording survived.
 */
export async function withRecordingFallback<T>(
  recording: CallRecordingRequest | null,
  run: (recording: CallRecordingRequest | null) => Promise<T>,
): Promise<[T, boolean]> {
  if (!recording) return [await run(null), false]
  try {
    return [await run(recording), true]
  } catch (err) {
    if (err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
      console.warn('[calls] Meta rejected the recording request; retrying unrecorded:', err.message)
      return [await run(null), false]
    }
    throw err
  }
}

export interface CallingErrorBody {
  error: string
  meta?: { code: number | null; subcode: number | null; fbtrace_id: string | null; message: string }
}

/** Map a Meta calling failure to an actionable message + HTTP status. */
export function explainCallingError(err: unknown): { status: number; body: CallingErrorBody } {
  if (err instanceof VoiceServerError) {
    console.error('[calls] voice server error:', err.message)
    return { status: 502, body: { error: t('aiServerError') } }
  }
  if (!(err instanceof MetaApiError)) {
    console.error('[calls] unexpected error:', err)
    return { status: 500, body: { error: t('unexpected') } }
  }
  const meta = {
    code: err.code,
    subcode: err.subcode,
    fbtrace_id: err.fbtraceId,
    message: err.details ?? err.message,
  }
  const key = (() => {
    switch (err.code) {
      case 138006:
        return 'noPermission'
      case 138015:
        return 'tierTooLow'
      case 138002:
      case 138003:
        return 'alreadyInCall'
      case 138012:
      case 138037:
        return 'limitReached'
      case 131047:
        return 'outsideWindow'
      case 131055:
        return 'sipEnabled'
      case 190:
        return 'tokenInvalid'
      case 10:
      case 200:
        return 'missingPermission'
      default:
        return null
    }
  })()
  const message = key ? t(key) : t('metaRejected', { message: meta.message })
  return {
    status: err.httpStatus >= 500 ? 502 : 400,
    body: { error: message, meta },
  }
}

export function callingErrorResponse(err: unknown): NextResponse {
  const { status, body } = explainCallingError(err)
  return NextResponse.json(body, { status })
}
