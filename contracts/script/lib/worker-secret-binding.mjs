#!/usr/bin/env node
/**
 * Where a Worker reads a named binding from, per its own wrangler config
 * (#2763 / #1492). Used by `worker-secrets.sh`.
 *
 *   node worker-secret-binding.mjs <worker_dir> <binding>
 *
 * Prints ONE line and exits 0:
 *   store <store_id> <secret_name>   the binding is a `secrets_store_secrets`
 *                                    entry: the value lives in that store
 *                                    under that name
 *   worker                           no store binding by that name: a value
 *                                    could only be a per-Worker secret
 *
 * Exits 2 with a message on stderr when the config cannot be read or a
 * matching entry is malformed, so the caller refuses rather than guessing.
 * The config is read with the repo's one JSONC reader
 * (`apps/keeper/scripts/lib/jsonc.mjs`), the same one the keep_vars check uses.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { parseJsonc } = await import(
  resolve(here, '../../../apps/keeper/scripts/lib/jsonc.mjs')
);

const [workerDir, binding] = process.argv.slice(2);
if (!workerDir || !binding) {
  console.error('usage: worker-secret-binding.mjs <worker_dir> <binding>');
  process.exit(2);
}

const candidates = ['wrangler.jsonc', 'wrangler.json'].map((f) => join(workerDir, f));
const configPath = candidates.find((p) => existsSync(p));
if (!configPath) {
  console.error(`no wrangler.jsonc or wrangler.json in ${workerDir}`);
  process.exit(2);
}

let config;
try {
  config = parseJsonc(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`${configPath} does not parse: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const entries = Array.isArray(config?.secrets_store_secrets) ? config.secrets_store_secrets : [];
const matches = entries.filter((e) => e && e.binding === binding);
if (matches.length > 1) {
  console.error(`${configPath} binds ${binding} from the Secrets Store more than once`);
  process.exit(2);
}
if (matches.length === 1) {
  const { store_id: storeId, secret_name: secretName } = matches[0];
  const word = /^[A-Za-z0-9_-]+$/;
  if (typeof storeId !== 'string' || !word.test(storeId) || typeof secretName !== 'string' || !word.test(secretName)) {
    console.error(`${configPath}: the ${binding} store binding lacks a well-formed store_id or secret_name`);
    process.exit(2);
  }
  console.log(`store ${storeId} ${secretName}`);
} else {
  console.log('worker');
}
