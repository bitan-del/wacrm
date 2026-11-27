/* Test harness: a voice server on an ephemeral port, a callback sink, an API client. */
import http from "node:http";
import { loadConfig } from "../../src/config.js";
import { createVoiceServer } from "../../src/server.js";
import { createLogger } from "../../src/log.js";
import { verifySignature } from "../../src/callback.js";
import { waitFor } from "./fakeMeta.js";

export const SECRET = "test-secret-0123456789abcdef";

let portBase = 41000;
/** Config for tests: loopback media, its own UDP range per server, short timers. */
export function testConfig(over = {}) {
  const base = loadConfig({});
  const min = portBase; portBase += 60;
  return {
    ...base, secret: SECRET, host: "127.0.0.1", port: 0, bindIp: "127.0.0.1", publicIp: "",
    rtcPortMin: min, rtcPortMax: min + 50, stunUrl: "", logLevel: process.env.TEST_LOG || "silent",
    hangupFallbackMs: 1500, ...over,
  };
}

export async function startServer(cfg = testConfig(), opts = {}) {
  const vs = createVoiceServer(cfg, { log: createLogger(cfg.logLevel, "voice"), ...opts });
  await new Promise((r) => vs.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + vs.server.address().port;
  return { ...vs, cfg, base, close: () => vs.shutdown("test_teardown", 2000) };
}

export async function api(base, method, path, body, token = SECRET) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** HTTP server that records signed events posted by the voice server. */
export async function startCallbackSink({ failFirst = 0 } = {}) {
  const events = [];
  let failures = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (failures < failFirst) { failures++; res.writeHead(503); return res.end(); }
      let body = null; try { body = JSON.parse(raw); } catch {}
      events.push({ body, raw, signature: req.headers["x-voice-signature"], validSignature: verifySignature(raw, req.headers["x-voice-signature"], SECRET), at: Date.now(), headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + server.address().port + "/api/whatsapp/calls/ai-events";
  return {
    url, events,
    of: (sessionId, type) => events.filter((e) => e.body && e.body.session_id === sessionId && (!type || e.body.type === type)),
    waitFor: (sessionId, type, timeout = 8000) => waitFor(() => events.find((e) => e.body && e.body.session_id === sessionId && e.body.type === type), { timeout, what: type + " event" }),
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export function sessionBody(over = {}) {
  return {
    session_id: "test-" + Math.random().toString(36).slice(2, 10),
    direction: "inbound",
    persona: { name: "Aisha", voice: "Kore", language: "en-IN", greeting: "Hello from the mock agent", instructions: "Be helpful.", max_duration_seconds: 120 },
    context: { customer_name: "Ravi", customer_phone: "+919800000000", business_name: "Acme", notes: "VIP" },
    gemini: { api_key: "mock" },
    ...over,
  };
}
