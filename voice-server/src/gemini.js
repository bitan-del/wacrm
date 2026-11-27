/* Gemini Live client (Node's built-in WebSocket).

   The wire format below is copied from the production Plivo ⇄ Gemini Live bridge
   (nutriherb src/server/voice.js → class GeminiLive), which runs live phone calls: the endpoint,
   the `models/` prefix, the setup message (AUDIO modality, prebuilt voice, optional language pin,
   thinking config, system instruction, input + output transcription, automatic activity
   detection), `realtimeInput.audio` at 16 kHz, `clientContent` turns, `toolResponse`, and the
   server messages (setupComplete, serverContent.{interrupted, inputTranscription,
   outputTranscription, modelTurn.parts[].inlineData, turnComplete}, toolCall, usageMetadata,
   goAway). Differences: the WebSocket class and URL are injectable (tests use a local fake
   server), and a setup that never completes times out. */
import { EventEmitter } from "node:events";

export const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

/* THE LANGUAGE PIN (from production): native-audio Live models may refuse an explicit
   speechConfig.languageCode. It is sent anyway; if the API closes the socket before setupComplete
   while the pin was in the setup, the session reconnects once without it and this flag stops every
   later session in the process from sending it. */
export const langPin = { unsupported: false };

export class GeminiLive extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {string} [o.model]
   * @param {string} [o.voice]
   * @param {string} [o.systemInstruction]
   * @param {Array<{name:string,description:string,parameters:object}>} [o.tools]
   * @param {{silenceMs?:number,prefixMs?:number,start?:string,endSensitivity?:string}} [o.vad]
   * @param {string} [o.thinking]  "0" → thinkingBudget 0; a word → thinkingLevel; "" → model default
   * @param {string} [o.languageCode] e.g. "hi-IN"; "" for none
   * @param {string} [o.url]   override the endpoint (tests)
   * @param {typeof WebSocket} [o.WebSocketImpl]
   * @param {number} [o.setupTimeoutMs]
   */
  constructor(o) {
    super();
    this.apiKey = o.apiKey; this.model = o.model || DEFAULT_MODEL; this.voice = o.voice || "Aoede"; this.thinking = o.thinking;
    this.languageCode = o.languageCode && !langPin.unsupported ? String(o.languageCode) : "";
    this.systemInstruction = o.systemInstruction || ""; this.tools = o.tools || []; this.vad = o.vad || {};
    this.url = o.url || GEMINI_WS; this.WebSocketImpl = o.WebSocketImpl || globalThis.WebSocket;
    this.setupTimeoutMs = o.setupTimeoutMs || 10000;
    this.ws = null; this.ready = false; this.closed = false; this.opened = false; this.setupTimer = null;
  }

  setupMessage() {
    return {
      setup: {
        model: this.model.startsWith("models/") ? this.model : "models/" + this.model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } }, ...(this.languageCode ? { languageCode: this.languageCode } : {}) },
          ...(this.thinking !== undefined && this.thinking !== null && String(this.thinking) !== ""
            ? { thinkingConfig: /^\d+$/.test(String(this.thinking)) ? { thinkingBudget: Number(this.thinking) } : { thinkingLevel: String(this.thinking).toUpperCase() } }
            : {}),
        },
        systemInstruction: { parts: [{ text: this.systemInstruction }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: String(this.vad.start || "").toLowerCase() === "high" ? "START_SENSITIVITY_HIGH" : "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: String(this.vad.endSensitivity || "").toLowerCase() === "high" ? "END_SENSITIVITY_HIGH" : "END_SENSITIVITY_LOW",
            prefixPaddingMs: Number(this.vad.prefixMs) || 20,
            silenceDurationMs: Number(this.vad.silenceMs) || 350,
          },
        },
        ...(this.tools.length ? { tools: [{ functionDeclarations: this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] } : {}),
      },
    };
  }

  connect() {
    if (typeof this.WebSocketImpl !== "function") throw new Error("WebSocket client unavailable (need Node 22+)");
    const ws = new this.WebSocketImpl(this.url + "?key=" + encodeURIComponent(this.apiKey));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setupTimer = setTimeout(() => {
      if (this.ready || this.closed) return;
      this.emit("error", new Error("gemini setup timed out after " + this.setupTimeoutMs + " ms"));
      this.close();
      this.emit("close", { code: 0, reason: "setup timeout", setupRejected: false, timedOut: true });
    }, this.setupTimeoutMs);
    ws.onopen = () => { this.opened = true; try { ws.send(JSON.stringify(this.setupMessage())); } catch (e) { this.emit("error", e); } };
    ws.onmessage = (ev) => {
      let txt;
      try { txt = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"); } catch { return; }
      this._onMessage(txt);
    };
    ws.onclose = (ev) => {
      clearTimeout(this.setupTimer);
      if (this.closed) return;
      this.closed = true;
      // the socket opened, the setup went out with the language pin, and the API closed before
      // setupComplete: the pin was refused. (A connection that never opened is not a refusal.)
      const setupRejected = this.opened && !this.ready && !!this.languageCode;
      if (setupRejected) langPin.unsupported = true;
      this.emit("close", { code: ev && ev.code, reason: ev && ev.reason, setupRejected, wasReady: this.ready });
    };
    ws.onerror = (e) => {
      this.emit("error", e && e.error ? e.error : new Error("gemini websocket error"));
      // Node's WebSocket may report a failed connect with only "error" and no "close": end it here
      if (!this.opened) setImmediate(() => {
        if (this.closed) return;
        this.close();
        this.emit("close", { code: 1006, reason: "connection failed", setupRejected: false, wasReady: false });
      });
    };
  }

  _onMessage(txt) {
    let msg; try { msg = JSON.parse(txt); } catch { return; }
    if (msg.setupComplete) { this.ready = true; clearTimeout(this.setupTimer); this.emit("ready"); return; }
    if (msg.goAway) this.emit("goaway", msg.goAway);
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.emit("interrupted");
      if (sc.inputTranscription && sc.inputTranscription.text) this.emit("transcript", { role: "customer", text: sc.inputTranscription.text });
      if (sc.outputTranscription && sc.outputTranscription.text) this.emit("transcript", { role: "agent", text: sc.outputTranscription.text });
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const p of parts) {
        const inline = p.inlineData;
        if (inline && inline.data) {
          const m = /rate=(\d+)/.exec(inline.mimeType || ""); const rate = m ? parseInt(m[1], 10) : 24000;
          this.emit("audio", Buffer.from(inline.data, "base64"), rate);
        }
      }
      if (sc.turnComplete) this.emit("turnComplete");
    }
    if (msg.usageMetadata) this.emit("usage", msg.usageMetadata);
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      for (const fc of msg.toolCall.functionCalls) this.emit("toolCall", { id: fc.id, name: fc.name, args: fc.args || {} });
    }
  }

  _open() { return this.ws && this.ws.readyState === 1; }
  /** Caller audio: PCM16 mono 16 kHz (Buffer). */
  sendAudio(pcm16) { if (!this._open() || !this.ready) return; this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm16.toString("base64"), mimeType: "audio/pcm;rate=16000" } } })); }
  /** Gemini Live stays silent until given a turn — this makes it speak first. */
  kickoff(text) { if (!this._open()) return; this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } })); }
  /** A text turn mid-call (same clientContent shape as the kickoff), e.g. a keypad press. */
  sendText(text) { this.kickoff(text); }
  sendToolResponse(id, name, response) { if (!this._open()) return; this.ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id, name, response }] } })); }
  close() { this.closed = true; clearTimeout(this.setupTimer); try { this.ws && this.ws.close(); } catch {} }
}
