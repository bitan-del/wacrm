/**
 * The AI agent on WhatsApp calls (migration 064).
 *
 * The app decides WHEN the AI takes a call and relays signalling; the
 * voice server (see voice-server.ts) does the audio with Gemini Live.
 *
 *  inbound:  ringing row → (now, or after N unanswered seconds) claim it
 *            for the AI → voice server builds an SDP answer from Meta's
 *            offer → Meta pre_accept + accept → voice server /start.
 *  outbound: voice server builds an SDP offer → Meta connect → Meta's
 *            answer (webhook) → voice server; ACCEPTED → /start.
 *  ending:   Meta terminate / agent hang-up → voice server /end; the AI's
 *            end_call → /api/whatsapp/calls/ai-events → Meta terminate.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { sendCallAction } from './calling-api'
import { loadCallingConfig, withRecordingFallback } from './calling-server'
import type { CallEvent } from './call-events'
import {
  createVoiceSession,
  endVoiceSession,
  setVoiceRemoteDescription,
  startVoiceSession,
  voiceServerConfig,
  type VoicePersona,
} from './voice-server'
import { findCallRow } from './call-store'
import { normalizePhone } from './phone-utils'
import type { CallAiInboundMode, PhoneAiProvider } from '@/types'

/** Gemini Live prebuilt voices offered in Settings. */
export const GEMINI_VOICES = [
  'Kore',
  'Aoede',
  'Leda',
  'Zephyr',
  'Puck',
  'Charon',
  'Fenrir',
  'Orus',
] as const

export const DEFAULT_AI_INSTRUCTIONS =
  'You are a warm, polite customer-care agent for this business. Keep every reply short (one or two sentences), ' +
  'speak the language the customer speaks, ask one question at a time, never invent prices, policies or order ' +
  'details you were not given, and offer to have a human call back when you are unsure. When the conversation ' +
  'is done, say a friendly goodbye and end the call.'

export interface PhoneAiConnector {
  provider: PhoneAiProvider
  label: string
  baseUrl: string
  path: string
  authHeader: string
  apiKey: string
}

export interface CallAiConfig {
  enabled: boolean
  inboundMode: CallAiInboundMode
  unansweredAfterSeconds: number
  persona: VoicePersona
  geminiApiKey: string | null
  phoneAi: PhoneAiConnector | null
}

interface CallAiRow {
  enabled: boolean
  inbound_mode: CallAiInboundMode
  unanswered_after_seconds: number
  persona_name: string | null
  voice: string
  language: string
  greeting: string | null
  instructions: string | null
  max_duration_seconds: number
  gemini_api_key: string | null
  phone_ai_provider: PhoneAiProvider | null
  phone_ai_label: string | null
  phone_ai_base_url: string | null
  phone_ai_path: string | null
  phone_ai_auth_header: string | null
  phone_ai_api_key: string | null
}

function safeDecrypt(value: string | null): string | null {
  if (!value) return null
  try {
    return decrypt(value)
  } catch {
    console.error('[calls] could not decrypt a stored AI key (ENCRYPTION_KEY changed?)')
    return null
  }
}

/** Default paths / auth headers per provider. */
export const PHONE_AI_PRESETS: Record<PhoneAiProvider, { path: string; authHeader: string }> = {
  // Nutriherb panel: Nutri Voice AI (Plivo + Gemini Live). Admin key header.
  nutriherb: { path: '/api/admin/voice/test', authHeader: 'X-Admin-Key' },
  // Dakiya (OpenWA): API key header; the call endpoint path is set by the user.
  dakiya: { path: '', authHeader: 'X-API-Key' },
  custom: { path: '', authHeader: 'Authorization' },
}

export function rowToCallAiConfig(row: CallAiRow | null): CallAiConfig | null {
  if (!row) return null
  const phoneKey = safeDecrypt(row.phone_ai_api_key)
  const provider = row.phone_ai_provider
  const phoneAi: PhoneAiConnector | null =
    provider && row.phone_ai_base_url && phoneKey
      ? {
          provider,
          label: row.phone_ai_label?.trim() || provider,
          baseUrl: row.phone_ai_base_url.replace(/\/+$/, ''),
          path: row.phone_ai_path?.trim() || PHONE_AI_PRESETS[provider].path,
          authHeader: row.phone_ai_auth_header?.trim() || PHONE_AI_PRESETS[provider].authHeader,
          apiKey: phoneKey,
        }
      : null
  return {
    enabled: row.enabled,
    inboundMode: row.inbound_mode,
    unansweredAfterSeconds: row.unanswered_after_seconds,
    persona: {
      name: row.persona_name?.trim() || 'Assistant',
      voice: row.voice || 'Kore',
      language: row.language || 'auto',
      greeting: row.greeting?.trim() || '',
      instructions: row.instructions?.trim() || DEFAULT_AI_INSTRUCTIONS,
      max_duration_seconds: row.max_duration_seconds || 600,
    },
    geminiApiKey: safeDecrypt(row.gemini_api_key),
    phoneAi,
  }
}

export async function loadCallAiConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<CallAiConfig | null> {
  const { data } = await db
    .from('call_ai_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  return rowToCallAiConfig((data as CallAiRow | null) ?? null)
}

/** Can the WhatsApp AI agent take or place calls for this account right now? */
export function aiCallingReady(config: CallAiConfig | null): config is CallAiConfig & { geminiApiKey: string } {
  return !!config && config.enabled && !!config.geminiApiKey && !!voiceServerConfig()
}

export function aiEventsCallbackUrl(): string {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  return `${site}/api/whatsapp/calls/ai-events`
}

async function callContext(
  admin: SupabaseClient,
  accountId: string,
  contactId: string | null,
  customerWaId: string | null,
) {
  const [{ data: account }, contactRes] = await Promise.all([
    admin.from('accounts').select('name').eq('id', accountId).maybeSingle(),
    contactId
      ? admin.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const contact = contactRes.data as { name?: string | null; phone?: string | null } | null
  return {
    business_name: (account as { name?: string } | null)?.name ?? undefined,
    customer_name: contact?.name?.trim() || undefined,
    customer_phone: contact?.phone || customerWaId || undefined,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Give a ringing inbound call to the AI. Returns false (and leaves the
 * call ringing for humans) if anything along the way fails.
 */
export async function handOffInboundCallToAi(
  admin: SupabaseClient,
  accountId: string,
  callRowId: string,
): Promise<boolean> {
  const ai = await loadCallAiConfig(admin, accountId)
  const voice = voiceServerConfig()
  if (!aiCallingReady(ai) || !voice) return false

  const { data: claimed } = await admin
    .from('calls')
    .update({ status: 'answering', handled_by_ai: true, answered_by: null })
    .eq('id', callRowId)
    .eq('account_id', accountId)
    .eq('direction', 'inbound')
    .eq('status', 'ringing')
    .select('id, wa_call_id, sdp_offer, contact_id, customer_wa_id')
  const call = claimed?.[0] as
    | { id: string; wa_call_id: string | null; sdp_offer: string | null; contact_id: string | null; customer_wa_id: string | null }
    | undefined
  if (!call) return false // a human (or a retry) got there first

  const giveBack = async (why: string) => {
    console.warn(`[calls] AI could not take ${call.id}: ${why}`)
    await endVoiceSession(voice, call.id, 'handoff_failed')
    await admin
      .from('calls')
      .update({ status: 'ringing', handled_by_ai: false })
      .eq('id', call.id)
      .eq('status', 'answering')
    return false
  }

  if (!call.wa_call_id || !call.sdp_offer) return giveBack('missing call id or SDP offer')

  const config = await loadCallingConfig(admin, accountId)
  if (!config) return giveBack('WhatsApp not connected')

  try {
    const sdp = await createVoiceSession(voice, {
      sessionId: call.id,
      direction: 'inbound',
      sdpOffer: call.sdp_offer,
      persona: ai.persona,
      context: await callContext(admin, accountId, call.contact_id, call.customer_wa_id),
      geminiApiKey: ai.geminiApiKey,
      callbackUrl: aiEventsCallbackUrl(),
    })
    await sendCallAction({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      callId: call.wa_call_id,
      action: 'pre_accept',
      sdp,
    })
    const [, recorded] = await withRecordingFallback(config.recording, (recording) =>
      sendCallAction({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        callId: call.wa_call_id as string,
        action: 'accept',
        sdp,
        callbackData: call.id,
        recording,
      }),
    )
    await admin
      .from('calls')
      .update({
        status: 'in_progress',
        answered_at: new Date().toISOString(),
        sdp_offer: null,
        ...(recorded ? { recording_status: 'requested' } : {}),
      })
      .eq('id', call.id)
      .eq('status', 'answering')
    await startVoiceSession(voice, call.id)
    return true
  } catch (err) {
    return giveBack(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Decide whether the AI should take a just-recorded inbound call, per
 * the account's mode. Runs inside the webhook's after() budget (60 s),
 * which is why the "unanswered" delay is capped at 30 s.
 */
export async function routeIncomingCallToAi(
  admin: SupabaseClient,
  accountId: string,
  callRowId: string,
): Promise<void> {
  const ai = await loadCallAiConfig(admin, accountId)
  if (!aiCallingReady(ai) || ai.inboundMode === 'off') return
  if (ai.inboundMode === 'unanswered') {
    await sleep(Math.min(30, Math.max(5, ai.unansweredAfterSeconds)) * 1000)
  }
  await handOffInboundCallToAi(admin, accountId, callRowId)
}

/**
 * Keep the voice server in step with Meta's events for AI-handled calls:
 * deliver Meta's SDP answer, start talking when the customer picks up,
 * stop when the call ends.
 */
export async function forwardCallEventToVoiceServer(
  admin: SupabaseClient,
  accountId: string,
  event: CallEvent,
): Promise<void> {
  if (event.kind === 'incoming' || event.kind === 'recording') return
  const voice = voiceServerConfig()
  if (!voice) return
  const row = await findCallRow(admin, accountId, event)
  if (!row) return
  const { data } = await admin
    .from('calls')
    .select('handled_by_ai, direction')
    .eq('id', row.id)
    .maybeSingle()
  if (!(data as { handled_by_ai?: boolean } | null)?.handled_by_ai) return

  try {
    if (event.kind === 'outbound_answer') {
      await setVoiceRemoteDescription(voice, row.id, event.sdpAnswer)
      // If Meta reported ACCEPTED before its SDP answer, the /start sent
      // then was refused (no remote description yet) — start now.
      if (row.status === 'in_progress') await startVoiceSession(voice, row.id)
    } else if (event.kind === 'status' && event.status === 'ACCEPTED') {
      await startVoiceSession(voice, row.id)
    } else if (event.kind === 'terminate' || (event.kind === 'status' && event.status === 'REJECTED')) {
      await endVoiceSession(voice, row.id, event.kind === 'terminate' ? 'call_ended' : 'rejected')
    }
  } catch (err) {
    console.error(
      `[calls] voice server sync failed for ${row.id} (${event.kind}):`,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * HTTP request that asks an external phone-AI system to call a contact.
 * Pure — exported for tests.
 */
export function buildPhoneAiRequest(
  connector: PhoneAiConnector,
  contact: { name: string; phone: string },
  meta: { conversationId: string },
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const digits = normalizePhone(contact.phone)
  const headerValue =
    connector.authHeader.toLowerCase() === 'authorization' && !/^bearer\s/i.test(connector.apiKey)
      ? `Bearer ${connector.apiKey}`
      : connector.apiKey
  const headers = { 'Content-Type': 'application/json', [connector.authHeader]: headerValue }
  const url = `${connector.baseUrl}${connector.path}`
  if (connector.provider === 'nutriherb') {
    // Nutri Voice AI's call endpoint takes a 10-digit Indian mobile.
    return {
      url,
      headers,
      body: { phone: digits.slice(-10), name: contact.name, live: true },
    }
  }
  return {
    url,
    headers,
    body: {
      phone: digits,
      phone_e164: `+${digits}`,
      name: contact.name,
      source: 'wacrm',
      conversation_id: meta.conversationId,
    },
  }
}
