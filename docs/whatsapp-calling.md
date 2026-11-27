# WhatsApp calling

Customers can call the business's WhatsApp number and agents answer in the
browser; agents can call customers who have allowed it. Calls are logged on
the **Calls** page, optionally with recordings.

## How it works

- **Signalling** goes through Meta's Cloud API calling endpoints and the
  `calls` webhook field. **Audio** is WebRTC between Meta and the agent's
  browser — it never passes through this server.
- An incoming call inserts a `calls` row with status `ringing`. Every online
  agent's browser rings (Supabase Realtime). The first agent to click
  **Answer** claims the row atomically (`/api/whatsapp/calls/[id]/answer`),
  which sends Meta `pre_accept` + `accept` with the browser's SDP answer.
- An outgoing call starts from the phone button in a conversation. The app
  asks Meta whether the customer has granted call permission; if not, it
  offers to send WhatsApp's "allow calls" request. The browser's SDP offer
  goes to `POST /api/whatsapp/calls`; Meta's SDP answer comes back on the
  webhook and reaches the browser through the row.
- Recording (optional) is done by Meta after a spoken announcement to both
  parties. The webhook copies each recording into the private
  `call-recordings` bucket (Meta deletes its copy after 7 days).

## Setup, per WhatsApp number

1. Apply migration `061_whatsapp_calling.sql`.
2. In the Meta app's **WhatsApp → Configuration → Webhook fields**, subscribe
   to **`calls`** (in addition to `messages`).
3. In the app: **Settings → Calling → Turn on WhatsApp calling.** Meta refuses
   (error 138015) unless the number's daily messaging limit is at least
   2,000 unique customers.
4. Optional: turn on recording and enter the purpose and announcement
   language.

The access token needs `whatsapp_business_messaging` (and
`whatsapp_business_management` to read settings).

## Where it works

- Customer → business calls: every country where the Cloud API works.
- Business → customer calls: not from business numbers in the United States,
  Canada, Egypt, Vietnam or Nigeria (Meta's rule, by the business number's
  country code). `src/lib/whatsapp/calling-availability.ts` uses this only for
  UI hints; Meta's own error is always shown when it disagrees.

## Costs (Meta)

- Customer-initiated calls: free.
- Business-initiated calls: per minute, billed in 6-second pulses, by the
  customer's country, to the WhatsApp Business account's payment method.
- Call-permission requests: charged like normal messages.
- Recording: free at the time of writing.

## Limits worth knowing

- Meta gives ~30–60 s to answer an incoming call.
- Call-permission requests: 1 per 24 h and 2 per 7 days per customer, and only
  within 24 h of the customer's last message (a template with a
  call-permission button is needed outside that window — not built yet).
- One live call per customer at a time; up to 100 connected
  business-initiated calls per number per day.

## AI agent on calls (Settings → AI calls)

An AI agent with your own persona (name, voice, language, greeting and
guidelines — its "soul") can answer incoming WhatsApp calls and place calls
for your team. It talks through Google's **Gemini Live**.

- **Where the audio runs:** WhatsApp call audio is WebRTC and can't live in a
  Vercel function, so AI calls run on the separate **voice server** in
  [`voice-server/`](../voice-server/README.md) — a small VM with public UDP
  (Cloud Run can't receive WebRTC). Until it's deployed the settings page
  says "Voice server not connected" and the AI options stay hidden.
- **Connect it:** set `VOICE_SERVER_URL` (https URL of the VM) and
  `VOICE_SERVER_SECRET` (shared secret, same value on the VM) as Vercel
  Production env vars and redeploy. The voice server calls back
  `POST /api/whatsapp/calls/ai-events`, signed with that secret.
- **Per account:** turn the agent on, paste a Gemini API key (stored
  encrypted), write the persona, and choose when it answers incoming calls:
  never, every call, or after 5–30 s with no human answer.
- **Placing AI calls:** the phone button in a chat and the Calls-page dialer
  offer "AI agent calls on WhatsApp". WhatsApp's call-permission rules apply
  exactly as for human calls.
- **After the call:** the Calls page marks AI calls and shows the transcript,
  any notes the AI saved, and a summary.

## AI phone-call systems (Nutriherb panel, Dakiya, custom)

Separate from WhatsApp calling: connect an external system that calls normal
phone numbers with its own AI, and trigger it from a chat or the dialer.

| Preset | Request |
|---|---|
| Nutriherb panel | `POST {url}/api/admin/voice/test` with `X-Admin-Key`, body `{ phone: <10 digits>, name, live: true }` — Nutri Voice AI (Plivo + Gemini Live), Indian mobiles, runs the panel's own script |
| Dakiya | `POST {url}{path}` with `X-API-Key`, body `{ phone, phone_e164, name, source, conversation_id }` — enter the path of Dakiya's call endpoint |
| Custom | same body, your header name (`Authorization` gets `Bearer …`) |

The base URL must be https. Keys are stored encrypted and never returned to
the browser.
