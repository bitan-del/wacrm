// ============================================================
// SMS consent rules (pure — no I/O).
//
//   Broadcast (marketing)  → requires an opt-in AND no opt-out.
//   Inbox reply            → allowed unless the contact opted out.
//                            Answering a customer who texted us is
//                            conversational, not marketing; it is
//                            still never allowed after STOP.
//
// The DB side of this lives in migration 063: `apply_sms_consent`
// writes, the `contacts_log_sms_consent` trigger audits.
// ============================================================

import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { Contact, SmsOptInSource, SmsOptOutSource } from '@/types';

export type SmsConsentFields = Pick<
  Contact,
  'phone' | 'sms_opted_in_at' | 'sms_opted_out_at'
>;

export const SMS_OPT_IN_SOURCES: readonly SmsOptInSource[] = [
  'keyword',
  'web_form',
  'paper_form',
  'verbal',
  'import',
  'api',
  'manual',
  'other',
];

export const SMS_OPT_OUT_SOURCES: readonly SmsOptOutSource[] = [
  'keyword',
  'provider',
  'manual',
  'api',
  'other',
];

/**
 * Opt-in sources a staff member may record from the dashboard / API.
 * 'keyword' is reserved for the recipient's own START text, and is the
 * only source that can override a recipient-initiated opt-out (enforced
 * in `apply_sms_consent`).
 */
export const STAFF_OPT_IN_SOURCES: readonly SmsOptInSource[] = SMS_OPT_IN_SOURCES.filter(
  (s) => s !== 'keyword',
);

export function isSmsOptInSource(value: unknown): value is SmsOptInSource {
  return typeof value === 'string' && (SMS_OPT_IN_SOURCES as readonly string[]).includes(value);
}

export function isStaffOptInSource(value: unknown): value is SmsOptInSource {
  return typeof value === 'string' && (STAFF_OPT_IN_SOURCES as readonly string[]).includes(value);
}

/** E.164 with a leading `+` for an SMS send, or null when not dialable. */
export function smsPhoneFor(phone: string | null | undefined): string | null {
  const digits = normalizePhone(phone ?? '');
  if (!digits || !isValidE164(digits)) return null;
  return `+${digits}`;
}

export function isSmsOptedOut(contact: Pick<Contact, 'sms_opted_out_at'>): boolean {
  return Boolean(contact.sms_opted_out_at);
}

export function hasSmsOptIn(contact: Pick<Contact, 'sms_opted_in_at' | 'sms_opted_out_at'>): boolean {
  return Boolean(contact.sms_opted_in_at) && !isSmsOptedOut(contact);
}

export type SmsAudienceVerdict = 'eligible' | 'no_consent' | 'opted_out' | 'invalid_phone';

/** Why a contact would or would not receive an SMS broadcast. */
export function classifySmsAudienceContact(contact: SmsConsentFields): SmsAudienceVerdict {
  if (isSmsOptedOut(contact)) return 'opted_out';
  if (!contact.sms_opted_in_at) return 'no_consent';
  if (!smsPhoneFor(contact.phone)) return 'invalid_phone';
  return 'eligible';
}

export type SmsReplyVerdict = 'allowed' | 'opted_out' | 'invalid_phone';

/** Whether an agent may answer this contact by SMS from the inbox. */
export function classifySmsReply(contact: SmsConsentFields): SmsReplyVerdict {
  if (isSmsOptedOut(contact)) return 'opted_out';
  if (!smsPhoneFor(contact.phone)) return 'invalid_phone';
  return 'allowed';
}

export interface SmsAudienceBreakdown<T> {
  eligible: T[];
  noConsent: number;
  optedOut: number;
  invalidPhone: number;
}

/** Split an audience into sendable contacts and counted exclusions. */
export function partitionSmsAudience<T extends SmsConsentFields>(
  contacts: readonly T[],
): SmsAudienceBreakdown<T> {
  const out: SmsAudienceBreakdown<T> = {
    eligible: [],
    noConsent: 0,
    optedOut: 0,
    invalidPhone: 0,
  };
  for (const c of contacts) {
    switch (classifySmsAudienceContact(c)) {
      case 'eligible':
        out.eligible.push(c);
        break;
      case 'no_consent':
        out.noConsent++;
        break;
      case 'opted_out':
        out.optedOut++;
        break;
      case 'invalid_phone':
        out.invalidPhone++;
        break;
    }
  }
  return out;
}
