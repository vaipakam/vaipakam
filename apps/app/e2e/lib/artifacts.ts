/**
 * Node-side loader for the @vaipakam/contracts artifacts. The app
 * imports the workspace barrel (vite understands its JSON imports);
 * Node's ESM loader — which runs this suite and the indexer stub —
 * refuses those without import attributes, so the e2e tier reads the
 * SAME ABI files via fs instead, and the same generated deployments
 * bundle the app is pointed at.
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

/**
 * The deployments bundle every e2e consumer reads — the committed one with
 * its 84532 entry replaced by the deployment global setup just made from
 * source (#2334; see `fixture.ts`). The app reads the same file through
 * vite's APP_E2E resolve hook, so the suite and the app cannot disagree
 * about an address.
 */
export const E2E_BUNDLE = path.resolve(HERE, '..', '.state', 'deployments.json');
/** Written after the bundle, holding the run id it belongs to. */
export const E2E_BUNDLE_RUN_ID = path.resolve(HERE, '..', '.state', 'deployments.run-id');

/** This suite run's id, minted by `playwright.config.ts`. */
export function e2eRunId(): string {
  const id = process.env.APP_E2E_RUN_ID;
  if (!id) {
    throw new Error('APP_E2E_RUN_ID is unset — run the e2e suite through Playwright (its config mints it)');
  }
  return id;
}

export interface DeploymentSlice {
  diamond: `0x${string}`;
  /** The Diamond's admin — holds ADMIN_ROLE and ownership, so specs that
   *  flip config (#1355) impersonate it. */
  admin: `0x${string}`;
  weth?: `0x${string}`;
  testnetMocks?: Record<string, string>;
}

export function loadDeployment(chainId: number): DeploymentSlice {
  const stamped = fs.existsSync(E2E_BUNDLE_RUN_ID)
    ? fs.readFileSync(E2E_BUNDLE_RUN_ID, 'utf8').trim()
    : null;
  if (stamped !== e2eRunId()) {
    throw new Error(
      `${E2E_BUNDLE} is not this run's (stamped ${JSON.stringify(stamped)}) — global ` +
        `setup writes it after deploying the fixture chain, so this module was loaded ` +
        `before setup ran, or setup failed`,
    );
  }
  const all = JSON.parse(fs.readFileSync(E2E_BUNDLE, 'utf8')) as Record<string, DeploymentSlice>;
  const d = all[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId} in the e2e bundle`);
  return d;
}
