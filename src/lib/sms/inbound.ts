// ============================================================
// Inbound SMS processing (runs inside the webhook's `after()`).
//
//   1. Find-or-create the contact by phone, then their conversation.
//   2. Insert the message (channel 'sms'). The unique index on
//      (conversation_id, message_id) makes provider retries no-ops —
//      this insert is the idempotency boundary, so nothing below runs
//      twice for one MessageSid.
//      MMS attachments are mirrored to `chat-media` first, one message
//      row each (the first carries the text as its caption).
//   3. Keywords: STOP family → opt out, START → opt in, HELP → reply.
//   4. Bump the conversation, re-open it, credit a broadcast reply,
//      fan out the public `message.received` webhook.
//   5. Ordinary texts (not a compliance keyword) run automations with
//      `channel: 'sms'` — their text steps reply by SMS — and then the
//      AI auto-reply, also over SMS. Flows are not dispatched: they are
//      built from WhatsApp buttons and lists, which SMS can't carry.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { flagBroadcastReply } from '@/lib/whatsapp/broadcast-recipient-webhook';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { defaultHelpReply, smsWebhookUrls, type SmsConfigRow } from './config';
import { applySmsConsent, recordSmsHelpEvent } from './consent-store';
import { classifySmsKeyword, normalizeKeywordText, type SmsKeywordIntent } from './keywords';
import { contentTypeForMime, mirrorSmsMedia } from './media';
import { findOrCreateConversation, findOrCreateSmsContact, persistOutboundSms, resolveAuditUserId } from './threads';
import type { InboundSms, SmsProvider } from './types';

export interface InboundOutcome {
  status: 'stored' | 'duplicate' | 'dropped';
  intent: SmsKeywordIntent | null;
}

/** Message id of the i-th attachment row (the first reuses the provider id). */
export function smsAttachmentMessageId(providerMessageId: string, index: number): string {
  return index === 0 ? providerMessageId : `${providerMessageId}-m${index}`;
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

  const text = sms.body ?? '';

  // Cheap replay check before spending any media downloads.
  const { data: already } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', sms.providerMessageId)
    .limit(1);
  if (already && already.length > 0) return { status: 'duplicate', intent: null };

  const attachments = await Promise.all(
    sms.media.map(async (media, index) => ({
      kind: contentTypeForMime(media.contentType),
      mime: media.contentType,
      url:
        (await mirrorSmsMedia({
          storage: db.storage,
          provider,
          accountId,
          messageId: sms.providerMessageId,
          index,
          media,
        })) ?? media.url,
    })),
  );
  const rows =
    attachments.length === 0
      ? [{ content_type: 'text', content_text: text || null, media_url: null, media_type: null }]
      : attachments.map((a, i) => ({
          content_type: a.kind,
          content_text: i === 0 ? text || null : null,
          media_url: a.url,
          media_type: a.mime,
        }));

  // The first row is the idempotency boundary: an empty result means a
  // concurrent delivery of the same MessageSid got there first.
  const { data: inserted, error: insertError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        ...rows[0],
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
  if (rows.length > 1) {
    const { error: extraError } = await db.from('messages').upsert(
      rows.slice(1).map((row, i) => ({
        conversation_id: conversation.id,
        sender_type: 'customer',
        ...row,
        message_id: smsAttachmentMessageId(sms.providerMessageId, i + 1),
        status: 'delivered',
        channel: 'sms',
      })),
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    );
    if (extraError) console.error('[sms/inbound] extra attachment insert failed:', extraError.message);
  }
  const summary = text || (attachments.length > 0 ? `[${attachments[0].kind}]` : '[sms]');

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
    p_last_message_text: summary,
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

  // ---- Automations + AI (ordinary texts only) --------------------
  if (intent === null) {
    const isFirstInbound = await claimFirstInboundMessage(
      db,
      conversation as { id: string; first_inbound_at?: string | null },
      new Date().toISOString(),
    );
    const triggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match')[] = [
      'new_message_received',
      'keyword_match',
    ];
    if (contactOutcome.created) triggers.unshift('new_contact_created');
    if (isFirstInbound) triggers.unshift('first_inbound_message');
    for (const triggerType of triggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contact.id,
        context: { message_text: text, conversation_id: conversation.id, channel: 'sms' },
      }).catch((err) => console.error('[sms/inbound] automations failed:', err));
    }

    if (text.trim()) {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: conversation.id,
        contactId: contact.id,
        configOwnerUserId: auditUserId,
        // The newest row of this delivery — the AI skips when a newer
        // customer message exists, and extra MMS rows come after the first.
        inboundMessageId: smsAttachmentMessageId(sms.providerMessageId, rows.length - 1),
        channel: 'sms',
      });
    }
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    channel: 'sms',
    sms_message_id: sms.providerMessageId,
    content_type: rows[0].content_type,
    text,
  });

  return { status: 'stored', intent };
}
