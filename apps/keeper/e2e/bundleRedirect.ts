/**
 * The one seam between the keeper and a scenario's local chains: the keeper
 * resolves its chains and Diamond addresses from
 * `@vaipakam/contracts/deployments`, which imports a static
 * `./deployments.json`. This plugin redirects THAT import (and only that one,
 * from `packages/contracts/src/deployments.ts`) to the bundle a fixture's
 * global setup wrote — the same redirect the connected app's e2e build makes
 * (`apps/app/vite.config.ts`). No keeper code is changed or mocked to point
 * it at the nodes.
 *
 * Each vitest config passes its OWN bundle: the single-chain scenarios'
 * 84532 entry is a different Diamond from the two-chain scenarios' one, so
 * the two run as separate configs (`vitest.config.ts`,
 * `vitest.mesh.config.ts`) rather than sharing a redirect.
 */
import type { Plugin } from 'vitest/config';

export function scenarioDeploymentsBundle(bundlePath: string): Plugin {
  return {
    name: 'keeper-e2e-deployments-bundle',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './deployments.json' || !importer) return null;
      const from = importer.split('?')[0].replace(/\\/g, '/');
      if (!from.endsWith('/packages/contracts/src/deployments.ts')) return null;
      return bundlePath;
    },
  };
}
