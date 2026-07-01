/**
 * Slug normalization for kitchen-provisioned worlds.
 *
 * Rules (canonical across Freeside — dashboard catalog, score-api, characters):
 *   1. Lowercase the input.
 *   2. Trim leading/trailing whitespace.
 *   3. Replace runs of whitespace, underscores, and dots with a single hyphen.
 *   4. Strip characters outside `[a-z0-9-]`.
 *   5. Collapse consecutive hyphens.
 *   6. Strip leading/trailing hyphens.
 *   7. If the result starts with a digit, prefix `w-`.
 *   8. Truncate to 21 characters (matches world-manifest.schema.json `slug`:
 *      `^[a-z][a-z0-9-]{1,20}$` → 2–21 chars, must start with a letter).
 *   9. If shorter than 2 characters after normalization, fall back to `w-{n}`
 *      where `{n}` is a deterministic hash fragment from the input.
 *
 * Examples:
 *   "My Collection"     → "my-collection"
 *   "Pythenians NFT"    → "pythenians-nft"
 *   "  HELLO__world  "  → "hello-world"
 *   "123 Club"          → "w-123-club"
 */

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;
const MAX_SLUG_LEN = 21;

/** Normalize a display name into a candidate world slug. */
export function normalizeDisplayNameToSlug(displayName: string): string {
  let s = displayName.toLowerCase().trim();
  s = s.replace(/[\s_.]+/g, '-');
  s = s.replace(/[^a-z0-9-]/g, '');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  if (s.length > 0 && /^[0-9]/.test(s)) {
    s = `w-${s}`;
  }

  if (s.length > MAX_SLUG_LEN) {
    s = s.slice(0, MAX_SLUG_LEN).replace(/-+$/g, '');
  }

  if (s.length < 2 || !/^[a-z]/.test(s)) {
    const frag = simpleHash(displayName).slice(0, 6);
    s = `w-${frag}`;
  }

  return s;
}

/** Append `-2`, `-3`, … until the slug fits the schema and is unused. */
export function suggestAlternateSlug(baseSlug: string, taken: ReadonlySet<string>, maxAttempts = 100): string | null {
  if (!taken.has(baseSlug) && SLUG_PATTERN.test(baseSlug)) {
    return baseSlug;
  }

  for (let n = 2; n <= maxAttempts; n++) {
    const suffix = `-${n}`;
    const trimmed = baseSlug.slice(0, MAX_SLUG_LEN - suffix.length).replace(/-+$/g, '');
    const candidate = `${trimmed}${suffix}`;
    if (SLUG_PATTERN.test(candidate) && !taken.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
