/**
 * Where WhatsApp calling works — pure, no I/O.
 *
 * Meta's rules (Calling docs, read 2026-11):
 *  - Customer → business calls work wherever the Cloud API works.
 *  - Business → customer calls depend on the BUSINESS number's country
 *    code. They are unavailable for business numbers in the United
 *    States, Canada, Egypt, Vietnam and Nigeria.
 *  - Calling can only be switched on for a number whose daily messaging
 *    limit is at least 2,000 unique recipients.
 *
 * These lists drift as Meta expands availability, so they only drive UI
 * hints. The server never refuses a call on their account — Meta's own
 * error is the final word and is shown verbatim when it disagrees.
 */

import type { MessagingLimit } from './phone-health'

/** Minimum daily messaging limit Meta requires before calling can be enabled. */
export const CALLING_MIN_DAILY_LIMIT = 2000

/**
 * Dialling prefixes (without "+") of countries where business-initiated
 * calls are unavailable. "1" is special-cased below: the +1 plan also
 * covers independent Caribbean nations that are NOT restricted.
 */
const BUSINESS_INITIATED_BLOCKED: Record<string, string> = {
  '20': 'EG',
  '84': 'VN',
  '234': 'NG',
}

/**
 * +1 area codes that belong to countries other than the US and Canada
 * (US territories such as Puerto Rico or Guam stay treated as US).
 */
const NANP_NON_US_CA_AREA_CODES = new Set([
  '242', // Bahamas
  '246', // Barbados
  '264', // Anguilla
  '268', // Antigua and Barbuda
  '284', // British Virgin Islands
  '345', // Cayman Islands
  '441', // Bermuda
  '473', // Grenada
  '649', // Turks and Caicos
  '658', // Jamaica
  '664', // Montserrat
  '721', // Sint Maarten
  '758', // Saint Lucia
  '767', // Dominica
  '784', // Saint Vincent and the Grenadines
  '809', // Dominican Republic
  '829', // Dominican Republic
  '849', // Dominican Republic
  '868', // Trinidad and Tobago
  '869', // Saint Kitts and Nevis
  '876', // Jamaica
])

function digitsOnly(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '')
}

export interface OutboundCallingSupport {
  /** False when Meta does not allow business-initiated calls from this number's country. */
  supported: boolean
  /** ISO country of the restriction, when unsupported ('US/CA' for the +1 plan). */
  blockedCountry: string | null
}

/**
 * Can this business number place calls to customers?
 * Unknown / unparseable numbers are reported as supported — Meta decides.
 */
export function outboundCallingSupport(
  businessPhone: string | null | undefined,
): OutboundCallingSupport {
  const digits = digitsOnly(businessPhone)
  if (!digits) return { supported: true, blockedCountry: null }

  if (digits.startsWith('1') && digits.length === 11) {
    const area = digits.slice(1, 4)
    if (NANP_NON_US_CA_AREA_CODES.has(area)) {
      return { supported: true, blockedCountry: null }
    }
    return { supported: false, blockedCountry: 'US/CA' }
  }

  for (const prefix of Object.keys(BUSINESS_INITIATED_BLOCKED)) {
    if (digits.startsWith(prefix)) {
      return { supported: false, blockedCountry: BUSINESS_INITIATED_BLOCKED[prefix] }
    }
  }
  return { supported: true, blockedCountry: null }
}

/** Does the number's messaging limit meet Meta's minimum for calling? */
export function meetsCallingTier(limit: MessagingLimit | null | undefined): boolean | null {
  if (!limit) return null
  if (limit.kind === 'unlimited') return true
  return limit.perDay >= CALLING_MIN_DAILY_LIMIT
}
