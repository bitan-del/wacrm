import { describe, expect, it } from 'vitest';

import {
  classifySmsAudienceContact,
  classifySmsReply,
  hasSmsOptIn,
  isStaffOptInSource,
  partitionSmsAudience,
  smsPhoneFor,
} from './consent';

const IN = '2026-01-01T00:00:00Z';
const OUT = '2026-02-01T00:00:00Z';

describe('smsPhoneFor', () => {
  it('normalizes stored numbers to +E.164', () => {
    expect(smsPhoneFor('14155550123')).toBe('+14155550123');
    expect(smsPhoneFor('+1 (415) 555-0123')).toBe('+14155550123');
  });

  it('rejects empty and implausible numbers', () => {
    expect(smsPhoneFor('')).toBeNull();
    expect(smsPhoneFor(null)).toBeNull();
    expect(smsPhoneFor('12345')).toBeNull();
    expect(smsPhoneFor('0123456789')).toBeNull();
  });
});

describe('broadcast eligibility', () => {
  it('requires an opt-in and no opt-out', () => {
    expect(classifySmsAudienceContact({ phone: '14155550123', sms_opted_in_at: IN, sms_opted_out_at: null })).toBe('eligible');
    expect(classifySmsAudienceContact({ phone: '14155550123', sms_opted_in_at: null, sms_opted_out_at: null })).toBe('no_consent');
    expect(classifySmsAudienceContact({ phone: '14155550123', sms_opted_in_at: IN, sms_opted_out_at: OUT })).toBe('opted_out');
  });

  it('reports an opt-out before a missing opt-in or a bad number', () => {
    expect(classifySmsAudienceContact({ phone: '', sms_opted_in_at: null, sms_opted_out_at: OUT })).toBe('opted_out');
  });

  it('excludes consented contacts with no dialable number', () => {
    expect(classifySmsAudienceContact({ phone: '', sms_opted_in_at: IN, sms_opted_out_at: null })).toBe('invalid_phone');
  });

  it('hasSmsOptIn is false once opted out', () => {
    expect(hasSmsOptIn({ sms_opted_in_at: IN, sms_opted_out_at: null })).toBe(true);
    expect(hasSmsOptIn({ sms_opted_in_at: IN, sms_opted_out_at: OUT })).toBe(false);
  });
});

describe('inbox reply gate', () => {
  it('allows replying to a contact with no opt-in (conversational)', () => {
    expect(classifySmsReply({ phone: '14155550123', sms_opted_in_at: null, sms_opted_out_at: null })).toBe('allowed');
  });

  it('never allows replying after an opt-out', () => {
    expect(classifySmsReply({ phone: '14155550123', sms_opted_in_at: IN, sms_opted_out_at: OUT })).toBe('opted_out');
  });

  it('rejects an undialable number', () => {
    expect(classifySmsReply({ phone: '', sms_opted_in_at: null, sms_opted_out_at: null })).toBe('invalid_phone');
  });
});

describe('partitionSmsAudience', () => {
  it('keeps eligible contacts and counts every exclusion', () => {
    const contacts = [
      { id: 'a', phone: '14155550101', sms_opted_in_at: IN, sms_opted_out_at: null },
      { id: 'b', phone: '14155550102', sms_opted_in_at: null, sms_opted_out_at: null },
      { id: 'c', phone: '14155550103', sms_opted_in_at: IN, sms_opted_out_at: OUT },
      { id: 'd', phone: 'n/a', sms_opted_in_at: IN, sms_opted_out_at: null },
      { id: 'e', phone: '+44 7700 900123', sms_opted_in_at: IN, sms_opted_out_at: null },
    ];
    const out = partitionSmsAudience(contacts);
    expect(out.eligible.map((c) => c.id)).toEqual(['a', 'e']);
    expect(out).toMatchObject({ noConsent: 1, optedOut: 1, invalidPhone: 1 });
  });
});

describe('staff opt-in sources', () => {
  it('excludes the keyword source, which is reserved for the recipient', () => {
    expect(isStaffOptInSource('web_form')).toBe(true);
    expect(isStaffOptInSource('manual')).toBe(true);
    expect(isStaffOptInSource('keyword')).toBe(false);
    expect(isStaffOptInSource('nonsense')).toBe(false);
  });
});
