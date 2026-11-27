"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalCalls } from "./call-provider";

interface PermissionResponse {
  outbound?: { supported: boolean; blockedCountry: string | null };
  calling_enabled?: boolean;
  permission?: {
    status: "no_permission" | "temporary" | "permanent";
    expiresAt: number | null;
    canStartCall: boolean;
    canRequestPermission: boolean;
  } | null;
  error?: string;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "unsupported"; country: string | null }
  | { kind: "request"; canRequest: boolean; conversationId: string; label: string };

/** Who talks on the WhatsApp call: the agent in this browser, or the AI agent. */
export type CallMode = "agent" | "ai";

/**
 * Shared "place a WhatsApp call" flow for the chat header and the dialer:
 * ask Meta whether the customer allows calls; if yes, dial (agent or AI);
 * if not, offer WhatsApp's "allow calls" request. Render `node` once.
 */
export function useCallFlow() {
  const t = useTranslations("Calls");
  const calls = useOptionalCalls();
  const [checking, setChecking] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [requestText, setRequestText] = useState("");
  const [sending, setSending] = useState(false);

  const begin = async (conversationId: string, label: string, mode: CallMode = "agent") => {
    if (!calls) return;
    if (mode === "agent") {
      if (!calls.supported) {
        toast.error(t("browserUnsupported"));
        return;
      }
      if (calls.active) {
        toast(t("finishCurrentCall"));
        return;
      }
    }
    setChecking(true);
    try {
      const res = await fetch(
        `/api/whatsapp/calls/permission?conversation_id=${encodeURIComponent(conversationId)}`,
      );
      const data = (await res.json().catch(() => ({}))) as PermissionResponse;
      if (!res.ok) {
        toast.error(data.error || t("callFailed"));
        return;
      }
      if (data.outbound && !data.outbound.supported) {
        setDialog({ kind: "unsupported", country: data.outbound.blockedCountry });
        return;
      }
      if (data.permission?.canStartCall) {
        if (mode === "ai") await calls.startAiCall({ conversationId, label });
        else await calls.startCall({ conversationId, label });
        return;
      }
      setRequestText(t("permissionRequestDefault"));
      setDialog({
        kind: "request",
        canRequest: data.permission?.canRequestPermission ?? true,
        conversationId,
        label,
      });
    } finally {
      setChecking(false);
    }
  };

  const sendRequest = async () => {
    if (dialog.kind !== "request") return;
    setSending(true);
    try {
      const res = await fetch("/api/whatsapp/calls/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: dialog.conversationId, body_text: requestText }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error || t("permissionRequestFailed"));
        return;
      }
      toast.success(t("permissionRequestSent"));
      setDialog({ kind: "closed" });
    } finally {
      setSending(false);
    }
  };

  const node = (
    <Dialog
      open={dialog.kind !== "closed"}
      onOpenChange={(open) => {
        if (!open) setDialog({ kind: "closed" });
      }}
    >
      <DialogContent>
        {dialog.kind === "unsupported" ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{t("outboundUnavailableTitle")}</DialogTitle>
              <DialogDescription>
                {t("outboundUnavailableBody", { country: dialog.country ?? "" })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog({ kind: "closed" })}>
                {t("close")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {dialog.kind === "request" ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{t("permissionNeededTitle", { name: dialog.label })}</DialogTitle>
              <DialogDescription>{t("permissionNeededBody")}</DialogDescription>
            </DialogHeader>
            {dialog.canRequest ? (
              <Textarea
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
                maxLength={1024}
                rows={3}
                aria-label={t("permissionRequestMessage")}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("permissionRequestLimited")}</p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog({ kind: "closed" })}>
                {t("cancel")}
              </Button>
              {dialog.canRequest ? (
                <Button onClick={() => void sendRequest()} disabled={sending || !requestText.trim()}>
                  {sending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("sendPermissionRequest")}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  return { begin, checking, node, calls };
}
