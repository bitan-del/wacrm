'use client';

// ============================================================
// SmsConfig — Settings → SMS (admin-only)
//
// Connects the workspace's own SMS provider account (Twilio first).
// Each workspace brings its own credentials AND its own carrier
// registration (A2P 10DLC brand + campaign, or toll-free verification)
// — the platform never sends on another tenant's registration. The
// auth token is verified with the provider and stored encrypted; it is
// never sent back to the browser.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Eye, EyeOff, Loader2, MessageSquareText, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { invalidateSmsStatus } from '@/hooks/use-sms-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED = '••••••••••••••••';

const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Seoul',
];

const REGISTRATION_TYPES = ['10dlc', 'toll_free', 'short_code', 'other'] as const;
type RegistrationType = (typeof REGISTRATION_TYPES)[number];
const NO_REGISTRATION = '__none__';

interface WebhookUrls {
  inbound: string;
  status: string;
}

export function SmsConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.smsConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [configured, setConfigured] = useState(false);

  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [messagingServiceSid, setMessagingServiceSid] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [brandName, setBrandName] = useState('');
  const [helpReply, setHelpReply] = useState('');
  const [optOutReply, setOptOutReply] = useState('');
  const [optInReply, setOptInReply] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(8);
  const [costPerSegment, setCostPerSegment] = useState('0.0083');
  const [currency, setCurrency] = useState('USD');
  const [registrationType, setRegistrationType] = useState<RegistrationType | ''>('');
  const [registrationRef, setRegistrationRef] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [webhookUrls, setWebhookUrls] = useState<WebhookUrls | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const apply = useCallback((data: Record<string, unknown>) => {
    if (!data.configured) {
      setConfigured(false);
      setWebhookUrls(null);
      return;
    }
    setConfigured(true);
    setAccountSid(String(data.account_sid ?? ''));
    setHasStoredToken(Boolean(data.has_auth_token));
    setAuthToken(data.has_auth_token ? MASKED : '');
    setTokenEdited(false);
    setMessagingServiceSid(String(data.messaging_service_sid ?? ''));
    setFromNumber(String(data.from_number ?? ''));
    setBrandName(String(data.brand_name ?? ''));
    setHelpReply(String(data.help_reply_text ?? ''));
    setOptOutReply(String(data.opt_out_reply_text ?? ''));
    setOptInReply(String(data.opt_in_reply_text ?? ''));
    setTimezone(String(data.default_timezone ?? 'America/New_York'));
    setQuietStart(Number(data.quiet_hours_start ?? 21));
    setQuietEnd(Number(data.quiet_hours_end ?? 8));
    setCostPerSegment(String(data.cost_per_segment ?? '0.0083'));
    setCurrency(String(data.cost_currency ?? 'USD'));
    setRegistrationType((data.registration_type as RegistrationType | null) ?? '');
    setRegistrationRef(String(data.registration_reference ?? ''));
    setIsActive(Boolean(data.is_active));
    setVerifiedAt((data.last_verified_at as string | null) ?? null);
    setWebhookUrls((data.webhook_urls as WebhookUrls | null) ?? null);
  }, []);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sms/config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      apply(data);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [apply, t]);

  useEffect(() => {
    if (!accountId || !canEdit || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, canEdit, fetchConfig]);

  const handleSave = async () => {
    if (!configured && !tokenEdited) {
      toast.error(t('missingToken'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/sms/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'twilio',
          account_sid: accountSid.trim(),
          auth_token: tokenEdited ? authToken.trim() : undefined,
          messaging_service_sid: messagingServiceSid.trim() || null,
          from_number: fromNumber.trim() || null,
          brand_name: brandName.trim() || null,
          help_reply_text: helpReply.trim() || null,
          opt_out_reply_text: optOutReply.trim() || null,
          opt_in_reply_text: optInReply.trim() || null,
          default_timezone: timezone.trim(),
          quiet_hours_start: quietStart,
          quiet_hours_end: quietEnd,
          cost_per_segment: Number(costPerSegment),
          cost_currency: currency.trim().toUpperCase(),
          registration_type: registrationType || null,
          registration_reference: registrationRef.trim() || null,
          is_active: isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      apply(data);
      invalidateSmsStatus();
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(t('removeConfirm'))) return;
    setRemoving(true);
    try {
      const res = await fetch('/api/sms/config', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('removeFailed'));
        return;
      }
      invalidateSmsStatus();
      toast.success(t('removeSuccess'));
      setConfigured(false);
      setHasStoredToken(false);
      setAuthToken('');
      setTokenEdited(false);
      setIsActive(false);
      setWebhookUrls(null);
      setVerifiedAt(null);
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(t('copied')),
      () => toast.error(t('copyFailed')),
    );
  };

  if (profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnly')}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  const disabled = saving || removing;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="space-y-6">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <ShieldCheck className="h-4 w-4 text-amber-500" />
            {t('complianceTitle')}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t('complianceRegistration')}</li>
            <li>{t('complianceConsent')}</li>
            <li>{t('complianceQuietHours')}</li>
          </ul>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareText className="h-4 w-4 text-primary" /> {t('providerTitle')}
            </CardTitle>
            <CardDescription>{t('providerDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Input value="Twilio" disabled readOnly />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-account-sid">{t('accountSid')}</Label>
                <Input
                  id="sms-account-sid"
                  value={accountSid}
                  onChange={(e) => setAccountSid(e.target.value)}
                  placeholder="AC…"
                  autoComplete="off"
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sms-auth-token">{t('authToken')}</Label>
              <div className="relative">
                <Input
                  id="sms-auth-token"
                  type={showToken ? 'text' : 'password'}
                  value={authToken}
                  onChange={(e) => {
                    setAuthToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (!tokenEdited && hasStoredToken) {
                      setAuthToken('');
                      setTokenEdited(true);
                    }
                  }}
                  autoComplete="off"
                  disabled={disabled}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showToken ? t('hideToken') : t('showToken')}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('authTokenHint')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sms-mg">{t('messagingServiceSid')}</Label>
                <Input
                  id="sms-mg"
                  value={messagingServiceSid}
                  onChange={(e) => setMessagingServiceSid(e.target.value)}
                  placeholder="MG…"
                  autoComplete="off"
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t('messagingServiceHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-from">{t('fromNumber')}</Label>
                <Input
                  id="sms-from"
                  value={fromNumber}
                  onChange={(e) => setFromNumber(e.target.value)}
                  placeholder="+14155550123"
                  autoComplete="off"
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t('fromNumberHint')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('registrationTitle')}</CardTitle>
            <CardDescription>{t('registrationDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('registrationType')}</Label>
                <Select
                  value={registrationType || NO_REGISTRATION}
                  onValueChange={(v) =>
                    setRegistrationType(v === NO_REGISTRATION ? '' : (v as RegistrationType))
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_REGISTRATION}>{t('registrationTypes.none')}</SelectItem>
                    {REGISTRATION_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`registrationTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-reg-ref">{t('registrationReference')}</Label>
                <Input
                  id="sms-reg-ref"
                  value={registrationRef}
                  onChange={(e) => setRegistrationRef(e.target.value)}
                  placeholder={t('registrationReferencePlaceholder')}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sms-brand">{t('brandName')}</Label>
              <Input
                id="sms-brand"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder={t('brandNamePlaceholder')}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('brandNameHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sms-help">{t('helpReply')}</Label>
              <Textarea
                id="sms-help"
                rows={2}
                value={helpReply}
                onChange={(e) => setHelpReply(e.target.value)}
                placeholder={t('helpReplyPlaceholder')}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('helpReplyHint')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sms-optout">{t('optOutReply')}</Label>
                <Textarea
                  id="sms-optout"
                  rows={2}
                  value={optOutReply}
                  onChange={(e) => setOptOutReply(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-optin">{t('optInReply')}</Label>
                <Textarea
                  id="sms-optin"
                  rows={2}
                  value={optInReply}
                  onChange={(e) => setOptInReply(e.target.value)}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('confirmationsHint')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('sendingTitle')}</CardTitle>
            <CardDescription>{t('sendingDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-1">
                <Label htmlFor="sms-tz">{t('defaultTimezone')}</Label>
                <Input
                  id="sms-tz"
                  list="sms-timezones"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  disabled={disabled}
                />
                <datalist id="sms-timezones">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-quiet-start">{t('quietStart')}</Label>
                <Input
                  id="sms-quiet-start"
                  type="number"
                  min={0}
                  max={23}
                  value={quietStart}
                  onChange={(e) => setQuietStart(Number(e.target.value))}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-quiet-end">{t('quietEnd')}</Label>
                <Input
                  id="sms-quiet-end"
                  type="number"
                  min={0}
                  max={23}
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(Number(e.target.value))}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('quietHoursHint')}</p>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="sms-cost">{t('costPerSegment')}</Label>
                <Input
                  id="sms-cost"
                  type="number"
                  step="0.0001"
                  min={0}
                  value={costPerSegment}
                  onChange={(e) => setCostPerSegment(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sms-currency">{t('currency')}</Label>
                <Input
                  id="sms-currency"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('costHint')}</p>
          </CardContent>
        </Card>

        {webhookUrls && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('webhooksTitle')}</CardTitle>
              <CardDescription>{t('webhooksDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(
                [
                  ['inbound', t('inboundUrl')],
                  ['status', t('statusUrl')],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <Label>{label}</Label>
                  <div className="flex gap-2">
                    <Input value={webhookUrls[key]} readOnly className="font-mono text-xs" />
                    <Button variant="outline" size="sm" onClick={() => copy(webhookUrls[key])}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{t('statusUrlHint')}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Switch checked={isActive} onCheckedChange={(v) => setIsActive(Boolean(v))} disabled={disabled} />
              <div>
                <p className="text-sm font-medium text-foreground">{t('enabled')}</p>
                <p className="text-xs text-muted-foreground">
                  {verifiedAt ? (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-primary" />
                      {t('verifiedAt', { date: new Date(verifiedAt) })}
                    </span>
                  ) : (
                    t('enabledHint')
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {configured && (
                <Button variant="outline" onClick={handleRemove} disabled={disabled}>
                  {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  {t('disconnect')}
                </Button>
              )}
              <Button onClick={handleSave} disabled={disabled}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('saveAndVerify')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
