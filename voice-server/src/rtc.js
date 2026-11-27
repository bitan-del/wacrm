/* One WebRTC audio leg with Meta, on werift: ICE (full agent; Meta is ICE-lite so we are
   controlling), DTLS-SRTP, RTP. Audio only: Opus 48 kHz (pt 111) + telephone-event/8000 (pt 126),
   sendrecv, rtcp-mux, BUNDLE. Complete SDP only (no trickle) — Meta does not trickle.

   Receive path: every SRTP-decrypted RTP packet on the transport is taken straight from the DTLS
   transport (`onRtp`), not from werift's SSRC router. There is a single m-line, so nothing needs
   demuxing, and it keeps working if the far end's SDP carries no a=ssrc lines (werift's router
   drops packets whose SSRC it was never told about).
   Send path: RTCRtpSender.sendRtp — werift sets our SSRC and payload type and keeps the sequence
   number / timestamp we give it (offset 0 unless a source is replaced), and sends RTCP SRs. */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, RtpHeader } = require("werift");

export const OPUS_PT = 111;
export const DTMF_PT = 126;

export function audioCodecs() {
  return [
    new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: OPUS_PT, parameters: "minptime=10;useinbandfec=1" }),
    new RTCRtpCodecParameters({ mimeType: "audio/telephone-event", clockRate: 8000, channels: 1, payloadType: DTMF_PT }),
  ];
}

/* werift's findPort() probes the range, closes the probe socket and binds later, so two peers
   gathering at the same moment can pick the same port. Gathering is serialised per process. */
let gatherChain = Promise.resolve();
function withGatherLock(fn) {
  const run = gatherChain.then(fn, fn);
  gatherChain = run.catch(() => {});
  return run;
}

/** Payload types the far end uses for opus / telephone-event, read from its SDP rtpmap lines. */
export function parseAudioPayloadTypes(sdp) {
  const out = { opus: null, dtmf: [] };
  for (const line of String(sdp || "").split(/\r?\n/)) {
    const m = /^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/i.exec(line);
    if (!m) continue;
    const pt = Number(m[1]), name = m[2].toLowerCase();
    if (name === "opus" && out.opus == null) out.opus = pt;
    else if (name === "telephone-event") out.dtmf.push(pt);
  }
  return out;
}

/** Reject SDP that cannot work here before werift sees it (it accepts some garbage silently). */
export function checkRemoteSdp(sdp) {
  const s = String(sdp || "");
  const missing = [];
  if (!/^v=0\r?\n/.test(s)) missing.push("v=0");
  if (!/^m=audio \d+ [A-Z/]*SAVPF? [\d ]+/m.test(s)) missing.push("an m=audio line");
  if (!/^a=ice-ufrag:\S+/m.test(s) || !/^a=ice-pwd:\S+/m.test(s)) missing.push("ICE credentials");
  if (!/^a=fingerprint:\S+ \S+/m.test(s)) missing.push("a DTLS fingerprint");
  if (!/^a=candidate:/m.test(s)) missing.push("ICE candidates (complete SDP required, no trickle)");
  if (!parseAudioPayloadTypes(s).opus) missing.push("Opus");
  if (missing.length) { const e = new Error("SDP is missing " + missing.join(", ")); e.status = 400; throw e; }
}

/**
 * Make a complete SDP presentable to Meta: with PUBLIC_IP, host candidates advertise it (1:1 NAT,
 * same port — the classic "announced IP"); the c= line, m= port and a=rtcp take the first
 * candidate's address, as a browser's do after gathering.
 */
export function finalizeSdp(sdp, { publicIp = "" } = {}) {
  const lines = String(sdp).split(/\r\n|\n/);
  const seen = new Set();
  const out = [];
  let first = null;
  for (let line of lines) {
    if (line.startsWith("a=candidate:")) {
      const parts = line.slice(2).split(" ");
      // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
      if (publicIp && parts[2] && parts[2].toLowerCase() === "udp" && parts[7] === "host" && /^\d+\.\d+\.\d+\.\d+$/.test(parts[4])) {
        parts[4] = publicIp;
        line = "a=" + parts.join(" ");
      }
      const key = parts[2] + " " + parts[4] + " " + parts[5];
      if (seen.has(key)) continue;
      seen.add(key);
      if (!first && parts[2] && parts[2].toLowerCase() === "udp" && /^\d+\.\d+\.\d+\.\d+$/.test(parts[4])) first = { ip: parts[4], port: parts[5] };
    }
    out.push(line);
  }
  if (first) {
    for (let i = 0; i < out.length; i++) {
      if (out[i].startsWith("m=audio ")) out[i] = out[i].replace(/^m=audio \d+ /, "m=audio " + first.port + " ");
      else if (out[i].startsWith("c=IN IP4 ")) out[i] = "c=IN IP4 " + first.ip;
      else if (out[i].startsWith("a=rtcp:")) out[i] = "a=rtcp:" + first.port + " IN IP4 " + first.ip;
    }
  }
  let s = out.join("\r\n");
  if (!s.endsWith("\r\n")) s += "\r\n";
  return s;
}

export class MediaPeer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.bindIp]  bind ICE UDP to this local IPv4 only (one socket per call)
   * @param {string} [o.publicIp] advertise this IPv4 instead of the bound one
   * @param {[number, number]} [o.portRange]
   * @param {string} [o.stunUrl]
   * @param {number} [o.gatherTimeoutMs]
   * @param {boolean} [o.iceLite]  (tests: the fake Meta)
   * @param {object} [o.log]
   */
  constructor(o = {}) {
    super();
    this.o = o; this.log = o.log;
    this.pc = new RTCPeerConnection({
      codecs: { audio: audioCodecs(), video: [] },
      headerExtensions: { audio: [], video: [] },
      iceServers: o.stunUrl ? [{ urls: o.stunUrl }] : [],
      iceUseDefaultStunServer: false,
      iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false, iceTcpPassive: false,
      ...(o.bindIp ? { iceInterfaceAddresses: { udp4: o.bindIp } } : {}),
      ...(o.portRange ? { icePortRange: o.portRange } : {}),
      iceStunGatherTimeout: 2,
      iceLite: !!o.iceLite,
      bundlePolicy: "max-bundle",
    });
    this.transceiver = null; this.remotePts = { opus: OPUS_PT, dtmf: [DTMF_PT] };
    this.state = "new"; this.connected = false; this.closed = false;
    this.hooked = new Set();
    // outbound RTP numbering (RFC 3550: random initial values)
    this.seq = crypto.randomInt(0, 0x10000); this.ts = crypto.randomInt(0, 0x100000000); this.sentFirst = false;
    this.stats = { rtpIn: 0, rtpOut: 0, bytesIn: 0, bytesOut: 0, sendErrors: 0 };
    this.pc.connectionStateChange.subscribe((s) => {
      this.state = s;
      this.log?.debug("connection state", s);
      if (s === "connected" && !this.connected) { this.connected = true; this._hookTransports(); this.emit("connected"); }
      if (s === "failed") this.emit("failed", new Error("ICE/DTLS connection failed"));
      if (s === "disconnected") this.emit("disconnected");
    });
  }

  _hookTransports() {
    for (const t of this.pc.dtlsTransports) {
      if (this.hooked.has(t)) continue;
      this.hooked.add(t);
      t.onRtp.subscribe((rtp) => { this.stats.rtpIn++; this.stats.bytesIn += rtp.payload.length; this.emit("rtp", rtp); });
    }
  }

  async _gathered() {
    const pc = this.pc, timeout = this.o.gatherTimeoutMs || 2500;
    if (pc.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, timeout);
      const sub = pc.iceGatheringStateChange.subscribe((s) => { if (s === "complete") done(); });
      function done() { clearTimeout(timer); try { sub.unSubscribe(); } catch {} resolve(); }
    });
  }

  _localSdp() {
    const sdp = this.pc.localDescription && this.pc.localDescription.sdp;
    if (!sdp) throw new Error("no local description");
    if (!/a=candidate:/.test(sdp)) throw new Error("no ICE candidates gathered (check RTC_BIND_IP / RTC_PORT_MIN..MAX)");
    return finalizeSdp(sdp, { publicIp: this.o.publicIp });
  }

  /** Inbound: apply Meta's offer, return our complete answer. */
  answer(offerSdp) {
    checkRemoteSdp(offerSdp);
    return withGatherLock(async () => {
      this.remotePts = { ...this.remotePts, ...parseAudioPayloadTypes(offerSdp) };
      await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const audio = this.pc.getTransceivers().filter((t) => t.kind === "audio");
      if (!audio.length) throw new Error("offer has no audio m-line");
      this.transceiver = audio[0];
      this.transceiver.setDirection("sendrecv");
      const ans = await this.pc.createAnswer();
      await this.pc.setLocalDescription(ans);
      this._hookTransports();
      await this._gathered();
      return this._localSdp();
    });
  }

  /** Outbound: our complete offer. */
  offer() {
    return withGatherLock(async () => {
      this.transceiver = this.pc.addTransceiver("audio", { direction: "sendrecv" });
      const off = await this.pc.createOffer();
      await this.pc.setLocalDescription(off);
      this._hookTransports();
      await this._gathered();
      return this._localSdp();
    });
  }

  /** Outbound: apply Meta's answer. */
  async setAnswer(answerSdp) {
    checkRemoteSdp(answerSdp);
    this.remotePts = { ...this.remotePts, ...parseAudioPayloadTypes(answerSdp) };
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this._hookTransports();
  }

  /** Send one encoded Opus frame. `samples` = 48 kHz samples it covers (960 for 20 ms). */
  sendOpus(payload, samples = 960) {
    if (this.closed || !this.transceiver) return;
    const header = new RtpHeader({ payloadType: OPUS_PT, sequenceNumber: this.seq, timestamp: this.ts, marker: !this.sentFirst });
    this.sentFirst = true;
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + samples) >>> 0;
    this.stats.rtpOut++; this.stats.bytesOut += payload.length;
    const p = this.transceiver.sender.sendRtp(new RtpPacket(header, payload));
    if (p && p.catch) p.catch(() => { this.stats.sendErrors++; });
  }

  /** Advance the RTP clock over frames that were not sent (event-loop stall), so the far end's
      jitter buffer sees a gap in time rather than audio arriving late. */
  skip(samples) { this.ts = (this.ts + samples) >>> 0; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.pc.close(); } catch {}
  }
}
