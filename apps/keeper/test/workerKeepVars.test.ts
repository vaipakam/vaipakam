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
    expect(r.out).toContain('wrangler config(s) declare preservation');
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

  /**
   * EVERY wrangler config declares preservation — no classification.
   *
   * Round 1 of #2171 answered "a deploy can select a different config" by
   * deciding WHICH configs mattered: those naming a var-carrying Worker and
   * carrying a `compatibility_date`, under `apps/` or `ops/`. Round 2 returned
   * SIX P1s against that predicate, each a different way to reach a protected
   * Worker through a config it excluded — `--name`, `--compatibility-date`,
   * `env.<name>.name` under `--env`, a path outside both roots, and a sixth
   * Worker's alternate config. So the predicate is gone: the requirement is
   * unconditional, and a config is identified by wrangler's own filename
   * convention, which is a test on a string rather than a judgement about
   * content.
   *
   * Each case seeds a COPY, for the reason `copiedRoot` documents.
   */
  describe('every wrangler config declares preservation (#2171 r2)', () => {
    function withSeeded(rel: string, body: string, assert: (r: ReturnType<typeof runCheck>) => void) {
      const root = copiedRoot();
      try {
        const path = join(root, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
        assert(runCheck(root));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    /** Every shape round 2 named, and each is rejected for the same reason. */
    const REJECTED: Array<[string, string, string]> = [
      // `--name` overrides the stored name, so the stored name cannot gate.
      ['a config naming an unrelated Worker', 'apps/agent/wrangler.alt.jsonc', '{"name": "something-else", "compatibility_date": "2026-01-01"}'],
      // `--compatibility-date` supplies what the file omits.
      ['a config with no compatibility_date', 'apps/agent/wrangler.nodate.jsonc', '{"name": "vaipakam-agent"}'],
      // `--config` accepts any path — neither root is privileged.
      ['a config outside apps/ and ops/', 'configs/wrangler.www.jsonc', '{"name": "vaipakam-www", "compatibility_date": "2026-01-01"}'],
      // A sixth Worker needs no entry in any list to be covered.
      ['a config for a Worker in no list', 'apps/new-worker/wrangler.jsonc', '{"name": "vaipakam-new", "compatibility_date": "2026-01-01"}'],
      // Depth is not a factor.
      ['a config nested several levels down', 'apps/agent/deploy/envs/wrangler.staging.jsonc', '{"name": "vaipakam-agent", "compatibility_date": "2026-01-01"}'],
      // A manifest sharing the Worker's name is NOT a config — it is not
      // named `wrangler*`, so it is never read. Asserted from the other side
      // in the bounds guards below; listed here so the contrast is visible.
    ];

    it.each(REJECTED)('rejects %s', (_label, rel, body) => {
      withSeeded(rel, `${body}\n`, (r) => {
        expect(r.ok, `${rel} was accepted without keep_vars`).toBe(false);
        expect(r.out).toContain(rel);
      });
    });

    it('accepts each of those once it declares the key', () => {
      for (const [, rel, body] of REJECTED) {
        const withKey = JSON.stringify({ ...JSON.parse(body), keep_vars: true });
        withSeeded(rel, `${withKey}\n`, (r) =>
          expect(r.ok, `${rel} was rejected despite declaring keep_vars: ${r.out}`).toBe(true),
        );
      }
    });

    it('requires the key in each named environment, not only at the top', () => {
      // Whether `keep_vars` inherits into an `env.<name>` block is not
      // something this check can verify, and `--env staging` merges that
      // block. It is required there rather than assumed to carry down.
      withSeeded(
        'apps/agent/wrangler.envs.jsonc',
        `{"name": "vaipakam-agent", "keep_vars": true, "env": {"staging": {"name": "vaipakam-agent"}}}\n`,
        (r) => {
          expect(r.ok, 'an env block without keep_vars was accepted').toBe(false);
          expect(r.out).toContain('staging');
        },
      );
      withSeeded(
        'apps/agent/wrangler.envs.jsonc',
        `{"name": "vaipakam-agent", "keep_vars": true, "env": {"staging": {"keep_vars": true}}}\n`,
        (r) => expect(r.ok, r.out).toBe(true),
      );
    });

    it('REFUSES a TOML config rather than guessing at its grammar', () => {
      // Deciding whether a `keep_vars = true` line is top-level — and not
      // inside a table or a multiline string — is the class of reasoning the
      // retired scanner failed at, so the check says so instead of
      // approximating. No TOML config exists in the tree.
      withSeeded('apps/agent/wrangler.toml', 'name = "vaipakam-agent"\nkeep_vars = true\n', (r) => {
        expect(r.ok, 'a TOML config was silently skipped').toBe(false);
        expect(r.out).toContain('JSON/JSONC');
      });
    });

    // BOUNDS GUARDS — these pass with or without the rule, and are here to
    // pin that it is not a blanket file ban. Labelled so nobody counts them
    // as coverage of the rule itself.
    it('bounds guard: a manifest sharing the Worker name is not a config', () => {
      // `ops/mesh-watcher/package.json` really does carry
      // `"name": "vaipakam-mesh-watcher"`, and an earlier draft that keyed on
      // the name turned the committed tree red on it.
      withSeeded('apps/agent/package.json', `{"name": "vaipakam-agent", "version": "1.0.0"}\n`, (r) =>
        expect(r.ok, r.out).toBe(true),
      );
    });

    it('bounds guard: ordinary JSON is not read', () => {
      withSeeded('apps/agent/tsconfig.probe.json', '{"compilerOptions": {}}\n', (r) =>
        expect(r.ok, r.out).toBe(true),
      );
    });

    it('bounds guard: vendored trees are not walked', () => {
      withSeeded('apps/agent/node_modules/pkg/wrangler.jsonc', '{"name": "x"}\n', (r) =>
        expect(r.ok, 'a vendored config was treated as ours').toBe(true),
      );
    });

    it('the real tree carries the key on EVERY config, app and www included', () => {
      // The two Workers with no `vars` are the ones the deleted predicate
      // excluded, so their declarations are the part of this change most
      // likely to be reverted by someone tidying up.
      for (const rel of ['apps/app/wrangler.jsonc', 'apps/www/wrangler.jsonc']) {
        const cfg = readFileSync(join(REPO_ROOT, rel), 'utf8');
        expect(/"keep_vars"\s*:\s*true/.test(cfg), `${rel} lost its declaration`).toBe(true);
      }
    });
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
