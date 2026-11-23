// Tests for contracts/script/predeploy-verdict.mjs (#3896; deploy rehearsal design §18, hardening lesson 10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIND, main, verdictPath, whyNot } from '../../../contracts/script/predeploy-verdict.mjs';
import { treeDigest } from '../../../contracts/script/rehearsal-tree.mjs';

const H = (c) => c.repeat(64);
const TOOL = 'forge Version: 1.8.6-stable';
const pass = { kind: KIND, version: 1, result: 'pass', mode: 'default', commit: 'c'.repeat(40), treeDigest: H('a'), toolchain: TOOL };

test('a passing verdict of the same tree, toolchain and mode covers the step', () => {
  assert.equal(whyNot(pass, { treeDigest: H('a'), toolchain: TOOL, mode: 'default' }), '');
});

test('a full verdict covers a default step; a default verdict never covers a full one', () => {
  assert.equal(whyNot({ ...pass, mode: 'full' }, { treeDigest: H('a'), toolchain: TOOL, mode: 'default' }), '');
  assert.match(whyNot(pass, { treeDigest: H('a'), toolchain: TOOL, mode: 'full' }), /needs the full check/);
});

test('another tree, another toolchain, no verdict or a failed one does not cover the step', () => {
  const present = { treeDigest: H('a'), toolchain: TOOL, mode: 'default' };
  assert.match(whyNot({ ...pass, treeDigest: H('b') }, present), /another tree/);
  assert.match(whyNot({ ...pass, toolchain: 'forge Version: 1.9.0' }, present), /reached with forge Version: 1\.9\.0/);
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

test('record then covers over the real tree; a stronger verdict is not replaced by a weaker one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  const tool = () => TOOL;
  try {
    const { digest } = treeDigest();
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { tool })).code, 1);
    assert.equal(quiet(() => main(['record', '--mode', 'full', '--start', digest, '--toolchain', TOOL, '--dir', dir], { tool })).code, 0);
    const r = quiet(() => main(['covers', '--mode', 'full', '--dir', dir], { tool }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`${digest}\\.json$`));
    quiet(() => main(['record', '--mode', 'default', '--start', digest, '--toolchain', TOOL, '--dir', dir], { tool }));
    assert.equal(JSON.parse(readFileSync(verdictPath(dir, digest), 'utf8')).mode, 'full');
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { tool: () => 'forge Version: other' })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree that changed while the check ran records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    const r = quiet(() => main(['record', '--mode', 'default', '--start', H('9'), '--toolchain', TOOL, '--dir', dir], { tool: () => TOOL }));
    assert.equal(r.code, 0);
    assert.match(r.out, /tree changed while the pre-deploy check ran/);
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { tool: () => TOOL })).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable verdict file does not cover, and bad arguments are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'predeploy-verdict-'));
  try {
    writeFileSync(verdictPath(dir, treeDigest().digest), 'not json');
    assert.equal(quiet(() => main(['covers', '--mode', 'default', '--dir', dir], { tool: () => TOOL })).code, 1);
    assert.equal(quiet(() => main(['covers', '--mode', 'fast', '--dir', dir])).code, 2);
    assert.equal(quiet(() => main(['record', '--mode', 'default', '--dir', dir])).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
