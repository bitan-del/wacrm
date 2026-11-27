/* PCM16 helpers. bufferToInt16 / int16ToBuffer / resample / FirLowpass / rmsOf are the helpers
   from the production Plivo ⇄ Gemini Live bridge (nutriherb src/server/voice.js), unchanged.
   StreamResampler / RateConverter are the streaming versions used on the live path: they carry
   the fractional read position and the previous chunk's last sample across chunk boundaries, so
   20 ms frames join without clicks and the long-run sample count is exact. */

/* ---------------- from the production bridge ---------------- */
export function bufferToInt16(buf) {
  const n = buf.length >> 1, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
export function int16ToBuffer(pcm) {
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] < -32768 ? -32768 : pcm[i] > 32767 ? 32767 : pcm[i]; buf.writeInt16LE(v | 0, i * 2); }
  return buf;
}
/** Linear-interpolation resampler (stateless, one chunk at a time). */
export function resample(pcm, inRate, outRate) {
  if (inRate === outRate || pcm.length === 0) return pcm;
  const ratio = outRate / inRate, outLen = Math.max(1, Math.round(pcm.length * ratio)), out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const p = i / ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, pcm.length - 1), f = p - i0;
    out[i] = (pcm[i0] * (1 - f) + pcm[i1] * f) | 0;
  }
  return out;
}
/** Stateful windowed-sinc (Blackman) low-pass. Keeps the tail of the previous chunk so chunk
    boundaries do not click. */
export class FirLowpass {
  constructor(rate, cutoffHz, taps = 33) {
    this.rate = rate; this.cutoff = cutoffHz;
    const h = new Float32Array(taps), m = (taps - 1) / 2, fc = cutoffHz / rate; let sum = 0;
    for (let n = 0; n < taps; n++) {
      const k = n - m;
      const sinc = k === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * k) / k;
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
      h[n] = sinc * w; sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;
    this.h = h; this.hist = new Float32Array(taps - 1);
  }
  process(pcm) {
    const h = this.h, taps = h.length, H = this.hist;
    const ext = new Float32Array(H.length + pcm.length); ext.set(H, 0);
    for (let i = 0; i < pcm.length; i++) ext[H.length + i] = pcm[i];
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      let acc = 0; const base = i + H.length;
      for (let n = 0; n < taps; n++) acc += h[n] * ext[base - n];
      out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
    }
    H.set(ext.subarray(ext.length - H.length));
    return out;
  }
}
export function rmsOf(pcm) { let s = 0; for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i]; return Math.sqrt(s / (pcm.length || 1)); }

/* ---------------- streaming conversion for the live path ---------------- */
/** Linear interpolation that keeps state across chunks (arbitrary ratio). */
export class StreamResampler {
  constructor(inRate, outRate) {
    this.inRate = inRate; this.outRate = outRate;
    this.step = inRate / outRate; this.pos = 0; this.prev = 0;
  }
  process(input) {
    if (this.inRate === this.outRate) return input;
    const n = input.length; if (!n) return new Int16Array(0);
    const est = Math.ceil((n + 1) / this.step) + 1;
    const out = new Int16Array(est); let k = 0, pos = this.pos;
    for (;;) {
      const i0 = Math.floor(pos);
      if (i0 + 1 >= n) break;
      const f = pos - i0;
      const a = i0 < 0 ? this.prev : input[i0], b = input[i0 + 1];
      const v = a + (b - a) * f;
      out[k++] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
      pos += this.step;
    }
    this.pos = pos - n; this.prev = input[n - 1];
    return out.subarray(0, k);
  }
}
/** Rate conversion with filtering: anti-alias low-pass before downsampling, image-smoothing
    low-pass after upsampling. */
export class RateConverter {
  constructor(inRate, outRate, taps = 33) {
    this.inRate = inRate; this.outRate = outRate;
    this.rs = new StreamResampler(inRate, outRate);
    this.pre = outRate < inRate ? new FirLowpass(inRate, 0.45 * outRate, taps) : null;
    this.post = outRate > inRate ? new FirLowpass(outRate, 0.45 * inRate, taps) : null;
  }
  process(pcm) {
    if (this.inRate === this.outRate) return pcm;
    let x = this.pre ? this.pre.process(pcm) : pcm;
    x = this.rs.process(x);
    return this.post && x.length ? this.post.process(x) : x;
  }
}

/* ---------------- generators / analysis (mock AI + tests) ---------------- */
/** A sine tone, PCM16 mono. `phase` = sample offset so consecutive chunks join seamlessly. */
export function tone(freq, rate, samples, amp = 8000, phase = 0) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * (i + phase)) / rate));
  return out;
}
/** Goertzel power of one frequency (normalised by length). */
export function goertzel(pcm, rate, freq) {
  const w = (2 * Math.PI * freq) / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < pcm.length; i++) { const s = pcm[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (pcm.length * pcm.length || 1);
}
/** Strongest frequency between lo and hi (Hz), coarse scan then fine scan. */
export function dominantFrequency(pcm, rate, lo = 100, hi = 3000) {
  if (!pcm.length) return 0;
  let best = lo, bp = -1;
  for (let f = lo; f <= hi; f += 20) { const p = goertzel(pcm, rate, f); if (p > bp) { bp = p; best = f; } }
  let fine = best; bp = -1;
  for (let f = Math.max(lo, best - 20); f <= Math.min(hi, best + 20); f += 2) { const p = goertzel(pcm, rate, f); if (p > bp) { bp = p; fine = f; } }
  return fine;
}
export function concatInt16(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Int16Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
