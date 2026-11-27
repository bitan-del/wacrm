'use client';

import { useMemo, useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { composeSmsBroadcastBody, renderSmsBody, SMS_MERGE_TAGS, unknownMergeTags } from '@/lib/sms/render';
import { countSmsSegments } from '@/lib/sms/segments';
import { SMS_MAX_BODY_CHARS } from '@/lib/sms/limits';

export interface SmsComposeValue {
  body: string;
  prefixBrand: boolean;
  appendOptOut: boolean;
}

interface Props {
  value: SmsComposeValue;
  onChange: (value: SmsComposeValue) => void;
  brandName: string | null;
  onNext: () => void;
  onBack: () => void;
}

/** A sample contact so the preview shows merge tags filled in. */
const SAMPLE_CONTACT = { name: 'Alex Rivera', company: 'Acme Co' };

export function SmsComposeStep({ value, onChange, brandName, onNext, onBack }: Props) {
  const t = useTranslations('Broadcasts.sms');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const composed = useMemo(
    () =>
      composeSmsBroadcastBody(value.body, {
        brandName,
        prefixBrand: value.prefixBrand,
        appendOptOut: value.appendOptOut,
      }),
    [value, brandName],
  );
  const preview = useMemo(() => renderSmsBody(composed, SAMPLE_CONTACT), [composed]);
  const segments = useMemo(() => countSmsSegments(preview), [preview]);
  const unknown = useMemo(() => unknownMergeTags(value.body), [value.body]);
  const tooLong = composed.length > SMS_MAX_BODY_CHARS;
  const canContinue = value.body.trim().length > 0 && unknown.length === 0 && !tooLong;

  const insertTag = (tag: string) => {
    const token = `{{${tag}}}`;
    const el = textareaRef.current;
    if (!el) {
      onChange({ ...value, body: value.body + token });
      return;
    }
    const start = el.selectionStart ?? value.body.length;
    const end = el.selectionEnd ?? value.body.length;
    const next = value.body.slice(0, start) + token + value.body.slice(end);
    onChange({ ...value, body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('composeTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('composeSubtitle')}</p>
      </div>

      <div className="space-y-2">
        <textarea
          ref={textareaRef}
          value={value.body}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          rows={6}
          placeholder={t('composePlaceholder')}
          className="w-full resize-y rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('insertTag')}</span>
          {SMS_MERGE_TAGS.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => insertTag(tag)}
              className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs text-foreground hover:border-primary/50"
            >
              {tag}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('fallbackHint', { example: '{{first_name|there}}' })}</p>
        {unknown.length > 0 && (
          <p className="text-xs text-red-400">{t('unknownTags', { tags: unknown.join(', ') })}</p>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <div className="flex items-start gap-2">
          <Checkbox
            id="sms-prefix-brand"
            checked={value.prefixBrand}
            onCheckedChange={(v) => onChange({ ...value, prefixBrand: Boolean(v) })}
            disabled={!brandName}
          />
          <Label htmlFor="sms-prefix-brand" className="text-sm font-normal leading-snug">
            {brandName ? t('prefixBrand', { brand: brandName }) : t('prefixBrandMissing')}
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="sms-append-optout"
            checked={value.appendOptOut}
            onCheckedChange={(v) => onChange({ ...value, appendOptOut: Boolean(v) })}
          />
          <Label htmlFor="sms-append-optout" className="text-sm font-normal leading-snug">
            {t('appendOptOut')}
          </Label>
        </div>
        {!value.appendOptOut && <p className="text-xs text-amber-500">{t('optOutWarning')}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('previewLabel')}</p>
        <div className="max-w-sm whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm text-foreground">
          {preview || <span className="text-muted-foreground">{t('previewEmpty')}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('segmentCounter', {
            segments: segments.segments,
            encoding: segments.encoding,
            units: segments.units,
            remaining: segments.remainingInSegment,
          })}
        </p>
        {segments.encoding === 'UCS-2' && (
          <p className="text-xs text-amber-500">
            {t('unicodeWarning', { chars: segments.nonGsmCharacters.slice(0, 8).join(' ') })}
          </p>
        )}
        {tooLong && <p className="text-xs text-red-400">{t('tooLong', { max: SMS_MAX_BODY_CHARS })}</p>}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button onClick={onNext} disabled={!canContinue} className="bg-primary text-primary-foreground">
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
