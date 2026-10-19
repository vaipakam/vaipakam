// entry-point.test.mjs — #2443: the sanctions scripts run when started
// through a link, even one repointed while they load, and not when imported.
// The services are started through /opt/vaipakam-sanctions/current, a link
// the installer repoints; a guard comparing paths skipped every run there and
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
const PACKAGE = join(HERE, '..');

test('the entry point is what Node reports', () => {
  assert.equal(isEntryPoint({ main: true }), true);
  assert.equal(isEntryPoint({ main: false }), false);
});

// A Node before 22.18 sets no import.meta.main. Importing must still work;
// anything that looks like a start must be an error, never a quiet false.
test('on a Node without import.meta.main, an import answers false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-point-old-node-'));
  const script = join(dir, 'sanctions-adder.mjs');
  writeFileSync(script, '');
  const meta = { url: pathToFileURL(script).href };
  writeFileSync(join(dir, 'importer.mjs'), '');
  assert.equal(isEntryPoint(meta, join(dir, 'importer.mjs')), false);
  assert.equal(isEntryPoint(meta, undefined), false, 'node -e, or an embedder, names no script');
});

test('on a Node without import.meta.main, anything that looks like a start throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-point-old-node-'));
  mkdirSync(join(dir, 'release'));
  mkdirSync(join(dir, 'elsewhere'));
  const script = join(dir, 'release', 'sanctions-adder.mjs');
  writeFileSync(script, '');
  const meta = { url: pathToFileURL(script).href };
  const expected = /run it with Node 22\.18 or newer/;
  // By its real path, and through a link to its directory.
  symlinkSync(join(dir, 'release'), join(dir, 'current'));
  assert.throws(() => isEntryPoint(meta, script), expected);
  assert.throws(() => isEntryPoint(meta, join(dir, 'current', 'sanctions-adder.mjs')), expected);
  // Through a link to the file under another name.
  symlinkSync(script, join(dir, 'adder'));
  assert.throws(() => isEntryPoint(meta, join(dir, 'adder')), expected);
  // Through a directory link repointed after Node resolved it.
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'repointed'));
  assert.throws(() => isEntryPoint(meta, join(dir, 'repointed', 'sanctions-adder.mjs')), expected);
});

/** A fresh directory with `current`, a link to this package, as the units have. */
function release() {
  const dir = mkdtempSync(join(tmpdir(), 'entry-point-release-'));
  symlinkSync(PACKAGE, join(dir, 'current'));
  return dir;
}

// The real scripts, started the way their units start them: through a link to
// the release, with an empty environment. Each must reach its main and say so.
const SCRIPTS = [
  ['sanctions-adder.mjs', ['--check'], /^sanctions-adder: release ok /m],
  ['sanctions-delister.mjs', ['--check'], /^sanctions-delister: release ok /m],
  ['ofac-sanctions-diff.mjs', ['--help'], /OFAC SDN → `SanctionsList` DIFF TOOL/],
];

for (const [script, args, expected] of SCRIPTS) {
  test(`${script} ${args.join(' ')} runs when started through a link`, () => {
    const dir = release();
    const r = spawnSync(process.execPath, [join(dir, 'current', 'scripts', script), ...args], { encoding: 'utf8', env: {} });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, expected);
  });
}

// The installer repointing `current` while a run is still loading its modules
// must not stop that run: the link is moved to an empty directory as soon as
// the script, already resolved, asks for its first dependency.
for (const [script, args, expected] of SCRIPTS) {
  test(`${script} ${args.join(' ')} runs when its link is repointed while it loads`, () => {
    const dir = release();
    mkdirSync(join(dir, 'elsewhere'));
    const hooks = join(dir, 'hooks.mjs');
    writeFileSync(hooks, `
      import { renameSync, symlinkSync } from 'node:fs';
      let moved = false;
      export async function resolve(specifier, context, next) {
        if (!moved && specifier === 'viem') {
          moved = true;
          symlinkSync(${JSON.stringify(join(dir, 'elsewhere'))}, ${JSON.stringify(join(dir, 'current.new'))});
          renameSync(${JSON.stringify(join(dir, 'current.new'))}, ${JSON.stringify(join(dir, 'current'))});
        }
        return next(specifier, context);
      }
    `);
    const register = join(dir, 'register.mjs');
    writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, join(dir, 'current', 'scripts', script), ...args], { encoding: 'utf8', env: {} });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, expected);
  });
}

// Imported by another program, as the tests import them, none of them runs.
for (const [script, args] of SCRIPTS) {
  test(`${script} does not run when another script imports it`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry-point-import-'));
    const importer = join(dir, 'importer.mjs');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(join(HERE, script)).href)}); console.log('imported');`);
    const r = spawnSync(process.execPath, [importer, ...args], { encoding: 'utf8', env: {} });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'imported\n');
  });
}
