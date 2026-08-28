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

/** Write a fixture file WITHOUT running the guard, for multi-file cases. */
function seed(relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** The two protected manifests, so `...<pattern>` has a graph to resolve. */
function seedWorkspace(): void {
  for (const name of ['agent', 'keeper']) {
    seed(
      `apps/${name}/package.json`,
      `{"name":"@vaipakam/${name}","dependencies":{"@vaipakam/lib":"workspace:*"}}\n`,
    );
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
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy # TODO: add --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('an unsafe command followed by a comment mentioning run deploy (#1924 r17)', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy # prefer pnpm run deploy\n');
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
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --message=note\\ --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('a bare deploy hidden under a comment ending in a backslash (#1924 r26)', () => {
    // bash ignores the backslash inside the comment and runs line 2 normally.
    // Folding it joined both lines, then stripComment deleted the lot.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper\n# previous deploy used \\\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a comment opening straight after a shell operator (#1924 r27)', () => {
    // bash treats `#` after `;` as a comment, so the safety token inside it
    // must not bless the deploy on the next line.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper\necho prev;# --keep-vars \\\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the --no-keep-vars negation (#1924 r27)', () => {
    // wrangler 4.90.0 parses this as keepVars:false.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars --no-keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('the --no-dry-run negation (#1924 r27)', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --dry-run --no-dry-run\n');
    expect(r.ok).toBe(false);
  });

  it('a deploy reached via pushd rather than cd (#1924 r27)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pushd apps/keeper\nwrangler deploy\npopd\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a real command sharing a line with allowlisted prose (#1924 r27)', () => {
    const r = runWith(
      'apps/keeper/README.md',
      'Prefer the dashboard over `wrangler deploy` for this. Then: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a workflow run: block with cd + continuation (#1924 r28)', () => {
    // GitHub Actions `run:` blocks ARE shell. Scoping shell semantics to .sh
    // files in r27 closed the markdown false positives and opened this.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: |\n          cd apps/keeper\n          wrangler \\\n            deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a fenced bash block with cd + continuation (#1924 r28)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Steps:\n\n```bash\ncd apps/keeper\nwrangler \\\n  deploy\n```\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an extensionless wrapper with a bash shebang (#1924 r28)', () => {
    // The header claimed shebang detection; the extension allow-list never
    // yielded such a file, so it was not even opened.
    const r = runWith(
      'contracts/script/deploy-keeper',
      '#!/usr/bin/env bash\ncd apps/keeper\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a command lost when a comment runs to EOF (#1924 r28)', () => {
    // No trailing newline: inComment was still true at EOF, so the buffered
    // command before the comment was discarded with it.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy # TODO --keep-vars');
    expect(r.ok).toBe(false);
  });

  it('a comment opening right after a closing paren (#1924 r28)', () => {
    const r = runWith(
      'apps/keeper/x.sh',
      '(true)# --keep-vars \\\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('nested pushd/popd returning to the keeper directory (#1924 r28)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pushd apps/keeper\npushd ../indexer\npopd\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('--keep-vars=yes, which wrangler parses as false (#1924 r28)', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars=yes\n');
    expect(r.ok).toBe(false);
  });

  it('--keep-vars= with an empty value (#1924 r28)', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars=\n');
    expect(r.ok).toBe(false);
  });

  it('a negation followed by a positional script (#1924 r28)', () => {
    // The option-value strip used to swallow `--no-keep-vars src/index.ts`
    // whole, leaving only the positive event behind.
    const r = runWith(
      'apps/keeper/x.sh',
      'wrangler deploy --keep-vars --no-keep-vars src/index.ts\n',
    );
    expect(r.ok).toBe(false);
  });

  it("ANSI-C $'…' quoting does not end at an escaped apostrophe (#1924 r28)", () => {
    const r = runWith(
      'apps/keeper/x.sh',
      "printf '%s' $'it\\'s fine' # --keep-vars \\\nwrangler deploy\n",
    );
    expect(r.ok).toBe(false);
  });

  it('a run block whose indicator carries a YAML comment (#1924 r29)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: | # deploy keeper\n          cd apps/keeper\n          wrangler \\\n            deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a folded run: > block, where YAML joins lines (#1924 r29)', () => {
    // YAML replaces the newlines with spaces before the shell sees it, so this
    // executes as `cd apps/keeper; wrangler deploy`.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: >\n          cd apps/keeper;\n          wrangler\n          deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an attached value beginning with # (#1924 r29)', () => {
    // The `#` is part of the argument, not a comment. Excluding it made the
    // value branch backtrack to "bare flag, enabled".
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars=#false\n');
    expect(r.ok).toBe(false);
  });

  it('a run block with an explicit indentation indicator (#1924 r30)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: |2\n          cd apps/keeper\n          wrangler \\\n            deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a folded block where a more-indented comment precedes the command (#1924 r30)', () => {
    // YAML keeps line breaks on BOTH sides of a more-indented line; adding one
    // only before it let the comment swallow the deploy beneath.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: >\n          cd apps/keeper;\n            # harmless note\n          wrangler\n          deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an attached value mixing quoted and unquoted chunks (#1924 r30)', () => {
    // bash passes --keep-vars=truegarbage, which is not true.
    const r = runWith('apps/keeper/x.sh', "wrangler deploy --keep-vars='true'garbage\n");
    expect(r.ok).toBe(false);
  });

  it('a redirection target that looks like the safety flag (#1924 r30)', () => {
    // bash runs a bare deploy and creates a file named --keep-vars.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy > --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('a here-string operand that looks like the safety flag (#1924 r31)', () => {
    // bash treats --keep-vars as the <<< operand; wrangler gets only `deploy`.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy <<< --keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('global wrangler flags before the subcommand (#1924 r31)', () => {
    // `--cwd` is a documented global flag, so `deploy` is not the next word.
    const r = runWith('apps/keeper/x.sh', 'wrangler --cwd apps/keeper deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a tilde-fenced shell example with cd + continuation (#1924 r32)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Steps:\n\n~~~bash\ncd apps/keeper\nwrangler \\\n  deploy\n~~~\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a four-tilde fenced shell example (#1924 r33)', () => {
    // CommonMark allows 3+ fence characters; matching exactly three missed it.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Steps:\n\n~~~~bash\ncd apps/keeper\nwrangler \\\n  deploy\n~~~~\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a version-qualified wrangler executable (#1924 r33)', () => {
    const r = runWith('apps/keeper/x.sh', 'npx wrangler@4.90.0 deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a fence whose info string carries more than the language (#1924 r34)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Steps:\n\n```bash title="keeper deploy"\ncd apps/keeper\nnpx wrangler@4.90.0 \\\n  deploy\n```\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a cd that follows another command on the line (#1924 r35)', () => {
    // `set -e; cd apps/keeper` is an ordinary wrapper preamble; a
    // start-anchored match never saw the cd.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/keeper\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the LAST cd on a line decides scope (#1924 r36)', () => {
    // `cd apps/indexer; cd apps/keeper` ends in the keeper directory.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/indexer; cd apps/keeper\nwrangler deploy\n',
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

/**
 * These fixtures use `apps/indexer` as the out-of-scope stand-in. It was
 * `apps/agent` until #1933 put the agent IN scope — at which point all thirteen
 * of them failed, correctly.
 *
 * They were re-pointed rather than flipped to expect a violation. The property
 * each one protects is that scope does not LEAK — past a blank line, across a
 * fenced block, out of a `run:` step, through a `pushd`/`popd` pair, or from a
 * superseded `cd` — and a test that expects a violation proves none of that: a
 * guard that flagged every line would satisfy it. The assertion has to stay
 * "this correct line is accepted", so the fixture needs a Worker that is
 * genuinely out of scope. `apps/indexer` is (audited #1924 r43; see SCOPED in
 * the script).
 */
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
    const r = runWith('docs/ops/DeploymentRunbook.md', '```bash\ncd apps/indexer\nwrangler deploy\n```\n');
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper context past a blank line', () => {
    const r = runWith('contracts/script/deploy-testnet.sh', 'cd "$KEEPER_DIR"\n\ncd "$INDEXER_DIR"\npnpm exec wrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper context across fenced blocks', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '```bash\ncd apps/keeper\n```\n\n```bash\ncd apps/indexer\nwrangler deploy\n```\n',
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

  it('KNOWN LIMIT: reports a deploy inside a multi-line quoted string', () => {
    // Documented rather than fixed (#1924 r27). Distinguishing a command from
    // the same text inside a quoted argument needs shell WORD analysis, and
    // the attempts at that in this loop kept breaking real cases — most
    // recently by blanking `"$KEEPER_DIR"`, which is exactly how the wrapper
    // fixtures identify keeper scope. This over-reports in an obscure case
    // (a keeper-tree shell script printing a multi-line string containing the
    // command) and the workaround is to reword the string. Over-reporting is
    // the safe direction here PROVIDED it stays rare; if this ever fires on
    // real content, that is the signal to reconsider rather than to widen the
    // allowlist.
    const r = runWith(
      'apps/keeper/x.sh',
      'printf "%s" "line1\n# wrangler deploy \\\nline3"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a later --no- negation that re-enables via a positive flag', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --no-keep-vars --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a safe deploy inside a workflow run: block', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: |\n          cd apps/keeper\n          wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a bare --dry-run followed by another option', () => {
    // The stricter true-only rule briefly read the strip placeholder as this
    // flag's value and failed a correct bundle check.
    const r = runWith(
      'apps/keeper/x.sh',
      'wrangler deploy --dry-run --outdir /tmp/keeper-bundle\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts an explicit --keep-vars=true after the stricter parse', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars=true\n');
    expect(r.ok).toBe(true);
  });

  it('accepts pushd into a sibling app, deploying that one', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pushd apps/indexer\nwrangler deploy\npopd\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper scope from one run block into the next (#1924 r29)', () => {
    // Each Actions step is a fresh shell. Carrying scope across blocks made
    // the first block's cd reject the second block's INDEXER deploy.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: |\n          cd apps/keeper\n          wrangler deploy --keep-vars\n      - run: |\n          cd apps/indexer\n          wrangler \\\n            deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper scope between fenced examples', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '```bash\ncd apps/keeper\nwrangler deploy --keep-vars\n```\n\n```bash\ncd apps/indexer\nwrangler deploy\n```\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts an attached =true even with the split value rules', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars=true\n');
    expect(r.ok).toBe(true);
  });

  it('does not let prose in one file scope a later unrelated deploy (#1924 r30)', () => {
    // Physical (non-shell) lines all had `block === undefined`, so the r29
    // block reset never fired for them and a `cd apps/keeper` in prose
    // rejected an out-of-scope deploy further down the same file.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'First cd apps/keeper and read on.\n\nLater, for the indexer:\n\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a redirection to an ordinary file alongside a safe deploy', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy --keep-vars > deploy.log\n');
    expect(r.ok).toBe(true);
  });

  it('accepts stderr redirection before the safety flag (#1924 r31)', () => {
    // The `&` in `2>&1` is not a command separator; treating it as one split
    // the command and REJECTED a safe deploy.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy 2>&1 --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts global flags before the subcommand on a safe deploy', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler --cwd apps/keeper deploy --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('keeps allowlisted prose exempt after a non-shell fenced block', () => {
    // A ```jsonc opener was skipped while its CLOSING fence read as an opener,
    // so the prose after it was scanned as shell and three allowlisted README
    // lines were reported on the live tree (#1924 r31).
    const r = runWith(
      'apps/keeper/README.md',
      '```jsonc\n{ "a": 1 }\n```\n\nPrefer the dashboard over `wrangler deploy` for this.\n',
    );
    expect(r.ok).toBe(true);
  });

  it("accepts bash's combined &> redirection before the flag (#1924 r32)", () => {
    // The leading `&` is part of the redirection, not a command separator.
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy &> deploy.log --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts the &>> append form as well', () => {
    const r = runWith('apps/keeper/x.sh', 'wrangler deploy &>> deploy.log --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('accepts a version-qualified executable with the flag', () => {
    const r = runWith('apps/keeper/x.sh', 'npx wrangler@4.90.0 deploy --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('does not close a long fence on a shorter one inside it', () => {
    // A ```` block may legitimately contain a ``` line; closing early would
    // leave the remainder scanned with the wrong model.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '````bash\ncd apps/keeper\nwrangler deploy --keep-vars\n````\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a non-shell fence whose info string mentions bash', () => {
    // The LANGUAGE is the first word; a jsonc block titled "bash example" is
    // not shell and must not be scanned as such.
    const r = runWith(
      'apps/keeper/README.md',
      '```jsonc title="bash example"\n{ "a": 1 }\n```\n\nPrefer the dashboard over `wrangler deploy` for this.\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not treat a cd to another app after a preamble as keeper scope', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/indexer\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('the last cd also decides scope in the other direction (#1924 r36)', () => {
    // `cd apps/keeper; cd apps/indexer` ends in the INDEXER directory — taking the
    // first match rejected this correct wrapper.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/keeper; cd apps/indexer\nwrangler deploy\n',
    );
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

  it('a same-line cd away from the keeper applies BEFORE the deploy (#1924 r37)', () => {
    // The shell reaches this line in apps/keeper, then leaves. The deploy that
    // FOLLOWS the cd runs from apps/indexer, so it is not the keeper's.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper\ncd ../indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a same-line cd INTO the keeper still catches the deploy after it (#1924 r37)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd ../indexer\ncd apps/keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('flags a keeper deploy in a multiline DOUBLE-QUOTED run scalar (#1924 r37)', () => {
    // YAML folds this to `cd apps/keeper; wrangler deploy` before the shell
    // sees it; the physical scan sees scope and deploy on separate lines.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: "cd apps/keeper;\n          wrangler deploy"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('flags a keeper deploy in a multiline SINGLE-QUOTED run scalar (#1924 r37)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      "jobs:\n  d:\n    steps:\n      - run: 'cd apps/keeper;\n          wrangler deploy'\n",
    );
    expect(r.ok).toBe(false);
  });

  it('flags a keeper deploy in a multiline PLAIN run scalar (#1924 r37)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: cd apps/keeper;\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a safe deploy in a multiline quoted run scalar (#1924 r37)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: "cd apps/keeper;\n          wrangler deploy --keep-vars"\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not fold a run: scalar in prose that merely mentions it (#1924 r37)', () => {
    // Folding is a YAML rule. Applying it to markdown would join lines the
    // author never joined — the r27 scoping mistake by another door.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'The step is `run: cd apps/keeper;`\nand then wrangler deploy is described.\n',
    );
    expect(r.ok).toBe(true);
  });

  it('reports a folded run scalar ONCE, at the run: line (#1924 r37)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: "cd apps/keeper;\n          wrangler deploy"\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('deploy.yml:4');
    expect(r.out.match(/deploy\.yml:/g)?.length).toBe(1);
  });

  it('still flags a single-line keeper run: deploy exactly once (#1924 r37)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: cd apps/keeper && wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out.match(/deploy\.yml:/g)?.length).toBe(1);
  });

  it('honours an escaped line break in a double-quoted run scalar (#1924 r38)', () => {
    // YAML removes the break outright; folding it to a space searched
    // `wrangler \\ deploy` and matched nothing.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: "cd apps/keeper; wrangler \\\n          deploy"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('treats a DOUBLED backslash as a literal, not an escaped break (#1924 r38)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: "cd apps/keeper; echo a\\\\\n          wrangler deploy"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('carries a plain run scalar across a BLANK line (#1924 r38)', () => {
    // YAML keeps the scalar open; ending extraction at the blank line split
    // the scope from the deploy and passed it.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: cd apps/keeper;\n\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a blank line then a DEDENTED key still ends the scalar (#1924 r38)', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  d:\n    steps:\n      - run: cd apps/keeper\n\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a superseded cd does not scope a later deploy on the same line (#1924 r38)', () => {
    // The walk ends in apps/indexer; the line still CONTAINS `apps/keeper`, and
    // a whole-line fallback let that stale string override the walk.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd ../indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a KEEPER_DIR assignment on the line still scopes the deploy (#1924 r38)', () => {
    // The narrowed fallback must not lose the non-cd ways a line names the
    // keeper — this is what the whole-line test was there for.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'KEEPER_DIR=apps/keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the subshell form still scopes the deploy after the narrowing (#1924 r38)', () => {
    const r = runWith(
      'contracts/script/deploy-testnet.sh',
      '( cd "$KEEPER_DIR" && wrangler deploy )\n',
    );
    expect(r.ok).toBe(false);
  });

  it('scans a .bash wrapper (#1924 r38)', () => {
    // Not `.sh`, and `looksExecutable` rejects anything with a dot — so this
    // file was never opened at all.
    const r = runWith(
      'apps/keeper/release.bash',
      '#!/usr/bin/env bash\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('scans a .zsh wrapper (#1924 r38)', () => {
    const r = runWith(
      'apps/keeper/release.zsh',
      '#!/usr/bin/env zsh\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('applies SHELL semantics to a .bash file, not prose semantics (#1924 r38)', () => {
    // A line continuation is a shell rule; the extension must select the shell
    // line model, not just open the file.
    const r = runWith(
      'apps/keeper/release.bash',
      '#!/usr/bin/env bash\nwrangler \\\n  deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('resolves a relative cd BETWEEN siblings (#1924 r39)', () => {
    // `cd apps/indexer; cd ../keeper` ends in apps/keeper; scoring each target
    // as its own boolean saw `../keeper` and recorded non-keeper.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer; cd ../keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('resolves a relative cd back OUT of the keeper (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd ../../apps/indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('keeps a keeper state reachable across a || fallback (#1924 r39)', () => {
    // The left cd succeeds in this tree, so the deploy runs from the keeper;
    // applying both cds unconditionally ended in indexer scope.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper || cd apps/indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('flags the other || order too — keeper is still reachable (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer || cd apps/keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('&& does NOT keep the pre-cd state reachable (#1924 r39)', () => {
    // Unlike ||, the right-hand side of && runs only when the cd SUCCEEDED, so
    // apps/indexer is the only reachable state. Modelling both would be a false
    // positive.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer && wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('pushd/popd still restore the directory through the state set (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pushd apps/keeper; pushd ../indexer; popd; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects --keep-vars\\=false, which bash passes as --keep-vars=false (#1924 r39)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nwrangler deploy --keep-vars\\=false\n',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects --keep-vars"="false (#1924 r39)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nwrangler deploy --keep-vars"="false\n',
    );
    expect(r.ok).toBe(false);
  });

  it("rejects --keep-vars'='false (#1924 r39)", () => {
    const r = runWith(
      'apps/keeper/release.sh',
      "#!/usr/bin/env bash\nwrangler deploy --keep-vars'='false\n",
    );
    expect(r.ok).toBe(false);
  });

  it('still accepts a plain --keep-vars after the normalisation (#1924 r39)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nwrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('an unresolvable cd target is assumed to succeed (#1924 r40)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd "$INDEXER_DIR"; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects --keep-vars"=true garbage", one bash argument (#1924 r40)', () => {
    // Wrangler parses `--keep-vars=true garbage` as false; dropping the
    // opening quote let the matcher stop at the space and read `true`.
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nwrangler deploy --keep-vars"=true garbage"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('still accepts --keep-vars"=true" after the quote move (#1924 r40)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nwrangler deploy --keep-vars"=true"\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not accept a package script quoted inside a value (#1924 r40)', () => {
    // Bash runs a BARE wrangler deploy here; `pnpm run deploy` is just text
    // inside an environment assignment.
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nNOTE=" pnpm run deploy" wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('still accepts the package script as the executed command (#1924 r40)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\npnpm --filter @vaipakam/keeper run deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts the package script behind an env assignment it really uses (#1924 r40)', () => {
    const r = runWith(
      'apps/keeper/release.sh',
      '#!/usr/bin/env bash\nCI=1 pnpm run deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not flag ops/mesh-watcher, verified clean rather than assumed (#1933)', () => {
    // Out of scope on EVIDENCE, not caution: every non-secret, non-binding name
    // its source reads is declared in its own wrangler config, so a bare deploy
    // deletes nothing. Re-verify if that config changes — this expectation is a
    // record of an audit, not a permanent property.
    const r = runWith(
      'ops/mesh-watcher/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  }\n}\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not flag ops/offchain-data-warm, which only LOOKS unsafe (#1933)', () => {
    // Its wrangler config carries `"vars": {}` and its source reads three names
    // absent from it, which is the shape that put it on #1933's audit list. All
    // three are accounted for: TG_OPS_CHAT_ID is a SECRET there (secrets survive
    // a deploy), and the two ARCHIVE_FIRST_* vars are set by pasting them into
    // the COMMITTED config — its own tooling prints them for that purpose and
    // says they are "NOT secrets". A value that lives in the config is
    // re-applied by every deploy. Scoping it would have contradicted a correct
    // README on a wrong classification.
    const r = runWith(
      'ops/offchain-data-warm/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  }\n}\n',
    );
    expect(r.ok).toBe(true);
  });
});

/**
 * #1933 — the guard covers apps/agent too.
 *
 * The premise: `apps/agent/src/env.ts` reads `RECIPIENT_VALIDATING_TOKENS` and
 * `OPENSEA_OFFERS_MAX_PAGES`, and `apps/agent/wrangler.jsonc` declares neither
 * (the latter appears there only inside a comment). A bare deploy therefore
 * switches recipient-token validation off and resets OpenSea pagination — the
 * same failure the keeper half exists to prevent, and Codex found nine bare
 * agent invocations across #1924 r42 and r43 while the guard could not see
 * them.
 *
 * Every scoping form the keeper half supports is re-tested here rather than
 * assumed, because the generalisation replaced a hard-coded predicate with a
 * table and a table can be wrong per row.
 */
describe('check-deploy-invocations — apps/agent scope (#1933)', () => {
  it('a bare deploy inside the agent tree, scoped by location', () => {
    const r = runWith('apps/agent/release.sh', 'wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('the agent package manifest, the canonical entry point', () => {
    const r = runWith(
      'apps/agent/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy"\n  }\n}\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the pnpm-filter exec form', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'pnpm --filter @vaipakam/agent exec wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the multiline cd form, where the deploy line names nothing', () => {
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('the $AGENT_DIR subshell form — the exact r43 finding', () => {
    const r = runWith(
      'contracts/script/deploy-testnet.sh',
      '( cd "$AGENT_DIR" && pnpm exec wrangler deploy )\n',
    );
    expect(r.ok).toBe(false);
  });

  it('brace notation naming the agent among siblings', () => {
    const r = runWith(
      'docs/DesignsAndPlans/CloudflareStagingDeployPlan.md',
      'Deploy apps/{keeper,indexer,agent} with `wrangler deploy`.\n',
    );
    expect(r.ok).toBe(false);
  });

  it('names the AGENT package and its vars in the remedy, not the keeper (#1933)', () => {
    // The message is the whole product for a reader: a keeper-worded remedy
    // beside an agent violation sends them to the wrong wrangler.jsonc and the
    // wrong pnpm filter.
    const r = runWith('apps/agent/release.sh', 'wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('pnpm --filter @vaipakam/agent run deploy');
    expect(r.out).toContain('RECIPIENT_VALIDATING_TOKENS');
    expect(r.out).not.toContain('HF_SCALE');
  });

  it('still accepts a safe agent deploy', () => {
    const r = runWith('apps/agent/release.sh', 'wrangler deploy --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('does not let a keeper cd bless an agent deploy, or the reverse', () => {
    // The table must not collapse the two scopes into one boolean: each package
    // has its own directory, and a deploy is judged against the scope it is
    // actually in.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper\ncd ../agent\nwrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('composes TWO allowlisted quotes on one line (#1933)', () => {
    // docs/ToDo.md's OP-001 entry records the same completed operator action
    // twice on a single line. Removing only the first exemption left the second
    // standing and reported the line; exemptions have to compose. What is tested
    // afterwards is whatever is LEFT, so the r27 property is unaffected.
    const r = runWith(
      'docs/ToDo.md',
      'added the matching binding to `apps/agent/wrangler.jsonc` + `npx wrangler deploy` (live version x) ' +
        'and later: the commented block shows the exact declaration; replace `<chosen-id>` with the id from step 2) + `cd apps/agent && npx wrangler deploy`\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a deploy from a SUBDIRECTORY of a scoped package (#1995 r1)', () => {
    // wrangler walks UP for its config: verified against the repo's 4.90.0, a
    // dry run from apps/agent/src reports `Processing ../wrangler.jsonc`. The
    // end-anchored cwd test missed it — a bug that predates #1933, since the
    // keeper-only predicate was anchored the same way.
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/agent/src\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('the same subdirectory form for the keeper (#1995 r1)', () => {
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/keeper/scripts\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('--config pointing at a scoped package from outside it (#1995 r1)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy --config ../agent/wrangler.jsonc\n',
    );
    expect(r.ok).toBe(false);
  });

  it('--cwd pointing at a scoped package from outside it (#1995 r1)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy --cwd ../agent\n',
    );
    expect(r.ok).toBe(false);
  });

  it('--name naming the deployed Worker, with no path at all (#1995 r1)', () => {
    const r = runWith('docs/ops/DeploymentRunbook.md', 'wrangler deploy --name vaipakam-agent\n');
    expect(r.ok).toBe(false);
  });

  it('attributes a two-package prose line to the ACTUAL offender (#1995 r1)', () => {
    // Reported under apps/keeper before the fix — purely because it is first in
    // SCOPED — so the reader got the keeper's filter and HF_SCALE remedy beside
    // an agent problem. Scope has to come from the segment carrying the unsafe
    // command, not from the line.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'For apps/keeper use pnpm run deploy; for apps/agent use wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/agent');
    expect(r.out).toContain('RECIPIENT_VALIDATING_TOKENS');
    expect(r.out).not.toContain('HF_SCALE');
  });

  it("the -c alias for --config, wrangler's documented short form (#1995 r2)", () => {
    // 4.90.0 help: "-c, --config  Path to Wrangler configuration file". Handling
    // only the long spelling left the identical bypass open in short form.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy -c ../agent/wrangler.jsonc\n',
    );
    expect(r.ok).toBe(false);
  });

  it('--config resolved FROM --cwd when both are given (#1995 r2)', () => {
    // `--cwd` runs wrangler as if started there, so a relative `--config` is
    // relative to IT. Resolving the two independently let this through; a 4.90.0
    // dry run confirms the command bundles the agent.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'wrangler deploy --cwd apps/indexer --config ../agent/wrangler.jsonc\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an explicit --name OVERRIDES incidental segment text (#1995 r2)', () => {
    // The segment says keeper; the selector says agent; wrangler obeys the
    // selector. Reporting the keeper's remedy here sends the reader to the wrong
    // wrangler.jsonc — the same class as r1c, one level deeper.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'For apps/keeper: wrangler deploy --name vaipakam-agent\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/agent');
    expect(r.out).not.toContain('HF_SCALE');
  });

  it('an explicit selector targeting an UNSCOPED Worker is not flagged (#1995 r2)', () => {
    // The other direction of the same precedence rule, and the one that makes it
    // a real rule rather than a one-way ratchet: standing in apps/agent does not
    // make a deploy of the indexer unsafe.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrangler deploy --name vaipakam-indexer\n',
    );
    expect(r.ok).toBe(true);
  });

  it('an UNRESOLVABLE selector does not suppress cwd scope (#1995 r2)', () => {
    // `--config "$CFG"` says nothing, so it must not override the fact that the
    // shell is standing in apps/agent. Treating "selector present" as
    // "authoritative" regardless of whether it resolved would have opened a
    // bypass that is trivial to write by accident.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrangler deploy --config "$CFG"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a resolved --name survives another selector being dynamic (#1995 r3)', () => {
    // wrangler's getScriptName is `args.name ?? config.name`, so the explicit
    // name decides regardless of what the config path turns out to be. A single
    // early return on "any value is dynamic" threw the resolved name away.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy --name vaipakam-agent --config "$CFG"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a relative --config in PROSE defers to the textual scope (#1995 r3)', () => {
    // No shell state on the prose path, so resolving `wrangler.jsonc` against an
    // invented empty cwd produced "targets nothing" — which then suppressed the
    // correct textual scope. Unresolved must mean defer, not decide.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'From apps/agent, run `wrangler deploy --config wrangler.jsonc`\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a relative --cwd in PROSE is read by what it NAMES (#1995 r3)', () => {
    // `../agent` cannot be resolved without knowing where the reader stands, but
    // its trailing segment identifies the package on its own — and nothing else
    // on this line names the agent.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'From apps/indexer, run `wrangler deploy --cwd ../agent`\n',
    );
    expect(r.ok).toBe(false);
  });

  it('that segment match is by whole PATH SEGMENT, not prefix (#1995 r3)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'From apps/indexer, run `wrangler deploy --cwd ../agent-backup`\n',
    );
    expect(r.ok).toBe(true);
  });

  it('selector text inside another option value is not a selector (#1995 r3)', () => {
    // The fake name parsed as real and then AUTHORITATIVELY suppressed the cwd
    // scope of a bare agent deploy — a bypass anyone could write by accident in
    // a deployment message.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrangler deploy --message="note --name vaipakam-indexer"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('does not claim a longer sibling package by prefix (#1995 r3)', () => {
    // `apps/agent-backup` is a different, out-of-scope directory. This guard
    // blocks an unfiltered CI job, so a false red here is expensive.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Deploy apps/agent-backup with wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('nor by a prefixed pnpm filter name (#1995 r3)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Use @vaipakam/agent-tools then wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a selector value assembled from adjacent quoted chunks (#1995 r4)', () => {
    // `--name vaipakam"-"agent` is ONE shell argument, `vaipakam-agent`.
    // Capturing only the first chunk made the value `vaipakam`, and that
    // non-match then read as authoritative no-scope.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy --name vaipakam"-"agent\n',
    );
    expect(r.ok).toBe(false);
  });

  it('selector text in a leading ENV ASSIGNMENT is not a selector (#1995 r4)', () => {
    // `NOTE="--name vaipakam-indexer" wrangler deploy` passes no such option —
    // the shell puts it in the environment — but the fake name was suppressing
    // the cwd scope of a bare agent deploy.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nNOTE="--name vaipakam-indexer" wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a keep-vars flag in a leading ENV ASSIGNMENT does not bless (#1995 r6)', () => {
    // The mirror of the r4 selector case, on the SAFETY predicate rather than
    // the scope one. The shell passes NOTE through the environment, so wrangler
    // receives a bare deploy — but `flagEnabled` read the raw segment and found
    // `--keep-vars` inside the quoted value.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nNOTE="--keep-vars" wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a for LOOP binds its variable like an assignment (#1995 r12)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nfor TARGET in apps/agent; do\n  cd "$TARGET"\n  wrangler deploy\ndone\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a loop over several values models the protected one (#1995 r12)', () => {
    // Each iteration binds a different value; the one that lands in a scoped
    // package is the iteration that deploys from it.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nfor T in apps/indexer apps/agent; do\n  cd "$T"\n  wrangler deploy\ndone\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a loop with no scoped value binds nothing (#1995 r12 control)', () => {
    for (const list of ['apps/indexer', '$LIST']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `#!/usr/bin/env bash\nfor T in ${list}; do\n  cd "$T"\n  wrangler deploy\ndone\n`,
      );
      expect(r.ok, list).toBe(true);
    }
  });

  it('wrangler versions upload erases vars too (#1995 r14)', () => {
    // The installed wrangler documents the same sentence for this subcommand:
    // without --keep-vars it deletes all vars before setting the config's.
    for (const cmd of ['wrangler versions upload', 'pnpm exec wrangler versions upload']) {
      const r = runWith('contracts/script/deploy-chain.sh', `cd apps/agent\n${cmd}\n`);
      expect(r.ok, cmd).toBe(false);
    }
  });

  it('versions upload takes the SAME remedy (#1995 r14 control)', () => {
    for (const flag of ['--keep-vars', '--dry-run']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `cd apps/agent\nwrangler versions upload ${flag}\n`,
      );
      expect(r.ok, flag).toBe(true);
    }
  });

  it('other versions subcommands are not deploys (#1995 r14 control)', () => {
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/agent\nwrangler versions list\n');
    expect(r.ok).toBe(true);
  });

  it('a matrix working-directory resolves to its declared values (#1995 r11)', () => {
    // One leg of the matrix really does deploy from the protected package.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n' +
        '        dir: [apps/agent, apps/indexer]\n    steps:\n' +
        '      - run: wrangler deploy\n        working-directory: ${{ matrix.dir }}\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a matrix with NO protected leg stays quiet (#1995 r11 control)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n' +
        '        dir: [apps/indexer, apps/www]\n    steps:\n' +
        '      - run: wrangler deploy\n        working-directory: ${{ matrix.dir }}\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a sibling YAML key is not folded into the run scalar (#1995)', () => {
    // Pre-existing false red, found while fixing the matrix case above and not
    // reported by review: the step's own `working-directory:` was folded into
    // the shell text, so `--keep-vars` read as having the VALUE
    // `working-directory:` and scored as DISABLED. A correct step reported as
    // a violation, in a check that blocks the unfiltered CI job.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n' +
        '      - run: wrangler deploy --keep-vars\n        working-directory: apps/agent\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a FLOW-style defaults mapping is the same configuration (#1995 r13)', () => {
    // `defaults: { run: { working-directory: X } }` is valid YAML for the same
    // Actions setting; only the block form was recognised.
    for (const [name, yml] of [
      [
        'workflow level',
        'name: w\ndefaults: { run: { working-directory: apps/agent } }\n' +
          'jobs:\n  d:\n    steps:\n      - run: wrangler deploy\n',
      ],
      [
        'job level',
        'name: w\njobs:\n  d:\n    defaults: { run: { working-directory: apps/agent } }\n' +
          '    steps:\n      - run: wrangler deploy\n',
      ],
    ] as const) {
      const r = runWith('.github/workflows/w.yml', yml);
      expect(r.ok, name).toBe(false);
      expect(r.out, name).toContain('apps/agent');
    }
  });

  it('a job-level FLOW defaults does not leak to a later job (#1995 r13)', () => {
    // r8's property, restated for the flow spelling.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  a:\n    defaults: { run: { working-directory: apps/agent } }\n' +
        '    steps:\n      - run: echo hi\n  b:\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('cd through a bash command builtin still moves the shell (#1995 r14)', () => {
    // `help builtin` / `help command`: both run cd in the CURRENT shell.
    for (const via of ['builtin', 'command']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `${via} cd apps/agent\nwrangler deploy\n`,
      );
      expect(r.ok, via).toBe(false);
      expect(r.out, via).toContain('apps/agent');
    }
  });

  it('cd - returns to OLDPWD, not a directory named - (#1995 r14)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\ncd ../indexer\ncd -\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('cd - with no previous directory returns to the root (#1995 r14)', () => {
    // The control: OLDPWD is the repo root here, which is not a scoped
    // package, so this must stay quiet rather than resolve somewhere.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\ncd -\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('...<pattern> reaches the pattern\'s DEPENDENTS (#1995 r9)', () => {
    // Both protected packages declare @vaipakam/lib, so pnpm selects both.
    // Stripping the dots reduced this to a literal no package has.
    seedWorkspace();
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter ...@vaipakam/lib run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
    expect(r.out).toContain('apps/keeper');
  });

  it('...<pattern> does NOT over-report (#1995 r9)', () => {
    // The keeper does not depend on the agent, so it must not be named. A
    // blanket "attribute every ... selector to everything" would report it.
    seedWorkspace();
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter ...@vaipakam/agent run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
    expect(r.out).not.toContain('apps/keeper');
  });

  it('a ... selector matching nothing selects nothing (#1995 r9)', () => {
    seedWorkspace();
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter ...@vaipakam/nothing run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(true);
  });

  it('a JSON script value is split on its own operators (#1995 r14)', () => {
    // The enclosing double quotes are JSON, not shell. Treating them as shell
    // quoting meant the `&&` never split, and the trailing safe flag blessed a
    // value whose FIRST command erases the dashboard vars.
    const r = runWith(
      'apps/agent/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy && wrangler deploy --keep-vars"\n  }\n}\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a JSON script that is wholly safe still passes (#1995 r14 control)', () => {
    const r = runWith(
      'apps/agent/package.json',
      '{\n  "scripts": {\n    "deploy": "wrangler deploy --keep-vars"\n  }\n}\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a safety flag inside a COMMAND SUBSTITUTION does not bless (#1995 r14)', () => {
    // The substitution writes to stderr and contributes no argument, so this
    // is a bare deploy — but its source text contains --keep-vars.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrangler deploy $(echo --keep-vars >&2)\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a REAL safety flag is still safe (#1995 r14 control)', () => {
    for (const flag of ['--keep-vars', '--dry-run']) {
      const r = runWith('contracts/script/deploy-chain.sh', `cd apps/agent\nwrangler deploy ${flag}\n`);
      expect(r.ok, flag).toBe(true);
    }
  });

  it('a backticked command in PROSE is not blanked (#1995 r14 control)', () => {
    // Backticks are deliberately left alone: in prose the command being judged
    // sits inside a Markdown code span, and blanking it would delete it.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'In apps/agent run `wrangler deploy --keep-vars` now.\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a dynamic reassignment CLEARS the stale binding (#1995 r14)', () => {
    // Without this, the scanner kept resolving TARGET to the keeper and
    // reported a keeper violation for a command that enters the agent — the
    // wrong package named in the remedy. Deleting the binding does not let the
    // agent deploy be DETECTED (the substitution's value is unknowable here);
    // it stops the guard asserting a package it cannot know.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nTARGET=apps/keeper\nTARGET=$(printf %s apps/agent)\n' +
        'cd "$TARGET"\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a re-bound LITERAL still wins (#1995 r14 control)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nTARGET=apps/indexer\nTARGET=apps/agent\ncd "$TARGET"\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('wrangler2 is the same executable (#1995 r13)', () => {
    // wrangler's manifest maps both names to ./bin/wrangler.js.
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/agent\npnpm exec wrangler2 deploy\n');
    expect(r.ok).toBe(false);
  });

  it('wrangler2 with --keep-vars is safe (#1995 r13 control)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\npnpm exec wrangler2 deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a declaration builtin still binds the variable (#1995 r12)', () => {
    // `export TARGET=apps/agent` binds exactly as the bare form does; only the
    // bare spelling was recognised, so `cd "$TARGET"` cleared scope instead of
    // entering the protected package.
    for (const decl of ['export', 'declare', 'readonly', 'declare -r']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `#!/usr/bin/env bash\n${decl} TARGET=apps/agent\ncd "$TARGET"\nwrangler deploy\n`,
      );
      expect(r.ok, decl).toBe(false);
      expect(r.out, decl).toContain('apps/agent');
    }
  });

  it('a declared value that is COMPUTED stays unremembered (#1995 r12)', () => {
    // The safe direction is preserved: an unknown variable clears scope rather
    // than inventing one.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nexport TARGET=$OTHER\ncd "$TARGET"\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it("npm's run ALIASES are safe when they invoke the safe script (#1995 r11)", () => {
    // r10 widened the DETECTOR for rum/urn and left the SAFETY matcher on
    // run|run-script, so these became candidates that could never be judged
    // safe — a false red on the command the guard's own remedy recommends.
    for (const alias of ['rum', 'urn', 'run-script']) {
      const r = runWith('contracts/script/deploy-chain.sh', `cd apps/agent\nnpm ${alias} deploy\n`);
      expect(r.ok, alias).toBe(true);
    }
  });

  it('an alias with a negation appended is still caught (#1995 r11)', () => {
    // The other direction: sharing the alias list must not make the aliases
    // unconditionally safe.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nnpm rum deploy -- --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a BRACE GROUP runs in the current shell and its cd persists (#1995 r12)', () => {
    // The mirror of the subshell cases: `{ … ; }` is not a subshell, so the
    // move is real and the next line's bare deploy is the agent's.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '{ cd apps/agent; }\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a ( ) subshell still does NOT persist (#1995 r12 control)', () => {
    // The distinction the brace fix must not blur.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '( cd apps/agent )\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('{cd without a space is a command name, not a group (#1995 r12)', () => {
    // bash requires the space; `{cd` is the command `{cd`.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '{cd apps/agent; }\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a ( ) subshell cannot move the parent either (#1995 r13)', () => {
    // The r9 fix covered `|` and `&` and stopped there. Bash stays in
    // apps/agent; the scanner recorded the indexer and let the deploy through.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\n(echo x; cd ../indexer)\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a && CHAIN deploys from where the chain leaves it (#1995 r15)', () => {
    // The deploy runs only if BOTH moves succeeded, so it runs from the
    // indexer — which is not a protected package. Reporting the agent was a
    // false red introduced by r13's union.
    for (const body of [
      'cd apps/agent && cd ../indexer && wrangler deploy\n',
      'cd apps/agent && cd ../indexer\nwrangler deploy\n',
    ]) {
      const r = runWith('contracts/script/deploy-chain.sh', body);
      expect(r.ok, body).toBe(true);
    }
  });

  it('a cd on the right of && may never run (#1995 r13)', () => {
    // `false && cd ../indexer` moves nothing, so the deploy is still judged
    // against apps/agent.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nfalse && cd ../indexer\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a cd INSIDE a subshell still applies within it (#1995 r13)', () => {
    // The other side: restoring on `)` must not blind the deploy that sits
    // inside the same subshell.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '( cd apps/agent && wrangler deploy )\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a cd in a PIPELINE runs in a subshell and does not move the parent (#1995 r9)', () => {
    // bash is still in apps/agent when the deploy runs; the scanner had
    // recorded the indexer and let the protected bare deploy through.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent; cd ../indexer | cat; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a plain cd on the same line DOES move the parent (#1995 r9)', () => {
    // The control: without the pipeline the move is real, and the indexer is
    // not a protected package.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent; cd ../indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a deploy that is itself piped keeps its scope (#1995 r9)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent; wrangler deploy | tee log\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a positive and its own negation select NOTHING (#1995 r9)', () => {
    // pnpm reports no projects for this pair, so reporting either package is a
    // false red. Previously the negation's complement was added independently
    // and it came out as a keeper violation.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter @vaipakam/agent --filter '!@vaipakam/agent' run --if-present deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(true);
  });

  it('negations SUBTRACT from the positive selection (#1995 r9)', () => {
    // The glob selects both protected packages; the negation removes one, so
    // only the agent should be reported — not both, and not neither.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter '@vaipakam/*' --filter '!@vaipakam/keeper' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
    expect(r.out).not.toContain('apps/keeper');
  });

  it('a negation ALONE still selects everything else (#1995 r8)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter '!@vaipakam/indexer' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
    expect(r.out).toContain('apps/keeper');
  });

  it('a top-level defaults: applies wherever it is declared (#1995 r10)', () => {
    // YAML mapping order is not significant, so a workflow may declare `jobs:`
    // first and `defaults:` after it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - run: wrangler deploy\n' +
        'defaults:\n  run:\n    working-directory: apps/agent\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a JOB-level defaults: still does not leak to a later job (#1995 r8)', () => {
    // The property the indent test must preserve: selecting top-level
    // `defaults:` by indent must not start admitting job-level ones.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  a:\n    defaults:\n      run:\n' +
        '        working-directory: apps/agent\n    steps:\n      - run: echo hi\n' +
        '  b:\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('an explicit cd OUTRANKS where the wrapper file lives (#1995 r9)', () => {
    // Script inside apps/agent, but the shell moves to the indexer, which is
    // not a protected package. Reporting it as an agent violation is a false
    // red in a check that blocks the unfiltered CI job.
    for (const body of [
      'cd apps/indexer; wrangler deploy\n',
      'cd apps/indexer\nwrangler deploy\n',
    ]) {
      const r = runWith('apps/agent/deploy.sh', body);
      expect(r.ok, body).toBe(true);
    }
  });

  it('the file-path fallback still applies with no cd (#1995 r9)', () => {
    // The other half: without an explicit cd, living inside the package IS the
    // scope, and suppressing the fallback unconditionally would lose it.
    const r = runWith('apps/agent/deploy.sh', 'wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a cd to ANOTHER scoped package re-attributes it (#1995 r9)', () => {
    const r = runWith('apps/agent/deploy.sh', 'cd apps/keeper\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/keeper');
  });

  it("wrangler stops parsing options at -- (#1995 r10)", () => {
    // `wrangler deploy -- --dry-run` is a LIVE bare deploy; the flag after the
    // terminator is inert.
    for (const tail of ['--dry-run', '--keep-vars']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `cd apps/agent\nwrangler deploy -- ${tail}\n`,
      );
      expect(r.ok, tail).toBe(false);
    }
  });

  it('-- BEFORE the command ends the package manager\'s options, not wrangler\'s (#1995 r10)', () => {
    // `pnpm exec -- wrangler deploy --keep-vars` is a SAFE deploy. Cutting at
    // the first `--` anywhere reported it as a violation — a CI-blocking false
    // red, and the case that no fixture covered until the mutation exposed it.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\npnpm exec -- wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it("a package manager FORWARDS past -- and still counts (#1995 r10)", () => {
    // The mirror of the case above: truncating at `--` unconditionally would
    // have blessed this, which is the destructive one.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run deploy -- --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a safety flag inside a shell COMMENT does not bless (#1995 r10)', () => {
    // Copying this line into a terminal performs the bare deploy: the shell
    // ignores everything after `#`.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Run apps/agent: `wrangler deploy # TODO: add --keep-vars`\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a # inside a URL is not a comment (#1995 r10)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'See https://x/#f — in apps/agent run `wrangler deploy --keep-vars`\n',
    );
    expect(r.ok).toBe(true);
  });

  it("pnpm's -F is --filter (#1995 r10)", () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm -F '@vaipakam/*gent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
  });

  it("npm's rum and urn are run (#1995 r10)", () => {
    // `npm run --help` lists run-script, rum and urn as aliases.
    for (const alias of ['rum', 'urn']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `cd apps/agent\nnpm ${alias} deploy -- --no-keep-vars\n`,
      );
      expect(r.ok, alias).toBe(false);
    }
  });

  it("npm's --workspaces fans out like pnpm's -r (#1995 r10)", () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'npm --workspaces --if-present run deploy -- --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it("a changed-since filter may reach any package (#1995 r10)", () => {
    // `[<ref>]` selects whatever changed since that ref, which the text cannot
    // tell us — attributed to every scoped package, as `-r` is.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter '[abc123]' exec wrangler deploy\n",
    );
    expect(r.ok).toBe(false);
  });

  it("pnpm's --dir and wrangler's --cwd COMPOSE (#1995 r9)", () => {
    // pnpm moves to ../agent, then wrangler starts where it was left, so
    // `--cwd .` is the agent. Reading only one of the two resolved wrangler's
    // path straight from the shell cwd and the deploy escaped.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\npnpm --dir ../agent exec wrangler deploy --cwd .\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("pnpm's recursive COMMAND aliases fan out like -r (#1995 r9)", () => {
    // `pnpm help recursive` documents recursive/multi/m as running an action
    // across every package, so each reaches both protected Workers.
    for (const alias of ['recursive', 'multi', 'm']) {
      const r = runWith(
        'contracts/script/deploy-chain.sh',
        `pnpm ${alias} --if-present run deploy --no-keep-vars\n`,
      );
      expect(r.ok, alias).toBe(false);
    }
  });

  it("npm's --prefix moves the package cwd like pnpm's --dir (#1995 r9)", () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nnpm --prefix ../agent run deploy -- --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a composed wrangler COMMAND name still counts as a deploy (#1995 r9)', () => {
    // The dequoted fallback existed but tested only the package-script
    // alternation, so a composed DIRECT wrangler command skipped the whole
    // file at the prefilter.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrang"ler" deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a composed wrangler SUBcommand still counts as a deploy (#1995 r9)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nwrangler de"ploy"\n',
    );
    expect(r.ok).toBe(false);
  });

  it('composed package scripts are caught in PROSE too (#1995 r9)', () => {
    // Only the shell path dequoted, so the same sentence was judged two ways
    // by which file it sat in — and prose is what an operator copies.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'From apps/agent run `pnpm run de"ploy" --no-keep-vars` before the cutover.\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a composed literal assignment is still remembered (#1995 r9)', () => {
    // `TARGET=apps/"agent"` is the literal `apps/agent` to bash. The
    // single-chunk matcher rejected it, so the variable stayed unremembered and
    // the later `cd "$TARGET"` cleared scope instead of entering the agent.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      '#!/usr/bin/env bash\nTARGET=apps/"agent"\ncd "$TARGET"\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a dry-run flag in a leading ENV ASSIGNMENT does not bless (#1995 r6)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent\nNOTE="--dry-run" wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a DOT-continued sibling name is not the scoped package (#1995 r4)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Deploy apps/agent.backup with wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but a sentence-ending period still matches (#1995 r4)', () => {
    // The commonest spelling in a runbook. Disallowing `.` outright to fix the
    // case above would have stopped matching this one.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Deploy apps/agent. Then verify with wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a negating flag appended to the package script (#1995 r4)', () => {
    // `run deploy --no-keep-vars` expands to
    // `wrangler deploy --keep-vars --no-keep-vars` => keepVars:false. The line
    // contains no `wrangler deploy` at all, so nothing examined it before.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('the same negation spelled --keep-vars=false (#1995 r4)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run deploy --keep-vars=false\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and in PROSE telling an operator to run it (#1995 r4)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Run `pnpm --filter @vaipakam/agent run deploy --no-keep-vars` to redeploy.\n',
    );
    expect(r.ok).toBe(false);
  });

  it('still accepts the plain package script, in shell and in prose (#1995 r4)', () => {
    // The widened detection must not report the RECOMMENDED command — it
    // appears in this guard's own remedy text and across the runbooks, so a
    // false positive here would be immediate and everywhere.
    expect(
      runWith('contracts/script/deploy-chain.sh', 'pnpm --filter @vaipakam/agent run deploy\n').ok,
    ).toBe(true);
    expect(
      runWith(
        'docs/ops/DeploymentRunbook.md',
        'Use `pnpm --filter @vaipakam/agent run deploy` (the script carries the flag).\n',
      ).ok,
    ).toBe(true);
  });

  it('and ignores the package script of an UNSCOPED package (#1995 r4)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/www run deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('the run-script alias of run (#1995 r5)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run-script deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an allowlisted quote does not clear a package-script deploy (#1995 r5)', () => {
    // The residue test looked only for `wrangler deploy`, so once the
    // package-script form counted as a deploy the exemption suppressed it.
    const r = runWith(
      'docs/ToDo.md',
      'added the matching binding to `apps/agent/wrangler.jsonc` + `npx wrangler deploy` (live version x) ' +
        'and pnpm --filter @vaipakam/agent run deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a selector word with a shell ESCAPE (#1995 r5)', () => {
    // The shell hands wrangler `vaipakam-agent`; comparing the escaped form
    // made it an authoritative non-match.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/indexer\nwrangler deploy --name vaipakam\\-agent\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a static suffix beneath a VARIABLE path prefix (#1995 r5)', () => {
    // `cd "$ROOT/apps/agent"` is an ordinary root-relative wrapper: the
    // segments after the variable identify the package wherever $ROOT points.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'ROOT=/workspace/vaipakam\ncd "$ROOT/apps/agent"\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('but a wholly unknown variable target still clears scope (#1924 r40)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd "$INDEXER_DIR"; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a pnpm --filter PATTERN that selects a scoped package (#1995 r5)', () => {
    // pnpm filters accept globs, so neither the package name nor its path need
    // appear literally.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter '@vaipakam/*gent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
  });

  it('a real subdirectory named like a package root (#1995 r5)', () => {
    // `apps/agent/packages/generated` is INSIDE the agent — wrangler walks up
    // from it to the agent's own config. The tail exclusion that used to undo
    // the scanner's sibling-move modelling dropped this valid descendant.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent/packages/generated\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a sibling move still lands on the sibling (#1995 r5)', () => {
    // The case the tail exclusion existed for. A package-root-relative target
    // is repo-relative, so this resolves to apps/indexer rather than nesting.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd apps/indexer\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('npm forwards only what follows -- (#1995 r5)', () => {
    // `npm run deploy --no-keep-vars` passes npm an unknown OPTION and runs the
    // script with nothing appended. Reporting it destructive is a false red on
    // a correct command.
    expect(runWith('apps/agent/x.sh', 'npm run deploy --no-keep-vars\n').ok).toBe(true);
    // After the separator it really is forwarded.
    expect(runWith('apps/agent/y.sh', 'npm run deploy -- --no-keep-vars\n').ok).toBe(false);
    // pnpm and yarn forward directly, with no separator needed.
    expect(runWith('apps/agent/z.sh', 'pnpm run deploy --no-keep-vars\n').ok).toBe(false);
  });

  it('an unrelated earlier command does not scope a later deploy (#1995 r5)', () => {
    // `echo apps/agent` cannot establish a target; the `cd` moves to the
    // out-of-scope indexer. Carrying every preceding command's text forward
    // made this a false red.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'echo apps/agent; cd apps/indexer; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a protected glob that is not the FIRST filter selector (#1995 r6)', () => {
    // pnpm runs on packages satisfying "at least one of the selectors".
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter @vaipakam/indexer --filter '@vaipakam/*gent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
  });

  it('the --filter-prod spelling of the same selector (#1995 r6)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter-prod '@vaipakam/*gent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
  });

  it('reports BOTH packages when one line offends for each (#1995 r6)', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'For apps/keeper run wrangler deploy; for apps/agent run wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/keeper');
    expect(r.out).toContain('@vaipakam/agent');
  });

  it('an assignment value mixing quoted and unquoted chunks (#1995 r6)', () => {
    // bash reads `NOTE=foo" --keep-vars"` as ONE assignment and passes wrangler
    // only `deploy`; the quoted tail was left behind as an apparent flag.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent; NOTE=foo" --keep-vars" wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('sentence punctuation is not part of a --name value in prose (#1995 r6)', () => {
    // `vaipakam-agent.` matched no Worker, and since r2 that non-match was
    // authoritative and erased the correct line scope.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'From apps/agent, run `wrangler deploy --name vaipakam-agent`.\n',
    );
    expect(r.ok).toBe(false);
  });

  it('run options between `run` and the script name (#1995 r6)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run --if-present deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it('cd options before the destination (#1995 r6)', () => {
    // bash `help cd`: `cd [-L|[-P [-e]] [-@]] [dir]`.
    expect(runWith('a.sh', 'cd -P apps/agent; wrangler deploy\n').ok).toBe(false);
    expect(runWith('b.sh', 'cd -L apps/agent; wrangler deploy\n').ok).toBe(false);
  });

  it('a subshell directory change dies with the subshell (#1995 r6)', () => {
    // The deploy runs from the ORIGINAL directory. Carrying the prefix through
    // the rest of the line was a false red in the unfiltered CI job. The second
    // form nets zero parens within one segment, so depth tracking alone misses
    // it — the change has to be recognised as confined.
    expect(
      runWith('a.sh', '(cd apps/agent && echo prepared); wrangler deploy\n').ok,
    ).toBe(true);
    expect(runWith('b.sh', '(cd apps/agent); wrangler deploy\n').ok).toBe(true);
  });

  // NOTE for anyone adding to these: `runWith` writes into the SAME fixture
  // tree for the whole test and re-runs the guard over all of it, so a call
  // expecting `ok: true` must not follow one that planted a violation. Assert
  // the two directions in separate tests rather than relying on ordering.
  it('but a deploy INSIDE the subshell is still scoped (#1924 r8)', () => {
    // The counterpart the fix above must not break: here the deploy is before
    // the closing paren, so the directory change is still in effect.
    const r = runWith('a.sh', '( cd "$AGENT_DIR" && pnpm exec wrangler deploy )\n');
    expect(r.ok).toBe(false);
  });

  it('and its safe form is still accepted (#1924 r8)', () => {
    const r = runWith(
      'b.sh',
      '( cd "$AGENT_DIR" && pnpm exec wrangler deploy --keep-vars )\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a --filter naming a DIRECTORY pattern (#1995 r7)', () => {
    // pnpm documents `--filter ./<dir>` and `{<dir>}`; matching only against
    // package names missed them entirely.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter './apps/*gent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
  });

  it('a run option with an ATTACHED value (#1995 r7)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pnpm --filter @vaipakam/agent run --if-present=true deploy --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
  });

  it("cd's -- option terminator (#1995 r7)", () => {
    const r = runWith('a.sh', 'cd -- apps/agent; wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('ONE filter selecting BOTH packages reports both (#1995 r7)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      "pnpm --filter '@vaipakam/*' run --if-present deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/keeper');
    expect(r.out).toContain('@vaipakam/agent');
  });

  it("a workflow step's working-directory scopes its run body (#1995 r7)", () => {
    // Actions runs the body from `working-directory`, so the run body itself
    // contains no scope text at all.
    const r = runWith(
      '.github/workflows/w.yml',
      'jobs:\n  x:\n    steps:\n      - name: deploy\n        working-directory: apps/agent\n        run: |\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and the defaults.run form of the same (#1995 r7)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'jobs:\n  x:\n    defaults:\n      run:\n        working-directory: apps/agent\n    steps:\n      - run: |\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('but an out-of-scope working-directory is left alone (#1995 r7)', () => {
    // Step precedence must not leak between steps either: the second step here
    // is the agent and is safe.
    const r = runWith(
      '.github/workflows/w.yml',
      'jobs:\n  x:\n    steps:\n      - name: a\n        working-directory: apps/indexer\n        run: |\n          wrangler deploy\n' +
        '      - name: b\n        working-directory: apps/agent\n        run: |\n          wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it("working-directory applies to a SINGLE-LINE run too (#1995 r8)", () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'jobs:\n  x:\n    steps:\n      - name: deploy\n        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    // Reported ONCE despite reaching the reporter as both a physical line and a
    // seeded workflow block.
    expect(r.out.match(/w\.yml:/g) ?? []).toHaveLength(1);
  });

  it('job defaults do not leak into a later job (#1995 r8)', () => {
    // First job defaults to the agent and deploys safely; the second has no
    // defaults and deploys from the repo root. Attributing it to the agent is a
    // false red.
    const r = runWith(
      '.github/workflows/w.yml',
      'jobs:\n  first:\n    defaults:\n      run:\n        working-directory: apps/agent\n' +
        '    steps:\n      - run: |\n          wrangler deploy --keep-vars\n' +
        '  second:\n    steps:\n      - run: |\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but a WORKFLOW-level defaults still applies (#1995 r8)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'defaults:\n  run:\n    working-directory: apps/agent\njobs:\n  only:\n    steps:\n      - run: |\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a NEGATED filter selector reaches both packages (#1995 r8)', () => {
    const r = runWith(
      'a.sh',
      "pnpm --filter '!@vaipakam/indexer' run --if-present deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/keeper');
    expect(r.out).toContain('@vaipakam/agent');
  });

  it('a RECURSIVE workspace run reaches every scoped package (#1995 r8)', () => {
    const r = runWith('a.sh', 'pnpm -r --if-present run deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('@vaipakam/keeper');
    expect(r.out).toContain('@vaipakam/agent');
  });

  it('a filter value assembled from adjacent chunks (#1995 r8)', () => {
    const r = runWith('a.sh', "pnpm --filter '@vaipakam/'\"*gent\" run deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
  });

  it('a cd destination assembled from adjacent chunks (#1995 r8)', () => {
    const r = runWith('a.sh', 'cd "$ROOT"/apps/agent; wrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a script NAME assembled from adjacent chunks (#1995 r8)', () => {
    const r = runWith('apps/agent/a.sh', 'pnpm run de"ploy" --no-keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it("pnpm's own --dir / -C option decides the package (#1995 r8)", () => {
    expect(
      runWith('a.sh', 'cd apps/indexer\npnpm --dir ../agent run deploy --no-keep-vars\n').ok,
    ).toBe(false);
  });

  it('the -C spelling of the same (#1995 r8)', () => {
    expect(
      runWith('b.sh', 'cd apps/indexer\npnpm -C ../agent run deploy --no-keep-vars\n').ok,
    ).toBe(false);
  });

  it('a statically assigned directory variable carries across lines (#1995 r8)', () => {
    // The same commands on ONE line were already rejected; treating every `$` as
    // unknown made the two spellings disagree.
    const r = runWith('a.sh', 'TARGET=apps/agent\ncd "$TARGET"\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a COMPUTED variable still clears scope (#1995 r8)', () => {
    // Only literal assignments are carried; anything with a `$` in its value
    // stays unresolved, per #1924 r40.
    const r = runWith('a.sh', 'TARGET="$BASE/apps/agent"\ncd "$TARGET"\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('prose after a package script is not read as a flag VALUE (#1995 r8)', () => {
    // "`pnpm … run deploy`, whose …" made `,` the value and scored it unsafe —
    // four false reds on the real tree, latent since r4d.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'Use `pnpm --filter @vaipakam/agent run deploy`, whose script carries the flag.\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a negation flag composed from chunks (#1995 r15)', () => {
    // bash passes `--no-keep-"vars"` as `--no-keep-vars`, so the earlier
    // --keep-vars is overridden and the deploy is destructive.
    const r = runWith('a.sh', 'cd apps/agent\nwrangler deploy --keep-vars --no-keep-"vars"\n');
    expect(r.ok).toBe(false);
  });

  it('a quoted paren inside a command substitution (#1995 r15)', () => {
    // The substitution produces no stdout, so the deploy is bare; the quoted
    // `)` ended the depth walk early and left the inert --keep-vars visible.
    const r = runWith('a.sh', "cd apps/agent\nwrangler deploy $(echo ')' --keep-vars >&2)\n");
    expect(r.ok).toBe(false);
  });

  it('a package-root target with a doubled separator (#1995 r15)', () => {
    const r = runWith('a.sh', 'cd apps//agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it("ANSI-C quoting in a path component (#1995 r15)", () => {
    // `$'agent'` is a quoted WORD; leaving the `$` made it read as an
    // unresolved parameter expansion and cleared scope.
    const r = runWith('a.sh', "cd apps/$'agent'\nwrangler deploy\n");
    expect(r.ok).toBe(false);
  });

  it('a colon-terminated prose LABEL scopes the next command line (#1995 r15)', () => {
    const r = runWith('docs/ops/DeploymentRunbook.md', 'From apps/agent, run:\n\n`wrangler deploy`\n');
    expect(r.ok).toBe(false);
  });

  it('but a label naming TWO scoped packages hands over nothing (#1995 r15)', () => {
    // Ambiguous, and this guard blocks the unfiltered CI job.
    const r = runWith('docs/x.md', 'Compare apps/agent and apps/keeper:\n\n`wrangler deploy`\n');
    expect(r.ok).toBe(true);
  });

  it('and intervening prose resets the label (#1995 r15)', () => {
    const r = runWith('docs/x.md', 'From apps/agent, run:\n\nSome prose here.\n\n`wrangler deploy`\n');
    expect(r.ok).toBe(true);
  });

  it('an explicit cd supersedes an earlier assignment on the line (#1995 r15)', () => {
    // A valid bare INDEXER deploy; preferring the unused TARGET text over the
    // modelled cwd was a false red.
    const r = runWith('a.sh', 'TARGET=apps/agent; cd apps/indexer; wrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('while the assignment still resolves a later cd through it (#1995 r15)', () => {
    // Assignments keep feeding shellVars; what they stop doing is standing in
    // for a cwd the shell has since been told.
    const r = runWith('b.sh', 'TARGET=apps/agent\ncd "$TARGET"\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('still does not flag a subdirectory of an OUT-OF-SCOPE package (#1995 r1)', () => {
    // The descendant match must widen scope for scoped packages only; if it
    // widened generally the 13 leak fixtures would pass for the wrong reason.
    const r = runWith('contracts/script/deploy-chain.sh', 'cd apps/indexer/src\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  // ── The safety flag is a CLAIM about argv, and argv is not the source text.
  // Five constructs hand wrangler `--no-keep-vars` without spelling it, and
  // each was reported separately (#1995 r16). Three are decidable and are
  // decided; two are not, and are answered "cannot prove it survives".
  it('a QUOTED negation reaches wrangler as the real flag (#1995 r16)', () => {
    const r = runWith('a.sh', 'cd apps/agent\nwrangler deploy --keep-vars --no-keep-"vars"\n');
    expect(r.ok).toBe(false);
  });

  it('a quoted negation appended to a package script too (#1995 r16)', () => {
    const r = runWith('b.sh', 'pnpm --filter @vaipakam/agent run deploy --no-"keep-vars"\n');
    expect(r.ok).toBe(false);
  });

  it("yargs' CAMEL-CASE spelling is the same option (#1995 r16)", () => {
    // `--no-keepVars` really does set keepVars:false on the pinned 4.90.0.
    const r = runWith('c.sh', 'pnpm --filter @vaipakam/agent run deploy --no-keepVars\n');
    expect(r.ok).toBe(false);
  });

  it('camel-case on a direct command as well (#1995 r16)', () => {
    const r = runWith('d.sh', 'cd apps/agent\nwrangler deploy --keep-vars --no-keepVars\n');
    expect(r.ok).toBe(false);
  });

  it('a BRACE group expands to two arguments before scoring (#1995 r16)', () => {
    // `--{,no-}keep-vars` is one written token and two arguments.
    const r = runWith('e.sh', 'cd apps/agent\npnpm run deploy --{,no-}keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('a brace group that PRODUCES the safety flag is honoured (#1995 r16)', () => {
    // The package-script path expands braces at its own entry; this pins the
    // scorer's, and it has to pin it in the SAFE direction. The destructive
    // spelling would be reported either way — expanded, because the negation
    // wins; unexpanded, because the flag is then missing entirely — so it
    // cannot tell the two apart. `--{keep-vars,dry-run}` can: without
    // expansion the token is unreadable and this correct command is a false
    // red, with it the flag is present and the deploy passes.
    const r = runWith('e2.sh', 'cd apps/agent\nwrangler deploy --{keep-vars,dry-run}\n');
    expect(r.ok).toBe(true);
  });

  it('and the camel-case POSITIVE spelling really is the safety flag (#1995 r16)', () => {
    // Not decoration: without it only the NEGATION pattern knew camel-case, so
    // dropping camel from the positive pattern broke nothing a test could see
    // — while `--keepVars`, a correct and safe command, read as a bare deploy.
    const r = runWith('d2.sh', 'cd apps/agent\nwrangler deploy --keepVars\n');
    expect(r.ok).toBe(true);
  });

  it('a VARIABLE that carries the negation cannot be proven safe (#1995 r16)', () => {
    const r = runWith('f.sh', 'FLAG=--no-keep-vars\ncd apps/agent\npnpm run deploy "$FLAG"\n');
    expect(r.ok).toBe(false);
  });

  it('nor a SUBSTITUTION that emits one after the flag (#1995 r16)', () => {
    // The mirror of the r14 case: there the substitution DELETED the flag,
    // here it ADDS a negation, and blanking it hid both.
    const r = runWith('g.sh', 'cd apps/agent\nwrangler deploy --keep-vars $(printf %s --no-keep-vars)\n');
    expect(r.ok).toBe(false);
  });

  it('an opaque word after the flag is unknown, and unknown is not safe (#1995 r16)', () => {
    const r = runWith('h.sh', 'cd apps/agent\nwrangler deploy --keep-vars $EXTRA\n');
    expect(r.ok).toBe(false);
  });

  it('but an opaque word inside ANOTHER option is inert (#1995 r16 control)', () => {
    // `--var "SHA:$COMMIT"` cannot introduce an argument. Reading every `$` as
    // opaque would have made this correct command a false red — which is the
    // failure mode that gets a guard deleted.
    const r = runWith('i.sh', 'cd apps/agent\nwrangler deploy --keep-vars --var "SHA:$COMMIT"\n');
    expect(r.ok).toBe(true);
  });

  it('and a SINGLE-quoted dollar expands to itself (#1995 r16 control)', () => {
    const r = runWith('j.sh', "cd apps/agent\nwrangler deploy --keep-vars --message 'cost $5'\n");
    expect(r.ok).toBe(true);
  });

  it('a quoted command name beside an allowlisted quote is caught (#1995 r16)', () => {
    // The residue test cleared the line because it read RAW text only, while
    // detection reads the dequoted form — the exemption cancelled a real find.
    const r = runWith(
      'docs/ToDo.md',
      'Prefer the dashboard over `wrangler deploy` for this. cd apps/agent && wrang"ler" deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  // ── The directive parser only saw moves that carried a DESTINATION WORD.
  // Four argument-less spellings move the shell and were all ignored (#1995
  // r16). Two of these assert the reported PACKAGE, not just that something
  // was reported: the defect was the guard standing in the wrong directory, and
  // a bare `ok === false` cannot tell a right report from a wrong one.
  it('a bare pushd SWAPS the top two directories (#1995 r16)', () => {
    // Bash: "With no arguments, exchanges the top two directories." The swap
    // walks back INTO the agent after the shell had left it.
    const r = runWith(
      'a.sh',
      'pushd apps/agent\npushd ../indexer\ncd ../www\npushd\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the swap PUSHES the old directory back, for a later popd (#1995 r16)', () => {
    // The swap is two halves and the cwd fixture above pins only one: dropping
    // the old cwd from the stack instead of exchanging it leaves the same
    // resulting directory and shows up only on a LATER popd. Mutating that
    // half survived until this case existed.
    const r = runWith(
      'a2.sh',
      'pushd apps/indexer\npushd apps/agent\npushd\npopd\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('popd +N removes an entry WITHOUT changing directory (#1995 r16)', () => {
    // Collapsing every popd spelling onto the top-pop transition walked the
    // model to the indexer while the shell was still in the agent.
    const r = runWith(
      'b.sh',
      'pushd apps/indexer\npushd ../agent\npopd +1\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while popd +0 IS the ordinary pop (#1995 r16 control)', () => {
    const r = runWith('b2.sh', 'pushd apps/agent\npushd ../www\npopd +0\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a bare cd goes to $HOME, which the text does not name (#1995 r16)', () => {
    // Ignoring it held the agent's scope over a deploy that runs elsewhere —
    // reporting the wrong package rather than the right one.
    const r = runWith('c.sh', 'cd apps/agent\ncd\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('and so does cd ~ (#1995 r16)', () => {
    // `cd "$HOME"` already resolved to an unknown destination through the
    // variable rule; the tilde reached resolveDir as a directory named `~`.
    const r = runWith('c2.sh', 'cd apps/agent\ncd ~\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a console PROMPT still moves the shell (#1995 r16)', () => {
    // ```console is an accepted fence and a prompted block is exactly what an
    // operator copies. Detection was never anchored, so only the SCOPE was
    // lost: the deploy was seen and attributed to the repo root.
    const r = runWith('d.md', '```console\n$ cd apps/agent\n$ wrangler deploy\n```\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a # line in a fence stays a COMMENT (#1995 r16 control)', () => {
    // A root prompt is indistinguishable from a comment, and the docs are full
    // of `# wrangler deploy` written as commentary. Stripping `#` would invent
    // commands out of prose — a new false-red class in exchange for a narrow
    // one.
    const r = runWith('h.md', '```bash\ncd apps/agent\n# wrangler deploy\n```\n');
    expect(r.ok).toBe(true);
  });

  it('and a leading $VAR is not a prompt (#1995 r16 control)', () => {
    // The `$` must be followed by whitespace; no real shell word can be.
    const r = runWith('i.sh', 'cd apps/www\n$WRANGLER deploy\n');
    expect(r.ok).toBe(true);
  });

  // ── An UNRECOGNISED selector was an authoritative EMPTY selection, which
  // suppressed every other source of scope. Real-but-unresolvable and
  // selects-nothing had the same spelling (#1995 r16).
  it('--filter . is the packages under the CWD, not none (#1995 r16)', () => {
    seedWorkspace();
    seed('docs/r.md', 'From `apps/agent`, run `pnpm --filter . run deploy --no-keep-vars`\n');
    const r = runWith('x.sh', '# placeholder\n');
    expect(r.ok).toBe(false);
    // The NEGATIVE is what pins the deferral. The report echoes the offending
    // line, and that line says `apps/agent` itself — so asserting only that
    // was satisfied by the input rather than by the verdict, and a mutant
    // removing the deferral survived. Without it the selector falls through to
    // "negations only, so every package" and the FIRST scoped package (the
    // keeper) is reported instead of the one the cwd names.
    expect(r.out).toContain('apps/agent');
    expect(r.out).not.toContain('@vaipakam/keeper');
  });

  it('a changed-since suffix COMPOSES with a directory selector (#1995 r16)', () => {
    // pnpm documents the shape as `{<dir>}[<since>]`; only the standalone
    // `[<since>]` form was handled, so this matched nothing and read as an
    // authoritative empty scope. The suffix only NARROWS the prefix, so
    // attributing the prefix's packages is the conservative reading.
    seedWorkspace();
    const r = runWith('a.sh', "pnpm --filter '{apps/agent}[HEAD~100]' run deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('filter-like text inside ANOTHER option cannot subtract a package (#1995 r16)', () => {
    // The quoted wrangler message parsed as a real negation and excluded the
    // very package the command deploys. `selectorScope` was fixed for exactly
    // this at r3; `filterScopes` was the selector reader nobody had asked.
    seedWorkspace();
    const r = runWith(
      'b.sh',
      'pnpm --filter @vaipakam/agent run deploy --message="--filter !@vaipakam/agent" --no-keep-vars\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('...<pkg> reaches INDIRECT dependents too (#1995 r16)', () => {
    // pnpm's wording is "direct and indirect". A one-level manifest read
    // answered the direct question correctly and silently missed this one.
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent","dependencies":{"@vaipakam/contracts":"workspace:*"}}\n');
    seed('apps/keeper/package.json', '{"name":"@vaipakam/keeper","dependencies":{"@vaipakam/contracts":"workspace:*"}}\n');
    seed('packages/contracts/package.json', '{"name":"@vaipakam/contracts","dependencies":{"@vaipakam/lib":"workspace:*"}}\n');
    const r = runWith('c.sh', "pnpm --filter '...@vaipakam/lib' run --if-present deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a DISABLED fan-out flag selects nothing (#1995 r16)', () => {
    // `pnpm --recursive=false run --if-present deploy` runs no workspace
    // script; a presence test failed CI on a command that deploys nothing.
    seedWorkspace();
    const r = runWith('d.sh', 'pnpm --recursive=false run --if-present deploy --no-keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('and npm --workspaces=false likewise (#1995 r16)', () => {
    seedWorkspace();
    const r = runWith('e.sh', 'npm --workspaces=false run deploy -- --no-keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('while a BARE --workspaces is still every package (#1995 r16 control)', () => {
    // Load-bearing: neutralising other options' values before the fan-out test
    // swallowed `--workspaces run` as an option-and-value, so a command that
    // deploys EVERY package read as naming none. A control probe caught it,
    // not the finding being fixed.
    seedWorkspace();
    const r = runWith('f.sh', 'npm --workspaces run deploy -- --no-keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('and a bare -r too (#1995 r16 control)', () => {
    seedWorkspace();
    const r = runWith('g.sh', 'pnpm -r run deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
  });

  it('but a REAL command beside an allowlisted quote is still caught (#1924 r27)', () => {
    const r = runWith(
      'docs/ToDo.md',
      'added the matching binding to `apps/agent/wrangler.jsonc` + `npx wrangler deploy` (live version x) ' +
        '&& cd apps/agent && wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });
});
