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

  it('--keep-vars=false, which is a live deploy that deletes vars (#1924 r12)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars=false\n');
    expect(r.ok).toBe(false);
  });

  it('--keep-vars false, the space-separated disable', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars false\n');
    expect(r.ok).toBe(false);
  });

  it('--dry-run=false, which really does deploy (#1924 r12)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --dry-run=false\n');
    expect(r.ok).toBe(false);
  });

  it('--keep-vars="false", double-quoted (#1924 r13)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars="false"\n');
    expect(r.ok).toBe(false);
  });

  it("--keep-vars 'false', single-quoted and space-separated (#1924 r13)", () => {
    const r = runWith('apps/keeper/README.md', "wrangler deploy --keep-vars 'false'\n");
    expect(r.ok).toBe(false);
  });

  it('--dry-run="false", quoted (#1924 r13)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --dry-run="false"\n');
    expect(r.ok).toBe(false);
  });

  it('a bare deploy whose only --keep-vars is in a shell comment (#1924 r17)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy # TODO: add --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('an unsafe command followed by a comment mentioning run deploy (#1924 r17)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy # prefer pnpm run deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a compound line where a safe command precedes an unsafe one (#1924 r18)', () => {
    const r = runWith('apps/keeper/README.md', 'pnpm run deploy && wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a compound line with an explicitly disabled first deploy (#1924 r18)', () => {
    const r = runWith(
      'apps/keeper/README.md',
      'wrangler deploy --keep-vars=false; wrangler deploy --dry-run\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a safety flag that only appears inside another option value (#1924 r19)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message="remember --keep-vars"\n');
    expect(r.ok).toBe(false);
  });

  it("the same bypass with single quotes (#1924 r19)", () => {
    const r = runWith('apps/keeper/README.md', "wrangler deploy --message='use --keep-vars next time'\n");
    expect(r.ok).toBe(false);
  });

  it('a later --keep-vars=false overriding an earlier bare one (#1924 r20)', () => {
    // Verified against wrangler 4.90.0: this parses as keepVars:false.
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars --keep-vars=false\n');
    expect(r.ok).toBe(false);
  });

  it('a later --dry-run=false overriding an earlier enabling one (#1924 r20)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --dry-run --dry-run=false\n');
    expect(r.ok).toBe(false);
  });

  it('a safety flag embedded in an UNQUOTED option value (#1924 r21)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message=remember--keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('an option whose entire value looks like the flag (#1924 r22)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message=--keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('`run deploy` appearing only inside an option value (#1924 r22)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message="run deploy"\n');
    expect(r.ok).toBe(false);
  });

  it('`run deploy` inside a single-quoted option value (#1924 r22)', () => {
    const r = runWith('apps/keeper/README.md', "wrangler deploy --message='run deploy'\n");
    expect(r.ok).toBe(false);
  });

  it('a flag concatenated onto a quoted option value (#1924 r23)', () => {
    // The shell builds ONE argument here — `--message=note--keep-vars` — so no
    // flag is enabled. Stripping the quoted value to a SPACE used to
    // manufacture a token boundary the shell never saw.
    const r = runWith('apps/keeper/README.md', "wrangler deploy --message='note'--keep-vars\n");
    expect(r.ok).toBe(false);
  });

  it('the same concatenation with double quotes (#1924 r23)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message="note"--keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('a flag as a QUOTED chunk of a mixed option value (#1924 r24)', () => {
    // Bash builds one argument: --message=note--keep-vars. Matching only
    // wholly-quoted values let the quoted suffix survive as a real flag.
    const r = runWith('apps/keeper/README.md', "wrangler deploy --message=note'--keep-vars'\n");
    expect(r.ok).toBe(false);
  });

  it('the mixed form with double quotes (#1924 r24)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message=note"--keep-vars"\n');
    expect(r.ok).toBe(false);
  });

  it('a deploy helper under a first-party lib directory (#1924 r24)', () => {
    // `lib` was in SKIP_DIRS by basename, so contracts/script/lib — which
    // holds FacetSelectors.sol — was never scanned at all.
    const r = runWith(
      'contracts/script/lib/deploy.sh',
      '( cd apps/keeper && wrangler deploy )\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a deploy helper under packages/lib (#1924 r24)', () => {
    const r = runWith('packages/lib/src/deploy.ts', "// pnpm --filter @vaipakam/keeper exec wrangler deploy\n");
    expect(r.ok).toBe(false);
  });

  it('a deploy split across a shell line continuation (#1924 r25)', () => {
    // bash runs a bare `wrangler deploy`; the literal prefilter used to skip
    // the whole file because no single line contained the phrase.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd "$KEEPER_DIR"\npnpm exec wrangler \\\n  deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an escaped space inside an option value (#1924 r25)', () => {
    // bash passes ONE argument, `--message=note --keep-vars`, enabling nothing.
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message=note\\ --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('a bare deploy hidden under a comment ending in a backslash (#1924 r26)', () => {
    // bash ignores the backslash inside the comment and runs line 2 normally.
    // Folding it joined both lines, then stripComment deleted the lot.
    const r = runWith(
      'apps/keeper/README.md',
      '# previous deploy used \\\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a regression in the keeper package manifest itself (#1924 r12)', () => {
    // The canonical entry point every corrected wrapper calls. A bare deploy
    // here re-breaks the whole invariant while each wrapper still looks right.
    const r = runWith(
      'apps/keeper/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  }\n}\n',
    );
    expect(r.ok).toBe(false);
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

  it('accepts --keep-vars followed by another flag rather than a value', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars --outdir /tmp/b\n');
    expect(r.ok).toBe(true);
  });

  it('accepts an explicit --keep-vars=true', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars=true\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a quoted true value', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars="true"\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a safe command that also carries a trailing comment', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars # keeps dashboard vars\n');
    expect(r.ok).toBe(true);
  });

  it('does not treat a # inside quotes as a comment', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars --message "fix #1896"\n');
    expect(r.ok).toBe(true);
  });

  it('does not treat a # mid-token as a comment (#1924 r18)', () => {
    // `--message fix#1896 --keep-vars` is a valid tagged deploy. Truncating at
    // the mid-word `#` dropped the real flag and failed a correct command.
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message fix#1896 --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('does not treat an escaped hash as a comment (#1924 r18)', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message fix\\#1896 --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts prose that backticks the command and the flag separately', () => {
    // A full shell tokenizer failed this: markdown backticks are not shell
    // quoting, and treating them as such hid the flag (#1924 r19).
    const r = runWith(
      'apps/keeper/README.md',
      'keeper-scoped `wrangler deploy` that lacks `--keep-vars`. It exists because\n',
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a line with an apostrophe before the command", () => {
    const r = runWith(
      'apps/keeper/README.md',
      "So `apps/keeper`'s `deploy` script now runs `wrangler deploy --keep-vars`,\n",
    );
    expect(r.ok).toBe(true);
  });

  it('accepts --keep-vars carrying its own quoted true value', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars="true" --message="x"\n');
    expect(r.ok).toBe(true);
  });

  it('accepts an unquoted other-option value followed by a real flag', () => {
    // The shell really does see a separate --keep-vars here, so it is safe.
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message remember --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a later --keep-vars=true overriding an earlier false', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars=false --keep-vars=true\n');
    expect(r.ok).toBe(true);
  });

  it('still accepts the flag when it begins a token after an equals', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --keep-vars=true\n');
    expect(r.ok).toBe(true);
  });

  it('still accepts a quoted option value followed by a real flag', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message="note" --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('still leaves an unquoted option value followed by a real flag alone', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message=note --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('does not scan the vendored contracts/lib submodule tree', () => {
    const r = runWith('contracts/lib/forge-std/x.sh', '( cd apps/keeper && wrangler deploy )\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a safe deploy split across a line continuation', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd "$KEEPER_DIR"\npnpm exec wrangler deploy \\\n  --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a boolean option placed before the safety flag (#1924 r26)', () => {
    // Both are booleans per wrangler's own help. Consuming --keep-vars as
    // --strict's value made the guard REJECT a safe command, which would
    // block CI on valid input.
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --strict --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('still strips a genuinely space-separated option value', () => {
    const r = runWith('apps/keeper/README.md', 'wrangler deploy --message note --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a compound line where every deploy is safe', () => {
    const r = runWith(
      'apps/keeper/README.md',
      'pnpm run deploy && wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts the real keeper package manifest shape', () => {
    const r = runWith(
      'apps/keeper/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy --keep-vars"\n  }\n}\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not flag a sibling Worker manifest with a bare deploy', () => {
    // apps/agent and apps/indexer legitimately run bare deploys — they have no
    // dashboard-managed vars absent from their configs. Only the keeper is in
    // scope, and widening that would make this guard everyone's problem.
    const r = runWith(
      'apps/agent/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  }\n}\n',
    );
    expect(r.ok).toBe(true);
  });
});
