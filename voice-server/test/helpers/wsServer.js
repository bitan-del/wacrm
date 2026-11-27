/* Minimal RFC 6455 WebSocket server for a local fake Gemini Live endpoint (no dependencies).
   Adapted from the production bridge's WsConn / attachWsServer (nutriherb src/server/voice.js). */
import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WsConn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket; this.req = req; this.buf = Buffer.alloc(0); this.frag = null; this.fragOp = 0; this.closed = false;
    socket.on("data", (d) => this._feed(d));
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
  }
  _closed() { if (this.closed) return; this.closed = true; this.emit("close"); }
  _feed(d) { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; try { this._parse(); } catch { this.close(); } }
  _parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (masked && b.length < off + 4) return;
      const mask = masked ? b.subarray(off, off + 4) : null; if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) { if (this.frag) { this.frag.push(payload); if (fin) { const full = Buffer.concat(this.frag), fo = this.fragOp; this.frag = null; this._deliver(fo, full); } } continue; }
      if (!fin) { this.frag = [payload]; this.fragOp = op; continue; }
      this._deliver(op, payload);
    }
  }
  _deliver(op, payload) { if (op === 0x1 || op === 0x2) this.emit("message", payload.toString("utf8")); }
  _send(op, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length; let hdr;
    if (len < 126) { hdr = Buffer.alloc(2); hdr[1] = len; }
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    hdr[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([hdr, payload])); } catch {}
  }
  send(v) { if (this.closed) return; this._send(0x1, Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8")); }
  /** Close with a status code (e.g. 1007 like a refused setup). */
  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(reason, "utf8"); const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this._send(0x8, p); } catch {}
    this.closed = true; try { this.socket.end(); } catch {} this.emit("close");
  }
}

/** @param {(conn: WsConn) => void} onConnection */
export async function startWsServer(onConnection) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = new Set();
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const conn = new WsConn(socket, req); conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    if (head && head.length) conn._feed(head);
    onConnection(conn);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: "ws://127.0.0.1:" + server.address().port + "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    close: () => new Promise((r) => { for (const c of conns) c.close(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
