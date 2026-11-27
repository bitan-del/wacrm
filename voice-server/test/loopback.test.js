/* End-to-end on localhost: a werift peer plays Meta (ICE-lite, Opus 48k pt 111 +
   telephone-event pt 126), the voice server runs the mock AI. Real ICE, DTLS-SRTP, RTP, Opus. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeMeta, sleep, waitFor } from "./helpers/fakeMeta.js";
import { startServer, startCallbackSink, api, sessionBody, testConfig } from "./helpers/harness.js";

let srv, sink;
before(async () => { srv = await startServer(testConfig()); sink = await startCallbackSink(); });
after(async () => { await srv.close(); await sink.close(); });

function checkRtpStream(frames) {
  assert.ok(frames.length > 10, "enough packets");
  const ssrc = frames[0].ssrc;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    assert.equal(b.ssrc, ssrc, "constant SSRC");
    assert.equal(b.pt, 111, "opus payload type");
    assert.equal((b.seq - a.seq) & 0xffff, 1, "sequence numbers step by 1 at packet " + i);
    assert.equal((b.ts - a.ts) >>> 0, 960, "timestamps step by 960 (20 ms @ 48 kHz) at packet " + i);
    assert.equal(b.marker, false, "marker only on the first packet");
  }
}

test("inbound: Meta offer → answer, ICE/DTLS, silence before /start, greeting, two-way audio, DTMF, signed ended event", async () => {
  const meta = new FakeMeta();
  try {
    const offer = await meta.offer();
    const body = sessionBody({ direction: "inbound", sdp_offer: offer, callback: { url: sink.url } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200, created.text);
    const answer = created.json.sdp;
    assert.equal(created.json.type, "answer");
    for (const re of [/^v=0\r\n/, /a=setup:active/, /m=audio \d+ UDP\/TLS\/RTP\/SAVPF 111 126/, /a=rtpmap:111 opus\/48000\/2/, /a=rtpmap:126 telephone-event\/8000/, /a=sendrecv/, /a=rtcp-mux/, /a=group:BUNDLE/, /a=fingerprint:sha-256 /, /a=candidate:\S+ 1 udp \d+ 127\.0\.0\.1 \d+ typ host/, /c=IN IP4 127\.0\.0\.1/])
      assert.match(answer, re);
    assert.doesNotMatch(answer, /a=ice-lite/);

    await meta.applyAnswer(answer);
    await meta.waitConnected();
    meta.startMedia();

    // before /start: media flows (keepalive) but it is silence, and the AI is warm but quiet
    await sleep(700);
    const pre = meta.audioFrames();
    assert.ok(pre.length >= 20, "server sends RTP before /start (got " + pre.length + ")");
    assert.ok(pre[0].marker, "first packet carries the marker bit");
    checkRtpStream(meta.rx.filter((r) => r.pt === 111));
    assert.ok(meta.maxRms() < 50, "silence before /start");
    let info = (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json;
    assert.equal(info.state, "setup");
    assert.equal(info.ai.ready, true);
    assert.equal(info.ai.kicked, false);
    assert.ok(info.media.rtp_in > 20, "server receives Meta's RTP");
    assert.equal(info.media.frames_to_ai, 0, "no customer audio goes to the AI before /start");

    // pacing: ~50 packets/s
    const t1 = meta.now(); await sleep(1000);
    const n = meta.audioFrames(t1, t1 + 1000).length;
    assert.ok(n >= 45 && n <= 55, "≈50 packets per second, got " + n);

    // /start → greeting (mock: 440 Hz for 1 s)
    const tStart = meta.now();
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start")).status, 200);
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start")).status, 200, "start is idempotent");
    const greetAt = await waitFor(() => meta.firstToneAt(440, tStart), { timeout: 3000, what: "greeting audio" });
    assert.ok(greetAt - tStart < 1000, "greeting starts within 1 s of /start (" + Math.round(greetAt - tStart) + " ms)");
    await sleep(1300);
    const greetMs = meta.toneMs(440, tStart);
    assert.ok(greetMs >= 800 && greetMs <= 1200, "≈1 s of 440 Hz greeting received, got " + greetMs + " ms");

    // the customer speaks (1 kHz, 600 ms) → the mock hears it and answers at 700 Hz
    const tSpeak = meta.now();
    meta.playTone(1000, 600);
    await waitFor(() => meta.toneMs(700, tSpeak) >= 400, { timeout: 4000, what: "reply audio" });

    await meta.sendDtmf("5");
    await waitFor(async () => (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json.media.dtmf >= 1, { timeout: 2000, what: "DTMF" });
    await sleep(200);

    info = (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json;
    assert.equal(info.state, "live");
    assert.ok(info.media.frames_to_ai > 50, "customer audio reaches the AI");
    assert.equal(info.media.dtmf, 1, "one key press reported once");
    assert.equal(info.media.decode_errors, 0);
    assert.equal(info.media.lost, 0);

    const end = await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "customer_hangup" });
    assert.equal(end.status, 200);
    assert.deepEqual(end.json, { ok: true });
    const ended = await sink.waitFor(body.session_id, "ended");
    assert.equal(ended.validSignature, true, "X-Voice-Signature verifies");
    assert.match(ended.signature, /^sha256=[0-9a-f]{64}$/);
    const ev = ended.body;
    assert.equal(ev.reason, "customer_hangup");
    assert.ok(ev.duration_seconds >= 3, "duration counted from /start: " + ev.duration_seconds);
    const roles = ev.transcript.map((t) => t.role + ": " + t.text);
    assert.equal(ev.transcript[0].role, "agent");
    assert.equal(ev.transcript[0].text, "Hello from the mock agent");
    const heard = ev.transcript.find((t) => t.role === "customer" && /^heard \d+ Hz/.test(t.text));
    assert.ok(heard, "customer turn transcribed: " + JSON.stringify(roles));
    const f = Number(/heard (\d+) Hz/.exec(heard.text)[1]);
    assert.ok(Math.abs(f - 1000) <= 30, "the AI heard ~1000 Hz after Opus decode + 48→16 kHz, got " + f);
    assert.ok(ev.transcript.some((t) => t.role === "agent" && t.text === "reply 1"));
    assert.ok(ev.transcript.some((t) => t.role === "customer" && t.text === "[pressed 5]"));
    for (const t of ev.transcript) assert.ok(!Number.isNaN(Date.parse(t.at)), "ISO timestamp");
    assert.equal(ev.notes.dtmf, "5");
    assert.equal(ev.summary, "Mock call: greeted the customer.");

    // idempotent end, exactly one "ended"
    const again = await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", {});
    assert.equal(again.status, 200);
    assert.equal(again.json.already_ended, true);
    await sleep(300);
    assert.equal(sink.of(body.session_id, "ended").length, 1);
    assert.equal(sink.of(body.session_id, "error").length, 0);
    assert.equal((await api(srv.base, "GET", "/health", undefined, null)).json.sessions, 0);
  } finally { await meta.close(); }
});

test("inbound: barge-in flushes queued AI audio", async () => {
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, persona: { greeting: "hi", instructions: "[mock:greeting_ms=300] [mock:reply_ms=4000]" } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200, created.text);
    await meta.applyAnswer(created.json.sdp);
    await meta.waitConnected(); meta.startMedia();
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    await sleep(600);
    const tSpeak = meta.now();
    meta.playTone(1000, 400);
    const replyAt = await waitFor(() => meta.firstToneAt(700, tSpeak), { timeout: 4000, what: "4 s reply" });
    await waitFor(() => meta.now() > replyAt + 600, { timeout: 2000 });
    meta.playTone(1200, 400); // the customer talks over the AI
    await sleep(4500);
    const replyMs = meta.toneMs(700, tSpeak);
    const info = (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json;
    assert.ok(info.ai.interruptions >= 1, "interruption seen");
    // ≥1 s of the 4 s reply was still queued when the customer cut in. The
    // exact figure depends on detection latency, which drifts on a loaded
    // machine (1480 ms was observed), so don't pin it tighter than that.
    assert.ok(info.ai.flushed_ms >= 1000, "queued audio flushed: " + info.ai.flushed_ms + " ms");
    assert.ok(replyMs >= 400 && replyMs <= 2200, "only the part before the barge-in played (" + replyMs + " of 4000 ms)");
    assert.ok(meta.toneMs(800, tSpeak) > 300, "the AI answered the interruption (reply 2)");
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "done" });
    await sink.waitFor(body.session_id, "ended");
  } finally { await meta.close(); }
});

test("outbound: server offer → Meta answer, end_call → hangup_requested after the goodbye, fallback end", async () => {
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ direction: "outbound", callback: { url: sink.url }, persona: { greeting: "Hi, calling from Acme", instructions: "[mock:end_call]", max_duration_seconds: 60 } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200, created.text);
    assert.equal(created.json.type, "offer");
    const offer = created.json.sdp;
    for (const re of [/a=setup:actpass/, /m=audio \d+ UDP\/TLS\/RTP\/SAVPF 111 126\r\n/, /a=rtpmap:111 opus\/48000\/2/, /a=fmtp:111 minptime=10;useinbandfec=1/, /a=rtpmap:126 telephone-event\/8000/, /a=sendrecv/, /a=rtcp-mux/, /a=group:BUNDLE 0/, /a=candidate:/, /a=end-of-candidates/])
      assert.match(offer, re);
    assert.doesNotMatch(offer, /m=video|m=application/, "audio only");

    const early = await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    assert.equal(early.status, 409, "cannot start before Meta's answer");

    const answer = await meta.answer(offer);
    assert.match(answer, /a=ice-lite/); assert.match(answer, /a=setup:active/);
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/remote-description", { sdp: answer })).status, 200);
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/remote-description", { sdp: answer })).status, 200, "same answer again is fine");
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/remote-description", { sdp: answer.replace("a=sendrecv", "a=recvonly") })).status, 409, "a different answer is refused");
    await meta.waitConnected(); meta.startMedia();
    await sleep(300);
    assert.ok(meta.audioFrames().length > 5, "keepalive media before pickup");

    const tStart = meta.now();
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    await waitFor(() => meta.firstToneAt(440, tStart), { timeout: 3000, what: "greeting" });
    await sleep(1100);
    const tSpeak = meta.now();
    meta.playTone(1000, 500);
    const hang = await sink.waitFor(body.session_id, "hangup_requested", 8000);
    assert.equal(hang.validSignature, true);
    assert.equal(hang.body.reason, "mock_done");
    const heardGoodbye = meta.toneMs(700, tSpeak, meta.now());
    assert.ok(heardGoodbye >= 700, "hangup_requested only after the goodbye played (" + heardGoodbye + " of 800 ms)");
    checkRtpStream(meta.rx.filter((r) => r.pt === 111));

    // the app never calls /end here: the server ends the session itself after HANGUP_FALLBACK_MS
    const ended = await sink.waitFor(body.session_id, "ended", 5000);
    assert.equal(ended.body.reason, "agent_hangup");
    const order = sink.of(body.session_id).map((e) => e.body.type);
    assert.deepEqual(order, ["hangup_requested", "ended"]);
    assert.ok(ended.body.transcript.some((t) => t.role === "agent" && t.text === "Hi, calling from Acme"));
    assert.equal((await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "late" })).json.already_ended, true);
  } finally { await meta.close(); }
});

test("AI connection failure → error event, then ended", async () => {
  const meta = new FakeMeta();
  const srv2 = await startServer(testConfig({ geminiWsUrl: "ws://127.0.0.1:9/nothing-listens-here" }));
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, gemini: { api_key: "not-a-real-key" } });
    const created = await api(srv2.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200, "the SDP is still returned: " + created.text);
    const err = await sink.waitFor(body.session_id, "error");
    assert.match(err.body.message, /AI connection failed/);
    assert.doesNotMatch(err.raw, /not-a-real-key/, "the key never leaks into events");
    const ended = await sink.waitFor(body.session_id, "ended");
    assert.equal(ended.body.reason, "ai_error");
    assert.equal(ended.body.duration_seconds, 0);
    await sleep(200);
    assert.deepEqual(sink.of(body.session_id).map((e) => e.body.type), ["error", "ended"]);
  } finally { await meta.close(); await srv2.close(); }
});

test("max_duration_seconds ends the call", async () => {
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, persona: { greeting: "hi", max_duration_seconds: 10 } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200);
    await meta.applyAnswer(created.json.sdp); await meta.waitConnected(); meta.startMedia();
    const s = srv.sessions.get(body.session_id);
    assert.equal(s.maxDurationSec, 10);
    s.maxDurationSec = 1.5; // shorten for the test (API values are clamped to 10..3600 s); the timer starts at /start
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    const ended = await sink.waitFor(body.session_id, "ended", 5000);
    assert.equal(ended.body.reason, "max_duration");
  } finally { await meta.close(); }
});

test("no inbound RTP after /start ends the call (no_media)", async () => {
  const meta = new FakeMeta();
  const srv3 = await startServer(testConfig({ noMediaTimeoutSec: 2 }));
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url } });
    const created = await api(srv3.base, "POST", "/v1/sessions", body);
    await meta.applyAnswer(created.json.sdp); await meta.waitConnected();
    // Meta never sends media
    await api(srv3.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    const ended = await sink.waitFor(body.session_id, "ended", 6000);
    assert.equal(ended.body.reason, "no_media");
  } finally { await meta.close(); await srv3.close(); }
});

test("concurrent calls: parallel session creation gets distinct UDP ports, every call connects and hears its greeting", async () => {
  const N = 8;
  const metas = Array.from({ length: N }, () => new FakeMeta());
  try {
    const offers = await Promise.all(metas.map((m) => m.offer()));
    const bodies = offers.map((o) => sessionBody({ sdp_offer: o, callback: { url: sink.url } }));
    const created = await Promise.all(bodies.map((b) => api(srv.base, "POST", "/v1/sessions", b)));
    const ports = created.map((r) => { assert.equal(r.status, 200, r.text); return /a=candidate:\S+ 1 udp \d+ \S+ (\d+) typ host/.exec(r.json.sdp)[1]; });
    assert.equal(new Set(ports).size, N, "distinct ports: " + ports.join(","));
    for (const p of ports) assert.ok(Number(p) >= srv.cfg.rtcPortMin && Number(p) <= srv.cfg.rtcPortMax, "port in RTC range");
    await Promise.all(metas.map((m, i) => m.applyAnswer(created[i].json.sdp)));
    await Promise.all(metas.map((m) => m.waitConnected()));
    metas.forEach((m) => m.startMedia());
    const cpu0 = process.cpuUsage(), t0 = Date.now();
    await Promise.all(bodies.map((b) => api(srv.base, "POST", "/v1/sessions/" + b.session_id + "/start")));
    await Promise.all(metas.map((m) => waitFor(() => m.toneMs(440) >= 800, { timeout: 5000, what: "greeting on every call" })));
    const cpu = process.cpuUsage(cpu0), wall = Date.now() - t0;
    // the whole process (server + 8 fake Metas, both ends encoding/decoding) — for information
    console.log(`# ${N} calls (both ends in-process): ${(100 * (cpu.user + cpu.system) / 1000 / wall).toFixed(0)}% of one core`);
    for (const b of bodies) await api(srv.base, "POST", "/v1/sessions/" + b.session_id + "/end", { reason: "done" });
    for (const b of bodies) assert.equal((await sink.waitFor(b.session_id, "ended")).body.reason, "done");
  } finally { await Promise.all(metas.map((m) => m.close())); }
});
