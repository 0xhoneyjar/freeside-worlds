-- 0003_roles_as_code_provenance_retention.sql
--
-- cycle-010 (Roles-as-Code) config-service surfaces (S1) DB support:
--   • sprint T1.7 / SDD §6 — WRITE PROVENANCE: an additive `provenance` JSONB
--     column on the append-only history table. Records the audit subject
--     {service_identity, actor, plan_id|apply_id, fencing_token, ts} for the
--     world-keyed roles-as-code writes (roster-commit / resolution-ledger /
--     pending-apply). NULL for the 4 existing surfaces' writes (no provenance
--     supplied) — so EVERY pre-existing row + every verify-message/role-map/
--     apply-mode/onboarding-lifecycle write stays valid with ZERO data
--     migration.
--   • sprint T1.6 / SDD §4 — RETENTION: an index supporting the warn-then-prune
--     history scan (most-recent-first per key). The prune itself is a scoped
--     DELETE on config_record (see pg-config-store.ts pruneHistory) — the table
--     is the commit log for `roster-commit`, so pruning history IS commit
--     retention (last-50 + 180d).
--
-- The NET-NEW surfaces (roster-commit/resolution-ledger/pending-apply) need NO
-- new tables — they ride the existing current_config + config_record machinery
-- (head pointer + append-only history), exactly like the 4 existing surfaces
-- (SDD §4 §9 fork 4: the store's native history IS the commit log).
--
-- Additive + idempotent (IF NOT EXISTS guards) — safe to re-run.

-- ─── write provenance (sprint T1.7 · SDD §6) ────────────────────────────────
-- JSONB so the provenance shape can evolve without a column migration. DEFAULT
-- NULL keeps every existing config_record row valid (no backfill).
ALTER TABLE config_record
  ADD COLUMN IF NOT EXISTS provenance JSONB;

-- ─── retention scan index (sprint T1.6 · SDD §4) ────────────────────────────
-- The warn-then-prune pass lists history refs most-recent-first per composite
-- key; this index serves that scan AND the existing per-key history queries.
-- (idx_config_record_key_cm_created from 0002 already covers
--  (world_slug, surface, cm_identity_id, created_at DESC); this adds the id
--  tie-break so the prune ordering (created_at DESC, id DESC) is index-served.)
CREATE INDEX IF NOT EXISTS idx_config_record_key_cm_created_id
  ON config_record (world_slug, surface, cm_identity_id, created_at DESC, id DESC);
