'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { useSmsStatus } from '@/hooks/use-sms-status';
import { SmsComposeStep, type SmsComposeValue } from '@/components/broadcasts/sms-compose-step';
import { SmsReviewStep, smsRequestBody } from '@/components/broadcasts/sms-review-step';
import { Check, MessageCircle, MessageSquareText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

type Channel = 'whatsapp' | 'sms';

const WHATSAPP_STEPS = [
  { label: 'steps.template', key: 'template' },
  { label: 'steps.audience', key: 'audience' },
  { label: 'steps.personalize', key: 'personalize' },
  { label: 'steps.send', key: 'send' },
] as const;

// SMS has no Meta template and no per-variable mapping step: merge tags
// are typed inline, so the wizard is three steps.
const SMS_STEPS = [
  { label: 'smsSteps.message', key: 'message' },
  { label: 'steps.audience', key: 'audience' },
  { label: 'smsSteps.review', key: 'review' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();
  const smsStatus = useSmsStatus();

  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [smsCompose, setSmsCompose] = useState<SmsComposeValue>({
    body: '',
    prefixBrand: true,
    appendOptOut: true,
  });
  const [smsSending, setSmsSending] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  const steps = channel === 'sms' ? SMS_STEPS : WHATSAPP_STEPS;
  const busy = isProcessing || smsSending;

  function switchChannel(next: Channel) {
    if (next === channel) return;
    setChannel(next);
    setCurrentStep(0);
  }

  async function handleSendSms() {
    setSmsSending(true);
    try {
      const res = await fetch('/api/sms/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), ...smsRequestBody(smsCompose, audience) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('broadcastFailed'));
        return;
      }
      toast.success(t('toastSmsQueued', { count: data.eligible ?? 0 }));
      router.push(`/broadcasts/${data.broadcast_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('broadcastFailed'));
    } finally {
      setSmsSending(false);
    }
  }

  async function handleSend() {
    if (!template) return;

    try {
      const { broadcastId, interruption } = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
      });
      if (interruption === 'lease_lost') toast.warning(t('toastSendTakenOver'));
      if (interruption === 'lease_error') toast.error(t('toastSendInterrupted'));
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('broadcastFailed');
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Channel. Only offered when SMS is connected and switched on. */}
      {smsStatus.enabled && (
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { id: 'whatsapp', icon: MessageCircle },
              { id: 'sms', icon: MessageSquareText },
            ] as const
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => switchChannel(id)}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                channel === id
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card/50 hover:border-primary/40',
              )}
            >
              <Icon className={cn('mt-0.5 h-4 w-4', channel === id ? 'text-primary' : 'text-muted-foreground')} />
              <span>
                <span className="block text-sm font-medium text-foreground">{t(`channel.${id}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`channel.${id}Desc`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(step.label)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? 'none' : 'auto',
          }}
        >
          {channel === 'sms' && currentStep === 0 && (
            <SmsComposeStep
              value={smsCompose}
              onChange={setSmsCompose}
              brandName={smsStatus.brandName}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {channel === 'sms' && currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
              channel="sms"
            />
          )}
          {channel === 'sms' && currentStep === 2 && (
            <SmsReviewStep
              name={name}
              onNameChange={setName}
              compose={smsCompose}
              audience={audience}
              onSend={handleSendSms}
              onBack={() => setCurrentStep(1)}
              isSending={smsSending}
            />
          )}
          {channel === 'whatsapp' && currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {channel === 'whatsapp' && currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {channel === 'whatsapp' && currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {channel === 'whatsapp' && currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
