'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Clock, Loader2, MessageSquareText, Send, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { SmsComposeValue } from './sms-compose-step';

export interface SmsPreview {
  audience_total: number;
  eligible: number;
  excluded_no_consent: number;
  excluded_opted_out: number;
  excluded_invalid_phone: number;
  deferred_quiet_hours: number;
  total_segments: number;
  max_segments_per_message: number;
  encoding: 'GSM-7' | 'UCS-2';
  estimated_cost: number;
  cost_per_segment: number;
  cost_currency: string;
  quiet_hours: { start: number; end: number; timezone: string };
  composed_body: string;
  sample_body: string;
}

interface Props {
  name: string;
  onNameChange: (name: string) => void;
  compose: SmsComposeValue;
  audience: AudienceConfig;
  onSend: () => void;
  onBack: () => void;
  isSending: boolean;
}

export function smsRequestBody(compose: SmsComposeValue, audience: AudienceConfig) {
  return {
    body: compose.body,
    prefix_brand: compose.prefixBrand,
    append_opt_out: compose.appendOptOut,
    audience,
  };
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount);
  } catch {
    return `${amount.toFixed(4)} ${currency}`;
  }
}

export function SmsReviewStep({ name, onNameChange, compose, audience, onSend, onBack, isSending }: Props) {
  const t = useTranslations('Broadcasts.sms');
  const [preview, setPreview] = useState<SmsPreview | null>(null);
  // `failed` with no server message falls back to a translated default
  // at render, so the fetch effect doesn't depend on `t`.
  const [failure, setFailure] = useState<{ message: string | null } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPreview(null);
      setFailure(null);
      try {
        const res = await fetch('/api/sms/broadcasts/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(smsRequestBody(compose, audience)),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setFailure({ message: typeof data.error === 'string' ? data.error : null });
        else setPreview(data as SmsPreview);
      } catch {
        if (!cancelled) setFailure({ message: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compose, audience]);

  const error = failure ? (failure.message ?? t('previewFailed')) : null;

  const canSend = Boolean(name.trim()) && !!preview && preview.eligible > 0 && !isSending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('reviewTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('reviewSubtitle')}</p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {!preview && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('previewLoading')}
        </div>
      )}

      {preview && (
        <>
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/50 p-4 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">{t('recipients')}</p>
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <Users className="h-3.5 w-3.5 text-primary" />
                {preview.eligible.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('segments')}</p>
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <MessageSquareText className="h-3.5 w-3.5 text-primary" />
                {preview.total_segments.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('estimatedCost')}</p>
              <p className="font-medium text-foreground">
                {formatMoney(preview.estimated_cost, preview.cost_currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('encoding')}</p>
              <p className="font-medium text-foreground">
                {t('encodingValue', {
                  encoding: preview.encoding,
                  segments: preview.max_segments_per_message,
                })}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('costFootnote', { rate: formatMoney(preview.cost_per_segment, preview.cost_currency) })}
          </p>

          {(preview.excluded_no_consent > 0 ||
            preview.excluded_opted_out > 0 ||
            preview.excluded_invalid_phone > 0) && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                {t('excludedTitle', { total: preview.audience_total })}
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {preview.excluded_no_consent > 0 && (
                  <li>{t('excludedNoConsent', { count: preview.excluded_no_consent })}</li>
                )}
                {preview.excluded_opted_out > 0 && (
                  <li>{t('excludedOptedOut', { count: preview.excluded_opted_out })}</li>
                )}
                {preview.excluded_invalid_phone > 0 && (
                  <li>{t('excludedInvalidPhone', { count: preview.excluded_invalid_phone })}</li>
                )}
              </ul>
            </div>
          )}

          {preview.deferred_quiet_hours > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 text-sm text-muted-foreground">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
              <p>
                {t('deferredNote', {
                  count: preview.deferred_quiet_hours,
                  start: preview.quiet_hours.start,
                  end: preview.quiet_hours.end,
                })}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('sampleLabel')}</p>
            <div className="max-w-sm whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-3 text-sm text-foreground">
              {preview.sample_body}
            </div>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} disabled={isSending} className="border-border text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!canSend}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t('sendNow')}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('confirmTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {preview
                ? t('confirmDesc', {
                    count: preview.eligible,
                    cost: formatMoney(preview.estimated_cost, preview.cost_currency),
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} className="border-border text-muted-foreground">
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                onSend();
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Send className="h-4 w-4" />
              {t('sendNow')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
