import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { cspScriptHashesPlugin } from '@vaipakam/lib/cspScriptHashes';
import { REPORT_ONLY_HEADER, cspConnectSourcesPlugin } from '@vaipakam/lib/cspConnectSources';
import { connectSources, rpcConfigProblems } from './src/chain/endpoints.ts';

// Stamp the commit and build time into the bundle (shown on the Help page
// and in the capability service's provenance) so a tester can always tell
// which build they are looking at.
process.env.VITE_BUILD_HASH = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();
process.env.VITE_BUILD_TIME = new Date().toISOString();

/** Every chain the committed deployments bundle carries a Diamond for. */
function deployedChainIds(): number[] {
  const require = createRequire(import.meta.url);
  const bundle = JSON.parse(
    fs.readFileSync(require.resolve('@vaipakam/contracts/deployments.json'), 'utf8'),
  ) as Record<string, { diamond?: string }>;
  return Object.entries(bundle)
    .filter(([, d]) => typeof d?.diamond === 'string' && d.diamond !== '')
    .map(([id]) => Number(id));
}

// A production build refuses an RPC configuration that would ship a
// provider key, or serve a mainnet without the read-only proxy. The rules
// are `rpcConfigProblems` in src/chain/endpoints.ts, the same module that
// decides where the bundle sends its reads (#1724).
function checkRpcConfig(mode: string, command: string): void {
  if (command !== 'build') return;
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const problems = rpcConfigProblems(env, deployedChainIds());
  if (problems.length > 0) {
    throw new Error(`[rpc-config guard]\n  - ${problems.join('\n  - ')}`);
  }
}

// RB-INTEGRITY — the Content-Security-Policy is completed from the build
// itself and the build throws rather than ship a policy it could not
// complete: inline scripts are allowed by hash only, and the hosts the page
// may connect to are written from the SAME resolver the bundle reads its
// endpoints through. The connect list ships REPORT-ONLY first (the rulebook's
// deployment acceptance: a live review of the deployed build fails on any
// report), and moves into the enforced line before the domain switches.
export default defineConfig(({ mode, command }) => {
  checkRpcConfig(mode, command);
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [
      react(),
      cspScriptHashesPlugin() as Plugin,
      cspConnectSourcesPlugin({
        header: REPORT_ONLY_HEADER,
        sources: () => connectSources(env, deployedChainIds()),
      }) as Plugin,
    ],
    build: {
      rollupOptions: {
        output: {
          // The rarely-changing dependency groups out of the entry chunk, so
          // the boot payload stays small and vendor code stays cacheable
          // across app deploys.
          manualChunks(id: string) {
            if (/[\\/]packages[\\/]contracts[\\/]src[\\/](abis[\\/]|diamondAbi\.json)/.test(id)) {
              return 'contract-abis';
            }
            if (id.includes('node_modules')) {
              if (/[\\/]node_modules[\\/](wagmi|viem|connectkit|@tanstack[\\/]react-query|@wagmi)[\\/]/.test(id)) {
                return 'wallet-vendor';
              }
              if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
                return 'react-vendor';
              }
            }
            return undefined;
          },
        },
      },
    },
  };
});
