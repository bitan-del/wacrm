// ============================================================
// Shared front half of the provider webhooks: read the form body,
// resolve WHICH account's config it belongs to, and verify the
// provider signature with that account's secret.
//
// Order matters for multi-tenancy: the signature can only be checked
// once we know whose auth token to check it with. The `cfg` query
// parameter (our own config id, embedded in the URLs the settings page
// hands out) names it; without one we fall back to the provider account
// + receiving number. Either way nothing is trusted until the HMAC
// matches that config's token AND the payload's AccountSid matches the
// config — a valid signature from tenant A can't be replayed at B.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCappedBody } from '@/lib/whatsapp/webhook-body';
import {
  createSmsProvider,
  loadSmsConfigById,
  signatureCandidateUrls,
  type SmsConfigRow,
} from './config';
import { smsPhoneFor } from './consent';
import type { SmsProvider } from './types';

export type VerifiedWebhook =
  | {
      ok: true;
      config: SmsConfigRow;
      provider: SmsProvider;
      params: Record<string, string>;
    }
  | { ok: false; status: number; reason: string };

export function parseFormBody(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  return params;
}

async function findConfigByAccountAndSender(
  db: SupabaseClient,
  accountSid: string | undefined,
  to: string | undefined,
  messagingServiceSid: string | undefined,
): Promise<SmsConfigRow | null> {
  if (!accountSid) return null;
  const toE164 = smsPhoneFor(to ?? null);
  const filters: string[] = [];
  if (messagingServiceSid) filters.push(`messaging_service_sid.eq.${messagingServiceSid}`);
  if (toE164) filters.push(`from_number.eq.${toE164}`);
  if (filters.length === 0) return null;

  const { data, error } = await db
    .from('sms_config')
    .select('*')
    .eq('account_sid', accountSid)
    .or(filters.join(','))
    .limit(2);
  if (error || !data || data.length !== 1) return null;
  return data[0] as SmsConfigRow;
}

export async function verifySmsWebhook(
  db: SupabaseClient,
  request: Request,
  signatureHeader: string,
): Promise<VerifiedWebhook> {
  const raw = await readCappedBody(request);
  if (raw === null) return { ok: false, status: 413, reason: 'payload too large' };
  const params = parseFormBody(raw);

  const cfg = new URL(request.url).searchParams.get('cfg');
  const config = cfg
    ? await loadSmsConfigById(db, cfg)
    : await findConfigByAccountAndSender(db, params.AccountSid, params.To, params.MessagingServiceSid);
  if (!config) return { ok: false, status: 404, reason: 'no matching sms config' };

  let provider: SmsProvider;
  try {
    provider = createSmsProvider(config);
  } catch {
    return { ok: false, status: 500, reason: 'sms config unreadable' };
  }

  const valid = provider.verifyWebhookSignature({
    urls: signatureCandidateUrls(request),
    params,
    signature: request.headers.get(signatureHeader),
  });
  if (!valid) return { ok: false, status: 403, reason: 'invalid signature' };

  if (params.AccountSid && params.AccountSid !== config.account_sid) {
    return { ok: false, status: 403, reason: 'account mismatch' };
  }

  return { ok: true, config, provider, params };
}
