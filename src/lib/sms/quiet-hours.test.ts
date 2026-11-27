import { describe, expect, it } from 'vitest';

import {
  isQuietHours,
  isValidTimeZone,
  localMinuteOfDay,
  nextAllowedSendTime,
  resolveTimeZone,
} from './quiet-hours';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

describe('timezone resolution', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it('prefers the contact, then the account, then Eastern', () => {
    expect(resolveTimeZone(LA, NY)).toBe(LA);
    expect(resolveTimeZone('bogus', 'America/Denver')).toBe('America/Denver');
    expect(resolveTimeZone(null, 'bogus')).toBe(NY);
  });
});

describe('isQuietHours (default 21:00–08:00)', () => {
  // 2026-07-15 is EDT (UTC-4) / PDT (UTC-7).
  it('is quiet at 22:00 and 07:59 local, not at 08:00 or 20:59', () => {
    expect(isQuietHours(new Date('2026-07-16T02:00:00Z'), NY)).toBe(true); // 22:00 EDT
    expect(isQuietHours(new Date('2026-07-15T11:59:00Z'), NY)).toBe(true); // 07:59
    expect(isQuietHours(new Date('2026-07-15T12:00:00Z'), NY)).toBe(false); // 08:00
    expect(isQuietHours(new Date('2026-07-16T00:59:00Z'), NY)).toBe(false); // 20:59
    expect(isQuietHours(new Date('2026-07-16T01:00:00Z'), NY)).toBe(true); // 21:00
  });

  it('judges by the recipient timezone, not the sender', () => {
    const t = new Date('2026-07-15T13:00:00Z'); // 09:00 New York, 06:00 Los Angeles
    expect(isQuietHours(t, NY)).toBe(false);
    expect(isQuietHours(t, LA)).toBe(true);
  });

  it('supports a non-wrapping window and an empty one', () => {
    const t = new Date('2026-07-15T07:00:00Z'); // 03:00 EDT
    expect(isQuietHours(t, NY, { start: 0, end: 6 })).toBe(true);
    expect(isQuietHours(t, NY, { start: 4, end: 6 })).toBe(false);
    expect(isQuietHours(t, NY, { start: 8, end: 8 })).toBe(false);
  });

  it('falls back to the default window for out-of-range hours', () => {
    const t = new Date('2026-07-16T02:00:00Z'); // 22:00 EDT
    expect(isQuietHours(t, NY, { start: 99, end: -1 })).toBe(true);
  });
});

describe('nextAllowedSendTime', () => {
  it('returns the same instant outside quiet hours', () => {
    const t = new Date('2026-07-15T15:30:12Z');
    expect(nextAllowedSendTime(t, NY).getTime()).toBe(t.getTime());
  });

  it('defers a late-evening send to 08:00 the next morning', () => {
    const t = new Date('2026-07-16T02:17:45Z'); // 22:17:45 EDT on the 15th
    expect(nextAllowedSendTime(t, NY).toISOString()).toBe('2026-07-16T12:00:00.000Z');
  });

  it('defers an early-morning send to 08:00 the same day', () => {
    const t = new Date('2026-07-15T09:30:00Z'); // 05:30 EDT
    expect(nextAllowedSendTime(t, NY).toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('uses the recipient zone for the target time', () => {
    const t = new Date('2026-07-15T13:00:00Z'); // 06:00 PDT
    expect(nextAllowedSendTime(t, LA).toISOString()).toBe('2026-07-15T15:00:00.000Z');
  });

  it('lands on local 08:00 across a DST change overnight', () => {
    // US DST starts 2026-03-08 at 02:00 local. 22:00 EST on the 7th
    // (UTC-5) → 08:00 EDT on the 8th (UTC-4) = 12:00Z.
    const t = new Date('2026-03-08T03:00:00Z');
    const next = nextAllowedSendTime(t, NY);
    expect(next.toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(localMinuteOfDay(next, NY)).toBe(8 * 60);
  });

  it('honours a custom window end', () => {
    const t = new Date('2026-07-16T01:30:00Z'); // 21:30 EDT
    expect(nextAllowedSendTime(t, NY, { start: 20, end: 9 }).toISOString()).toBe(
      '2026-07-16T13:00:00.000Z',
    );
  });
});

describe('nextAllowedSendTime across the autumn DST change', () => {
  it('lands on local 08:00 when clocks fall back overnight', () => {
    // US DST ends 2026-11-01 at 02:00 local. 22:00 EDT on Oct 31 (UTC-4)
    // → 08:00 EST on Nov 1 (UTC-5) = 13:00Z.
    const next = nextAllowedSendTime(new Date('2026-11-01T02:00:00Z'), NY);
    expect(next.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });
});
