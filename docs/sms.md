# SMS channel (US bulk SMS alongside WhatsApp)

Meta has paused **marketing** WhatsApp templates to US `+1` numbers since
April 2025 (error `131049`). Promotional bulk messaging to US recipients
therefore has to go over SMS, which carries its own compliance regime:
A2P 10DLC (or toll-free verification) registration, TCPA express consent,
STOP handling and quiet hours. This document is the design of the SMS
channel and the setup guide for operators and their customers.

## Design

### Principles

- **SMS is a second channel on the same CRM objects.** Contacts,
  conversations and broadcasts are shared with WhatsApp. A contact has
  one conversation; each message row records the `channel` it travelled
  on (`whatsapp` | `sms`).
- **Per-account provider credentials.** Each workspace (account) brings
  its own provider account and its own A2P registration. Nothing is
  hard-coded to one account, one number or one country.
- **Provider abstraction.** `src/lib/sms/types.ts` defines
  `SmsProvider` (send, verify credentials, verify webhook signature,
  parse inbound, parse status). Twilio (`src/lib/sms/twilio.ts`) is the
  first implementation; adding Telnyx/Plivo/Vonage means one new file
  plus widening the `provider` CHECK.
- **Compliance is enforced on the server, not the UI.** Consent, opt-out
  and quiet hours are checked at the moment a message is handed to the
  provider, so a contact who texts STOP while a broadcast is queued is
  skipped.

### Data model (migration `063_sms_channel.sql`)

| Object | Change |
| --- | --- |
| `sms_config` (new) | One row per account: `provider`, `account_sid`, `auth_token` (AES-256-GCM via `src/lib/whatsapp/encryption`), sender (`messaging_service_sid` and/or `from_number`), brand name, HELP / opt-out / opt-in reply texts, `default_timezone`, quiet-hours window, cost per segment, registration type + reference, `is_active`. RLS: admin-only for every verb (the table holds the encrypted token); members learn "is SMS on?" through `GET /api/sms/config`. |
| `contacts` | `sms_opted_in_at`, `sms_opt_in_source`, `sms_opted_out_at`, `sms_opt_out_source`, `timezone` (IANA, for quiet hours). |
| `sms_consent_events` (new) | Append-only audit trail of every opt-in / opt-out / HELP (who, when, how, which keyword / message). TCPA disputes are won with records. RLS: members read, agents insert. |
| `messages` | `channel` (`whatsapp` default, `sms`). The provider message id (Twilio `SM…` SID) goes in the existing `message_id` column, so the existing status-sync and idempotency index work unchanged. |
| `broadcasts` | `channel`, `sms_body` (the un-rendered message). `template_name` stays NOT NULL and is `''` for SMS. |
| `broadcast_recipients` | `sms_message_id`, `sms_body` (rendered, frozen at plan time), `sms_segments`, `scheduled_for` (quiet-hours deferral), `claimed_at` (delivery lease). |
| `claim_sms_broadcast_recipients(limit)` (new RPC) | `FOR UPDATE SKIP LOCKED` claim of due SMS recipients, service-role only, so the after-response pass and the cron can overlap without double-sending. |

### Consent rules

- A broadcast targets a contact only when `sms_opted_in_at IS NOT NULL
  AND sms_opted_out_at IS NULL` and the phone is valid E.164.
- An inbox reply by SMS is allowed unless the contact has opted out
  (a reply to a customer-initiated thread is conversational, not
  marketing). It is never allowed after STOP.
- Inbound keywords (case-insensitive, surrounding punctuation ignored):
  - opt-out: `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`,
    plus FCC 2025 revocation words `REVOKE`, `OPTOUT`, `OPT OUT`. A
    short message (≤ 3 words) that *contains* `STOP`, `STOPALL`,
    `UNSUBSCRIBE`, `REVOKE` or `OPT OUT` ("Stop please", "please stop")
    also counts — a false opt-out is cheap, a missed one is a TCPA
    violation. `CANCEL` / `END` / `QUIT` only count on their own, so
    "Cancel my order" stays a normal message. Twilio's `OptOutType`
    (Advanced Opt-Out, including custom keywords) overrides our match.
  - opt-in: `START`, `UNSTOP`.
  - help: `HELP`, `INFO`.
- STOP sets `sms_opted_out_at`; START clears it and stamps a fresh
  opt-in with source `keyword`. Each writes a `sms_consent_events` row.
- HELP gets the account's HELP text as an automatic reply. STOP / START
  confirmations are sent by us only when the provider does not already
  send them (Twilio does, at the platform level, and blocks any further
  message to an opted-out number with error 21610 — on 21610 we also
  mark the contact opted out).

### Broadcast flow

1. The wizard gets a channel picker (shown when SMS is configured and
   active). SMS steps: **Message → Audience → Review & send**.
2. `POST /api/sms/broadcasts/preview` resolves the audience server-side
   and returns: eligible / no-consent / opted-out / invalid-phone counts,
   segment count and encoding, estimated cost (segments × the account's
   cost per segment) and how many recipients fall inside quiet hours.
   CSV audiences only match **existing** contacts — a CSV row cannot
   carry consent, so the SMS path never creates contacts.
3. `POST /api/sms/broadcasts` creates the broadcast + recipient rows. Each
   recipient's body is rendered and frozen; `scheduled_for` is now, or
   the next 08:00 in the recipient's timezone (contact `timezone` when
   set and valid, else the account's `default_timezone`) when now falls
   inside the 21:00–08:00 window (window configurable per account).
4. Delivery runs server-side (`after()` for the first pass, then
   `GET /api/sms/cron` on a schedule) using the claim RPC. Each send
   re-checks consent, passes a status-callback URL, and stamps
   `sms_message_id` / `sent_at` or `failed` + reason. Status callbacks
   advance `delivered` / `failed`; inbound replies flip `replied`. The
   existing DB trigger keeps the broadcast counters in sync.

### Inbox

- Inbound SMS (`POST /api/sms/twilio/inbound`) finds-or-creates the
  contact by phone and lands in that contact's single conversation as a
  `channel = 'sms'` message; bubbles show an "SMS" badge.
- The composer gets a WhatsApp / SMS toggle (defaulting to the channel
  of the customer's last message). SMS mode is text-only, ignores the
  WhatsApp 24-hour window, shows a live segment counter and posts to
  `POST /api/sms/send`.
- Automations, Flows and the AI auto-reply are WhatsApp-only and do not
  fire on SMS inbound (they would answer on the wrong channel).

### Webhooks and security

- `POST /api/sms/twilio/inbound?cfg=<sms_config.id>` and
  `POST /api/sms/twilio/status?cfg=<sms_config.id>`. The `cfg` id picks
  the account's config; the request is accepted only if
  `X-Twilio-Signature` validates against **that** account's auth token
  (HMAC-SHA1 over the full URL + sorted form params). Inbound without
  `cfg` falls back to matching `AccountSid` + `To` / messaging service.
- `GET /api/sms/cron` requires `x-cron-secret` = `SMS_CRON_SECRET`
  (falls back to `AUTOMATION_CRON_SECRET`).

## Setup

### What the platform operator does once

1. **Apply migration `063_sms_channel.sql`** to the Supabase project.
   (`061`/`062`/`064` belong to other branches; see the merge note at
   the bottom of 063 about `redeem_invitation`.)
2. **Environment variables** (Vercel → Project → Settings → Environment
   Variables). Nothing provider-specific is global — every workspace
   brings its own Twilio credentials.

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `ENCRYPTION_KEY` | already set | Encrypts each workspace's Twilio Auth Token (same key as WhatsApp tokens). |
   | `SUPABASE_SERVICE_ROLE_KEY` | already set | Webhooks and the delivery cron run without a user session. |
   | `NEXT_PUBLIC_SITE_URL` | **yes for SMS** | Public origin (e.g. `https://waba.outreach-pro.in`). Used to build the status-callback URL from the cron, which has no browser request to derive it from, and as the public URL Twilio signed. |
   | `SMS_CRON_SECRET` | **yes for SMS broadcasts** | Shared secret for `GET /api/sms/cron`. Falls back to `AUTOMATION_CRON_SECRET` when unset. |

3. **Schedule the delivery cron** every 5 minutes (it delivers
   recipients held for quiet hours, rate-limit retries, and anything the
   first pass of a large campaign didn't reach):

   ```bash
   curl -fsS -H "x-cron-secret: $SMS_CRON_SECRET" https://waba.outreach-pro.in/api/sms/cron
   ```

   Vercel Cron cannot send custom headers, so use an external pinger
   (cron-job.org, GitHub Actions schedule, Upstash QStash…) or the same
   pinger that already drives `/api/automations/cron`. Without the cron,
   a campaign started during quiet hours never sends.

### What each customer (workspace) does

1. **Twilio account.** Create one (or a subaccount under the operator's
   account — each subaccount has its own Account SID + Auth Token, which
   keeps tenants isolated). Upgrade from trial: trial accounts can only
   text verified numbers and prefix every message.
2. **Carrier registration — required before any US traffic.** Unregistered
   10DLC traffic is blocked by US carriers (Twilio error 30034).
   - **A2P 10DLC** (local numbers): Twilio Console → Messaging →
     Regulatory Compliance → register a **Brand** (the customer's own
     legal business, EIN, website) and a **Campaign** (use case
     "Marketing" or "Mixed", sample messages including opt-out
     language, a description of how consent is collected — e.g. the
     web form with an unchecked SMS consent checkbox and the disclosure
     text). Attach the campaign to a **Messaging Service** and add the
     number(s) to that service. Brand vetting takes minutes to days;
     campaign review typically days to a few weeks. Each customer must
     register their own brand — a platform cannot send one customer's
     marketing under another's brand.
   - **Toll-free alternative:** buy a toll-free number and submit
     **Toll-Free Verification** (business info, use case, opt-in
     evidence, sample message). Unverified toll-free traffic is blocked.
   - Short codes are supported by the same settings (enter the
     Messaging Service), but provisioning takes 8–12 weeks.
3. **Connect in wacrm:** Settings → **SMS** (admins only). Enter the
   Account SID, Auth Token, and the Messaging Service SID (preferred) or
   From number, the brand name, and optionally the registration type +
   campaign/verification ID for your records. **Verify and save** checks
   the credentials with Twilio and that the sender belongs to that
   account. Switch **SMS enabled** on.
4. **Webhooks in Twilio.** Copy the **Incoming messages** URL shown in
   Settings → SMS — `https://<host>/api/sms/twilio/inbound?cfg=<id>` —
   into the Messaging Service → Integration → "Send a webhook" (or the
   phone number's "A message comes in" webhook), method `HTTP POST`.
   The delivery-status URL (`/api/sms/twilio/status?cfg=<id>`) is
   attached to every message automatically.
5. **Advanced Opt-Out** (Messaging Service → Opt-Out Management) can stay
   on: Twilio confirms STOP/START and forwards the message to us with
   `OptOutType`, which we record. If Twilio's HELP auto-response is also
   on, clear the HELP reply in Settings → SMS or turn Twilio's off, so
   the customer doesn't get two.
6. **Record consent.** Only contacts with an SMS opt-in receive
   broadcasts. Record it per contact (Contacts → contact → Details →
   SMS consent, with the source: web form, paper form, verbal…) or via
   `POST /api/sms/consent` (`{ contact_ids, action: "opt_in", source }`)
   from the customer's own sign-up integration. A contact who texted
   STOP can only re-subscribe by texting START.
7. **Timezones.** Set a contact's timezone (Details → SMS consent) when
   known; otherwise the workspace default timezone decides quiet hours.

### Using it

- **Broadcasts → New** shows a WhatsApp / SMS choice once SMS is on.
  SMS: write the message (merge tags `{{first_name}}`,
  `{{last_name}}`, `{{name}}`, `{{company}}`, with fallbacks like
  `{{first_name|there}}`), pick the audience, then review consent
  exclusions, segments, estimated cost and quiet-hour deferrals before
  sending.
- **Inbox:** SMS messages carry an "SMS" badge; the composer's
  WhatsApp / SMS toggle picks the reply channel (it defaults to the
  channel the customer last used).

### Error codes worth knowing

| Code | Meaning | What the app does |
| --- | --- | --- |
| 21610 | Recipient replied STOP to this sender | Marks the contact opted out (source `provider`), fails the recipient |
| 30034 | Sender not registered for A2P 10DLC | Fails the recipient with the reason — finish registration |
| 30007 | Carrier filtered the message | Delivery status `failed` with the code — review content / registration |
| 20429 / HTTP 429 | Rate limited | Recipient re-queued for a minute later |

### Known limits / follow-ups

- Text only: inbound MMS is recorded as "[MMS: N attachments]"; no
  outbound MMS.
- No area-code → timezone inference yet: contacts without a timezone use
  the workspace default, so a nationwide list with an Eastern default can
  reach Pacific numbers before 8am local. Set contact timezones (or a
  more western default) for nationwide sends.
- Automations, Flows and AI auto-reply don't run on SMS.
- No bulk consent UI or CSV consent column yet (the API takes up to 1000
  ids per call). No "retry failed" for SMS broadcasts.
