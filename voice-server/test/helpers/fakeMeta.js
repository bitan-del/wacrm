/* A stand-in for Meta's WhatsApp media endpoint, on werift: ICE-lite (it never starts ICE checks,
   the voice server must), Opus 48 kHz pt 111 + telephone-event/8000 pt 126, bound to 127.0.0.1.
   Its RTP is written straight onto the DTLS-SRTP transport with its own SSRC / sequence /
   timestamp / payload type, like a real far end. Everything it receives is decoded and kept
   with arrival times for analysis. */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { OpusEncoder, OpusDecoder } from "../../src/opus.js";
import { audioCodecs } from "../../src/rtc.js";
import { tone, rmsOf, goertzel } from "../../src/audio.js";
import { buildTelephoneEvent } from "../../src/dtmf.js";

const require = createRequire(import.meta.url);
const { RTCPeerConnection, RtpHeader } = require("werift");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 5000, interval = 20, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting for " + what);
    await sleep(interval);
  }
}

export class FakeMeta {
  constructor() {
    this.pc = new RTCPeerConnection({
      codecs: { audio: audioCodecs(), video: [] }, headerExtensions: { audio: [], video: [] },
      iceServers: [], iceUseDefaultStunServer: false, iceUseIpv6: false, iceUseTcp: false, iceTcpPassive: false,
      iceInterfaceAddresses: { udp4: "127.0.0.1" }, iceLite: true, bundlePolicy: "max-bundle",
    });
    this.enc = new OpusEncoder(); this.dec = new OpusDecoder();
    this.ssrc = crypto.randomInt(1, 0xffffffff); this.seq = crypto.randomInt(0, 0x10000); this.ts = crypto.randomInt(0, 0x7fffffff);
    this.dtmfSeqTs = 0;
    this.rx = []; this.t0 = performance.now();
    this.sources = []; this.timer = null; this.framesSent = 0;
    this.connected = false;
    this.pc.connectionStateChange.subscribe((s) => { if (s === "connected") this.connected = true; });
  }
  now() { return performance.now() - this.t0; }
  async _gathered() {
    if (this.pc.iceGatheringState === "complete") return;
    await new Promise((r) => { const sub = this.pc.iceGatheringStateChange.subscribe((s) => { if (s === "complete") { sub.unSubscribe(); r(); } }); });
  }
  _hook() {
    const t = this.pc.dtlsTransports[0];
    if (!t || t === this.hooked) return;
    this.hooked = t; this.dtls = t;
    t.onRtp.subscribe((rtp) => {
      const h = rtp.header;
      const rec = { at: this.now(), pt: h.payloadType, seq: h.sequenceNumber, ts: h.timestamp, ssrc: h.ssrc, marker: h.marker, bytes: rtp.payload.length, pcm: null };
      if (h.payloadType === 111) { try { rec.pcm = this.dec.decode(rtp.payload); } catch { rec.decodeError = true; } }
      this.rx.push(rec);
    });
  }
  /** Customer-initiated call: Meta's offer. */
  async offer() {
    this.tx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this._hook(); await this._gathered();
    return this.pc.localDescription.sdp;
  }
  async applyAnswer(sdp) { await this.pc.setRemoteDescription({ type: "answer", sdp }); this._hook(); }
  /** Business-initiated call: Meta's answer to our offer. */
  async answer(offerSdp) {
    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    this.tx = this.pc.getTransceivers()[0];
    this.tx.setDirection("sendrecv");
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    this._hook(); await this._gathered();
    return this.pc.localDescription.sdp;
  }
  waitConnected(timeout = 8000) { return waitFor(() => this.connected && this.dtls, { timeout, what: "fake Meta media connection" }); }

  _rtp(pt, payload, { marker = false, ts } = {}) {
    if (!this.dtls) return;
    const header = new RtpHeader({ payloadType: pt, sequenceNumber: this.seq, timestamp: ts ?? this.ts, ssrc: this.ssrc, marker });
    this.seq = (this.seq + 1) & 0xffff;
    this.dtls.sendRtp(payload, header).catch(() => {});
  }
  /** Start the 20 ms media clock (silence unless a tone is queued). */
  startMedia() {
    if (this.timer) return;
    const t0 = performance.now();
    this.timer = setInterval(() => {
      const due = Math.floor((performance.now() - t0) / 20) + 1;
      while (this.framesSent < due) {
        let frame = null;
        const src = this.sources[0];
        if (src) { frame = tone(src.freq, 48000, 960, src.amp, src.off); src.off += 960; if (src.off >= src.total) this.sources.shift(); }
        this._rtp(111, this.enc.encode(frame || new Int16Array(960)), { marker: this.framesSent === 0 });
        this.ts = (this.ts + 960) >>> 0;
        this.framesSent++;
      }
    }, 10);
  }
  /** Queue `ms` of a sine at `freq` (the "customer speaking"). */
  playTone(freq, ms, amp = 9000) { this.sources.push({ freq, amp, off: 0, total: Math.round((48 * ms)) }); }
  /** RFC 4733: 3 packets for the key press, then 3 end packets, one RTP timestamp. */
  async sendDtmf(digit) {
    const ts = this.ts;
    for (let i = 1; i <= 3; i++) { this._rtp(126, buildTelephoneEvent({ digit, duration: i * 160 }), { ts, marker: i === 1 }); await sleep(20); }
    for (let i = 0; i < 3; i++) this._rtp(126, buildTelephoneEvent({ digit, end: true, duration: 640 }), { ts });
  }

  /* ---------- analysis of what the voice server sent ---------- */
  audioFrames(from = 0, to = Infinity) { return this.rx.filter((r) => r.pcm && r.at >= from && r.at < to); }
  /** ms of received audio whose 20 ms frames are a clean tone at `freq`. */
  toneMs(freq, from = 0, to = Infinity) {
    let n = 0;
    for (const r of this.audioFrames(from, to)) {
      const rms = rmsOf(r.pcm); if (rms < 800) continue;
      if (goertzel(r.pcm, 48000, freq) / (rms * rms) > 0.3) n++;
    }
    return n * 20;
  }
  firstToneAt(freq, from = 0) {
    for (const r of this.audioFrames(from)) {
      const rms = rmsOf(r.pcm); if (rms < 800) continue;
      if (goertzel(r.pcm, 48000, freq) / (rms * rms) > 0.3) return r.at;
    }
    return null;
  }
  maxRms(from = 0, to = Infinity) { let m = 0; for (const r of this.audioFrames(from, to)) m = Math.max(m, rmsOf(r.pcm)); return m; }

  async close() {
    clearInterval(this.timer); this.timer = null;
    try { await this.pc.close(); } catch {}
    this.enc.delete(); this.dec.delete();
  }
}
