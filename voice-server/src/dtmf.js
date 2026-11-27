/* RFC 4733 telephone-event payloads (DTMF over RTP).
   One key press = several packets with the SAME RTP timestamp (duration growing), the last three
   with the E (end) bit set. A digit is reported once, on the first packet of a new timestamp. */
export const DTMF_EVENTS = "0123456789*#ABCD";

export function parseTelephoneEvent(payload) {
  if (!payload || payload.length < 4) return null;
  const event = payload[0];
  return {
    event,
    digit: event < 16 ? DTMF_EVENTS[event] : null,
    end: (payload[1] & 0x80) !== 0,
    volume: payload[1] & 0x3f,
    duration: (payload[2] << 8) | payload[3],
  };
}

export function buildTelephoneEvent({ digit, end = false, volume = 10, duration = 0 }) {
  const event = typeof digit === "number" ? digit : DTMF_EVENTS.indexOf(String(digit).toUpperCase());
  if (event < 0) throw new RangeError("not a DTMF digit: " + digit);
  return Buffer.from([event, (end ? 0x80 : 0) | (volume & 0x3f), (duration >> 8) & 0xff, duration & 0xff]);
}

export class DtmfDetector {
  constructor(onDigit) { this.onDigit = onDigit; this.lastTs = null; }
  /** @param {number} timestamp RTP timestamp @param {Buffer} payload */
  push(timestamp, payload) {
    const ev = parseTelephoneEvent(payload);
    if (!ev || ev.digit == null) return;
    if (timestamp === this.lastTs) return;
    this.lastTs = timestamp;
    this.onDigit(ev.digit);
  }
}
