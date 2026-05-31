# Render Contract — store raw-but-bounded, escape-at-render

> **One sentence:** this package stores config **raw-but-bounded**; the
> **rendering medium** (C-5, `freeside-mediums`) MUST **escape per-medium**
> before output. The store never emits to a medium directly.

This document closes the BLOCKER-1 (config-injection) contract so the escape
responsibility has a single, named owner.

## Why this contract exists

In sietch, the verify-flow message copy was a **hardcoded string** — never
attacker-controlled, so no output sanitization was needed. The C-1 extraction
makes that copy (and the optional theme) **community-manager-editable** via the
config service. That changes the trust model: a CM's input now flows toward a
rendering medium (Discord, the verify web page). The port initially dropped the
defense — editable `copy.*` plus an OPEN `theme.props` record
(`Record<string, unknown>` / `additionalProperties: true`) would have been
rendered with zero sanitization.

The fix splits the defense across two planes so neither plane has to know the
other's concerns:

| Plane | Owner | Responsibility | Where |
|---|---|---|---|
| **Write-side** | this package + `config-engine` | generic, **medium-agnostic VALIDATION** | `putConfig` decode-and-validate |
| **Render-side** | `freeside-mediums` (C-5) | medium-specific **ESCAPING** | per-medium renderer |

## What the write-side already guarantees (this package)

Enforced in `surface-config.ts` (Effect.Schema), applied at the
`config-engine putConfig` boundary (fail-closed; reject → `ConfigValidationError`
→ HTTP 422):

1. **Bounded `props` slot-schema.** `ComponentInstance.props` is a **closed**
   set of allowed keys with bounded value-types — NOT an open record. Decoding
   runs with `onExcessProperty: 'error'`, so an unknown key (e.g. `onClick`)
   anywhere in the tree is **rejected**, not silently stripped. (Closed
   tree-wide: envelope, theme, branding, copy, every component.)
2. **Length caps** on every CM-editable / stored string
   (`title ≤ 200`, `body ≤ 4000`, `buttonLabel ≤ 80`, prop strings ≤ 4000,
   names/ids ≤ 200, description ≤ 1000).
3. **Control-byte / zero-width rejection.** Every stored string rejects C0
   (`U+0000–U+001F`), DEL (`U+007F`), C1 (`U+0080–U+009F`), and zero-width Cf
   characters (`U+200B–U+200F`, `U+202A–U+202E`, `U+2060–U+2064`, `U+FEFF`).
   Mirrors loa-freeside's soul/handoff sanitizers
   (`.claude/scripts/lib/soul-identity-lib.sh` `_scrub_heading`) but **rejects**
   at write rather than strips — the operator gets a 422 and fixes the input;
   the store never silently mutates content.

**What the write-side deliberately does NOT do:** HTML-escape, Discord-markdown
escape, or any medium-specific transform. The stored bytes are the operator's
literal intent within the bounds above. Escaping at write would couple the
store to one medium and corrupt round-trips for every other medium.

## What the render-side MUST do (C-5 / `freeside-mediums`)

The rendering medium reads a stored, already-bounded config and **MUST escape
per-medium before output**:

- **Discord** — escape for Discord CV2 (Components V2) / markdown before
  placing any `copy.*` or theme-derived string into a message component.
- **Verify web page** — HTML-escape (`&`, `<`, `>`, `"`, `'`) before
  interpolating any stored string into HTML. See loa-freeside **arrakis-art2
  F-001** (the verify-page HTML-escape finding) for the canonical web-page
  escape requirement.

Tracking bead: **arrakis-4re1 (C-5)** — `freeside-mediums` owns the per-medium
escape implementation. This contract is the seam: the store fulfills its half
(raw-but-bounded), C-5 fulfills the other half (escape-at-render).

## The invariant, stated negatively

- The store **never** emits config to a medium directly.
- A medium **never** renders stored config without escaping for that medium.
- The write-side **never** silently mutates input to make it "safe" — it
  bounds, and rejects what exceeds the bounds.

If a new medium is added, it inherits the render-side obligation: the bounds
this package enforces are necessary but **not sufficient** for safe output —
escaping is always the medium's job.
