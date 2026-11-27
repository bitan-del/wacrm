import { describe, expect, it, vi } from 'vitest';

import { contentTypeForMime, isSendableMediaUrl, mirrorSmsMedia } from './media';
import { parseTwilioInbound, TwilioSmsProvider } from './twilio';
import { smsAttachmentMessageId } from './inbound';

describe('contentTypeForMime', () => {
  it('maps MIME families onto message content types', () => {
    expect(contentTypeForMime('image/jpeg')).toBe('image');
    expect(contentTypeForMime('IMAGE/PNG; q=1')).toBe('image');
    expect(contentTypeForMime('video/mp4')).toBe('video');
    expect(contentTypeForMime('audio/amr')).toBe('audio');
    expect(contentTypeForMime('text/vcard')).toBe('document');
    expect(contentTypeForMime(null)).toBe('document');
  });
});

describe('isSendableMediaUrl', () => {
  it('only accepts https URLs', () => {
    expect(isSendableMediaUrl('https://x.supabase.co/storage/v1/object/public/chat-media/a.jpg')).toBe(true);
    expect(isSendableMediaUrl('http://example.com/a.jpg')).toBe(false);
    expect(isSendableMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isSendableMediaUrl(42)).toBe(false);
  });
});

describe('MMS parsing and ids', () => {
  it('keeps each attachment with its content type', () => {
    const sms = parseTwilioInbound({
      MessageSid: 'MM1',
      From: '+14155550100',
      To: '+18005551212',
      Body: '',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/m/0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/m/1',
      MediaContentType1: 'video/mp4',
    });
    expect(sms?.media).toEqual([
      { url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' },
      { url: 'https://api.twilio.com/m/1', contentType: 'video/mp4' },
    ]);
  });

  it('gives every attachment row a distinct, stable message id', () => {
    expect(smsAttachmentMessageId('MM1', 0)).toBe('MM1');
    expect(smsAttachmentMessageId('MM1', 2)).toBe('MM1-m2');
  });
});

describe('Twilio media', () => {
  it('attaches MediaUrl params on send', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ sid: 'MM9', status: 'queued' }), { status: 201 }),
    );
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC1', authToken: 't', fromNumber: '+18005551212' },
      fetchImpl as unknown as typeof fetch,
    );
    await provider.send({ to: '+14155550100', body: '', mediaUrls: ['https://cdn/a.jpg'] });
    const form = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.getAll('MediaUrl')).toEqual(['https://cdn/a.jpg']);
  });

  it('downloads media with Basic auth and refuses non-Twilio hosts', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const provider = new TwilioSmsProvider({ accountSid: 'AC1', authToken: 't' }, fetchImpl as unknown as typeof fetch);
    const out = await provider.downloadMedia('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1');
    expect(out.contentType).toBe('image/png');
    expect(out.buffer.byteLength).toBe(3);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    await expect(provider.downloadMedia('https://evil.example.com/x')).rejects.toThrow(/non-Twilio/);
  });

  it('mirrors into chat-media under a deterministic per-attachment path', async () => {
    const upload = vi.fn(async () => ({ error: null }));
    const storage = {
      from: () => ({ upload, getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn/${path}` } }) }),
    };
    const url = await mirrorSmsMedia({
      storage,
      provider: { downloadMedia: async () => ({ buffer: Buffer.from([1]), contentType: 'image/jpeg' }) },
      accountId: 'acct',
      messageId: 'MM1',
      index: 1,
      media: { url: 'https://api.twilio.com/m/1', contentType: 'image/jpeg' },
    });
    expect(url).toMatch(/^https:\/\/cdn\/account-acct\/inbound\/.*sms-MM1-1/);
    expect(upload).toHaveBeenCalledOnce();
  });
});
