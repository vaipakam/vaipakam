/**
 * #2651 — the keeper machine builds a commit only when it can change what the
 * keeper runs. The running release records the files its bundle was made from
 * (build-inputs.mjs `record`), and the updater compares a newer commit against
 * them (`decide`). A wrong "skip" leaves the keeper on old code, so every
 * doubt is a build.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script, shipped in the deploy kit
import * as buildInputs from '../host/deploy/build-inputs.mjs';

const { decide, formatInputs, mustBuild, parseInputs, parseNameStatus, recordInputs, INPUTS_HEADER } = buildInputs as {
  decide: (repo: string, from: string, to: string, inputsFile: string) => string;
  formatInputs: (files: string[]) => string;
  mustBuild: (changes: { status: string; path: string }[], inputs: Set<string>) => { build: boolean; why?: string };
  parseInputs: (text: string) => Set<string> | undefined;
  parseNameStatus: (raw: string) => { status: string; path: string }[];
  recordInputs: (metafile: unknown, esbuildDir: string, repoRoot?: string) => string[];
  INPUTS_HEADER: string;
};

const INPUTS = new Set([
  'apps/keeper/src/watcher.ts',
  'apps/keeper/host/main.ts',
  'packages/contracts/src/abis/RiskFacet.json',
  'apps/indexer/scripts/lib/d1-workers.mjs',
]);
const verdict = (status: string, path: string) => mustBuild([{ status, path }], INPUTS);

describe('which changes can reach the bundle (#2651)', () => {
  it('builds for a recorded input, changed or deleted', () => {
    expect(verdict('M', 'apps/keeper/src/watcher.ts').build).toBe(true);
    expect(verdict('D', 'packages/contracts/src/abis/RiskFacet.json').build).toBe(true);
  });

  it('builds for anything in the deploy kit, a config file, or a root file other than Markdown', () => {
    expect(verdict('M', 'apps/keeper/host/deploy/vaipakam-keeper.service').build).toBe(true);
    expect(verdict('M', 'apps/keeper/host/deploy/keeper.env.example').build).toBe(true);
    for (const path of ['packages/lib/package.json', 'apps/app/package.json', 'apps/keeper/tsconfig.json', 'packages/x/tsconfig.base.json', 'apps/keeper/.npmrc', 'packages/contracts/.gitattributes']) {
      expect(verdict('M', path).build, path).toBe(true);
    }
    for (const path of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.gitattributes']) {
      expect(verdict('M', path).build, path).toBe(true);
    }
    expect(verdict('M', 'CLAUDE.md').build).toBe(false);
  });

  it('builds for a new module file next to an input, or one directory below one', () => {
    expect(verdict('A', 'apps/keeper/src/newPass.ts').build).toBe(true);
    expect(verdict('A', 'apps/keeper/src/watcher/index.ts').build).toBe(true);
    expect(verdict('A', 'packages/contracts/src/abis/NewFacet.json').build).toBe(true);
  });

  it('skips what the build never read and cannot come to read', () => {
    for (const [status, path] of [
      ['M', 'apps/app/src/pages/Dashboard.tsx'],
      ['A', 'apps/indexer/migrations/0070_x.sql'],
      ['M', 'apps/indexer/src/chainIndexer.ts'],
      ['M', 'apps/keeper/README.md'],
      ['A', 'apps/keeper/test/newPass.test.ts'],
      ['M', 'packages/contracts/src/abis/UnusedFacet.json'],
      ['D', 'packages/lib/src/unused.ts'],
      ['M', 'contracts/src/facets/RiskFacet.sol'],
      ['A', 'docs/ReleaseNotes/unreleased/2651-x.md'],
    ] as const) {
      expect(verdict(status, path).build, path).toBe(false);
    }
  });
});

describe('the recorded inputs (#2651)', () => {
  it('reads back exactly what it writes, and nothing else', () => {
    const files = ['apps/keeper/host/main.ts', 'packages/push/src/index.ts'];
    expect(parseInputs(formatInputs(files))).toEqual(new Set(files));
    for (const bad of [
      '',
      `${INPUTS_HEADER}\n`,
      'apps/keeper/host/main.ts\n',
      `${INPUTS_HEADER}\napps/keeper/host/main.ts`,
      `${INPUTS_HEADER}\n../etc/passwd\n`,
      `${INPUTS_HEADER}\n/etc/passwd\n`,
      `${INPUTS_HEADER}\napps/keeper/../../x\n`,
      `${INPUTS_HEADER}\napps/keeper//x.ts\n`,
      `${INPUTS_HEADER}\napps/keeper/x y.ts\n`,
      `# vaipakam keeper build inputs v2\napps/keeper/x.ts\n`,
    ]) {
      expect(parseInputs(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('parses git diff -z name-status output', () => {
    expect(parseNameStatus('M\0a/b.ts\0A\0c.md\0D\0d/e f.ts\0')).toEqual([
      { status: 'M', path: 'a/b.ts' },
      { status: 'A', path: 'c.md' },
      { status: 'D', path: 'd/e f.ts' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
    expect(() => parseNameStatus('M\0')).toThrow();
  });
});

describe('recording and deciding against a real tree (#2651)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  it('records repository paths from the metafile and leaves node_modules out', () => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-inputs-'));
    write('apps/keeper/host/main.ts', '');
    write('packages/push/src/index.ts', '');
    const metafile = {
      inputs: {
        'host/main.ts': {},
        '../../packages/push/src/index.ts': {},
        '../../node_modules/.pnpm/viem@2/node_modules/viem/index.js': {},
      },
    };
    expect(recordInputs(metafile, 'apps/keeper', dir)).toEqual(['apps/keeper/host/main.ts', 'packages/push/src/index.ts']);
    expect(() => recordInputs({ inputs: { '../../../outside.ts': {} } }, 'apps/keeper', dir)).toThrow('outside the repository');
    expect(() => recordInputs({ inputs: { 'host/missing.ts': {} } }, 'apps/keeper', dir)).toThrow('not a file');
    expect(() => recordInputs({ inputs: {} }, 'apps/keeper', dir)).toThrow('names no build inputs');
  });

  it('skips a commit that changes only what was never read, and builds one that changes an input', () => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-decide-'));
    git('init', '-q');
    write('pnpm-lock.yaml', 'v1');
    write('apps/keeper/host/main.ts', 'one');
    write('apps/app/src/page.tsx', 'one');
    const base = commit('base');
    const lists = mkdtempSync(join(tmpdir(), 'keeper-lists-'));
    const list = join(lists, 'INPUTS');
    writeFileSync(list, formatInputs(['apps/keeper/host/main.ts']));

    write('apps/app/src/page.tsx', 'two');
    write('README.md', 'docs');
    const elsewhere = commit('elsewhere');
    expect(decide(dir, base, elsewhere, list)).toBe('skip');

    write('apps/keeper/host/main.ts', 'two');
    const keeper = commit('keeper');
    expect(decide(dir, base, keeper, list)).toBe('build: apps/keeper/host/main.ts, a build input, changed');
    expect(decide(dir, elsewhere, keeper, list)).toMatch(/^build: /);

    // Anything it cannot read is a build.
    expect(decide(dir, base, elsewhere, join(lists, 'missing'))).toMatch(/^build: /);
    writeFileSync(join(lists, 'BAD'), 'apps/keeper/host/main.ts\n');
    expect(decide(dir, base, elsewhere, join(lists, 'BAD'))).toMatch(/^build: /);
    expect(decide(dir, base, 'f'.repeat(40), list)).toMatch(/^build: could not compare/);
    expect(decide(dir, base.slice(0, 7), elsewhere, list)).toMatch(/^build: /);
    rmSync(lists, { recursive: true, force: true });
  });
});

describe('the real keeper bundle (#2651)', () => {
  it('records every input it reads inside the repository', () => {
    const keeperDir = join(dirname(new URL(import.meta.url).pathname), '..');
    execFileSync('pnpm', ['run', '--silent', 'build:host'], { cwd: keeperDir, stdio: 'ignore' });
    const repoRoot = join(keeperDir, '..', '..');
    const metafile = JSON.parse(readFileSync(join(keeperDir, 'dist', 'keeper-host.meta.json'), 'utf8'));
    const files = recordInputs(metafile, 'apps/keeper', repoRoot);
    expect(files).toContain('apps/keeper/host/main.ts');
    expect(files.some((f) => f.startsWith('packages/contracts/'))).toBe(true);
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
    expect(parseInputs(formatInputs(files))).toEqual(new Set(files));
  }, 60_000);
});
