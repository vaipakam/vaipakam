/** Types for `e2eDeploymentsBundle.mjs`, imported by the connected apps' Vite configs under their e2e tiers. */

export const BUNDLE_FILE: string;
export const RUN_ID_FILE: string;
/** Structurally a Vite plugin; typed loosely so this package needs no Vite. */
export function e2eDeploymentsBundlePlugin(options: { stateDir: string; runIdEnv: string }): {
  name: string;
  enforce: 'pre';
  resolveId(source: string, importer: string | undefined): string | null;
  load(this: { error(message: string): never }, id: string): Promise<string | null>;
};
