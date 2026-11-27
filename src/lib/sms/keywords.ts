// ============================================================
// Inbound SMS compliance keywords (CTIA + TCPA / FCC 2025 rules).
//
// Opt-out must be honoured for the standard keywords, and the FCC's
// 2025 revocation rule adds "revoke" and "opt out" to the list of words
// that, sent on their own, are a revocation. We match:
//
//   1. The whole message, after normalization, equal to a keyword
//      ("STOP", "stop.", " Unsubscribe! ", "opt-out").
//   2. A short message (≤ 3 words) that CONTAINS an unambiguous
//      opt-out word ("Stop please", "please stop", "unsubscribe me").
//      Deliberately not CANCEL / END / QUIT: "Cancel my order" is a
//      customer-service request, and treating it as an opt-out would
//      also block the agent from answering it by SMS.
//
// A missed opt-out is a TCPA violation; a false one costs a marketing
// contact. The rules lean accordingly.
// ============================================================

export type SmsKeywordIntent = 'opt_out' | 'opt_in' | 'help';

export const OPT_OUT_KEYWORDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
  'OPT OUT',
] as const;

export const OPT_IN_KEYWORDS = ['START', 'UNSTOP'] as const;

export const HELP_KEYWORDS = ['HELP', 'INFO'] as const;

/** Opt-out words specific enough to count anywhere in a short reply. */
const SHORT_REPLY_OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'OPTOUT', 'REVOKE']);
const MAX_WORDS_FOR_SHORT_MATCH = 3;

const OPT_OUT = new Set<string>(OPT_OUT_KEYWORDS);
const OPT_IN = new Set<string>(OPT_IN_KEYWORDS);
const HELP = new Set<string>(HELP_KEYWORDS);

/**
 * Upper-case, fold compatibility forms (full-width letters), turn
 * hyphens/underscores into spaces, drop everything that isn't a letter,
 * digit or space (punctuation, emoji), and collapse whitespace.
 */
export function normalizeKeywordText(body: string): string {
  return (body ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[-_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The provider's own keyword classification, when it sends one. Twilio's
 * Advanced Opt-Out adds `OptOutType` = STOP | START | HELP to the inbound
 * webhook — including for custom keywords the customer configured in
 * Twilio — so it wins over our own matching.
 */
export function intentFromProviderHint(hint: string | null | undefined): SmsKeywordIntent | null {
  switch ((hint ?? '').trim().toUpperCase()) {
    case 'STOP':
      return 'opt_out';
    case 'START':
      return 'opt_in';
    case 'HELP':
      return 'help';
    default:
      return null;
  }
}

export function classifySmsKeyword(
  body: string,
  providerHint?: string | null,
): SmsKeywordIntent | null {
  const hinted = intentFromProviderHint(providerHint);
  if (hinted) return hinted;

  const text = normalizeKeywordText(body);
  if (!text) return null;

  if (OPT_OUT.has(text)) return 'opt_out';
  if (OPT_IN.has(text)) return 'opt_in';
  if (HELP.has(text)) return 'help';

  const words = text.split(' ');
  if (words.length <= MAX_WORDS_FOR_SHORT_MATCH) {
    if (words.some((w) => SHORT_REPLY_OPT_OUT_WORDS.has(w))) return 'opt_out';
    if (/\bOPT OUT\b/.test(text)) return 'opt_out';
  }
  return null;
}
