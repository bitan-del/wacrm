// ============================================================
// SMS text send for the automation engine and the AI auto-reply —
// the SMS counterpart of `engineSendText` in flows/meta-send.ts.
//
// Used when the run was triggered by an inbound SMS (context.channel
// === 'sms'). Same gates as an inbox reply: SMS configured + on, the
// contact hasn't opted out, the number is dialable. Never sends after
// STOP, whatever the automation says.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope';
import { classifySmsReply, smsPhoneFor } from './consent';
import { optOutByPhone } from './consent-store';
import {
  createSmsProvider,
  loadSmsConfigForAccount,
  resolvePublicOrigin,
  smsWebhookUrls,
} from './config';
import { persistOutboundSms } from './threads';
import { TWILIO_ERROR_UNSUBSCRIBED } from './twilio';
import { SmsProviderError } from './types';

export interface EngineSmsArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  text: string;
  aiGenerated?: boolean;
}

export async function engineSendSmsText(args: EngineSmsArgs): Promise<{ sms_message_id: string }> {
  const db = supabaseAdmin();

  const { data: contact, error } = await db
    .from('contacts')
    .select('id, phone, sms_opted_in_at, sms_opted_out_at')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (error || !contact) throw new Error('Contact not found');
  await assertConversationInAccount(db, args.conversationId, args.accountId);

  const verdict = classifySmsReply(contact);
  if (verdict === 'opted_out') throw new Error('Contact has opted out of SMS');
  const to = smsPhoneFor(contact.phone);
  if (verdict === 'invalid_phone' || !to) throw new Error('Contact has no valid phone number for SMS');

  const config = await loadSmsConfigForAccount(db, args.accountId);
  if (!config || !config.is_active) throw new Error('SMS is not set up for this workspace');

  const origin = resolvePublicOrigin(null);
  let sid: string;
  try {
    const result = await createSmsProvider(config).send({
      to,
      body: args.text,
      statusCallbackUrl: origin ? smsWebhookUrls(origin, config).status : null,
    });
    sid = result.providerMessageId;
  } catch (err) {
    if (err instanceof SmsProviderError && err.code === TWILIO_ERROR_UNSUBSCRIBED) {
      await optOutByPhone(db, args.accountId, to, 'provider');
      throw new Error('Contact has opted out of SMS');
    }
    throw err;
  }

  await persistOutboundSms(db, db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    text: args.text,
    providerMessageId: sid,
    senderType: 'bot',
    aiGenerated: args.aiGenerated,
  });
  return { sms_message_id: sid };
}
