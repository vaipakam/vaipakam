// Tests for contracts/script/rehearsal-tree.mjs (#3891, deploy rehearsal design §13, §18, §20 test 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, readLeftOut, snapshot, treeDigest, validateLeftOut } from '../../../contracts/script/rehearsal-tree.mjs';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'rehearsal-tree-'));
  const put = (p, c = 'x') => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  put('contracts/deployments/base-sepolia/addresses.json', '{}');
  put('contracts/deployments/base-sepolia/.markers/contracts.done', '1');
  put('contracts/deployments/base-sepolia/.history/x.json', '{}');
  put('contracts/deployments/base-sepolia/.archive/2026/addresses.json', '{}');
  put('contracts/deployments/base-sepolia/carry-forward.json', '{}');
  put('contracts/broadcast/DeployDiamond.s.sol/84532/run-latest.json', '{}');
  put('contracts/cache/solidity-files-cache.json', '{}');
  put('contracts/deployments/.forge-test/rehearsal/r1/base-sepolia/addresses.json', '{}');
  put('apps/app/node_modules/x/index.js');
  return { root, put };
}
const SCRATCH = 'contracts/deployments/.forge-test/rehearsal/r1';

test('a write inside the scratch folder is not a difference', () => {
  const { root, put } = tree();
  const before = snapshot(root, ['.git', SCRATCH], ['node_modules']);
  put(`${SCRATCH}/base-sepolia/addresses.json`, '{"diamond":"0x1"}');
  put('apps/app/node_modules/y.js');
  assert.deepEqual(compare(before, snapshot(root, ['.git', SCRATCH], ['node_modules'])), []);
  rmSync(root, { recursive: true });
});

test('test 6: every write outside the scratch folder fails the run', () => {
  const cases = [
    'contracts/deployments/base-sepolia/addresses.json',
    'contracts/deployments/base-sepolia/.markers/contracts.done',
    'contracts/deployments/base-sepolia/.history/x.json',
    'contracts/deployments/base-sepolia/.archive/2026/addresses.json',
    'contracts/deployments/base-sepolia/carry-forward.json',
    'contracts/broadcast/DeployDiamond.s.sol/84532/run-latest.json',
    'contracts/cache/solidity-files-cache.json',
    'packages/contracts/src/deployments.json',
  ];
  for (const p of cases) {
    const { root, put } = tree();
    const before = snapshot(root, ['.git', SCRATCH], ['node_modules']);
    put(p, 'changed');
    const diff = compare(before, snapshot(root, ['.git', SCRATCH], ['node_modules']));
    assert.equal(diff.length, 1, p);
    assert.equal(diff[0].path, p);
    rmSync(root, { recursive: true });
  }
});

test('a removed file is a difference', () => {
  const { root } = tree();
  const before = snapshot(root, ['.git', SCRATCH]);
  rmSync(join(root, 'contracts/deployments/base-sepolia/carry-forward.json'));
  assert.deepEqual(compare(before, snapshot(root, ['.git', SCRATCH])), [
    { path: 'contracts/deployments/base-sepolia/carry-forward.json', change: 'removed' },
  ]);
  rmSync(root, { recursive: true });
});

test('test 6: the left-out list refuses deploy state and compiled output', () => {
  const r = 'a reason long enough to be a reason';
  for (const path of [
    'contracts/deployments',
    'contracts/deployments/base-sepolia/.markers',
    'contracts/broadcast',
    'contracts/cache',
    'contracts/out',
    'contracts',
    '../elsewhere',
  ]) {
    assert.ok(validateLeftOut([{ path, reason: r }]).length > 0, path);
  }
  for (const name of ['broadcast', 'cache', 'out', 'deployments']) {
    assert.ok(validateLeftOut([{ name, reason: r }]).length > 0, name);
  }
  assert.ok(validateLeftOut([{ path: 'graphify-out' }]).length > 0, 'no reason');
});

test('the committed left-out list is valid', () => {
  assert.deepEqual(validateLeftOut(readLeftOut()), []);
});

test('the tree digest is stable and names the commit', () => {
  const a = treeDigest();
  const b = treeDigest();
  assert.equal(a.digest, b.digest);
  assert.match(a.commit, /^[0-9a-f]{40}$/);
});

test('an untracked file changes the tree digest; an ignored one does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'rehearsal-tree-git-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(root, '.gitignore'), 'out/\n');
    writeFileSync(join(root, 'a.sol'), 'a');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    const base = treeDigest(root).digest;
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'out', 'b.json'), 'b');
    assert.equal(treeDigest(root).digest, base, 'an ignored file is not in the digest');
    writeFileSync(join(root, 'New.sol'), 'n');
    assert.notEqual(treeDigest(root).digest, base, 'an untracked source file is');
    mkdirSync(join(root, 'contracts', 'deployments'), { recursive: true });
    rmSync(join(root, 'New.sol'));
    writeFileSync(join(root, 'contracts', 'deployments', 'r.json'), 'r');
    assert.equal(treeDigest(root).digest, base, 'the deploy records are outside it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a change inside a submodule changes the tree digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'rehearsal-tree-sub-'));
  try {
    const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], { encoding: 'utf8' });
    const lib = join(root, 'lib-src');
    const top = join(root, 'top');
    mkdirSync(lib);
    mkdirSync(top);
    git(lib, 'init', '-q');
    writeFileSync(join(lib, 'L.sol'), 'v1');
    git(lib, 'add', '.');
    git(lib, 'commit', '-qm', 'lib');
    git(top, 'init', '-q');
    git(top, 'submodule', '-q', 'add', lib, 'lib/dep');
    git(top, 'commit', '-qm', 'top');
    const base = treeDigest(top).digest;
    writeFileSync(join(top, 'lib', 'dep', 'L.sol'), 'v2');
    const edited = treeDigest(top).digest;
    assert.notEqual(edited, base, 'an edit inside the submodule');
    git(join(top, 'lib', 'dep'), 'commit', '-qam', 'v2');
    assert.notEqual(treeDigest(top).digest, base, 'another submodule commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
