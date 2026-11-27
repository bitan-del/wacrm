// ============================================================
// `sms_config` access + provider construction.
//
// The row holds an encrypted auth token, so it is read with the
// service-role client by server code only (RLS restricts direct reads
// to admins). `toPublicSmsConfig` is the only shape that leaves the
// server, and it never carries the token.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { TwilioSmsProvider } from './twilio';
import type { SmsProvider, SmsProviderId } from './types';
import {
  DEFAULT_QUIET_HOURS_END,
  DEFAULT_QUIET_HOURS_START,
  DEFAULT_SMS_TIMEZONE,
  type QuietHoursWindow,
} from './quiet-hours';

export type SmsRegistrationType = '10dlc' | 'toll_free' | 'short_code' | 'other';

export interface SmsConfigRow {
  id: string;
  account_id: string;
  created_by: string | null;
  provider: SmsProviderId;
  account_sid: string;
  auth_token: string;
  messaging_service_sid: string | null;
  from_number: string | null;
  brand_name: string | null;
  help_reply_text: string | null;
  opt_out_reply_text: string | null;
  opt_in_reply_text: string | null;
  default_timezone: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  cost_per_segment: number | string;
  cost_currency: string;
  registration_type: SmsRegistrationType | null;
  registration_reference: string | null;
  is_active: boolean;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the dashboard sees. Never includes the auth token. */
export interface PublicSmsConfig {
  configured: true;
  id: string;
  provider: SmsProviderId;
  account_sid: string;
  has_auth_token: boolean;
  messaging_service_sid: string | null;
  from_number: string | null;
  brand_name: string | null;
  help_reply_text: string | null;
  opt_out_reply_text: string | null;
  opt_in_reply_text: string | null;
  default_timezone: string;
  quiet_hours_start: number;
  quiet_hours_end: number;
  cost_per_segment: number;
  cost_currency: string;
  registration_type: SmsRegistrationType | null;
  registration_reference: string | null;
  is_active: boolean;
  last_verified_at: string | null;
}

export const SMS_REGISTRATION_TYPES: readonly SmsRegistrationType[] = [
  '10dlc',
  'toll_free',
  'short_code',
  'other',
];

export function toPublicSmsConfig(row: SmsConfigRow): PublicSmsConfig {
  return {
    configured: true,
    id: row.id,
    provider: row.provider,
    account_sid: row.account_sid,
    has_auth_token: Boolean(row.auth_token),
    messaging_service_sid: row.messaging_service_sid,
    from_number: row.from_number,
    brand_name: row.brand_name,
    help_reply_text: row.help_reply_text,
    opt_out_reply_text: row.opt_out_reply_text,
    opt_in_reply_text: row.opt_in_reply_text,
    default_timezone: row.default_timezone,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    cost_per_segment: Number(row.cost_per_segment) || 0,
    cost_currency: row.cost_currency,
    registration_type: row.registration_type,
    registration_reference: row.registration_reference,
    is_active: row.is_active,
    last_verified_at: row.last_verified_at,
  };
}

export function quietHoursOf(row: Pick<SmsConfigRow, 'quiet_hours_start' | 'quiet_hours_end'>): QuietHoursWindow {
  return {
    start: row.quiet_hours_start ?? DEFAULT_QUIET_HOURS_START,
    end: row.quiet_hours_end ?? DEFAULT_QUIET_HOURS_END,
  };
}

export function accountTimezoneOf(row: Pick<SmsConfigRow, 'default_timezone'>): string {
  return row.default_timezone || DEFAULT_SMS_TIMEZONE;
}

export async function loadSmsConfigForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<SmsConfigRow | null> {
  const { data, error } = await db
    .from('sms_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[sms/config] load failed:', error.message);
    return null;
  }
  return (data as SmsConfigRow | null) ?? null;
}

export async function loadSmsConfigById(
  db: SupabaseClient,
  id: string,
): Promise<SmsConfigRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await db.from('sms_config').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error('[sms/config] load by id failed:', error.message);
    return null;
  }
  return (data as SmsConfigRow | null) ?? null;
}

/** Thrown when the stored token can't be decrypted (rotated ENCRYPTION_KEY). */
export class SmsConfigUnreadableError extends Error {
  constructor() {
    super('Stored SMS credentials could not be decrypted — re-save them in Settings → SMS');
    this.name = 'SmsConfigUnreadableError';
  }
}

export function createSmsProvider(
  row: Pick<SmsConfigRow, 'provider' | 'account_sid' | 'auth_token' | 'messaging_service_sid' | 'from_number'>,
  plaintextAuthToken?: string,
): SmsProvider {
  let authToken = plaintextAuthToken;
  if (authToken === undefined) {
    try {
      authToken = decrypt(row.auth_token);
    } catch {
      throw new SmsConfigUnreadableError();
    }
  }
  switch (row.provider) {
    case 'twilio':
      return new TwilioSmsProvider({
        accountSid: row.account_sid,
        authToken,
        messagingServiceSid: row.messaging_service_sid,
        fromNumber: row.from_number,
      });
  }
}

// ------------------------------------------------------------
// Public URLs
// ------------------------------------------------------------

/**
 * Public origin of this deployment: NEXT_PUBLIC_SITE_URL when set
 * (the only reliable answer for a cron or a proxied deploy), else the
 * forwarded host of the current request, else the request URL's own.
 */
export function resolvePublicOrigin(request?: Request | null): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (!request) return null;
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${host}`;
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function smsWebhookUrls(
  origin: string,
  config: Pick<SmsConfigRow, 'id' | 'provider'>,
): { inbound: string; status: string } {
  const base = `${origin.replace(/\/+$/, '')}/api/sms/${config.provider}`;
  const q = `?cfg=${encodeURIComponent(config.id)}`;
  return { inbound: `${base}/inbound${q}`, status: `${base}/status${q}` };
}

/**
 * Every URL the provider might have signed for this request. The raw
 * `request.url` is what the platform saw; behind a proxy that can differ
 * from the public URL the provider called, so the public spelling is
 * offered too. Each candidate still has to match the HMAC.
 */
export function signatureCandidateUrls(request: Request): string[] {
  const out = new Set<string>();
  try {
    const raw = new URL(request.url);
    out.add(raw.toString());
    const origin = resolvePublicOrigin(request);
    if (origin) out.add(`${origin}${raw.pathname}${raw.search}`);
  } catch {
    // unparseable URL — nothing to offer
  }
  return [...out];
}

/** Default HELP reply when the admin hasn't written one. */
export function defaultHelpReply(brandName: string | null | undefined): string {
  const brand = (brandName ?? '').trim();
  return `${brand ? `${brand}: ` : ''}Reply STOP to unsubscribe. Msg & data rates may apply.`;
}
