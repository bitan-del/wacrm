-- ============================================================
-- 061_whatsapp_calling
--
-- WhatsApp Business Calling (Cloud API). Customers can call the
-- business number and agents answer in the browser (WebRTC); agents can
-- call customers who have granted call permission. Meta signals every
-- call over the `calls` webhook field and the media flows directly
-- between Meta and the agent's browser, so the server only relays SDP
-- and records the call's lifecycle here.
--
-- 1. whatsapp_config gets the per-account calling preferences. The
--    authoritative on/off switch lives at Meta (POST /{phone}/settings);
--    `calling_enabled` mirrors what we last set so the UI can render
--    without a Graph round trip.
-- 2. `calls` — one row per call, inbound or outbound. Agents' browsers
--    subscribe to it through Realtime: an INSERT with status 'ringing'
--    rings every online agent, and the first one to claim it (an atomic
--    UPDATE ... WHERE status = 'ringing') takes the call.
-- 3. `call-recordings` — PRIVATE storage bucket. Meta deletes its copy
--    of a recording after 7 days, so the webhook mirrors it here.
--    Only the service role touches the bucket; members get short-lived
--    signed URLs from /api/whatsapp/calls/[id]/recording after an RLS
--    check on the call row.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-account calling preferences
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS calling_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS call_recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS call_recording_purpose TEXT,
  ADD COLUMN IF NOT EXISTS call_recording_language TEXT;

COMMENT ON COLUMN whatsapp_config.calling_enabled IS
  'Last calling status this app set at Meta (POST /{phone_number_id}/settings). '
  'Meta stays the source of truth; this only lets the UI render offline.';
COMMENT ON COLUMN whatsapp_config.call_recording_enabled IS
  'When true, answered and placed calls ask Meta to record the audio. Both '
  'parties hear a spoken announcement of call_recording_purpose first.';
COMMENT ON COLUMN whatsapp_config.call_recording_purpose IS
  'Why calls are recorded (max 250 chars). Meta reads it out to both parties.';
COMMENT ON COLUMN whatsapp_config.call_recording_language IS
  'Locale of Meta''s recording announcement, e.g. en_US, hi, es, pt.';

-- ------------------------------------------------------------
-- 2. calls
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Meta's call id ("wacid.…"). NULL only for the instant between
  -- inserting an outbound row and Meta answering the connect request.
  wa_call_id        TEXT,
  phone_number_id   TEXT NOT NULL,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status            TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN (
                      'dialing',      -- outbound: connect sent, nothing back yet
                      'ringing',      -- ringing on the other side
                      'answering',    -- inbound: an agent claimed it, accepting at Meta
                      'in_progress',  -- connected
                      'completed',    -- ended after being connected
                      'missed',       -- ended without being answered
                      'rejected',     -- declined (by the agent or the customer)
                      'canceled',     -- outbound: the agent hung up before an answer
                      'failed'        -- Meta reported a failure
                    )),
  -- Customer's WhatsApp identity at call time (phone or BSUID).
  customer_wa_id    TEXT,
  -- SDP exchange. Inbound: Meta's offer, read by the answering browser.
  -- Outbound: Meta's answer, read by the calling browser. Both are
  -- cleared once the call ends.
  sdp_offer         TEXT,
  sdp_answer        TEXT,
  answered_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  placed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_seconds  INTEGER,
  error_code        INTEGER,
  error_title       TEXT,
  error_details     TEXT,
  recording_status  TEXT NOT NULL DEFAULT 'none'
                      CHECK (recording_status IN ('none', 'requested', 'available', 'failed')),
  recording_path    TEXT,
  recording_mime    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS calls_wa_call_id_key
  ON calls (wa_call_id) WHERE wa_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_account_started_idx
  ON calls (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_contact_idx
  ON calls (contact_id);
CREATE INDEX IF NOT EXISTS calls_live_idx
  ON calls (account_id, status)
  WHERE status IN ('dialing', 'ringing', 'answering', 'in_progress');

DROP TRIGGER IF EXISTS set_updated_at ON calls;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calls_select ON calls;
CREATE POLICY calls_select ON calls FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS calls_insert ON calls;
CREATE POLICY calls_insert ON calls FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS calls_update ON calls;
CREATE POLICY calls_update ON calls FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS calls_delete ON calls;
CREATE POLICY calls_delete ON calls FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Realtime: ringing / status changes reach every agent's browser.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calls;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Private bucket for call recordings
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  FALSE,
  52428800, -- 50 MB: ~3.5 h of Opus at Meta's bitrate
  ARRAY['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/wav']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ------------------------------------------------------------
-- 4. redeem_invitation: treat call history as data
--
-- Joining another account deletes the joiner's old account only when it
-- holds no data. `calls` is a new account-scoped table, so the check
-- must look at it too (same body as migration 047 plus one line).
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
    UNION ALL SELECT 1 FROM calls WHERE account_id = v_old_account_id
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
