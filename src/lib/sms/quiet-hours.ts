// ============================================================
// SMS quiet hours.
//
// TCPA bars telemarketing texts before 8am and after 9pm in the
// recipient's local time (several states are stricter — the window is
// configurable per account for that reason). "Local time" is the
// contact's own timezone when we know it, else the account's default.
//
// The window may wrap midnight (21 → 8) or not (e.g. 0 → 6); start ===
// end means "no quiet hours". All arithmetic is done through Intl, so
// DST transitions resolve against the real tz database.
// ============================================================

export const DEFAULT_SMS_TIMEZONE = 'America/New_York';
export const DEFAULT_QUIET_HOURS_START = 21;
export const DEFAULT_QUIET_HOURS_END = 8;

export interface QuietHoursWindow {
  /** Local hour (0–23) quiet hours begin. */
  start: number;
  /** Local hour (0–23) sending is allowed again. */
  end: number;
}

const validityCache = new Map<string, boolean>();

/** True for a timezone name Intl recognises (IANA, e.g. "America/Chicago"). */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  const cached = validityCache.get(tz);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  validityCache.set(tz, ok);
  return ok;
}

/** Contact tz when valid, else the account default when valid, else ET. */
export function resolveTimeZone(
  contactTz: string | null | undefined,
  accountTz: string | null | undefined,
): string {
  if (isValidTimeZone(contactTz)) return contactTz;
  if (isValidTimeZone(accountTz)) return accountTz;
  return DEFAULT_SMS_TIMEZONE;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Minutes since local midnight of `date` in `tz`. */
export function localMinuteOfDay(date: Date, tz: string): number {
  const parts = formatterFor(tz).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function normalizeWindow(window?: Partial<QuietHoursWindow>): QuietHoursWindow {
  const clamp = (n: unknown, fallback: number) => {
    const v = Number(n);
    return Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  };
  return {
    start: clamp(window?.start, DEFAULT_QUIET_HOURS_START),
    end: clamp(window?.end, DEFAULT_QUIET_HOURS_END),
  };
}

/** True when `date` falls inside the quiet window in `tz`. */
export function isQuietHours(
  date: Date,
  tz: string,
  window?: Partial<QuietHoursWindow>,
): boolean {
  const { start, end } = normalizeWindow(window);
  if (start === end) return false;
  const m = localMinuteOfDay(date, tz);
  const s = start * 60;
  const e = end * 60;
  return start > end ? m >= s || m < e : m >= s && m < e;
}

/**
 * The earliest instant at or after `date` that is outside quiet hours in
 * `tz` — `date` itself when it already is, else the next local `end:00`
 * (corrected for a DST change in between).
 */
export function nextAllowedSendTime(
  date: Date,
  tz: string,
  window?: Partial<QuietHoursWindow>,
): Date {
  const w = normalizeWindow(window);
  if (!isQuietHours(date, tz, w)) return date;

  const m = localMinuteOfDay(date, tz);
  const delta = (w.end * 60 - m + 1440) % 1440;
  const floorToMinute =
    date.getTime() - date.getUTCSeconds() * 1000 - date.getUTCMilliseconds();
  let candidate = new Date(floorToMinute + delta * 60_000);

  // `delta` assumed today's UTC offset. If a DST change falls between
  // now and the target, the candidate is an hour off local `end:00` —
  // correct it against the candidate's real local time.
  let drift = localMinuteOfDay(candidate, tz) - w.end * 60;
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;
  if (drift !== 0) candidate = new Date(candidate.getTime() - drift * 60_000);

  // A local time that doesn't exist (skipped by DST) can still leave us
  // inside the window; step forward until we're out of it.
  for (let i = 0; i < 12 && isQuietHours(candidate, tz, w); i++) {
    candidate = new Date(candidate.getTime() + 15 * 60_000);
  }
  return candidate;
}
