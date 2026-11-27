import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  DEFAULT_AI_INSTRUCTIONS,
  GEMINI_VOICES,
  PHONE_AI_PRESETS,
} from '@/lib/whatsapp/call-ai'
import { voiceServerConfig, voiceServerHealth } from '@/lib/whatsapp/voice-server'
import type { CallAiInboundMode, PhoneAiProvider } from '@/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

const LIMITS = { name: 60, greeting: 500, instructions: 8000, language: 20, label: 60, url: 300, path: 200, header: 60, key: 500 }
const INBOUND_MODES: CallAiInboundMode[] = ['off', 'always', 'unanswered']
const PROVIDERS: PhoneAiProvider[] = ['nutriherb', 'dakiya', 'custom']

/**
 * GET /api/whatsapp/calls/ai-settings — the AI call agent + phone-AI
 * connector for this account. Secrets are never returned, only whether
 * they're set. Any member may read.
 */
export async function GET(request: Request) {
  try {
    // ?lite=1 skips the voice-server ping (used on every page load).
    const lite = new URL(request.url).searchParams.get('lite') === '1'
    const { supabase, accountId } = await getCurrentAccount()
    const { data } = await supabase
      .from('call_ai_settings')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()
    const row = (data ?? {}) as Record<string, unknown>

    const voice = voiceServerConfig()
    const health = voice && !lite ? await voiceServerHealth(voice) : null

    return NextResponse.json({
      enabled: row.enabled === true,
      inbound_mode: (row.inbound_mode as string) ?? 'off',
      unanswered_after_seconds: (row.unanswered_after_seconds as number) ?? 20,
      persona_name: (row.persona_name as string) ?? '',
      voice: (row.voice as string) ?? 'Kore',
      language: (row.language as string) ?? 'auto',
      greeting: (row.greeting as string) ?? '',
      instructions: (row.instructions as string) ?? '',
      default_instructions: DEFAULT_AI_INSTRUCTIONS,
      max_duration_seconds: (row.max_duration_seconds as number) ?? 600,
      has_gemini_key: !!row.gemini_api_key,
      voices: GEMINI_VOICES,
      voice_server: {
        configured: !!voice,
        reachable: health?.ok ?? false,
        error: health && !health.ok ? health.error ?? null : null,
      },
      phone_ai: {
        provider: (row.phone_ai_provider as string) ?? null,
        label: (row.phone_ai_label as string) ?? '',
        base_url: (row.phone_ai_base_url as string) ?? '',
        path: (row.phone_ai_path as string) ?? '',
        auth_header: (row.phone_ai_auth_header as string) ?? '',
        has_key: !!row.phone_ai_api_key,
        presets: PHONE_AI_PRESETS,
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  return v.trim().slice(0, max)
}

/** POST — admins only. Every field optional; secrets: '' keeps, null clears. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!b) return NextResponse.json({ error: t('badRequest') }, { status: 400 })

    const { data: existing } = await supabase
      .from('call_ai_settings')
      .select('gemini_api_key, phone_ai_api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    const patch: Record<string, unknown> = {}
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
    if (typeof b.inbound_mode === 'string') {
      if (!INBOUND_MODES.includes(b.inbound_mode as CallAiInboundMode)) {
        return NextResponse.json({ error: t('badRequest') }, { status: 400 })
      }
      patch.inbound_mode = b.inbound_mode
    }
    if (typeof b.unanswered_after_seconds === 'number') {
      patch.unanswered_after_seconds = Math.min(30, Math.max(5, Math.round(b.unanswered_after_seconds)))
    }
    if (typeof b.max_duration_seconds === 'number') {
      patch.max_duration_seconds = Math.min(3600, Math.max(60, Math.round(b.max_duration_seconds)))
    }
    const name = str(b.persona_name, LIMITS.name)
    if (name !== undefined) patch.persona_name = name || null
    if (typeof b.voice === 'string') {
      if (!(GEMINI_VOICES as readonly string[]).includes(b.voice)) {
        return NextResponse.json({ error: t('badRequest') }, { status: 400 })
      }
      patch.voice = b.voice
    }
    const language = str(b.language, LIMITS.language)
    if (language !== undefined) patch.language = language || 'auto'
    const greeting = str(b.greeting, LIMITS.greeting)
    if (greeting !== undefined) patch.greeting = greeting || null
    const instructions = str(b.instructions, LIMITS.instructions)
    if (instructions !== undefined) patch.instructions = instructions || null

    if (b.gemini_api_key === null) patch.gemini_api_key = null
    else {
      const key = str(b.gemini_api_key, LIMITS.key)
      if (key) patch.gemini_api_key = encrypt(key)
    }

    // External phone-AI connector (Nutriherb panel / Dakiya / custom).
    if (b.phone_ai_provider === null) {
      Object.assign(patch, {
        phone_ai_provider: null,
        phone_ai_label: null,
        phone_ai_base_url: null,
        phone_ai_path: null,
        phone_ai_auth_header: null,
        phone_ai_api_key: null,
      })
    } else if (typeof b.phone_ai_provider === 'string') {
      if (!PROVIDERS.includes(b.phone_ai_provider as PhoneAiProvider)) {
        return NextResponse.json({ error: t('badRequest') }, { status: 400 })
      }
      const baseUrl = str(b.phone_ai_base_url, LIMITS.url) ?? ''
      let parsed: URL | null = null
      try {
        parsed = new URL(baseUrl)
      } catch {
        parsed = null
      }
      if (!parsed || parsed.protocol !== 'https:') {
        return NextResponse.json({ error: t('phoneAiBadUrl') }, { status: 400 })
      }
      const path = str(b.phone_ai_path, LIMITS.path) ?? ''
      if (path && !path.startsWith('/')) {
        return NextResponse.json({ error: t('phoneAiBadPath') }, { status: 400 })
      }
      Object.assign(patch, {
        phone_ai_provider: b.phone_ai_provider,
        phone_ai_label: str(b.phone_ai_label, LIMITS.label) || null,
        phone_ai_base_url: parsed.origin + parsed.pathname.replace(/\/+$/, ''),
        phone_ai_path: path || null,
        phone_ai_auth_header: str(b.phone_ai_auth_header, LIMITS.header) || null,
      })
      const key = str(b.phone_ai_api_key, LIMITS.key)
      if (key) patch.phone_ai_api_key = encrypt(key)
      else if (!existing?.phone_ai_api_key) {
        return NextResponse.json({ error: t('phoneAiNeedsKey') }, { status: 400 })
      }
    }

    // The AI can't be switched on without a Gemini key.
    const keyAfter =
      'gemini_api_key' in patch ? patch.gemini_api_key : existing?.gemini_api_key ?? null
    if (patch.enabled === true && !keyAfter) {
      return NextResponse.json({ error: t('aiNeedsKey') }, { status: 400 })
    }

    const { error } = await supabase
      .from('call_ai_settings')
      .upsert({ account_id: accountId, ...patch }, { onConflict: 'account_id' })
    if (error) {
      console.error('[calls] could not save AI settings:', error.message)
      return NextResponse.json({ error: t('unexpected') }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
