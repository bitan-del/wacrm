// ============================================================
// Inbox SMS send: an agent replies to a conversation by SMS.
//
// Gates, in order: SMS configured + active → contact not opted out →
// dialable number. Opt-in is NOT required here (see consent.ts): this
// is a 1:1 reply, not marketing. Quiet hours are not applied to live
// agent replies either — they gate unsolicited bulk sends.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Contact } from '@/types';
import { classifySmsReply, smsPhoneFor } from './consent';
import { optOutByPhone } from './consent-store';
import { createSmsProvider, loadSmsConfigForAccount, smsWebhookUrls, SmsConfigUnreadableError } from './config';
import { SMS_MAX_BODY_CHARS } from './limits';
import { isSendableMediaUrl } from './media';
import { persistOutboundSms } from './threads';
import { TWILIO_ERROR_UNSUBSCRIBED } from './twilio';
import { SmsProviderError } from './types';

export { SMS_MAX_BODY_CHARS };

export type SmsSendErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'sms_not_configured'
  | 'opted_out'
  | 'invalid_phone'
  | 'provider_error'
  | 'db_error';

export class SmsSendError extends Error {
  readonly code: SmsSendErrorCode;
  readonly status: number;
  constructor(code: SmsSendErrorCode, message: string, status: number) {
    super(message);
    this.name = 'SmsSendError';
    this.code = code;
    this.status = status;
  }
}

export interface SendSmsToConversationParams {
  conversationId: string;
  text: string;
  senderId: string;
  /** Public origin for the status callback; null skips it. */
  origin: string | null;
  /** MMS: a public https image URL (the composer's chat-media upload). */
  mediaUrl?: string | null;
}

export async function sendSmsToConversation(
  /** Caller's RLS client — scopes the conversation lookup + insert. */
  db: SupabaseClient,
  /** Service role — reads the encrypted config, applies statuses. */
  admin: SupabaseClient,
  accountId: string,
  params: SendSmsToConversationParams,
): Promise<{ messageId: string; providerMessageId: string }> {
  const text = (params.text ?? '').trim();
  const mediaUrl = params.mediaUrl ?? null;
  if (mediaUrl !== null && !isSendableMediaUrl(mediaUrl)) {
    throw new SmsSendError('bad_request', 'Attachment URL must be https', 400);
  }
  if (!text && !mediaUrl) throw new SmsSendError('bad_request', 'Message text is required', 400);
  if (text.length > SMS_MAX_BODY_CHARS) {
    throw new SmsSendError('bad_request', `SMS is limited to ${SMS_MAX_BODY_CHARS} characters`, 400);
  }

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('id, contact:contacts(*)')
    .eq('id', params.conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (convError || !conversation) {
    throw new SmsSendError('not_found', 'Conversation not found', 404);
  }
  const contact = (conversation as unknown as { contact: Contact | null }).contact;
  if (!contact) throw new SmsSendError('not_found', 'Conversation has no contact', 404);

  const verdict = classifySmsReply(contact);
  if (verdict === 'opted_out') {
    throw new SmsSendError('opted_out', 'This contact has opted out of SMS', 409);
  }
  const to = smsPhoneFor(contact.phone);
  if (verdict === 'invalid_phone' || !to) {
    throw new SmsSendError('invalid_phone', 'This contact has no valid phone number for SMS', 400);
  }

  const config = await loadSmsConfigForAccount(admin, accountId);
  if (!config || !config.is_active) {
    throw new SmsSendError('sms_not_configured', 'SMS is not set up for this workspace', 400);
  }

  let providerMessageId: string;
  try {
    const provider = createSmsProvider(config);
    const result = await provider.send({
      to,
      body: text,
      statusCallbackUrl: params.origin ? smsWebhookUrls(params.origin, config).status : null,
      mediaUrls: mediaUrl ? [mediaUrl] : undefined,
    });
    providerMessageId = result.providerMessageId;
  } catch (err) {
    if (err instanceof SmsConfigUnreadableError) {
      throw new SmsSendError('sms_not_configured', err.message, 400);
    }
    if (err instanceof SmsProviderError) {
      if (err.code === TWILIO_ERROR_UNSUBSCRIBED) {
        await optOutByPhone(admin, accountId, to, 'provider');
        throw new SmsSendError('opted_out', 'This number has unsubscribed from your SMS', 409);
      }
      const code = err.code !== null ? ` [${err.code}]` : '';
      throw new SmsSendError('provider_error', `SMS provider error${code}: ${err.message}`, 502);
    }
    throw err;
  }

  const messageId = await persistOutboundSms(db, admin, {
    accountId,
    conversationId: params.conversationId,
    text,
    providerMessageId,
    senderType: 'agent',
    senderId: params.senderId,
    media: mediaUrl ? { kind: 'image', url: mediaUrl } : null,
  });
  if (!messageId) {
    throw new SmsSendError('db_error', 'SMS sent but failed to save to the conversation', 500);
  }
  return { messageId, providerMessageId };
}
