'use client';

// Bulk SMS consent for the contacts list's selection: record opt-in
// (with how consent was captured) or mark opted out. Goes through
// POST /api/sms/consent, so a contact who texted STOP is skipped on
// opt-in — the toast reports how many.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageSquareText } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GatedButton } from '@/components/ui/gated-button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { STAFF_OPT_IN_SOURCES } from '@/lib/sms/consent';
import type { SmsOptInSource } from '@/types';

const CHUNK = 1000;

interface Props {
  contactIds: string[];
  canAct: boolean;
  onDone: () => void;
}

export function BulkSmsConsent({ contactIds, canAct, onDone }: Props) {
  const t = useTranslations('Contacts.smsConsent');
  const tGate = useTranslations('GatedButton');
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'opt_in' | 'opt_out'>('opt_in');
  const [source, setSource] = useState<SmsOptInSource>('web_form');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    let updated = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < contactIds.length; i += CHUNK) {
        const res = await fetch('/api/sms/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_ids: contactIds.slice(i, i + CHUNK), action, source }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('saveFailed'));
          return;
        }
        updated += Number(data.updated) || 0;
        skipped += Array.isArray(data.skipped) ? data.skipped.length : 0;
      }
      toast.success(t('bulkDone', { updated, skipped }));
      setOpen(false);
      setAttested(false);
      onDone();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <GatedButton
        variant="outline"
        size="sm"
        canAct={canAct}
        gateReason={tGate('reasons.sendMessages')}
        onClick={() => setOpen(true)}
      >
        <MessageSquareText className="size-4" />
        {t('bulkButton')}
      </GatedButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('bulkTitle', { count: contactIds.length })}</DialogTitle>
            <DialogDescription>{t('bulkDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {(['opt_in', 'opt_out'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAction(a)}
                  className={
                    'rounded-lg border px-3 py-2 text-sm transition-colors ' +
                    (action === a
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/40')
                  }
                >
                  {a === 'opt_in' ? t('recordOptIn') : t('markOptedOut')}
                </button>
              ))}
            </div>

            {action === 'opt_in' && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('sourceLabel')}</Label>
                  <Select value={source} onValueChange={(v) => setSource(v as SmsOptInSource)}>
                    <SelectTrigger>
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
                <div className="flex items-start gap-2">
                  <Checkbox id="bulk-sms-attest" checked={attested} onCheckedChange={(v) => setAttested(Boolean(v))} />
                  <Label htmlFor="bulk-sms-attest" className="text-xs font-normal leading-snug text-muted-foreground">
                    {t('optInAttestation')}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">{t('bulkStopNote')}</p>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={busy || (action === 'opt_in' && !attested)}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
