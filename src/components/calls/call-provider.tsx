"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Call, CallStatus } from "@/types";
import {
  applyAnswer,
  buildAnswer,
  buildOffer,
  createCallPeerConnection,
  getMicrophone,
  isCallingSupportedInBrowser,
  stopStream,
} from "@/lib/calls/webrtc";
import { startRingtone, type Ringtone } from "@/lib/calls/ringtone";
import { CallOverlay } from "./call-overlay";

// ============================================================
// Live WhatsApp calls for this browser tab.
//
// Mounted once in the dashboard shell, so a call survives client-side
// navigation. Every agent's tab subscribes to the `calls` table:
//   - an inbound INSERT with status 'ringing' rings here;
//   - the first agent to answer claims it server-side, and the UPDATE
//     that follows stops the ringing everywhere else;
//   - for the call this tab is on, updates drive the UI (and, outbound,
//     carry Meta's SDP answer).
// Audio is WebRTC between this tab and Meta — nothing passes through
// our servers.
// ============================================================

/** Ignore ringing rows older than this (missed terminate webhook). */
const RING_STALE_MS = 75_000;
const TERMINAL: CallStatus[] = ["completed", "missed", "rejected", "canceled", "failed"];

export interface RingingCall {
  id: string;
  label: string;
  phone: string | null;
  conversationId: string | null;
  startedAt: string;
}

export interface ActiveCall {
  id: string;
  direction: "inbound" | "outbound";
  status: CallStatus;
  label: string;
  conversationId: string | null;
  answeredAt: string | null;
  muted: boolean;
}

export interface AiCallOptions {
  /** The WhatsApp AI agent can place calls (enabled, key set, voice server configured). */
  whatsappAi: boolean;
  /** Connected external phone-AI system (Nutriherb panel / Dakiya / custom). */
  phoneAi: { label: string } | null;
}

interface CallContextValue {
  /** True when this user may place/answer calls (agent and above). */
  canCall: boolean;
  aiOptions: AiCallOptions;
  /** Have the AI agent place a WhatsApp call (it talks, not you). */
  startAiCall: (args: { conversationId: string; label: string }) => Promise<boolean>;
  /** Ask the connected phone-AI system to call this contact. */
  startPhoneAiCall: (args: { conversationId: string; label: string }) => Promise<boolean>;
  supported: boolean;
  ringing: RingingCall[];
  active: ActiveCall | null;
  connectingId: string | null;
  answer: (id: string) => Promise<void>;
  decline: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  startCall: (args: { conversationId: string; label: string }) => Promise<boolean>;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCalls(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCalls must be used inside <CallProvider>");
  return ctx;
}

/** Same as useCalls, but null outside the provider (e.g. in tests). */
export function useOptionalCalls(): CallContextValue | null {
  return useContext(CallContext);
}

type ContactLite = { name?: string | null; phone?: string | null; wa_username?: string | null };

function contactLabel(contact: ContactLite | null | undefined, fallback: string): string {
  return (
    contact?.name?.trim() ||
    (contact?.wa_username ? `@${contact.wa_username}` : "") ||
    contact?.phone ||
    fallback
  );
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export function CallProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("Calls");
  const { user, isViewer, accountRole } = useAuth();
  const canCall = !!user && !!accountRole && !isViewer;
  const [supported] = useState(() => isCallingSupportedInBrowser());

  const [ringing, setRinging] = useState<RingingCall[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [aiOptions, setAiOptions] = useState<AiCallOptions>({ whatsappAi: false, phoneAi: null });

  // Which AI call options this account has switched on.
  useEffect(() => {
    if (!canCall) return;
    let cancelled = false;
    fetch("/api/whatsapp/calls/ai-settings?lite=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setAiOptions({
          whatsappAi: !!(d.enabled && d.has_gemini_key && d.voice_server?.configured),
          phoneAi:
            d.phone_ai?.provider && d.phone_ai?.has_key && (d.phone_ai?.path || d.phone_ai?.presets?.[d.phone_ai.provider]?.path)
              ? { label: d.phone_ai.label || d.phone_ai.provider }
              : null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canCall]);

  const pcRef = useRef<PeerRefs | null>(null);
  const activeRef = useRef<ActiveCall | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneRef = useRef<Ringtone | null>(null);
  const answerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tRef = useRef(t);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // ---- media teardown ---------------------------------------------------
  const teardown = useCallback(() => {
    if (answerPollRef.current) {
      clearInterval(answerPollRef.current);
      answerPollRef.current = null;
    }
    const refs = pcRef.current;
    pcRef.current = null;
    if (refs) {
      stopStream(refs.mic);
      try {
        refs.pc.close();
      } catch {
        // already closed
      }
    }
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const endLocally = useCallback(
    (status: CallStatus | null) => {
      teardown();
      setActive(null);
      if (status === "rejected") toast(tRef.current("toastDeclined"));
      else if (status === "missed") toast(tRef.current("toastNoAnswer"));
      else if (status === "failed") toast.error(tRef.current("toastFailed"));
      else toast(tRef.current("toastEnded"));
    },
    [teardown],
  );

  // ---- apply a row update to the call this tab is on --------------------
  const onActiveRow = useCallback(
    async (row: Call) => {
      const current = activeRef.current;
      if (!current || current.id !== row.id) return;
      if (TERMINAL.includes(row.status)) {
        endLocally(row.status);
        return;
      }
      if (current.direction === "outbound" && row.sdp_answer && pcRef.current) {
        try {
          await applyAnswer(pcRef.current.pc, row.sdp_answer);
        } catch (err) {
          console.error("[calls] could not apply SDP answer:", err);
        }
      }
      setActive((prev) =>
        prev && prev.id === row.id
          ? { ...prev, status: row.status, answeredAt: row.answered_at ?? prev.answeredAt }
          : prev,
      );
    },
    [endLocally],
  );

  // ---- realtime subscription --------------------------------------------
  useEffect(() => {
    if (!canCall) return;
    const supabase = createClient();
    let cancelled = false;

    const addRinging = async (row: Call) => {
      if (row.direction !== "inbound" || row.status !== "ringing") return;
      if (Date.now() - new Date(row.started_at).getTime() > RING_STALE_MS) return;
      let contact: ContactLite | null = null;
      if (row.contact_id) {
        const { data } = await supabase
          .from("contacts")
          .select("name, phone, wa_username")
          .eq("id", row.contact_id)
          .maybeSingle();
        contact = data as ContactLite | null;
      }
      if (cancelled) return;
      const entry: RingingCall = {
        id: row.id,
        label: contactLabel(contact, row.customer_wa_id ?? tRef.current("unknownCaller")),
        phone: contact?.phone ?? row.customer_wa_id,
        conversationId: row.conversation_id,
        startedAt: row.started_at,
      };
      setRinging((prev) => (prev.some((r) => r.id === entry.id) ? prev : [...prev, entry]));
    };

    // Calls already ringing when the page loaded.
    void supabase
      .from("calls")
      .select("*")
      .eq("direction", "inbound")
      .eq("status", "ringing")
      .gte("started_at", new Date(Date.now() - RING_STALE_MS).toISOString())
      .then(({ data }) => {
        for (const row of (data ?? []) as Call[]) void addRinging(row);
      });

    const channel = supabase
      .channel("whatsapp-calls")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "calls" },
        (payload) => void addRinging(payload.new as Call),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "calls" },
        (payload) => {
          const row = payload.new as Call;
          if (row.status !== "ringing") {
            setRinging((prev) => prev.filter((r) => r.id !== row.id));
          }
          void onActiveRow(row);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [canCall, onActiveRow]);

  // Drop ringing entries whose terminate webhook never came.
  useEffect(() => {
    if (ringing.length === 0) return;
    const timer = setInterval(() => {
      setRinging((prev) =>
        prev.filter((r) => Date.now() - new Date(r.startedAt).getTime() <= RING_STALE_MS),
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [ringing.length]);

  const audibleRinging = useMemo(
    () => ringing.filter((r) => !dismissed.has(r.id)),
    [ringing, dismissed],
  );

  // ---- ringtone + background notification -------------------------------
  const shouldRing = audibleRinging.length > 0 && !active && !connectingId;
  useEffect(() => {
    if (!shouldRing) {
      ringtoneRef.current?.stop();
      ringtoneRef.current = null;
      return;
    }
    ringtoneRef.current ??= startRingtone();
    return undefined;
  }, [shouldRing]);
  useEffect(() => () => ringtoneRef.current?.stop(), []);

  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const call of audibleRinging) {
      if (notifiedRef.current.has(call.id)) continue;
      notifiedRef.current.add(call.id);
      if (document.visibilityState === "visible") continue;
      try {
        const n = new Notification(t("notificationTitle"), {
          body: call.label,
          tag: `call-${call.id}`,
          icon: "/icon",
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    }
  }, [audibleRinging, t]);

  // ---- hang up if the tab closes mid-call -------------------------------
  useEffect(() => {
    const onUnload = () => {
      const current = activeRef.current;
      if (current) navigator.sendBeacon(`/api/whatsapp/calls/${current.id}/hangup`);
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  // ---- actions ----------------------------------------------------------
  const attachRemoteAudio = useCallback((pc: RTCPeerConnection) => {
    pc.ontrack = (event) => {
      const el = audioRef.current;
      if (!el) return;
      el.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void el.play().catch(() => {});
    };
  }, []);

  const answer = useCallback(
    async (id: string) => {
      if (activeRef.current) {
        toast(t("finishCurrentCall"));
        return;
      }
      const ring = ringing.find((r) => r.id === id);
      setConnectingId(id);
      let mic: MediaStream | null = null;
      let pc: RTCPeerConnection | null = null;
      try {
        const supabase = createClient();
        const { data: row } = await supabase.from("calls").select("*").eq("id", id).maybeSingle();
        const call = row as Call | null;
        if (!call || call.status !== "ringing" || !call.sdp_offer) {
          toast(t("alreadyTaken"));
          setRinging((prev) => prev.filter((r) => r.id !== id));
          return;
        }

        try {
          mic = await getMicrophone();
        } catch {
          toast.error(t("micBlocked"));
          return;
        }
        pc = createCallPeerConnection();
        attachRemoteAudio(pc);
        // Muted until Meta confirms the accept, as its docs ask.
        for (const track of mic.getAudioTracks()) {
          track.enabled = false;
          pc.addTrack(track, mic);
        }
        const sdp = await buildAnswer(pc, call.sdp_offer);
        pcRef.current = { pc, mic };

        const { ok, data } = await postJson(`/api/whatsapp/calls/${id}/answer`, { sdp });
        if (!ok) {
          teardown();
          toast.error((data.error as string) || t("answerFailed"));
          return;
        }
        for (const track of mic.getAudioTracks()) track.enabled = true;
        setRinging((prev) => prev.filter((r) => r.id !== id));
        setActive({
          id,
          direction: "inbound",
          status: "in_progress",
          label: ring?.label ?? t("unknownCaller"),
          conversationId: call.conversation_id,
          answeredAt: new Date().toISOString(),
          muted: false,
        });
      } catch (err) {
        console.error("[calls] answer failed:", err);
        if (pcRef.current?.pc === pc) teardown();
        else {
          stopStream(mic);
          pc?.close();
        }
        toast.error(t("answerFailed"));
      } finally {
        setConnectingId(null);
      }
    },
    [ringing, t, teardown, attachRemoteAudio],
  );

  const decline = useCallback(
    async (id: string) => {
      setRinging((prev) => prev.filter((r) => r.id !== id));
      const { ok, data } = await postJson(`/api/whatsapp/calls/${id}/reject`);
      if (!ok && data.error) toast.error(data.error as string);
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  const hangup = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return;
    // Clear the ref now, not on the next render, so the status UPDATE
    // our own hang-up triggers isn't treated as the other side ending it.
    activeRef.current = null;
    teardown();
    setActive(null);
    const { ok, data } = await postJson(`/api/whatsapp/calls/${current.id}/hangup`);
    if (!ok && data.error) toast.error(data.error as string);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const refs = pcRef.current;
    if (!refs) return;
    setActive((prev) => {
      if (!prev) return prev;
      const muted = !prev.muted;
      for (const track of refs.mic.getAudioTracks()) track.enabled = !muted;
      return { ...prev, muted };
    });
  }, []);

  const startCall = useCallback(
    async ({ conversationId, label }: { conversationId: string; label: string }) => {
      if (activeRef.current) {
        toast(t("finishCurrentCall"));
        return false;
      }
      let mic: MediaStream;
      try {
        mic = await getMicrophone();
      } catch {
        toast.error(t("micBlocked"));
        return false;
      }
      const pc = createCallPeerConnection();
      attachRemoteAudio(pc);
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
      pcRef.current = { pc, mic };
      try {
        const sdp = await buildOffer(pc);
        const { ok, data } = await postJson("/api/whatsapp/calls", {
          conversation_id: conversationId,
          sdp,
        });
        if (!ok || !data.call) {
          teardown();
          toast.error((data.error as string) || t("callFailed"));
          return false;
        }
        const call = data.call as Call;
        setActive({
          id: call.id,
          direction: "outbound",
          status: call.status,
          label,
          conversationId,
          answeredAt: null,
          muted: false,
        });
        activeRef.current = {
          id: call.id,
          direction: "outbound",
          status: call.status,
          label,
          conversationId,
          answeredAt: null,
          muted: false,
        };
        if (call.sdp_answer) await applyAnswer(pc, call.sdp_answer);

        // Realtime normally delivers Meta's answer; poll as a backstop
        // in case that one UPDATE was missed.
        const supabase = createClient();
        const startedAt = Date.now();
        answerPollRef.current = setInterval(async () => {
          const current = activeRef.current;
          if (!current || current.id !== call.id || Date.now() - startedAt > 90_000) {
            if (answerPollRef.current) clearInterval(answerPollRef.current);
            answerPollRef.current = null;
            return;
          }
          const { data: row } = await supabase.from("calls").select("*").eq("id", call.id).maybeSingle();
          if (row) await onActiveRow(row as Call);
          if (row && (row as Call).status === "in_progress" && pc.remoteDescription) {
            if (answerPollRef.current) clearInterval(answerPollRef.current);
            answerPollRef.current = null;
          }
        }, 2000);
        return true;
      } catch (err) {
        console.error("[calls] outbound call failed:", err);
        teardown();
        setActive(null);
        toast.error(t("callFailed"));
        return false;
      }
    },
    [t, teardown, attachRemoteAudio, onActiveRow],
  );

  const startAiCall = useCallback(
    async ({ conversationId, label }: { conversationId: string; label: string }) => {
      const { ok, data } = await postJson("/api/whatsapp/calls", { conversation_id: conversationId, ai: true });
      if (!ok) {
        toast.error((data.error as string) || t("callFailed"));
        return false;
      }
      toast.success(t("aiCallStarted", { name: label }));
      return true;
    },
    [t],
  );

  const startPhoneAiCall = useCallback(
    async ({ conversationId, label }: { conversationId: string; label: string }) => {
      const { ok, data } = await postJson("/api/whatsapp/calls/phone-ai", { conversation_id: conversationId });
      if (!ok) {
        toast.error((data.error as string) || t("callFailed"));
        return false;
      }
      toast.success(t("phoneAiCallStarted", { name: label, system: String(data.label ?? "") }));
      return true;
    },
    [t],
  );

  const value = useMemo<CallContextValue>(
    () => ({
      canCall,
      aiOptions,
      startAiCall,
      startPhoneAiCall,
      supported,
      ringing: audibleRinging,
      active,
      connectingId,
      answer,
      decline,
      dismiss,
      hangup,
      toggleMute,
      startCall,
    }),
    [canCall, aiOptions, startAiCall, startPhoneAiCall, supported, audibleRinging, active, connectingId, answer, decline, dismiss, hangup, toggleMute, startCall],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Remote party's audio. Always mounted so ontrack has a target. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {canCall ? <CallOverlay /> : null}
    </CallContext.Provider>
  );
}

interface PeerRefs {
  pc: RTCPeerConnection;
  mic: MediaStream;
}
