import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  computeTwilioSignature,
  mapTwilioStatus,
  parseTwilioInbound,
  parseTwilioStatus,
  TwilioSmsProvider,
  validateTwilioSignature,
} from './twilio';
import { SmsProviderError } from './types';

const TOKEN = 'test-auth-token';
const URL_ = 'https://crm.example.com/api/sms/twilio/inbound?cfg=abc';
const PARAMS = {
  To: '+18005551212',
  From: '+14155550123',
  Body: 'STOP',
  MessageSid: 'SM00000000000000000000000000000001',
  AccountSid: 'AC00000000000000000000000000000001',
};

describe('computeTwilioSignature', () => {
  it('is HMAC-SHA1(token, url + params sorted by name as name+value), base64', () => {
    const expected = createHmac('sha1', TOKEN)
      .update(
        URL_ +
          'AccountSid' + PARAMS.AccountSid +
          'Body' + PARAMS.Body +
          'From' + PARAMS.From +
          'MessageSid' + PARAMS.MessageSid +
          'To' + PARAMS.To,
      )
      .digest('base64');
    expect(computeTwilioSignature(TOKEN, URL_, PARAMS)).toBe(expected);
  });

  it('does not depend on parameter insertion order', () => {
    const shuffled = { Body: PARAMS.Body, To: PARAMS.To, AccountSid: PARAMS.AccountSid, MessageSid: PARAMS.MessageSid, From: PARAMS.From };
    expect(computeTwilioSignature(TOKEN, URL_, shuffled)).toBe(computeTwilioSignature(TOKEN, URL_, PARAMS));
  });
});

describe('validateTwilioSignature', () => {
  const signature = computeTwilioSignature(TOKEN, URL_, PARAMS);

  it('accepts a matching signature on any candidate URL', () => {
    expect(
      validateTwilioSignature(TOKEN, { urls: ['http://internal:3000/x', URL_], params: PARAMS, signature }),
    ).toBe(true);
  });

  it('accepts the explicit-default-port spelling of the URL', () => {
    const withPort = 'https://crm.example.com:443/api/sms/twilio/inbound?cfg=abc';
    const sig = computeTwilioSignature(TOKEN, withPort, PARAMS);
    expect(validateTwilioSignature(TOKEN, { urls: [URL_], params: PARAMS, signature: sig })).toBe(true);
  });

  it('rejects the wrong token, a tampered param, a different URL or no signature', () => {
    expect(validateTwilioSignature('other-token', { urls: [URL_], params: PARAMS, signature })).toBe(false);
    expect(
      validateTwilioSignature(TOKEN, { urls: [URL_], params: { ...PARAMS, Body: 'START' }, signature }),
    ).toBe(false);
    expect(
      validateTwilioSignature(TOKEN, { urls: [URL_.replace('cfg=abc', 'cfg=xyz')], params: PARAMS, signature }),
    ).toBe(false);
    expect(validateTwilioSignature(TOKEN, { urls: [URL_], params: PARAMS, signature: null })).toBe(false);
    expect(validateTwilioSignature('', { urls: [URL_], params: PARAMS, signature })).toBe(false);
  });
});

describe('webhook parsing', () => {
  it('parses an inbound message, including MMS and the opt-out hint', () => {
    const sms = parseTwilioInbound({
      ...PARAMS,
      MessagingServiceSid: 'MG00000000000000000000000000000001',
      OptOutType: 'STOP',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/m0',
      MediaUrl1: 'https://api.twilio.com/m1',
    });
    expect(sms).toEqual({
      providerMessageId: PARAMS.MessageSid,
      accountRef: PARAMS.AccountSid,
      senderRef: 'MG00000000000000000000000000000001',
      from: PARAMS.From,
      to: PARAMS.To,
      body: 'STOP',
      keywordHint: 'STOP',
      mediaUrls: ['https://api.twilio.com/m0', 'https://api.twilio.com/m1'],
    });
  });

  it('returns null when required fields are missing', () => {
    expect(parseTwilioInbound({ From: '+1', To: '+2' })).toBeNull();
  });

  it('parses a failed status callback with its error code', () => {
    expect(
      parseTwilioStatus({
        MessageSid: 'SM1',
        MessageStatus: 'undelivered',
        ErrorCode: '30007',
        AccountSid: 'AC1',
        To: '+14155550123',
      }),
    ).toMatchObject({ providerMessageId: 'SM1', status: 'failed', rawStatus: 'undelivered', errorCode: 30007 });
  });

  it('maps Twilio statuses onto delivery states', () => {
    expect(mapTwilioStatus('accepted')).toBe('queued');
    expect(mapTwilioStatus('sending')).toBe('queued');
    expect(mapTwilioStatus('sent')).toBe('sent');
    expect(mapTwilioStatus('delivered')).toBe('delivered');
    expect(mapTwilioStatus('undelivered')).toBe('failed');
    expect(mapTwilioStatus('canceled')).toBe('failed');
    expect(mapTwilioStatus('received')).toBe('received');
    expect(mapTwilioStatus('weird')).toBe('unknown');
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TwilioSmsProvider.send', () => {
  const creds = {
    accountSid: 'AC00000000000000000000000000000001',
    authToken: TOKEN,
    messagingServiceSid: 'MG00000000000000000000000000000001',
  };

  it('posts a form with the messaging service and status callback', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { sid: 'SM123', status: 'queued', num_segments: '2' }),
    );
    const provider = new TwilioSmsProvider(creds, fetchImpl as unknown as typeof fetch);
    const result = await provider.send({ to: '+14155550123', body: 'Hi', statusCallbackUrl: 'https://x/status' });

    expect(result).toEqual({ providerMessageId: 'SM123', status: 'queued', segments: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('+14155550123');
    expect(form.get('MessagingServiceSid')).toBe(creds.messagingServiceSid);
    expect(form.get('From')).toBeNull();
    expect(form.get('StatusCallback')).toBe('https://x/status');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from(`${creds.accountSid}:${TOKEN}`).toString('base64'),
    );
  });

  it('falls back to the From number without a messaging service', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sid: 'SM1', status: 'queued' }));
    const provider = new TwilioSmsProvider(
      { accountSid: creds.accountSid, authToken: TOKEN, fromNumber: '+18005551212' },
      fetchImpl as unknown as typeof fetch,
    );
    await provider.send({ to: '+14155550123', body: 'Hi' });
    const form = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.get('From')).toBe('+18005551212');
    expect(form.get('StatusCallback')).toBeNull();
  });

  it('surfaces Twilio error codes (21610 = unsubscribed recipient)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 }),
    );
    const provider = new TwilioSmsProvider(creds, fetchImpl as unknown as typeof fetch);
    const err = await provider.send({ to: '+14155550123', body: 'Hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(SmsProviderError);
    expect(err).toMatchObject({ code: 21610, httpStatus: 400 });
  });

  it('refuses to send with no sender configured', async () => {
    const provider = new TwilioSmsProvider({ accountSid: creds.accountSid, authToken: TOKEN }, vi.fn());
    await expect(provider.send({ to: '+14155550123', body: 'Hi' })).rejects.toBeInstanceOf(SmsProviderError);
  });
});

describe('TwilioSmsProvider.verifyCredentials', () => {
  it('checks the account and that the From number belongs to it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('IncomingPhoneNumbers')) return jsonResponse(200, { incoming_phone_numbers: [] });
      return jsonResponse(200, { status: 'active', friendly_name: 'Acme' });
    });
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC1', authToken: TOKEN, fromNumber: '+18005551212' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.verifyCredentials()).rejects.toThrow(/not a phone number on this Twilio account/);
  });

  it('rejects a suspended account', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'suspended' }));
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC1', authToken: TOKEN, messagingServiceSid: 'MG1' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.verifyCredentials()).rejects.toThrow(/suspended/);
  });

  it('returns the account name when everything checks out', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'active', friendly_name: 'Acme' }));
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC1', authToken: TOKEN, messagingServiceSid: 'MG1' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.verifyCredentials()).resolves.toEqual({ accountName: 'Acme' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // account + messaging service
  });
});
