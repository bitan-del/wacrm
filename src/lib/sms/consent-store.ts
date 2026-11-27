// ============================================================
// Consent writes. Every change goes through migration 063's
// `apply_sms_consent` RPC so the re-opt-in guard and the audit trigger
// apply no matter who calls (webhook, inbox, API).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import type { SmsOptInSource, SmsOptOutSource } from '@/types';

export interface ConsentChange {
  action: 'opt_in' | 'opt_out';
  source: SmsOptInSource | SmsOptOutSource;
  keyword?: string | null;
  providerMessageId?: string | null;
}

/** Apply a consent change; returns the ids of contacts that changed. */
export async function applySmsConsent(
  db: SupabaseClient,
  accountId: string,
  contactIds: readonly string[],
  change: ConsentChange,
): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const { data, error } = await db.rpc('apply_sms_consent', {
    p_account_id: accountId,
    p_contact_ids: contactIds,
    p_action: change.action,
    p_source: change.source,
    p_keyword: change.keyword ?? null,
    p_message_id: change.providerMessageId ?? null,
  });
  if (error) {
    throw new Error(`apply_sms_consent failed: ${error.message}`);
  }
  // SETOF uuid comes back as an array of bare ids.
  return ((data ?? []) as unknown[]).map((row) =>
    typeof row === 'string' ? row : String((row as Record<string, unknown>).apply_sms_consent ?? ''),
  ).filter(Boolean);
}

/** Record a HELP request (no consent change, audit only). */
export async function recordSmsHelpEvent(
  db: SupabaseClient,
  params: {
    accountId: string;
    contactId: string | null;
    phone: string;
    keyword: string | null;
    providerMessageId: string | null;
  },
): Promise<void> {
  const { error } = await db.from('sms_consent_events').insert({
    account_id: params.accountId,
    contact_id: params.contactId,
    phone: params.phone,
    event: 'help',
    source: 'keyword',
    keyword: params.keyword,
    provider_message_id: params.providerMessageId,
  });
  if (error) console.error('[sms/consent] help event insert failed:', error.message);
}

/**
 * Opt out every contact in the account whose number matches `phone`.
 * Used when the provider reports the handset as unsubscribed (Twilio
 * 21610) — the handset said STOP at some point we may not have seen.
 */
export async function optOutByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  source: SmsOptOutSource,
): Promise<void> {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('phone_normalized', phoneVariants(normalized));
  if (error) {
    console.error('[sms/consent] opt-out lookup failed:', error.message);
    return;
  }
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  try {
    await applySmsConsent(db, accountId, ids, { action: 'opt_out', source });
  } catch (err) {
    console.error('[sms/consent] provider opt-out failed:', err instanceof Error ? err.message : err);
  }
}
