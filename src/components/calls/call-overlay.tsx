"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Mic, MicOff, Phone, PhoneIncoming, PhoneOff, X, MessageSquare, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationHref } from "@/lib/notifications/browser-notify";
import { formatCallDuration } from "@/lib/calls/webrtc";
import { useCalls } from "./call-provider";

function useElapsed(since: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return 0;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}

/** Floating incoming-call cards and the in-call bar (bottom right). */
export function CallOverlay() {
  const t = useTranslations("Calls");
  const { ringing, active, connectingId, answer, decline, dismiss, hangup, toggleMute, supported } =
    useCalls();
  const elapsed = useElapsed(active?.status === "in_progress" ? active.answeredAt : null);

  if (ringing.length === 0 && !active) return null;

  const statusText = (() => {
    if (!active) return "";
    if (active.status === "in_progress") return formatCallDuration(elapsed);
    if (active.status === "ringing") return t("statusRinging");
    if (active.status === "answering") return t("statusConnecting");
    return t("statusCalling");
  })();

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3"
      aria-live="polite"
    >
      {ringing.map((call) => {
        const connecting = connectingId === call.id;
        return (
          <div
            key={call.id}
            role="alertdialog"
            aria-label={t("incomingCallFrom", { name: call.label })}
            className="pointer-events-auto rounded-xl border border-border bg-card p-4 shadow-lg"
          >
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 animate-pulse items-center justify-center rounded-full bg-primary-soft text-primary">
                <PhoneIncoming className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">{t("incomingCall")}</p>
                <p className="truncate text-sm font-semibold text-foreground">{call.label}</p>
                {call.phone && call.phone !== call.label ? (
                  <p className="truncate text-xs text-muted-foreground">{call.phone}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(call.id)}
                aria-label={t("silence")}
                title={t("silence")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            {!supported ? (
              <p className="mt-3 text-xs text-destructive">{t("browserUnsupported")}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void decline(call.id)}
                disabled={connecting}
                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-destructive/10 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                <PhoneOff className="size-4" />
                {t("decline")}
              </button>
              <button
                type="button"
                onClick={() => void answer(call.id)}
                disabled={connecting || !supported || !!active}
                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
                {connecting ? t("connecting") : t("answer")}
              </button>
            </div>
          </div>
        );
      })}

      {active ? (
        <div className="pointer-events-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full",
                active.status === "in_progress"
                  ? "bg-primary text-primary-foreground"
                  : "animate-pulse bg-primary-soft text-primary",
              )}
            >
              <Phone className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">
                {active.direction === "inbound" ? t("inboundCall") : t("outboundCall")}
              </p>
              <p className="truncate text-sm font-semibold text-foreground">{active.label}</p>
              <p className="text-xs tabular-nums text-muted-foreground">{statusText}</p>
            </div>
            {active.conversationId ? (
              <Link
                href={conversationHref(active.conversationId)}
                aria-label={t("openChat")}
                title={t("openChat")}
                className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MessageSquare className="size-4" />
              </Link>
            ) : null}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={active.muted}
              className={cn(
                "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-medium hover:bg-muted",
                active.muted ? "text-destructive" : "text-foreground",
              )}
            >
              {active.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              {active.muted ? t("unmute") : t("mute")}
            </button>
            <button
              type="button"
              onClick={() => void hangup()}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-destructive text-sm font-medium text-white hover:bg-destructive/90"
            >
              <PhoneOff className="size-4" />
              {t("hangUp")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
