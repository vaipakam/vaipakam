/**
 * The two operator scripts moved onto `lib/b2-native.mjs` in #3032, run as
 * an operator runs them, against the in-memory B2 on API version 4 (#3222).
 *
 * Each run is a child process with only `PATH` from the parent environment,
 * so no credential on the machine running the tests can reach it, and the
 * preload replaces `fetch`, so nothing leaves the process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(HERE, 'test-helpers', 'fake-fetch-preload.mjs')).href;
const DECL = JSON.parse(readFileSync(join(HERE, '..', 'bucket-lifecycle.json'), 'utf8'));
const WARM = DECL.bucket;

function runScript(script, args, { world, env }) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', PRELOAD, join(HERE, script), ...args], {
    env: { PATH: process.env.PATH, FAKE_B2_WORLD: JSON.stringify(world), ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// ── find-archive-baselines ──────────────────────────────────────────────

const READ = ['listBuckets', 'listFiles', 'readFiles'];
const baselineWorld = (key) => ({
  buckets: [{ name: WARM }, { name: 'other' }],
  keys: [key],
  files: [
    { bucket: WARM, name: `manifests-monthly/2026-09/${'a'.repeat(32)}.json` },
    { bucket: WARM, name: `archives-monthly/2026-10/${'b'.repeat(32)}.bin` },
    { bucket: WARM, name: `archives-monthly/2026-00/${'c'.repeat(32)}.bin` },
  ],
});
const readEnv = { B2_READ_ACCESS_KEY_ID: 'reader', B2_READ_SECRET_ACCESS_KEY: 's' };

test('the baseline finder reads the earliest real period with a read key scoped to the bucket', () => {
  const r = runScript('find-archive-baselines.mjs', [], { world: baselineWorld({ id: 'reader', bucket: WARM, capabilities: READ }), env: readEnv });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ARCHIVE_FIRST_MONTHLY: '2026-09'/);
  assert.match(r.out, /periods: {2}NONE/);
});

test('the baseline finder refuses a key wider than the one bucket, or with more authority', () => {
  for (const [key, why] of [
    [{ id: 'reader', bucket: null, capabilities: READ }, /may reach every bucket/],
    [{ id: 'reader', buckets: [WARM, 'other'], capabilities: READ }, /confined to 2 buckets/],
    [{ id: 'reader', bucket: 'other', capabilities: READ }, /scoped to other/],
    [{ id: 'reader', bucket: WARM, capabilities: [...READ, 'deleteFiles'] }, /must not have: deleteFiles/],
    [{ id: 'reader', bucket: WARM, capabilities: READ, namePrefix: 'archives-monthly/' }, /name prefix/],
  ]) {
    const r = runScript('find-archive-baselines.mjs', [], { world: baselineWorld(key), env: readEnv });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, why);
  }
});

// ── apply-bucket-lifecycle ──────────────────────────────────────────────

const lifecycleWorld = (key, rules) => ({ buckets: [{ name: WARM, lifecycleRules: rules }], keys: [key] });
const keyEnv = { BACKBLAZE_KEY_ID: 'k', BACKBLAZE_APP_KEY: 's' };
const drifted = DECL.rules.map((r) => ({ ...r, daysFromHidingToDeleting: 1 }));

test('the lifecycle check reports a match and a drift with the read key', () => {
  const read = { id: 'k', bucket: WARM, capabilities: READ };
  const same = runScript('apply-bucket-lifecycle.mjs', ['--check'], { world: lifecycleWorld(read, DECL.rules), env: keyEnv });
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /MATCH/);
  const drift = runScript('apply-bucket-lifecycle.mjs', ['--check'], { world: lifecycleWorld(read, drifted), env: keyEnv });
  assert.equal(drift.code, 1, drift.out);
  assert.match(drift.out, /DRIFT/);
});

test('apply writes the declaration and verifies it by reading it back', () => {
  const writer = { id: 'k', bucket: WARM, capabilities: ['listBuckets', 'writeBuckets'] };
  const r = runScript('apply-bucket-lifecycle.mjs', ['--apply'], { world: lifecycleWorld(writer, drifted), env: keyEnv });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /applied and verified by readback/);
});

test('the lifecycle tool refuses the master key', () => {
  const master = { id: 'k', bucket: null, capabilities: ['listBuckets', 'writeBuckets', 'writeKeys', 'deleteBuckets'] };
  const r = runScript('apply-bucket-lifecycle.mjs', ['--check'], { world: lifecycleWorld(master, DECL.rules), env: keyEnv });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /looks like the MASTER key/);
});
