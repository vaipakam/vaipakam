/**
 * #2651 — the keeper machine builds a commit only when the source a build of
 * it would be given differs from the running release's. `build-source.sh`
 * exports exactly the paths `build-paths` lists (the build sees nothing
 * else) and digests that export, so the comparison is of the build's input
 * itself rather than a prediction of which changes could matter to it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const keeperDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(keeperDir, '..', '..');
const script = join(keeperDir, 'host', 'deploy', 'build-source.sh');
const KIT_PATHS = 'apps/keeper/host/deploy/build-paths';

function listedPaths(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

describe('build-source.sh against a real repository (#2651)', () => {
  let dir = '';
  let scratch = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-source-'));
    scratch = mkdtempSync(join(tmpdir(), 'keeper-scratch-'));
    git('init', '-q');
    write(KIT_PATHS, '# what the build is given\npackage.json\napps/keeper\n');
    write('package.json', '{}\n');
    write('apps/keeper/src/main.ts', 'one\n');
    write('apps/app/src/page.tsx', 'one\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function git(...args: string[]) {
    return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  }
  function write(path: string, text: string) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  function commit(message: string) {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  function run(command: string, commit: string, out: string) {
    return spawnSync('bash', [script, command, dir, commit, out], { encoding: 'utf8' });
  }
  function digest(commit: string) {
    const result = run('digest', commit, join(scratch, 'digest'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    return result.stdout.trim();
  }

  it('gives the same digest to a commit that changes only paths the build is not given', () => {
    const base = commit('base');
    write('apps/app/src/page.tsx', 'two\n');
    write('README.md', 'docs\n');
    expect(digest(commit('elsewhere'))).toBe(digest(base));
  });

  it('gives a new digest to any change in what the build is given', () => {
    const base = commit('base');
    write('apps/keeper/src/main.ts', 'two\n');
    const edited = commit('edit');
    expect(digest(edited)).not.toBe(digest(base));

    // An added file anywhere in a listed directory: it could shadow an import.
    write('apps/keeper/src/main.ts', 'one\n');
    expect(digest(commit('revert'))).toBe(digest(base));
    write('apps/keeper/src/deep/x.ts', '\n');
    expect(digest(commit('add'))).not.toBe(digest(base));
  });

  it('sees what git archive changes in the export, such as export-subst', () => {
    write('.gitattributes', 'apps/keeper/src/version.ts export-subst\n');
    write('apps/keeper/src/version.ts', 'export const commit = "$Format:%H$";\n');
    const base = commit('base');
    // Nothing the build is given changed in the tree, but its export did.
    const next = commit('empty');
    expect(digest(next)).not.toBe(digest(base));
  });

  it('sees a mode change', () => {
    const base = commit('base');
    git('update-index', '--chmod=+x', 'apps/keeper/src/main.ts');
    git('commit', '-q', '-m', 'mode');
    expect(digest(git('rev-parse', 'HEAD'))).not.toBe(digest(base));
  });

  it('exports only the listed paths', () => {
    const base = commit('base');
    const tar = join(scratch, 'src.tar');
    expect(run('export', base, tar).status).toBe(0);
    const files = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).split('\n').filter((f) => f && !f.endsWith('/'));
    expect(files.sort()).toEqual([KIT_PATHS, 'apps/keeper/src/main.ts', 'package.json']);
  });

  it('exits 3 for a commit with no build-paths, and 1 for one that names no plain path', () => {
    rmSync(join(dir, 'apps/keeper/host'), { recursive: true });
    const none = commit('none');
    expect(run('export', none, join(scratch, 'x.tar')).status).toBe(3);
    expect(run('digest', none, join(scratch, 'd')).status).toBe(3);
    for (const bad of ['../outside', '/etc', '-c', 'apps/./keeper', 'apps/../x', 'a b', '# only a comment']) {
      write(KIT_PATHS, `${bad}\n`);
      const commitId = commit(`bad ${bad}`);
      expect(run('export', commitId, join(scratch, 'x.tar')).status, bad).toBe(1);
    }
    // A listed path the commit does not have fails the export.
    write(KIT_PATHS, 'package.json\napps/missing\n');
    expect(run('export', commit('missing'), join(scratch, 'x.tar')).status).not.toBe(0);
    expect(spawnSync('bash', [script, 'export', dir, 'abc', 'x'], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('the real build-paths (#2651)', () => {
  const listed = listedPaths(readFileSync(join(repoRoot, KIT_PATHS), 'utf8'));
  const covered = (file: string) => listed.some((p) => file === p || file.startsWith(`${p}/`));

  it('lists every workspace package the keeper install reaches', () => {
    const seen = new Set<string>();
    const visit = (dir: string) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      expect(covered(dir), dir).toBe(true);
      const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
        for (const [name, spec] of Object.entries(deps ?? {})) {
          if (!spec.startsWith('workspace:')) continue;
          const target = ['apps', 'packages']
            .flatMap((root) => {
              try {
                return execFileSync('git', ['-C', repoRoot, 'ls-files', `${root}/*/package.json`], { encoding: 'utf8' }).split('\n');
              } catch {
                return [];
              }
            })
            .filter(Boolean)
            .find((file) => (JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as { name?: string }).name === name);
          expect(target, name).toBeDefined();
          visit(dirname(target!));
        }
      }
    };
    visit('apps/keeper');
    for (const root of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) expect(listed).toContain(root);
  });

  it('lists every file the keeper bundle is built from', async () => {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [join(keeperDir, 'host', 'main.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
      absWorkingDir: keeperDir,
    });
    const files = Object.keys(result.metafile.inputs)
      .filter((key) => !key.split('/').includes('node_modules'))
      .map((key) => relative(repoRoot, resolve(keeperDir, key)));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !covered(file))).toEqual([]);
  }, 60_000);
});
