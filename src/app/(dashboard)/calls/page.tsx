"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import {
  Bot,
  Download,
  FileText,
  Loader2,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Settings2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getDateLocale } from "@/i18n/date-locale";
import { conversationHref } from "@/lib/notifications/browser-notify";
import { formatCallDuration } from "@/lib/calls/webrtc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dialer } from "@/components/calls/dialer";
import type { Call, CallStatus } from "@/types";

const PAGE_SIZE = 50;

type Filter = "all" | "missed" | "inbound" | "outbound";
const FILTERS: Filter[] = ["all", "missed", "inbound", "outbound"];

const STATUS_TONE: Record<CallStatus, string> = {
  dialing: "text-primary",
  ringing: "text-primary",
  answering: "text-primary",
  in_progress: "text-primary",
  completed: "text-muted-foreground",
  missed: "text-red-500",
  rejected: "text-amber-500",
  canceled: "text-muted-foreground",
  failed: "text-red-500",
};

function CallIcon({ call }: { call: Call }) {
  if (call.status === "missed") return <PhoneMissed className="size-4 text-red-500" />;
  if (call.status === "failed" || call.status === "rejected") {
    return <PhoneOff className="size-4 text-amber-500" />;
  }
  return call.direction === "inbound" ? (
    <PhoneIncoming className="size-4 text-primary" />
  ) : (
    <PhoneOutgoing className="size-4 text-primary" />
  );
}

/** Call log: every WhatsApp call, with who took it and the recording. */
export default function CallsPage() {
  const t = useTranslations("Calls");
  const dateLocale = getDateLocale(useLocale());
  const { accountId, isAdmin, isOwner } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [agents, setAgents] = useState<Record<string, string>>({});
  const [transcriptOf, setTranscriptOf] = useState<Call | null>(null);

  const fetchPage = useCallback(
    async (offset: number, which: Filter) => {
      const supabase = createClient();
      let query = supabase
        .from("calls")
        .select("*, contact:contacts(id, name, phone, wa_username)")
        .order("started_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (which === "missed") query = query.eq("status", "missed");
      if (which === "inbound") query = query.eq("direction", "inbound");
      if (which === "outbound") query = query.eq("direction", "outbound");
      const { data, error } = await query;
      if (error) {
        console.error("[calls] could not load call log:", error.message);
        return [] as Call[];
      }
      return (data ?? []) as Call[];
    },
    [],
  );

  const reload = useCallback(async () => {
    const rows = await fetchPage(0, filter);
    setCalls(rows);
    setHasMore(rows.length === PAGE_SIZE);
  }, [fetchPage, filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Team member names for "answered by / placed by".
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("user_id, full_name, email")
      .eq("account_id", accountId)
      .then(({ data }) => {
        const map: Record<string, string> = {};
        for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
          map[p.user_id] = p.full_name?.trim() || p.email || "";
        }
        setAgents(map);
      });
  }, [accountId]);

  // Live: refresh the first page when any call changes.
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("calls-log")
      .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 600);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [reload]);

  const loadMore = async () => {
    if (!calls) return;
    setLoadingMore(true);
    try {
      const rows = await fetchPage(calls.length, filter);
      setCalls([...calls, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  const statusLabel = useMemo(
    () => (status: CallStatus) => t(`status.${status}`),
    [t],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin || isOwner ? (
            <Link
              href="/settings?tab=calling"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Settings2 className="size-4" />
              {t("callingSettings")}
            </Link>
          ) : null}
          <Dialer />
        </div>
      </div>

      <div className="mt-5 flex gap-1 overflow-x-auto" role="tablist" aria-label={t("filterLabel")}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => {
              if (f === filter) return;
              setCalls(null);
              setFilter(f);
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              filter === f
                ? "bg-primary-soft text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(`filter.${f}`)}
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
        {calls === null ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : calls.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("emptyBody")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {calls.map((call) => {
              const name =
                call.contact?.name?.trim() ||
                (call.contact?.wa_username ? `@${call.contact.wa_username}` : "") ||
                call.contact?.phone ||
                call.customer_wa_id ||
                t("unknownCaller");
              const agentId = call.direction === "inbound" ? call.answered_by : call.placed_by;
              const agentName = agentId ? agents[agentId] : null;
              return (
                <li key={call.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <CallIcon call={call} />
                    </div>
                    <div className="min-w-0">
                      {call.conversation_id ? (
                        <Link
                          href={conversationHref(call.conversation_id)}
                          className="block truncate text-sm font-medium text-foreground hover:underline"
                        >
                          {name}
                        </Link>
                      ) : (
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        {call.handled_by_ai ? (
                          <span className="mr-1 inline-flex items-center gap-0.5 rounded bg-primary-soft px-1 py-px text-[10px] font-semibold text-primary">
                            <Bot className="size-3" />
                            {t("aiBadge")}
                          </span>
                        ) : null}
                        {call.direction === "inbound" ? t("inbound") : t("outbound")}
                        {agentName && !call.handled_by_ai
                          ? ` · ${call.direction === "inbound" ? t("answeredBy", { name: agentName }) : t("placedBy", { name: agentName })}`
                          : ""}
                      </p>
                    </div>
                  </div>

                  <div className="w-28 text-xs">
                    <span className={cn("font-medium", STATUS_TONE[call.status])}>
                      {statusLabel(call.status)}
                    </span>
                    {call.duration_seconds ? (
                      <span className="block tabular-nums text-muted-foreground">
                        {formatCallDuration(call.duration_seconds)}
                      </span>
                    ) : null}
                  </div>

                  <div className="w-36 text-xs text-muted-foreground tabular-nums">
                    {format(new Date(call.started_at), "d MMM yyyy, HH:mm", { locale: dateLocale })}
                  </div>

                  <div className="flex w-full items-center gap-2 sm:w-72">
                    {call.recording_status === "available" ? (
                      <>
                        <audio
                          controls
                          preload="none"
                          src={`/api/whatsapp/calls/${call.id}/recording`}
                          className="h-8 min-w-0 flex-1"
                        />
                        <a
                          href={`/api/whatsapp/calls/${call.id}/recording?download=1`}
                          aria-label={t("downloadRecording")}
                          title={t("downloadRecording")}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Download className="size-4" />
                        </a>
                      </>
                    ) : call.recording_status === "requested" ? (
                      <span className="text-xs text-muted-foreground">{t("recordingProcessing")}</span>
                    ) : call.recording_status === "failed" ? (
                      <span className="text-xs text-muted-foreground">{t("recordingFailed")}</span>
                    ) : null}
                    {call.ai_transcript?.length || call.ai_summary ? (
                      <button
                        type="button"
                        onClick={() => setTranscriptOf(call)}
                        aria-label={t("viewTranscript")}
                        title={t("viewTranscript")}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <FileText className="size-4" />
                      </button>
                    ) : null}
                  </div>

                  {call.status === "failed" && (call.error_title || call.error_details) ? (
                    <p className="w-full text-xs text-red-500">
                      {[call.error_title, call.error_details].filter(Boolean).join(" — ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={!!transcriptOf} onOpenChange={(open) => !open && setTranscriptOf(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="pr-6">{t("transcriptTitle")}</DialogTitle>
            <DialogDescription>
              {transcriptOf
                ? format(new Date(transcriptOf.started_at), "d MMM yyyy, HH:mm", { locale: dateLocale })
                : ""}
            </DialogDescription>
          </DialogHeader>
          {transcriptOf?.ai_summary ? (
            <div className="rounded-lg bg-muted p-3 text-sm text-foreground">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">{t("transcriptSummary")}</p>
              {transcriptOf.ai_summary}
            </div>
          ) : null}
          {transcriptOf?.ai_notes && Object.keys(transcriptOf.ai_notes).length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {Object.entries(transcriptOf.ai_notes).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-medium text-muted-foreground">{k}</dt>
                  <dd className="text-foreground">{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {(transcriptOf?.ai_transcript ?? []).map((line, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  line.role === "agent"
                    ? "bg-primary-soft text-foreground"
                    : "ml-auto bg-muted text-foreground",
                )}
              >
                <p className="mb-0.5 text-[10px] font-semibold text-muted-foreground uppercase">
                  {line.role === "agent" ? t("transcriptAi") : t("transcriptCustomer")}
                </p>
                {line.text}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {hasMore ? (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
