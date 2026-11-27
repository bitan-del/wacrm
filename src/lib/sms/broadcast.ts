// ============================================================
// SMS broadcasts: audience, planning, delivery.
//
// Unlike WhatsApp broadcasts (driven from the browser tab), SMS
// broadcasts run entirely server-side, because quiet hours mean a
// campaign can legitimately span a night: recipients whose local time
// is 21:00–08:00 are planned with `scheduled_for` = their next 08:00,
// and the cron (`GET /api/sms/cron`) picks them up when due.
//
// Consent and quiet hours are re-checked at the moment of sending, not
// just at planning time: a contact who texts STOP after the campaign
// was created is skipped, and a cron that runs late at night re-defers
// instead of sending.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolveAudienceContacts,
  type AudienceConfig,
  type CsvAudienceRow,
} from '@/lib/broadcast-audience';
import { fetchAllInChunks } from '@/lib/supabase/paged-query';
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core';
import { normalizePhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import type { Contact } from '@/types';
import { classifySmsAudienceContact, partitionSmsAudience, smsPhoneFor } from './consent';
import { optOutByPhone } from './consent-store';
import {
  accountTimezoneOf,
  createSmsProvider,
  loadSmsConfigForAccount,
  quietHoursOf,
  smsWebhookUrls,
  type SmsConfigRow,
} from './config';
import { isQuietHours, nextAllowedSendTime, resolveTimeZone } from './quiet-hours';
import { renderSmsBody } from './render';
import { countSmsSegments, estimateSmsCost, type SmsEncoding } from './segments';
import { TWILIO_ERROR_UNSUBSCRIBED } from './twilio';
import { SmsProviderError, type SmsProvider } from './types';

/** Per-broadcast recipient cap (one RPC payload). */
export const SMS_BROADCAST_MAX_RECIPIENTS = 25_000;

// ------------------------------------------------------------
// Audience
// ------------------------------------------------------------

/**
 * CSV rows → EXISTING contacts only. A CSV cannot carry SMS consent, so
 * unlike the WhatsApp wizard the SMS path never creates contacts from
 * one; a number with no consented contact is simply not in the audience.
 */
async function matchCsvToExistingContacts(
  db: SupabaseClient,
  rows: readonly CsvAudienceRow[],
): Promise<Contact[]> {
  const keys = new Set<string>();
  for (const row of rows) {
    const n = normalizePhone(row.phone ?? '');
    if (!n) continue;
    for (const v of phoneVariants(n)) keys.add(v);
  }
  if (keys.size === 0) return [];
  const found = await fetchAllInChunks<Contact, string>([...keys], (slice, from, to) =>
    db.from('contacts').select('*').in('phone_normalized', slice).order('id').range(from, to),
  );
  const byId = new Map(found.map((c) => [c.id, c]));
  return [...byId.values()];
}

/** Resolve a wizard audience to contacts, under the caller's RLS. */
export function resolveSmsAudience(db: SupabaseClient, audience: AudienceConfig): Promise<Contact[]> {
  return resolveAudienceContacts(db, audience, (rows) => matchCsvToExistingContacts(db, rows));
}

/** Loose runtime check of the wizard's audience payload. */
export function parseAudienceConfig(raw: unknown): AudienceConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== 'all' && a.type !== 'tags' && a.type !== 'custom_field' && a.type !== 'csv') {
    return null;
  }
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const cf = a.customField as Record<string, unknown> | undefined;
  return {
    type: a.type,
    tagIds: ids(a.tagIds),
    excludeTagIds: ids(a.excludeTagIds),
    customField:
      cf && typeof cf.fieldId === 'string'
        ? {
            fieldId: cf.fieldId,
            operator: cf.operator === 'is_not' || cf.operator === 'contains' ? cf.operator : 'is',
            value: typeof cf.value === 'string' ? cf.value : '',
          }
        : undefined,
    csvContacts: Array.isArray(a.csvContacts)
      ? (a.csvContacts as unknown[])
          .filter((r): r is CsvAudienceRow =>
            Boolean(r) && typeof (r as CsvAudienceRow).phone === 'string',
          )
          .slice(0, SMS_BROADCAST_MAX_RECIPIENTS)
      : undefined,
  };
}

// ------------------------------------------------------------
// Planning (pure)
// ------------------------------------------------------------

export interface PlannedSmsRecipient {
  contactId: string;
  body: string;
  segments: number;
  /** ISO time; equals `now` when the recipient is outside quiet hours. */
  scheduledFor: string;
  deferred: boolean;
}

export interface SmsBroadcastPlan {
  recipients: PlannedSmsRecipient[];
  totalSegments: number;
  estimatedCost: number;
  deferred: number;
  /** Worst encoding across recipients (UCS-2 if any recipient needs it). */
  encoding: SmsEncoding;
  maxSegmentsPerMessage: number;
}

export type PlannableContact = Pick<Contact, 'id' | 'name' | 'company' | 'timezone'>;

export function planSmsBroadcast(
  contacts: readonly PlannableContact[],
  template: string,
  config: Pick<SmsConfigRow, 'default_timezone' | 'quiet_hours_start' | 'quiet_hours_end' | 'cost_per_segment'>,
  now: Date = new Date(),
): SmsBroadcastPlan {
  const window = quietHoursOf(config);
  const accountTz = accountTimezoneOf(config);
  let totalSegments = 0;
  let deferred = 0;
  let encoding: SmsEncoding = 'GSM-7';
  let maxSegments = 0;

  const recipients = contacts.map((c) => {
    const body = renderSmsBody(template, c);
    const info = countSmsSegments(body);
    totalSegments += info.segments;
    maxSegments = Math.max(maxSegments, info.segments);
    if (info.encoding === 'UCS-2') encoding = 'UCS-2';
    const tz = resolveTimeZone(c.timezone, accountTz);
    const at = nextAllowedSendTime(now, tz, window);
    const isDeferred = at.getTime() !== now.getTime();
    if (isDeferred) deferred++;
    return {
      contactId: c.id,
      body,
      segments: info.segments,
      scheduledFor: at.toISOString(),
      deferred: isDeferred,
    };
  });

  return {
    recipients,
    totalSegments,
    estimatedCost: estimateSmsCost(totalSegments, Number(config.cost_per_segment) || 0),
    deferred,
    encoding,
    maxSegmentsPerMessage: maxSegments,
  };
}

/** Eligible contacts + exclusion counts + the plan, for preview and create. */
export function buildSmsBroadcastPreview(
  audience: readonly Contact[],
  template: string,
  config: SmsConfigRow,
  now: Date = new Date(),
) {
  const breakdown = partitionSmsAudience(audience);
  const plan = planSmsBroadcast(breakdown.eligible, template, config, now);
  return { breakdown, plan };
}

// ------------------------------------------------------------
// Create
// ------------------------------------------------------------

export async function createSmsBroadcast(
  admin: SupabaseClient,
  params: {
    accountId: string;
    userId: string;
    name: string;
    template: string;
    audience: AudienceConfig;
    plan: SmsBroadcastPlan;
  },
): Promise<string> {
  const { data, error } = await admin.rpc('create_sms_broadcast_with_recipients', {
    p_account_id: params.accountId,
    p_user_id: params.userId,
    p_name: params.name,
    p_sms_body: params.template,
    p_audience: {
      type: params.audience.type,
      tagIds: params.audience.tagIds,
      customField: params.audience.customField,
      excludeTagIds: params.audience.excludeTagIds,
    },
    p_contact_ids: params.plan.recipients.map((r) => r.contactId),
    p_bodies: params.plan.recipients.map((r) => r.body),
    p_segments: params.plan.recipients.map((r) => r.segments),
    p_scheduled_for: params.plan.recipients.map((r) => r.scheduledFor),
  });
  if (error || !data) {
    throw new Error(`create_sms_broadcast_with_recipients failed: ${error?.message ?? 'no id'}`);
  }
  return data as string;
}

// ------------------------------------------------------------
// Delivery
// ------------------------------------------------------------

interface ClaimedRecipient {
  recipient_id: string;
  broadcast_id: string;
  account_id: string;
  contact_id: string | null;
  sms_body: string;
}

type DeliveryContact = Pick<
  Contact,
  'id' | 'phone' | 'sms_opted_in_at' | 'sms_opted_out_at' | 'timezone'
>;

export interface DeliveryReport {
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
}

export interface DeliverOptions {
  /** Public origin for status callbacks; null skips them. */
  origin: string | null;
  /** Restrict to one broadcast (the after() pass of a fresh campaign). */
  broadcastId?: string | null;
  /** Stop claiming new work after this long. */
  timeBudgetMs?: number;
  claimBatch?: number;
  concurrency?: number;
  now?: () => Date;
}

/** HTTP 429 or Twilio 20429 — back off and retry, don't fail. */
function isRateLimited(err: SmsProviderError): boolean {
  return err.httpStatus === 429 || err.code === 20429;
}

const OPTED_OUT_REASON = 'Contact opted out of SMS';

function exclusionReason(verdict: ReturnType<typeof classifySmsAudienceContact>): string {
  switch (verdict) {
    case 'opted_out':
      return OPTED_OUT_REASON;
    case 'no_consent':
      return 'Contact has no SMS consent';
    case 'invalid_phone':
      return 'Contact has no valid phone number';
    default:
      return 'Not sendable';
  }
}

async function mapPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function deliverDueSmsRecipients(
  admin: SupabaseClient,
  opts: DeliverOptions,
): Promise<DeliveryReport> {
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 240_000;
  const batch = opts.claimBatch ?? 25;
  const concurrency = opts.concurrency ?? 4;
  const clock = opts.now ?? (() => new Date());
  const report: DeliveryReport = { claimed: 0, sent: 0, failed: 0, deferred: 0 };

  const configs = new Map<string, { config: SmsConfigRow | null; provider: SmsProvider | null; error?: string }>();
  const touched = new Set<string>();

  const configFor = async (accountId: string) => {
    let entry = configs.get(accountId);
    if (!entry) {
      const config = await loadSmsConfigForAccount(admin, accountId);
      if (!config || !config.is_active) {
        entry = { config, provider: null, error: 'SMS is not set up or is turned off for this workspace' };
      } else {
        try {
          entry = { config, provider: createSmsProvider(config) };
        } catch (err) {
          entry = { config, provider: null, error: err instanceof Error ? err.message : String(err) };
        }
      }
      configs.set(accountId, entry);
    }
    return entry;
  };

  const markFailed = async (recipientId: string, reason: string) => {
    report.failed++;
    await admin
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: reason, claimed_at: null })
      .eq('id', recipientId)
      .eq('status', 'pending');
  };

  const reschedule = async (recipientId: string, at: Date) => {
    report.deferred++;
    await admin
      .from('broadcast_recipients')
      .update({ scheduled_for: at.toISOString(), claimed_at: null })
      .eq('id', recipientId)
      .eq('status', 'pending');
  };

  while (Date.now() - started < budget) {
    const { data, error } = await admin.rpc('claim_sms_broadcast_recipients', {
      p_limit: batch,
      p_stale_seconds: 900,
      p_broadcast_id: opts.broadcastId ?? null,
    });
    if (error) {
      console.error('[sms/broadcast] claim failed:', error.message);
      break;
    }
    const claimed = (data ?? []) as ClaimedRecipient[];
    if (claimed.length === 0) break;
    report.claimed += claimed.length;

    // Fresh consent / phone / timezone for this batch — read at send time.
    const contactIds = [...new Set(claimed.map((c) => c.contact_id).filter((id): id is string => !!id))];
    const contacts = await fetchAllInChunks<DeliveryContact, string>(contactIds, (slice, from, to) =>
      admin
        .from('contacts')
        .select('id, phone, sms_opted_in_at, sms_opted_out_at, timezone')
        .in('id', slice)
        .order('id')
        .range(from, to),
    ).catch((err) => {
      console.error('[sms/broadcast] contact fetch failed:', err instanceof Error ? err.message : err);
      return null;
    });
    if (!contacts) {
      // Leave the claims to go stale and be retried by a later pass.
      break;
    }
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    await mapPool(claimed, concurrency, async (row) => {
      touched.add(row.broadcast_id);
      const contact = row.contact_id ? contactById.get(row.contact_id) : undefined;
      if (!contact) return markFailed(row.recipient_id, 'Contact was deleted');

      const verdict = classifySmsAudienceContact(contact);
      if (verdict !== 'eligible') return markFailed(row.recipient_id, exclusionReason(verdict));

      const { config, provider, error: configError } = await configFor(row.account_id);
      if (!config || !provider) return markFailed(row.recipient_id, configError ?? 'SMS unavailable');

      const now = clock();
      const tz = resolveTimeZone(contact.timezone, accountTimezoneOf(config));
      const window = quietHoursOf(config);
      if (isQuietHours(now, tz, window)) {
        return reschedule(row.recipient_id, nextAllowedSendTime(now, tz, window));
      }

      const to = smsPhoneFor(contact.phone)!;
      try {
        const result = await provider.send({
          to,
          body: row.sms_body,
          statusCallbackUrl: opts.origin ? smsWebhookUrls(opts.origin, config).status : null,
        });
        report.sent++;
        const patch: Record<string, unknown> = {
          status: 'sent',
          sent_at: new Date().toISOString(),
          sms_message_id: result.providerMessageId,
          error_message: null,
          claimed_at: null,
        };
        if (result.segments !== null) patch.sms_segments = result.segments;
        const { error: stampError } = await admin
          .from('broadcast_recipients')
          .update(patch)
          .eq('id', row.recipient_id);
        if (stampError) {
          console.error('[sms/broadcast] recipient stamp failed after send:', stampError.message);
        }
      } catch (err) {
        if (err instanceof SmsProviderError) {
          if (err.code === TWILIO_ERROR_UNSUBSCRIBED) {
            await optOutByPhone(admin, row.account_id, to, 'provider');
            return markFailed(row.recipient_id, `[${err.code}] ${OPTED_OUT_REASON}`);
          }
          if (isRateLimited(err)) {
            return reschedule(row.recipient_id, new Date(Date.now() + 60_000));
          }
          const code = err.code !== null ? `[${err.code}] ` : '';
          return markFailed(row.recipient_id, `${code}${err.message}`);
        }
        return markFailed(row.recipient_id, err instanceof Error ? err.message : String(err));
      }
    });
  }

  for (const broadcastId of touched) {
    await finalizeBroadcastStatus(admin, broadcastId).catch((err) =>
      console.error('[sms/broadcast] finalize failed:', err instanceof Error ? err.message : err),
    );
  }
  return report;
}

/**
 * Pending recipients of an SMS broadcast waiting on quiet hours — what
 * the detail page shows as "queued until morning".
 */
export async function countScheduledSmsRecipients(db: SupabaseClient, broadcastId: string): Promise<number> {
  const { count } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
    .gt('scheduled_for', new Date().toISOString());
  return count ?? 0;
}
