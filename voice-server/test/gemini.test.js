/* The real GeminiLive client and session path against a local fake Gemini Live WebSocket server:
   checks the exact wire format (ported from the production bridge) and the call behaviour
   around it (silent until /start, audio both ways, tools, transcripts, language-pin fallback). */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GeminiLive, langPin } from "../src/gemini.js";
import { TOOLS } from "../src/prompt.js";
import { tone, int16ToBuffer, bufferToInt16, dominantFrequency } from "../src/audio.js";
import { startWsServer } from "./helpers/wsServer.js";
import { FakeMeta, sleep, waitFor } from "./helpers/fakeMeta.js";
import { startServer, startCallbackSink, api, sessionBody, testConfig } from "./helpers/harness.js";

/** A scriptable fake Gemini Live endpoint. */
async function fakeGemini(script = {}) {
  const st = { conns: [], setups: [], msgs: [], urls: [] };
  const ws = await startWsServer((conn) => {
    const c = { conn, msgs: [] };
    st.conns.push(c); st.urls.push(conn.req.url);
    conn.on("message", (txt) => {
      const m = JSON.parse(txt);
      c.msgs.push(m); st.msgs.push(m);
      if (m.setup) {
        st.setups.push(m.setup);
        if (script.onSetup) return script.onSetup(conn, m.setup, st);
        conn.send({ setupComplete: {} });
      } else if (script.onMessage) script.onMessage(conn, m, st);
    });
  });
  return { ...ws, st, count: (k) => st.msgs.filter((m) => m[k]).length };
}

function sendAudio24k(conn, freq, ms) {
  const total = 24 * ms;
  for (let off = 0; off < total; off += 960) {
    const pcm = tone(freq, 24000, Math.min(960, total - off), 8000, off);
    conn.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: int16ToBuffer(pcm).toString("base64") } }] } } });
  }
}

let sink;
before(async () => { sink = await startCallbackSink(); });
after(async () => { await sink.close(); });
beforeEach(() => { langPin.unsupported = false; });

test("GeminiLive: setup message, realtime input, clientContent, toolResponse, server events", async () => {
  const fg = await fakeGemini();
  const g = new GeminiLive({ apiKey: "k&ey", url: fg.url, voice: "Kore", systemInstruction: "SYS", tools: TOOLS, vad: { silenceMs: 250, prefixMs: 80, start: "low", endSensitivity: "low" }, thinking: "0", languageCode: "hi-IN" });
  const ev = { audio: [], transcript: [], tool: [], interrupted: 0, turn: 0, usage: 0 };
  g.on("audio", (b, r) => ev.audio.push({ b, r }));
  g.on("transcript", (t) => ev.transcript.push(t));
  g.on("toolCall", (t) => ev.tool.push(t));
  g.on("interrupted", () => ev.interrupted++);
  g.on("turnComplete", () => ev.turn++);
  g.on("usage", () => ev.usage++);
  try {
    g.connect();
    await new Promise((r) => g.once("ready", r));
    assert.match(fg.st.urls[0], /\?key=k%26ey$/);
    assert.deepEqual(fg.st.setups[0], {
      model: "models/gemini-3.1-flash-live-preview",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, languageCode: "hi-IN" },
        thinkingConfig: { thinkingBudget: 0 },
      },
      systemInstruction: { parts: [{ text: "SYS" }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_LOW", prefixPaddingMs: 80, silenceDurationMs: 250 } },
      tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    });
    g.sendAudio(Buffer.alloc(640, 1));
    g.kickoff("say hi");
    g.sendToolResponse("fc1", "save_note", { ok: true });
    await waitFor(() => fg.st.msgs.length >= 4, { timeout: 2000 });
    assert.deepEqual(fg.st.msgs[1], { realtimeInput: { audio: { data: Buffer.alloc(640, 1).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
    assert.deepEqual(fg.st.msgs[2], { clientContent: { turns: [{ role: "user", parts: [{ text: "say hi" }] }], turnComplete: true } });
    assert.deepEqual(fg.st.msgs[3], { toolResponse: { functionResponses: [{ id: "fc1", name: "save_note", response: { ok: true } }] } });

    const conn = fg.st.conns[0].conn;
    conn.send({ serverContent: { inputTranscription: { text: "haan" } } });
    conn.send({ serverContent: { outputTranscription: { text: "Namaste" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(96).toString("base64") } }] } } });
    conn.send({ serverContent: { turnComplete: true }, usageMetadata: { totalTokenCount: 5 } });
    conn.send({ serverContent: { interrupted: true } });
    conn.send({ toolCall: { functionCalls: [{ id: "x1", name: "end_call", args: { reason: "done" } }] } });
    await waitFor(() => ev.tool.length === 1, { timeout: 2000 });
    assert.deepEqual(ev.transcript, [{ role: "customer", text: "haan" }, { role: "agent", text: "Namaste" }]);
    assert.equal(ev.audio.length, 1); assert.equal(ev.audio[0].r, 24000); assert.equal(ev.audio[0].b.length, 96);
    assert.equal(ev.turn, 1); assert.equal(ev.interrupted, 1); assert.equal(ev.usage, 1);
    assert.deepEqual(ev.tool[0], { id: "x1", name: "end_call", args: { reason: "done" } });
  } finally { g.close(); await fg.close(); }
});

test("session ⇄ fake Gemini: silent until /start, greeting audio to Meta, 16 kHz customer audio to Gemini, tools, transcript", async () => {
  const fg = await fakeGemini({
    onMessage(conn, m, st) {
      if (m.clientContent) {
        conn.send({ serverContent: { outputTranscription: { text: "Namaste " } } });
        conn.send({ serverContent: { outputTranscription: { text: "Ravi ji" } } });
        sendAudio24k(conn, 440, 1000);
        conn.send({ serverContent: { turnComplete: true } });
        conn.send({ toolCall: { functionCalls: [{ id: "n1", name: "save_note", args: { key: "summary", value: "Greeted Ravi" } }] } });
      }
      if (m.realtimeInput && st.msgs.filter((x) => x.realtimeInput).length === 40) {
        conn.send({ serverContent: { inputTranscription: { text: "haan " } } });
        conn.send({ serverContent: { inputTranscription: { text: "ji" } } });
        conn.send({ serverContent: { outputTranscription: { text: "Dhanyavaad, bye" } } });
        sendAudio24k(conn, 660, 400);
        conn.send({ serverContent: { turnComplete: true } });
        conn.send({ toolCall: { functionCalls: [{ id: "e1", name: "end_call", args: { reason: "done" } }] } });
      }
    },
  });
  const srv = await startServer(testConfig({ geminiWsUrl: fg.url }));
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, gemini: { api_key: "test-key" }, persona: { name: "Aisha", voice: "Kore", language: "hi-IN", greeting: "Namaste, main Aisha", instructions: "SOUL: you sell tea." } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    assert.equal(created.status, 200, created.text);
    await meta.applyAnswer(created.json.sdp); await meta.waitConnected(); meta.startMedia();
    meta.playTone(1000, 30000); // the customer is already making noise before /start
    await waitFor(() => fg.st.setups.length === 1, { timeout: 3000, what: "gemini setup" });
    const setup = fg.st.setups[0];
    assert.equal(setup.model, "models/gemini-3.1-flash-live-preview");
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
    assert.equal(setup.generationConfig.speechConfig.languageCode, "hi-IN");
    const sys = setup.systemInstruction.parts[0].text;
    assert.match(sys, /You are Aisha, speaking on behalf of Acme/);
    assert.match(sys, /LIVE WHATSAPP VOICE CALL/);
    assert.match(sys, /customer's name is Ravi/);
    assert.match(sys, /SOUL: you sell tea\.$/);
    assert.deepEqual(setup.tools[0].functionDeclarations.map((f) => f.name), ["end_call", "save_note"]);
    assert.match(fg.st.urls[0], /key=test-key/);

    await sleep(800);
    assert.equal(fg.count("realtimeInput"), 0, "no customer audio to Gemini before /start");
    assert.equal(fg.count("clientContent"), 0, "no kickoff before /start");
    assert.ok(meta.maxRms() < 50, "Meta hears silence before /start");

    const tStart = meta.now();
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    await waitFor(() => fg.count("clientContent") === 1, { timeout: 2000, what: "kickoff" });
    const kick = fg.st.msgs.find((m) => m.clientContent).clientContent;
    assert.equal(kick.turnComplete, true);
    assert.match(kick.turns[0].parts[0].text, /Namaste, main Aisha/);
    await waitFor(() => meta.toneMs(440, tStart) >= 800, { timeout: 4000, what: "greeting audio at Meta" });

    await waitFor(() => fg.count("realtimeInput") >= 30, { timeout: 4000, what: "customer audio at Gemini" });
    const chunks = fg.st.msgs.filter((m) => m.realtimeInput).slice(5, 30).map((m) => m.realtimeInput.audio);
    for (const a of chunks) { assert.equal(a.mimeType, "audio/pcm;rate=16000"); assert.equal(Buffer.from(a.data, "base64").length, 640, "20 ms @ 16 kHz"); }
    const pcm16 = bufferToInt16(Buffer.concat(chunks.map((a) => Buffer.from(a.data, "base64"))));
    const f = dominantFrequency(pcm16, 16000);
    assert.ok(Math.abs(f - 1000) <= 20, "Gemini receives the customer's 1 kHz at 16 kHz, got " + f);

    await waitFor(() => fg.count("toolResponse") >= 1, { timeout: 3000 });
    assert.deepEqual(fg.st.msgs.find((m) => m.toolResponse).toolResponse, { functionResponses: [{ id: "n1", name: "save_note", response: { ok: true } }] });

    const hang = await sink.waitFor(body.session_id, "hangup_requested", 8000);
    assert.equal(hang.body.reason, "done");
    assert.ok(meta.toneMs(660, tStart) >= 300, "goodbye audio played before hangup_requested");
    const inputsAtHangup = fg.count("realtimeInput");
    await sleep(300);
    assert.ok(fg.count("realtimeInput") <= inputsAtHangup + 1, "customer audio stops going to Gemini once the hangup is requested");

    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", { reason: "app_hangup" });
    const ended = (await sink.waitFor(body.session_id, "ended")).body;
    assert.equal(ended.reason, "app_hangup");
    assert.deepEqual(ended.transcript.map((t) => [t.role, t.text]), [["agent", "Namaste Ravi ji"], ["customer", "haan ji"], ["agent", "Dhanyavaad, bye"]]);
    assert.deepEqual(ended.notes, { summary: "Greeted Ravi" });
    assert.equal(ended.summary, "Greeted Ravi");
    await waitFor(() => fg.st.conns[0].conn.closed, { timeout: 2000, what: "Gemini socket closed at the end" });
  } finally { await meta.close(); await srv.close(); await fg.close(); }
});

test("language pin refused by the API → one reconnect without it, no error", async () => {
  const fg = await fakeGemini({
    onSetup(conn, setup) {
      if (setup.generationConfig.speechConfig.languageCode) return conn.close(1007, "languageCode is not supported");
      conn.send({ setupComplete: {} });
    },
  });
  const srv = await startServer(testConfig({ geminiWsUrl: fg.url }));
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, gemini: { api_key: "k" }, persona: { language: "ta-IN", greeting: "Vanakkam" } });
    assert.equal((await api(srv.base, "POST", "/v1/sessions", body)).status, 200);
    await waitFor(async () => (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json.ai.ready, { timeout: 4000, what: "AI ready after the retry" });
    assert.equal(fg.st.setups.length, 2);
    assert.equal(fg.st.setups[0].generationConfig.speechConfig.languageCode, "ta-IN");
    assert.equal(fg.st.setups[1].generationConfig.speechConfig.languageCode, undefined);
    assert.equal(langPin.unsupported, true);
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/end", {});
    await sink.waitFor(body.session_id, "ended");
    assert.equal(sink.of(body.session_id, "error").length, 0);
  } finally { await meta.close(); await srv.close(); await fg.close(); }
});

test("Gemini drops mid-call → error event, then ended(ai_error)", async () => {
  const fg = await fakeGemini({ onMessage(conn, m) { if (m.clientContent) setTimeout(() => conn.close(1011, "internal"), 200); } });
  const srv = await startServer(testConfig({ geminiWsUrl: fg.url }));
  const meta = new FakeMeta();
  try {
    const body = sessionBody({ sdp_offer: await meta.offer(), callback: { url: sink.url }, gemini: { api_key: "k" } });
    const created = await api(srv.base, "POST", "/v1/sessions", body);
    await meta.applyAnswer(created.json.sdp); await meta.waitConnected(); meta.startMedia();
    await waitFor(async () => (await api(srv.base, "GET", "/v1/sessions/" + body.session_id)).json.ai.ready, { timeout: 3000 });
    await api(srv.base, "POST", "/v1/sessions/" + body.session_id + "/start");
    const err = await sink.waitFor(body.session_id, "error");
    assert.match(err.body.message, /AI connection closed mid-call \(code 1011 internal\)/);
    const ended = await sink.waitFor(body.session_id, "ended");
    assert.equal(ended.body.reason, "ai_error");
  } finally { await meta.close(); await srv.close(); await fg.close(); }
});
