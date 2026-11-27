'use client';

// SMS consent for one contact (migration 063): current state, how and
// when it was given / revoked, the contact's timezone for quiet hours,
// and actions to record consent captured elsewhere or a manual opt-out.
// Writes go through POST /api/sms/consent → `apply_sms_consent`, which
// refuses to re-opt-in someone who texted STOP (they must text START).

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageSquareText } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GatedButton } from '@/components/ui/gated-button';
import { useCan } from '@/hooks/use-can';
import { createClient } from '@/lib/supabase/client';
import { STAFF_OPT_IN_SOURCES } from '@/lib/sms/consent';
import { isValidTimeZone } from '@/lib/sms/quiet-hours';
import type { Contact, SmsOptInSource } from '@/types';

interface Props {
  contact: Contact;
  onChanged: () => void;
}

export function SmsConsentCard({ contact, onChanged }: Props) {
  const t = useTranslations('Contacts.smsConsent');
  const tGate = useTranslations('GatedButton');
  const locale = useLocale();
  const canEdit = useCan('send-messages');

  const [source, setSource] = useState<SmsOptInSource>('web_form');
  const [busy, setBusy] = useState<'opt_in' | 'opt_out' | 'tz' | null>(null);
  const [timezone, setTimezone] = useState(contact.timezone ?? '');

  const optedOut = Boolean(contact.sms_opted_out_at);
  const optedIn = Boolean(contact.sms_opted_in_at) && !optedOut;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const apply = async (action: 'opt_in' | 'opt_out') => {
    setBusy(action);
    try {
      const res = await fetch('/api/sms/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: [contact.id], action, source }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      if (Array.isArray(data.skipped) && data.skipped.length > 0 && action === 'opt_in') {
        toast.error(t('reoptInBlocked'));
        return;
      }
      toast.success(action === 'opt_in' ? t('optedInToast') : t('optedOutToast'));
      onChanged();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const saveTimezone = async () => {
    const next = timezone.trim();
    if (next && !isValidTimeZone(next)) {
      toast.error(t('timezoneInvalid'));
      return;
    }
    setBusy('tz');
    const { error } = await createClient()
      .from('contacts')
      .update({ timezone: next || null })
      .eq('id', contact.id);
    setBusy(null);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('timezoneSaved'));
    onChanged();
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-4 text-primary" />
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <span
          className={
            'ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ' +
            (optedOut
              ? 'border-red-500/30 bg-red-500/10 text-red-400'
              : optedIn
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border bg-muted text-muted-foreground')
          }
        >
          {optedOut ? t('statusOptedOut') : optedIn ? t('statusOptedIn') : t('statusNone')}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {optedOut && contact.sms_opted_out_at
          ? t('optedOutDetail', {
              date: fmt(contact.sms_opted_out_at),
              source: t(`outSources.${contact.sms_opt_out_source ?? 'other'}`),
            })
          : optedIn && contact.sms_opted_in_at
            ? t('optedInDetail', {
                date: fmt(contact.sms_opted_in_at),
                source: t(`inSources.${contact.sms_opt_in_source ?? 'other'}`),
              })
            : t('noneDetail')}
      </p>

      {!optedIn && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Label className="text-xs text-muted-foreground">{t('sourceLabel')}</Label>
            <Select value={source} onValueChange={(v) => setSource(v as SmsOptInSource)} disabled={!canEdit}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAFF_OPT_IN_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`inSources.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <GatedButton
            size="sm"
            canAct={canEdit}
            gateReason={tGate('reasons.sendMessages')}
            disabled={busy !== null}
            onClick={() => void apply('opt_in')}
          >
            {busy === 'opt_in' && <Loader2 className="size-3.5 animate-spin" />}
            {t('recordOptIn')}
          </GatedButton>
        </div>
      )}
      {!optedIn && <p className="text-[11px] text-muted-foreground">{t('optInAttestation')}</p>}

      {!optedOut && (
        <GatedButton
          variant="outline"
          size="sm"
          canAct={canEdit}
          gateReason={tGate('reasons.sendMessages')}
          disabled={busy !== null}
          onClick={() => void apply('opt_out')}
          className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10"
        >
          {busy === 'opt_out' && <Loader2 className="size-3.5 animate-spin" />}
          {t('markOptedOut')}
        </GatedButton>
      )}

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t('timezoneLabel')}</Label>
        <div className="flex gap-2">
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder={t('timezonePlaceholder')}
            className="h-8 border-border bg-muted text-sm text-foreground"
            disabled={!canEdit}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit || busy !== null || timezone.trim() === (contact.timezone ?? '')}
            onClick={() => void saveTimezone()}
          >
            {busy === 'tz' && <Loader2 className="size-3.5 animate-spin" />}
            {t('save')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('timezoneHint')}</p>
      </div>
    </div>
  );
}
