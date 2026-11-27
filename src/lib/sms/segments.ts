// ============================================================
// SMS segment counting + cost estimate.
//
// Carriers bill per *segment*, not per message. A message that fits the
// GSM-7 alphabet carries 160 characters in one segment, or 153 per
// segment once it has to be split (the other 7 septets hold the
// concatenation header). A single character outside GSM-7 — an emoji, a
// curly quote, most non-Latin scripts — switches the WHOLE message to
// UCS-2: 70 per single segment, 67 per part.
//
// Two details that naive `length / 153` counters get wrong:
//   - The GSM-7 extension table (€ [ ] { } ^ ~ | \ and form feed) costs
//     two septets each (escape + char), and an escape pair is never split
//     across a segment boundary.
//   - In UCS-2 a character outside the BMP (most emoji) is a surrogate
//     pair — two code units — and is likewise never split.
// Both are handled by packing characters into segments one at a time.
// ============================================================

/** GSM 03.38 basic character set (one septet each). */
const GSM7_BASIC = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
      '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);

/** GSM 03.38 extension table (escape + char = two septets each). */
const GSM7_EXTENDED = new Set(Array.from('\f^{}\\[~]|€'));

export const GSM7_SINGLE_SEGMENT = 160;
export const GSM7_MULTI_SEGMENT = 153;
export const UCS2_SINGLE_SEGMENT = 70;
export const UCS2_MULTI_SEGMENT = 67;

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** Billable segments. 0 for an empty message. */
  segments: number;
  /** Encoded length: septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  /** Units one segment holds at this length (160/153 or 70/67). */
  perSegment: number;
  /** Units left before the next segment starts. */
  remainingInSegment: number;
  /** Distinct characters that forced UCS-2 (empty for GSM-7). */
  nonGsmCharacters: string[];
}

function isGsm7Char(ch: string): boolean {
  return GSM7_BASIC.has(ch) || GSM7_EXTENDED.has(ch);
}

/** True when every character of `text` is in the GSM-7 alphabet. */
export function isGsm7(text: string): boolean {
  for (const ch of text) if (!isGsm7Char(ch)) return false;
  return true;
}

/**
 * Pack `widths` (one entry per indivisible character) into segments of
 * `single` units, or of `multi` units when it doesn't fit in one.
 * Returns the segment count and the units used in the last segment.
 */
function pack(
  widths: number[],
  single: number,
  multi: number,
): { segments: number; lastUsed: number; total: number } {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total === 0) return { segments: 0, lastUsed: 0, total };
  if (total <= single) return { segments: 1, lastUsed: total, total };

  let segments = 1;
  let used = 0;
  for (const w of widths) {
    if (used + w > multi) {
      segments++;
      used = 0;
    }
    used += w;
  }
  return { segments, lastUsed: used, total };
}

export function countSmsSegments(text: string): SmsSegmentInfo {
  const chars = Array.from(text ?? '');
  const nonGsm = [...new Set(chars.filter((ch) => !isGsm7Char(ch)))];

  if (nonGsm.length === 0) {
    const widths = chars.map((ch) => (GSM7_EXTENDED.has(ch) ? 2 : 1));
    const { segments, lastUsed, total } = pack(
      widths,
      GSM7_SINGLE_SEGMENT,
      GSM7_MULTI_SEGMENT,
    );
    const perSegment = segments > 1 ? GSM7_MULTI_SEGMENT : GSM7_SINGLE_SEGMENT;
    return {
      encoding: 'GSM-7',
      segments,
      units: total,
      perSegment,
      remainingInSegment: segments === 0 ? perSegment : perSegment - lastUsed,
      nonGsmCharacters: [],
    };
  }

  // UCS-2: width is the UTF-16 length of each code point (1 or 2).
  const widths = chars.map((ch) => ch.length);
  const { segments, lastUsed, total } = pack(
    widths,
    UCS2_SINGLE_SEGMENT,
    UCS2_MULTI_SEGMENT,
  );
  const perSegment = segments > 1 ? UCS2_MULTI_SEGMENT : UCS2_SINGLE_SEGMENT;
  return {
    encoding: 'UCS-2',
    segments,
    units: total,
    perSegment,
    remainingInSegment: perSegment - lastUsed,
    nonGsmCharacters: nonGsm,
  };
}

/**
 * Estimated provider cost for `segments` segments at `costPerSegment`.
 * Rounded to 4 decimals so float noise never shows up in the UI. This
 * is an estimate: carrier pass-through fees (10DLC, toll-free) are billed
 * on top by the provider and vary by carrier.
 */
export function estimateSmsCost(segments: number, costPerSegment: number): number {
  if (!Number.isFinite(segments) || !Number.isFinite(costPerSegment)) return 0;
  if (segments <= 0 || costPerSegment <= 0) return 0;
  return Math.round(segments * costPerSegment * 10_000) / 10_000;
}
