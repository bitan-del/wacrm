// ============================================================
// MMS attachments.
//
// Inbound: copied into the `chat-media` bucket (same durable-URL
// mirror the WhatsApp webhook uses), because the provider's URL may
// need the account's credentials to read and can be deleted at any
// time. Outbound: a public https URL the provider fetches at send time
// — the composer's chat-media upload already produces one.
// ============================================================

import {
  mirrorInboundMedia,
  normalizeMimeType,
  type MirrorStorage,
} from '@/lib/whatsapp/mirror-inbound-media';
import type { InboundSmsMedia, SmsProvider } from './types';

export type SmsMediaKind = 'image' | 'video' | 'audio' | 'document';

/** The `messages.content_type` an attachment of this MIME renders as. */
export function contentTypeForMime(mime: string | null | undefined): SmsMediaKind {
  const m = normalizeMimeType(mime) ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Kinds an agent may send as MMS. Carriers reliably deliver images; others vary. */
export const SMS_OUTBOUND_MEDIA_KINDS: readonly SmsMediaKind[] = ['image'];

/** Mirror one inbound attachment; null when it couldn't be copied. */
export async function mirrorSmsMedia(args: {
  storage: MirrorStorage;
  provider: Pick<SmsProvider, 'downloadMedia'>;
  accountId: string;
  messageId: string;
  index: number;
  media: InboundSmsMedia;
}): Promise<string | null> {
  return mirrorInboundMedia({
    storage: args.storage,
    accountId: args.accountId,
    // Deterministic per attachment → a provider retry overwrites, not duplicates.
    mediaId: `sms-${args.messageId}-${args.index}`,
    downloadUrl: args.media.url,
    accessToken: '',
    mimeType: args.media.contentType,
    download: ({ downloadUrl }) => args.provider.downloadMedia(downloadUrl),
  });
}

/** True for an https URL we can hand the provider for an outbound MMS. */
export function isSendableMediaUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
