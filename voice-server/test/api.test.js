/* HTTP contract: auth, 404s, validation, idempotency, capacity, a Meta-style offer. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startServer, startCallbackSink, api, sessionBody, testConfig, SECRET } from "./helpers/harness.js";
import { VERSION } from "../src/config.js";

const META_OFFER = readFileSync(new URL("./fixtures/meta-offer.sdp", import.meta.url), "utf8");
let srv, sink;
before(async () => { srv = await startServer(testConfig({ maxSessions: 2 })); sink = await startCallbackSink(); });
after(async () => { await srv.close(); await sink.close(); });

test("GET /health needs no auth", async () => {
  const r = await api(srv.base, "GET", "/health", undefined, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, sessions: 0, version: VERSION });
});

test("/v1 routes: 401 without or with a wrong bearer token", async () => {
  for (const [m, p] of [["POST", "/v1/sessions"], ["POST", "/v1/sessions/x/start"], ["POST", "/v1/sessions/x/end"], ["POST", "/v1/sessions/x/remote-description"], ["GET", "/v1/sessions/x"]]) {
    const body = m === "GET" ? undefined : {};
    assert.equal((await api(srv.base, m, p, body, null)).status, 401, m + " " + p + " without token");
    assert.equal((await api(srv.base, m, p, body, SECRET + "x")).status, 401, m + " " + p + " wrong token");
  }
  const raw = await fetch(srv.base + "/v1/sessions/x/start", { method: "POST", headers: { Authorization: "Basic " + SECRET } });
  assert.equal(raw.status, 401);
  assert.deepEqual(await raw.json(), { error: "unauthorized" });
});

test("unknown session → 404 on every session route; unknown path → 404", async () => {
  assert.equal((await api(srv.base, "POST", "/v1/sessions/nope/start")).status, 404);
  assert.equal((await api(srv.base, "POST", "/v1/sessions/nope/end", { reason: "x" })).status, 404);
  assert.equal((await api(srv.base, "POST", "/v1/sessions/nope/remote-description", { sdp: "v=0" })).status, 404);
  assert.equal((await api(srv.base, "GET", "/v1/sessions/nope")).status, 404);
  assert.equal((await api(srv.base, "GET", "/v1/whatever")).status, 404);
  assert.equal((await api(srv.base, "GET", "/nope", undefined, null)).status, 404);
});

test("POST /v1/sessions validation → 400", async () => {
  const cb = { url: sink.url };
  const cases = [
    ["invalid JSON", "{not json"],
    ["missing session_id", { ...sessionBody({ callback: cb, sdp_offer: META_OFFER }), session_id: undefined }],
    ["bad session_id", sessionBody({ session_id: "has spaces", callback: cb, sdp_offer: META_OFFER })],
    ["bad direction", sessionBody({ direction: "sideways", callback: cb })],
    ["inbound without sdp_offer", sessionBody({ direction: "inbound", callback: cb })],
    ["inbound with junk sdp", sessionBody({ direction: "inbound", sdp_offer: "hello", callback: cb })],
    ["no callback", sessionBody({ sdp_offer: META_OFFER })],
    ["bad callback url", sessionBody({ sdp_offer: META_OFFER, callback: { url: "ftp://x/y" } })],
    ["no gemini key", sessionBody({ sdp_offer: META_OFFER, callback: cb, gemini: {} })],
    ["persona not object", sessionBody({ sdp_offer: META_OFFER, callback: cb, persona: "x" })],
    ["bad max duration", sessionBody({ sdp_offer: META_OFFER, callback: cb, persona: { max_duration_seconds: -5 } })],
  ];
  for (const [name, body] of cases) {
    const r = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(r.status, 400, name + ": " + r.text);
    assert.equal(typeof r.json.error, "string", name);
  }
  assert.equal(srv.sessions.size, 0);
});

test("Meta-style inbound offer (ICE-lite, mid 'audio', transport-cc) → valid answer; contract details", async () => {
  const body = sessionBody({ sdp_offer: META_OFFER, callback: { url: sink.url } });
  const r = await api(srv.base, "POST", "/v1/sessions", body);
  assert.equal(r.status, 200, r.text);
  const a = r.json.sdp;
  for (const re of [/a=group:BUNDLE audio/, /a=mid:audio/, /m=audio \d+ UDP\/TLS\/RTP\/SAVPF 111 126/, /a=rtpmap:111 opus\/48000\/2/, /a=rtpmap:126 telephone-event\/8000/, /a=setup:active/, /a=sendrecv/, /a=rtcp-mux/, /a=ice-ufrag:\S+/, /a=ice-pwd:\S+/, /a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}/, /a=candidate:/, /a=end-of-candidates/])
    assert.match(a, re);
  assert.ok(a.endsWith("\r\n"));
  assert.equal((await api(srv.base, "GET", "/health", undefined, null)).json.sessions, 1);

  assert.equal((await api(srv.base, "POST", "/v1/sessions", body)).status, 409, "duplicate session_id");
  const rd = await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/remote-description", { sdp: META_OFFER });
  assert.equal(rd.status, 409, "remote-description is outbound-only");
  const info = await api(srv.base, "GET", "/v1/sessions/" + body.session_id);
  assert.equal(info.json.state, "setup"); assert.equal(info.json.direction, "inbound"); assert.equal(info.json.ai.mode, "mock");

  const end = await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "rejected_by_app" });
  assert.deepEqual(end.json, { ok: true });
  const ended = (await sink.waitFor(body.session_id, "ended")).body;
  assert.deepEqual(Object.keys(ended).sort(), ["duration_seconds", "notes", "reason", "session_id", "summary", "transcript", "type"]);
  assert.equal(ended.duration_seconds, 0); assert.deepEqual(ended.transcript, []); assert.deepEqual(ended.notes, {}); assert.equal(ended.summary, "");
  assert.equal(ended.reason, "rejected_by_app");
  assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start")).status, 409, "cannot start an ended session");
  assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end")).json.already_ended, true);
  assert.equal((await api(srv.base, "GET", "/health", undefined, null)).json.sessions, 0);
});

test("outbound: remote-description requires sdp; capacity → 503", async () => {
  const a = sessionBody({ direction: "outbound", callback: { url: sink.url } });
  const b = sessionBody({ direction: "outbound", callback: { url: sink.url } });
  const c = sessionBody({ direction: "outbound", callback: { url: sink.url } });
  try {
    assert.equal((await api(srv.base, "POST", "/v1/sessions", a)).status, 200);
    assert.equal((await api(srv.base, "POST", "/v1/sessions", b)).status, 200);
    assert.equal((await api(srv.base, "POST", "/v1/sessions", c)).status, 503, "maxSessions = 2");
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + a.session_id + "/remote-description", {})).status, 400);
    const broken = await api(srv.base, "POST", "/v1/sessions/" + a.session_id + "/remote-description", { sdp: "v=0\r\nbroken" });
    assert.equal(broken.status, 400, broken.text);
    const noCand = await api(srv.base, "POST", "/v1/sessions/" + a.session_id + "/remote-description", { sdp: META_OFFER.replace(/a=candidate:.*\r\n/g, "") });
    assert.equal(noCand.status, 400, "an SDP without candidates cannot connect (no trickle): " + noCand.text);
    assert.equal((await api(srv.base, "GET", "/v1/sessions/" + a.session_id)).json.media.remote_description, false);
  } finally {
    for (const s of [a, b]) await api(srv.base, "POST", "/v1/sessions/" + s.session_id + "/end", {});
  }
  await sink.waitFor(a.session_id, "ended"); await sink.waitFor(b.session_id, "ended");
});

test("events carry a valid signature and are retried when the app returns 5xx", async () => {
  const flaky = await startCallbackSink({ failFirst: 2 });
  try {
    const body = sessionBody({ sdp_offer: META_OFFER, callback: { url: flaky.url } });
    assert.equal((await api(srv.base, "POST", "/v1/sessions", body)).status, 200);
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "x" });
    const ev = await flaky.waitFor(body.session_id, "ended", 5000);
    assert.equal(ev.validSignature, true);
    assert.equal(flaky.of(body.session_id, "ended").length, 1);
  } finally { await flaky.close(); }
});
