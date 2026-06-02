# Config-service min-viable persistence contract (S2)

Cycle: `shadow-onboarding-substrate` · SDD §3.1/§6.1/§1.7 · task 403.6 (D4).

The shadow substrate is **pure** — it owns no database. All persistence flows
through the existing worlds-api config seam (`config-engine` over a `ConfigStore`
port: head-pointer + immutable append-only history + optimistic lock). S2 is
**additive** — no new tables, no schema rewrite. This documents the record shape
+ version contract so config-service is not a hidden late-failing dependency.

## The state-record shape

Persistence is `(world_slug, surface[, cm_identity_id]) → validated JSON`:

| Element | Contract |
|---|---|
| **Head pointer** | one row per key, carrying a monotonic `version` (the optimistic-lock token). `getConfig` reads it O(1). |
| **Immutable history** | every write appends one `config_record` (`CREATE \| UPDATE \| RESTORE`, `prev_config` + `new_config` + `actor` + `reason`). Never updated/deleted. |
| **Version guard** | `UPDATE … WHERE version = expected`; 0 rows ⇒ `ConfigVersionConflictError` (HTTP 409). |
| **Schema version** | `schema_version: "1.0"` on the envelope (unchanged; S2 adds surfaces, not a new envelope version). |

## The surface key (the S2 change)

| Surface | Key | Why |
|---|---|---|
| `verify-message` | `(world, surface)` | unchanged precedent |
| `role-map` | `(world, surface)` | one role map per world |
| `apply-mode` | `(world, surface)` | one safety state per world |
| `onboarding-lifecycle` | **`(world, surface, cm_identity_id)`** | **per-CM** — two CMs onboarding the same world get two records; neither overwrites the other (B1/SKP-006) |

`cm_identity_id` = the CM's identity-api `user_id` (UUID). It is BOTH a key
component AND carried in the payload. For every non-lifecycle surface it is
`null` (engine) / `''` (DB sentinel), collapsing the composite to the legacy
two-key — **zero data migration** for pre-existing rows.

## Wire contract (`/v1/config/:world/:surface`)

```
GET  …/role-map                         → 200 {envelope, version} | 404 not_configured | 401 | 403
PUT  …/role-map                         → 200 {envelope, version, record_id} | 409 | 403 (FR-10) | 422 | 400
GET  …/apply-mode                       → 200 | 404 (caller defaults SHADOW)
PUT  …/apply-mode                        → 200 | 409 | 403
GET  …/onboarding-lifecycle?cm=<uuid>   → 200 | 404 | 400 (cm required) | 403 (isolation/authority)
PUT  …/onboarding-lifecycle?cm=<uuid>   → 200 | 409 | 403 | 422 | 400
```

- **404 = fail-soft**: never configured → the caller uses its defaults
  (`apply_mode` defaults `SHADOW`). The engine never invents a row on read.
- **422 = fail-closed write**: `BoundedString` violation / unknown key
  (`onExcessProperty: 'error'`) → rejected before any store mutation.
- **403 = FR-10**: a verified `claims.sub` not in `admin_principals` (write +
  authority-bearing reads), or a `cm` ≠ `claims.sub` (per-CM isolation).

## DB migration (deploy-bound)

`packages/config-adapters/migrations/0002_onboarding_lifecycle_per_cm.sql` adds
`cm_identity_id TEXT NOT NULL DEFAULT ''` to both tables and widens the
`current_config` PK to `(world_slug, surface, cm_identity_id)`. Idempotent +
additive (safe to re-run on a 0001 database). **Apply 0002 before the apply
cutover (S4, 405.7).**

## Verification

- In-memory `ConfigStore` integration tests: `packages/config-service/__tests__/fr10-config-seam.test.ts`
  (round-trip + 401/403/409/422/404 + per-CM isolation + two-CM non-collision).
- Engine machinery (head-pointer + optimistic lock over the composite key):
  `packages/config-engine/__tests__/config-service.test.ts`.
- **Deployed** smoke (routing + schema + FR-10 token format against the LIVE
  service): `packages/config-service/__tests__/deployed-smoke.test.ts` — skips
  without `CONFIG_SERVICE_SMOKE_URL`; run it manually before the S4 cutover.
