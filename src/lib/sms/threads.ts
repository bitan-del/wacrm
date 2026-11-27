// ============================================================
// Contact / conversation / message plumbing shared by the SMS inbound
// webhook, keyword auto-replies and the inbox send path.
//
// One conversation per contact (migration 036's unique index), shared
// across channels: an SMS from a number we already talk to on WhatsApp
// lands in the same thread, marked `channel = 'sms'`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { applyPendingMessageStatuses } from '@/lib/whatsapp/message-status-sync';
import type { Contact } from '@/types';
import { smsPhoneFor } from './consent';

export interface ContactOutcome {
  contact: Contact;
  created: boolean;
}

/** The user_id to stamp on rows the webhook creates (NOT NULL audit FK). */
export async function resolveAuditUserId(
  db: SupabaseClient,
  accountId: string,
  preferred: string | null,
): Promise<string | null> {
  if (preferred) return preferred;
  const { data } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  return (data?.owner_user_id as string | undefined) ?? null;
}

export async function findOrCreateSmsContact(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  phone: string,
): Promise<ContactOutcome | null> {
  const existing = await findExistingContact(db, accountId, phone);
  if (existing) return { contact: existing as unknown as Contact, created: false };

  const e164 = smsPhoneFor(phone) ?? phone;
  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone: e164,
      name: e164,
    })
    .select()
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { contact: raced as unknown as Contact, created: false };
    }
    console.error('[sms] contact create failed:', error.message);
    return null;
  }
  return { contact: data as Contact, created: true };
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
): Promise<{ id: string; status?: string; created: boolean } | null> {
  const find = async () => {
    const { data, error } = await db
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      console.error('[sms] conversation lookup failed:', error.message);
      return null;
    }
    return data && data.length > 0 ? data[0] : null;
  };

  const existing = await find();
  if (existing) return { ...existing, created: false };

  const { data, error } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: auditUserId, contact_id: contactId })
    .select()
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await find();
      if (raced) return { ...raced, created: false };
    }
    console.error('[sms] conversation create failed:', error.message);
    return null;
  }
  return { ...data, created: true };
}

/**
 * Persist an outbound SMS on a conversation and refresh its summary.
 * Returns the new message row id, or null on a DB failure (the text has
 * already gone out — callers log, they don't retry the send).
 */
export async function persistOutboundSms(
  db: SupabaseClient,
  statusDb: SupabaseClient,
  params: {
    accountId: string;
    conversationId: string;
    text: string;
    providerMessageId: string;
    senderType: 'agent' | 'bot';
    senderId?: string | null;
  },
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .insert({
      conversation_id: params.conversationId,
      sender_type: params.senderType,
      sender_id: params.senderId ?? null,
      content_type: 'text',
      content_text: params.text,
      message_id: params.providerMessageId,
      status: 'sent',
      channel: 'sms',
    })
    .select('id')
    .single();

  if (error) {
    console.error('[sms] outbound message insert failed:', error.message);
    return null;
  }

  // A status callback can beat this insert; apply anything parked.
  await applyPendingMessageStatuses(statusDb, params.accountId, params.providerMessageId);

  const now = new Date().toISOString();
  await db
    .from('conversations')
    .update({ last_message_text: params.text, last_message_at: now, updated_at: now })
    .eq('id', params.conversationId);

  return data.id as string;
}
