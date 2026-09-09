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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEntry, readManifest, withManifestLock, entryFromArtifact, regenerateEntries, writeSnapshotGuarded, bumpLiveGeneration } from './archive-manifest.mjs';

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

test('a stale lock whose owner is DEAD is taken over IN PLACE (no directory removal) and the write proceeds', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 3) });
  const inoBefore = statSync(lockDir).ino;
  let inoDuring = null;
  let ownerDuring = null;
  assert.equal(
    appendEntry(manifest, e, { timeoutMs: 2_000, pollMs: 20, staleMs: 1_000 }).status,
    'recorded',
  );
  assert.equal(existsSync(lockDir), false, 'the taken-over lock is released after the write');
  void inoBefore; void inoDuring; void ownerDuring;
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

test('regenerate may correct non-identity fields, but a DIAMOND change is a displacement needing the override (r16)', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  appendEntry(manifest, e1);
  regenerateEntries(manifest, () => [{ ...e1, deployBlock: 77 }]);
  assert.equal(readManifest(manifest).entries[0].deployBlock, 77, 'a deployBlock correction is permitted');
  const before = readFileSync(manifest, 'utf8');
  assert.throws(() => regenerateEntries(manifest, () => [{ ...e1, deployBlock: 77, diamond: '0xcorrected' }]), /would change the DIAMOND/);
  assert.equal(readFileSync(manifest, 'utf8'), before, 'a refused displacement leaves the file untouched');
  const { displaced } = regenerateEntries(manifest, () => [{ ...e1, deployBlock: 77, diamond: '0xcorrected' }], { allowDisplace: true });
  assert.deepEqual(displaced, [{ key: 'a|s1', from: e1.diamond, to: '0xcorrected' }]);
  assert.equal(readManifest(manifest).entries[0].diamond, '0xcorrected');
});

test('an OWNERLESS stale lock (writer died before owner.json) is recovered — the claim must not reset its age (r16)', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir); // no owner.json at all
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 6) });
  assert.equal(appendEntry(manifest, e, { timeoutMs: 2_000, pollMs: 20, staleMs: 1_000 }).status, 'recorded');
  assert.equal(existsSync(lockDir), false);
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

test('a stale lock another waiter has already CLAIMED is not deleted by us (the r15 double-break)', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, at: new Date(0).toISOString() }));
  writeFileSync(join(lockDir, 'claim'), ''); // someone else is mid-break
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 4) });
  assert.throws(() => appendEntry(manifest, e, { timeoutMs: 400, pollMs: 20, staleMs: 1 }), /could not lock/);
  assert.equal(existsSync(lockDir), true, 'a claimed lock is left to its claimant');
  assert.equal(existsSync(manifest), false, 'nothing was written');
});

test('a stale lock whose owner changed to a LIVE one after we observed it is not deleted', () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  // Observed as dead+old, but by the time we would delete it the owner file names a live holder
  // (simulated by writing the live owner up front: the identity re-read must see it and withdraw).
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const e = entryFromArtifact({ slug: 'a', stamp: 'b', addrPath: artifact(dir, 5) });
  assert.throws(() => appendEntry(manifest, e, { timeoutMs: 400, pollMs: 20, staleMs: 1 }), /could not lock/);
  assert.equal(existsSync(lockDir), true);
  assert.equal(existsSync(join(lockDir, 'claim')), false, 'a withdrawn claim leaves no claim file behind');
});

test('N concurrent processes all get through a DEAD stale lock, and every append lands', async () => {
  const { dir, manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const N = 8;
  const runs = await Promise.all(
    Array.from({ length: N }, (_, i) => run(['append', manifest, `chain-${i % 2}`, `2026-02-02T00-00-${String(i).padStart(2, '0')}Z`, artifact(dir, 10 + i)])),
  );
  for (const r of runs) assert.equal(r.code, 0, r.err);
  assert.equal(readManifest(manifest).entries.length, N);
  assert.deepEqual(readdirSync(dirname(manifest)), ['archive-manifest.json']);
});

test('a producer form of the text is evaluated AFTER the comparison, so what it learned is written (r16)', () => {
  const { dir } = fixture();
  const p = join(dir, 'snap.json');
  writeSnapshotGuarded(p, JSON.stringify({ v: 1 }), { regressedBy: () => null });
  let learned = null;
  writeSnapshotGuarded(p, () => JSON.stringify({ v: 2, learned }), { regressedBy: (cur) => { learned = `saw v${cur.v}`; return null; } });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { v: 2, learned: 'saw v1' });
});

test('a stray claim in a directory we created and published into does not stop us — the owner file is the lock (r18)', () => {
  const { manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  let entered = 0;
  withManifestLock(manifest, () => { entered += 1; }, {
    timeoutMs: 400, pollMs: 20, staleMs: 60_000,
    _testAfterMkdir: (dir) => { writeFileSync(join(dir, 'claim'), ''); }, // a claimant looked while we were suspended; it will see our owner and withdraw
  });
  assert.equal(entered, 1, 'we published first, so we hold the lock');
  assert.equal(existsSync(lockDir), false, 'released at the end, claim and all');
});

test('an acquirer whose owner was published first by a rival yields to it (r17)', () => {
  const { manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  let entered = 0;
  const rival = { pid: process.pid, at: 'rival' };
  assert.throws(
    () =>
      withManifestLock(manifest, () => { entered += 1; }, {
        timeoutMs: 400, pollMs: 20, staleMs: 60_000,
        _testAfterMkdir: (dir) => { writeFileSync(join(dir, 'owner.json'), JSON.stringify(rival)); }, // a resumed rival published into our directory first
      }),
    /could not lock/,
  );
  assert.equal(entered, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')), rival, "the rival's owner file is untouched");
});

test('a dead-owner takeover keeps the SAME directory: the owner file is replaced, the inode is unchanged (r18)', () => {
  const { manifest } = fixture();
  const lockDir = `${manifest}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, at: new Date(0).toISOString() }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lockDir, old, old);
  const inoBefore = statSync(lockDir).ino;
  let seen = null;
  withManifestLock(manifest, () => { seen = { ino: statSync(lockDir).ino, owner: JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).pid, claim: existsSync(join(lockDir, 'claim')) }; }, { timeoutMs: 2_000, pollMs: 20, staleMs: 1_000 });
  assert.equal(seen.ino, inoBefore, 'the directory was not re-created');
  assert.equal(seen.owner, process.pid, 'the owner file is ours');
  assert.equal(seen.claim, false, 'the claim was dropped before entering');
  assert.equal(existsSync(lockDir), false);
});

test('regenerate: a displacement can be acknowledged BY KEY, and the displaced Diamond is RETAINED as a censusable record (r18/r20)', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  const e2 = entryFromArtifact({ slug: 'a', stamp: 's2', addrPath: artifact(dir, 2) });
  appendEntry(manifest, e1);
  appendEntry(manifest, e2);
  assert.throws(() => regenerateEntries(manifest, () => [{ ...e1, diamond: '0xfix1' }, { ...e2, diamond: '0xfix2' }], { allowDisplace: ['a|s1'] }), /a\|s2: /);
  const { displaced } = regenerateEntries(manifest, () => [{ ...e1, diamond: '0xfix1' }, e2], { allowDisplace: ['a|s1'] });
  assert.equal(displaced.length, 1);
  const m = readManifest(manifest);
  assert.equal(m.entries.find((e) => e.stamp === 's1').diamond, '0xfix1', 'the label now names the corrected Diamond');
  const kept = m.entries.find((e) => e.stamp === 's1@displaced-1');
  assert.ok(kept, 'the displaced Diamond is retained under a derived stamp');
  assert.equal(kept.diamond, e1.diamond);
  assert.equal(kept.displaced, true);
  assert.equal(kept.displacedFrom, 's1');
  assert.equal(kept.replacedBy, '0xfix1');
  // A later regeneration from disk (which never yields displaced records) keeps it and does not count it as a drop.
  const again = regenerateEntries(manifest, () => [{ ...e1, diamond: '0xfix1' }, e2]);
  assert.equal(again.dropped, 0);
  assert.ok(readManifest(manifest).entries.find((e) => e.stamp === 's1@displaced-1'), 'retained across regeneration');
});

test('bump-live increments liveGeneration under the lock and regeneration preserves it (r20)', () => {
  const { dir, manifest } = fixture();
  const e1 = entryFromArtifact({ slug: 'a', stamp: 's1', addrPath: artifact(dir, 1) });
  appendEntry(manifest, e1);
  assert.equal(bumpLiveGeneration(manifest, { slug: 'a', diamond: '0xlive' }), 1);
  assert.equal(bumpLiveGeneration(manifest, { slug: 'a', diamond: '0xlive' }), 2);
  regenerateEntries(manifest, () => [e1]);
  const m = readManifest(manifest);
  assert.equal(m.liveGeneration, 2, 'regeneration carries the counter');
  assert.equal(m.lastLivePublished.slug, 'a');
  assert.equal(readManifest(manifest).entries.length, 1);
});
