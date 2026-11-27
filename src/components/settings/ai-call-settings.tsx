"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Provider = "nutriherb" | "dakiya" | "custom";

interface AiSettings {
  enabled: boolean;
  inbound_mode: "off" | "always" | "unanswered";
  unanswered_after_seconds: number;
  persona_name: string;
  voice: string;
  language: string;
  greeting: string;
  instructions: string;
  default_instructions: string;
  max_duration_seconds: number;
  has_gemini_key: boolean;
  voices: string[];
  voice_server: { configured: boolean; reachable: boolean; error: string | null };
  phone_ai: {
    provider: Provider | null;
    label: string;
    base_url: string;
    path: string;
    auth_header: string;
    has_key: boolean;
    presets: Record<Provider, { path: string; authHeader: string }>;
  };
}

const LANGUAGES = [
  "auto", "en-IN", "hi-IN", "en-US", "en-GB", "bn-IN", "ta-IN", "te-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN",
  "es-ES", "es-US", "pt-BR", "fr-FR", "de-DE", "it-IT", "ar-XA", "id-ID", "ko-KR", "ja-JP", "tr-TR", "vi-VN",
];

const SELECT_CLASS = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CheckCircle2 : CircleAlert;
  return (
    <p className="flex items-start gap-2 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", ok ? "text-primary" : "text-amber-500")} />
      <span className="text-foreground">{children}</span>
    </p>
  );
}

/** Settings → AI calls: the AI agent's persona and the phone-AI connector. */
export function AiCallSettings() {
  const t = useTranslations("Settings.aiCalls");
  const { isAdmin, isOwner } = useAuth();
  const canEdit = isAdmin || isOwner;

  const [data, setData] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState<Partial<AiSettings>>({});
  const [geminiKey, setGeminiKey] = useState("");
  const [phone, setPhone] = useState({ provider: "" as Provider | "", label: "", base_url: "", path: "", auth_header: "", api_key: "" });
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/whatsapp/calls/ai-settings");
    if (!res.ok) return;
    const body = (await res.json()) as AiSettings;
    setData(body);
    setDraft({});
    setPhone({
      provider: body.phone_ai.provider ?? "",
      label: body.phone_ai.label,
      base_url: body.phone_ai.base_url,
      path: body.phone_ai.path,
      auth_header: body.phone_ai.auth_header,
      api_key: "",
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: string, patch: Record<string, unknown>, ok: string) => {
    setSaving(key);
    try {
      const res = await fetch("/api/whatsapp/calls/ai-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error || t("saveFailed"));
        return false;
      }
      toast.success(ok);
      await load();
      return true;
    } finally {
      setSaving(null);
    }
  };

  if (!data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const v = { ...data, ...draft };
  const set = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = Object.keys(draft).length > 0;
  const preset = phone.provider ? data.phone_ai.presets[phone.provider] : null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <Section title={t("statusTitle")}>
        <div className="space-y-2">
          <StatusLine ok={data.voice_server.configured && data.voice_server.reachable}>
            {!data.voice_server.configured
              ? t("serverNotConfigured")
              : data.voice_server.reachable
                ? t("serverOk")
                : t("serverUnreachable", { error: data.voice_server.error ?? "" })}
          </StatusLine>
          <StatusLine ok={data.has_gemini_key}>
            {data.has_gemini_key ? t("keySaved") : t("keyMissing")}
          </StatusLine>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <Label className="text-sm font-medium text-foreground">{t("enable")}</Label>
            <p className="text-xs text-muted-foreground">{t("enableHelp")}</p>
          </div>
          <Switch
            checked={data.enabled}
            disabled={!canEdit || saving !== null}
            onCheckedChange={(checked) =>
              void save("enabled", { enabled: checked }, checked ? t("enabledToast") : t("disabledToast"))
            }
            aria-label={t("enable")}
          />
        </div>
      </Section>

      <Section title={t("personaTitle")} description={t("personaDesc")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ai-name">{t("name")}</Label>
            <Input id="ai-name" value={v.persona_name} maxLength={60} placeholder="Aisha" disabled={!canEdit}
              onChange={(e) => set("persona_name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-voice">{t("voice")}</Label>
            <select id="ai-voice" className={SELECT_CLASS} value={v.voice} disabled={!canEdit}
              onChange={(e) => set("voice", e.target.value)}>
              {data.voices.map((voice) => (
                <option key={voice} value={voice}>{voice}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-language">{t("language")}</Label>
            <select id="ai-language" className={SELECT_CLASS} value={v.language} disabled={!canEdit}
              onChange={(e) => set("language", e.target.value)}>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>{code === "auto" ? t("languageAuto") : code}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-max">{t("maxDuration")}</Label>
            <select id="ai-max" className={SELECT_CLASS} value={v.max_duration_seconds} disabled={!canEdit}
              onChange={(e) => set("max_duration_seconds", Number(e.target.value))}>
              {[180, 300, 600, 900, 1200, 1800].map((s) => (
                <option key={s} value={s}>{t("minutes", { count: s / 60 })}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <Label htmlFor="ai-greeting">{t("greeting")}</Label>
          <Input id="ai-greeting" value={v.greeting} maxLength={500} placeholder={t("greetingPlaceholder")}
            disabled={!canEdit} onChange={(e) => set("greeting", e.target.value)} />
        </div>

        <div className="mt-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="ai-instructions">{t("instructions")}</Label>
            {canEdit ? (
              <button type="button" className="text-xs font-medium text-primary hover:underline"
                onClick={() => set("instructions", t("instructionsExample"))}>
                {t("useExample")}
              </button>
            ) : null}
          </div>
          <Textarea id="ai-instructions" rows={12} maxLength={8000} value={v.instructions}
            placeholder={data.default_instructions} disabled={!canEdit}
            onChange={(e) => set("instructions", e.target.value)} />
          <p className="text-xs text-muted-foreground">
            {t("instructionsHelp", { count: v.instructions.length })}
          </p>
        </div>
      </Section>

      <Section title={t("answerTitle")} description={t("answerDesc")}>
        <div className="space-y-2" role="radiogroup" aria-label={t("answerTitle")}>
          {(["off", "always", "unanswered"] as const).map((mode) => (
            <label key={mode} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input type="radio" name="ai-inbound" className="mt-1" value={mode} disabled={!canEdit}
                checked={v.inbound_mode === mode} onChange={() => set("inbound_mode", mode)} />
              <span>
                <span className="font-medium text-foreground">{t(`mode.${mode}`)}</span>
                {mode === "unanswered" ? (
                  <span className="ml-2 inline-flex items-center gap-1.5 text-muted-foreground">
                    <Input type="number" min={5} max={30} className="h-7 w-16" disabled={!canEdit}
                      value={v.unanswered_after_seconds}
                      onChange={(e) => set("unanswered_after_seconds", Number(e.target.value) || 20)} />
                    {t("seconds")}
                  </span>
                ) : null}
                <span className="block text-xs text-muted-foreground">{t(`modeHelp.${mode}`)}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      {canEdit ? (
        <div className="flex justify-end">
          <Button
            disabled={!dirty || saving !== null}
            onClick={() =>
              void save(
                "persona",
                {
                  persona_name: v.persona_name,
                  voice: v.voice,
                  language: v.language,
                  greeting: v.greeting,
                  instructions: v.instructions,
                  max_duration_seconds: v.max_duration_seconds,
                  inbound_mode: v.inbound_mode,
                  unanswered_after_seconds: v.unanswered_after_seconds,
                },
                t("savedToast"),
              )
            }
          >
            {saving === "persona" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("savePersona")}
          </Button>
        </div>
      ) : null}

      <Section title={t("keyTitle")} description={t("keyDesc")}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input type="password" autoComplete="off" value={geminiKey} disabled={!canEdit}
            placeholder={data.has_gemini_key ? t("keyPlaceholderSaved") : t("keyPlaceholder")}
            onChange={(e) => setGeminiKey(e.target.value)} aria-label={t("keyTitle")} />
          <Button disabled={!canEdit || !geminiKey.trim() || saving !== null}
            onClick={async () => {
              if (await save("key", { gemini_api_key: geminiKey.trim() }, t("keySavedToast"))) setGeminiKey("");
            }}>
            {t("saveKey")}
          </Button>
          {data.has_gemini_key && canEdit ? (
            <Button variant="outline" disabled={saving !== null}
              onClick={() => void save("key", { gemini_api_key: null, enabled: false }, t("keyRemovedToast"))}>
              {t("removeKey")}
            </Button>
          ) : null}
        </div>
      </Section>

      <Section title={t("phoneTitle")} description={t("phoneDesc")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pa-provider">{t("phoneProvider")}</Label>
            <select id="pa-provider" className={SELECT_CLASS} value={phone.provider} disabled={!canEdit}
              onChange={(e) => {
                const p = e.target.value as Provider | "";
                const pr = p ? data.phone_ai.presets[p] : null;
                setPhone((s) => ({
                  ...s,
                  provider: p,
                  label: s.label || (p === "nutriherb" ? "Nutriherb" : p === "dakiya" ? "Dakiya" : ""),
                  base_url: s.base_url || (p === "nutriherb" ? "https://first.try.nutriherbs.in" : p === "dakiya" ? "https://whatsapp.outreach-pro.in" : ""),
                  path: pr?.path ?? s.path,
                  auth_header: pr?.authHeader ?? s.auth_header,
                }));
              }}>
              <option value="">{t("phoneNone")}</option>
              <option value="nutriherb">{t("phoneNutriherb")}</option>
              <option value="dakiya">{t("phoneDakiya")}</option>
              <option value="custom">{t("phoneCustom")}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pa-label">{t("phoneLabel")}</Label>
            <Input id="pa-label" value={phone.label} maxLength={60} disabled={!canEdit || !phone.provider}
              onChange={(e) => setPhone((s) => ({ ...s, label: e.target.value }))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pa-url">{t("phoneUrl")}</Label>
            <Input id="pa-url" value={phone.base_url} placeholder="https://" disabled={!canEdit || !phone.provider}
              onChange={(e) => setPhone((s) => ({ ...s, base_url: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pa-path">{t("phonePath")}</Label>
            <Input id="pa-path" value={phone.path} placeholder={preset?.path || "/api/…"} disabled={!canEdit || !phone.provider}
              onChange={(e) => setPhone((s) => ({ ...s, path: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pa-header">{t("phoneHeader")}</Label>
            <Input id="pa-header" value={phone.auth_header} placeholder={preset?.authHeader || "Authorization"}
              disabled={!canEdit || !phone.provider}
              onChange={(e) => setPhone((s) => ({ ...s, auth_header: e.target.value }))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pa-key">{t("phoneKey")}</Label>
            <Input id="pa-key" type="password" autoComplete="off" value={phone.api_key}
              placeholder={data.phone_ai.has_key ? t("keyPlaceholderSaved") : ""}
              disabled={!canEdit || !phone.provider}
              onChange={(e) => setPhone((s) => ({ ...s, api_key: e.target.value }))} />
          </div>
        </div>
        {phone.provider ? (
          <p className="mt-3 text-xs text-muted-foreground">{t(`phoneHelp.${phone.provider}`)}</p>
        ) : null}
        {canEdit ? (
          <div className="mt-4 flex gap-2">
            <Button
              disabled={!phone.provider || !phone.base_url.trim() || saving !== null}
              onClick={async () => {
                const ok = await save(
                  "phone",
                  {
                    phone_ai_provider: phone.provider,
                    phone_ai_label: phone.label,
                    phone_ai_base_url: phone.base_url,
                    phone_ai_path: phone.path,
                    phone_ai_auth_header: phone.auth_header,
                    phone_ai_api_key: phone.api_key,
                  },
                  t("phoneSavedToast"),
                );
                if (ok) setPhone((s) => ({ ...s, api_key: "" }));
              }}
            >
              {saving === "phone" ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("phoneSave")}
            </Button>
            {data.phone_ai.provider ? (
              <Button variant="outline" disabled={saving !== null}
                onClick={() => void save("phone", { phone_ai_provider: null }, t("phoneRemovedToast"))}>
                {t("phoneDisconnect")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Section>

      {!canEdit ? <p className="text-xs text-muted-foreground">{t("adminOnly")}</p> : null}
    </div>
  );
}
