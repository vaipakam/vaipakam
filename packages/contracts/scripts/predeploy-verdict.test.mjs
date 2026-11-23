// Tests for contracts/script/predeploy-verdict.mjs (#3896; deploy rehearsal design §18, hardening lesson 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContext, contextDigest, KIND, main, verdictPath, whyNot } from '../../../contracts/script/predeploy-verdict.mjs';
import { treeDigest } from '../../../contracts/script/rehearsal-tree.mjs';

const H = (c) => c.repeat(64);
const TOOL = 'forge Version: 1.8.6-stable';
const CTX = { toolchain: TOOL, forgeConfig: 'cfg', foundry: 'none' };

const pass = { kind: KIND, version: 1, result: 'pass', mode: 'default', commit: 'c'.repeat(40), treeDigest: H('a'), context: CTX };
const ctxFn = (c = CTX) => () => c;

test('a passing verdict of the same tree, toolchain and mode covers the step', () => {
  assert.equal(whyNot(pass, { treeDigest: H('a'), mode: 'default', context: CTX }), '');
});

test('a full verdict covers a default step; no verdict ever covers a full step', () => {
  assert.equal(whyNot({ ...pass, mode: 'full' }, { treeDigest: H('a'), mode: 'default', context: CTX }), '');
  assert.match(whyNot({ ...pass, mode: 'full' }, { treeDigest: H('a'), mode: 'full', context: CTX }), /full check is never reused/);
});

test('another tree, another toolchain, no verdict or a failed one does not cover the step', () => {
  const present = { treeDigest: H('a'), mode: 'default', context: CTX };
  assert.match(whyNot({ ...pass, treeDigest: H('b') }, present), /another tree/);
  assert.match(whyNot({ ...pass, context: { ...CTX, toolchain: 'forge Version: 1.9.0' } }, present), /toolchain was forge Version: 1\.9\.0/);
  assert.match(whyNot({ ...pass, context: { ...CTX, foundry: 'FOUNDRY_PROFILE=quick' } }, present), /foundry was FOUNDRY_PROFILE=quick, now none/);
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

test('the context reads every FOUNDRY_ setting and treats the default profile as none', () => {
  const opts = (env) => ({ env, tool: () => TOOL, config: () => 'cfg' });
  assert.deepEqual(checkContext(opts({ FOUNDRY_PROFILE: 'default', PATH: '/bin' })), CTX);
  assert.equal(checkContext(opts({ FOUNDRY_PROFILE: 'quick', FOUNDRY_FUZZ_RUNS: '5' })).foundry, 'FOUNDRY_FUZZ_RUNS=5 FOUNDRY_PROFILE=quick');
});

test("forge's resolved configuration is part of the context", () => {
  assert.match(whyNot({ kind: KIND, result: 'pass', treeDigest: 'd', context: { ...CTX, forgeConfig: 'other' } }, { treeDigest: 'd', mode: 'default', context: CTX }), /forgeConfig was other, now cfg/);
});

test('record then covers over the real tree; a stronger verdict is not replaced by a weaker one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  const context = ctxFn();
  try {
    const { digest } = treeDigest();
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context })).code, 1);
    assert.equal(quiet(() => main(['record', '--mode', 'full', '--start', digest, '--start-context', contextDigest(CTX), '--dir', dir], { context })).code, 0);
    assert.equal(quiet(() => main(['covers', '--mode', 'full', '--dir', dir], { context })).code, 1, 'a full step always runs');
    const r = quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`${digest}\\.json$`));
    quiet(() => main(['record', '--mode', 'default', '--start', digest, '--start-context', contextDigest(CTX), '--dir', dir], { context }));
    assert.equal(JSON.parse(readFileSync(verdictPath(dir, digest), 'utf8')).mode, 'full');
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context: ctxFn({ ...CTX, toolchain: 'forge Version: other' }) })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree that changed while the check ran records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    const r = quiet(() => main(['record', '--mode', 'default', '--start', H('9'), '--start-context', contextDigest(CTX), '--dir', dir], { context: ctxFn() }));
    assert.equal(r.code, 0);
    assert.match(r.out, /tree changed while the pre-deploy check ran/);
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { context: ctxFn() })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a configuration that changed while the check ran records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    const startContext = contextDigest({ ...CTX, forgeConfig: 'quick-profile' });
    const r = quiet(() => main(['record', '--mode', 'default', '--start', treeDigest().digest, '--start-context', startContext, '--dir', dir], { context: ctxFn() }));
    assert.equal(r.code, 0);
    assert.match(r.out, /forge configuration changed while the pre-deploy check ran/);
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
