import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cspScriptHashesPlugin } from '@vaipakam/lib/cspScriptHashes';
import { cspConnectSourcesPlugin } from '@vaipakam/lib/cspConnectSources';
import { indexerOrigin } from './src/lib/indexerOrigin';

// Minimal Vite config for the marketing SPA.
//
// #43 (ET-017) — the Content-Security-Policy is completed from the build
// itself, and the build throws rather than ship a policy it could not
// complete (packages/lib/src/cspScriptHashes.mjs, cspConnectSources.mjs):
//   - `script-src` allows inline scripts only by hash: the hashes of the
//     BUILT page's inline scripts replace the placeholder `public/_headers`
//     carries. The prerender then refuses any snapshot whose inline
//     scripts that policy does not allow.
//   - `connect-src` allows the site's own origin and the indexer origin
//     this build's pages read, resolved from the same environment the
//     bundle is compiled with, through the same rule (`indexerOrigin`).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [
      react(),
      cspScriptHashesPlugin() as Plugin,
      cspConnectSourcesPlugin({ sources: () => [indexerOrigin(env.VITE_INDEXER_ORIGIN)] }) as Plugin,
    ],
  };
});
