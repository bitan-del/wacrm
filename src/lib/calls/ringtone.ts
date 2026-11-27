/**
 * A synthesized ringtone (no audio asset to ship). Two short tones every
 * two seconds until stopped. Browsers may refuse to start an AudioContext
 * before the user has interacted with the page — in that case it stays
 * silent and the on-screen popup / browser notification carry the ring.
 */

export interface Ringtone {
  stop: () => void
}

export function startRingtone(): Ringtone {
  if (typeof window === 'undefined') return { stop: () => {} }
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return { stop: () => {} }

  let ctx: AudioContext
  try {
    ctx = new Ctx()
  } catch {
    return { stop: () => {} }
  }
  void ctx.resume().catch(() => {})

  const ring = () => {
    if (ctx.state === 'closed') return
    const now = ctx.currentTime
    for (const [offset, freq] of [
      [0, 880],
      [0.25, 660],
    ] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.24)
    }
  }

  ring()
  const interval = setInterval(ring, 2000)
  return {
    stop: () => {
      clearInterval(interval)
      void ctx.close().catch(() => {})
    },
  }
}
