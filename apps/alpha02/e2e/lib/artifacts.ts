/**
 * Node-side loader for the @vaipakam/contracts artifacts. The app
 * imports the workspace barrel (vite understands its JSON imports);
 * Node's ESM loader — which runs this suite and the indexer stub —
 * refuses those without import attributes, so the fork-tier reads the
 * SAME source files via fs instead. Single source of truth preserved:
 * these are the exact JSONs the app ships with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONTRACTS_SRC = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'src',
);

/** Every per-facet ABI concatenated — the Diamond surface. Selector
 *  uniqueness across facets is enforced by the contracts repo's
 *  SelectorCoverageTest, so a flat concat is unambiguous. */
export function loadDiamondAbi(): Abi {
  const dir = path.join(CONTRACTS_SRC, 'abis');
  const out: unknown[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out as Abi;
}

export interface DeploymentSlice {
  diamond: `0x${string}`;
  weth?: `0x${string}`;
  testnetMocks?: Record<string, string>;
}

export function loadDeployment(chainId: number): DeploymentSlice {
  const all = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
  ) as Record<string, DeploymentSlice>;
  const d = all[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId} in the bundle`);
  return d;
}
