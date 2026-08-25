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
      'pushd apps/keeper\npushd ../agent\npopd\nwrangler deploy\n',
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
    // `cd apps/agent; cd apps/keeper` ends in the keeper directory.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/agent; cd apps/keeper\nwrangler deploy\n',
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
      'pushd apps/agent\nwrangler deploy\npopd\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper scope from one run block into the next (#1924 r29)', () => {
    // Each Actions step is a fresh shell. Carrying scope across blocks made
    // the first block's cd reject the second block's AGENT deploy.
    const r = runWith(
      '.github/workflows/deploy.yml',
      'jobs:\n  x:\n    steps:\n      - run: |\n          cd apps/keeper\n          wrangler deploy --keep-vars\n      - run: |\n          cd apps/agent\n          wrangler \\\n            deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('does not leak keeper scope between fenced examples', () => {
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      '```bash\ncd apps/keeper\nwrangler deploy --keep-vars\n```\n\n```bash\ncd apps/agent\nwrangler deploy\n```\n',
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
    // rejected an agent deploy further down the same file.
    const r = runWith(
      'docs/ops/DeploymentRunbook.md',
      'First cd apps/keeper and read on.\n\nLater, for the agent:\n\nwrangler deploy\n',
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
      'set -e; cd apps/agent\nwrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('the last cd also decides scope in the other direction (#1924 r36)', () => {
    // `cd apps/keeper; cd apps/agent` ends in the AGENT directory — taking the
    // first match rejected this correct wrapper.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'set -e; cd apps/keeper; cd apps/agent\nwrangler deploy\n',
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
    // FOLLOWS the cd runs from apps/agent, so it is not the keeper's.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper\ncd ../agent; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a same-line cd INTO the keeper still catches the deploy after it (#1924 r37)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd ../agent\ncd apps/keeper; wrangler deploy\n',
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
    // The walk ends in apps/agent; the line still CONTAINS `apps/keeper`, and
    // a whole-line fallback let that stale string override the walk.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd ../agent; wrangler deploy\n',
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
    // `cd apps/agent; cd ../keeper` ends in apps/keeper; scoring each target
    // as its own boolean saw `../keeper` and recorded non-keeper.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent; cd ../keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('resolves a relative cd back OUT of the keeper (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper; cd ../../apps/agent; wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('keeps a keeper state reachable across a || fallback (#1924 r39)', () => {
    // The left cd succeeds in this tree, so the deploy runs from the keeper;
    // applying both cds unconditionally ended in agent scope.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/keeper || cd apps/agent; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('flags the other || order too — keeper is still reachable (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent || cd apps/keeper; wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('&& does NOT keep the pre-cd state reachable (#1924 r39)', () => {
    // Unlike ||, the right-hand side of && runs only when the cd SUCCEEDED, so
    // apps/agent is the only reachable state. Modelling both would be a false
    // positive.
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'cd apps/agent && wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('pushd/popd still restore the directory through the state set (#1924 r39)', () => {
    const r = runWith(
      'contracts/script/deploy-chain.sh',
      'pushd apps/keeper; pushd ../agent; popd; wrangler deploy\n',
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
