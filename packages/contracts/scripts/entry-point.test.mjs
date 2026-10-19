// entry-point.test.mjs — #2443: a script started through a link still runs.
// The sanctions services are started through /opt/vaipakam-sanctions/current,
// a link; with the paths compared as written, every run skipped its main and
// exited 0 having done nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A fresh directory holding `real/script.mjs` and `link`, a link to `real`. */
function linkedScript() {
  const dir = mkdtempSync(join(tmpdir(), 'entry-point-'));
  const real = join(dir, 'real');
  mkdirSync(real);
  const script = join(real, 'script.mjs');
  writeFileSync(script, '');
  symlinkSync(real, join(dir, 'link'));
  return { script, viaLink: join(dir, 'link', 'script.mjs'), dir };
}

test('the module is the entry point when started by its real path', () => {
  const { script } = linkedScript();
  assert.equal(isEntryPoint(pathToFileURL(script).href, script), true);
});

test('the module is the entry point when started through a link', () => {
  const { script, viaLink } = linkedScript();
  // Node's default: import.meta.url is the link's target, argv[1] the link.
  assert.equal(isEntryPoint(pathToFileURL(script).href, viaLink), true);
  // Under --preserve-symlinks-main, import.meta.url keeps the link path.
  assert.equal(isEntryPoint(pathToFileURL(viaLink).href, viaLink), true);
});

test('another script, no script, or a missing file is not the entry point', () => {
  const { script, dir } = linkedScript();
  const other = join(dir, 'other.mjs');
  writeFileSync(other, '');
  assert.equal(isEntryPoint(pathToFileURL(script).href, other), false);
  assert.equal(isEntryPoint(pathToFileURL(script).href, undefined), false);
  assert.equal(isEntryPoint(pathToFileURL(script).href, join(dir, 'missing.mjs')), false);
});

// The real scripts, started the way their units start them: through a link to
// the release, with an empty environment. Each must reach its main and say so.
for (const [script, args, expected] of [
  ['sanctions-adder.mjs', ['--check'], /^sanctions-adder: release ok /m],
  ['sanctions-delister.mjs', ['--check'], /^sanctions-delister: release ok /m],
  ['ofac-sanctions-diff.mjs', ['--help'], /OFAC SDN → `SanctionsList` DIFF TOOL/],
]) {
  test(`${script} ${args.join(' ')} runs when started through a link`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry-point-release-'));
    symlinkSync(join(HERE, '..'), join(dir, 'current'));
    const r = spawnSync(process.execPath, [join(dir, 'current', 'scripts', script), ...args], { encoding: 'utf8', env: {} });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, expected);
  });
}
