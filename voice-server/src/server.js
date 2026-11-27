/* HTTP API (node:http, JSON in/out).

   GET  /health                              (no auth)  { ok, sessions, version }
   POST /v1/sessions                                    { sdp, type }
   GET  /v1/sessions/:id                                session state + media/AI counters (ops/debug)
   POST /v1/sessions/:id/remote-description  {sdp}      { ok: true }        outbound only
   POST /v1/sessions/:id/start                          { ok: true }        idempotent
   POST /v1/sessions/:id/end                 {reason}   { ok: true }        idempotent
   Every /v1 route needs `Authorization: Bearer <VOICE_SERVER_SECRET>`. */
import http from "node:http";
import crypto from "node:crypto";
import { VoiceSession } from "./session.js";
import { VERSION } from "./config.js";
import { createLogger } from "./log.js";

const MAX_BODY = 512 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) { failed = true; reject(new HttpError(413, "body too large")); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      let v;
      try { v = JSON.parse(raw); } catch { return reject(new HttpError(400, "invalid JSON")); }
      if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "body must be a JSON object"));
      resolve(v);
    });
    req.on("error", (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

function authorized(req, secret) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !secret) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const isStr = (v) => typeof v === "string";
const optStr = (v, name, max) => {
  if (v == null) return undefined;
  if (!isStr(v)) throw new HttpError(400, name + " must be a string");
  if (v.length > max) throw new HttpError(400, name + " is too long");
  return v;
};

function validateCreate(body, cfg) {
  const id = body.session_id;
  if (!isStr(id) || !SESSION_ID_RE.test(id)) throw new HttpError(400, "session_id is required (1-128 chars: letters, digits, . _ : -)");
  const direction = body.direction;
  if (direction !== "inbound" && direction !== "outbound") throw new HttpError(400, 'direction must be "inbound" or "outbound"');
  let sdpOffer;
  if (direction === "inbound") {
    sdpOffer = body.sdp_offer;
    if (!isStr(sdpOffer) || !/^v=0/.test(sdpOffer.trim()) || !/\nm=audio /.test(sdpOffer)) throw new HttpError(400, "sdp_offer (Meta's SDP offer with an audio m-line) is required for inbound sessions");
    if (sdpOffer.length > 64 * 1024) throw new HttpError(400, "sdp_offer is too long");
  }
  const p = body.persona == null ? {} : body.persona;
  if (typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "persona must be an object");
  const persona = {
    name: optStr(p.name, "persona.name", 200),
    voice: optStr(p.voice, "persona.voice", 64),
    language: optStr(p.language, "persona.language", 35),
    greeting: optStr(p.greeting, "persona.greeting", 2000),
    instructions: optStr(p.instructions, "persona.instructions", 100000),
    max_duration_seconds: p.max_duration_seconds == null ? undefined : Number(p.max_duration_seconds),
  };
  if (persona.max_duration_seconds !== undefined && !(persona.max_duration_seconds > 0)) throw new HttpError(400, "persona.max_duration_seconds must be a positive number");
  const c = body.context == null ? {} : body.context;
  if (typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "context must be an object");
  const context = {
    customer_name: optStr(c.customer_name, "context.customer_name", 200),
    customer_phone: optStr(c.customer_phone, "context.customer_phone", 40),
    business_name: optStr(c.business_name, "context.business_name", 200),
    notes: optStr(c.notes, "context.notes", 20000),
  };
  const g = body.gemini == null ? {} : body.gemini;
  if (typeof g !== "object" || Array.isArray(g)) throw new HttpError(400, "gemini must be an object");
  const gemini = { api_key: optStr(g.api_key, "gemini.api_key", 512), model: optStr(g.model, "gemini.model", 128) };
  if (!gemini.api_key && !cfg.geminiApiKey) throw new HttpError(400, "gemini.api_key is required");
  if (gemini.api_key === "mock" && !cfg.allowMockAi) throw new HttpError(400, "mock AI is disabled on this server");
  const cb = body.callback;
  let url;
  try { url = new URL(cb && cb.url); } catch { throw new HttpError(400, "callback.url must be an absolute http(s) URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "callback.url must be an absolute http(s) URL");
  return { id, direction, sdpOffer, persona, context, gemini, callback: { url: url.toString() } };
}

/**
 * @param {object} cfg loadConfig() result
 * @param {{log?:object, deps?:object}} [opts] deps are passed to every session (tests)
 */
export function createVoiceServer(cfg, opts = {}) {
  const log = opts.log || createLogger(cfg.logLevel, "voice");
  const sessions = new Map(); // live
  const recent = new Map(); // ended, kept a while so /end and GET stay idempotent

  const lookup = (id) => sessions.get(id) || recent.get(id) || null;

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";

    if (path === "/health" && (method === "GET" || method === "HEAD")) return send(res, 200, { ok: true, sessions: sessions.size, version: VERSION });

    if (!path.startsWith("/v1/")) throw new HttpError(404, "not found");
    if (!authorized(req, cfg.secret)) throw new HttpError(401, "unauthorized");

    if (path === "/v1/sessions" && method === "POST") {
      const v = validateCreate(await readJson(req), cfg);
      if (sessions.has(v.id)) throw new HttpError(409, "session already exists");
      if (sessions.size >= cfg.maxSessions) throw new HttpError(503, "at capacity");
      recent.delete(v.id);
      const slog = log.child(v.id.slice(0, 13));
      const s = new VoiceSession({ ...v, config: cfg, log: slog, deps: opts.deps });
      sessions.set(v.id, s);
      s.once("ended", () => {
        if (sessions.get(v.id) === s) sessions.delete(v.id);
        recent.set(v.id, s);
        const t = setTimeout(() => { if (recent.get(v.id) === s) recent.delete(v.id); }, cfg.endedRetentionMs);
        t.unref?.();
      });
      slog.info("new " + v.direction + " session (" + (s.mock ? "mock AI" : "gemini") + ")");
      let sdp;
      try { sdp = await s.init(v.sdpOffer); }
      catch (e) {
        sessions.delete(v.id); recent.delete(v.id);
        slog.error("setup failed: " + e.message);
        throw new HttpError(v.direction === "inbound" ? 400 : 500, "could not create the media session: " + e.message);
      }
      return send(res, 200, { sdp, type: v.direction === "inbound" ? "answer" : "offer" });
    }

    const m = /^\/v1\/sessions\/([^/]+)(?:\/(remote-description|start|end))?$/.exec(path);
    if (!m) throw new HttpError(404, "not found");
    const id = decodeURIComponent(m[1]), action = m[2] || "";
    const s = lookup(id);
    if (!s) throw new HttpError(404, "unknown session");

    if (!action && method === "GET") return send(res, 200, s.info());
    if (method !== "POST" || !action) throw new HttpError(404, "not found");

    if (action === "end") {
      const body = await readJson(req).catch(() => ({}));
      const reason = isStr(body.reason) && body.reason.trim() ? body.reason.trim().slice(0, 200) : "app_ended";
      const already = s.ended;
      if (!already) { s.log.info("end requested by the app (" + reason + ")"); s.end(reason); }
      return send(res, 200, { ok: true, ...(already ? { already_ended: true } : {}) });
    }
    if (action === "start") {
      if (s.ended) throw new HttpError(409, "session ended");
      try { s.start(); } catch (e) { throw new HttpError(e.status || 500, e.message); }
      return send(res, 200, { ok: true });
    }
    if (action === "remote-description") {
      const body = await readJson(req);
      if (!isStr(body.sdp) || !/^v=0/.test(body.sdp.trim())) throw new HttpError(400, "sdp is required");
      try { await s.setRemoteDescription(body.sdp); } catch (e) { throw new HttpError(e.status || 500, e.message); }
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error("http " + req.method + " " + (req.url || "").split("?")[0] + ": " + (e && e.message));
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "internal error" : e.message });
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  /** End every live session (sending their "ended" events), then stop listening. */
  async function shutdown(reason = "server_shutdown", waitMs = 5000) {
    const pending = [...sessions.values()].map((s) => s.end(reason));
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    await new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
  }

  return { server, sessions, recent, shutdown, log };
}
