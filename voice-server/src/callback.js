import crypto from "node:crypto";
import { VERSION } from "./config.js";

/** `sha256=<hex HMAC-SHA256 of the raw body>` — the X-Voice-Signature header value. */
export function signBody(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time check of an X-Voice-Signature header (what the app should do on receipt). */
export function verifySignature(rawBody, header, secret) {
  const want = Buffer.from(signBody(rawBody, secret));
  const got = Buffer.from(String(header || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one event as JSON with the HMAC header. Retries twice (300 ms, then 1.2 s) on a network
 * error, a timeout or a 5xx; a 4xx is final. Never throws: resolves { ok, status?, attempts, error? }.
 */
export async function postEvent(url, payload, { secret, retries = 2, backoffMs = [300, 1200], timeoutMs = 5000, fetchImpl = globalThis.fetch, log } = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "wacrm-voice-server/" + VERSION,
    "X-Voice-Signature": signBody(body, secret),
    "X-Voice-Event": String(payload.type || ""),
  };
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
      try { await res.arrayBuffer(); } catch {}
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, attempts: attempt + 1 };
      lastErr = "HTTP " + res.status;
      if (res.status < 500) { log?.warn("callback", payload.type, "rejected:", lastErr); return { ok: false, status: res.status, attempts: attempt + 1, error: lastErr }; }
    } catch (e) {
      const c = e && e.cause;
      lastErr = (e && e.name === "TimeoutError" ? "timeout after " + timeoutMs + " ms" : "") || c?.code || c?.errors?.[0]?.code || c?.message || e?.message || "network error";
    }
    log?.warn("callback", payload.type, "attempt", attempt + 1, "failed:", lastErr);
  }
  return { ok: false, attempts: retries + 1, error: lastErr };
}
