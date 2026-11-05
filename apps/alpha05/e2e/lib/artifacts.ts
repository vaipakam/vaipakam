/**
 * The deployments bundle every e2e consumer reads: the committed one with
 * its 84532 entry replaced by the deployment global setup made from source.
 * The app reads the same file through Vite's APP_E2E resolve hook
 * (`@vaipakam/lib/e2eDeploymentsBundle`), so the suite and the app cannot
 * disagree about an address, and both accept it only under this run's id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATE_DIR = path.resolve(HERE, '..', '.state');
export const E2E_BUNDLE = path.join(STATE_DIR, 'deployments.json');
export const E2E_BUNDLE_RUN_ID = path.join(STATE_DIR, 'deployments.run-id');

export function e2eRunId(): string {
  const id = process.env.APP_E2E_RUN_ID;
  if (!id) throw new Error('APP_E2E_RUN_ID is unset — run the e2e suite through Playwright (its config mints it)');
  return id;
}

export interface DeploymentSlice {
  diamond: `0x${string}`;
  admin: `0x${string}`;
  deployBlock?: number;
  weth?: `0x${string}`;
  testnetMocks?: Record<string, string>;
}

const LIST_ONLY_SLICE: DeploymentSlice = {
  diamond: '0x0000000000000000000000000000000000000000',
  admin: '0x0000000000000000000000000000000000000000',
};

export function loadDeployment(chainId: number): DeploymentSlice {
  const stamped = fs.existsSync(E2E_BUNDLE_RUN_ID) ? fs.readFileSync(E2E_BUNDLE_RUN_ID, 'utf8').trim() : null;
  if (stamped !== e2eRunId() && process.env.APP_E2E_LIST_ONLY === e2eRunId()) return LIST_ONLY_SLICE;
  if (stamped !== e2eRunId()) {
    throw new Error(
      `${E2E_BUNDLE} is not this run's (stamped ${JSON.stringify(stamped)}) — global setup writes it after ` +
        'deploying the fixture chain, so this module was loaded before setup ran, or setup failed',
    );
  }
  const all = JSON.parse(fs.readFileSync(E2E_BUNDLE, 'utf8')) as Record<string, DeploymentSlice>;
  const d = all[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId} in the e2e bundle`);
  return d;
}
