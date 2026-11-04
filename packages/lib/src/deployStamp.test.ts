import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEPLOY_TAG, deployStamp, deployStampArgs, wranglerEntry } from './deployStamp.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** A git stand-in answering `rev-parse` and `status` from fixed text. */
const fakeGit = (status: string | Error, head: string | Error = `${SHA}\n`) => (args: string[]) => {
  const answer = args[0] === 'rev-parse' ? head : status;
  if (answer instanceof Error) throw answer;
  return answer;
};

describe('deployStamp (#2242)', () => {
  it('stamps a clean working copy with its commit', () => {
    const s = deployStamp({ env: {}, git: fakeGit('') });
    expect(s).toEqual({ commit: SHA, dirty: false, tag: SHA.slice(0, 12), message: `built from ${SHA}` });
    expect(deployStampArgs(s)).toEqual(['--tag', SHA.slice(0, 12), '--message', `built from ${SHA}`]);
  });

  it('marks a working copy with uncommitted changes dirty, in the tag and in words', () => {
    const s = deployStamp({ env: {}, git: fakeGit(' M apps/app/src/x.ts\n') });
    expect(s).toMatchObject({ dirty: true, tag: `${SHA.slice(0, 12)}-dirty` });
    expect('message' in s && s.message).toMatch(/plus uncommitted changes/);
  });

  it('stamps a tree git cannot inspect as dirty, never as clean', () => {
    expect(deployStamp({ env: {}, git: fakeGit(new Error('no')) })).toMatchObject({ dirty: true });
  });

  it('takes the commit Workers Builds names, without asking git about the tree', () => {
    const s = deployStamp({ env: { WORKERS_CI_COMMIT_SHA: SHA.toUpperCase() }, git: fakeGit(' M built-output\n', new Error('no git')) });
    expect(s).toMatchObject({ commit: SHA, dirty: false });
  });

  it('records nothing, with the reason, when no commit can be named', () => {
    const s = deployStamp({ env: {}, git: fakeGit('', new Error('not a git repository')) });
    expect(s).toHaveProperty('reason');
    expect(deployStampArgs(s)).toEqual([]);
    expect(deployStamp({ env: { WORKERS_CI_COMMIT_SHA: 'abc' }, git: fakeGit('') })).toHaveProperty('reason');
  });

  it('writes only tags the deploy-lag check reads back', () => {
    for (const status of ['', ' M x\n']) {
      const s = deployStamp({ env: {}, git: fakeGit(status) });
      expect('tag' in s && DEPLOY_TAG.test(s.tag)).toBe(true);
    }
  });
});

describe('wranglerEntry', () => {
  /** A package dir whose node_modules/wrangler carries the given manifest. */
  const pkgWith = (manifest: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-entry-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"probe"}');
    const w = join(dir, 'node_modules', 'wrangler');
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'wrangler', ...manifest }));
    return { dir, w };
  };

  it('finds the entry through bin even when exports hides the bin subpath', () => {
    // The shape wrangler 4.114 ships: no "./bin/wrangler.js" in exports.
    const { dir, w } = pkgWith({
      exports: { '.': './wrangler-dist/cli.js', './package.json': './package.json' },
      bin: { wrangler: './bin/wrangler.js', wrangler2: './bin/wrangler.js' },
    });
    expect(wranglerEntry(dir)).toBe(join(w, 'bin', 'wrangler.js'));
  });

  it('accepts a string bin', () => {
    const { dir, w } = pkgWith({ bin: './bin/wrangler.js' });
    expect(wranglerEntry(dir)).toBe(join(w, 'bin', 'wrangler.js'));
  });

  it('refuses a wrangler that declares no wrangler bin', () => {
    const { dir } = pkgWith({ bin: { other: './x.js' } });
    expect(() => wranglerEntry(dir)).toThrow(/declares no "wrangler" bin/);
  });
});
