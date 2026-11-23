// Tests for contracts/script/rehearsal-gate.mjs (#3896; deploy rehearsal design §8, §18, §20 test 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, differences, main, MAX_AGE_HOURS, readPlan } from '../../../contracts/script/rehearsal-gate.mjs';
import { treeDigest } from '../../../contracts/script/rehearsal-tree.mjs';

const NOW = 1_800_000_000;
const H = (c) => c.repeat(64);
const present = {
  network: 'testnet',
  chain: 'base-sepolia',
  commit: 'c'.repeat(40),
  treeDigest: H('a'),
  inputDigest: H('b'),
  planDigest: H('d'),
  chains: ['base-sepolia', 'arb-sepolia'],
};
const green = {
  kind: 'vaipakam-deploy-rehearsal-verdict',
  version: 1,
  result: 'pass',
  failedStage: '',
  network: 'testnet',
  commit: present.commit,
  treeDigest: present.treeDigest,
  inputDigest: present.inputDigest,
  planDigest: present.planDigest,
  chains: ['arb-sepolia', 'base-sepolia'],
  forkTakenAt: NOW - 3600,
};

test('a green verdict of the same commit, tree, inputs, plan, network and chains, forked an hour ago, covers the deploy', () => {
  assert.deepEqual(differences(green, present, NOW), []);
});

test('test 10: the gate refuses on each of the five values, naming it', () => {
  for (const k of ['commit', 'treeDigest', 'inputDigest', 'planDigest']) {
    const d = differences({ ...green, [k]: k === 'commit' ? 'e'.repeat(40) : H('e') }, present, NOW);
    assert.equal(d.length, 1, k);
    assert.match(d[0], new RegExp(`^${k}: rehearsed`));
  }
  const d = differences({ ...green, chains: ['base-sepolia'] }, present, NOW);
  assert.equal(d.length, 1);
  assert.match(d[0], /^chain set: rehearsed base-sepolia, the plan names arb-sepolia base-sepolia/);
});

test('test 10: the gate refuses an old fork, a fork in the future, and no fork time', () => {
  assert.match(differences({ ...green, forkTakenAt: NOW - MAX_AGE_HOURS * 3600 }, present, NOW)[0], /hours old; a verdict is valid for 24 hours/);
  assert.deepEqual(differences({ ...green, forkTakenAt: NOW - MAX_AGE_HOURS * 3600 + 60 }, present, NOW), []);
  assert.match(differences({ ...green, forkTakenAt: NOW + 3600 }, present, NOW)[0], /in the future/);
  assert.match(differences({ ...green, forkTakenAt: null }, present, NOW)[0], /no fork time/);
});

test("the verdict's own maxAgeHours is not read: the figure is the design's", () => {
  assert.equal(differences({ ...green, maxAgeHours: 1000, forkTakenAt: NOW - 30 * 3600 }, present, NOW).length, 1);
});

test('a failed rehearsal, another network, or a chain outside the plan is refused', () => {
  assert.match(differences({ ...green, result: 'fail', failedStage: 'readback' }, present, NOW)[0], /did not pass \(result fail, at readback\)/);
  assert.match(differences({ ...green, network: 'mainnet' }, present, NOW)[0], /^network: rehearsed mainnet, deploying testnet/);
  assert.ok(differences(green, { ...present, chain: 'bnb-testnet' }, NOW).some((d) => /bnb-testnet is not in the plan's chain set/.test(d)));
  assert.deepEqual(differences({ kind: 'other' }, present, NOW), ['it is not a rehearsal verdict']);
});

test('the gate takes any covering verdict, and otherwise names what the newest one lacks', () => {
  const old = { path: 'a', verdict: { ...green, commit: 'f'.repeat(40) } };
  const ok = { path: 'b', verdict: green };
  assert.equal(decide([old, ok], present, NOW).verdict, ok);
  const r = decide([old], present, NOW);
  assert.equal(r.ok, false);
  assert.match(r.diffs[0], /^commit: rehearsed f+/);
  assert.deepEqual(decide([], present, NOW).diffs, ['no rehearsal verdict was found']);
});

test('test 10: the override passes only with a reason, and keeps what was not covered', () => {
  for (const bad of ['', '   ', '!!', 'x']) {
    const r = decide([], present, NOW, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.badOverride, true);
  }
  const r = decide([], present, NOW, '  incident fix: forks unavailable  ');
  assert.equal(r.ok, true);
  assert.equal(r.override, 'incident fix: forks unavailable');
  assert.deepEqual(r.diffs, ['no rehearsal verdict was found']);
});

test('readPlan reads the digest, the chain set and the desired line', () => {
  const text = `# desired deployments/testnets.desired.json sha256 ${H('1')}\n# generated\nchains base-sepolia arb-sepolia\nstep base-sepolia preflight\n`;
  const p = readPlan(text);
  assert.equal(p.planDigest, createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(p.chains, ['base-sepolia', 'arb-sepolia']);
  assert.deepEqual(p.desired, { path: 'deployments/testnets.desired.json', sha256: H('1') });
});

// End to end over the real tree: a verdict written as the driver writes it.
function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'rehearsal-gate-'));
  const desired = join(dir, 'desired.json');
  writeFileSync(desired, '{"network":"testnet"}\n');
  const dsha = createHash('sha256').update('{"network":"testnet"}\n').digest('hex');
  const plan = join(dir, 'plan');
  const planText = `# desired ${desired} sha256 ${dsha}\nchains base-sepolia arb-sepolia\nstep base-sepolia contracts --confirm-i-have-multisig-ready --fresh\n`;
  writeFileSync(plan, planText);
  const { commit, digest } = treeDigest();
  const verdicts = join(dir, 'runs');
  mkdirSync(join(verdicts, 'r1'), { recursive: true });
  const verdict = { ...green, commit, treeDigest: digest, planDigest: createHash('sha256').update(planText).digest('hex') };
  writeFileSync(join(verdicts, 'r1', 'verdict.json'), JSON.stringify(verdict));
  const args = ['check', '--network', 'testnet', '--chain', 'base-sepolia', '--plan', plan, '--input-digest', present.inputDigest, '--verdicts', verdicts, '--now', String(NOW)];
  return { dir, desired, plan, verdicts, args };
}

function capture(fn) {
  const out = [];
  const err = [];
  const o = console.log;
  const e = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    return { code: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = o;
    console.error = e;
  }
}

test('main accepts a covering verdict and prints its record', () => {
  const s = scene();
  try {
    const r = capture(() => main(s.args));
    assert.equal(r.code, 0, r.err);
    const rec = JSON.parse(r.out);
    assert.equal(rec.gate, 'passed');
    assert.match(rec.verdictSha256, /^[0-9a-f]{64}$/);
    assert.equal(rec.forkTakenAt, NOW - 3600);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('main refuses other inputs, says the verdict is a local file, and points at the override', () => {
  const s = scene();
  try {
    const args = [...s.args];
    args[args.indexOf('--input-digest') + 1] = H('9');
    const r = capture(() => main(args));
    assert.equal(r.code, 1);
    assert.match(r.err, /inputDigest: rehearsed b+, now 9+/);
    assert.match(r.err, /local file/);
    assert.match(r.err, /--without-rehearsal/);
    assert.equal(r.out, '');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('main refuses a desired-state file changed after the plan, and a missing plan', () => {
  const s = scene();
  try {
    writeFileSync(s.desired, '{"network":"testnet","x":1}\n');
    const r = capture(() => main(s.args));
    assert.equal(r.code, 1);
    assert.match(r.err, /changed since the plan was made/);
    const noPlan = s.args.filter((a, i) => a !== '--plan' && s.args[i - 1] !== '--plan');
    const r2 = capture(() => main(noPlan));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /no plan was named/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('main records an override with its reason and what it did not cover', () => {
  const s = scene();
  try {
    const noPlan = s.args.filter((a, i) => a !== '--plan' && s.args[i - 1] !== '--plan');
    const r = capture(() => main([...noPlan, '--without-rehearsal', 'incident fix, forks unavailable']));
    assert.equal(r.code, 0, r.err);
    const rec = JSON.parse(r.out);
    assert.equal(rec.gate, 'overridden');
    assert.equal(rec.reason, 'incident fix, forks unavailable');
    assert.match(rec.notCovered[0], /no plan was named/);
    const r2 = capture(() => main([...noPlan, '--without-rehearsal', '']));
    assert.equal(r2.code, 1);
    assert.match(r2.err, /needs a reason in words/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
