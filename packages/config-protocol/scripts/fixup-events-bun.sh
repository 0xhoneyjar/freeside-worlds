#!/usr/bin/env bash
# fixup-events-bun.sh — Bun-specific companion for the @0xhoneyjar/events
# git-source dependency.
#
# WHY THIS EXISTS:
#   Under bun, a git-URL dep pointing at a monorepo
#   (github:0xHoneyJar/loa-freeside#SHA) resolves to the monorepo ROOT —
#   whose package.json has `name: "loa-freeside"`, NOT
#   `name: "@0xhoneyjar/events"`. The import `@0xhoneyjar/events` therefore
#   fails to resolve. This script re-points the wrong symlink to the
#   `packages/events/` SUBDIR (correct name + exports map + a built dist/).
#
#   Mirrors freeside-characters/scripts/fixup-events-bun.sh verbatim in
#   intent; the cluster's other bun consumer of @0xhoneyjar/events. The
#   pinned SHA (68f5a89…) already ships a built packages/events/dist/, so no
#   dist rebuild is needed for this package — the symlink fixup is sufficient.
#
# WHY package.json DECLARES @noble/hashes + @noble/curves + canonicalize:
#   They are the RUNTIME transitive deps of @0xhoneyjar/events — `events/jcs.ts`
#   imports `canonicalize` (JCS) + `@noble/hashes` (sha256), `events/signer.ts`
#   imports `@noble/curves` (ed25519). The substrate's `roleMapVersionHash` calls
#   `jcsCanonicalize`/`sha256Hex` from events, so these MUST resolve. The
#   git-source monorepo-root resolution above does NOT reliably hoist the
#   events subpackage's own deps, so we declare them explicitly here. They are
#   NOT unused — do not remove (FAGAN iter-2 REJECT-E, verified by grep).
#
# IDEMPOTENT: re-running is a no-op when the symlink already points at the
# right subdir.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TAG="[fixup-events-bun]"

# Find every bun-installed events symlink under this package's node_modules.
# NOTE on portability + safety:
#   - `mapfile`/`readarray` is bash 4+; macOS ships /bin/bash 3.2, where the
#     postinstall hook runs. We use a Bash-3.2-compatible `while read` loop.
#   - Every filesystem path below is passed to `node` via process.argv / env,
#     NEVER interpolated into the `node -e` JS source — a checkout path with a
#     quote/backslash would otherwise break the JS string (silent mis-fixup,
#     the exact failure this script exists to prevent) and is an injection
#     vector in an auto-run install hook.
SYMLINKS=()
while IFS= read -r link; do
  [[ -n "$link" ]] && SYMLINKS+=("$link")
done < <(find "$ROOT_DIR" -type l -path "*/node_modules/@0xhoneyjar/events" 2>/dev/null || true)

if [[ ${#SYMLINKS[@]} -eq 0 ]]; then
  echo "$TAG No @0xhoneyjar/events symlinks found under $ROOT_DIR/**/node_modules — nothing to fix up"
  exit 0
fi

# JS program: print the `name` field of the package.json at argv[1] (empty on
# any error). The path arrives via process.argv — never interpolated.
read -r -d '' READ_PKG_NAME_JS <<'JS' || true
try { console.log(require(process.argv[1]).name || '') } catch { console.log('') }
JS

# JS program: print path.relative(argv[1], argv[2]). Paths arrive via argv.
read -r -d '' REL_PATH_JS <<'JS' || true
console.log(require('path').relative(process.argv[1], process.argv[2]))
JS

fixup_count=0
for link in ${SYMLINKS[@]+"${SYMLINKS[@]}"}; do
  current_target=$(readlink "$link")
  abs_target=$(cd "$(dirname "$link")" && cd "$current_target" 2>/dev/null && pwd -P || echo "")
  if [[ -z "$abs_target" ]]; then
    echo "$TAG WARNING: $link points at a missing target — skipping"
    continue
  fi

  # Idempotent: already pointing at the right place? (path via argv, not interp.)
  if [[ -f "$abs_target/package.json" ]]; then
    name=$(node -e "$READ_PKG_NAME_JS" "$abs_target/package.json" 2>/dev/null || echo "")
    if [[ "$name" == "@0xhoneyjar/events" ]]; then
      continue
    fi
  fi

  subdir="$abs_target/packages/events"
  if [[ ! -f "$subdir/package.json" ]]; then
    echo "$TAG WARNING: $abs_target/packages/events/package.json not found — cannot fix up $link"
    continue
  fi

  link_dir=$(dirname "$link")
  rel_subdir=$(node -e "$REL_PATH_JS" "$link_dir" "$subdir" 2>/dev/null || echo "")
  if [[ -z "$rel_subdir" ]]; then
    echo "$TAG WARNING: failed to compute relative path for $link → $subdir"
    continue
  fi

  # Atomic swap: `ln -sfn` replaces the symlink in one syscall so a failure can
  # never leave the dependency unlinked (no partial-mutation window). `-n`
  # avoids dereferencing an existing symlink-to-dir and creating a nested link.
  ln -sfn "$rel_subdir" "$link"
  echo "$TAG Fixed up $link → $rel_subdir"
  fixup_count=$((fixup_count + 1))
done

if [[ $fixup_count -gt 0 ]]; then
  echo "$TAG Fixed up $fixup_count @0xhoneyjar/events symlink(s) to point at packages/events/ subdir"
fi
