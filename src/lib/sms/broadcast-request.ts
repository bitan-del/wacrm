// ============================================================
// Shared request handling for the SMS broadcast preview + create
// routes: parse the wizard payload, load the config, resolve the
// audience under the caller's RLS, and build the plan. Keeping both
// routes on one path guarantees the preview shows exactly what the
// create will send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AudienceConfig } from '@/lib/broadcast-audience';
import { getT } from '@/lib/i18n/translate';
import type { Contact } from '@/types';
import { buildSmsBroadcastPreview, parseAudienceConfig, resolveSmsAudience } from './broadcast';
import { loadSmsConfigForAccount, type SmsConfigRow } from './config';
import { composeSmsBroadcastBody, unknownMergeTags } from './render';
import { SMS_MAX_BODY_CHARS } from './send';

const t = getT('Api');

export class SmsBroadcastRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SmsBroadcastRequestError';
    this.status = status;
  }
}

export interface PreparedSmsBroadcast {
  config: SmsConfigRow;
  audience: AudienceConfig;
  template: string;
  audienceSize: number;
  preview: ReturnType<typeof buildSmsBroadcastPreview>;
  eligible: Contact[];
}

export async function prepareSmsBroadcast(
  db: SupabaseClient,
  admin: SupabaseClient,
  accountId: string,
  body: unknown,
): Promise<PreparedSmsBroadcast> {
  const b = (body ?? {}) as Record<string, unknown>;

  const config = await loadSmsConfigForAccount(admin, accountId);
  if (!config || !config.is_active) throw new SmsBroadcastRequestError(t('sms.notConfigured'));

  const audience = parseAudienceConfig(b.audience);
  if (!audience) throw new SmsBroadcastRequestError(t('sms.audienceInvalid'));

  const raw = typeof b.body === 'string' ? b.body : '';
  if (!raw.trim()) throw new SmsBroadcastRequestError(t('sms.bodyRequired'));
  const unknown = unknownMergeTags(raw);
  if (unknown.length > 0) {
    throw new SmsBroadcastRequestError(t('sms.unknownTags', { tags: unknown.join(', ') }));
  }

  const template = composeSmsBroadcastBody(raw, {
    brandName: config.brand_name,
    prefixBrand: b.prefix_brand !== false,
    appendOptOut: b.append_opt_out !== false,
  });
  if (template.length > SMS_MAX_BODY_CHARS) {
    throw new SmsBroadcastRequestError(t('sms.textTooLong', { max: SMS_MAX_BODY_CHARS }));
  }

  const contacts = await resolveSmsAudience(db, audience);
  const preview = buildSmsBroadcastPreview(contacts, template, config);
  return {
    config,
    audience,
    template,
    audienceSize: contacts.length,
    preview,
    eligible: preview.breakdown.eligible,
  };
}

/** JSON summary shared by both routes. */
export function summarizePrepared(p: PreparedSmsBroadcast) {
  const { breakdown, plan } = p.preview;
  const sample = plan.recipients[0]?.body ?? p.template;
  return {
    audience_total: p.audienceSize,
    eligible: breakdown.eligible.length,
    excluded_no_consent: breakdown.noConsent,
    excluded_opted_out: breakdown.optedOut,
    excluded_invalid_phone: breakdown.invalidPhone,
    deferred_quiet_hours: plan.deferred,
    total_segments: plan.totalSegments,
    max_segments_per_message: plan.maxSegmentsPerMessage,
    encoding: plan.encoding,
    estimated_cost: plan.estimatedCost,
    cost_per_segment: Number(p.config.cost_per_segment) || 0,
    cost_currency: p.config.cost_currency,
    quiet_hours: {
      start: p.config.quiet_hours_start,
      end: p.config.quiet_hours_end,
      timezone: p.config.default_timezone,
    },
    composed_body: p.template,
    sample_body: sample,
  };
}
