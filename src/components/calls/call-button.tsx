"use client";

import { useTranslations } from "next-intl";
import { Bot, Loader2, Phone, PhoneCall } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCallFlow } from "./call-flow";

const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60";

/**
 * Phone button in the conversation header. With no AI options switched
 * on it dials straight away; otherwise it opens a menu: call yourself,
 * let the WhatsApp AI agent call, or start the connected phone-AI call.
 */
export function CallButton({
  conversationId,
  contactLabel,
}: {
  conversationId: string;
  contactLabel: string;
}) {
  const t = useTranslations("Calls");
  const flow = useCallFlow();
  const calls = flow.calls;
  if (!calls || !calls.canCall) return null;

  const { whatsappAi, phoneAi } = calls.aiOptions;
  const busy = flow.checking || !!calls.active;
  const label = t("callContact", { name: contactLabel });
  const icon = flow.checking ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin" />
  ) : (
    <Phone className="h-3.5 w-3.5" />
  );

  if (!whatsappAi && !phoneAi) {
    return (
      <>
        <button
          type="button"
          onClick={() => void flow.begin(conversationId, contactLabel, "agent")}
          disabled={busy}
          aria-label={label}
          title={label}
          className={ICON_BUTTON}
        >
          {icon}
        </button>
        {flow.node}
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={flow.checking} aria-label={label} title={label} className={ICON_BUTTON}>
          {icon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          <DropdownMenuItem
            disabled={!!calls.active}
            onClick={() => void flow.begin(conversationId, contactLabel, "agent")}
          >
            <Phone className="size-4" />
            {t("menuCallYourself")}
          </DropdownMenuItem>
          {whatsappAi ? (
            <DropdownMenuItem onClick={() => void flow.begin(conversationId, contactLabel, "ai")}>
              <Bot className="size-4" />
              {t("menuAiWhatsappCall")}
            </DropdownMenuItem>
          ) : null}
          {phoneAi ? (
            <DropdownMenuItem
              onClick={() => void calls.startPhoneAiCall({ conversationId, label: contactLabel })}
            >
              <PhoneCall className="size-4" />
              {t("menuPhoneAiCall", { system: phoneAi.label })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {flow.node}
    </>
  );
}
