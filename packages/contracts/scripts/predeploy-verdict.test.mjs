// Tests for contracts/script/predeploy-verdict.mjs (#3896; deploy rehearsal design §18, hardening lesson 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContext, KIND, regressionPlan, main, verdictPath, whyNot } from '../../../contracts/script/predeploy-verdict.mjs';
import { treeDigest } from '../../../contracts/script/rehearsal-tree.mjs';

const H = (c) => c.repeat(64);
const TOOL = 'forge Version: 1.8.6-stable';
const CTX = { toolchain: TOOL, foundry: 'none' };
const FULL_CTX = { ...CTX, gasBudgetsBase: 'b'.repeat(40), regressionPlan: H('p') };
const pass = { kind: KIND, version: 1, result: 'pass', mode: 'default', commit: 'c'.repeat(40), treeDigest: H('a'), context: CTX };
const ctxFn = (c = CTX, f = FULL_CTX) => (mode) => (mode === 'full' ? f : c);

test('a passing verdict of the same tree, toolchain and mode covers the step', () => {
  assert.equal(whyNot(pass, { treeDigest: H('a'), mode: 'default', context: CTX }), '');
});

test('a full verdict covers a default step; a default verdict never covers a full one', () => {
  assert.equal(whyNot({ ...pass, mode: 'full', context: FULL_CTX }, { treeDigest: H('a'), mode: 'default', context: CTX }), '');
  assert.match(whyNot(pass, { treeDigest: H('a'), mode: 'full', context: FULL_CTX }), /needs the full check/);
});

test('another tree, another toolchain, no verdict or a failed one does not cover the step', () => {
  const present = { treeDigest: H('a'), mode: 'default', context: CTX };
  assert.match(whyNot({ ...pass, treeDigest: H('b') }, present), /another tree/);
  assert.match(whyNot({ ...pass, context: { ...CTX, toolchain: 'forge Version: 1.9.0' } }, present), /toolchain was forge Version: 1\.9\.0/);
  assert.match(whyNot({ ...pass, context: { ...CTX, foundry: 'FOUNDRY_PROFILE=quick' } }, present), /foundry was FOUNDRY_PROFILE=quick, now none/);
  assert.match(
    whyNot({ ...pass, mode: 'full', context: FULL_CTX }, { treeDigest: H('a'), mode: 'full', context: { ...FULL_CTX, gasBudgetsBase: 'd'.repeat(40) } }),
    /gasBudgetsBase was b+, now d+/,
  );
  assert.match(whyNot({ ...pass, context: undefined }, present), /not recorded/);
  assert.match(whyNot(null, present), /no pre-deploy verdict/);
  assert.match(whyNot({ ...pass, result: 'fail' }, present), /not a passing/);
});

function quiet(fn) {
  const o = console.log;
  const e = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: fn(), out: out.join('\n') };
  } finally {
    console.log = o;
    console.error = e;
  }
}

test('the context reads every FOUNDRY_ setting, treats the default profile as none, and adds the gas base for the full check', () => {
  const opts = (env) => ({ env, tool: () => TOOL, gasBase: () => 'g'.repeat(40), plan: (e) => (e.FORK_URL_MAINNET ? H('f') : H('p')) });
  assert.deepEqual(checkContext('default', opts({ FOUNDRY_PROFILE: 'default', PATH: '/bin' })), CTX);
  assert.equal(checkContext('default', opts({ FOUNDRY_PROFILE: 'quick', FOUNDRY_FUZZ_RUNS: '5' })).foundry, 'FOUNDRY_FUZZ_RUNS=5 FOUNDRY_PROFILE=quick');
  assert.equal(checkContext('full', opts({})).gasBudgetsBase, 'g'.repeat(40));
  assert.equal(checkContext('default', opts({})).gasBudgetsBase, undefined);
  assert.notEqual(checkContext('full', opts({ FORK_URL_MAINNET: 'x' })).regressionPlan, checkContext('full', opts({})).regressionPlan);
});

test('the regression plan comes from run-regression.sh and changes when a fork RPC adds the fork suites', () => {
  const plain = regressionPlan({ ...process.env, FORK_URL_MAINNET: '', FORK_URL_BASE_SEPOLIA: '', FORK_URL_ARB_SEPOLIA: '' });
  assert.match(plain, /^[0-9a-f]{64}$/);
  const withFork = regressionPlan({ ...process.env, FORK_URL_MAINNET: 'http://127.0.0.1:1' });
  assert.notEqual(withFork, plain);
});

test('record then covers over the real tree; a stronger verdict is not replaced by a weaker one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  const context = ctxFn();
  try {
    const { digest } = treeDigest();
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context })).code, 1);
    assert.equal(quiet(() => main(['record', '--mode', 'full', '--start', digest, '--dir', dir], { context })).code, 0);
    const r = quiet(() => main(['covers', '--mode', 'full', '--dir', dir], { context }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`${digest}\\.json$`));
    quiet(() => main(['record', '--mode', 'default', '--start', digest, '--dir', dir], { context }));
    assert.equal(JSON.parse(readFileSync(verdictPath(dir, digest), 'utf8')).mode, 'full');
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context: ctxFn({ ...CTX, toolchain: 'forge Version: other' }) })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree that changed while the check ran records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    const r = quiet(() => main(['record', '--mode', 'default', '--start', H('9'), '--dir', dir], { context: ctxFn() }));
    assert.equal(r.code, 0);
    assert.match(r.out, /tree changed while the pre-deploy check ran/);
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context: ctxFn() })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable verdict file does not cover, and bad arguments are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    writeFileSync(verdictPath(dir, treeDigest().digest), 'not json');
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context: ctxFn() })).code, 1);
    assert.equal(quiet(() => main(['covers', '--mode', 'fast', '--dir', dir])).code, 2);
    assert.equal(quiet(() => main(['record', '--mode', 'default', '--dir', dir])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
