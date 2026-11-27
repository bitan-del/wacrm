"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, Delete, Grid3X3, Loader2, Phone, PhoneCall } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCallFlow, type CallMode } from "./call-flow";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"] as const;

/** Keep what a person would type in an international number. */
function cleanNumber(raw: string): string {
  const kept = raw.replace(/[^\d+\s()-]/g, "");
  // Only a single leading "+".
  return kept.replace(/(?!^)\+/g, "");
}

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

/**
 * "New call" dialer for the Calls page: type any number with its country
 * code, then call it yourself, let the AI agent call, or start the
 * connected phone-AI call. The number becomes (or matches) a contact and
 * conversation first, so the call lands in the normal history.
 */
export function Dialer() {
  const t = useTranslations("Calls");
  const flow = useCallFlow();
  const calls = flow.calls;
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  if (!calls || !calls.canCall) return null;
  const { whatsappAi, phoneAi } = calls.aiOptions;
  const valid = digitCount(number) >= 8 && digitCount(number) <= 15;

  const press = (key: (typeof KEYS)[number]) => {
    if (key === "⌫") setNumber((n) => n.slice(0, -1));
    else if (key === "+") setNumber((n) => (n.includes("+") ? n : `+${n}`));
    else setNumber((n) => (digitCount(n) >= 15 ? n : n + key));
  };

  /** Resolve the typed number to a conversation, then run the chosen call. */
  const go = async (kind: CallMode | "phone_ai") => {
    setBusy(kind);
    try {
      const res = await fetch("/api/whatsapp/calls/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: number, name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        conversation_id?: string;
        label?: string;
      };
      if (!res.ok || !data.conversation_id) {
        toast.error(data.error || t("callFailed"));
        return;
      }
      const label = data.label || number;
      setOpen(false);
      if (kind === "phone_ai") {
        await calls.startPhoneAiCall({ conversationId: data.conversation_id, label });
      } else {
        await flow.begin(data.conversation_id, label, kind);
      }
      setNumber("");
      setName("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!!calls.active}>
        <Grid3X3 className="size-4" />
        {t("newCall")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="pr-6">{t("dialerTitle")}</DialogTitle>
            <DialogDescription>{t("dialerHint")}</DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !busy) void go("agent");
            }}
            className="space-y-3"
          >
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              value={number}
              onChange={(e) => setNumber(cleanNumber(e.target.value))}
              placeholder="+91 98765 43210"
              aria-label={t("dialerNumber")}
              className="h-11 text-center text-lg tabular-nums"
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("dialerNameOptional")}
              aria-label={t("dialerNameOptional")}
              maxLength={120}
            />

            <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("dialerKeypad")}>
              {KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  aria-label={key === "⌫" ? t("dialerDelete") : key}
                  className="flex h-11 items-center justify-center rounded-lg border border-border text-lg font-medium text-foreground tabular-nums hover:bg-muted"
                >
                  {key === "⌫" ? <Delete className="size-5" /> : key}
                </button>
              ))}
            </div>

            <div className="space-y-2 pt-1">
              <Button type="submit" className="h-10 w-full" disabled={!valid || !!busy || !calls.supported}>
                {busy === "agent" ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
                {t("dialerCallWhatsapp")}
              </Button>
              {whatsappAi ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 w-full"
                  disabled={!valid || !!busy}
                  onClick={() => void go("ai")}
                >
                  {busy === "ai" ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                  {t("menuAiWhatsappCall")}
                </Button>
              ) : null}
              {phoneAi ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 w-full"
                  disabled={!valid || !!busy}
                  onClick={() => void go("phone_ai")}
                >
                  {busy === "phone_ai" ? <Loader2 className="size-4 animate-spin" /> : <PhoneCall className="size-4" />}
                  {t("menuPhoneAiCall", { system: phoneAi.label })}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t("dialerPermissionNote")}</p>
          </form>
        </DialogContent>
      </Dialog>
      {flow.node}
    </>
  );
}
