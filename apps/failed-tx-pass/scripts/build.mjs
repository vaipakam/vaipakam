/**
 * Builds the pass's bundle (#3919) with the deploy stamp tag of the checkout
 * it is built from, so the pass can name its build to the indexer's build
 * history (#3921). The install builds from a clean checkout of a commit on
 * main, so the tag is that commit; a working copy with uncommitted tracked
 * changes is marked `-dirty`.
 */
import { build } from 'esbuild';
import { deployStamp } from '@vaipakam/lib/deployStamp';

const stamp = deployStamp();
if (!('tag' in stamp)) console.warn(`[failed-tx-pass build] no deploy stamp: ${stamp.reason}; the bundle reports itself unstamped`);

await build({
  entryPoints: ['host/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/failed-tx-pass.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __FAILED_TX_BUILD__: JSON.stringify('tag' in stamp ? stamp.tag : 'unstamped') },
});
