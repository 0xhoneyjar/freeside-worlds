#!/usr/bin/env bun
/**
 * validate.ts — pre-generation gate
 *
 * Validates every worlds/*.yaml against ../protocol/world-manifest.schema.json.
 * Fails fast with a path + JSONPath + expected/actual report so the operator
 * can grep + fix in one read.
 *
 * Usage:
 *   bun bin/validate.ts                   validate all worlds
 *   bun bin/validate.ts <slug>            validate one world
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCHEMA_PATH = resolve(ROOT, "../protocol/world-manifest.schema.json");
const WORLDS_DIR = resolve(ROOT, "worlds");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const filter = process.argv[2];

const files = readdirSync(WORLDS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .filter((f) => !filter || f === `${filter}.yaml`);

if (files.length === 0) {
  console.error(`no world YAMLs found${filter ? ` matching '${filter}'` : ""}`);
  process.exit(1);
}

let failed = 0;
for (const file of files.sort()) {
  const path = join(WORLDS_DIR, file);
  const content = parseYaml(readFileSync(path, "utf-8"));
  const ok = validate(content);
  if (!ok) {
    failed++;
    console.error(`✗ ${file}`);
    for (const err of validate.errors ?? []) {
      console.error(`  ${err.instancePath || "/"}: ${err.message}`);
      if (err.params && Object.keys(err.params).length > 0) {
        console.error(`    params: ${JSON.stringify(err.params)}`);
      }
    }
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${files.length} failed validation`);
  process.exit(1);
}

console.log(`\n${files.length}/${files.length} valid against world-manifest v1.0`);
