/**
 * Browser WebRTC helpers for WhatsApp calling.
 *
 * Meta's media endpoint is ICE-lite and expects complete SDP (no
 * trickle), so every description we hand the server waits for ICE
 * gathering to finish (bounded — a slow STUN server must not eat the
 * 30–60 s Meta gives us to answer).
 */

export const CALL_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

/** Max time to wait for ICE gathering before sending what we have. */
const ICE_GATHER_TIMEOUT_MS = 2500

export function isCallingSupportedInBrowser(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.RTCPeerConnection === 'function' &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

export async function getMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  })
}

export function createCallPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS, bundlePolicy: 'max-bundle' })
}

export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = ICE_GATHER_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

/** Inbound: apply Meta's offer and produce our complete answer SDP. */
export async function buildAnswer(pc: RTCPeerConnection, offerSdp: string): Promise<string> {
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceGathering(pc)
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new Error('No local description after createAnswer')
  return sdp
}

/** Outbound: produce our complete offer SDP. */
export async function buildOffer(pc: RTCPeerConnection): Promise<string> {
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc)
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new Error('No local description after createOffer')
  return sdp
}

/** Outbound: apply Meta's answer once it arrives (idempotent). */
export async function applyAnswer(pc: RTCPeerConnection, answerSdp: string): Promise<boolean> {
  if (pc.signalingState !== 'have-local-offer') return false
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
  return true
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

/** Seconds → "m:ss" / "h:mm:ss". */
export function formatCallDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
