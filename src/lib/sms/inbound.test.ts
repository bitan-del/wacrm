import { describe, expect, it } from 'vitest';

import { defaultHelpReply, resolvePublicOrigin, smsWebhookUrls } from './config';
import { keywordReplyText } from './inbound';
import { statusFailureText } from './status';
import { parseFormBody } from './webhook';

const config = {
  brand_name: 'Acme',
  help_reply_text: null,
  opt_out_reply_text: 'You are unsubscribed.',
  opt_in_reply_text: 'Welcome back!',
};

describe('keywordReplyText', () => {
  it('always answers HELP, with a default when none is configured', () => {
    expect(keywordReplyText('help', config, { managesOptOutConfirmations: true })).toBe(
      defaultHelpReply('Acme'),
    );
    expect(
      keywordReplyText('help', { ...config, help_reply_text: '  Call 555-0100  ' }, { managesOptOutConfirmations: true }),
    ).toBe('Call 555-0100');
  });

  it('stays silent on STOP / START when the provider confirms them itself', () => {
    expect(keywordReplyText('opt_out', config, { managesOptOutConfirmations: true })).toBeNull();
    expect(keywordReplyText('opt_in', config, { managesOptOutConfirmations: true })).toBeNull();
  });

  it('sends the configured confirmations when the provider does not', () => {
    expect(keywordReplyText('opt_out', config, { managesOptOutConfirmations: false })).toBe(
      'You are unsubscribed.',
    );
    expect(keywordReplyText('opt_in', config, { managesOptOutConfirmations: false })).toBe('Welcome back!');
    expect(
      keywordReplyText('opt_in', { ...config, opt_in_reply_text: ' ' }, { managesOptOutConfirmations: false }),
    ).toBeNull();
  });
});

describe('defaultHelpReply', () => {
  it('names the brand and the opt-out keyword', () => {
    expect(defaultHelpReply('Acme')).toMatch(/^Acme: Reply STOP/);
    expect(defaultHelpReply(null)).toMatch(/^Reply STOP/);
  });
});

describe('webhook URLs', () => {
  it('embeds the config id the webhook uses to pick the tenant', () => {
    expect(smsWebhookUrls('https://crm.example.com/', { id: 'cfg-1', provider: 'twilio' })).toEqual({
      inbound: 'https://crm.example.com/api/sms/twilio/inbound?cfg=cfg-1',
      status: 'https://crm.example.com/api/sms/twilio/status?cfg=cfg-1',
    });
  });

  it('prefers NEXT_PUBLIC_SITE_URL, then forwarded headers, then the request', () => {
    const prev = process.env.NEXT_PUBLIC_SITE_URL;
    try {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      const req = new Request('http://10.0.0.1:3000/api/x', {
        headers: { 'x-forwarded-host': 'crm.example.com', 'x-forwarded-proto': 'https' },
      });
      expect(resolvePublicOrigin(req)).toBe('https://crm.example.com');
      expect(resolvePublicOrigin(new Request('http://localhost:3000/api/x'))).toBe('http://localhost:3000');
      expect(resolvePublicOrigin(null)).toBeNull();
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com/';
      expect(resolvePublicOrigin(req)).toBe('https://app.example.com');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = prev;
    }
  });
});

describe('parseFormBody', () => {
  it('decodes Twilio form encoding, including + as space and %2B', () => {
    expect(parseFormBody('From=%2B14155550123&Body=Stop+please&NumMedia=0')).toEqual({
      From: '+14155550123',
      Body: 'Stop please',
      NumMedia: '0',
    });
  });
});

describe('statusFailureText', () => {
  it('prefixes the provider code', () => {
    expect(statusFailureText({ errorCode: 30007, errorMessage: null, rawStatus: 'undelivered' })).toBe(
      '[30007] undelivered',
    );
    expect(statusFailureText({ errorCode: null, errorMessage: 'Carrier violation', rawStatus: 'failed' })).toBe(
      'Carrier violation',
    );
  });
});
