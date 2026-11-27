import { describe, expect, it } from 'vitest';
import { parseConsentCell, parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('keeps a row with an empty phone cell instead of dropping it silently', () => {
    const csv = `phone,name
+15551234567,Alice
,Bob`;

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      phone: '',
      name: 'Bob',
      email: undefined,
      company: undefined,
      tagNames: [],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });
});

describe('parseContactCsv — SMS columns', () => {
  it('reads sms_consent and timezone when present', () => {
    const { rows } = parseContactCsv(
      'phone,name,sms_consent,timezone\n+14155550100,Ann,yes,America/Los_Angeles\n+14155550101,Bo,no,\n+14155550102,Cy,,\n',
    );
    expect(rows.map((r) => [r.smsConsent, r.timezone])).toEqual([
      [true, 'America/Los_Angeles'],
      [false, undefined],
      [undefined, undefined],
    ]);
  });

  it('leaves both undefined without the columns', () => {
    const { rows } = parseContactCsv('phone\n+14155550100\n');
    expect(rows[0].smsConsent).toBeUndefined();
    expect(rows[0].timezone).toBeUndefined();
  });
});

describe('parseConsentCell', () => {
  it('only treats clear yes values as consent', () => {
    for (const v of ['yes', 'Y', 'TRUE', '1', 'opt-in', 'opted in', 'x']) expect(parseConsentCell(v)).toBe(true);
    for (const v of ['no', 'false', '0', 'opt_out']) expect(parseConsentCell(v)).toBe(false);
    for (const v of ['', 'maybe', undefined]) expect(parseConsentCell(v)).toBeUndefined();
  });
});
