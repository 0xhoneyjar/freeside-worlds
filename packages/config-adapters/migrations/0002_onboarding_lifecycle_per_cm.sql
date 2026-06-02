-- 0002_onboarding_lifecycle_per_cm.sql
--
-- S2 (shadow-onboarding-substrate, SDD §3.1/§6.1): the `onboarding-lifecycle`
-- surface is keyed PER-CM — `(world_slug, surface, cm_identity_id)` — so two
-- community managers onboarding the SAME world get two independent head rows +
-- histories, never one shared/overwritten row (flatline B1/SKP-006). The
-- `role-map` and `apply-mode` surfaces stay per-`(world, surface)`.
--
-- IMPLEMENTATION: add a `cm_identity_id` column to BOTH tables, defaulting to
-- the empty string '' (NOT NULL) so the composite primary key is well-formed
-- (a NULL in a PRIMARY KEY is disallowed in Postgres). The adapter maps the
-- engine's `cmIdentityId: null` (every non-lifecycle surface) to '' and back.
-- For `onboarding-lifecycle`, cm_identity_id = the CM's identity-api user_id
-- (UUID). The '' default keeps EVERY pre-existing verify-message row valid with
-- zero data migration (they collapse to the legacy two-key under cm = '').
--
-- This is additive + idempotent (IF NOT EXISTS / DO-block guards) so it is
-- safe to re-run against a database that already has 0001 applied.

-- ─── add the per-CM sub-key column (default '' = legacy two-key) ────────────
ALTER TABLE current_config
  ADD COLUMN IF NOT EXISTS cm_identity_id TEXT NOT NULL DEFAULT '';

ALTER TABLE config_record
  ADD COLUMN IF NOT EXISTS cm_identity_id TEXT NOT NULL DEFAULT '';

-- ─── widen the head-pointer primary key to the composite ────────────────────
-- Drop the old 2-key PK and re-create it as the 3-key composite. Guarded so a
-- re-run (PK already widened) is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'current_config'
       AND c.contype = 'p'
       AND c.conname = 'current_config_pkey'
       AND array_length(c.conkey, 1) = 2
  ) THEN
    ALTER TABLE current_config DROP CONSTRAINT current_config_pkey;
    ALTER TABLE current_config
      ADD CONSTRAINT current_config_pkey
      PRIMARY KEY (world_slug, surface, cm_identity_id);
  END IF;
END$$;

-- ─── history query path includes the per-CM sub-key ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_config_record_key_cm_created
  ON config_record (world_slug, surface, cm_identity_id, created_at DESC);
