/* Mock AI (gemini.api_key === "mock"): same interface and events as GeminiLive, no network.

   - kickoff → agent transcript = the greeting, audio = 440 Hz tone (greeting_ms, default 1000),
     then save_note("summary", ...).
   - Customer audio (16 kHz) is watched by an energy detector. An utterance (≥160 ms of sound, then
     300 ms quiet) → customer transcript "heard <f> Hz for <ms> ms" (f = dominant frequency) and a
     reply tone at 600 + 100·n Hz (reply n = 1, 2, …) lasting reply_ms (default 800).
   - Sound that starts while a reply is still playing → "interrupted" (barge-in).
   - A text turn (keypad press) → save_note("dtmf", digit) and save_note("dtmf_all", digits so far).
   - "[mock:end_call]" in the instructions → end_call("mock_done") right after the first reply's audio.
   Audio is emitted in 40 ms chunks faster than real time, like Gemini. Options can be overridden
   by tags in persona.instructions: [mock:greeting_ms=N] [mock:reply_ms=N] [mock:end_call]. */
import { EventEmitter } from "node:events";
import { tone, rmsOf, dominantFrequency, concatInt16, int16ToBuffer, bufferToInt16 } from "./audio.js";

const RATE_OUT = 24000, RATE_IN = 16000;

export function mockOptionsFrom(instructions = "") {
  const s = String(instructions || "");
  const num = (k, d) => { const m = new RegExp("\\[mock:" + k + "=(\\d+)\\]").exec(s); return m ? Number(m[1]) : d; };
  return { greetingMs: num("greeting_ms", 1000), replyMs: num("reply_ms", 800), endCall: /\[mock:end_call\]/.test(s) };
}

export class MockBrain extends EventEmitter {
  constructor({ greeting = "", options = {} } = {}) {
    super();
    this.greeting = greeting || "Hello, this is the mock agent.";
    this.opt = { greetingMs: 1000, replyMs: 800, endCall: false, ...options };
    this.ready = false; this.closed = false;
    this.timers = new Set();
    this.speakingUntil = 0; this.speechGen = 0; this.replies = 0; this.toolSeq = 0; this.dtmf = "";
    this.inSpeech = false; this.speechMs = 0; this.quietMs = 0; this.utter = [];
    this.received = { audioMessages: 0, kickoffs: 0, texts: [], toolResponses: [] };
  }
  _later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms); this.timers.add(t); }
  connect() { this._later(20, () => { this.ready = true; this.emit("ready"); }); }
  _speak(freq, ms, text, after) {
    const total = Math.round((RATE_OUT * ms) / 1000), chunk = (RATE_OUT * 40) / 1000, gen = ++this.speechGen;
    this.speakingUntil = Math.max(Date.now(), this.speakingUntil) + ms;
    if (text) this.emit("transcript", { role: "agent", text });
    let off = 0;
    const step = () => {
      if (gen !== this.speechGen) return; // interrupted: like Gemini, stop generating this turn
      if (off >= total) { this.emit("turnComplete"); if (after) after(); return; }
      const n = Math.min(chunk, total - off);
      this.emit("audio", int16ToBuffer(tone(freq, RATE_OUT, n, 8000, off)), RATE_OUT);
      off += n;
      this._later(10, step);
    };
    step();
  }
  _tool(name, args) { this.emit("toolCall", { id: "mock-" + ++this.toolSeq, name, args }); }
  kickoff() {
    this.received.kickoffs++;
    this._speak(440, this.opt.greetingMs, this.greeting, () => this._tool("save_note", { key: "summary", value: "Mock call: greeted the customer." }));
  }
  sendText(text) {
    this.received.texts.push(text);
    const m = /"(.)"/.exec(String(text));
    if (m) { this.dtmf += m[1]; this._tool("save_note", { key: "dtmf", value: m[1] }); this._tool("save_note", { key: "dtmf_all", value: this.dtmf }); }
  }
  sendAudio(buf) {
    if (!this.ready || this.closed) return;
    this.received.audioMessages++;
    const pcm = bufferToInt16(buf), ms = (pcm.length / RATE_IN) * 1000, loud = rmsOf(pcm) > 500;
    if (loud) {
      if (!this.inSpeech) {
        this.inSpeech = true; this.speechMs = 0; this.utter = [];
        if (Date.now() < this.speakingUntil) { this.speakingUntil = 0; this.speechGen++; this.emit("interrupted"); }
      }
      this.speechMs += ms; this.quietMs = 0;
      if (this.utter.length < 50) this.utter.push(pcm);
    } else if (this.inSpeech) {
      this.quietMs += ms;
      if (this.quietMs >= 300) {
        this.inSpeech = false;
        if (this.speechMs >= 160) this._onUtterance(concatInt16(this.utter), Math.round(this.speechMs));
      }
    }
  }
  _onUtterance(pcm, ms) {
    const f = dominantFrequency(pcm, RATE_IN, 100, 3000);
    this.emit("transcript", { role: "customer", text: `heard ${f} Hz for ${ms} ms` });
    const n = ++this.replies;
    const endAfter = this.opt.endCall && n === 1;
    this._speak(600 + 100 * n, this.opt.replyMs, `reply ${n}`, endAfter ? () => this._tool("end_call", { reason: "mock_done" }) : null);
  }
  sendToolResponse(id, name, response) { this.received.toolResponses.push({ id, name, response }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
