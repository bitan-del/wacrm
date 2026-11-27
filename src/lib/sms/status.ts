// ============================================================
// SMS delivery-status callbacks.
//
// A provider message id belongs to exactly one of:
//   - a broadcast recipient (`broadcast_recipients.sms_message_id`) —
//     broadcasts don't write `messages` rows, same as WhatsApp; or
//   - an inbox / auto-reply message (`messages.message_id`).
// The recipient is tried first so a broadcast status doesn't get parked
// in `pending_message_statuses` waiting for a message that never comes.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { allowedPredecessors } from '@/lib/broadcast-status';
import { applyMessageStatus } from '@/lib/whatsapp/message-status-sync';
import type { RecipientStatus } from '@/types';
import { optOutByPhone } from './consent-store';
import { TWILIO_ERROR_UNSUBSCRIBED } from './twilio';
import { toMessageStatus, type SmsStatusEvent } from './types';

export function statusFailureText(event: Pick<SmsStatusEvent, 'errorCode' | 'errorMessage' | 'rawStatus'>): string {
  const code = event.errorCode !== null ? `[${event.errorCode}] ` : '';
  return `${code}${event.errorMessage ?? event.rawStatus}`;
}

async function applyRecipientStatus(
  db: SupabaseClient,
  accountId: string,
  event: SmsStatusEvent,
  status: RecipientStatus,
): Promise<boolean> {
  const { data: rows, error } = await db
    .from('broadcast_recipients')
    .select('id, broadcasts!inner(account_id)')
    .eq('sms_message_id', event.providerMessageId)
    .eq('broadcasts.account_id', accountId);
  if (error) {
    console.error('[sms/status] recipient lookup failed:', error.message);
    return false;
  }
  if (!rows || rows.length === 0) return false;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status };
  if (status === 'sent') patch.sent_at = now;
  if (status === 'delivered') patch.delivered_at = now;
  if (status === 'failed') patch.error_message = statusFailureText(event);

  const { error: updateError } = await db
    .from('broadcast_recipients')
    .update(patch)
    .in('id', rows.map((r: { id: string }) => r.id))
    .in('status', allowedPredecessors(status));
  if (updateError) console.error('[sms/status] recipient update failed:', updateError.message);
  return true;
}

export async function applySmsStatusEvent(
  db: SupabaseClient,
  accountId: string,
  event: SmsStatusEvent,
): Promise<void> {
  if (event.errorCode === TWILIO_ERROR_UNSUBSCRIBED && event.to) {
    await optOutByPhone(db, accountId, event.to, 'provider');
  }

  const status = toMessageStatus(event.status);
  if (!status) return;

  if (await applyRecipientStatus(db, accountId, event, status)) return;

  await applyMessageStatus(db, accountId, {
    wamid: event.providerMessageId,
    status,
    failure:
      status === 'failed'
        ? {
            code: event.errorCode ?? 0,
            title: event.rawStatus,
            details: event.errorMessage,
          }
        : null,
    statusAt: new Date().toISOString(),
  });
}
