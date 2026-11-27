// ============================================================
// SMS broadcast body composition + per-contact merge tags.
//
// Merge tags: {{first_name}}, {{last_name}}, {{name}}, {{company}},
// each with an optional fallback after a pipe: {{first_name|there}}.
// Unknown tags are left as typed, so a typo is visible in the preview
// rather than silently sent as an empty string.
//
// CTIA expects every marketing message to identify the sender and to
// say how to opt out; `composeSmsBroadcastBody` adds both when asked
// (the wizard asks by default).
// ============================================================

import type { Contact } from '@/types';

export const SMS_MERGE_TAGS = ['first_name', 'last_name', 'name', 'company'] as const;
export type SmsMergeTag = (typeof SMS_MERGE_TAGS)[number];

export const DEFAULT_OPT_OUT_SUFFIX = 'Reply STOP to opt out.';

const TAG_RE = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi;

type MergeContact = Pick<Contact, 'name' | 'company'>;

function splitName(name: string | null | undefined): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function tagValue(tag: SmsMergeTag, contact: MergeContact): string {
  const { first, last } = splitName(contact.name);
  switch (tag) {
    case 'first_name':
      return first;
    case 'last_name':
      return last;
    case 'name':
      return (contact.name ?? '').trim();
    case 'company':
      return (contact.company ?? '').trim();
  }
}

function isMergeTag(tag: string): tag is SmsMergeTag {
  return (SMS_MERGE_TAGS as readonly string[]).includes(tag);
}

/** Replace merge tags with the contact's values (or the tag's fallback). */
export function renderSmsBody(body: string, contact: MergeContact): string {
  return (body ?? '').replace(TAG_RE, (whole, rawTag: string, fallback?: string) => {
    const tag = rawTag.toLowerCase();
    if (!isMergeTag(tag)) return whole;
    const value = tagValue(tag, contact);
    return value || (fallback ?? '').trim();
  });
}

/** Merge tags used in `body` that this renderer doesn't know. */
export function unknownMergeTags(body: string): string[] {
  const unknown = new Set<string>();
  for (const match of (body ?? '').matchAll(TAG_RE)) {
    const tag = match[1].toLowerCase();
    if (!isMergeTag(tag)) unknown.add(match[1]);
  }
  return [...unknown];
}

/** True when the text already tells the recipient how to opt out. */
export function hasOptOutLanguage(text: string): boolean {
  return /\b(STOP|UNSUBSCRIBE|OPT[\s-]?OUT)\b/i.test(text ?? '');
}

export interface ComposeOptions {
  brandName?: string | null;
  /** Prefix "Brand: " unless the body already starts with the brand. */
  prefixBrand?: boolean;
  /** Append the opt-out line unless the body already has one. */
  appendOptOut?: boolean;
  optOutSuffix?: string;
}

/** The broadcast body as it will be sent, before merge tags. */
export function composeSmsBroadcastBody(body: string, opts: ComposeOptions = {}): string {
  let text = (body ?? '').trim();
  const brand = (opts.brandName ?? '').trim();
  if (opts.prefixBrand && brand && !text.toLowerCase().startsWith(brand.toLowerCase())) {
    text = `${brand}: ${text}`;
  }
  if (opts.appendOptOut && !hasOptOutLanguage(text)) {
    text = `${text}\n${(opts.optOutSuffix ?? DEFAULT_OPT_OUT_SUFFIX).trim()}`;
  }
  return text;
}
