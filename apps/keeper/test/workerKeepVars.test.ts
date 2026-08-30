import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The keep_vars invariant, exercised through the SAME script CI runs.
 *
 * `scripts/check-keep-vars.mjs` is the one implementation — the rationale for
 * the invariant lives in its header. This suite does not restate the rule; it
 * proves the script accepts the tree as it stands and REJECTS the tree with
 * the key removed, which is the part a passing check cannot demonstrate about
 * itself.
 *
 * Two runners on purpose. CI runs the script unconditionally, because the
 * Workers it covers span `apps/` and `ops/` while the job running this suite
 * is path-gated to `apps/(app|indexer|keeper)` — an agent-only or ops-only
 * change would otherwise skip the invariant (Codex #1995 r22). This suite is
 * the fast local feedback, and it must not become a second implementation.
 */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPT = join(REPO_ROOT, 'apps/keeper/scripts/check-keep-vars.mjs');

function runCheck(): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('worker configs preserve dashboard vars at the source (#1995)', () => {
  it('passes on the tree as committed', () => {
    const r = runCheck();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain('preserve their dashboard-managed vars');
  });

  it.each([
    'apps/agent',
    'apps/keeper',
    'apps/indexer',
    'ops/mesh-watcher',
    'ops/offchain-data-warm',
  ])('fails when %s loses the declaration', (dir) => {
    // The check RUNS ON ITS OWN CASE, once per Worker: a check that only ever
    // passes proves nothing about the Worker it names. The config is restored
    // in `finally`, and the assertion is made after restoring so a failure
    // cannot leave the tree edited.
    const path = join(REPO_ROOT, dir, 'wrangler.jsonc');
    const original = readFileSync(path, 'utf8');
    let result: { ok: boolean; out: string };
    try {
      const mutated = original.replace(/^\s*"keep_vars":\s*true,\s*$/m, '');
      expect(mutated, `${dir}: mutation did not change the file`).not.toBe(original);
      writeFileSync(path, mutated);
      result = runCheck();
    } finally {
      writeFileSync(path, original);
    }
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(result.ok, `${dir}: removing keep_vars did not fail the check`).toBe(false);
    expect(result.out).toContain(dir);
  });
});
