"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, CircleAlert, CircleDashed, Loader2, Mic } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getMicrophone, stopStream } from "@/lib/calls/webrtc";
import {
  CALLING_LIMITS,
  RECORDING_ANNOUNCEMENT_LANGUAGES,
} from "@/lib/whatsapp/calling-constants";

interface SettingsResponse {
  connected: boolean;
  display_phone_number?: string | null;
  messaging_limit?: { kind: "tier"; perDay: number } | { kind: "unlimited" } | null;
  min_daily_limit?: number;
  meets_tier?: boolean | null;
  outbound?: { supported: boolean; blockedCountry: string | null };
  meta?: {
    status?: "ENABLED" | "DISABLED";
    call_icon_visibility?: "DEFAULT" | "DISABLE_ALL";
    callback_permission_status?: "ENABLED" | "DISABLED";
  } | null;
  meta_error?: { error: string } | null;
  local?: {
    calling_enabled: boolean;
    recording_enabled: boolean;
    recording_purpose: string | null;
    recording_language: string | null;
  };
  error?: string;
}

function CheckRow({
  state,
  title,
  children,
}: {
  state: "ok" | "bad" | "unknown";
  title: string;
  children?: ReactNode;
}) {
  const Icon = state === "ok" ? CheckCircle2 : state === "bad" ? CircleAlert : CircleDashed;
  return (
    <li className="flex gap-3 py-3">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          state === "ok" ? "text-primary" : state === "bad" ? "text-amber-500" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        {children ? <div className="mt-0.5 text-muted-foreground">{children}</div> : null}
      </div>
    </li>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function CallingSettings() {
  const t = useTranslations("Settings.calling");
  const { isAdmin, isOwner } = useAuth();
  const canEdit = isAdmin || isOwner;

  const [data, setData] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [language, setLanguage] = useState("en");
  const [micState, setMicState] = useState<"idle" | "ok" | "blocked">("idle");

  const load = useCallback(async () => {
    const res = await fetch("/api/whatsapp/calls/settings");
    const body = (await res.json().catch(() => ({ connected: false }))) as SettingsResponse;
    setData(body);
    setPurpose(body.local?.recording_purpose ?? "");
    setLanguage(body.local?.recording_language ?? "en");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: string, patch: Record<string, unknown>, okMessage: string) => {
    setSaving(key);
    try {
      const res = await fetch("/api/whatsapp/calls/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error || t("saveFailed"));
        return;
      }
      toast.success(okMessage);
      await load();
    } finally {
      setSaving(null);
    }
  };

  const testMic = async () => {
    try {
      const stream = await getMicrophone();
      stopStream(stream);
      setMicState("ok");
    } catch {
      setMicState("blocked");
    }
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data.connected) {
    return (
      <Section title={t("title")} description={t("notConnected")}>
        <a href="/settings?tab=whatsapp" className="text-sm font-medium text-primary hover:underline">
          {t("connectWhatsapp")}
        </a>
      </Section>
    );
  }

  const enabledAtMeta = data.meta?.status === "ENABLED";
  const limitText =
    data.messaging_limit?.kind === "unlimited"
      ? t("limitUnlimited")
      : data.messaging_limit?.kind === "tier"
        ? t("limitPerDay", { count: data.messaging_limit.perDay })
        : t("limitUnknown");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <Section title={t("requirementsTitle")} description={data.display_phone_number ?? undefined}>
        <ul className="divide-y divide-border">
          <CheckRow
            state={data.meets_tier === true ? "ok" : data.meets_tier === false ? "bad" : "unknown"}
            title={t("reqTier", { min: data.min_daily_limit ?? 2000 })}
          >
            {t("reqTierCurrent", { limit: limitText })}
            {data.meets_tier === false ? <p className="mt-1">{t("reqTierHelp")}</p> : null}
          </CheckRow>
          <CheckRow state="unknown" title={t("reqWebhook")}>
            {t("reqWebhookHelp")}
          </CheckRow>
          <CheckRow state={data.outbound?.supported ? "ok" : "bad"} title={t("reqOutbound")}>
            {data.outbound?.supported
              ? t("reqOutboundOk")
              : t("reqOutboundBlocked", { country: data.outbound?.blockedCountry ?? "" })}
          </CheckRow>
          <CheckRow state={micState === "ok" ? "ok" : micState === "blocked" ? "bad" : "unknown"} title={t("reqMic")}>
            <span>{micState === "blocked" ? t("micBlocked") : t("reqMicHelp")}</span>
            <div className="mt-2">
              <Button variant="outline" size="sm" onClick={() => void testMic()}>
                <Mic className="size-3.5" />
                {t("testMic")}
              </Button>
            </div>
          </CheckRow>
        </ul>
      </Section>

      <Section title={t("callingTitle")} description={t("callingDesc")}>
        {data.meta_error ? (
          <p className="mb-3 text-sm text-amber-600 dark:text-amber-400">{data.meta_error.error}</p>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium text-foreground">{t("enableCalling")}</Label>
            <p className="text-xs text-muted-foreground">
              {enabledAtMeta ? t("statusOn") : t("statusOff")}
            </p>
          </div>
          <Switch
            checked={enabledAtMeta}
            disabled={!canEdit || saving !== null}
            onCheckedChange={(checked) =>
              void save("enabled", { enabled: checked }, checked ? t("enabledToast") : t("disabledToast"))
            }
            aria-label={t("enableCalling")}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <Label className="text-sm font-medium text-foreground">{t("showCallButton")}</Label>
            <p className="text-xs text-muted-foreground">{t("showCallButtonHelp")}</p>
          </div>
          <Switch
            checked={data.meta?.call_icon_visibility !== "DISABLE_ALL"}
            disabled={!canEdit || saving !== null || !enabledAtMeta}
            onCheckedChange={(checked) =>
              void save(
                "icon",
                { call_icon_visibility: checked ? "DEFAULT" : "DISABLE_ALL" },
                t("savedToast"),
              )
            }
            aria-label={t("showCallButton")}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <Label className="text-sm font-medium text-foreground">{t("callbackPermission")}</Label>
            <p className="text-xs text-muted-foreground">{t("callbackPermissionHelp")}</p>
          </div>
          <Switch
            checked={data.meta?.callback_permission_status === "ENABLED"}
            disabled={!canEdit || saving !== null || !enabledAtMeta}
            onCheckedChange={(checked) =>
              void save("callback", { callback_permission: checked }, t("savedToast"))
            }
            aria-label={t("callbackPermission")}
          />
        </div>
      </Section>

      <Section title={t("recordingTitle")} description={t("recordingDesc")}>
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm font-medium text-foreground">{t("recordCalls")}</Label>
          <Switch
            checked={data.local?.recording_enabled ?? false}
            disabled={!canEdit || saving !== null}
            onCheckedChange={(checked) =>
              void save(
                "recording",
                {
                  recording_enabled: checked,
                  recording_purpose: purpose,
                  recording_language: language,
                },
                t("savedToast"),
              )
            }
            aria-label={t("recordCalls")}
          />
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="recording-purpose" className="text-sm text-foreground">
            {t("purposeLabel")}
          </Label>
          <Textarea
            id="recording-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={CALLING_LIMITS.recordingPurpose}
            placeholder={t("purposePlaceholder")}
            rows={2}
            disabled={!canEdit}
          />
          <p className="text-xs text-muted-foreground">
            {t("purposeHelp", { count: purpose.length, max: CALLING_LIMITS.recordingPurpose })}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="recording-language" className="text-sm text-foreground">
            {t("languageLabel")}
          </Label>
          <select
            id="recording-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={!canEdit}
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          >
            {RECORDING_ANNOUNCEMENT_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        {canEdit ? (
          <div className="mt-4">
            <Button
              size="sm"
              disabled={saving !== null}
              onClick={() =>
                void save(
                  "recordingText",
                  { recording_purpose: purpose, recording_language: language },
                  t("savedToast"),
                )
              }
            >
              {saving === "recordingText" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("saveRecording")}
            </Button>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-muted-foreground">{t("recordingLegal")}</p>
      </Section>

      <Section title={t("costsTitle")}>
        <p className="text-sm text-muted-foreground">{t("costsBody")}</p>
      </Section>

      {!canEdit ? <p className="text-xs text-muted-foreground">{t("adminOnly")}</p> : null}
    </div>
  );
}
