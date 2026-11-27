import os from "node:os";
import { readFileSync } from "node:fs";

export const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
})();

const int = (v, d) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? n : d; };
const str = (v, d = "") => (v == null || String(v).trim() === "" ? d : String(v).trim());

/** The first non-internal IPv4 address, skipping container / VPN bridges. */
export function detectBindIp() {
  const nets = os.networkInterfaces();
  const skip = /^(docker|br-|veth|virbr|cni|flannel|cali|tun|tap|utun|lo|awdl|llw|bridge)/i;
  let fallback = "";
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.internal || (a.family !== "IPv4" && a.family !== 4)) continue;
      if (a.address.startsWith("169.254.")) continue;
      if (!skip.test(name)) return a.address;
      fallback = fallback || a.address;
    }
  }
  return fallback;
}

/** All runtime settings, from the environment (or an explicit object in tests). */
export function loadConfig(env = process.env) {
  const cfg = {
    port: int(env.PORT, 8080),
    host: str(env.HOST, "0.0.0.0"),
    secret: str(env.VOICE_SERVER_SECRET),
    // media / ICE
    publicIp: str(env.PUBLIC_IP),
    bindIp: str(env.RTC_BIND_IP) || detectBindIp(),
    rtcPortMin: int(env.RTC_PORT_MIN, 40000),
    rtcPortMax: int(env.RTC_PORT_MAX, 40100),
    stunUrl: str(env.STUN_URL),
    iceGatherTimeoutMs: int(env.ICE_GATHER_TIMEOUT_MS, 2500),
    // limits / timers
    maxSessions: int(env.MAX_SESSIONS, 40),
    defaultMaxDurationSec: int(env.DEFAULT_MAX_DURATION_SECONDS, 600),
    noMediaTimeoutSec: int(env.NO_MEDIA_TIMEOUT_SECONDS, 60),
    setupTimeoutSec: int(env.SETUP_TIMEOUT_SECONDS, 120),
    mediaConnectTimeoutSec: int(env.MEDIA_CONNECT_TIMEOUT_SECONDS, 20),
    hangupFallbackMs: int(env.HANGUP_FALLBACK_MS, 15000),
    endedRetentionMs: int(env.ENDED_RETENTION_MS, 10 * 60 * 1000),
    // Gemini Live (defaults = the production nutriherb bridge's settings)
    geminiModel: str(env.GEMINI_MODEL, "gemini-3.1-flash-live-preview"),
    geminiApiKey: str(env.GEMINI_API_KEY), // fallback when a request carries no gemini.api_key
    geminiVoice: str(env.GEMINI_VOICE, "Aoede"),
    geminiWsUrl: str(env.GEMINI_WS_URL), // override (tests / a proxy); default is Google's endpoint
    geminiThinking: env.GEMINI_THINKING == null ? "0" : String(env.GEMINI_THINKING).trim(),
    geminiSetupTimeoutMs: int(env.GEMINI_SETUP_TIMEOUT_MS, 10000),
    vad: {
      silenceMs: int(env.VAD_SILENCE_MS, 250),
      prefixMs: int(env.VAD_PREFIX_MS, 80),
      start: str(env.VAD_START_SENSITIVITY, "low").toLowerCase(),
      endSensitivity: str(env.VAD_END_SENSITIVITY, "low").toLowerCase(),
    },
    allowMockAi: str(env.ALLOW_MOCK_AI, "1") !== "0",
    opusBitrate: int(env.OPUS_BITRATE, 32000),
    logLevel: str(env.LOG_LEVEL, "info").toLowerCase(),
  };
  return cfg;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.secret || cfg.secret.length < 16) errors.push("VOICE_SERVER_SECRET must be set (at least 16 characters)");
  if (!(cfg.rtcPortMin > 0 && cfg.rtcPortMax <= 65535 && cfg.rtcPortMin < cfg.rtcPortMax)) errors.push("RTC_PORT_MIN must be < RTC_PORT_MAX, both in 1..65535");
  if (cfg.publicIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(cfg.publicIp)) errors.push("PUBLIC_IP must be an IPv4 address");
  if (cfg.stunUrl && !/^stun:/i.test(cfg.stunUrl)) errors.push("STUN_URL must look like stun:host:port");
  return errors;
}
