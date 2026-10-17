#!/usr/bin/env node
/**
 * The ONE statement that seeds a retired Diamond into `indexer_deployment`
 * (#1566, Codex #2545 r3): what a fresh contract redeploy tells the indexer,
 * so its next pass under the new bundle sees a different, newer Diamond and
 * resets the chain's chain-scoped rows (src/deploymentEpoch.ts).
 *
 * Semantics of the upsert:
 *   - no row            → insert the retired Diamond (not blind, not pending).
 *   - row adopted BLIND and NEWER than the seed → replace it. This is the
 *     published-before-seeded race: the new Worker's first pass recorded the
 *     new Diamond with nothing reset; the seed corrects it and the next pass
 *     resets.
 *   - any other row     → untouched: the epoch was earned by a reset (not
 *     blind), or the seed is not older than what is recorded. A second seed
 *     can never trigger a second reset.
 *
 * WHERE THE RETIRED DIAMONDS COME FROM (Codex #2545 r6): the COMMITTED archive
 * inventory, `contracts/deployments/archive-manifest.json`, which every
 * `--fresh` redeploy writes BEFORE it moves the artifact. For each chain the
 * live bundle (`packages/contracts/src/deployments.json`) names, the newest
 * archived entry whose Diamond differs from the live one is a retired Diamond
 * to seed. Nothing untracked is involved, so a deploy from a clean checkout of
 * the merged tree — a Workers Build, an operator's `pnpm run deploy` — seeds
 * exactly what the repository records. Seeding is idempotent (see above), so
 * every deploy may run it.
 *
 * Used by `deploy-shared-d1.mjs apply` (the indexer's deploy, between the
 * migration apply and the publish — the only moment the table is guaranteed
 * to exist and the new code is guaranteed not to be running yet), and by the
 * deploy scripts directly. `INDEXER_RETIRED_DEPLOYMENTS_FILE` may ADD entries
 * from a JSON array of `{ chainId, diamond, deployBlock }`.
 *
 * CLI:
 *   node retiredDeploymentSeed.mjs print  (--from-manifest | <file.json> | <chainId> <diamond> <deployBlock>)
 *   node retiredDeploymentSeed.mjs apply  (--from-manifest | <file.json> | <chainId> <diamond> <deployBlock>)   (wrangler d1 execute --remote)
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

export const D1_NAME = 'vaipakam-warm';

/** Validate one entry; everything is interpolated into SQL for `wrangler d1 execute --command`, so nothing unvalidated may pass. */
export function validateRetiredDeployment(entry) {
  const chainId = Number(entry?.chainId);
  const deployBlock = Number(entry?.deployBlock);
  const diamond = String(entry?.diamond ?? '');
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`retired deployment: chainId must be a positive integer, got ${String(entry?.chainId)}`);
  if (!Number.isInteger(deployBlock) || deployBlock < 0) throw new Error(`retired deployment: deployBlock must be a non-negative integer, got ${String(entry?.deployBlock)}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(diamond)) throw new Error(`retired deployment: diamond must be a 0x-prefixed 40-hex address, got ${diamond}`);
  return { chainId, diamond, deployBlock };
}

/** The seed statement for one retired deployment. */
export function seedRetiredDeploymentSql(entry) {
  const { chainId, diamond, deployBlock } = validateRetiredDeployment(entry);
  return (
    `INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind) ` +
    `VALUES (${chainId}, '${diamond}', ${deployBlock}, strftime('%s','now'), 0, 0) ` +
    `ON CONFLICT(chain_id) DO UPDATE SET diamond = excluded.diamond, deploy_block = excluded.deploy_block, ` +
    `adopted_at = excluded.adopted_at, reset_pending = 0, adopted_blind = 0 ` +
    `WHERE indexer_deployment.adopted_blind = 1 AND indexer_deployment.deploy_block > excluded.deploy_block;`
  );
}

/** Every entry of a JSON file (an array, or one object) as validated entries. */
export function readRetiredDeploymentsFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new Error(`retired deployments file ${path} is empty`);
  return list.map(validateRetiredDeployment);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const MANIFEST_PATH = join(REPO_ROOT, 'contracts', 'deployments', 'archive-manifest.json');
export const DEPLOYMENTS_PATH = join(REPO_ROOT, 'packages', 'contracts', 'src', 'deployments.json');

/**
 * The retired Diamonds the repository records: for each chain the live bundle
 * names, the newest archived entry for that chain's slug whose Diamond is not
 * the live one. A chain with no archived entry, or whose newest archived
 * Diamond IS the live one, contributes nothing.
 */
export function retiredDeploymentsFromManifest({ manifestPath = MANIFEST_PATH, deploymentsPath = DEPLOYMENTS_PATH } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8'));
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const out = [];
  for (const [chainIdKey, live] of Object.entries(deployments)) {
    const chainId = Number(chainIdKey);
    if (!Number.isInteger(chainId) || !live || typeof live.diamond !== 'string') continue;
    const slug = typeof live.chainSlug === 'string' ? live.chainSlug : null;
    const archived = entries
      .filter((e) => e && typeof e.diamond === 'string' && (Number(e.chainId) === chainId || (slug !== null && e.slug === slug)))
      .sort((a, b) => String(a.stamp ?? '').localeCompare(String(b.stamp ?? '')));
    const newest = archived[archived.length - 1];
    if (!newest) continue;
    if (newest.diamond.toLowerCase() === live.diamond.toLowerCase()) continue;
    out.push(validateRetiredDeployment({ chainId, diamond: newest.diamond, deployBlock: Number(newest.deployBlock ?? 0) }));
  }
  return out;
}

function entriesFromArgs(args) {
  if (args.length === 1 && args[0] === '--from-manifest') return retiredDeploymentsFromManifest();
  if (args.length === 1) return readRetiredDeploymentsFile(args[0]);
  if (args.length === 3) return [validateRetiredDeployment({ chainId: args[0], diamond: args[1], deployBlock: args[2] })];
  throw new Error('usage: retiredDeploymentSeed.mjs <print|apply> (<file.json> | <chainId> <diamond> <deployBlock>)');
}

/** Run one seed statement against the remote D1 from apps/indexer (wrangler reads wrangler.jsonc there). */
export function applyRetiredDeployment(entry, { cwd = join(dirname(fileURLToPath(import.meta.url)), '..', '..') } = {}) {
  const sql = seedRetiredDeploymentSql(entry);
  const r = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', D1_NAME, '--remote', '--command', sql], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ok = r.status === 0 && /Executed|rows (read|written)/.test(out);
  return { ok, sql, output: out };
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== 'print' && mode !== 'apply') {
    console.error('usage: retiredDeploymentSeed.mjs <print|apply> (<file.json> | <chainId> <diamond> <deployBlock>)');
    return 2;
  }
  const entries = entriesFromArgs(rest);
  if (entries.length === 0) console.log('  (no retired deployment to seed)');
  let failed = 0;
  for (const e of entries) {
    if (mode === 'print') {
      console.log(seedRetiredDeploymentSql(e));
      continue;
    }
    const r = applyRetiredDeployment(e);
    if (r.ok) {
      console.log(`  ✓ seeded retired Diamond ${e.diamond} (deploy block ${e.deployBlock}) for chainId=${e.chainId}`);
    } else {
      failed += 1;
      console.error(`  ✗ could not seed chainId=${e.chainId}: ${r.output.trim().split('\n').slice(-3).join(' | ')}`);
      console.error(`    run against ${D1_NAME} once migration 0063 is applied:\n    ${r.sql}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
