import { describe, expect, it } from 'vitest'
import { meetsCallingTier, outboundCallingSupport } from './calling-availability'
import { parseCallPermissionResponse } from './calling-api'

describe('outboundCallingSupport', () => {
  it('blocks US and Canadian business numbers', () => {
    expect(outboundCallingSupport('+1 774-278-6408')).toEqual({ supported: false, blockedCountry: 'US/CA' })
    expect(outboundCallingSupport('+1 416 555 0100')).toEqual({ supported: false, blockedCountry: 'US/CA' })
    // US territory (Puerto Rico) is treated as US.
    expect(outboundCallingSupport('+1 787 555 0100').supported).toBe(false)
  })

  it('allows Caribbean countries that share the +1 plan', () => {
    expect(outboundCallingSupport('+1 876 555 0100')).toEqual({ supported: true, blockedCountry: null })
    expect(outboundCallingSupport('+1 (809) 555-0100').supported).toBe(true)
  })

  it('blocks Egypt, Vietnam and Nigeria', () => {
    expect(outboundCallingSupport('+20 10 1234 5678').blockedCountry).toBe('EG')
    expect(outboundCallingSupport('+84 91 234 5678').blockedCountry).toBe('VN')
    expect(outboundCallingSupport('+234 803 123 4567').blockedCountry).toBe('NG')
  })

  it('allows everywhere else, including India, Brazil, Mexico and the UK', () => {
    for (const phone of ['+91 98765 43210', '+55 11 91234 5678', '+52 55 1234 5678', '+44 20 7946 0958']) {
      expect(outboundCallingSupport(phone)).toEqual({ supported: true, blockedCountry: null })
    }
  })

  it('leaves unknown numbers to Meta', () => {
    expect(outboundCallingSupport(null).supported).toBe(true)
    expect(outboundCallingSupport('').supported).toBe(true)
  })
})

describe('meetsCallingTier', () => {
  it('needs at least 2,000 a day', () => {
    expect(meetsCallingTier({ kind: 'tier', perDay: 250 })).toBe(false)
    expect(meetsCallingTier({ kind: 'tier', perDay: 2000 })).toBe(true)
    expect(meetsCallingTier({ kind: 'tier', perDay: 10000 })).toBe(true)
    expect(meetsCallingTier({ kind: 'unlimited' })).toBe(true)
    expect(meetsCallingTier(null)).toBeNull()
  })
})

describe('parseCallPermissionResponse', () => {
  it('reads a temporary permission and the per-action flags', () => {
    expect(
      parseCallPermissionResponse({
        messaging_product: 'whatsapp',
        permission: { status: 'temporary', expiration_time: 1796000000 },
        actions: [
          { action_name: 'send_call_permission_request', can_perform_action: false },
          { action_name: 'start_call', can_perform_action: true },
        ],
      }),
    ).toEqual({
      status: 'temporary',
      expiresAt: 1796000000,
      canStartCall: true,
      canRequestPermission: false,
    })
  })

  it('treats a missing or unknown permission as none', () => {
    expect(parseCallPermissionResponse({})).toEqual({
      status: 'no_permission',
      expiresAt: null,
      canStartCall: false,
      canRequestPermission: true,
    })
  })

  it('honours Meta saying a call cannot start even with permission (e.g. a limit)', () => {
    expect(
      parseCallPermissionResponse({
        permission: { status: 'permanent' },
        actions: [{ action_name: 'start_call', can_perform_action: false }],
      }).canStartCall,
    ).toBe(false)
  })
})
