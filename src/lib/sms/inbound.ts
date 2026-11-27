// ============================================================
// Inbound SMS processing (runs inside the webhook's `after()`).
//
//   1. Find-or-create the contact by phone, then their conversation.
//   2. Insert the message (channel 'sms'). The unique index on
//      (conversation_id, message_id) makes provider retries no-ops —
//      this insert is the idempotency boundary, so nothing below runs
//      twice for one MessageSid.
//   3. Keywords: STOP family → opt out, START → opt in, HELP → reply.
//   4. Bump the conversation, re-open it, credit a broadcast reply,
//      fan out the public `message.received` webhook.
//
// Automations, Flows and AI auto-reply are WhatsApp-only and are NOT
// dispatched here: every one of them answers over WhatsApp.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { flagBroadcastReply } from '@/lib/whatsapp/broadcast-recipient-webhook';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { defaultHelpReply, smsWebhookUrls, type SmsConfigRow } from './config';
import { applySmsConsent, recordSmsHelpEvent } from './consent-store';
import { classifySmsKeyword, normalizeKeywordText, type SmsKeywordIntent } from './keywords';
import { findOrCreateConversation, findOrCreateSmsContact, persistOutboundSms, resolveAuditUserId } from './threads';
import type { InboundSms, SmsProvider } from './types';

export interface InboundOutcome {
  status: 'stored' | 'duplicate' | 'dropped';
  intent: SmsKeywordIntent | null;
}

function inboundText(sms: InboundSms): string {
  const body = sms.body ?? '';
  if (sms.mediaUrls.length === 0) return body;
  const note = `[MMS: ${sms.mediaUrls.length} attachment${sms.mediaUrls.length === 1 ? '' : 's'}]`;
  return body ? `${body}\n${note}` : note;
}

/** Text we send back for a keyword, or null to stay silent. */
export function keywordReplyText(
  intent: SmsKeywordIntent,
  config: Pick<SmsConfigRow, 'help_reply_text' | 'opt_out_reply_text' | 'opt_in_reply_text' | 'brand_name'>,
  provider: Pick<SmsProvider, 'managesOptOutConfirmations'>,
): string | null {
  if (intent === 'help') {
    return config.help_reply_text?.trim() || defaultHelpReply(config.brand_name);
  }
  // The provider already confirmed STOP / START to the handset (and
  // would reject a send to a just-opted-out number anyway).
  if (provider.managesOptOutConfirmations) return null;
  const text = intent === 'opt_out' ? config.opt_out_reply_text : config.opt_in_reply_text;
  return text?.trim() || null;
}

export async function processInboundSms(
  db: SupabaseClient,
  config: SmsConfigRow,
  provider: SmsProvider,
  sms: InboundSms,
  /** Public origin for the auto-reply's status callback; null skips it. */
  origin: string | null,
): Promise<InboundOutcome> {
  const accountId = config.account_id;
  const auditUserId = await resolveAuditUserId(db, accountId, config.created_by);
  if (!auditUserId) {
    console.error('[sms/inbound] no audit user for account', accountId);
    return { status: 'dropped', intent: null };
  }

  const contactOutcome = await findOrCreateSmsContact(db, accountId, auditUserId, sms.from);
  if (!contactOutcome) return { status: 'dropped', intent: null };
  const contact = contactOutcome.contact;

  const conversation = await findOrCreateConversation(db, accountId, auditUserId, contact.id);
  if (!conversation) return { status: 'dropped', intent: null };

  if (conversation.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    });
  }

  const text = inboundText(sms);
  const { data: inserted, error: insertError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: text || null,
        message_id: sms.providerMessageId,
        status: 'delivered',
        channel: 'sms',
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id');

  if (insertError) {
    console.error('[sms/inbound] message insert failed:', insertError.message);
    return { status: 'dropped', intent: null };
  }
  if (!inserted || inserted.length === 0) {
    return { status: 'duplicate', intent: null };
  }

  // ---- Compliance keywords -------------------------------------
  const intent = classifySmsKeyword(sms.body, sms.keywordHint);
  const keyword = normalizeKeywordText(sms.body) || sms.keywordHint || null;
  if (intent === 'opt_out' || intent === 'opt_in') {
    try {
      await applySmsConsent(db, accountId, [contact.id], {
        action: intent,
        source: 'keyword',
        keyword,
        providerMessageId: sms.providerMessageId,
      });
    } catch (err) {
      // Loud: a lost STOP is a compliance incident.
      console.error('[sms/inbound] CONSENT UPDATE FAILED', {
        accountId,
        contactId: contact.id,
        intent,
        error: err instanceof Error ? err.message : err,
      });
    }
  } else if (intent === 'help') {
    await recordSmsHelpEvent(db, {
      accountId,
      contactId: contact.id,
      phone: sms.from,
      keyword,
      providerMessageId: sms.providerMessageId,
    });
  }

  // ---- Conversation bookkeeping --------------------------------
  const { error: bumpError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: text || '[sms]',
  });
  if (bumpError) console.error('[sms/inbound] conversation bump failed:', bumpError.message);

  await reopenClosedConversation(db, conversation);

  if (intent === null) {
    try {
      await flagBroadcastReply(db, accountId, contact.id);
    } catch (err) {
      console.error('[sms/inbound] broadcast reply flag failed:', err);
    }
  }

  // ---- Keyword auto-reply --------------------------------------
  if (intent) {
    const reply = keywordReplyText(intent, config, provider);
    if (reply) {
      try {
        const result = await provider.send({
          to: sms.from,
          body: reply,
          statusCallbackUrl: origin ? smsWebhookUrls(origin, config).status : null,
        });
        await persistOutboundSms(db, db, {
          accountId,
          conversationId: conversation.id,
          text: reply,
          providerMessageId: result.providerMessageId,
          senderType: 'bot',
        });
      } catch (err) {
        console.error('[sms/inbound] keyword auto-reply failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    channel: 'sms',
    sms_message_id: sms.providerMessageId,
    content_type: 'text',
    text,
  });

  return { status: 'stored', intent };
}
