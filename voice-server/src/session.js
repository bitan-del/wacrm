/* One AI call: Meta's WebRTC leg ⇄ this session ⇄ Gemini Live (or the mock AI).

   Inbound audio:  RTP Opus 48 kHz → decode (mono) → low-pass + resample to 16 kHz → Gemini
                   realtimeInput (only after /start, and not after the hangup was requested).
   Outbound audio: Gemini PCM16 24 kHz → resample to 48 kHz (+ smoothing low-pass) → queue →
                   a fixed 20 ms clock takes 960 samples per tick (silence when the queue is empty)
                   → Opus → RTP. The clock runs from the moment ICE/DTLS connects until the end, so
                   Meta always gets media, before /start included.
   Lifecycle:      init() → SDP, Gemini connects in the background (warm, silent)
                   start() → kickoff turn: the AI greets, customer audio flows to the AI
                   end_call tool → wait for the goodbye to finish playing → "hangup_requested"
                   end() → teardown → "ended" (exactly once) */
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { MediaPeer } from "./rtc.js";
import { OpusEncoder, OpusDecoder } from "./opus.js";
import { RateConverter, bufferToInt16, int16ToBuffer, rmsOf } from "./audio.js";
import { DtmfDetector } from "./dtmf.js";
import { GeminiLive } from "./gemini.js";
import { MockBrain, mockOptionsFrom } from "./mockBrain.js";
import { TOOLS, buildSystemInstruction, kickoffText, dtmfText, languagePinFor } from "./prompt.js";
import { postEvent } from "./callback.js";

const RATE = 48000;
const FRAME_MS = 20;
const FRAME = (RATE * FRAME_MS) / 1000; // 960 samples
const MAX_QUEUE_SAMPLES = RATE * 120; // never hold more than 2 min of AI audio
const MAX_CATCHUP_FRAMES = 10; // after a longer event-loop stall, skip ahead instead of bursting
const MAX_NOTES = 100;

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) : t; };

export class VoiceSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {"inbound"|"outbound"} o.direction
   * @param {object} o.persona
   * @param {object} o.context
   * @param {{api_key?:string, model?:string}} o.gemini
   * @param {{url:string}} o.callback
   * @param {object} o.config  loadConfig() result
   * @param {object} o.log
   * @param {{postEvent?:Function, brainFactory?:Function}} [o.deps]
   */
  constructor(o) {
    super();
    this.id = o.id; this.direction = o.direction;
    this.persona = o.persona || {}; this.context = o.context || {};
    this.gemini = o.gemini || {}; this.callbackUrl = (o.callback && o.callback.url) || "";
    this.cfg = o.config; this.log = o.log; this.deps = o.deps || {};
    this.apiKey = String(this.gemini.api_key || this.cfg.geminiApiKey || "");
    this.mock = this.apiKey === "mock";
    const maxDur = Number(this.persona.max_duration_seconds) || this.cfg.defaultMaxDurationSec;
    this.maxDurationSec = Math.max(10, Math.min(3600, maxDur));

    this.createdAt = Date.now(); this.startedAt = 0; this.endedAt = 0; this.endReason = "";
    this.started = false; this.ended = false; this.initializing = false; this.pendingFatal = null;
    this.kicked = false; this.brain = null; this.brainEverReady = false; this.brainReconnects = 0; this.langRetried = false;
    this.transcript = []; this.notes = Object.create(null);
    this.hangupRequestedAt = 0; this.hangupEmitted = false; this.hangupReason = "";
    this.remoteApplied = false; this.remoteApplying = null; this.remoteSdp = ""; this.mediaConnectedAt = 0; this.lastRtpAt = 0; this.lastSeq = null; this.lastSsrc = null;
    this.outQueue = []; this.outPos = 0; this.queuedSamples = 0; this.lastAiAudioAt = 0; this.queueEmptySince = 0;
    this.pacer = null; this.pacerT0 = 0; this.framesSent = 0;
    this.timers = {}; this.eventChain = Promise.resolve(); this.eventsSent = [];
    this.stats = { lost: 0, late: 0, decodeErrors: 0, framesToAi: 0, framesVoiced: 0, framesSkipped: 0, inPeakRms: 0, aiAudioMs: 0, aiAudioDropped: 0, interruptions: 0, flushedMs: 0, toolCalls: 0, dtmf: 0 };

    this.encoder = new OpusEncoder({ bitrate: this.cfg.opusBitrate });
    this.decoder = new OpusDecoder();
    this.inConv = new RateConverter(RATE, 16000);
    this.outConvs = new Map();
    this.dtmf = new DtmfDetector((d) => this._onDigit(d));
    this.post = this.deps.postEvent || postEvent;
  }

  /* ---------------- setup ---------------- */
  /** @returns {Promise<string>} our SDP: the answer (inbound) or the offer (outbound) */
  async init(sdpOffer) {
    this.initializing = true;
    this.peer = new MediaPeer({
      bindIp: this.cfg.bindIp, publicIp: this.cfg.publicIp, portRange: [this.cfg.rtcPortMin, this.cfg.rtcPortMax],
      stunUrl: this.cfg.stunUrl, gatherTimeoutMs: this.cfg.iceGatherTimeoutMs, log: this.log,
    });
    this.peer.on("rtp", (rtp) => this._onRtp(rtp));
    this.peer.on("connected", () => this._onMediaConnected());
    this.peer.on("failed", () => this._fatal("media", "media connection failed (ICE/DTLS)"));
    this.peer.on("disconnected", () => this.log.warn("media disconnected (waiting for it to recover)"));
    this._connectBrain(); // warm, but silent until start()
    this.timers.watchdog = setInterval(() => this._watch(), 1000);
    try {
      let sdp;
      if (this.direction === "inbound") { sdp = await this.peer.answer(sdpOffer); this.remoteApplied = true; this.remoteSdp = sdpOffer; }
      else sdp = await this.peer.offer();
      this.localSdp = sdp;
      return sdp;
    } catch (e) {
      this.dispose("setup_failed");
      throw e;
    } finally {
      this.initializing = false;
      if (this.pendingFatal && !this.ended) { const f = this.pendingFatal; setImmediate(() => this._fatal(f.kind, f.message)); }
    }
  }

  /** Outbound: Meta's SDP answer. Idempotent for the same SDP. */
  async setRemoteDescription(sdp) {
    if (this.direction !== "outbound") { const e = new Error("remote-description is only for outbound sessions"); e.status = 409; throw e; }
    if (this.ended) { const e = new Error("session ended"); e.status = 409; throw e; }
    if (this.remoteApplying) { try { await this.remoteApplying; } catch {} } // a retry racing the first request
    if (this.remoteApplied) {
      if (sdp === this.remoteSdp) return;
      const e = new Error("a different remote description was already applied"); e.status = 409; throw e;
    }
    this.remoteSdp = sdp;
    const p = this.peer.setAnswer(sdp);
    this.remoteApplying = p;
    try { await p; this.remoteApplied = true; }
    catch (e) { this.remoteSdp = ""; e.status = e.status || 400; throw e; }
    finally { this.remoteApplying = null; }
    this.log.info("remote description applied");
  }

  /** The call is live: the AI greets and starts listening. Idempotent. */
  start() {
    if (this.ended) { const e = new Error("session ended"); e.status = 409; throw e; }
    if (this.started) return false;
    if (this.direction === "outbound" && !this.remoteApplied) { const e = new Error("outbound session has no remote description yet"); e.status = 409; throw e; }
    this.started = true; this.startedAt = Date.now();
    this.timers.max = setTimeout(() => this.end("max_duration"), this.maxDurationSec * 1000);
    this.log.info("call live" + (this.brain && this.brain.ready ? " — AI greeting" : " — AI greets when ready"));
    if (this.brain && this.brain.ready) this._kickoff();
    return true;
  }

  /* ---------------- AI ---------------- */
  _makeBrain() {
    if (this.mock) return new MockBrain({ greeting: this.persona.greeting, options: mockOptionsFrom(this.persona.instructions) });
    if (this.deps.brainFactory) return this.deps.brainFactory(this);
    return new GeminiLive({
      apiKey: this.apiKey,
      model: this.gemini.model || this.cfg.geminiModel,
      voice: this.persona.voice || this.cfg.geminiVoice,
      systemInstruction: buildSystemInstruction(this.persona, this.context, { direction: this.direction }),
      tools: TOOLS,
      vad: this.cfg.vad,
      thinking: this.cfg.geminiThinking,
      languageCode: languagePinFor(this.persona.language),
      url: this.cfg.geminiWsUrl || undefined,
      setupTimeoutMs: this.cfg.geminiSetupTimeoutMs,
    });
  }

  _connectBrain() {
    if (this.ended) return;
    const b = this._makeBrain();
    this.brain = b;
    const stale = () => this.brain !== b || this.ended;
    b.on("ready", () => {
      if (stale()) return;
      this.brainEverReady = true;
      this.log.info("AI ready (" + (this.mock ? "mock" : "gemini") + ")");
      if (this.started && !this.kicked) this._kickoff();
    });
    b.on("audio", (buf, rate) => { if (!stale()) this._onAiAudio(buf, rate); });
    b.on("transcript", (t) => { if (!stale()) this._addTranscript(t.role, t.text); });
    b.on("turnComplete", () => { if (!stale()) this._sealLast("agent"); });
    b.on("interrupted", () => { if (!stale()) this._onInterrupted(); });
    b.on("toolCall", (fc) => { if (!stale()) this._onToolCall(b, fc); });
    b.on("goaway", (g) => { if (!stale()) this.log.warn("AI goAway " + JSON.stringify(g || {})); });
    b.on("error", (e) => { if (!stale()) this.log.warn("AI error: " + ((e && e.message) || e)); });
    b.on("close", (info) => { if (!stale()) this._onBrainClose(info || {}); });
    try { b.connect(); } catch (e) { this._fatal("ai", "AI connect failed: " + e.message); }
  }

  _onBrainClose(info) {
    const what = "code " + (info.code ?? "?") + (info.reason ? " " + clip(info.reason, 200) : "");
    if (info.setupRejected && !this.langRetried) {
      this.langRetried = true;
      this.log.warn("AI refused the setup with a language pin — reconnecting without it");
      return this._connectBrain();
    }
    if (this.hangupRequestedAt) { this.log.info("AI connection closed after end_call (" + what + ")"); return; } // not an error: the hangup flow finishes on its own
    if (!this.started && this.brainEverReady && this.brainReconnects < 2) {
      this.brainReconnects++;
      this.log.warn("AI connection dropped before the call went live (" + what + ") — reconnecting");
      return this._connectBrain();
    }
    this._fatal("ai", this.brainEverReady ? "AI connection closed mid-call (" + what + ")" : "AI connection failed (" + (info.timedOut ? "setup timed out" : what) + ")");
  }

  _kickoff() {
    if (this.kicked || !this.brain || !this.brain.ready) return;
    this.kicked = true;
    this.brain.kickoff(kickoffText(this.persona, this.context));
  }

  _onAiAudio(buf, rate) {
    if (!this.started || this.ended) { this.stats.aiAudioDropped++; return; }
    const r = Number(rate) || 24000;
    let conv = this.outConvs.get(r);
    if (!conv) { conv = new RateConverter(r, RATE); this.outConvs.set(r, conv); }
    const pcm = conv.process(bufferToInt16(buf));
    if (!pcm.length) return;
    if (this.queuedSamples + pcm.length > MAX_QUEUE_SAMPLES) { this.stats.aiAudioDropped++; return; }
    this.outQueue.push(pcm); this.queuedSamples += pcm.length;
    this.lastAiAudioAt = Date.now();
    this.stats.aiAudioMs += (pcm.length / RATE) * 1000;
  }

  /** Barge-in: the customer started talking over the AI — drop everything not yet played. */
  _onInterrupted() {
    this.stats.interruptions++;
    this.stats.flushedMs += Math.round((this.queuedSamples / RATE) * 1000);
    this.outQueue = []; this.outPos = 0; this.queuedSamples = 0; this.queueEmptySince = Date.now();
    this._sealLast("agent");
    this.log.debug("barge-in: AI audio flushed");
  }

  _onToolCall(b, fc) {
    this.stats.toolCalls++;
    const args = fc.args || {};
    let resp;
    if (fc.name === "save_note") {
      const key = clip(String(args.key ?? "").trim(), 64), value = clip(String(args.value ?? ""), 2000);
      if (!key) resp = { ok: false, error: "key is required" };
      else if (!(key in this.notes) && Object.keys(this.notes).length >= MAX_NOTES) resp = { ok: false, error: "too many notes" };
      else { this.notes[key] = value; resp = { ok: true }; }
    } else if (fc.name === "end_call") {
      resp = { ok: true, note: "The call will end once your last words have played." };
      this._requestHangup(clip(String(args.reason || "done"), 200));
    } else {
      resp = { ok: false, error: "unknown tool " + fc.name };
    }
    try { b.sendToolResponse(fc.id, fc.name, resp); } catch {}
  }

  /** end_call: let the goodbye finish playing, then ask the app to hang up. */
  _requestHangup(reason) {
    if (this.hangupRequestedAt || this.ended) return;
    this.hangupRequestedAt = Date.now(); this.hangupReason = reason;
    this.log.info("AI requested hangup (" + reason + ")");
    const deadline = this.hangupRequestedAt + 15000;
    const check = () => {
      if (this.ended) return;
      const t = Date.now();
      const quietSince = Math.max(this.lastAiAudioAt, this.queueEmptySince);
      const drained = this.queuedSamples === 0 && t - quietSince >= 500 && t - this.hangupRequestedAt >= 600;
      if (drained || t >= deadline || !this.mediaConnectedAt) {
        this.hangupEmitted = true;
        this._emitEvent({ type: "hangup_requested", reason });
        // the app is expected to hang up and call /end; if it does not, end the session ourselves
        this.timers.hangupFallback = setTimeout(() => this.end("agent_hangup"), this.cfg.hangupFallbackMs);
        return;
      }
      this.timers.hangup = setTimeout(check, 100);
    };
    this.timers.hangup = setTimeout(check, 100);
  }

  /* ---------------- transcript ---------------- */
  _addTranscript(role, text) {
    const t = String(text || ""); if (!t) return;
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role && !last.sealed) last.text += t;
    else this.transcript.push({ role, text: t, at: new Date().toISOString(), sealed: false });
  }
  _sealLast(role) { const last = this.transcript[this.transcript.length - 1]; if (last && (!role || last.role === role)) last.sealed = true; }
  finalTranscript() {
    return this.transcript
      .map((t) => ({ role: t.role, text: t.text.replace(/\s+/g, " ").trim(), at: t.at }))
      .filter((t) => t.text);
  }

  /* ---------------- media ---------------- */
  _onMediaConnected() {
    if (this.ended) return;
    this.mediaConnectedAt = Date.now();
    this.log.info("media connected (ICE + DTLS-SRTP) in " + (this.mediaConnectedAt - this.createdAt) + " ms");
    this._startPacer();
  }

  _onRtp(rtp) {
    if (this.ended) return;
    this.lastRtpAt = Date.now();
    const pt = rtp.header.payloadType, pts = this.peer.remotePts;
    // one sequence space per SSRC, shared by audio and telephone-event packets
    const seq = rtp.header.sequenceNumber, ssrc = rtp.header.ssrc;
    let late = false;
    if (this.lastSeq !== null && ssrc === this.lastSsrc) {
      const d = (seq - this.lastSeq) & 0xffff;
      if (d === 0 || d > 0x8000) late = true; // duplicate or reordered: already past it
      else if (d > 1) this.stats.lost += d - 1;
    }
    if (!late) { this.lastSeq = seq; this.lastSsrc = ssrc; }
    if (pt === pts.opus) { if (late) { this.stats.late++; return; } this._onOpus(rtp); }
    else if (pts.dtmf.includes(pt)) this.dtmf.push(rtp.header.timestamp, rtp.payload);
  }

  _onOpus(rtp) {
    if (!rtp.payload || !rtp.payload.length) return;
    let pcm;
    try { pcm = this.decoder.decode(rtp.payload); } catch { this.stats.decodeErrors++; return; }
    const lvl = rmsOf(pcm); if (lvl > this.stats.inPeakRms) this.stats.inPeakRms = Math.round(lvl);
    const pcm16 = this.inConv.process(pcm);
    if (!this.started || this.hangupEmitted || !this.brain || !this.brain.ready || !pcm16.length) return;
    this.brain.sendAudio(int16ToBuffer(pcm16));
    this.stats.framesToAi++;
  }

  _onDigit(digit) {
    this.stats.dtmf++;
    this.log.info("DTMF " + digit);
    if (!this.started) return;
    this._sealLast();
    this._addTranscript("customer", "[pressed " + digit + "]");
    this._sealLast();
    if (this.brain && this.brain.ready && !this.hangupEmitted) this.brain.sendText(dtmfText(digit));
  }

  _startPacer() {
    if (this.pacer || this.ended) return;
    this.pacerT0 = performance.now(); this.framesSent = 0;
    this.pacer = setInterval(() => { try { this._tick(); } catch (e) { this.log.error("pacer: " + e.message); } }, 10);
    this._tick();
  }

  _tick() {
    if (this.ended) return;
    const due = Math.floor((performance.now() - this.pacerT0) / FRAME_MS) + 1;
    const behind = due - this.framesSent;
    if (behind > MAX_CATCHUP_FRAMES) {
      const skip = behind - 1;
      this.peer.skip(skip * FRAME); this.framesSent += skip; this.stats.framesSkipped += skip;
    }
    while (this.framesSent < due) { this._sendFrame(); this.framesSent++; }
  }

  _sendFrame() {
    const frame = new Int16Array(FRAME);
    let filled = 0;
    while (filled < FRAME && this.outQueue.length) {
      const head = this.outQueue[0], take = Math.min(FRAME - filled, head.length - this.outPos);
      frame.set(head.subarray(this.outPos, this.outPos + take), filled);
      filled += take; this.outPos += take;
      if (this.outPos >= head.length) { this.outQueue.shift(); this.outPos = 0; }
    }
    if (filled) {
      this.queuedSamples -= filled; this.stats.framesVoiced++;
      if (this.queuedSamples <= 0) { this.queuedSamples = 0; this.queueEmptySince = Date.now(); }
    }
    this.peer.sendOpus(this.encoder.encode(frame), FRAME);
  }

  /* ---------------- watchdog / errors / end ---------------- */
  _watch() {
    if (this.ended) return;
    const t = Date.now(), c = this.cfg;
    if (!this.started) {
      if (t - this.createdAt > c.setupTimeoutSec * 1000) this.end("setup_timeout");
      return;
    }
    if (!this.mediaConnectedAt && t - this.startedAt > c.mediaConnectTimeoutSec * 1000) {
      this._fatal("media", "media did not connect within " + c.mediaConnectTimeoutSec + " s of start");
      return;
    }
    if (t - Math.max(this.lastRtpAt, this.startedAt) > c.noMediaTimeoutSec * 1000) this.end("no_media");
  }

  _fatal(kind, message) {
    if (this.ended) return;
    if (this.initializing) { this.pendingFatal = this.pendingFatal || { kind, message }; return; }
    this.log.error(message);
    this._emitEvent({ type: "error", message });
    this.end(kind === "ai" ? "ai_error" : "media_error");
  }

  _emitEvent(ev) {
    const payload = { session_id: this.id, ...ev };
    this.eventsSent.push(payload.type);
    if (!this.callbackUrl) return this.eventChain;
    this.eventChain = this.eventChain
      .then(() => this.post(this.callbackUrl, payload, { secret: this.cfg.secret, log: this.log }))
      .then((r) => { if (r && !r.ok) this.log.warn("event " + payload.type + " not delivered: " + (r.error || r.status)); })
      .catch(() => {});
    return this.eventChain;
  }

  _teardown() {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
    if (this.pacer) { clearInterval(this.pacer); this.pacer = null; }
    try { this.brain && this.brain.close(); } catch {}
    this.brain = null;
    if (this.peer) this.peer.close().catch(() => {});
    try { this.encoder.delete(); } catch {}
    try { this.decoder.delete(); } catch {}
    this.outQueue = []; this.queuedSamples = 0;
  }

  /** Tear down without telling the app (a session that never got off the ground). */
  dispose(reason) {
    if (this.ended) return;
    this.ended = true; this.endedAt = Date.now(); this.endReason = reason;
    this._teardown();
    this.emit("ended", reason);
  }

  /** Tear down and send the final "ended" event (once). Resolves when the event was delivered or given up on. */
  end(reason = "ended") {
    if (this.ended) return this.endedPromise || Promise.resolve();
    this.ended = true; this.endedAt = Date.now(); this.endReason = String(reason);
    this.log.info("ended (" + this.endReason + ")");
    this._teardown();
    const notes = { ...this.notes };
    this.endedPromise = this._emitEvent({
      type: "ended",
      reason: this.endReason,
      duration_seconds: this.startedAt ? Math.round((this.endedAt - this.startedAt) / 1000) : 0,
      transcript: this.finalTranscript(),
      notes,
      summary: typeof notes.summary === "string" ? notes.summary : "",
    });
    this.emit("ended", this.endReason);
    return this.endedPromise;
  }

  info() {
    const p = this.peer;
    return {
      session_id: this.id, direction: this.direction,
      state: this.ended ? "ended" : this.started ? "live" : "setup",
      created_at: new Date(this.createdAt).toISOString(),
      started_at: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      ended_at: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      end_reason: this.endReason || null,
      media: {
        state: p ? p.state : "new", connected: !!this.mediaConnectedAt, remote_description: this.remoteApplied,
        rtp_in: p ? p.stats.rtpIn : 0, rtp_out: p ? p.stats.rtpOut : 0, send_errors: p ? p.stats.sendErrors : 0,
        lost: this.stats.lost, late: this.stats.late, decode_errors: this.stats.decodeErrors, in_peak_rms: this.stats.inPeakRms,
        frames_to_ai: this.stats.framesToAi, frames_voiced: this.stats.framesVoiced, frames_skipped: this.stats.framesSkipped, dtmf: this.stats.dtmf,
      },
      ai: {
        mode: this.mock ? "mock" : "gemini", ready: !!(this.brain && this.brain.ready), kicked: this.kicked,
        audio_ms: Math.round(this.stats.aiAudioMs), queued_ms: Math.round((this.queuedSamples / RATE) * 1000),
        interruptions: this.stats.interruptions, flushed_ms: this.stats.flushedMs, tool_calls: this.stats.toolCalls,
        hangup_requested: !!this.hangupRequestedAt,
      },
      transcript_turns: this.transcript.length,
      notes: Object.keys(this.notes).length,
      events: this.eventsSent.slice(),
    };
  }
}
