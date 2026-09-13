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

  /**
   * A configuration that is NOT the Worker's canonical one.
   *
   * `wrangler deploy --config other.jsonc` (and `versions upload`) loads the
   * selected file, so the canonical config's declaration is not the one in
   * force. This was the ONE thing the retired command scanner caught that the
   * declaration alone did not, raised as a P1 on #2171 when the retirement
   * claimed it traded away no coverage. It is answered here as a property of
   * configuration FILES rather than of commands — no notion of what runs, no
   * parsing of text as a command.
   *
   * Each case seeds a COPY, for the reason `copiedRoot` documents.
   */
  describe('a non-canonical config naming a var-carrying Worker (#2171 r1 P1)', () => {
    /** The Worker names, read from the tree — never restated here. */
    function agentName(): string {
      const raw = readFileSync(join(REPO_ROOT, 'apps/agent/wrangler.jsonc'), 'utf8');
      return /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1] as string;
    }

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

    it('is REJECTED when it omits the declaration', () => {
      withSeeded('apps/agent/unsafe.jsonc', `{"name": "${agentName()}", "compatibility_date": "2026-01-01"}\n`, (r) => {
        expect(r.ok, 'a selected config without keep_vars was accepted').toBe(false);
        expect(r.out).toContain('apps/agent/unsafe.jsonc');
        expect(r.out).toContain(agentName());
      });
    });

    it('is ACCEPTED when it declares it — the rule is the key, not the filename', () => {
      withSeeded(
        'apps/agent/safe.jsonc',
        `{"name": "${agentName()}", "compatibility_date": "2026-01-01", "keep_vars": true}\n`,
        (r) => expect(r.ok, r.out).toBe(true),
      );
    });

    it('is found at any depth, not only beside the canonical config', () => {
      withSeeded('apps/agent/deploy/envs/staging.jsonc', `{"name": "${agentName()}", "compatibility_date": "2026-01-01"}\n`, (r) => {
        expect(r.ok).toBe(false);
        expect(r.out).toContain('apps/agent/deploy/envs/staging.jsonc');
      });
    });

    it('ignores a config naming a Worker that has no vars to lose', () => {
      const www = /"name"\s*:\s*"([^"]+)"/.exec(
        readFileSync(join(REPO_ROOT, 'apps/www/wrangler.jsonc'), 'utf8'),
      )?.[1] as string;
      expect(VAR_CARRYING_WORKERS).not.toContain('apps/www');
      withSeeded('apps/agent/other.jsonc', `{"name": "${www}", "compatibility_date": "2026-01-01"}\n`, (r) =>
        expect(r.ok, r.out).toBe(true),
      );
    });

    it('ignores a manifest that merely SHARES the Worker name', () => {
      // Not hypothetical: `ops/mesh-watcher/package.json` and its lockfile
      // both carry `"name": "vaipakam-mesh-watcher"`. The first draft of this
      // rule keyed on the name alone and turned the committed tree red with
      // four false reports. `compatibility_date` is the marker instead —
      // wrangler requires it to deploy, so a file without one cannot publish
      // and cannot delete a var.
      withSeeded(
        'apps/agent/some-package.json',
        `{"name": "${agentName()}", "version": "1.0.0"}\n`,
        (r) => expect(r.ok, r.out).toBe(true),
      );
    });

    it('ignores ordinary JSON and unparseable JSON — it is not a blanket file ban', () => {
      // Most JSON under apps/ is not a wrangler config, and some of it is
      // deliberately malformed fixture input. Neither may turn the check red.
      withSeeded('apps/agent/tsconfig.probe.json', '{"compilerOptions": {}}\n', (r) =>
        expect(r.ok, r.out).toBe(true),
      );
      withSeeded('apps/agent/broken.probe.json', 'not json at all {{{\n', (r) =>
        expect(r.ok, r.out).toBe(true),
      );
    });

    it('does not walk node_modules', () => {
      withSeeded('apps/agent/node_modules/pkg/wrangler.jsonc', `{"name": "${agentName()}", "compatibility_date": "2026-01-01"}\n`, (r) =>
        expect(r.ok, 'a vendored config was treated as ours').toBe(true),
      );
    });

    it('REFUSES a TOML config rather than guessing at its grammar', () => {
      // Wrangler accepts TOML. Deciding whether a `keep_vars = true` line is
      // top-level — and not inside a table or a multiline string — is the
      // class of reasoning the retired scanner failed at, so the check says so
      // instead of approximating. No TOML exists under apps/ or ops/ today.
      withSeeded('apps/agent/wrangler.toml', `name = "${agentName()}"\nkeep_vars = true\n`, (r) => {
        expect(r.ok, 'a TOML config was silently skipped').toBe(false);
        expect(r.out).toContain('JSON/JSONC configs only');
      });
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
