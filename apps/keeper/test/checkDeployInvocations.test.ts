/**
 * Tests for `scripts/check-deploy-invocations.mjs`.
 *
 * A guard nobody has watched FAIL is not known to work. This one was written
 * twice before it did: the first cut caught 3 of 5 known violation forms, and
 * the second caught all of them but also flagged 7 correct lines on a clean
 * tree — a guard that cries wolf gets disabled, so the false-positive cases
 * below are as load-bearing as the true-positive ones.
 *
 * Every `violation` case is a form that actually reached `main` or was found in
 * review on PR #1924. Fixtures live in a temp directory (`CHECK_DEPLOY_ROOT`)
 * so the suite never touches the repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../scripts/check-deploy-invocations.mjs', import.meta.url).pathname;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write one fixture file and run the guard over the fixture tree. */
function runWith(relPath: string, content: string): { ok: boolean; out: string } {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  try {
    const out = execFileSync('node', [SCRIPT], {
      env: { ...process.env, CHECK_DEPLOY_ROOT: root },
      encoding: 'utf8',
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-deploy-invocations — forms it must CATCH', () => {
  it('the deploy-wrapper subshell form (#1924 r8)', () => {
    const r = runWith(
      'contracts/script/deploy-testnet.sh',
      '( cd "$KEEPER_DIR" && pnpm exec wrangler deploy )\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the pnpm-filter exec form (#1924 r9)', () => {
    const r = runWith(
      'docs/ops/FlashLoanLiquidatorRollout.md',
      'pnpm --filter @vaipakam/keeper exec wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a command quoted inside runbook prose (#1924 r9 follow-up)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '3. Keeper deploy — `pnpm exec wrangler deploy` from `apps/keeper/`.\n',
    );
    expect(r.ok).toBe(false);
  });

  it('brace notation, which names neither apps/keeper nor a filter (#1924 r10)', () => {
    const r = runWith(
      'docs/DesignsAndPlans/CloudflareStagingDeployPlan.md',
      '| 5 | Operator | `wrangler deploy` for each of `apps/{keeper,indexer,agent}`. |\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a bare deploy inside the keeper tree, scoped by location', () => {
    const r = runWith('apps/keeper/README.md', 'npx wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('the multiline cd form, where the deploy line names nothing (#1924 r11)', () => {
    const r = runWith('docs/ops/DeploymentRunbook.md', '```bash\ncd apps/keeper\nwrangler deploy\n```\n');
    expect(r.ok).toBe(false);
  });

  it('the multiline form via $KEEPER_DIR', () => {
    const r = runWith('contracts/script/deploy-chain.sh', 'cd "$KEEPER_DIR"\npnpm exec wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('names the offending file and line', () => {
    const r = runWith('apps/keeper/README.md', 'intro\nnpx wrangler deploy\n');
    expect(r.out).toContain('apps/keeper/README.md:2');
  });
});

describe('check-deploy-invocations — forms it must NOT flag', () => {
  it('a keeper deploy carrying --keep-vars', () => {
    const r = runWith('docs/ops/DeploymentRunbook.md', '```bash\ncd apps/keeper\nwrangler deploy --keep-vars\n```\n');
    expect(r.ok).toBe(true);
  });

  it('the safe `run deploy` package-script form', () => {
    const r = runWith('docs/x.md', 'pnpm --filter @vaipakam/keeper run deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a --dry-run bundle check, which deploys nothing', () => {
    const r = runWith(
      'docs/x.md',
      'pnpm --filter @vaipakam/keeper exec wrangler deploy --dry-run --outdir /tmp/b\n',
    );
    expect(r.ok).toBe(true);
  });

  it('another Worker entirely', () => {
    const r = runWith('docs/ops/DeploymentRunbook.md', '```bash\ncd apps/agent\nwrangler deploy\n```\n');
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper context past a blank line', () => {
    const r = runWith('contracts/script/deploy-testnet.sh', 'cd "$KEEPER_DIR"\n\ncd "$AGENT_DIR"\npnpm exec wrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper context across fenced blocks', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '```bash\ncd apps/keeper\n```\n\n```bash\ncd apps/agent\nwrangler deploy\n```\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not read `wrangler deployments list` as a deploy', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deployments list | head\n');
    expect(r.ok).toBe(true);
  });

  it('does not flag a deploy of a sibling Worker named on one line', () => {
    const r = runWith('docs/x.md', 'pnpm --filter @vaipakam/indexer exec wrangler deploy\n');
    expect(r.ok).toBe(true);
  });
});
