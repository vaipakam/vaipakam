/**
 * The e2e tier's deployments bundle, as a Vite plugin shared by the
 * connected apps' Playwright suites (apps/app, apps/alpha05).
 *
 * Under the e2e tier the app must read the Diamond deployed on the local
 * Anvil, which exists only in the generated file the suite's global setup
 * writes (`<stateDir>/deployments.json`, gitignored); the committed
 * bundle's entry for that chain is the live testnet, which is exactly what
 * the suite must not read. Exactly one module imports the bundle,
 * `packages/contracts/src/deployments.ts`, so this redirects that one
 * import and nothing else. An app registers it only when its e2e flag is
 * set; no other dev, build or deploy path sees it.
 *
 * Playwright starts the dev server BEFORE global setup runs, and Vite
 * pre-transforms the entry's imports as soon as the readiness probe loads
 * the page, so the first load of this module can arrive before the file
 * exists. It therefore WAITS until the bundle is stamped with this run's id
 * (`<stateDir>/deployments.run-id`, minted by the Playwright config into
 * the environment variable `runIdEnv`), which also means a file left by an
 * earlier run is never served. A bundle that never arrives is an error,
 * never a fallback to the committed one: a silent fallback would point the
 * app at the live testnet while every harness helper points at the local
 * chain.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUNDLE_FILE = 'deployments.json';
export const RUN_ID_FILE = 'deployments.run-id';
const WAIT_MS = 20 * 60_000;

/**
 * @param {{ stateDir: string, runIdEnv: string }} options
 *   `stateDir`: the suite's state directory (absolute); `runIdEnv`: the
 *   environment variable the Playwright config mints the run id into.
 */
export function e2eDeploymentsBundlePlugin({ stateDir, runIdEnv }) {
  const bundle = path.join(stateDir, BUNDLE_FILE);
  const stamp = path.join(stateDir, RUN_ID_FILE);
  const stampedForThisRun = (runId) => {
    try {
      return fs.readFileSync(stamp, 'utf8').trim() === runId;
    } catch {
      return false;
    }
  };
  return {
    name: 'vaipakam-e2e-deployments-bundle',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './deployments.json' || !importer) return null;
      const from = importer.split('?')[0].replace(/\\/g, '/');
      if (!from.endsWith('/packages/contracts/src/deployments.ts')) return null;
      return bundle;
    },
    async load(id) {
      if (id !== bundle) return null;
      const runId = process.env[runIdEnv];
      if (!runId) {
        this.error(`${runIdEnv} is unset — start the e2e app through Playwright, whose config mints it.`);
      }
      const deadline = Date.now() + WAIT_MS;
      while (!stampedForThisRun(runId)) {
        if (Date.now() > deadline) {
          this.error(
            `${bundle} was not written for this run within ${WAIT_MS / 60_000} minutes. ` +
              'The e2e global setup writes it after deploying the fixture chain; the ' +
              'app does not fall back to the committed bundle.',
          );
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return fs.readFileSync(bundle, 'utf8');
    },
  };
}
