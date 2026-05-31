# C-6 — freeside-worlds config service (the FIRST runtime in this repo).
#
# A deterministic Bun image, chosen over nixpacks so the build does NOT depend on
# nixpacks auto-detecting the newer text-format `bun.lock` (it keys on the legacy
# binary `bun.lockb`). With the official image the runtime is unambiguous.
FROM oven/bun:1

WORKDIR /app

# `.dockerignore` keeps node_modules/.git out of the context. Install against the
# committed lockfile so the build is reproducible. This installs `pg` (the
# optional peer that bun.lock already pins at 8.21.0) which the migration runner
# and PgConfigStore load dynamically via `await import('pg')`.
COPY . .
RUN bun install --frozen-lockfile

# Service reads PORT (Railway-injected), DATABASE_URL (its OWN Postgres — C-1
# isolation invariant), and CONFIG_SERVICE_TOKEN (service-to-service auth gate).
# Migrations run separately via railway.toml's preDeployCommand before this serves.
CMD ["bun", "packages/config-service/src/server.ts"]
