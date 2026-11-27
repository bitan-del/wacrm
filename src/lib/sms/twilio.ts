// ============================================================
// Twilio Programmable Messaging — the first `SmsProvider`.
//
// REST: https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
// (form-encoded, HTTP Basic with AccountSid:AuthToken). A Messaging
// Service SID is preferred over a bare From number: on 10DLC the A2P
// campaign is attached to the service, and the service handles sender
// pools, sticky senders and Advanced Opt-Out.
//
// Webhook security: Twilio signs every webhook with the *account's*
// Auth Token — HMAC-SHA1 over the full URL followed by each POST
// parameter name+value, sorted by name, base64 — in X-Twilio-Signature.
// Multi-tenant consequence: we must find the right account's token
// before we can validate, which is why our webhook URLs carry the
// config id (see docs/sms.md).
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  SmsProviderError,
  type InboundSms,
  type SmsCredentials,
  type SmsDeliveryStatus,
  type SmsProvider,
  type SmsSendParams,
  type SmsSendResult,
  type SmsStatusEvent,
  type VerifiedSmsAccount,
  type WebhookSignatureInput,
} from './types';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const TWILIO_MESSAGING_API = 'https://messaging.twilio.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/** Twilio: "Attempt to send to unsubscribed recipient" (the handset sent STOP). */
export const TWILIO_ERROR_UNSUBSCRIBED = 21610;

export const TWILIO_ACCOUNT_SID_RE = /^AC[0-9a-fA-F]{32}$/;
export const TWILIO_MESSAGING_SERVICE_SID_RE = /^MG[0-9a-fA-F]{32}$/;

// ------------------------------------------------------------
// Signature validation
// ------------------------------------------------------------

/** Twilio's request signature for `url` + form `params`. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Twilio has historically signed some URLs with an explicit default
 * port and some without; accept either spelling of each candidate.
 */
function urlSpellings(url: string): string[] {
  try {
    const u = new URL(url);
    const out = new Set<string>([url]);
    const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
    if (u.port === '' && defaultPort) {
      out.add(`${u.protocol}//${u.hostname}:${defaultPort}${u.pathname}${u.search}`);
    } else if (u.port === defaultPort) {
      out.add(`${u.protocol}//${u.hostname}${u.pathname}${u.search}`);
    }
    return [...out];
  } catch {
    return [url];
  }
}

export function validateTwilioSignature(
  authToken: string,
  input: WebhookSignatureInput,
): boolean {
  const signature = (input.signature ?? '').trim();
  if (!authToken || !signature) return false;
  for (const candidate of input.urls) {
    for (const url of urlSpellings(candidate)) {
      if (safeEqual(computeTwilioSignature(authToken, url, input.params), signature)) {
        return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------------
// Webhook parsing
// ------------------------------------------------------------

function str(params: Readonly<Record<string, string>>, key: string): string | null {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function mapTwilioStatus(raw: string | null | undefined): SmsDeliveryStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'receiving':
    case 'received':
      return 'received';
    default:
      return 'unknown';
  }
}

/** Parse Twilio's inbound-message webhook form. Null when it isn't one. */
export function parseTwilioInbound(params: Readonly<Record<string, string>>): InboundSms | null {
  const sid = str(params, 'MessageSid') ?? str(params, 'SmsMessageSid') ?? str(params, 'SmsSid');
  const from = str(params, 'From');
  const to = str(params, 'To');
  if (!sid || !from || !to) return null;

  const numMedia = Math.min(Number.parseInt(params.NumMedia ?? '0', 10) || 0, 10);
  const mediaUrls: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = str(params, `MediaUrl${i}`);
    if (url) mediaUrls.push(url);
  }

  return {
    providerMessageId: sid,
    accountRef: str(params, 'AccountSid'),
    senderRef: str(params, 'MessagingServiceSid'),
    from,
    to,
    body: params.Body ?? '',
    keywordHint: str(params, 'OptOutType'),
    mediaUrls,
  };
}

/** Parse Twilio's status-callback form. Null when it isn't one. */
export function parseTwilioStatus(params: Readonly<Record<string, string>>): SmsStatusEvent | null {
  const sid = str(params, 'MessageSid') ?? str(params, 'SmsSid');
  const rawStatus = str(params, 'MessageStatus') ?? str(params, 'SmsStatus');
  if (!sid || !rawStatus) return null;
  const code = Number.parseInt(params.ErrorCode ?? '', 10);
  return {
    providerMessageId: sid,
    accountRef: str(params, 'AccountSid'),
    status: mapTwilioStatus(rawStatus),
    rawStatus,
    errorCode: Number.isFinite(code) && code > 0 ? code : null,
    errorMessage: str(params, 'ErrorMessage'),
    to: str(params, 'To'),
    from: str(params, 'From'),
  };
}

// ------------------------------------------------------------
// REST client
// ------------------------------------------------------------

type FetchLike = typeof fetch;

function basicAuth(creds: SmsCredentials): string {
  return 'Basic ' + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
}

async function twilioRequest(
  fetchImpl: FetchLike,
  creds: SmsCredentials,
  url: string,
  init: { method: 'GET' | 'POST'; form?: URLSearchParams },
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      headers: {
        Authorization: basicAuth(creds),
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.form?.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SmsProviderError(`Twilio request failed: ${reason}`, null, 502);
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.code === 'number' ? data.code : null;
    const message =
      typeof data.message === 'string' && data.message
        ? data.message
        : `Twilio returned HTTP ${res.status}`;
    throw new SmsProviderError(message, code, res.status);
  }
  return data;
}

export class TwilioSmsProvider implements SmsProvider {
  readonly id = 'twilio' as const;
  /**
   * Twilio answers STOP / START itself on long codes, toll-free and
   * Messaging Services, and rejects any later send to an opted-out
   * handset with 21610.
   */
  readonly managesOptOutConfirmations = true;

  constructor(
    private readonly creds: SmsCredentials,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(params: SmsSendParams): Promise<SmsSendResult> {
    const form = new URLSearchParams();
    form.set('To', params.to);
    form.set('Body', params.body);
    if (this.creds.messagingServiceSid) {
      form.set('MessagingServiceSid', this.creds.messagingServiceSid);
    } else if (this.creds.fromNumber) {
      form.set('From', this.creds.fromNumber);
    } else {
      throw new SmsProviderError('No SMS sender configured', null, 400);
    }
    if (params.statusCallbackUrl) form.set('StatusCallback', params.statusCallbackUrl);

    const data = await twilioRequest(
      this.fetchImpl,
      this.creds,
      `${TWILIO_API}/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`,
      { method: 'POST', form },
    );

    const sid = typeof data.sid === 'string' ? data.sid : '';
    if (!sid) throw new SmsProviderError('Twilio response had no message sid', null, 502);
    const segments = Number.parseInt(String(data.num_segments ?? ''), 10);
    return {
      providerMessageId: sid,
      status: mapTwilioStatus(typeof data.status === 'string' ? data.status : null),
      segments: Number.isFinite(segments) && segments > 0 ? segments : null,
    };
  }

  async verifyCredentials(): Promise<VerifiedSmsAccount> {
    const sid = encodeURIComponent(this.creds.accountSid);
    const account = await twilioRequest(this.fetchImpl, this.creds, `${TWILIO_API}/Accounts/${sid}.json`, {
      method: 'GET',
    });
    const status = typeof account.status === 'string' ? account.status : 'active';
    if (status !== 'active') {
      throw new SmsProviderError(`Twilio account is ${status}`, null, 400);
    }

    // The sender must belong to THIS account — otherwise sends fail at
    // runtime and inbound routing would point at the wrong tenant.
    if (this.creds.messagingServiceSid) {
      await twilioRequest(
        this.fetchImpl,
        this.creds,
        `${TWILIO_MESSAGING_API}/Services/${encodeURIComponent(this.creds.messagingServiceSid)}`,
        { method: 'GET' },
      );
    }
    if (this.creds.fromNumber) {
      const owned = await twilioRequest(
        this.fetchImpl,
        this.creds,
        `${TWILIO_API}/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(this.creds.fromNumber)}`,
        { method: 'GET' },
      );
      const numbers = Array.isArray(owned.incoming_phone_numbers) ? owned.incoming_phone_numbers : [];
      if (numbers.length === 0) {
        throw new SmsProviderError(
          `${this.creds.fromNumber} is not a phone number on this Twilio account`,
          null,
          400,
        );
      }
    }

    return {
      accountName: typeof account.friendly_name === 'string' ? account.friendly_name : null,
    };
  }

  verifyWebhookSignature(input: WebhookSignatureInput): boolean {
    return validateTwilioSignature(this.creds.authToken, input);
  }
}
