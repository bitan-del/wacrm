import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resample, StreamResampler, RateConverter, tone, rmsOf, dominantFrequency, bufferToInt16, int16ToBuffer, concatInt16 } from "../src/audio.js";
import { OpusEncoder, OpusDecoder, opusPacketSamples } from "../src/opus.js";

const require = createRequire(import.meta.url);

/** Best normalised cross-correlation of b against a over lags 0..maxLag (b delayed). */
function bestCorr(a, b, maxLag) {
  let best = -1, lagAt = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0, sa = 0, sb = 0; const n = Math.min(a.length, b.length - lag);
    for (let i = 0; i < n; i++) { const x = a[i], y = b[i + lag]; s += x * y; sa += x * x; sb += y * y; }
    const c = s / Math.sqrt(sa * sb || 1); if (c > best) { best = c; lagAt = lag; }
  }
  return { corr: best, lag: lagAt };
}
const chirp = (rate, n, f0 = 200, f1 = 3000) => { const o = new Int16Array(n); for (let i = 0; i < n; i++) { const t = i / rate, T = n / rate; o[i] = Math.round(9000 * Math.sin(2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T)))); } return o; };

test("pcm16 buffer conversion round-trips and clamps", () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  assert.deepEqual(bufferToInt16(int16ToBuffer(pcm)), pcm);
  assert.deepEqual(Array.from(bufferToInt16(int16ToBuffer([40000, -40000]))), [32767, -32768]);
});

test("stateless resample (production helper): lengths and frequency", () => {
  const x = tone(440, 24000, 2400);
  const y = resample(x, 24000, 48000);
  assert.equal(y.length, 4800);
  assert.ok(Math.abs(dominantFrequency(y, 48000) - 440) <= 4);
  assert.equal(resample(x, 24000, 24000), x);
  assert.equal(resample(tone(1000, 48000, 960), 48000, 16000).length, 320);
});

test("StreamResampler: 48k→16k gives exactly 320 samples per 20 ms frame and matches one-shot", () => {
  const rs = new StreamResampler(48000, 16000);
  const x = tone(1000, 48000, 960 * 50);
  const outs = [];
  for (let i = 0; i < 50; i++) { const o = rs.process(x.subarray(i * 960, (i + 1) * 960)); assert.equal(o.length, 320); outs.push(o); }
  const y = concatInt16(outs);
  for (let i = 0; i < y.length; i++) assert.equal(y[i], x[i * 3]); // integer ratio: exact decimation
});

test("StreamResampler: 24k→48k is continuous across chunk boundaries and sample-exact over time", () => {
  const rs = new StreamResampler(24000, 48000);
  const x = tone(440, 24000, 24000);
  const outs = []; let n = 0;
  for (let off = 0; off < x.length; off += 960) { const o = rs.process(x.subarray(off, off + 960)); outs.push(o); n += o.length; }
  assert.ok(Math.abs(n - 48000) <= 2, "1 s in → ~1 s out (" + n + ")");
  const y = concatInt16(outs);
  let maxJump = 0; for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
  const ideal = 8000 * 2 * Math.PI * 440 / 48000; // max slope of the sine per output sample
  assert.ok(maxJump <= ideal * 1.1 + 2, "no clicks at chunk joins (max step " + maxJump + ", sine slope " + ideal.toFixed(1) + ")");
  assert.ok(Math.abs(dominantFrequency(y, 48000) - 440) <= 4);
});

test("RateConverter 48k→16k suppresses content above the new Nyquist (anti-alias)", () => {
  const conv = new RateConverter(48000, 16000);
  const hi = tone(12000, 48000, 9600); // would alias to 4 kHz without filtering
  const lo = tone(1000, 48000, 9600);
  const yHi = conv.process(hi), yLo = new RateConverter(48000, 16000).process(lo);
  assert.ok(rmsOf(yHi.subarray(100)) < 0.05 * rmsOf(hi), "12 kHz attenuated > 26 dB");
  assert.ok(rmsOf(yLo.subarray(100)) > 0.9 * rmsOf(lo), "1 kHz passes");
});

test("RateConverter 24k→48k keeps speech-band tones", () => {
  const conv = new RateConverter(24000, 48000);
  const outs = []; for (let i = 0; i < 25; i++) outs.push(conv.process(tone(660, 24000, 960, 8000, i * 960)));
  const y = concatInt16(outs);
  assert.ok(Math.abs(dominantFrequency(y, 48000) - 660) <= 4);
  assert.ok(Math.abs(rmsOf(y.subarray(200)) - 8000 / Math.SQRT2) < 400);
});

test("Opus: 48 kHz mono PCM → Opus → PCM round trip preserves the waveform", () => {
  const enc = new OpusEncoder({ bitrate: 32000 }), dec = new OpusDecoder();
  try {
    const x = chirp(48000, 960 * 50), outs = [];
    for (let i = 0; i < 50; i++) {
      const pkt = enc.encode(x.subarray(i * 960, (i + 1) * 960));
      assert.ok(pkt.length > 0 && pkt.length < 400);
      assert.equal(opusPacketSamples(pkt), 960, "20 ms packet");
      const pcm = dec.decode(pkt); assert.equal(pcm.length, 960); outs.push(pcm);
    }
    const { corr, lag } = bestCorr(x.subarray(0, 24000), concatInt16(outs), 600);
    assert.ok(corr > 0.9, "decoded ≈ input (corr " + corr.toFixed(3) + " at lag " + lag + ")");
    const silent = enc.encode(new Int16Array(960));
    assert.ok(silent.length < 120, "silence frames are small (" + silent.length + " bytes)");
  } finally { enc.delete(); dec.delete(); }
});

test("Opus: decodes a stereo stream (opus/48000/2) to mono", () => {
  const OpusScript = require("opusscript");
  const st = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const dec = new OpusDecoder();
  try {
    const mono = tone(500, 48000, 960), inter = new Int16Array(1920);
    for (let i = 0; i < 960; i++) { inter[2 * i] = mono[i]; inter[2 * i + 1] = mono[i]; }
    let out;
    for (let k = 0; k < 5; k++) out = dec.decode(st.encode(Buffer.from(inter.buffer), 960));
    assert.equal(out.length, 960);
    assert.ok(Math.abs(dominantFrequency(out, 48000) - 500) <= 4);
  } finally { st.delete(); dec.delete(); }
});

test("Opus wrapper is byte-identical to opusscript's own wrapper (same wasm, same data layout)", () => {
  const OpusScript = require("opusscript");
  const e1 = new OpusEncoder({ fec: false, complexity: 10, bitrate: 64000 }), d1 = new OpusDecoder();
  const e2 = new OpusScript(48000, 1, OpusScript.Application.VOIP), d2 = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  e2.setBitrate(64000); e2.encoderCTL(4024, 3001);
  try {
    for (let i = 0; i < 20; i++) {
      const pcm = tone(523, 48000, 960, 8000, i * 960);
      const p1 = e1.encode(pcm), p2 = e2.encode(Buffer.from(pcm.buffer), 960);
      assert.deepEqual(p1, p2, "encode frame " + i);
      assert.deepEqual(Buffer.from(d1.decode(p2).buffer), d2.decode(p2), "decode frame " + i);
    }
  } finally { e1.delete(); d1.delete(); e2.delete(); d2.delete(); }
});

test("Opus: many concurrent codecs (wasm heap growth) do not break older instances", () => {
  const old = new OpusEncoder(), oldDec = new OpusDecoder();
  const many = [];
  try {
    for (let i = 0; i < 300; i++) many.push(new OpusEncoder(), new OpusDecoder());
    const pkt = old.encode(tone(440, 48000, 960));
    assert.equal(oldDec.decode(pkt).length, 960);
    const last = many[many.length - 2].encode(tone(440, 48000, 960));
    assert.equal(many[many.length - 1].decode(last).length, 960);
  } finally { old.delete(); oldDec.delete(); for (const m of many) m.delete(); }
});
