# wacrm voice server

Lets a **Gemini Live** AI agent talk on **WhatsApp Business Cloud API calls**.

The Next.js app (on Vercel) keeps doing all the signalling with Meta — webhooks, `pre_accept` /
`accept` / `connect` / `terminate`. Vercel cannot hold a media session, so for AI-handled calls
the app hands the WebRTC leg to this small always-on server:

```
WhatsApp user ⇄ Meta media (ICE-lite, DTLS-SRTP, Opus 48 kHz)
                     ⇅  UDP 40000-40100
               voice-server (this)  ── RTP Opus ⇄ PCM ⇄ Gemini Live (WebSocket)
                     ⇅  HTTPS
               wacrm app on Vercel  (signalling + DB)
```

- **Inbound audio:** RTP Opus 48 kHz → decode (mono) → anti-alias low-pass → 16 kHz PCM16 → Gemini
  `realtimeInput`.
- **Outbound audio:** Gemini 24 kHz PCM16 → 48 kHz (+ smoothing low-pass) → queue → **fixed 20 ms
  clock** → Opus → RTP. Silence frames are sent whenever the AI is quiet, from the moment ICE/DTLS
  connects until the end, so Meta never hits its no-media timeout (~20 s at start, ~30 s mid-call).
- **DTMF:** RFC 4733 `telephone-event` is decoded; each key press goes to the transcript as
  `[pressed 5]` and to the model as a text turn.
- **Barge-in:** when Gemini signals `interrupted`, all queued AI audio is dropped at once.
- **Gemini wire format** (model, setup message, realtime input/output shapes, tool calls,
  transcription, VAD settings, language pin + fallback) is ported from the production Plivo ⇄
  Gemini Live bridge in the nutriherb project, not re-invented.

Stack: Node ≥ 22, plain ESM JavaScript (no build step), [`werift`](https://github.com/shinyoshiaki/werift-webrtc)
(pure TypeScript WebRTC) for ICE/DTLS/SRTP/RTP, libopus 1.4 compiled to WebAssembly (from the
`opusscript` package, driven by our own wrapper — see *Risks*), Node's built-in `WebSocket` for
Gemini. Two runtime dependencies, no native builds.

---

## Run it locally

```bash
cd voice-server
npm install
npm test                      # unit + API + local end-to-end WebRTC tests (no network, no keys)
VOICE_SERVER_SECRET=$(openssl rand -hex 32) npm start     # or: npm run dev (auto-restart)
curl localhost:8080/health
```

## HTTP API

All `/v1/*` routes need `Authorization: Bearer <VOICE_SERVER_SECRET>`. JSON in and out. Errors are
`{ "error": "message" }` with status 400 (validation / unusable SDP), 401 (bad or missing token),
404 (unknown session or route), 409 (wrong state), 413 (body > 512 KB), 503 (at `MAX_SESSIONS`).

### `GET /health` (no auth)
`{ "ok": true, "sessions": <live sessions>, "version": "0.1.0" }`

### `POST /v1/sessions`
```json
{
  "session_id": "uuid (the app's calls.id)",
  "direction": "inbound" | "outbound",
  "sdp_offer": "Meta's SDP offer — required for inbound",
  "persona": {
    "name": "Aisha", "voice": "Kore", "language": "hi-IN | en-IN | auto",
    "greeting": "first line to say", "instructions": "the persona's long system prompt",
    "max_duration_seconds": 600
  },
  "context": { "customer_name": "…", "customer_phone": "…", "business_name": "…", "notes": "free text" },
  "gemini": { "api_key": "…", "model": "optional override" },
  "callback": { "url": "https://app/api/whatsapp/calls/ai-events" }
}
```
→ `200 { "sdp": "…", "type": "answer" | "offer" }`

- **inbound:** `sdp` is our complete SDP **answer** to Meta's offer (`a=setup:active`, Opus/48000/2
  + telephone-event/8000 with Meta's payload types, our ICE candidate, `a=end-of-candidates`).
- **outbound:** `sdp` is our complete SDP **offer** (audio only, Opus/48000/2 pt 111
  `minptime=10;useinbandfec=1` + telephone-event/8000 pt 126, `sendrecv`, `rtcp-mux`, `BUNDLE`,
  `a=setup:actpass`).
- ICE gathering is awaited (max `ICE_GATHER_TIMEOUT_MS`, 2.5 s; with no STUN it takes a few ms).
- The Gemini Live connection is opened right away so it is warm, but **the AI says nothing and
  hears nothing until `/start`**.
- `session_id`: 1–128 chars of `A-Z a-z 0-9 . _ : -` (a UUID fits). A live duplicate → 409.
- `persona.max_duration_seconds` is clamped to 10–3600 (default `DEFAULT_MAX_DURATION_SECONDS`,
  600). Gemini Live audio sessions are capped by Google at about 15 minutes.
- `gemini.api_key` may be omitted if `GEMINI_API_KEY` is set on the server. The key is never
  logged or echoed.
- The SDP we receive must be complete (ICE credentials, fingerprint, at least one candidate, Opus);
  otherwise 400.

### `POST /v1/sessions/:id/remote-description` (outbound only)
Body `{ "sdp": "Meta's SDP answer" }` → `{ "ok": true }`. Sending the same SDP again is fine;
a different one → 409; on an inbound session → 409; unusable SDP → 400.

### `POST /v1/sessions/:id/start`
The call is live (inbound: the app's `accept` succeeded; outbound: the customer picked up).
The AI gets its kickoff turn and says the greeting; customer audio starts flowing to it.
Idempotent → `{ "ok": true }`. Outbound before the remote description → 409; ended session → 409.

### `POST /v1/sessions/:id/end`
Body `{ "reason": "…" }` (optional, default `app_ended`) → `{ "ok": true }`. Tears the session
down and sends the final `ended` event. Idempotent: an already-ended session (kept for
`ENDED_RETENTION_MS`, 10 min) answers `{ "ok": true, "already_ended": true }`.

### `GET /v1/sessions/:id` (extra, for ops/debugging)
State (`setup` / `live` / `ended`), timestamps, media counters (RTP in/out, loss, DTMF, frames to
the AI), AI state (ready, kicked, interruptions, queued audio), events sent.

### Session ends by itself when
- `max_duration_seconds` after `/start` → reason `max_duration`;
- no inbound RTP for `NO_MEDIA_TIMEOUT_SECONDS` (60) after `/start` → `no_media`;
- `/start` never came within `SETUP_TIMEOUT_SECONDS` (120) of creation → `setup_timeout`;
- the AI's `end_call` → `hangup_requested`, and the app did not call `/end` within
  `HANGUP_FALLBACK_MS` (15 s) → `agent_hangup`;
- a fatal error (below) → `ai_error` / `media_error`;
- the server receives SIGTERM → `server_shutdown`.

## Events to the app

`POST callback.url`, JSON body, header `X-Voice-Signature: sha256=<hex HMAC-SHA256 of the raw
body, keyed with VOICE_SERVER_SECRET>` (also `X-Voice-Event: <type>`). Retried twice (after
300 ms and 1.2 s) on network errors, timeouts (5 s) and 5xx; a 4xx is final. Delivery failures are
logged, never thrown. Events of one session are delivered in order.

| type | body |
|---|---|
| `hangup_requested` | `{ session_id, type, reason }` — the AI called `end_call(reason)`; sent once its goodbye audio has finished playing (queue drained + 0.5 s, max 15 s). The app should terminate the call at Meta and call `/end`. |
| `ended` | `{ session_id, type, reason, duration_seconds, transcript: [{ role: "agent"\|"customer", text, at }], notes: { key: value }, summary }` — exactly once per session. `duration_seconds` counts from `/start` (0 if never started). `summary` is the AI's `save_note("summary", …)`, or `""`. `reason` = the `/end` reason or one of the automatic reasons above. |
| `error` | `{ session_id, type, message }` — fatal: Gemini connect/setup failure or drop mid-call, ICE/DTLS failure, media not connected 20 s after `/start`. An `ended` event always follows. |

Verifying in the app (already implemented in `src/lib/whatsapp/voice-server.ts`):
```ts
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
// constant-time compare with the X-Voice-Signature header
```

## The agent

- **System instruction** = a short generated preamble (persona name, business name, customer name
  and notes, language guidance, "this is a live WhatsApp voice call — keep replies short and
  natural", tool usage) + `persona.instructions` verbatim.
- **Tools:** `end_call(reason)` and `save_note(key, value)` (max 100 notes, key ≤ 64 chars, value
  ≤ 2000). The preamble asks the model to save a `summary` note before hanging up.
- **Language:** a BCP-47 `persona.language` (e.g. `hi-IN`) is sent as Gemini's
  `speechConfig.languageCode` pin; `auto` sends none. If Gemini refuses the pin (closes the setup),
  the session reconnects once without it and the process stops sending pins (production behaviour).
- **Transcript** comes from Gemini's input/output audio transcription, merged per turn.
- **Defaults** (production values): model `gemini-3.1-flash-live-preview`, `thinkingBudget: 0`,
  VAD start/end sensitivity LOW, prefix 80 ms, silence 250 ms.

### Mock AI (tests / dry runs)
`"gemini": { "api_key": "mock" }` replaces Gemini with a local mock: the greeting is a 440 Hz
tone, each customer utterance is "transcribed" as `heard <freq> Hz for <ms> ms` and answered with
a tone, interruptions and keypad presses behave like Gemini's, and the usual events are sent. Tags
in `persona.instructions` tune it: `[mock:greeting_ms=N]`, `[mock:reply_ms=N]`, `[mock:end_call]`.
Disable with `ALLOW_MOCK_AI=0`.

## Environment

| var | default | |
|---|---|---|
| `VOICE_SERVER_SECRET` | — (required, ≥ 16 chars) | Bearer token for `/v1/*` and HMAC key for events. Same value as on Vercel. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listener. Use `HOST=127.0.0.1` when Caddy on the same host fronts it. |
| `PUBLIC_IP` | — | Public IPv4 advertised in our ICE candidate (1:1 NAT, e.g. GCE external IP). Set it on any VM. |
| `RTC_BIND_IP` | auto | Local IPv4 to bind media sockets to. Auto = first non-internal, non-docker interface. |
| `RTC_PORT_MIN` / `RTC_PORT_MAX` | `40000` / `40100` | UDP range; one port per live call. |
| `STUN_URL` | — | e.g. `stun:stun.l.google.com:19302`, only if you cannot set `PUBLIC_IP` (adds a server-reflexive candidate). |
| `MAX_SESSIONS` | `40` | Concurrent calls before 503. Keep ≤ the UDP range size. |
| `GEMINI_API_KEY` | — | Fallback key if a request has none. |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Default model (`gemini.model` overrides per call). |
| `GEMINI_VOICE` | `Aoede` | Default voice when `persona.voice` is empty. |
| `GEMINI_THINKING` | `0` | `0` = thinkingBudget 0; a word (`minimal`, `low`) = thinkingLevel; empty = model default. |
| `VAD_SILENCE_MS` / `VAD_PREFIX_MS` | `250` / `80` | Gemini automatic activity detection. |
| `VAD_START_SENSITIVITY` / `VAD_END_SENSITIVITY` | `low` / `low` | `low` or `high`. |
| `GEMINI_WS_URL` | Google's endpoint | Override (tests, or an egress proxy). |
| `GEMINI_SETUP_TIMEOUT_MS` | `10000` | Fail the AI if `setupComplete` does not arrive. |
| `DEFAULT_MAX_DURATION_SECONDS` | `600` | |
| `NO_MEDIA_TIMEOUT_SECONDS` | `60` | After `/start`. |
| `SETUP_TIMEOUT_SECONDS` | `120` | Creation → `/start`. |
| `MEDIA_CONNECT_TIMEOUT_SECONDS` | `20` | After `/start`, ICE/DTLS must be up. |
| `HANGUP_FALLBACK_MS` | `15000` | After `hangup_requested`, end ourselves if the app does not. |
| `ICE_GATHER_TIMEOUT_MS` | `2500` | |
| `OPUS_BITRATE` | `32000` | Outbound Opus bitrate (mono, VOIP, in-band FEC on). |
| `ALLOW_MOCK_AI` | `1` | `0` refuses `api_key: "mock"`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

## Deploying on a VM

Any small Linux VM with a **public IPv4** and **open UDP** works (GCE e2-small/e2-medium, a
Hostinger KVM VPS, …). Rough sizing: the media path costs a few % of one core per call on a modern
CPU (8 concurrent calls *plus* their 8 simulated Meta endpoints used ~0.5 core in the test suite),
so 2 vCPU comfortably handles a few dozen calls; Gemini does the heavy lifting remotely.

1. **VM + IP.** Reserve a static external IP. On GCE the VM only sees its private IP (1:1 NAT), so
   `PUBLIC_IP` is required; on a Hostinger VPS the public IP is on the interface, set it anyway.
2. **Firewall.** Allow inbound **TCP 80 + 443** (Caddy / Let's Encrypt) and **UDP 40000-40100**
   from anywhere (Meta's media servers). Port 8080 does not need to be public when Caddy fronts it.
   - GCE: `gcloud compute firewall-rules create voice-media --allow=udp:40000-40100,tcp:80,tcp:443 --target-tags=voice --source-ranges=0.0.0.0/0` (and tag the VM `voice`).
   - Ubuntu ufw: `ufw allow 80,443/tcp && ufw allow 40000:40100/udp`.
3. **DNS:** `voice.example.com` → the VM's IP.
4. **Run the server with Docker** (host networking so the UDP range is the host's):
   ```bash
   git clone … && cd wacrm/voice-server        # or copy just this folder
   docker build -t wacrm-voice-server .
   cat > voice.env <<EOF
   VOICE_SERVER_SECRET=<openssl rand -hex 32>
   PUBLIC_IP=<the VM's public IPv4>
   HOST=127.0.0.1
   PORT=8080
   EOF
   docker run -d --name voice --restart unless-stopped --network host --env-file voice.env wacrm-voice-server
   docker logs -f voice
   ```
   Without host networking, publish the range with identical ports and let the container
   auto-detect its own interface: `-p 127.0.0.1:8080:8080 -p 40000-40100:40000-40100/udp` (and
   `HOST=0.0.0.0`). Docker's UDP proxying of 100 ports works but host networking is simpler.
   Without Docker: Node 22, `npm ci --omit=dev`, `node src/index.js` under systemd with the same env.
5. **HTTPS with Caddy** (the request body carries the Gemini API key — never expose plain HTTP):
   ```
   # /etc/caddy/Caddyfile
   voice.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
   `sudo systemctl reload caddy`, then `curl https://voice.example.com/health`.
6. **Connect the app:** in Vercel → Project → Settings → Environment Variables set
   `VOICE_SERVER_URL=https://voice.example.com` and `VOICE_SERVER_SECRET=<same secret>`, redeploy.
   The app sends `callback.url = https://<your app>/api/whatsapp/calls/ai-events`; the VM must be
   able to reach it (outbound HTTPS). Settings → AI calls shows whether the server is reachable.

Updating: rebuild the image and `docker rm -f voice && docker run …` — SIGTERM ends live calls
cleanly (each gets its `ended` event), so deploy between calls.

## Tests

`npm test` (node:test, ~30 s, fully offline):

- `audio.test.js` — resampling (production helper + streaming converters, anti-aliasing, no
  clicks at chunk joins), Opus encode/decode round trip, stereo → mono decode, byte-for-byte
  equality with opusscript's own wrapper, many concurrent codecs.
- `units.test.js` — HMAC signing (RFC 4231 vector), event delivery with retries / no retry on 4xx /
  app down, RFC 4733 DTMF, SDP helpers (`PUBLIC_IP` announcement), prompt building, config.
- `api.test.js` — auth (401), 404s, validation (400), duplicate (409), capacity (503), a
  Meta-style offer (ICE-lite, `mid:audio`, transport-cc) → answer, idempotent `/end`, signed events
  retried on 5xx.
- `gemini.test.js` — the real Gemini client against a local fake Gemini Live WebSocket server:
  exact setup / realtimeInput / clientContent / toolResponse shapes; through a full call: nothing
  sent to Gemini before `/start`, greeting audio reaches "Meta", customer audio reaches Gemini as
  20 ms 16 kHz PCM at the right frequency, tools, transcript, `hangup_requested` after the goodbye,
  language-pin refusal → reconnect, Gemini drop → `error` + `ended`.
- `loopback.test.js` — real WebRTC on localhost: a werift peer plays Meta (ICE-lite, Opus pt 111,
  telephone-event pt 126). Inbound (Meta offer → our answer) and outbound (our offer → Meta answer):
  ICE + DTLS-SRTP connect, silence keepalive before `/start`, ~50 packets/s, contiguous sequence
  numbers, +960 timestamps, one SSRC, greeting and replies at the expected frequencies, the
  customer's tone heard by the AI at ~1000 Hz, DTMF, barge-in flush, `end_call` →
  `hangup_requested` after the goodbye → fallback end, max duration, no-media timeout, AI connect
  failure, 8 concurrent calls on distinct ports.

## Not verified here / risks

- **Real Meta and real Gemini were not exercised** (no network/keys in tests). The Meta side is
  simulated with werift in ICE-lite mode and a hand-written Meta-style SDP; the Gemini side with a
  local server speaking the production wire format. First real calls should be watched with
  `LOG_LEVEL=debug` and `GET /v1/sessions/:id`.
- **opusscript:** its JS wrapper breaks when the WebAssembly heap grows (older instances throw
  "detached ArrayBuffer" after ~100 codec instances, i.e. a few dozen calls) and points its PCM
  views at the wrong address. `src/opus.js` drives the same wasm module with fresh heap views per
  call; it is tested byte-identical to opusscript's output and safe with 600 live instances. If
  opusscript is ever upgraded, re-run `npm test` (the equality test guards the data layout).
- **werift** is pinned to an exact version (0.27.0); it moves fast. Inbound RTP is read straight
  from the DTLS transport (so a far end without `a=ssrc` lines still works), and SDP gathering is
  serialised because werift's port picker can hand the same port to two peers created at once.
- IPv4 only, no TURN; the VM must have public UDP. One DTLS certificate per process (werift's
  default), fingerprint in every SDP.
- No Opus FEC/PLC on lost inbound packets (lost 20 ms frames are skipped; Gemini copes). Silence is
  sent as regular Opus frames (no DTX), ~60 bytes each.
- Gemini Live session limits (≈15 min audio, occasional `goAway`) end the call with `ai_error`;
  session resumption is not implemented.
