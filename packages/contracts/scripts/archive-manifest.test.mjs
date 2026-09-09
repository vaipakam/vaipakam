// archive-manifest.test.mjs — proves the manifest writer serializes, verifies,
// refuses conflicts, and breaks only DEAD stale locks. Run with `node --test`
// (no dependency; CI runs `pnpm --filter @vaipakam/contracts test`).
//
// The concurrency case is exercised with REAL processes, because the race
// this module exists to close (Codex #2070 r12 P1) is between two `--fresh`
// deploys, i.e. two node processes appending to one committed file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEntry, readManifest, withManifestLock, entryFromArtifact, regenerateEntries, writeSnapshotGuarded } from './archive-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = join(HERE, 'archive-manifest.mjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'archive-manifest-'));
  const manifest = join(dir, 'deployments', 'archive-manifest.json');
  mkdirSync(dirname(manifest), { recursive: true });
  return { dir, manifest };
}
function artifact(dir, i) {
  const p = join(dir, `addresses-${i}.json`);
  writeFileSync(p, JSON.stringify({ chainId: 84532, diamond: `0x${String(i).padStart(40, '0')}`, deployBlock: i, vpfiToken: '0xvpfi' }));
  return p;
}
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRITER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('N concurrent processes appending to one manifest all land (the r12 race)', async () => {
  const { dir, manifest } = fixture();
  const N = 12;
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) => run(['append', manifest, `chain-${i % 3}`, `2026-01-01T00-00-${String(i).padStart(2, '0')}Z`, artifact(dir, i)])),
  );
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const m = readManifest(manifest);
  assert.equal(m.entries.length, N, 'every concurrent append must be present');
  assert.deepEqual(m.entries.map((e) => e.deployBlock).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
  // No lock directory or temp file survives.
  assert.deepEqual(readdirSync(dirname(manifest)), ['archive-manifest.json']);
});

test('re-appending an identical record is idempotent; a conflicting record is refused', () => {
  const { dir, manifest } = fixture();
  const e = entryFromArtifact({ slug: 'base-sepolia', stamp: 's1', addrPath: artifact(dir, 1) });
  assert.equal(appendEntry(manifest, e).status, 'recorded');
  assert.equal(appendEntry(manifest, e).status, 'already-recorded');
  assert.equal(readManifest(manifest).entries.length, 1);
  const before = readFileSync(manifest, 'utf8');
  assert.throws(() => appendEntry(manifest, { ...e, diamond: '0xdifferent' }), /DIFFERENT content/);
  assert.equal(readFileSync(manifest, 'utf8'), before, 'a refused conflict leaves the file untouched');
});

test('an artifact naming no diamond yields no entry', () => {
  const { dir } = fixture();
  const p = join(dir, 'empty.json');
  writeFileSync(p, JSON.stringify({ chainId: 1 }));
  assert.equal(entryFromArtifact({ slug: 'x', stamp: 'y', addrPath: p }), null);
});

test('a lock held by a LIVE process is waited on, then refused — never broken', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  // Make it OLD too: age alone must not break a lock whose owner is alive.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 2) });
  assert.throws(() => appendEntry(manifest, e, { timeoutMs: 300, pollMs: 20, staleMs: 1 }), /could not lock/);
  assert.equal(existsSync(manifest), false, 'nothing was written');
  assert.equal(existsSync(lockDir), true, 'the live lock is still there');
});

test('a stale lock whose owner is DEAD is broken and the write proceeds', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 3) });
  assert.equal(appendEntry(manifest, e, { timeoutMs: 2_000, pollMs: 20, staleMs: 1_000 }).status, 'recorded');
  assert.equal(existsSync(lockDir), false, 'the broken lock is released after the write');
});

test('withManifestLock releases on throw', () => {
  const { manifest } = fixture();
  assert.throws(() => withManifestLock(manifest, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(`${manifest}.lock`), false);
});

test('regenerate collects INSIDE the lock and sees every prior append (the r13 race)', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  const e2 = entryFromArtifact({ slug: 'a', stamp: 's2', addrPath: artifact(dir, 2) });
  appendEntry(manifest, e1);
  appendEntry(manifest, e2);
  let lockedDuringCollect = null;
  let seen = null;
  const { manifest: out } = regenerateEntries(manifest, (current) => {
    lockedDuringCollect = existsSync(`${manifest}.lock`);
    seen = current.entries.length;
    return [...current.entries, entryFromArtifact({ slug: 'b', stamp: 's3', addrPath: artifact(dir, 3) })];
  });
  assert.equal(lockedDuringCollect, true, 'collect must run while the lock is held');
  assert.equal(seen, 2, 'collect receives the file as it stands under the lock');
  assert.equal(out.entries.length, 3);
  assert.equal(readManifest(manifest).entries.length, 3);
  assert.equal(existsSync(`${manifest}.lock`), false);
});

test('regenerate refuses a DROP without the override, and refuses an empty result', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  const e2 = entryFromArtifact({ slug: 'a', stamp: 's2', addrPath: artifact(dir, 2) });
  appendEntry(manifest, e1);
  appendEntry(manifest, e2);
  const before = readFileSync(manifest, 'utf8');
  assert.throws(() => regenerateEntries(manifest, () => [e1]), /DROP 1/);
  assert.throws(() => regenerateEntries(manifest, () => []), /EMPTY/);
  assert.equal(readFileSync(manifest, 'utf8'), before, 'a refused regeneration leaves the file untouched');
  const { dropped } = regenerateEntries(manifest, () => [e1], { allowDrop: true });
  assert.equal(dropped, 1);
  assert.equal(readManifest(manifest).entries.length, 1);
});

test('regenerate may CORRECT the content of an existing key (an in-place artifact fix)', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  appendEntry(manifest, e1);
  regenerateEntries(manifest, () => [{ ...e1, diamond: '0xcorrected' }]);
  assert.equal(readManifest(manifest).entries[0].diamond, '0xcorrected');
});

test('a guarded snapshot write compares under the lock and refuses a regression (the r14 lost update)', () => {
  const { dir } = fixture();
  const p = join(dir, 'census.json');
  const heights = (h) => JSON.stringify({ results: [{ chainSlug: 'x', atBlock: String(h) }] }) + '\n';
  const byHeight = (mine) => (current) => {
    const theirs = Number(current.results[0].atBlock);
    return theirs > mine ? `a newer snapshot (block ${theirs}) is already committed for x; this run read block ${mine}` : null;
  };
  let lockedDuringCompare = null;
  assert.equal(writeSnapshotGuarded(p, heights(100), { regressedBy: () => { lockedDuringCompare = 'not called: no current'; return null; } }), true);
  assert.equal(lockedDuringCompare, null, 'no current file → nothing to compare');
  assert.equal(writeSnapshotGuarded(p, heights(101), { regressedBy: (c) => { lockedDuringCompare = existsSync(`${p}.lock`); return byHeight(101)(c); } }), true);
  assert.equal(lockedDuringCompare, true, 'the comparison runs while the lock is held');
  const before = readFileSync(p, 'utf8');
  assert.throws(() => writeSnapshotGuarded(p, heights(100), { regressedBy: byHeight(100) }), /newer snapshot \(block 101\)/);
  assert.equal(readFileSync(p, 'utf8'), before, 'a refused replacement leaves the newer file untouched');
  writeFileSync(p, '{ truncated');
  assert.throws(() => writeSnapshotGuarded(p, heights(200), { regressedBy: byHeight(200) }), /cannot be parsed/);
  assert.equal(existsSync(`${p}.lock`), false);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('census.json')), ['census.json'], 'no temp file survives');
});
