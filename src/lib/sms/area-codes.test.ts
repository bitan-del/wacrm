import { describe, expect, it } from 'vitest';

import { knownAreaCodes, nanpAreaCode, timeZonesForPhone } from './area-codes';
import {
  isQuietHoursInAny,
  isValidTimeZone,
  nextAllowedSendTimeInAll,
  recipientTimeZones,
} from './quiet-hours';
import { planSmsBroadcast } from './broadcast';

describe('area code table', () => {
  it('only contains 3-digit codes with valid IANA zones', () => {
    const codes = knownAreaCodes();
    expect(codes.length).toBeGreaterThan(350);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9]\d\d$/);
      for (const tz of timeZonesForPhone(`+1${code}5550100`)!) expect(isValidTimeZone(tz)).toBe(true);
    }
  });

  it('maps well-known codes to the right zones', () => {
    expect(timeZonesForPhone('+12125550100')).toEqual(['America/New_York']);
    expect(timeZonesForPhone('+13125550100')).toEqual(['America/Chicago']);
    expect(timeZonesForPhone('+13035550100')).toEqual(['America/Denver']);
    expect(timeZonesForPhone('+16025550100')).toEqual(['America/Phoenix']);
    expect(timeZonesForPhone('+14155550100')).toEqual(['America/Los_Angeles']);
    expect(timeZonesForPhone('+19075550100')).toEqual(['America/Anchorage']);
    expect(timeZonesForPhone('+18085550100')).toEqual(['Pacific/Honolulu']);
    expect(timeZonesForPhone('+19155550100')).toEqual(['America/Denver']); // El Paso
    expect(timeZonesForPhone('+14165550100')).toEqual(['America/Toronto']);
  });

  it('keeps every zone of an area code that spans more than one', () => {
    expect(timeZonesForPhone('+18505550100')).toEqual(['America/New_York', 'America/Chicago']);
    expect(timeZonesForPhone('+16055550100')).toEqual(['America/Chicago', 'America/Denver']);
  });

  it('accepts stored formats and ignores non-NANP numbers', () => {
    expect(nanpAreaCode('14155550100')).toBe('415');
    expect(nanpAreaCode('+1 (415) 555-0100')).toBe('415');
    expect(nanpAreaCode('+442071234567')).toBeNull();
    expect(nanpAreaCode('4155550100')).toBeNull(); // no country code
    expect(timeZonesForPhone('+18765550100')).toBeNull(); // Jamaica — not covered
  });
});

describe('recipientTimeZones', () => {
  it("prefers the contact's own timezone", () => {
    expect(recipientTimeZones({ timezone: 'America/Chicago', phone: '+14155550100' }, 'America/New_York')).toEqual([
      'America/Chicago',
    ]);
  });

  it('infers from the area code before using the account default', () => {
    expect(recipientTimeZones({ timezone: null, phone: '+14155550100' }, 'America/New_York')).toEqual([
      'America/Los_Angeles',
    ]);
  });

  it('falls back to the account default', () => {
    expect(recipientTimeZones({ timezone: null, phone: '+447700900123' }, 'Europe/London')).toEqual(['Europe/London']);
  });
});

describe('quiet hours across candidate zones', () => {
  // 2026-07-15 12:30Z = 08:30 EDT, 07:30 CDT.
  const t = new Date('2026-07-15T12:30:00Z');

  it('is quiet when any candidate zone is still before 8am', () => {
    expect(isQuietHoursInAny(t, ['America/New_York'])).toBe(false);
    expect(isQuietHoursInAny(t, ['America/New_York', 'America/Chicago'])).toBe(true);
  });

  it('waits until it is allowed in every candidate zone', () => {
    expect(nextAllowedSendTimeInAll(t, ['America/New_York', 'America/Chicago']).toISOString()).toBe(
      '2026-07-15T13:00:00.000Z',
    );
  });

  it('stops sending at 9pm in the easternmost candidate', () => {
    // 01:30Z = 21:30 EDT / 20:30 CDT → quiet; next allowed is 08:00 CDT.
    const late = new Date('2026-07-16T01:30:00Z');
    expect(nextAllowedSendTimeInAll(late, ['America/New_York', 'America/Chicago']).toISOString()).toBe(
      '2026-07-16T13:00:00.000Z',
    );
  });
});

describe('planSmsBroadcast with area codes', () => {
  it('defers a Pacific number when the account default is Eastern', () => {
    const now = new Date('2026-07-15T13:00:00Z'); // 09:00 ET, 06:00 PT
    const plan = planSmsBroadcast(
      [
        { id: 'ny', name: 'N', timezone: null, phone: '+12125550100' },
        { id: 'sf', name: 'S', timezone: null, phone: '+14155550100' },
      ],
      'Sale',
      { default_timezone: 'America/New_York', quiet_hours_start: 21, quiet_hours_end: 8, cost_per_segment: 0.01 },
      now,
    );
    expect(plan.deferred).toBe(1);
    expect(plan.recipients.find((r) => r.contactId === 'sf')!.scheduledFor).toBe('2026-07-15T15:00:00.000Z');
  });
});
