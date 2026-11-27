// ============================================================
// SMS provider abstraction.
//
// Everything above this interface (inbox send, broadcasts, webhooks,
// consent) is provider-agnostic. Adding a provider = one module that
// implements `SmsProvider`, a case in `createSmsProvider`, and widening
// the `sms_config.provider` CHECK in a migration.
// ============================================================

export type SmsProviderId = 'twilio';

export const SMS_PROVIDERS: readonly SmsProviderId[] = ['twilio'];

/**
 * Provider-agnostic delivery state. Maps onto `messages.status` /
 * `broadcast_recipients.status` via `toMessageStatus`.
 */
export type SmsDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'received'
  | 'unknown';

export interface SmsCredentials {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string | null;
  fromNumber?: string | null;
}

export interface SmsSendParams {
  /** E.164 with leading `+`. */
  to: string;
  body: string;
  /** Where the provider should POST delivery-status updates. */
  statusCallbackUrl?: string | null;
  /** Public https URLs to attach (MMS). The provider fetches them. */
  mediaUrls?: readonly string[];
}

export interface SmsSendResult {
  providerMessageId: string;
  status: SmsDeliveryStatus;
  /** Billable segments as the provider counted them, when reported. */
  segments: number | null;
}

export interface InboundSms {
  providerMessageId: string;
  /** Provider account the message arrived on (Twilio AccountSid). */
  accountRef: string | null;
  /** Messaging service / sender pool, when the provider uses one. */
  senderRef: string | null;
  from: string;
  to: string;
  body: string;
  /** Provider's own keyword classification (Twilio `OptOutType`). */
  keywordHint: string | null;
  /** MMS attachments, in order. */
  media: InboundSmsMedia[];
}

export interface InboundSmsMedia {
  url: string;
  contentType: string | null;
}

export interface SmsStatusEvent {
  providerMessageId: string;
  accountRef: string | null;
  status: SmsDeliveryStatus;
  rawStatus: string;
  errorCode: number | null;
  errorMessage: string | null;
  to: string | null;
  from: string | null;
}

export interface WebhookSignatureInput {
  /** Candidate public URLs the provider may have signed. */
  urls: readonly string[];
  params: Readonly<Record<string, string>>;
  signature: string | null;
}

export interface VerifiedSmsAccount {
  accountName: string | null;
}

export interface SmsProvider {
  readonly id: SmsProviderId;
  /**
   * True when the provider itself confirms STOP / START to the handset
   * (and blocks sends to opted-out numbers). We then skip our own
   * confirmation texts — they would duplicate, or be rejected.
   */
  readonly managesOptOutConfirmations: boolean;
  send(params: SmsSendParams): Promise<SmsSendResult>;
  /** Throws `SmsProviderError` when credentials or sender are unusable. */
  verifyCredentials(): Promise<VerifiedSmsAccount>;
  verifyWebhookSignature(input: WebhookSignatureInput): boolean;
  /** Fetch an inbound MMS attachment (the provider may require auth). */
  downloadMedia(url: string): Promise<{ buffer: Buffer; contentType: string }>;
}

/** A failed provider call, with the provider's numeric code when known. */
export class SmsProviderError extends Error {
  readonly code: number | null;
  readonly httpStatus: number;
  constructor(message: string, code: number | null, httpStatus: number) {
    super(message);
    this.name = 'SmsProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Map a provider-agnostic delivery state onto `messages.status`. */
export function toMessageStatus(
  status: SmsDeliveryStatus,
): 'sent' | 'delivered' | 'failed' | null {
  switch (status) {
    case 'queued':
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}
