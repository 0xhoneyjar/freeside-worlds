# packages/registry — YAML source-of-truth + terraform generator

The bridge between `freeside-world` world manifests and `loa-freeside` infrastructure/terraform. Every world deployed on Freeside has a corresponding `worlds/{slug}.yaml` here that auto-generates the per-tenant `world-{slug}.tf` + `world-{slug}-secrets.tf` files Terraform consumes.

## Layout

```
packages/registry/
├── worlds/                  source-of-truth YAMLs (one per world)
│   ├── apdao.yaml
│   ├── mibera.yaml
│   ├── midi.yaml
│   ├── rektdrop.yaml
│   └── score-api.yaml
├── bin/
│   ├── validate.ts          ajv against ../protocol/world-manifest.schema.json
│   ├── generate-tf.ts       worlds/*.yaml → tf-out/world-{slug}.tf + tf-out/world-{slug}-secrets.tf
│   └── sync-from-tf.ts      one-time bootstrap: read existing world-{name}.tf → emit YAML
├── tf-templates/            (optional) handlebars templates if/when complexity demands them
└── tf-out/                  generated, gitignored. Copied to loa-freeside via cross-repo PR.
```

## Workflow — adding a new world

1. Author `worlds/<slug>.yaml` (or have COSMOGRAPHER's apprenticeship author it via `packages/creator`).
2. `bun run validate` — fail-fast on schema drift.
3. `bun run generate-tf` — emits `tf-out/world-<slug>.tf` + `tf-out/world-<slug>-secrets.tf`.
4. Open PR in `loa-freeside` copying `tf-out/*` into `infrastructure/terraform/`.
5. `terraform plan` in loa-freeside CI shows the diff.
6. Merge + `terraform apply`.
7. World is live on Freeside.

## Workflow — modifying an existing world

1. Edit `worlds/<slug>.yaml`.
2. `bun run generate-tf` — emits the updated terraform.
3. Cross-repo PR to loa-freeside.
4. `terraform plan` shows only the intended diff.
5. Merge + apply.

## Idempotency gate (the load-bearing test)

`bin/generate-tf.ts` MUST produce output that, when copied to `loa-freeside/infrastructure/terraform/`, produces a `terraform plan` showing **zero semantic diff** against the live infrastructure.

"Zero semantic diff" means: terraform sees no resource changes. Whitespace + comment churn is acceptable on first migration; semantically the plan is clean.

If `terraform plan` shows ANY resource change after first migration, the schema is incomplete or the templates are wrong. Treat as a hard gate.

## Phase 2 — registry as runtime surface

Today: YAML in this package is the source-of-truth; terraform consumes it via cross-repo PR.

When 10+ worlds exist OR Freeside dashboard needs sub-second world-list queries:
- **Option A**: Convex/Postgres table in `loa-freeside/apps/dashboard`. YAML → DB on PR-merge.
- **Option B**: GitHub raw-content fetch + cache.
- **Option C** (most likely): hybrid — YAML canonical, dashboard mirrors to DB.

Until then: YAML is enough.

## Schema

Defined in `../protocol/world-manifest.schema.json` v1.0. Governance: `../protocol/VERSIONING.md`.
