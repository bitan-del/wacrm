/**
 * Client for the AI voice server (`voice-server/` in this repo).
 *
 * WhatsApp call audio is WebRTC, which a serverless function can't hold
 * open, so AI calls run on a separate always-on service. This app only
 * signals it: hand over Meta's SDP offer (or ask it for an offer), tell
 * it when the call goes live or ends, and receive its events (hang-up
 * requests, transcript) at /api/whatsapp/calls/ai-events.
 *
 * Platform-level config (not per account):
 *   VOICE_SERVER_URL     e.g. https://voice.example.com
 *   VOICE_SERVER_SECRET  shared secret — Bearer auth one way, HMAC
 *                        signature (X-Voice-Signature) the other way.
 */

import crypto from 'node:crypto'

export interface VoiceServerConfig {
  url: string
  secret: string
}

export function voiceServerConfig(): VoiceServerConfig | null {
  const url = process.env.VOICE_SERVER_URL?.trim().replace(/\/+$/, '')
  const secret = process.env.VOICE_SERVER_SECRET?.trim()
  if (!url || !secret) return null
  return { url, secret }
}

export class VoiceServerError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'VoiceServerError'
  }
}

async function call<T>(
  cfg: VoiceServerConfig,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new VoiceServerError(
      `voice server unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const text = await res.text()
  if (!res.ok) {
    throw new VoiceServerError(`voice server ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

export interface VoicePersona {
  name: string
  voice: string
  language: string
  greeting: string
  instructions: string
  max_duration_seconds: number
}

export interface CreateVoiceSessionArgs {
  sessionId: string
  direction: 'inbound' | 'outbound'
  /** Inbound only: Meta's SDP offer. */
  sdpOffer?: string
  persona: VoicePersona
  context: { customer_name?: string; customer_phone?: string; business_name?: string; notes?: string }
  geminiApiKey: string
  callbackUrl: string
}

/** Returns our SDP answer (inbound) or our SDP offer (outbound). */
export async function createVoiceSession(
  cfg: VoiceServerConfig,
  args: CreateVoiceSessionArgs,
): Promise<string> {
  const data = await call<{ sdp?: string }>(
    cfg,
    '/v1/sessions',
    {
      session_id: args.sessionId,
      direction: args.direction,
      ...(args.sdpOffer ? { sdp_offer: args.sdpOffer } : {}),
      persona: args.persona,
      context: args.context,
      gemini: { api_key: args.geminiApiKey },
      callback: { url: args.callbackUrl },
    },
    12_000,
  )
  if (!data.sdp) throw new VoiceServerError('voice server returned no SDP')
  return data.sdp
}

export async function setVoiceRemoteDescription(
  cfg: VoiceServerConfig,
  sessionId: string,
  sdp: string,
): Promise<void> {
  await call(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/remote-description`, { sdp }, 8_000)
}

export async function startVoiceSession(cfg: VoiceServerConfig, sessionId: string): Promise<void> {
  await call(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/start`, {}, 8_000)
}

/** Best effort — a session that's already gone is fine. */
export async function endVoiceSession(
  cfg: VoiceServerConfig,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await call(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/end`, { reason }, 5_000)
  } catch (err) {
    if (err instanceof VoiceServerError && err.status === 404) return
    console.warn('[calls] could not end voice session', sessionId, err instanceof Error ? err.message : err)
  }
}

export async function voiceServerHealth(
  cfg: VoiceServerConfig,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(3_000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Verify `X-Voice-Signature: sha256=<hex>` on a callback body. */
export function verifyVoiceSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
