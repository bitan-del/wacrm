-- ============================================================
-- 064_call_ai
--
-- AI agent on WhatsApp calls, plus a connector to an external AI
-- phone-calling system (e.g. the Nutriherb panel or Dakiya).
--
-- 1. call_ai_settings — one row per account: the AI persona (its
--    "soul": name, voice, language, greeting, guidelines), when it
--    answers incoming calls, the Gemini API key (AES-GCM encrypted by
--    the app, like whatsapp_config.access_token), and the external
--    phone-AI connector (URL, path, auth header, encrypted key).
--    The audio itself runs on a separate voice server (voice-server/);
--    the app reaches it through VOICE_SERVER_URL / VOICE_SERVER_SECRET.
-- 2. calls gets handled_by_ai + the AI's transcript, notes and summary.
-- 3. redeem_invitation treats call_ai_settings as account data.
--
-- (062/063 are reserved for other branches.) Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_ai_settings (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  inbound_mode              TEXT NOT NULL DEFAULT 'off'
                              CHECK (inbound_mode IN ('off', 'always', 'unanswered')),
  unanswered_after_seconds  INTEGER NOT NULL DEFAULT 20
                              CHECK (unanswered_after_seconds BETWEEN 5 AND 30),
  persona_name              TEXT,
  voice                     TEXT NOT NULL DEFAULT 'Kore',
  language                  TEXT NOT NULL DEFAULT 'auto',
  greeting                  TEXT,
  instructions              TEXT,
  max_duration_seconds      INTEGER NOT NULL DEFAULT 600
                              CHECK (max_duration_seconds BETWEEN 60 AND 3600),
  gemini_api_key            TEXT,
  phone_ai_provider         TEXT CHECK (phone_ai_provider IN ('nutriherb', 'dakiya', 'custom')),
  phone_ai_label            TEXT,
  phone_ai_base_url         TEXT,
  phone_ai_path             TEXT,
  phone_ai_auth_header      TEXT,
  phone_ai_api_key          TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_updated_at ON call_ai_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON call_ai_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE call_ai_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_ai_settings_select ON call_ai_settings;
CREATE POLICY call_ai_settings_select ON call_ai_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS call_ai_settings_insert ON call_ai_settings;
CREATE POLICY call_ai_settings_insert ON call_ai_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS call_ai_settings_update ON call_ai_settings;
CREATE POLICY call_ai_settings_update ON call_ai_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS call_ai_settings_delete ON call_ai_settings;
CREATE POLICY call_ai_settings_delete ON call_ai_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS handled_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_transcript JSONB,
  ADD COLUMN IF NOT EXISTS ai_notes JSONB,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT;

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
    UNION ALL SELECT 1 FROM call_ai_settings WHERE account_id = v_old_account_id
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
