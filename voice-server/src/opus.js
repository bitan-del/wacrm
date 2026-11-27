/* Opus encode/decode on top of opusscript's WebAssembly build of libopus 1.4.

   Why not `new OpusScript(...)` directly: opusscript's JS wrapper caches typed-array views of the
   wasm heap when an instance is created. The heap grows as more instances are created, which
   detaches those views, and every older instance then throws "Cannot perform
   %TypedArray%.prototype.set on a detached ArrayBuffer" on its next encode (reproduced with ~100
   encoder/decoder pairs — i.e. a few dozen concurrent calls). It also points its PCM views at
   twice the malloc'd address. This wrapper drives the same wasm module (`OpusScriptHandler`)
   but takes fresh heap views on every call and allocates PCM buffers large enough for what the C
   side actually touches, so any number of concurrent calls is safe.

   Data layout expected by opusscript's C++ handler (mirrored exactly from opusscript/index.js,
   and verified byte-for-byte against it in test/opus.test.js):
     _encode(pcmPtr, nBytes, outPtr, frameSize): PCM16LE input, ONE BYTE PER uint16 SLOT
                                                 (nBytes slots), returns the opus packet length.
     _decode(inPtr, nBytes, pcmPtr):             returns samples per channel; the PCM16LE output
                                                 bytes come back ONE BYTE PER uint16 SLOT too. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const MAX_FRAME_SIZE = (48000 * 60) / 1000; // 60 ms at 48 kHz, per channel
const MAX_PACKET_SIZE = 1276 * 3;
const OPUS_APPLICATION_VOIP = 2048;
// encoder CTLs (opus_defines.h)
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;
const OPUS_SET_SIGNAL = 4024;
const OPUS_SIGNAL_VOICE = 3001;

let native = null;
function lib() {
  if (!native) native = require("opusscript/build/opusscript_native_wasm.js")();
  return native;
}

class OpusBase {
  constructor(sampleRate, channels) {
    if (![8000, 12000, 16000, 24000, 48000].includes(sampleRate)) throw new RangeError("invalid opus sample rate " + sampleRate);
    this.sampleRate = sampleRate;
    this.channels = channels;
    const m = lib();
    this.m = m;
    this.handler = new m.OpusScriptHandler(sampleRate, channels, OPUS_APPLICATION_VOIP);
    // PCM regions hold one byte per uint16 slot: 2 bytes of heap per PCM byte.
    this.pcmBytesMax = MAX_FRAME_SIZE * channels * 2;
    this.pcmPtr = m._malloc(this.pcmBytesMax * 2);
    this.pktPtr = m._malloc(MAX_PACKET_SIZE);
    if (!this.pcmPtr || !this.pktPtr) throw new Error("opus: wasm malloc failed");
    this.deleted = false;
  }
  delete() {
    if (this.deleted) return;
    this.deleted = true;
    try { this.m.OpusScriptHandler.destroy_handler(this.handler); } catch {}
    try { this.m._free(this.pcmPtr); this.m._free(this.pktPtr); } catch {}
  }
}

export class OpusEncoder extends OpusBase {
  /** @param {{sampleRate?:number, channels?:number, bitrate?:number, complexity?:number, fec?:boolean, lossPerc?:number}} [o] */
  constructor(o = {}) {
    super(o.sampleRate || 48000, o.channels || 1);
    this.ctl(OPUS_SET_SIGNAL, OPUS_SIGNAL_VOICE);
    this.ctl(OPUS_SET_BITRATE, o.bitrate || 32000);
    this.ctl(OPUS_SET_COMPLEXITY, o.complexity ?? 5);
    if (o.fec !== false) { this.ctl(OPUS_SET_INBAND_FEC, 1); this.ctl(OPUS_SET_PACKET_LOSS_PERC, o.lossPerc ?? 5); }
  }
  ctl(code, value) {
    const r = this.handler._encoder_ctl(code, value);
    if (r < 0) throw new Error("opus encoder ctl " + code + " failed: " + r);
  }
  /** @param {Int16Array} pcm interleaved samples; length must be a valid frame (2.5–60 ms) × channels. @returns {Buffer} */
  encode(pcm) {
    if (this.deleted) throw new Error("opus encoder deleted");
    const frameSize = pcm.length / this.channels;
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength); // PCM16LE (all supported hosts are little-endian)
    if (bytes.length > this.pcmBytesMax) throw new RangeError("opus frame too large");
    const m = this.m;
    new Uint16Array(m.HEAPU8.buffer, this.pcmPtr, bytes.length).set(bytes); // fresh view: survives heap growth
    const len = this.handler._encode(this.pcmPtr, bytes.length, this.pktPtr, frameSize);
    if (len < 0) throw new Error("opus encode error " + len);
    return Buffer.from(m.HEAPU8.subarray(this.pktPtr, this.pktPtr + len));
  }
}

export class OpusDecoder extends OpusBase {
  constructor(o = {}) {
    super(o.sampleRate || 48000, o.channels || 1);
  }
  /** @param {Uint8Array} packet @returns {Int16Array} interleaved PCM */
  decode(packet) {
    if (this.deleted) throw new Error("opus decoder deleted");
    if (!packet || !packet.length || packet.length > MAX_PACKET_SIZE) throw new RangeError("bad opus packet size");
    const m = this.m;
    m.HEAPU8.set(packet, this.pktPtr);
    const samples = this.handler._decode(this.pktPtr, packet.length, this.pcmPtr);
    if (samples < 0) throw new Error("opus decode error " + samples);
    const nBytes = samples * this.channels * 2;
    const slots = new Uint16Array(m.HEAPU8.buffer, this.pcmPtr, nBytes);
    const out = new Int16Array(samples * this.channels);
    const ob = new Uint8Array(out.buffer);
    for (let i = 0; i < nBytes; i++) ob[i] = slots[i] & 0xff;
    return out;
  }
}

/** Samples per channel in an Opus packet (RFC 6716 §3.1 TOC), or 0 if malformed. */
export function opusPacketSamples(packet, sampleRate = 48000) {
  if (!packet || !packet.length) return 0;
  const toc = packet[0], config = toc >> 3, code = toc & 3;
  let frameMs10; // frame duration in units of 0.1 ms
  if (config < 12) frameMs10 = [100, 200, 400, 600][config & 3];
  else if (config < 16) frameMs10 = [100, 200][config & 1];
  else frameMs10 = [25, 50, 100, 200][config & 3];
  let frames;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else { if (packet.length < 2) return 0; frames = packet[1] & 0x3f; }
  return Math.round((frames * frameMs10 * sampleRate) / 10000);
}
