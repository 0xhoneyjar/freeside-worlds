/**
 * Registry bridge — read existing slugs + write kitchen-provisioned YAML manifests.
 *
 * Writes to `packages/registry/worlds/{slug}.yaml` using the sealed world-manifest
 * schema minimum for shadow-funnel step 3+ (hosting + chain env vars + anon auth).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORLDS_DIR = join(__dirname, '../../../registry/worlds');

export interface RegistryWriteInput {
  worldSlug: string;
  displayName: string;
  chainId: string;
  contractAddress: string;
  orderId: string;
  source: string;
}

export interface RegistryBridge {
  listExistingSlugs(): Set<string>;
  writeManifestYaml(input: RegistryWriteInput): string;
}

export function createRegistryBridge(worldsDir = process.env.WORLDS_REGISTRY_DIR ?? DEFAULT_WORLDS_DIR): RegistryBridge {
  return {
    listExistingSlugs(): Set<string> {
      if (!existsSync(worldsDir)) return new Set();
      const slugs = new Set<string>();
      for (const file of readdirSync(worldsDir)) {
        if (file.endsWith('.yaml')) {
          slugs.add(file.replace(/\.yaml$/, ''));
        }
      }
      return slugs;
    },

    writeManifestYaml(input: RegistryWriteInput): string {
      mkdirSync(worldsDir, { recursive: true });
      const yamlPath = join(worldsDir, `${input.worldSlug}.yaml`);

      const doc = {
        schema_version: '1.2',
        slug: input.worldSlug,
        name: input.displayName,
        repo: `0xHoneyJar/world-${input.worldSlug}`,
        description: `Kitchen-provisioned world (${input.source}, order ${input.orderId}).`,
        auth: { backend: 'anon' },
        hosting: {
          type: 'ECSHosting',
          cpu: 256,
          memory: 512,
        },
        env_vars: {
          PUBLIC_CHAIN_ID: input.chainId,
          PUBLIC_CONTRACT_ADDRESS: input.contractAddress,
        },
        secrets: [],
        compose_with: [],
      };

      const header = `# Auto-provisioned by worlds-api kitchen manifest API.\n# order_id: ${input.orderId}\n# source: ${input.source}\n`;
      writeFileSync(yamlPath, header + stringifyYaml(doc, { lineWidth: 0 }), 'utf-8');
      return yamlPath;
    },
  };
}

/** Read slug from an existing YAML file (for tests / validation helpers). */
export function readSlugFromYaml(path: string): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const match = /^slug:\s*(\S+)/m.exec(raw);
  return match?.[1] ?? null;
}
