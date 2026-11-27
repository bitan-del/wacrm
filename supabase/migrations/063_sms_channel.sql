-- ============================================================
-- 063_sms_channel.sql — SMS as a second messaging channel
--
-- Why: Meta has paused marketing WhatsApp templates to US +1 numbers
-- (error 131049), so US promotional bulk messaging has to go over SMS.
-- SMS brings its own compliance regime (A2P 10DLC / toll-free
-- verification, TCPA consent, STOP handling, quiet hours). This
-- migration adds the storage for all of it. Design: docs/sms.md.
--
--   1. `sms_config` — one provider setup per account (Twilio first).
--      The auth token is AES-256-GCM-encrypted by the app (same
--      `encrypt()` as whatsapp_config.access_token). Admin-only RLS
--      for every verb: unlike ai_configs, members never read this
--      table directly — `GET /api/sms/config` tells them whether SMS
--      is on without exposing the ciphertext.
--   2. `contacts` consent columns + `timezone` (quiet hours).
--   3. `sms_consent_events` — append-only consent audit trail,
--      written by a trigger on `contacts` so every path that changes
--      consent (API, webhook, a direct PostgREST update) is recorded.
--   4. `apply_sms_consent()` — the one write path the app uses for
--      consent changes; refuses to re-opt-in a recipient who opted out
--      themselves unless the re-opt-in is their own START keyword.
--   5. `messages.channel`, `broadcasts.channel` / `sms_body`, and the
--      per-recipient SMS columns (`sms_message_id`, `sms_body`,
--      `sms_segments`, `scheduled_for`, `claimed_at`).
--   6. `create_sms_broadcast_with_recipients()` (atomic create) and
--      `claim_sms_broadcast_recipients()` (FOR UPDATE SKIP LOCKED
--      claim so the after-response pass and the cron can overlap
--      without double-sending). Both service-role only.
--   7. `redeem_invitation` counts the SMS tables as account data.
--
-- Numbering: 061 / 062 are reserved by other in-flight branches.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sms_config
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_config (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider               text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
  -- Provider account identifier (Twilio Account SID, AC…). Not secret.
  account_sid            text NOT NULL,
  -- AES-256-GCM-encrypted provider secret (Twilio Auth Token). Also the
  -- key Twilio signs webhooks with, so it is required, not optional.
  auth_token             text NOT NULL,
  -- Sender. A Messaging Service (MG…) is the normal 10DLC setup — the
  -- A2P campaign is attached to the service. A bare number is allowed
  -- for toll-free / single-number setups. At least one is required.
  messaging_service_sid  text,
  from_number            text,
  brand_name             text,
  help_reply_text        text,
  opt_out_reply_text     text,
  opt_in_reply_text      text,
  -- Quiet hours: no marketing sends between start and end in the
  -- recipient's local time (contact.timezone when known, else this).
  default_timezone       text NOT NULL DEFAULT 'America/New_York',
  quiet_hours_start      smallint NOT NULL DEFAULT 21 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end        smallint NOT NULL DEFAULT 8 CHECK (quiet_hours_end BETWEEN 0 AND 23),
  -- Drives the cost estimate in the broadcast wizard only.
  cost_per_segment       numeric(10, 5) NOT NULL DEFAULT 0.0083 CHECK (cost_per_segment >= 0),
  cost_currency          text NOT NULL DEFAULT 'USD',
  -- Informational: which carrier registration this sender runs under
  -- and its reference (10DLC campaign id, toll-free verification id…).
  registration_type      text CHECK (registration_type IN ('10dlc', 'toll_free', 'short_code', 'other')),
  registration_reference text,
  is_active              boolean NOT NULL DEFAULT false,
  last_verified_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_config_sender_present
    CHECK (messaging_service_sid IS NOT NULL OR from_number IS NOT NULL)
);

-- A sender belongs to exactly one account, otherwise an inbound text
-- could not be routed unambiguously (mirrors 013 for whatsapp_config).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_config_from_number
  ON sms_config (from_number) WHERE from_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_config_messaging_service
  ON sms_config (messaging_service_sid) WHERE messaging_service_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_config_account_sid ON sms_config (account_sid);

ALTER TABLE sms_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_config_select ON sms_config;
CREATE POLICY sms_config_select ON sms_config FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sms_config_insert ON sms_config;
CREATE POLICY sms_config_insert ON sms_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sms_config_update ON sms_config;
CREATE POLICY sms_config_update ON sms_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sms_config_delete ON sms_config;
CREATE POLICY sms_config_delete ON sms_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS sms_config_updated_at ON sms_config;
CREATE TRIGGER sms_config_updated_at
  BEFORE UPDATE ON sms_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2. Contact consent + timezone
-- ------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_opted_in_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_opt_in_source text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_opted_out_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_opt_out_source text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone text;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_sms_opt_in_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_sms_opt_in_source_check
  CHECK (sms_opt_in_source IS NULL OR sms_opt_in_source IN
    ('keyword', 'web_form', 'paper_form', 'verbal', 'import', 'api', 'manual', 'other'));
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_sms_opt_out_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_sms_opt_out_source_check
  CHECK (sms_opt_out_source IS NULL OR sms_opt_out_source IN
    ('keyword', 'provider', 'manual', 'api', 'other'));
-- IANA names are validated by the app (Intl); this only bounds junk.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_timezone_length_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_timezone_length_check
  CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 64);

-- Broadcast audiences filter on "opted in and not opted out".
CREATE INDEX IF NOT EXISTS idx_contacts_sms_eligible
  ON contacts (account_id)
  WHERE sms_opted_in_at IS NOT NULL AND sms_opted_out_at IS NULL;

-- ------------------------------------------------------------
-- 3. Consent audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_consent_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- SET NULL: the proof of consent must outlive the contact row.
  contact_id           uuid REFERENCES contacts(id) ON DELETE SET NULL,
  phone                text,
  event                text NOT NULL CHECK (event IN ('opt_in', 'opt_out', 'help')),
  source               text,
  keyword              text,
  provider_message_id  text,
  actor_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_consent_events_contact
  ON sms_consent_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_events_account
  ON sms_consent_events (account_id, created_at DESC);

ALTER TABLE sms_consent_events ENABLE ROW LEVEL SECURITY;

-- Append-only: members read, agents append, nobody edits or deletes.
DROP POLICY IF EXISTS sms_consent_events_select ON sms_consent_events;
CREATE POLICY sms_consent_events_select ON sms_consent_events FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS sms_consent_events_insert ON sms_consent_events;
CREATE POLICY sms_consent_events_insert ON sms_consent_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Every consent change on a contact lands here, whichever path made
-- it. `apply_sms_consent` passes the keyword / provider message id
-- through transaction-local settings so keyword events keep that
-- detail; a direct PostgREST update is still recorded, just without it.
CREATE OR REPLACE FUNCTION public.log_sms_consent_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keyword text := NULLIF(current_setting('wacrm.sms_consent_keyword', true), '');
  v_message text := NULLIF(current_setting('wacrm.sms_consent_message_id', true), '');
BEGIN
  IF NEW.sms_opted_out_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.sms_opted_out_at IS DISTINCT FROM NEW.sms_opted_out_at) THEN
    INSERT INTO sms_consent_events
      (account_id, contact_id, phone, event, source, keyword, provider_message_id, actor_user_id)
    VALUES
      (NEW.account_id, NEW.id, NEW.phone, 'opt_out', NEW.sms_opt_out_source, v_keyword, v_message, auth.uid());
  ELSIF NEW.sms_opted_in_at IS NOT NULL
     AND NEW.sms_opted_out_at IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.sms_opted_in_at IS DISTINCT FROM NEW.sms_opted_in_at
          OR OLD.sms_opted_out_at IS NOT NULL) THEN
    INSERT INTO sms_consent_events
      (account_id, contact_id, phone, event, source, keyword, provider_message_id, actor_user_id)
    VALUES
      (NEW.account_id, NEW.id, NEW.phone, 'opt_in', NEW.sms_opt_in_source, v_keyword, v_message, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_sms_consent_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_sms_consent_change() FROM anon;
REVOKE ALL ON FUNCTION public.log_sms_consent_change() FROM authenticated;

DROP TRIGGER IF EXISTS contacts_log_sms_consent ON contacts;
CREATE TRIGGER contacts_log_sms_consent
  AFTER INSERT OR UPDATE OF sms_opted_in_at, sms_opted_out_at ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.log_sms_consent_change();

-- ------------------------------------------------------------
-- 4. apply_sms_consent — the app's single consent write path
--
-- SECURITY INVOKER: an agent calling it through PostgREST is held to
-- contacts_update RLS (agent+ in their own account); the webhook calls
-- it with the service role. Returns the ids actually changed.
--
-- Re-opt-in guard: a contact who opted out THEMSELVES (keyword, or the
-- provider reporting them as unsubscribed) can only be re-opted-in by
-- their own START keyword. A staff member ticking a box, an import or
-- an API call cannot override a recipient's STOP.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_sms_consent(
  p_account_id  uuid,
  p_contact_ids uuid[],
  p_action      text,
  p_source      text,
  p_keyword     text DEFAULT NULL,
  p_message_id  text DEFAULT NULL
)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_action NOT IN ('opt_in', 'opt_out') THEN
    RAISE EXCEPTION 'p_action must be opt_in or opt_out' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('wacrm.sms_consent_keyword', COALESCE(p_keyword, ''), true);
  PERFORM set_config('wacrm.sms_consent_message_id', COALESCE(p_message_id, ''), true);

  IF p_action = 'opt_out' THEN
    RETURN QUERY
    UPDATE contacts
    SET sms_opted_out_at = now(),
        sms_opt_out_source = p_source,
        updated_at = now()
    WHERE account_id = p_account_id
      AND id = ANY (p_contact_ids)
      AND sms_opted_out_at IS NULL
    RETURNING id;
  ELSE
    RETURN QUERY
    UPDATE contacts
    SET sms_opted_in_at = now(),
        sms_opt_in_source = p_source,
        sms_opted_out_at = NULL,
        sms_opt_out_source = NULL,
        updated_at = now()
    WHERE account_id = p_account_id
      AND id = ANY (p_contact_ids)
      AND (
        p_source = 'keyword'
        OR sms_opted_out_at IS NULL
        OR COALESCE(sms_opt_out_source, '') NOT IN ('keyword', 'provider')
      )
    RETURNING id;
  END IF;

  PERFORM set_config('wacrm.sms_consent_keyword', '', true);
  PERFORM set_config('wacrm.sms_consent_message_id', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_sms_consent(uuid, uuid[], text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_sms_consent(uuid, uuid[], text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_sms_consent(uuid, uuid[], text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sms_consent(uuid, uuid[], text, text, text, text) TO service_role;

-- ------------------------------------------------------------
-- 5. Channel columns
-- ------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('whatsapp', 'sms'));

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS sms_body text;
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_channel_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_channel_check
  CHECK (channel IN ('whatsapp', 'sms'));
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_sms_body_present;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_sms_body_present
  CHECK (channel <> 'sms' OR (sms_body IS NOT NULL AND sms_body <> ''));

ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS sms_message_id text;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS sms_body text;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS sms_segments smallint;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Status callbacks look recipients up by provider message id.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sms_message_id
  ON broadcast_recipients (sms_message_id) WHERE sms_message_id IS NOT NULL;
-- The claim RPC scans pending SMS recipients by due time.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sms_due
  ON broadcast_recipients (scheduled_for)
  WHERE status = 'pending' AND sms_body IS NOT NULL;

-- ------------------------------------------------------------
-- 6a. Atomic SMS broadcast create
--
-- Same shape and reasoning as create_broadcast_with_recipients (037 /
-- 049): parent + recipients in one transaction so a failed recipient
-- insert never leaves an orphaned 'sending' campaign. The API route
-- resolves and consent-filters contacts under the caller's RLS before
-- calling this with the service role.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_sms_broadcast_with_recipients(
  p_account_id     uuid,
  p_user_id        uuid,
  p_name           text,
  p_sms_body       text,
  p_audience       jsonb,
  p_contact_ids    uuid[],
  p_bodies         text[],
  p_segments       smallint[],
  p_scheduled_for  timestamptz[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id uuid;
  v_n integer := COALESCE(cardinality(p_contact_ids), 0);
BEGIN
  IF v_n = 0 THEN
    RAISE EXCEPTION 'p_contact_ids must not be empty' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(cardinality(p_bodies), 0) <> v_n
     OR COALESCE(cardinality(p_segments), 0) <> v_n
     OR COALESCE(cardinality(p_scheduled_for), 0) <> v_n THEN
    RAISE EXCEPTION 'per-recipient arrays must all have % entries', v_n
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, name, template_name, template_language,
    channel, sms_body, audience_filter, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, '', 'en_US',
    'sms', p_sms_body, p_audience, 'sending', v_n
  )
  RETURNING id INTO v_broadcast_id;

  INSERT INTO broadcast_recipients (
    broadcast_id, contact_id, status, sms_body, sms_segments, scheduled_for
  )
  SELECT v_broadcast_id, c.cid, 'pending', b.body, s.seg, w.due_at
  FROM unnest(p_contact_ids) WITH ORDINALITY AS c(cid, ord)
  JOIN unnest(p_bodies) WITH ORDINALITY AS b(body, ord) ON b.ord = c.ord
  JOIN unnest(p_segments) WITH ORDINALITY AS s(seg, ord) ON s.ord = c.ord
  JOIN unnest(p_scheduled_for) WITH ORDINALITY AS w(due_at, ord) ON w.ord = c.ord;

  RETURN v_broadcast_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sms_broadcast_with_recipients(uuid, uuid, text, text, jsonb, uuid[], text[], smallint[], timestamptz[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_sms_broadcast_with_recipients(uuid, uuid, text, text, jsonb, uuid[], text[], smallint[], timestamptz[]) FROM anon;
REVOKE ALL ON FUNCTION public.create_sms_broadcast_with_recipients(uuid, uuid, text, text, jsonb, uuid[], text[], smallint[], timestamptz[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_sms_broadcast_with_recipients(uuid, uuid, text, text, jsonb, uuid[], text[], smallint[], timestamptz[]) TO service_role;

-- ------------------------------------------------------------
-- 6b. Claim due SMS recipients
--
-- Stamps `claimed_at` on up to p_limit due, pending recipients of
-- 'sending' SMS broadcasts and returns them. SKIP LOCKED means two
-- overlapping passes (the after() pass of a fresh broadcast and the
-- cron) take disjoint rows. A claim older than p_stale_seconds is
-- considered abandoned (the pass died) and becomes claimable again.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sms_broadcast_recipients(
  p_limit          integer,
  p_stale_seconds  integer DEFAULT 900,
  p_broadcast_id   uuid DEFAULT NULL
)
RETURNS TABLE (
  recipient_id  uuid,
  broadcast_id  uuid,
  account_id    uuid,
  contact_id    uuid,
  sms_body      text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH due AS (
    SELECT r.id
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
    WHERE b.channel = 'sms'
      AND b.status = 'sending'
      AND r.status = 'pending'
      AND r.sms_body IS NOT NULL
      AND (r.scheduled_for IS NULL OR r.scheduled_for <= now())
      AND (r.claimed_at IS NULL
           OR r.claimed_at < now() - make_interval(secs => p_stale_seconds))
      AND (p_broadcast_id IS NULL OR r.broadcast_id = p_broadcast_id)
    ORDER BY r.scheduled_for NULLS FIRST, r.created_at
    LIMIT GREATEST(p_limit, 0)
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE broadcast_recipients r
  SET claimed_at = now()
  FROM due, broadcasts b
  WHERE r.id = due.id
    AND b.id = r.broadcast_id
  RETURNING r.id, r.broadcast_id, b.account_id, r.contact_id, r.sms_body;
$$;

REVOKE ALL ON FUNCTION public.claim_sms_broadcast_recipients(integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_sms_broadcast_recipients(integer, integer, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_sms_broadcast_recipients(integer, integer, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sms_broadcast_recipients(integer, integer, uuid) TO service_role;

-- ------------------------------------------------------------
-- 7. redeem_invitation treats SMS config + consent records as data
--
-- Joining another account deletes the caller's old personal account,
-- but only when it holds no data (047). The SMS tables are new
-- account-scoped data: without this, accepting an invite could
-- cascade-delete a workspace's consent audit trail. Body is 047's with
-- the two SMS tables added.
--
-- MERGE NOTE: 061 / 064 on the WhatsApp-calling branch redefine this
-- function too (calls, call_ai_settings). Whichever migration runs
-- last must list every table — src/lib/auth/redeem-invitation-
-- migration.test.ts fails if one is missing.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM sms_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM sms_consent_events WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
