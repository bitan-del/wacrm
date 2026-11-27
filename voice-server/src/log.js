const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Minimal line logger. `scope` is prefixed (e.g. a session id); never pass secrets to it. */
export function createLogger(level = "info", scope = "") {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl, args) => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const line = [new Date().toISOString(), lvl.toUpperCase().padEnd(5), scope ? "[" + scope + "]" : "", ...args].filter((x) => x !== "").join(" ");
    (lvl === "error" || lvl === "warn" ? console.error : console.log)(line);
  };
  return {
    level,
    debug: (...a) => out("debug", a),
    info: (...a) => out("info", a),
    warn: (...a) => out("warn", a),
    error: (...a) => out("error", a),
    child: (s) => createLogger(level, scope ? scope + " " + s : s),
  };
}
