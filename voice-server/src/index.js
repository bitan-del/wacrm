#!/usr/bin/env node
import { loadConfig, validateConfig, VERSION } from "./config.js";
import { createVoiceServer } from "./server.js";
import { createLogger } from "./log.js";

const cfg = loadConfig();
const log = createLogger(cfg.logLevel, "voice");
const errors = validateConfig(cfg);
if (errors.length) {
  for (const e of errors) log.error("config: " + e);
  process.exit(1);
}
if (!cfg.publicIp) log.warn("PUBLIC_IP is not set: SDP will advertise the bound interface address " + (cfg.bindIp || "(all interfaces)") + " — fine only if that address is public");

const { server, shutdown } = createVoiceServer(cfg, { log });
server.listen(cfg.port, cfg.host, () => {
  log.info(`voice-server ${VERSION} listening on ${cfg.host}:${cfg.port} — media ${cfg.bindIp || "*"} udp ${cfg.rtcPortMin}-${cfg.rtcPortMax}` + (cfg.publicIp ? ` advertised as ${cfg.publicIp}` : "") + ` — model ${cfg.geminiModel}`);
});

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(sig + ": ending live sessions");
    try { await shutdown("server_shutdown"); } catch {}
    process.exit(0);
  });
}
process.on("unhandledRejection", (e) => log.error("unhandled rejection: " + ((e && e.stack) || e)));
process.on("uncaughtException", (e) => log.error("uncaught exception: " + ((e && e.stack) || e)));
