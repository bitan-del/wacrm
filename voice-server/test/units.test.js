/* HMAC signing + callback delivery, DTMF, SDP helpers, prompt building, mock options. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { signBody, verifySignature, postEvent } from "../src/callback.js";
import { parseTelephoneEvent, buildTelephoneEvent, DtmfDetector } from "../src/dtmf.js";
import { finalizeSdp, parseAudioPayloadTypes } from "../src/rtc.js";
import { buildSystemInstruction, kickoffText, languagePinFor, TOOLS } from "../src/prompt.js";
import { mockOptionsFrom } from "../src/mockBrain.js";
import { loadConfig, validateConfig } from "../src/config.js";

test("signBody: HMAC-SHA256 hex with sha256= prefix (RFC 4231 test case 2)", () => {
  assert.equal(signBody("what do ya want for nothing?", "Jefe"), "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  const body = JSON.stringify({ session_id: "s", type: "ended" });
  assert.equal(signBody(body, "k"), "sha256=" + crypto.createHmac("sha256", "k").update(body).digest("hex"));
  assert.equal(verifySignature(body, signBody(body, "k"), "k"), true);
  assert.equal(verifySignature(body + " ", signBody(body, "k"), "k"), false);
  assert.equal(verifySignature(body, signBody(body, "other"), "k"), false);
  assert.equal(verifySignature(body, undefined, "k"), false);
});

async function sinkServer(statuses) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ raw: Buffer.concat(chunks).toString(), headers: req.headers });
      const st = statuses[Math.min(hits.length - 1, statuses.length - 1)];
      res.writeHead(st); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port + "/cb", hits, close: () => new Promise((r) => server.close(() => r())) };
}

test("postEvent: signed raw body, retries twice on 5xx, then succeeds", async () => {
  const s = await sinkServer([500, 502, 200]);
  try {
    const r = await postEvent(s.url, { session_id: "a", type: "ended", n: 1 }, { secret: "sec", backoffMs: [10, 10] });
    assert.deepEqual(r, { ok: true, status: 200, attempts: 3 });
    assert.equal(s.hits.length, 3);
    for (const h of s.hits) {
      assert.equal(h.headers["content-type"], "application/json");
      assert.equal(h.headers["x-voice-signature"], signBody(h.raw, "sec"));
      assert.equal(h.headers["x-voice-event"], "ended");
      assert.deepEqual(JSON.parse(h.raw), { session_id: "a", type: "ended", n: 1 });
    }
  } finally { await s.close(); }
});

test("postEvent: gives up after 3 attempts on 5xx, does not retry a 4xx, never throws when the app is down", async () => {
  const s5 = await sinkServer([503]);
  const s4 = await sinkServer([400]);
  try {
    const r5 = await postEvent(s5.url, { type: "x" }, { secret: "s", backoffMs: [5, 5] });
    assert.equal(r5.ok, false); assert.equal(r5.attempts, 3); assert.equal(s5.hits.length, 3);
    const r4 = await postEvent(s4.url, { type: "x" }, { secret: "s", backoffMs: [5, 5] });
    assert.equal(r4.ok, false); assert.equal(r4.status, 400); assert.equal(s4.hits.length, 1);
    const down = await postEvent("http://127.0.0.1:9/nope", { type: "x" }, { secret: "s", backoffMs: [5, 5] });
    assert.equal(down.ok, false); assert.equal(down.attempts, 3);
    const bad = await postEvent("not a url", { type: "x" }, { secret: "s", backoffMs: [5, 5] });
    assert.equal(bad.ok, false);
  } finally { await s5.close(); await s4.close(); }
});

test("DTMF: RFC 4733 parse/build and one digit per key press", () => {
  const p = buildTelephoneEvent({ digit: "#", end: true, volume: 10, duration: 1280 });
  assert.deepEqual(parseTelephoneEvent(p), { event: 11, digit: "#", end: true, volume: 10, duration: 1280 });
  assert.equal(parseTelephoneEvent(Buffer.from([1, 2])), null);
  const got = []; const d = new DtmfDetector((x) => got.push(x));
  for (const end of [false, false, true, true, true]) d.push(1000, buildTelephoneEvent({ digit: "7", end }));
  for (const end of [false, true, true]) d.push(2600, buildTelephoneEvent({ digit: "*", end }));
  d.push(4000, buildTelephoneEvent({ digit: "7" }));
  assert.deepEqual(got, ["7", "*", "7"]);
});

test("SDP: payload types from rtpmap; finalizeSdp sets c=/m= from the candidate and announces PUBLIC_IP", () => {
  const sdp = ["v=0", "o=- 1 0 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111 126", "c=IN IP4 0.0.0.0",
    "a=candidate:abc 1 udp 2116026367 10.128.0.5 40001 typ host generation 0", "a=end-of-candidates", "a=rtcp:9 IN IP4 0.0.0.0", "a=rtcp-mux",
    "a=rtpmap:111 opus/48000/2", "a=rtpmap:126 telephone-event/8000", ""].join("\r\n");
  assert.deepEqual(parseAudioPayloadTypes(sdp), { opus: 111, dtmf: [126] });
  assert.deepEqual(parseAudioPayloadTypes("a=rtpmap:109 OPUS/48000/2\na=rtpmap:101 telephone-event/48000\na=rtpmap:126 telephone-event/8000"), { opus: 109, dtmf: [101, 126] });
  const plain = finalizeSdp(sdp);
  assert.match(plain, /m=audio 40001 UDP/); assert.match(plain, /c=IN IP4 10\.128\.0\.5\r\n/); assert.match(plain, /a=rtcp:40001 IN IP4 10\.128\.0\.5/);
  const pub = finalizeSdp(sdp, { publicIp: "34.1.2.3" });
  assert.match(pub, /a=candidate:abc 1 udp 2116026367 34\.1\.2\.3 40001 typ host generation 0\r\n/);
  assert.match(pub, /c=IN IP4 34\.1\.2\.3\r\n/);
  assert.doesNotMatch(pub, /10\.128\.0\.5/);
  assert.ok(pub.endsWith("\r\n"));
});

test("prompt: preamble + persona instructions, language pin, kickoff, tools", () => {
  const sys = buildSystemInstruction({ name: "Aisha", language: "hi-IN", instructions: "SOUL TEXT" }, { business_name: "Acme", customer_name: "Ravi", notes: "Asked about prices" }, { direction: "outbound" });
  assert.match(sys, /^You are Aisha, speaking on behalf of Acme\./);
  assert.match(sys, /LIVE WHATSAPP VOICE CALL \(the business called the customer\)/);
  assert.match(sys, /keep replies short/);
  assert.match(sys, /customer's name is Ravi/);
  assert.match(sys, /Asked about prices/);
  assert.match(sys, /speak Hindi \(India\) \(hi-IN\)/);
  assert.ok(sys.endsWith("SOUL TEXT"));
  assert.match(buildSystemInstruction({ language: "auto" }, {}), /reply in the language the customer speaks/);
  assert.equal(languagePinFor("auto"), ""); assert.equal(languagePinFor("en-IN"), "en-IN"); assert.equal(languagePinFor("x y"), ""); assert.equal(languagePinFor(undefined), "");
  assert.match(kickoffText({ greeting: "Namaste!" }), /"Namaste!"/);
  assert.match(kickoffText({ name: "Aisha" }, { business_name: "Acme" }), /introduce yourself as Aisha from Acme/);
  assert.deepEqual(TOOLS.map((t) => [t.name, t.parameters.required]), [["end_call", ["reason"]], ["save_note", ["key", "value"]]]);
});

test("mock options from instruction tags; config validation", () => {
  assert.deepEqual(mockOptionsFrom("x [mock:reply_ms=4000] [mock:end_call]"), { greetingMs: 1000, replyMs: 4000, endCall: true });
  const cfg = loadConfig({ VOICE_SERVER_SECRET: "short", RTC_PORT_MIN: "5000", RTC_PORT_MAX: "5000", PUBLIC_IP: "nope" });
  const errs = validateConfig(cfg);
  assert.equal(errs.length, 3);
  const ok = loadConfig({ VOICE_SERVER_SECRET: "0123456789abcdef0123", PUBLIC_IP: "34.1.2.3", RTC_BIND_IP: "10.0.0.2" });
  assert.deepEqual(validateConfig(ok), []);
  assert.equal(ok.port, 8080); assert.equal(ok.rtcPortMin, 40000); assert.equal(ok.rtcPortMax, 40100); assert.equal(ok.bindIp, "10.0.0.2");
  assert.equal(ok.geminiModel, "gemini-3.1-flash-live-preview");
});
