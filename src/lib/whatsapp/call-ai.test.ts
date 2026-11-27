import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encrypt } from './encryption'
import {
  DEFAULT_AI_INSTRUCTIONS,
  buildPhoneAiRequest,
  rowToCallAiConfig,
  type PhoneAiConnector,
} from './call-ai'
import { verifyVoiceSignature } from './voice-server'

const baseRow = {
  enabled: true,
  inbound_mode: 'unanswered' as const,
  unanswered_after_seconds: 15,
  persona_name: '  Aisha ',
  voice: 'Kore',
  language: 'hi-IN',
  greeting: 'Namaste!',
  instructions: 'Be kind.',
  max_duration_seconds: 300,
  gemini_api_key: null as string | null,
  phone_ai_provider: null as PhoneAiConnector['provider'] | null,
  phone_ai_label: null as string | null,
  phone_ai_base_url: null as string | null,
  phone_ai_path: null as string | null,
  phone_ai_auth_header: null as string | null,
  phone_ai_api_key: null as string | null,
}

describe('rowToCallAiConfig', () => {
  it('returns null without a row', () => {
    expect(rowToCallAiConfig(null)).toBeNull()
  })

  it('builds the persona and decrypts the Gemini key', () => {
    const config = rowToCallAiConfig({ ...baseRow, gemini_api_key: encrypt('gm-key') })
    expect(config?.geminiApiKey).toBe('gm-key')
    expect(config?.persona).toEqual({
      name: 'Aisha',
      voice: 'Kore',
      language: 'hi-IN',
      greeting: 'Namaste!',
      instructions: 'Be kind.',
      max_duration_seconds: 300,
    })
    expect(config?.inboundMode).toBe('unanswered')
    expect(config?.phoneAi).toBeNull()
  })

  it('falls back to default guidelines and name', () => {
    const config = rowToCallAiConfig({ ...baseRow, persona_name: null, instructions: '  ' })
    expect(config?.persona.name).toBe('Assistant')
    expect(config?.persona.instructions).toBe(DEFAULT_AI_INSTRUCTIONS)
  })

  it('fills the Nutriherb preset path and header', () => {
    const config = rowToCallAiConfig({
      ...baseRow,
      phone_ai_provider: 'nutriherb',
      phone_ai_base_url: 'https://first.try.nutriherbs.in/',
      phone_ai_api_key: encrypt('admin-pass'),
    })
    expect(config?.phoneAi).toEqual({
      provider: 'nutriherb',
      label: 'nutriherb',
      baseUrl: 'https://first.try.nutriherbs.in',
      path: '/api/admin/voice/test',
      authHeader: 'X-Admin-Key',
      apiKey: 'admin-pass',
    })
  })

  it('ignores a connector without a usable key', () => {
    const config = rowToCallAiConfig({
      ...baseRow,
      phone_ai_provider: 'dakiya',
      phone_ai_base_url: 'https://whatsapp.outreach-pro.in',
      phone_ai_api_key: 'not-encrypted',
    })
    expect(config?.phoneAi).toBeNull()
  })
})

describe('buildPhoneAiRequest', () => {
  const contact = { name: 'Ravi', phone: '+91 98765-43210' }

  it('sends Nutriherb a 10-digit number with the admin key', () => {
    const req = buildPhoneAiRequest(
      {
        provider: 'nutriherb',
        label: 'Nutriherb',
        baseUrl: 'https://first.try.nutriherbs.in',
        path: '/api/admin/voice/test',
        authHeader: 'X-Admin-Key',
        apiKey: 'secret',
      },
      contact,
      { conversationId: 'c1' },
    )
    expect(req.url).toBe('https://first.try.nutriherbs.in/api/admin/voice/test')
    expect(req.headers['X-Admin-Key']).toBe('secret')
    expect(req.body).toEqual({ phone: '9876543210', name: 'Ravi', live: true })
  })

  it('sends other systems the full international number and adds Bearer for Authorization', () => {
    const req = buildPhoneAiRequest(
      {
        provider: 'custom',
        label: 'Mine',
        baseUrl: 'https://calls.example.com',
        path: '/start',
        authHeader: 'Authorization',
        apiKey: 'tok',
      },
      { name: 'Ana', phone: '+55 11 91234-5678' },
      { conversationId: 'conv-9' },
    )
    expect(req.headers.Authorization).toBe('Bearer tok')
    expect(req.body).toEqual({
      phone: '5511912345678',
      phone_e164: '+5511912345678',
      name: 'Ana',
      source: 'wacrm',
      conversation_id: 'conv-9',
    })
  })
})

describe('verifyVoiceSignature', () => {
  const secret = 'voice-secret'
  const body = JSON.stringify({ session_id: 'x', type: 'ended' })
  const sign = (b: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(b).digest('hex')

  it('accepts a correct signature and rejects anything else', () => {
    expect(verifyVoiceSignature(body, sign(body), secret)).toBe(true)
    expect(verifyVoiceSignature(body + ' ', sign(body), secret)).toBe(false)
    expect(verifyVoiceSignature(body, null, secret)).toBe(false)
    expect(verifyVoiceSignature(body, 'sha256=00', secret)).toBe(false)
    expect(verifyVoiceSignature(body, sign(body).replace('sha256=', ''), secret)).toBe(false)
  })
})
