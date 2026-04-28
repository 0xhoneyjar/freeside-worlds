#!/usr/bin/env bun
/**
 * sync-from-tf.ts — bootstrap helper
 *
 * Reads existing world-{name}.tf files in loa-freeside/infrastructure/terraform/
 * and emits worlds/{slug}.yaml. Used once to bootstrap the registry from
 * historical hand-written terraform; afterward the YAML is the source-of-truth
 * and this script only runs to import a future hand-edited .tf back into the
 * registry (e.g. if an operator hot-patches terraform out-of-band).
 *
 * Implementation note: HCL parsing is non-trivial. This v0 implementation
 * shells out to terraform's `terraform-config-inspect` if available, otherwise
 * uses a regex-based extractor for the small subset of HCL we care about
 * (module blocks, env_vars maps, secrets maps, locals.{name}_secrets toset).
 *
 * Usage:
 *   bun bin/sync-from-tf.ts <path-to-loa-freeside-terraform-dir> <slug>
 *
 * Status: STUB. The 5 existing worlds were hand-derived to YAML during initial
 * registry bootstrap. This script lands as v0 scaffolding for future imports;
 * fill in the parser when first reimport demands it.
 */
import { existsSync } from "node:fs";

const tfDir = process.argv[2];
const slug = process.argv[3];

if (!tfDir || !slug) {
  console.error("usage: bun bin/sync-from-tf.ts <terraform-dir> <slug>");
  console.error("");
  console.error("Reads <terraform-dir>/world-<slug>.tf and emits worlds/<slug>.yaml.");
  console.error("");
  console.error("Status: STUB. Implementation pending first reimport demand.");
  console.error("        The 5 existing worlds were hand-derived during bootstrap.");
  process.exit(2);
}

if (!existsSync(tfDir)) {
  console.error(`terraform dir not found: ${tfDir}`);
  process.exit(1);
}

const tfFile = `${tfDir}/world-${slug}.tf`;
if (!existsSync(tfFile)) {
  console.error(`world-${slug}.tf not found at ${tfFile}`);
  process.exit(1);
}

console.error("STUB: HCL parser not implemented. To import this .tf into a YAML manifest:");
console.error(`  1. Read ${tfFile} manually`);
console.error(`  2. Author worlds/${slug}.yaml by hand following the schema`);
console.error(`  3. Run: bun bin/validate.ts ${slug}`);
console.error(`  4. Run: bun bin/generate-tf.ts ${slug}`);
console.error(`  5. Diff tf-out/world-${slug}.tf against ${tfFile} to confirm round-trip`);
process.exit(1);
