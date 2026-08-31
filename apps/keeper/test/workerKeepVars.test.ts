import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The keep_vars invariant, exercised through the SAME script CI runs.
 *
 * `scripts/check-keep-vars.mjs` is the one implementation — the rationale for
 * the invariant lives in its header. This suite does not restate the rule; it
 * proves the script accepts the tree as it stands and REJECTS the tree with
 * the key removed, which is the part a passing check cannot demonstrate about
 * itself.
 *
 * TWO gates, deliberately, because they fail differently:
 *
 *   - `ci.yml`'s `worker keep_vars (unconditional)` job runs the script on
 *     every PR with no path filter, the same shape and for the same stated
 *     reason as `D1 name consistency` — a path gate excludes exactly the
 *     changes the check exists to catch. It needs no install step, so it is
 *     cheap enough to be unconditional.
 *   - `app-vitest.yml`'s filter additionally brings THIS suite in whenever a
 *     listed config changes, so the richer assertions run too. The last test
 *     below reads that filter and asserts it covers every listed Worker,
 *     because a gate nobody checks is how the invariant went unrun in the
 *     first place (#1995 r22).
 */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPT = join(REPO_ROOT, 'apps/keeper/scripts/check-keep-vars.mjs');

/** Kept in step with the same list inside the script, which is the authority. */
const VAR_CARRYING_WORKERS = [
  'apps/agent',
  'apps/keeper',
  'apps/indexer',
  'ops/mesh-watcher',
  'ops/offchain-data-warm',
];

function runCheck(root?: string): { ok: boolean; out: string } {
  const env = root ? { ...process.env, CHECK_KEEP_VARS_ROOT: root } : process.env;
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT], { encoding: 'utf8', env }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * A throwaway tree holding COPIES of the real configs.
 *
 * The mutation cases below must not edit the repository's own
 * `wrangler.jsonc` files: a crash or a kill between the write and the restore
 * would leave the worktree without `keep_vars` — the exact unsafe state this
 * invariant exists to prevent — and no `finally` runs after process
 * termination (Codex #1995 r23). Copying keeps the fixtures HONEST, since the
 * bytes under test are the committed ones.
 */
function copiedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keep-vars-'));
  for (const dir of VAR_CARRYING_WORKERS) {
    const rel = `${dir}/wrangler.jsonc`;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), readFileSync(join(REPO_ROOT, rel), 'utf8'));
  }
  return root;
}

describe('worker configs preserve dashboard vars at the source (#1995)', () => {
  it('passes on the tree as committed', () => {
    const r = runCheck();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain('preserve their dashboard-managed vars');
  });

  it('covers exactly the Workers the script covers', () => {
    // The list above is a convenience for the tests below; the script owns the
    // real one. If they drift, the mutation tests would silently stop covering
    // a Worker — so the drift itself is asserted.
    const src = readFileSync(SCRIPT, 'utf8');
    const block = /const VAR_CARRYING_WORKERS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
    const inScript = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(inScript).toEqual(VAR_CARRYING_WORKERS);
  });

  it.each(VAR_CARRYING_WORKERS)('fails when %s loses the declaration', (dir) => {
    // The check RUNS ON ITS OWN CASE, once per Worker: a check that only ever
    // passes proves nothing about the Worker it names. Mutated in a COPY, so
    // an interrupted run cannot leave the repository unsafe.
    const root = copiedRoot();
    try {
      const path = join(root, dir, 'wrangler.jsonc');
      const original = readFileSync(path, 'utf8');
      const mutated = original.replace(/^\s*"keep_vars":\s*true,\s*$/m, '');
      expect(mutated, `${dir}: mutation did not change the file`).not.toBe(original);
      writeFileSync(path, mutated);
      const result = runCheck(root);
      expect(result.ok, `${dir}: removing keep_vars did not fail the check`).toBe(false);
      expect(result.out).toContain(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // The REAL tree is untouched — asserted, not assumed, because the whole
    // point of the copy is that this can never have been edited.
    expect(runCheck().ok).toBe(true);
  });

  it('CI actually runs this suite when any listed config changes', () => {
    // The unconditional job is the primary gate, but this suite carries the
    // richer assertions and is path-gated. That gate listed
    // `apps/(app|indexer|keeper)` only, so an agent-only or ops-only PR could
    // delete `keep_vars` with this file never executing (#1995 r22).
    //
    // Asserted against the workflow's own regex rather than restated here: a
    // copy would drift, and the failure mode is silence.
    const wf = readFileSync(join(REPO_ROOT, '.github/workflows/app-vitest.yml'), 'utf8');
    const line = wf.split('\n').find((l) => l.trim().startsWith('DEFI_RE='));
    expect(line, 'DEFI_RE not found in app-vitest.yml').toBeTruthy();
    const pattern = /DEFI_RE='(.*)'\s*$/.exec(line as string)?.[1];
    expect(pattern, 'DEFI_RE is not single-quoted as expected').toBeTruthy();
    const re = new RegExp(pattern as string);
    for (const dir of VAR_CARRYING_WORKERS) {
      expect(
        re.test(`${dir}/wrangler.jsonc`),
        `${dir}/wrangler.jsonc does not trigger the vitest job, so removing its keep_vars would go unchecked`,
      ).toBe(true);
    }
    // …and the test file itself, so editing the invariant runs it.
    expect(re.test('apps/keeper/test/workerKeepVars.test.ts')).toBe(true);
  });

  it('a REQUIRED job runs the invariant, not only the unconditional one', () => {
    // Branch protection gates on a list of contexts that no PR can change, and
    // the unconditional job is not on it — so on its own it can be red while
    // the PR stays mechanically mergeable (Codex #1995 r22). The keeper's
    // `typecheck` is invoked by the REQUIRED `workspaces` job, so running the
    // script there makes the invariant blocking without a ruleset change.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/keeper/package.json'), 'utf8'));
    expect(pkg.scripts.typecheck).toContain('check-keep-vars.mjs');

    // …and that job must TRIGGER for every config the invariant asserts, or it
    // is path-skipped on exactly the change it exists to catch. Read from the
    // workflow's own filter rather than restated.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const pattern = /WORKSPACES_RE='(.*)'/.exec(ci)?.[1];
    expect(pattern, 'WORKSPACES_RE not found in ci.yml').toBeTruthy();
    const re = new RegExp(pattern as string);
    for (const dir of VAR_CARRYING_WORKERS) {
      expect(
        re.test(`${dir}/wrangler.jsonc`),
        `${dir}/wrangler.jsonc does not trigger the required workspaces job`,
      ).toBe(true);
    }
  });

  it('the unconditional CI job exists and is not path-gated', () => {
    // The other half of the same worry: this suite's gate is asserted above,
    // and the job that needs NO gate is asserted here. A job that quietly
    // gained an `if:` would look identical from the outside.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const job = /\n  worker-keep-vars:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/.exec(ci)?.[1] ?? '';
    expect(job, 'worker-keep-vars job not found in ci.yml').toBeTruthy();
    expect(job).toContain('check-keep-vars.mjs');
    expect(/^\s{4}if:/m.test(job), 'the unconditional job has acquired an if: gate').toBe(false);
  });
});
