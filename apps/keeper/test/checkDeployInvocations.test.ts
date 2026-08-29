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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      // A sync child is beyond vitest's own test timeout, so a guard that
      // stops terminating (the ReDoS class the alert-1957/1958 canaries pin)
      // would HANG the suite, not fail it. The kill turns that into a loud
      // ok:false. 60 s is two orders above the slowest healthy fixture run.
      timeout: 60_000,
      killSignal: 'SIGKILL',
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

/** Create a symlink inside the fixture tree. */
function link(from: string, to: string): void {
  const full = join(root, from);
  mkdirSync(dirname(full), { recursive: true });
  symlinkSync(join(root, to), full);
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
    // The NEGATIVE is what pins the resolution. Refusing to resolve the prefix
    // falls through to "negations only, so every package" and reports the
    // keeper as well — the fixture passes either way without this line, which
    // is how a mutant dropping the positive branch survived.
    expect(r.out).not.toContain('@vaipakam/keeper');
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

  // ── Three more selector readers, all fail-open (#1995 r16).
  it("a selector after WRANGLER's -- is inert (#1995 r16)", () => {
    // Verified against 4.90.0: `deploy --dry-run -- --name X` still processed
    // the local configuration. The trailing name selected nothing, yet it was
    // read as authoritative and suppressed the cwd scope of a live deploy.
    const r = runWith('a.sh', 'cd apps/agent\nwrangler deploy -- --name vaipakam-indexer\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("and so is a --cwd after it (#1995 r16)", () => {
    const r = runWith('a2.sh', 'pnpm --dir apps/agent exec wrangler deploy -- --cwd ../www\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("but PNPM's -- forwards, so the script's --cwd stays live (#1995 r9 regression guard)", () => {
    // The two `--`s mean opposite things and the terminator must tell them
    // apart: pnpm CONSUMES its own and appends what follows to the script's
    // arguments. Keying the cut on the verb rather than on `wrangler` would
    // silently un-do r9's chaining, and this case had never been fixtured — a
    // probe is what found the gap.
    const r = runWith('a3.sh', 'pnpm --dir apps/agent run deploy -- --cwd . --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and it still redirects when the forwarded --cwd points elsewhere (#1995 r9 control)', () => {
    const r = runWith('a4.sh', 'pnpm --dir apps/agent run deploy -- --cwd ../www --no-keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('a repeated directory selector takes the LAST (#1995 r16)', () => {
    // Confirmed against the pinned pnpm: this runs the AGENT script. Taking
    // the first match handed the guard an out-of-scope directory.
    const r = runWith('b.sh', 'pnpm --dir apps/indexer --dir apps/agent run deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a single out-of-scope --dir still selects nothing (#1995 r16 control)', () => {
    const r = runWith('b2.sh', 'pnpm --dir apps/indexer run deploy --no-keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('a STATIC variable in an explicit selector resolves (#1995 r16)', () => {
    // resolveDir has carried literal assignments for directory targets since
    // r8; the selector readers did not, which is the same incoherent pair r8
    // named — resolvable one way and not the other.
    const r = runWith('c.sh', 'NAME=vaipakam-agent\nwrangler deploy --name "$NAME"\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a DYNAMIC one DEFERS rather than asserting "targets nothing" (#1995 r16)', () => {
    // The `cd` is what makes this discriminate, and without it the case was
    // vacuous: an unresolved `$NAME` returned as a LITERAL matches no worker,
    // so the reader answers "selects nothing" AUTHORITATIVELY and suppresses
    // the cwd — the fail-open direction. With no cwd to suppress, both
    // behaviours pass and a mutant dropping the guard survived. Deferring here
    // matches what `--config` has always done for the same question.
    const r = runWith(
      'c2.sh',
      'cd apps/agent\nNAME=$(cat n.txt)\nwrangler deploy --name "$NAME"\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a static one naming an UNSCOPED worker still selects nothing (#1995 r16 control)', () => {
    // Discriminates "resolved" from "gave up and fell back to the cwd": the
    // shell is in apps/agent, so a reader that ignored the resolved name would
    // report the agent.
    const r = runWith('c3.sh', 'cd apps/agent\nNAME=vaipakam-www\nwrangler deploy --name "$NAME"\n');
    expect(r.ok).toBe(true);
  });

  // ── `workingDirFor` read the workflow as free TEXT rather than as
  // structure: no depth rule, no normalisation, one matrix shape, unquoted job
  // keys only, no env, and no notion of which interpreter runs the body
  // (#1995 r16). Six reported, one found while probing them.
  it('a step key on the DASH LINE is still metadata (#1995 r16)', () => {
    // `- working-directory: apps/agent` is ordinary Actions YAML and the
    // pattern could only see a line that STARTS with the key. Nobody reported
    // this one; it turned up because two of my probes for the others passed
    // when their controls said they should not have.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('shell PAYLOAD cannot stand in for step metadata (#1995 r16)', () => {
    // A heredoc whose data reads `working-directory: apps/indexer` overrode
    // the real Actions cwd. Depth distinguishes a sibling key from text inside
    // a value, and the scan had no notion of it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\ndefaults:\n  run:\n    working-directory: apps/agent\njobs:\n  d:\n    steps:\n' +
        "      - run: |\n          cat <<'EOT' > /tmp/x\n          working-directory: apps/indexer\n" +
        '          EOT\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a QUOTED job key still has its defaults read (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  "deploy-agent":\n    defaults:\n      run:\n' +
        '        working-directory: apps/agent\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a NON-NORMALIZED working directory resolves (#1995 r16)', () => {
    // The runner starts in apps/agent; storing the raw path meant scopeOfCwd
    // could not recognise it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    defaults:\n      run:\n' +
        '        working-directory: apps/indexer/../agent\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a root-crossing .. still resolves to the package (#1995 r16)', () => {
    // My first version of this expected a PASS, on the reasoning that
    // `../apps/agent` leaves the checkout. It does not pass, and should not:
    // `scopeOfCwd` matches a package on a `/` boundary anywhere in the path,
    // which is what lets an absolute runner path resolve at all. Written down
    // because the wrong expectation is the tempting one.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    defaults:\n      run:\n' +
        '        working-directory: ../apps/agent\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a static env value backs a working directory (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/agent\njobs:\n  d:\n    steps:\n' +
        '      - name: go\n        working-directory: ${{ env.DEPLOY_DIR }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('matrix.include carries the leg values too (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        include:\n' +
        '          - dir: apps/agent\n    steps:\n' +
        '      - name: go\n        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and so does a block-sequence matrix (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        dir:\n          - apps/agent\n' +
        '    steps:\n      - name: go\n        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a NON-SHELL interpreter runs no shell (#1995 r16)', () => {
    // `print("wrangler deploy")` prints a string. Reporting it failed CI on a
    // correct workflow — the failure mode that gets a guard switched off.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: python\n' +
        '        working-directory: apps/agent\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('while shell: bash is still scanned (#1995 r16 control)', () => {
    // Allow-list, not deny-list: an unrecognised interpreter is not known to
    // be a shell, but the named ones must keep working.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: bash\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and a non-shell step does not silence its SIBLING (#1995 r16 control)', () => {
    // The gate is per-step. If it leaked to the block or the file, one python
    // step would hide every real deploy beside it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: a\n        shell: python\n' +
        '        run: print("hi")\n      - name: b\n        working-directory: apps/agent\n' +
        '        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── Four more ways the shell was told to move that the state model did not
  // see (#1995 r16). Each asserts the reported PACKAGE where the defect was
  // standing in the wrong directory rather than missing the command.
  it('a CONTROL WORD in front of cd does not stop cd running (#1995 r16)', () => {
    // `splitCommands` hands the directive parser `then cd "$TARGET"`, and the
    // prefix admitted only braces and `builtin`/`command`. The variable is
    // load-bearing: with a literal path the line carries textual scope and the
    // case passes for the wrong reason.
    const r = runWith(
      'a.sh',
      'TARGET=apps/agent\nif true; then cd "$TARGET"; wrangler deploy; fi\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('pushd +N ROTATES the stack rather than naming a directory (#1995 r16)', () => {
    // Bash rotates so the Nth entry becomes current. The destination match
    // claimed `+1` as a directory name — and because it runs first, my first
    // cut of this fix changed nothing at all until the order was corrected.
    const r = runWith('b.sh', 'pushd apps/agent\npushd ../indexer\npushd +1\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while pushd -n STACKS without moving, and a later popd lands there (#1995 r16)', () => {
    // Two wrong versions of this before it discriminated. Asserting only that
    // the shell does not move cannot fail: the fall-through models a directory
    // literally named `-n`, and `apps/agent/-n` is still inside the agent, so
    // both behaviours report the same package. The stack is where the
    // difference lives — bash pops to `apps/agent` here — and that also caught
    // my own handling being incomplete: it suppressed the move but never
    // pushed, so a later popd went somewhere the shell would not.
    const r = runWith('b2.sh', 'cd apps/www\npushd -n apps/agent\npopd\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the deploy right after pushd -n still runs where it was (#1995 r16 control)', () => {
    const r = runWith('b3.sh', 'cd apps/www\npushd -n apps/agent\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('CDPATH is the search path for a relative cd (#1995 r16)', () => {
    // `CDPATH=apps` then `cd agent` enters apps/agent; resolving only against
    // the modelled cwd recorded a directory called `agent`, matching nothing.
    const r = runWith('c.sh', 'CDPATH=apps\ncd agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a CDPATH that lands nowhere scoped invents no scope (#1995 r16 control)', () => {
    const r = runWith('c2.sh', 'CDPATH=vendor\ncd agent\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('and EVERY CDPATH entry is searched, not just the first (#1995 r16)', () => {
    // This is what the "must land on a scoped package" condition really buys,
    // and the single-entry control could not show it: with a first entry that
    // matches nothing, accepting it and stopping loses the agent entirely.
    // Bash searches the entries in order until one exists.
    const r = runWith('c4.sh', 'CDPATH=vendor:apps\ncd agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a dot-relative target is not searched at all (#1995 r16 control)', () => {
    // Bash searches CDPATH only for targets that do not begin with `/`, `.`
    // or `..`. Without that rule `./agent` would resolve through CDPATH too.
    const r = runWith('c3.sh', 'CDPATH=apps\ncd ./agent\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('the state cap keeps the PROTECTED destination (#1995 r16)', () => {
    // A long `||` chain of failing `cd`s filled the cap with thirty-two
    // irrelevant directories, so the one scoped state — which arrives last and
    // is the only one that decides anything — was dropped.
    const chain = Array.from({ length: 40 }, (_, i) => `cd missing${i} ||`).join(' ');
    const r = runWith('d.sh', `${chain} cd apps/agent; wrangler deploy\n`);
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── Three of these are seams in the r16 workflow fix itself: the env
  // resolver, the flow-style branch and the shell allow-list each needed a
  // sweep the original change did not make.
  it('env resolves from the NEAREST scope, step then job then workflow (#1995 r16)', () => {
    // Scanning the whole file and taking the first match let a workflow-level
    // value shadow the job-level override beneath it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/indexer\njobs:\n  d:\n    env:\n      DEPLOY_DIR: apps/agent\n' +
        '    steps:\n      - name: go\n        working-directory: ${{ env.DEPLOY_DIR }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('flow-style defaults get the same normalization (#1995 r16)', () => {
    // The r13 flow branch returned its capture raw, so it reached neither the
    // expression resolver nor the normaliser — both added later, neither wired
    // to it. Two return sites had it, job-level and workflow-level.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\ndefaults: { run: { working-directory: apps/indexer/../agent } }\n' +
        'jobs:\n  d:\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('at the JOB level as well as the workflow level (#1995 r16)', () => {
    // Both return sites had the defect and my first pair of fixtures pinned
    // only the workflow-level one, so a mutant restoring the job-level raw
    // return survived. Third time this session that a fix touched two sites
    // and the tests reached one.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    defaults: { run: { working-directory: apps/indexer/../agent } }\n' +
        '    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the same EXPRESSION resolution (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  D: apps/agent\ndefaults: { run: { working-directory: "${{ env.D }}" } }\n' +
        'jobs:\n  d:\n    steps:\n      - run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a pwsh step moves with Set-Location (#1995 r16)', () => {
    // Admitting `pwsh` and `cmd` to the shell allow-list widened what is
    // SCANNED without widening what is UNDERSTOOD: their bodies went to a
    // scanner that knows only `cd`/`pushd`.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n' +
        '        run: |\n          Set-Location apps/agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a cmd step with cd /d and a backslash path (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: cmd\n' +
        '        run: |\n          cd /d apps\\agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a backslash in BASH is still an escape (#1995 r16 control)', () => {
    // `cd apps\agent` is `cd appsagent` in bash. The conversion is scoped to
    // the Windows-specific commands precisely so this stays true.
    const r = runWith('w.sh', 'cd apps\\agent\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a prose label carries ACROSS the fence it introduces (#1995 r16)', () => {
    // The label was attached to the ```bash opener and reset before the
    // command inside arrived — so the one shape a runbook actually uses was
    // the one shape this could not carry.
    const r = runWith('docs/r.md', 'From `apps/agent`:\n\n```bash\nwrangler deploy\n```\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but intervening prose still resets it (#1995 r16 control)', () => {
    const r = runWith(
      'docs/r2.md',
      'From `apps/agent`:\n\nSome other note.\n\n```bash\nwrangler deploy\n```\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a matrix expression inside a LARGER path interpolates (#1995 r16)', () => {
    // r11 gave the expression its own branch, which works exactly when the
    // value IS the expression — so `apps/${{ matrix.app }}`, the more ordinary
    // spelling, had `\S+` stop at the first space and captured `apps/${{`.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        app: [agent]\n    steps:\n' +
        '      - name: go\n        working-directory: apps/${{ matrix.app }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a leg that lands outside every package stays quiet (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        app: [www]\n    steps:\n' +
        '      - name: go\n        working-directory: apps/${{ matrix.app }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a FLOW-style matrix include carries its values (#1995 r16)', () => {
    // `include: [{ dir: apps/agent }]` has no line beginning with `dir:`, so
    // the anchored matcher recorded nothing — the identical omission the
    // `defaults:` reader had at r13, in the matrix reader.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        include: [{ dir: apps/agent }]\n' +
        '    steps:\n      - name: go\n        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("pnpm's UNSCOPED name selects the scoped package (#1995 r16)", () => {
    // `--filter agent` selects `@vaipakam/agent`; comparing only the full name
    // resolved the selection to an authoritative empty.
    const r = runWith('u.sh', 'pnpm --filter agent run deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a DIRECTORY filter is matched as a path, never as a name (#1995 r16)', () => {
    // `--filter {agent}` means "the package in ./agent", which does not exist
    // here, so pnpm selects nothing. Letting the unscoped-name comparison
    // apply to directory filters too would report the agent for a selector
    // that never reaches it — and that widening survived a mutation until this
    // case existed.
    const r = runWith('u3.sh', "pnpm --filter '{agent}' run deploy --no-keep-vars\n");
    expect(r.ok).toBe(true);
  });

  it('but an unscoped name matching nothing selects nothing (#1995 r16 control)', () => {
    const r = runWith('u2.sh', 'pnpm --filter www run deploy --no-keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('wrangler deploy --help uploads nothing (#1995 r16)', () => {
    // A false red blocks the unfiltered CI job over a command that deploys
    // nothing, and the credibility of a guard is spent on those.
    const r = runWith('h.sh', 'cd apps/agent\nwrangler deploy --help\n');
    expect(r.ok).toBe(true);
  });

  it('while --help=false is not a help invocation (#1995 r16 control)', () => {
    // Scored through flagEnabled rather than by substring, so the CLI's own
    // reading of the value decides.
    const r = runWith('h2.sh', 'cd apps/agent\nwrangler deploy --help=false\n');
    expect(r.ok).toBe(false);
  });

  it('nor is the word --help inside another option value (#1995 r16 control)', () => {
    const r = runWith('h3.sh', 'cd apps/agent\nwrangler deploy --message="see --help"\n');
    expect(r.ok).toBe(false);
  });

  it('nor one that arrives after the option terminator (#1995 r16 control)', () => {
    const r = runWith('h4.sh', 'cd apps/agent\nwrangler deploy -- --help\n');
    expect(r.ok).toBe(false);
  });

  it('a PROCESS substitution is as opaque as a command substitution (#1995 r16)', () => {
    // Two bugs in series: the redirection stripper ate `<` and its "operand"
    // `(echo`, leaving the substitution's words standing as real arguments, so
    // a `--keep-vars` written inside one blessed a bare deploy.
    const r = runWith('p.sh', 'cd apps/agent\nwrangler deploy --message <(echo --keep-vars)\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a REAL redirection is still stripped (#1995 r16 control)', () => {
    // The lookahead is on the single-character operators only. Both of these
    // put the safety flag where the shell does not: after a redirection
    // operand, and inside a here-string.
    expect(runWith('p2.sh', 'cd apps/agent\nwrangler deploy > out --keep-vars\n').ok).toBe(true);
    expect(runWith('p3.sh', 'cd apps/agent\nwrangler deploy --keep-vars <<< done\n').ok).toBe(true);
  });

  it("a boolean flag does not eat wrangler's positional script (#1995 r16)", () => {
    // `wrangler deploy [script]` takes an entrypoint and `--keep-vars` is a
    // boolean, so the path is the SCRIPT — but the separated branch consumed
    // it and, under the true-only rule, scored the flag off. A correct
    // explicit-entrypoint deploy was reported as destructive.
    const r = runWith('q.sh', 'cd apps/agent\nwrangler deploy --keep-vars apps/agent/src/index.ts\n');
    expect(r.ok).toBe(true);
  });

  it('while a separated boolean LITERAL is still its value (#1995 r16 control)', () => {
    // The attached form is untouched — `=yes` and `=garbage` are still false
    // (r28) — and a separated `false` still disables.
    expect(runWith('q2.sh', 'cd apps/agent\nwrangler deploy --keep-vars false\n').ok).toBe(false);
    expect(runWith('q3.sh', 'cd apps/agent\nwrangler deploy --keep-vars=garbage\n').ok).toBe(false);
  });

  it('a package-manager option may take a SEPARATED value (#1995 r16)', () => {
    // `pnpm help run` documents `-C, --dir <dir>`. The pattern could only step
    // over `--opt` or `--opt=value`, so this never reached `deploy` and the
    // whole destructive line was invisible to detection.
    seedWorkspace();
    const r = runWith('s.sh', 'pnpm run -C apps/agent deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a JSON escape is decoded with JSON semantics (#1995 r16)', () => {
    // `\u0079` is `y`. Dropping the backslash left `deployu0079`, which matched
    // no deploy, so the whole file was skipped at the prefilter.
    const r = runWith(
      'apps/agent/package.json',
      '{\n  "name": "@vaipakam/agent",\n  "scripts": {\n    "deploy": "wrangler deplo\\u0079"\n  }\n}\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and every value on a MINIFIED line is read (#1995 r16)', () => {
    // Found while fixing the escape: the decoded case passed pretty-printed
    // and failed minified, which is the escape working and the EXTRACTION not.
    // The value pattern was end-anchored, so only the last value on a line was
    // ever scanned.
    const r = runWith(
      'apps/agent/package.json',
      '{"name":"@vaipakam/agent","scripts":{"deploy":"wrangler deplo\\u0079"}}\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a custom shell TEMPLATE names its interpreter first (#1995 r16)', () => {
    // The unquoted spelling worked for the wrong reason — `\S+` stopped at the
    // space and captured `bash` by accident — while the quoted one compared
    // the whole scalar and classified a real Bash step as non-shell.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "bash -e {0}"\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a python TEMPLATE is still not a shell (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "python {0}"\n' +
        '        working-directory: apps/agent\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  // ── Markdown blocks and prose command spans (#1995 r16).
  it('an INDENTED markdown code block is one shell block (#1995 r16)', () => {
    // CommonMark's fence-free spelling of the same copyable example. Only
    // fenced blocks were grouped, so the first line's directory could not
    // reach the second.
    const r = runWith('docs/r.md', 'Steps:\n\n    cd apps/agent\n    wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the same block with the flag still passes (#1995 r16 control)', () => {
    // Pins that the block is SCANNED, not merely ignored: before the change
    // this passed because nothing looked at it at all.
    const r = runWith('docs/r2.md', 'Steps:\n\n    cd apps/agent\n    wrangler deploy --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('an indented block with a COMPOSED command name is still grouped (#1995 r16)', () => {
    // The block filter read raw text only, so `wrang"ler" deploy` — a deploy by
    // the r9 rule — did not qualify the block and its `cd` never reached the
    // command. Mutation found it: widening the filter changed a verdict, which
    // a filter that was only a blast-radius bound could not have done.
    const r = runWith('docs/r5.md', 'Steps:\n\n    cd apps/agent\n    wrang"ler" deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but indented lines in YAML are DATA, not a shell block (#1995 r16 control)', () => {
    // Indentation is structure in YAML and JSON, and a `run:` block is already
    // handled on its own path. Grouping every indented run would put ordinary
    // mapping content through a shell parser — the r27 mistake, which cost
    // four false positives on a clean tree.
    const r = runWith('config/notes.yml', 'notes:\n    cd apps/agent\n    wrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a MAKEFILE recipe folds its backslash continuation (#1995 r16)', () => {
    // GNU Make preserves the continuation, so this is one command and each
    // physical line alone says nothing.
    const r = runWith('Makefile', 'deploy:\n\tcd apps/agent && \\\n\twrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('two command SPANS on one prose line are two commands (#1995 r16)', () => {
    // No shell separator between them, so `splitCommands` returned one segment
    // and the safe span blessed the bare one beside it.
    const r = runWith(
      'docs/r3.md',
      'Use `wrangler deploy --keep-vars` for apps/keeper and `wrangler deploy` for apps/agent.\n',
    );
    expect(r.ok).toBe(false);
    // The clause AFTER the span names the package. Reporting the keeper here —
    // first in SCOPED — would be the r1 defect again: wrong package, wrong
    // remedy, and a reader acts on the remedy.
    expect(r.out).toContain('apps/agent');
    expect(r.out).not.toContain('@vaipakam/keeper');
  });

  it('but ONE command span with a flag beside it is one command (#1995 r16 control)', () => {
    // `keeper-scoped `wrangler deploy` that lacks `--keep-vars`` is a sentence
    // ABOUT a command. Splitting on every span reported it as a deploy — this
    // is the standing #1924 r19 fixture, and breaking it is how the
    // two-or-more rule was found.
    const r = runWith(
      'apps/keeper/README.md',
      'keeper-scoped `wrangler deploy` that lacks `--keep-vars`. It exists because\n',
    );
    expect(r.ok).toBe(true);
  });

  it('and an UNATTRIBUTED span is not reported at all (#1995 r16 control)', () => {
    // The shape that caught this on the real tree: a documentation row saying a
    // bare deploy must NOT be used. Two command spans, but the clause after the
    // bare one names no package — so there is nothing to attribute it to, and
    // falling back to the whole line would report every sentence warning
    // against the command. A guard that blocks CI over the sentence telling you
    // not to do the thing is how a guard gets switched off.
    const r = runWith(
      'docs/r4.md',
      'Use `pnpm --filter @vaipakam/agent run deploy` — NOT a bare `wrangler deploy` — ' +
        'because those scripts carry `--keep-vars`.\n',
    );
    expect(r.ok).toBe(true);
  });

  // ── The state walk applied every `cd` it saw, with no model of whether the
  // shell would execute it or return from it (#1995 r16).
  it('a MULTILINE subshell restores the parent (#1995 r16)', () => {
    // The same-line form was fixed at r13; this is that fix's other half. Depth
    // and the snapshot stack were re-created per line, so the closing `)` had
    // nothing to restore.
    const r = runWith('a.sh', 'cd apps/agent\n(\ncd ../indexer\n)\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a SKIPPED conditional branch leaves the shell where it was (#1995 r16)', () => {
    const r = runWith('b.sh', 'cd apps/agent\nif false; then cd ../indexer; fi\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and BOTH branches of an if/else stay reachable (#1995 r16)', () => {
    // Applying them in sequence let the else-branch overwrite the then-branch,
    // so the protected leg vanished.
    const r = runWith(
      'c.sh',
      'if [ -n "$X" ]; then cd apps/agent; else cd apps/indexer; fi\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a for-loop GLOB is a list, not an unknown (#1995 r16)', () => {
    // `for TARGET in apps/*` iterates the real directories, one of which is
    // protected. Dropping the value left `cd "$TARGET"` unresolved.
    //
    // The seed is load-bearing and not boilerplate: the expansion reads the
    // TREE, so without `apps/` on disk the glob matches nothing and this passes
    // for the wrong reason — which is exactly what it did on the first run.
    seedWorkspace();
    const r = runWith('d.sh', 'for TARGET in apps/*; do\ncd "$TARGET"\nwrangler deploy\ndone\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a glob matching no protected package binds nothing (#1995 r16 control)', () => {
    seedWorkspace();
    const r = runWith('e.sh', 'for TARGET in packages/*; do\ncd "$TARGET"\nwrangler deploy\ndone\n');
    expect(r.ok).toBe(true);
  });

  it('and a DYNAMIC loop list still clears the binding (#1995 r16 control)', () => {
    // The r14 rule: an unknown value clears the name rather than leaving a
    // stale binding. Expanding globs must not weaken it.
    const r = runWith('f.sh', 'for TARGET in $DIRS; do\ncd "$TARGET"\nwrangler deploy\ndone\n');
    expect(r.ok).toBe(true);
  });

  it('a one-line subshell still restores too (#1995 r13 control)', () => {
    // Pins that hoisting the stack to block scope did not break the case the
    // stack was introduced for.
    const r = runWith('g.sh', 'cd apps/agent\n(cd ../indexer)\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── The expression resolver I added at r16 handled ONE expression, of ONE
  // kind, and the env branch RETURNED its value instead of substituting it.
  // Four reports plus a shell one, all the same shape.
  it('env resolution reads an actual env: MAPPING (#1995 r16)', () => {
    // An action input under `with:` reusing the key was read as an environment
    // declaration and shadowed the real one.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/agent\njobs:\n  d:\n    steps:\n      - name: a\n' +
        '        with:\n          DEPLOY_DIR: apps/indexer\n      - name: go\n' +
        '        working-directory: ${{ env.DEPLOY_DIR }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('an env value SUBSTITUTES into the surrounding path (#1995 r16)', () => {
    // `ROOT: .` with `${{ env.ROOT }}/apps/agent` runs in apps/agent; returning
    // the value alone seeded `.`. The scope test also had to normalise, because
    // the caller normalises the RESULT — too late to choose between candidates.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  ROOT: .\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: ${{ env.ROOT }}/apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a FLOW-style matrix axis is an axis (#1995 r16)', () => {
    // `strategy: { matrix: { dir: [apps/agent] } }` — the inline matcher is
    // start-anchored and the scalar flow matcher reads mapping members, not
    // arrays, so an ordinary matrix written in flow style resolved to nothing.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy: { matrix: { dir: [apps/agent] } }\n    steps:\n' +
        '      - name: go\n        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('EVERY expression in a path resolves, not just the first (#1995 r16)', () => {
    // Chosen by COMBINATION: with more than one expression the choices
    // interact, so the question is not whether a leg lands in a scoped package
    // but whether an assignment of all of them does.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        root: [apps]\n        app: [agent]\n' +
        '    steps:\n      - name: go\n        working-directory: ${{ matrix.root }}/${{ matrix.app }}\n' +
        '        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('an UNDECLARED axis substitutes empty, keeping the literals (#1995 r16)', () => {
    // Actions evaluates an undefined context expression to the empty string, so
    // this step runs inside the agent. Discarding the whole value lost that —
    // found by mutation, not by a report.
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: apps/agent/${{ matrix.x }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and an UNMODELLED expression is treated the same way (#1995 r16)', () => {
    // `${{ inputs.x }}` is not a context this resolver models, and it used to
    // make the whole value unusable. Actions evaluates it to the empty string
    // like any other undefined expression, so the literal segments stand and
    // the step runs inside the agent. Uniform treatment came from two mutants
    // that both survived by keeping the text literally.
    const r = runWith(
      '.github/workflows/w6.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: apps/agent/${{ inputs.x }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a suffix expression with no separator still lands in the package (#1995 r16)', () => {
    // `apps/agent${{ matrix.x }}` substitutes to `apps/agent`. Keeping the text
    // literally left a string that matches no package on a `/` boundary, so
    // this passed — which is the mutant that survived until this case existed.
    const r = runWith(
      '.github/workflows/w7.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: apps/agent${{ matrix.x }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while an expression that is the WHOLE value still resolves to nothing (#1995 r11 control)', () => {
    // The r11 rule: `${{` is not a directory name.
    const r = runWith(
      '.github/workflows/w5.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: ${{ matrix.x }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a matrix-selected SHELL resolves before being judged (#1995 r16)', () => {
    // Testing the literal token `${{` against the keyword set classified a real
    // bash leg as non-shell and skipped its body.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        shell: [bash]\n    steps:\n' +
        '      - name: go\n        shell: ${{ matrix.shell }}\n        working-directory: apps/agent\n' +
        '        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a matrix shell of python is still not a shell (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        shell: [python]\n    steps:\n' +
        '      - name: go\n        shell: ${{ matrix.shell }}\n        working-directory: apps/agent\n' +
        '        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('and an UNRESOLVED shell expression is scanned, not skipped (#1995 r16)', () => {
    // Skipping is the fail-open direction: the whole point of the allow-list is
    // that an unknown interpreter must not silence a deploy it might execute.
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: ${{ inputs.shell }}\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── Detection matched a LITERAL `wrangler` command word, so every other way
  // of naming the same executable was invisible — and the file-level prefilter
  // then skipped the whole file (#1995 r16).
  it('a command word held in a VARIABLE is still wrangler (#1995 r16)', () => {
    const r = runWith('a.sh', 'CMD=wrangler\ncd apps/agent\n"$CMD" deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and so is a SUBCOMMAND held in one (#1995 r16)', () => {
    const r = runWith('a2.sh', 'SUB=deploy\ncd apps/agent\nwrangler "$SUB"\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('the variable form with the flag still passes (#1995 r16 control)', () => {
    // Pins that the file is SCANNED and SCORED, not merely pulled in: before
    // the change this passed because the prefilter skipped it entirely.
    const r = runWith('a3.sh', 'CMD=wrangler\ncd apps/agent\n"$CMD" deploy --keep-vars\n');
    expect(r.ok).toBe(true);
  });

  it('an unrelated variable brings nothing in (#1995 r16 control)', () => {
    const r = runWith('a4.sh', 'NAME=hello\ncd apps/agent\necho "$NAME"\n');
    expect(r.ok).toBe(true);
  });

  it('a MESSAGE variable holding the command text is not a command (#1995 r16 control)', () => {
    // `MSG="wrangler deploy"` then `echo "$MSG"` echoes a string. Admitting
    // multi-word values made the expansion report it as a destructive deploy —
    // the r19 defect reappearing through my own fix. A command word is ONE
    // word, so that is what the scan records. My probe caught this, not a
    // review round.
    expect(runWith('m.sh', 'MSG="wrangler deploy"\ncd apps/agent\necho "$MSG"\n').ok).toBe(true);
    expect(runWith('m2.sh', 'MSG="wrangler deploy"\ncd apps/agent\necho $MSG\n').ok).toBe(true);
  });

  it('and a DYNAMIC assignment is not expanded either (#1995 r16 control)', () => {
    const r = runWith('m3.sh', 'CMD=$(which wrangler)\ncd apps/agent\n"$CMD" deploy\n');
    expect(r.ok).toBe(true);
  });

  it('the PROSE path expands command words too (#1995 r16)', () => {
    // A runbook writes the command in a code span, so the assignment is
    // preceded by a backtick rather than whitespace — the leading boundary had
    // to admit quotes and backticks for this to be reached at all. A mutant
    // removing the prose-side expansion survived until this case existed.
    const r = runWith('docs/x.md', 'Run `CMD=wrangler; cd apps/agent; "$CMD" deploy`\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("npm's WINDOWS shim is the same executable (#1995 r16)", () => {
    // The shell allow-list admits `cmd` and `pwsh` steps, so not recognising
    // the shim meant admitting the step and then seeing nothing in it.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: cmd\n' +
        '        working-directory: apps/agent\n        run: wrangler.cmd deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the PowerShell shim too (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n' +
        '        working-directory: apps/agent\n        run: wrangler.ps1 deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a PROGRAMMATIC argv invocation counts (#1995 r16)', () => {
    // A JS helper names the executable and its arguments as argv, with no
    // whitespace between them, so the shell-string pattern could not match.
    // This repo already uses that spawn form elsewhere.
    const r = runWith(
      'apps/agent/deploy.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['deploy']);\n",
    );
    expect(r.ok).toBe(false);
  });

  it('but an argv invocation carrying the flag passes (#1995 r16 control)', () => {
    const r = runWith(
      'apps/agent/d2.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['deploy', '--keep-vars']);\n",
    );
    expect(r.ok).toBe(true);
  });

  // ── The workflow readers resolved against the WHOLE FILE and took the first
  // match, with no notion of which mapping level or which job an entry belongs
  // to (#1995 r16). Three of these six are false REDS.
  it('an absolute-path interpreter is still bash (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "/bin/bash -e {0}"\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('defaults.run.shell decides for a step with no shell key (#1995 r16)', () => {
    // Returning "shell" unconditionally reported a python step's
    // `print("wrangler deploy")` as a destructive deploy.
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\ndefaults:\n  run:\n    shell: python\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: apps/agent\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('and a bash default still scans (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\ndefaults:\n  run:\n    shell: bash\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('an EXCLUDED matrix leg does not exist (#1995 r16)', () => {
    // Keeping the declared value reported a violation for a leg that never runs.
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        dir: [apps/agent, apps/indexer]\n' +
        '        exclude:\n          - dir: apps/agent\n    steps:\n      - name: go\n' +
        '        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('and a config WITHOUT keep_vars leaves the upload reported (#1995 r16 control)', () => {
    // The config must actually DECLARE it. Accepting any config at all would
    // bless every upload in a package that happens to have one — which is both
    // scoped packages today.
    seed('apps/agent/wrangler.jsonc', '{"name": "vaipakam-agent"}\n');
    seed('apps/keeper/wrangler.jsonc', '{"name": "vaipakam-keeper"}\n');
    const r = runWith('u3.sh', 'cd apps/agent\nwrangler versions upload\n');
    expect(r.ok).toBe(false);
  });

  it('while the same matrix without the exclusion still flags (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w5.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        dir: [apps/agent, apps/indexer]\n' +
        '    steps:\n      - name: go\n        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a matrix axis in an UNRELATED job scopes nothing here (#1995 r16)', () => {
    // A deploy job whose `dir` is only the indexer was reported as the agent
    // because another job declared an agent leg.
    const r = runWith(
      '.github/workflows/w6.yml',
      'name: w\njobs:\n  other:\n    strategy:\n      matrix:\n        dir: [apps/agent]\n    steps:\n' +
        '      - name: x\n        run: echo hi\n  deploy:\n    strategy:\n      matrix:\n' +
        '        dir: [apps/indexer]\n    steps:\n      - name: go\n' +
        '        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a static string-literal expression evaluates to itself (#1995 r16)', () => {
    // Blanking it made a real deploy unattributed — a defect in last round's
    // empty-substitution rule, found by the round after it.
    const r = runWith(
      '.github/workflows/w7.yml',
      "name: w\njobs:\n  d:\n    steps:\n      - name: go\n" +
        "        working-directory: ${{ 'apps/agent' }}\n        run: wrangler deploy\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a SIBLING step env does not shadow the workflow env (#1995 r16)', () => {
    // A job's range contains every step's `env`, and the workflow's contains
    // every job's and step's — so the first `env:` in range was often a deeper
    // one. Each level now reads its OWN mapping.
    const r = runWith(
      '.github/workflows/w8.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/agent\njobs:\n  d:\n    steps:\n      - name: a\n' +
        '        env:\n          DEPLOY_DIR: apps/indexer\n        run: echo hi\n      - name: go\n' +
        '        working-directory: ${{ env.DEPLOY_DIR }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("but a step's OWN env still wins (#1995 r16 control)", () => {
    const r = runWith(
      '.github/workflows/w9.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/indexer\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        env:\n          DEPLOY_DIR: apps/agent\n' +
        '        working-directory: ${{ env.DEPLOY_DIR }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── Seven more ways the shell reaches a deploy that the readers could not
  // follow (#1995 r16).
  it('a SOURCED helper moves the caller (#1995 r16)', () => {
    // `source` runs the file's commands in the CURRENT shell, so neither file
    // contains both the scope and the deploy and scanning them independently
    // saw nothing in either.
    seed('scripts/enter-agent.sh', 'cd apps/agent\n');
    const r = runWith('w.sh', 'source scripts/enter-agent.sh\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the dot form does the same (#1995 r16)', () => {
    seed('scripts/enter.sh', 'cd apps/agent\n');
    const r = runWith('w2.sh', '. scripts/enter.sh\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  it('a helper that moves nowhere scoped stays quiet (#1995 r16 control)', () => {
    seed('scripts/e.sh', 'cd apps/www\n');
    expect(runWith('w3.sh', 'source scripts/e.sh\nwrangler deploy\n').ok).toBe(true);
  });

  it('and an UNREADABLE helper contributes nothing (#1995 r16 control)', () => {
    // It might do anything; the caller's own moves stay the best evidence, and
    // clearing scope on a missing file would be a guess in the other direction.
    // The `cd` BEFORE it is what makes this discriminate: without it, clearing
    // and preserving both come out as "no scope" and the case cannot fail.
    const r = runWith('w4.sh', 'cd apps/agent\nsource scripts/missing.sh\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and helpers that source EACH OTHER still terminate (#1995 r16 control)', () => {
    // A cycle is not a realistic wrapper, but a guard must terminate on one.
    // Without the depth bound this recurses until the stack gives out, and the
    // process dies rather than reporting anything.
    seed('scripts/a.sh', '. scripts/b.sh\ncd apps/agent\n');
    seed('scripts/b.sh', '. scripts/a.sh\n');
    const r = runWith('w5.sh', '. scripts/a.sh\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('dash and ash shebangs are shell (#1995 r16)', () => {
    // Their names END in `sh` with no word boundary before it, so a
    // `\b(ba|z|k)?sh\b` test matched neither and the file was scanned as prose.
    expect(runWith('bin/d1', '#!/bin/dash\ncd apps/agent\nwrangler deploy\n').ok).toBe(false);
    expect(runWith('bin/d2', '#!/bin/ash\ncd apps/agent\nwrangler deploy\n').ok).toBe(false);
  });

  it('yarn runs a script WITHOUT the run keyword (#1995 r16)', () => {
    const r = runWith('y.sh', 'cd apps/agent\nyarn deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and the same form without a negation is safe (#1995 r16 control)', () => {
    // Load-bearing: widening only the DETECTOR made this correct command read
    // as an unrecognised bare deploy. Two halves of one decision.
    expect(runWith('y2.sh', 'cd apps/agent\nyarn deploy\n').ok).toBe(true);
  });

  it('parameter-expansion OPERATORS resolve (#1995 r16)', () => {
    // `${TARGET:?missing}` is the same variable; matching only `${TARGET` left
    // the operator text attached and the modelled path matched no package.
    expect(runWith('p1.sh', 'TARGET=apps/agent\ncd "${TARGET:?missing}"\nwrangler deploy\n').ok).toBe(false);
    expect(runWith('p2.sh', 'TARGET=apps/agent\ncd "${TARGET:-apps/www}"\nwrangler deploy\n').ok).toBe(false);
  });

  it('EVERY binding in an assignment-only command is kept (#1995 r16)', () => {
    // The single-pair matcher is end-anchored, so the combined form parsed as
    // nothing and the binding was dropped entirely.
    const r = runWith('as.sh', 'TARGET=apps/agent OTHER=x\ncd "$TARGET"\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a later COMPUTED value still clears it (#1995 r16 control)', () => {
    // r14's rule, applied per name rather than per command.
    const r = runWith('as2.sh', 'TARGET=apps/agent OTHER=x\nTARGET=$(cat f)\ncd "$TARGET"\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a BRACE LIST in a for-loop is a list (#1995 r16)', () => {
    const r = runWith('b.sh', 'for TARGET in apps/{indexer,agent}; do\ncd "$TARGET"\nwrangler deploy\ndone\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a DYNAMIC alternative does not hide its literal siblings (#1995 r16)', () => {
    // bash expands `apps/{$X,agent}` to both, and the agent iteration runs.
    // Refusing the whole group when any alternative held a `$` was my first cut
    // and it was wrong; the per-value filter drops the unresolved alternative
    // on its own, which is the right granularity. Mutation caught it — widening
    // the pattern changed a verdict, and the widened answer was correct.
    const r = runWith('b2.sh', 'for TARGET in apps/{$X,agent}; do\ncd "$TARGET"\nwrangler deploy\ndone\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // ── Selectors and Windows interpreters (#1995 r16).
  it("pnpm's EXCLUSIVE dependency selector resolves (#1995 r16)", () => {
    // `...^X` is X's dependents WITHOUT X. The dots were stripped and the caret
    // left in the pattern, so it matched no package name at all.
    seedWorkspace();
    const r = runWith('s.sh', "pnpm --filter '...^@vaipakam/lib' run --if-present deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a RESOLVED filter survives beside an unresolved one (#1995 r16)', () => {
    // pnpm runs on packages satisfying AT LEAST ONE selector, so discarding the
    // resolved half because the other was unknown threw away a protected
    // selection that was right there.
    seedWorkspace();
    const r = runWith('s2.sh', "pnpm --filter . --filter '@vaipakam/*gent' run deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while an unresolved selector ALONE still defers (#1995 r16 control)', () => {
    seedWorkspace();
    expect(runWith('s3.sh', 'pnpm --filter . run deploy --no-keep-vars\n').ok).toBe(true);
  });

  it("a nested shell's -c is not wrangler's --config (#1995 r16)", () => {
    // The shell's own flag was read as a config path, and the resulting
    // authoritative no-scope answer suppressed BOTH the literal target inside
    // the payload and the scoped-file fallback.
    const r = runWith('n.sh', "sh -c 'cd apps/agent; wrangler deploy'\n");
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("but wrangler's own -c still redirects (#1995 r16 control)", () => {
    expect(runWith('n2.sh', 'cd apps/agent\nwrangler deploy -c ../www/wrangler.jsonc\n').ok).toBe(true);
    expect(
      runWith('n3.sh', 'cd apps/agent\nwrangler deploy --config ../www/wrangler.jsonc\n').ok,
    ).toBe(true);
  });

  it('a WINDOWS working-directory separator resolves (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        working-directory: apps\\agent\n' +
        '        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it("PowerShell's cd alias takes a Windows path (#1995 r16)", () => {
    // The `Set-Location` and `cd /d` forms carried their own conversion because
    // the COMMAND identified the platform; the plain `cd` alias does not, so it
    // comes from the step's interpreter instead.
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n' +
        '        run: |\n          cd apps\\agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('cmd folds a CARET continuation (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: cmd\n' +
        '        working-directory: apps/agent\n        run: |\n          wrangler ^\n          deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a caret at end-of-line in BASH joins nothing (#1995 r16 control)', () => {
    // `^` is an ordinary character in a POSIX line, and folding it there would
    // join lines the shell never joined.
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: bash\n' +
        '        working-directory: apps/agent\n        run: |\n          echo wrangler ^\n          deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  // ── Reachability and file coverage (#1995 r16). Four of these are false REDS.
  it('an .mdx runbook is opened at all (#1995 r16)', () => {
    // The markdown branch already tested for `.mdx`; `walk` never yielded the
    // file, so that handling was unreachable.
    const r = runWith('docs/r.mdx', 'Steps:\n\n```bash\ncd apps/agent\nwrangler deploy\n```\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('env RUNS a command, so the interpreter is what follows (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "/usr/bin/env bash -e {0}"\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a YAML ANCHOR before the block indicator (#1995 r16)', () => {
    // Rejecting `- run: &deploy |` sent the whole block down the flow-scalar
    // path, where the indicator, the cd and the deploy folded into prose.
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - run: &deploy |\n          cd apps/agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a STORED argv array is not an invocation (#1995 r16)', () => {
    // The pattern is the final predicate, not only a prefilter, so this
    // reported a deployment that never runs.
    expect(runWith('apps/agent/a.mjs', "const args = ['wrangler', 'deploy'];\nconsole.log(args);\n").ok).toBe(true);
  });

  it('and `versions list` is not the guarded operation (#1995 r16)', () => {
    expect(
      runWith('apps/agent/b.mjs', "import { spawn } from 'node:child_process';\nspawn('wrangler', ['versions', 'list']);\n").ok,
    ).toBe(true);
  });

  it('while a real spawned deploy still counts (#1995 r16 control)', () => {
    expect(
      runWith('apps/agent/c.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['deploy']);\n").ok,
    ).toBe(false);
    expect(
      runWith('apps/agent/d.mjs', "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['versions', 'upload']);\n").ok,
    ).toBe(false);
  });

  it('a statically DISABLED step runs nothing (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        if: ${{ false }}\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but a condition referencing a CONTEXT is a runtime question (#1995 r16 control)', () => {
    // Treating an unknown condition as false would silence real deploys, which
    // is the direction this must not err in.
    const r = runWith(
      '.github/workflows/w4.yml',
      "name: w\njobs:\n  d:\n    steps:\n      - name: go\n        if: ${{ github.event_name == 'push' }}\n" +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('Make runs each recipe line in its OWN shell (#1995 r16)', () => {
    // Without `.ONESHELL:` the `cd` does not reach the next line, so grouping
    // the recipe reported a deploy that runs from the repo root.
    expect(runWith('Makefile', 'deploy:\n\tcd apps/agent\n\twrangler deploy\n').ok).toBe(true);
  });

  it('unless .ONESHELL, where the @ prefix is not the command (#1995 r16)', () => {
    const r = runWith('Makefile', '.ONESHELL:\ndeploy:\n\t@cd apps/agent\n\twrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a backslash continuation is one command either way (#1995 r16 control)', () => {
    const r = runWith('Makefile', 'deploy:\n\tcd apps/agent && \\\n\twrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  // ── Scoping siblings, launchers and links (#1995 r16).
  it('wrangler global flags may sit between versions and upload (#1995 r16)', () => {
    const r = runWith('v.sh', 'cd apps/agent\nwrangler versions --config wrangler.jsonc upload\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('the SHELL matrix collector is job-bounded too (#1995 r16)', () => {
    // The working-directory collector took this correction a round earlier; the
    // shell one was written afterwards and did not get it, so an axis of the
    // same name in an unrelated job answered for this step.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  other:\n    strategy:\n      matrix:\n        interp: [bash]\n    steps:\n' +
        '      - name: x\n        run: echo hi\n  d:\n    strategy:\n      matrix:\n        interp: [python]\n' +
        '    steps:\n      - name: go\n        shell: ${{ matrix.interp }}\n' +
        '        working-directory: apps/agent\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('defaults text inside a run PAYLOAD is not metadata (#1995 r16)', () => {
    // Heredoc data shaped like `defaults: / run: / shell: python` classified a
    // later ordinary bash step as python and omitted it.
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: a\n        run: |\n          cat <<EOT > f\n' +
        '          defaults:\n            run:\n              shell: python\n          EOT\n' +
        '      - name: go\n        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a NON-SHELL step can still LAUNCH a deploy (#1995 r16)', () => {
    // Dropping the block left the argv text to the physical-line scan, which has
    // no working directory to attribute it to. Shell state is not modelled for
    // these bodies and does not need to be: an argv call names its own
    // executable, and what the guard needs from the step is WHERE it runs.
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "python {0}"\n' +
        '        working-directory: apps/agent\n        run: subprocess.run(["wrangler", "deploy"])\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a python step that only PRINTS still runs nothing (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "python {0}"\n' +
        '        working-directory: apps/agent\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a repository SYMLINK resolves to what it points at (#1995 r16)', () => {
    // `cd worker` where `worker -> apps/agent` puts the shell physically in the
    // agent and wrangler finds that configuration.
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    link('worker', 'apps/agent');
    const r = runWith('l.sh', 'cd worker\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but the walk does not LEAVE the tree through one (#1995 r16)', () => {
    // `statSync` follows a directory symlink, so a link to the parent had the
    // guard scanning whatever sits beside the checkout and reporting violations
    // in files it does not own. Found while writing a control for the
    // resolution above; it predates that change rather than being caused by it.
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    link('outside', '..');
    const r = runWith('l2.sh', 'cd outside\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  // ── A deploy whose TEXT lives elsewhere but whose STATE is here (#1995 r16),
  // and the Actions environment the block actually runs with.
  it("a workflow env value reaches the block's shell (#1995 r16)", () => {
    // Actions EXPORTS these, so `cd "$DEPLOY_DIR"` resolves against them — but
    // each block cleared shellVars and seeded nothing.
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/agent\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        run: |\n          cd "$DEPLOY_DIR"\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a STEP-level one does too (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        env:\n          DEPLOY_DIR: apps/agent\n' +
        '        run: |\n          cd "$DEPLOY_DIR"\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and its LITERAL segments still name the package (#1995 r16)', () => {
    // `${{ env.X }}/apps/agent` is the agent whatever X holds. Refusing any
    // value carrying an expression lost that — mutation showed the choice was
    // observable and WRONG rather than merely cautious, because `resolveDir`
    // keeps a static suffix after an unknown prefix.
    const r = runWith(
      '.github/workflows/w3b.yml',
      'name: w\nenv:\n  DEPLOY_DIR: ${{ env.X }}/apps/agent\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        run: |\n          cd "$DEPLOY_DIR"\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a value carrying an EXPRESSION is not known (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\nenv:\n  DEPLOY_DIR: ${{ inputs.d }}\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        run: |\n          cd "$DEPLOY_DIR"\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it("PowerShell's $name = 'value' binds like an assignment (#1995 r16)", () => {
    // Rewritten at block ingest rather than parsed by a second assignment
    // model in the walk: the interpreter is known here and not there, and one
    // model with a translation in front of it cannot drift the way two can.
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n        run: |\n' +
        "          $target = 'apps/agent'\n          Set-Location $target\n          wrangler deploy\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a computed one stays unknown (#1995 r16 control)', () => {
    const r = runWith(
      '.github/workflows/w5.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n        run: |\n' +
        '          $target = (Get-Item .).Name\n          Set-Location $target\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a FUNCTION defined earlier is judged where it is CALLED (#1995 r16)', () => {
    // The definition was read before any protected scope existed and the call
    // was ignored, so neither half was ever seen together.
    const r = runWith('f.sh', 'deploy_worker() { wrangler deploy; }\ncd apps/agent\ndeploy_worker\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a function whose body carries the FLAG is safe (#1995 r16 control)', () => {
    // Probed but not fixtured on the first pass, so a mutant recording every
    // function body — safe ones included — survived. Only bodies that would be
    // reported on their own are remembered.
    const r = runWith('f0.sh', 'deploy_worker() { wrangler deploy --keep-vars; }\ncd apps/agent\ndeploy_worker\n');
    expect(r.ok).toBe(true);
  });

  it('but defining one without calling it deploys nothing (#1995 r16 control)', () => {
    expect(runWith('f2.sh', 'deploy_worker() { wrangler deploy; }\ncd apps/agent\necho hi\n').ok).toBe(true);
  });

  it('and calling it from an UNSCOPED directory is not reported (#1995 r16 control)', () => {
    // Scope comes from the caller's state: the same function called from two
    // directories deploys two different Workers.
    expect(runWith('f3.sh', 'deploy_worker() { wrangler deploy; }\ncd apps/www\ndeploy_worker\n').ok).toBe(true);
  });

  it('a SOURCED helper deploys in the caller\u2019s directory (#1995 r16)', () => {
    // Reaching this needed the handling to sit BEFORE the directive
    // short-circuit: `source` is itself a directive, so `if (dir) continue`
    // skipped the very segment that carries the helper.
    seed('deploy.sh', 'wrangler deploy\n');
    const r = runWith('s.sh', 'cd apps/agent\nsource ../../deploy.sh\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while a helper that deploys SAFELY is not reported (#1995 r16 control)', () => {
    seed('d.sh', 'wrangler deploy --keep-vars\n');
    expect(runWith('s2.sh', 'cd apps/agent\nsource ../../d.sh\n').ok).toBe(true);
  });

  it('nor one sourced from an unscoped directory (#1995 r16 control)', () => {
    seed('d.sh', 'wrangler deploy\n');
    expect(runWith('s3.sh', 'cd apps/www\nsource ../../d.sh\n').ok).toBe(true);
  });

  // ── Selector corrections and the versions-upload path (#1995 r16).
  it('...^ excludes its own ANCHOR (#1995 r16)', () => {
    // My previous round claimed exclusion "only removes the matched package,
    // and a scoped package is never the one being excluded here" — simply
    // false: `...^@vaipakam/agent` excludes the agent, and the agent IS scoped.
    // The selector reported a deploy pnpm does not perform.
    seedWorkspace();
    const r = runWith('e.sh', "pnpm --filter '...^@vaipakam/agent' run --if-present deploy --no-keep-vars\n");
    expect(r.ok).toBe(true);
  });

  it('while plain ... still selects dependents (#1995 r16 control)', () => {
    seedWorkspace();
    const r = runWith('e2.sh', "pnpm --filter '...@vaipakam/lib' run --if-present deploy --no-keep-vars\n");
    expect(r.ok).toBe(false);
  });

  it('a NEGATIVE changed-since filter cannot subtract (#1995 r16)', () => {
    // `[HEAD]` matches no changed package, so pnpm still selects the agent;
    // stripping the suffix excluded it unconditionally.
    seedWorkspace();
    const r = runWith(
      'n.sh',
      "pnpm --filter '@vaipakam/agent' --filter '!{apps/agent}[HEAD]' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a plain negative filter still subtracts (#1995 r16 control)', () => {
    seedWorkspace();
    const r = runWith(
      'n2.sh',
      "pnpm --filter '@vaipakam/agent' --filter '!@vaipakam/agent' run deploy --no-keep-vars\n",
    );
    expect(r.ok).toBe(true);
  });

  it('a safety flag in the OPTIONS object is not an argument (#1995 r16)', () => {
    // The third argument is process options; wrangler receives only `deploy`.
    const r = runWith(
      'apps/agent/d.mjs',
      "import { spawnSync } from 'node:child_process';\n" +
        "spawnSync('wrangler', ['deploy'], { env: { NOTE: '--keep-vars' } });\n",
    );
    expect(r.ok).toBe(false);
  });

  it('while one in the argv ARRAY still counts (#1995 r16 control)', () => {
    const r = runWith(
      'apps/agent/d2.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['deploy', '--keep-vars']);\n",
    );
    expect(r.ok).toBe(true);
  });

  it('versions upload is guarded by CONFIG, not by the flag (#1995 r16)', () => {
    // The pinned wrangler lists no `--keep-vars` for that path and derives
    // `keepVars` from `config.keep_vars`, so the guard was blessing a command
    // that cannot run while blocking every upload that can.
    const r = runWith('u.sh', 'cd apps/agent\nwrangler versions upload\n');
    expect(r.ok).toBe(false);
    // …and the remedy names the setting rather than the flag the CLI rejects.
    expect(r.out).toContain('keep_vars');
  });

  it('and a config declaring keep_vars makes it safe (#1995 r16)', () => {
    seed('apps/agent/wrangler.jsonc', '{"keep_vars": true}\n');
    seed('apps/keeper/wrangler.jsonc', '{"keep_vars": true}\n');
    const r = runWith('u2.sh', 'cd apps/agent\nwrangler versions upload\n');
    expect(r.ok).toBe(true);
  });

  // ── How a command and its arguments are RECOGNISED (#1995 r16).
  it('a CommonJS helper is opened (#1995 r16)', () => {
    // `.cjs` was absent from the traversal set and `looksExecutable` rejects
    // any filename with a dot, so the argv detection could never see it.
    const r = runWith(
      'apps/agent/deploy.cjs',
      "const { spawnSync } = require('node:child_process');\nspawnSync('wrangler', ['deploy']);\n",
    );
    expect(r.ok).toBe(false);
  });

  it('a PATH-QUALIFIED executable in argv is the same binary (#1995 r16)', () => {
    const r = runWith(
      'apps/agent/d.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('./node_modules/.bin/wrangler', ['deploy']);\n",
    );
    expect(r.ok).toBe(false);
  });

  it('adjacent string LITERALS fold before matching (#1995 r16)', () => {
    // JavaScript evaluates `'de' + 'ploy'`; requiring one literal skipped the
    // file at the prefilter. The fold has to reach the per-line test as well,
    // or the file is admitted and then nothing is seen in it.
    const r = runWith(
      'apps/agent/d2.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('wrangler', ['de' + 'ploy']);\n",
    );
    expect(r.ok).toBe(false);
  });

  it('a MULTIWORD alias expands in command position (#1995 r16)', () => {
    // `WRANGLER="pnpm exec wrangler"` word-splits to a real command.
    const r = runWith('m.sh', 'WRANGLER="pnpm exec wrangler"\ncd apps/agent\n$WRANGLER deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but NOT as an argument or a message (#1995 r16 control)', () => {
    // What keeps the widened value rule from resurrecting the r19 defect is
    // WHERE the expansion is allowed, not what the value contains. Both
    // spellings of the message case are pinned, because my first cut restricted
    // only the head and left the general replace substituting everywhere.
    expect(runWith('m2.sh', 'MSG="wrangler deploy"\ncd apps/agent\necho "$MSG"\n').ok).toBe(true);
    expect(runWith('m3.sh', 'MSG="wrangler deploy"\ncd apps/agent\necho $MSG\n').ok).toBe(true);
  });

  it('a static FLAG variable makes the deploy safe (#1995 r16)', () => {
    // `FLAGS=--keep-vars` then `wrangler deploy "$FLAGS"` is a safe deploy that
    // bash really does make safe; scoring the raw segment reported it.
    const r = runWith('fl.sh', 'FLAGS=--keep-vars\ncd apps/agent\nwrangler deploy "$FLAGS"\n');
    expect(r.ok).toBe(true);
  });

  it('and the same expansion applies on the PROSE path (#1995 r16)', () => {
    // Two call sites score safety — the shell walk and the prose walk — and a
    // mutant removing the prose one survived, because the shell fixture above
    // does not reach it. A runbook line is the shape that does.
    const r = runWith(
      'docs/r.md',
      'Run `FLAGS=--keep-vars; cd apps/agent; wrangler deploy "$FLAGS"` to redeploy.\n',
    );
    expect(r.ok).toBe(true);
  });

  it('while a bare deploy beside it is still reported (#1995 r16 control)', () => {
    const r = runWith('fl2.sh', 'FLAGS=--keep-vars\ncd apps/agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
  });

  // ── Config-backed safety, YAML spellings, and Windows case (#1995 r16).
  it('keep_vars is read from the DEPLOYED worker (#1995 r16)', () => {
    // One package enabling it must not bless a bare upload in the other. The
    // file supplies the scope here, since there is no `cd` to supply it.
    seed('apps/keeper/wrangler.jsonc', '{"keep_vars": true}\n');
    const r = runWith('apps/agent/release.sh', 'wrangler versions upload\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a COMMENTED declaration does not enable it (#1995 r16)', () => {
    // A config that merely documents the remedy was read as applying it.
    seed('apps/agent/wrangler.jsonc', '{\n  // "keep_vars": true\n}\n');
    const r = runWith('apps/agent/r.sh', 'wrangler versions upload\n');
    expect(r.ok).toBe(false);
  });

  it('while the real setting still makes it safe (#1995 r16 control)', () => {
    seed('apps/agent/wrangler.jsonc', '{"keep_vars": true}\n');
    expect(runWith('apps/agent/r2.sh', 'wrangler versions upload\n').ok).toBe(true);
  });

  it('a QUOTED run key is the same mapping key (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        working-directory: apps/agent\n' +
        '        "run": |\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('an ANCHORED working-directory scalar resolves (#1995 r16)', () => {
    // The `run:` matcher already stepped over anchors; this one did not.
    const r = runWith(
      '.github/workflows/w2.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n' +
        '        working-directory: &agent-dir apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a zsh template executes the body (#1995 r16)', () => {
    const r = runWith(
      '.github/workflows/w3.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: "zsh {0}"\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('Windows resolves the executable case-insensitively (#1995 r16)', () => {
    // Third time an interpreter transform went in at one of the three `run:`
    // ingest points and not the others, so they share one function now. This
    // case uses the SINGLE-LINE spelling, which the block-only fix never
    // reached.
    const r = runWith(
      '.github/workflows/w4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n' +
        '        working-directory: apps/agent\n        run: Wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and a BASH workflow step does not case-fold either (#1995 r16 control)', () => {
    // The `.sh` control above cannot pin this: a shell FILE never reaches the
    // interpreter transform at all, so only a YAML step with `shell: bash`
    // distinguishes "fold for Windows" from "fold always". A mutant applying
    // the fold on every path survived until this case existed.
    const r = runWith(
      '.github/workflows/w5.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: bash\n' +
        '        working-directory: apps/agent\n        run: |\n          Wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but on a POSIX path Wrangler is a different file (#1995 r16 control)', () => {
    // Case-folding belongs where the interpreter is known; doing it everywhere
    // would invent a command that does not exist on a POSIX runner.
    expect(runWith('cs.sh', 'cd apps/agent\nWrangler deploy\n').ok).toBe(true);
  });

  // ── Directory state: prefixes, wrappers and traversal (#1995 r16).
  it("PowerShell's -LiteralPath names the destination (#1995 r16)", () => {
    const r = runWith(
      '.github/workflows/w.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - name: go\n        shell: pwsh\n        run: |\n' +
        '          Set-Location -LiteralPath apps/agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a CASE arm label is a prefix like then (#1995 r16)', () => {
    // `splitCommands` hands the parser `agent) cd ../agent`, and a grammar that
    // knew only the control words left the move unrecorded.
    const r = runWith(
      'c.sh',
      'cd apps/indexer\ncase "$T" in\nagent) cd ../agent ;;\nesac\nwrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a relative cd INSIDE a subshell group applies to the group (#1995 r16)', () => {
    // The opener kept the directive matcher from seeing the `cd`, so the deploy
    // beside it was scored against the outer directory.
    const r = runWith('sg.sh', 'cd apps/indexer\n(cd ../agent && wrangler deploy)\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a SELF-CLOSING group still moves nothing (#1995 r6 control)', () => {
    // Load-bearing: the opener is stripped only when the group stays OPEN. One
    // that closes in its own segment nets zero depth, nothing would restore it,
    // and applying the move there is the r6 defect. Putting `(` in the prefix
    // grammar broke three standing fixtures at once.
    const r = runWith('sg2.sh', 'cd apps/keeper\n(cd ../agent)\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/keeper');
  });

  it('env --chdir runs the WRAPPED command elsewhere (#1995 r16)', () => {
    const r = runWith('e.sh', 'cd apps/indexer\nenv --chdir ../agent wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and its target is the ONLY scope for that command (#1995 r16 control)', () => {
    // The shell's own directory is not where this command runs; falling back to
    // it reported the agent for a deploy that runs in apps/www.
    expect(runWith('e2.sh', 'cd apps/agent\nenv --chdir ../www wrangler deploy\n').ok).toBe(true);
  });

  it("and the SAFETY question follows it too (#1995 r16)", () => {
    // `env --chdir` decides which worker's config a `versions upload` is judged
    // against. The scope resolution and the safety hint are two separate reads,
    // and a mutant reverting only the hint survived until this case existed —
    // this is the one shape where the hint alone changes the answer.
    seed('apps/agent/wrangler.jsonc', '{"keep_vars": true}\n');
    expect(
      runWith('ec.sh', 'cd apps/keeper\nenv --chdir ../agent wrangler versions upload\n').ok,
    ).toBe(true);
  });

  it('and the wrong worker\u2019s config does not answer it (#1995 r16 control)', () => {
    seed('apps/keeper/wrangler.jsonc', '{"keep_vars": true}\n');
    const r = runWith('ec2.sh', 'cd apps/keeper\nenv --chdir ../agent wrangler versions upload\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('while the shell itself does not move (#1995 r16 control)', () => {
    const r = runWith('e3.sh', 'cd apps/www\nenv --chdir ../agent wrangler deploy --keep-vars\nwrangler deploy\n');
    expect(r.ok).toBe(true);
  });

  it('a canonical directory is walked once (#1995 r16)', () => {
    // Containment bounded WHERE the walk goes; two internal links back to an
    // ancestor still branched, and the traversal multiplied. This completes
    // rather than timing out, which is the whole assertion.
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    link('a', '.');
    link('b', '.');
    const r = runWith('w.sh', 'cd apps/agent\nwrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a REAL command beside an allowlisted quote is still caught (#1924 r27)', () => {
    const r = runWith(
      'docs/ToDo.md',
      'added the matching binding to `apps/agent/wrangler.jsonc` + `npx wrangler deploy` (live version x) ' +
        '&& cd apps/agent && wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a TAGGED block scalar still opens a run block (CodeQL js/redos fix)', () => {
    // The ReDoS fix made the whitespace after a tag or anchor property
    // MANDATORY. YAML requires that whitespace too, so no recognised form may
    // be lost — this pins the tag spelling the fix touched most directly.
    const r = runWith(
      '.github/workflows/wt.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - run: !!str |\n          cd apps/agent\n          wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a pathological run-property line terminates (CodeQL js/redos, alert 1958)', () => {
    // With every part of the tag item optional, `run:!` + `!!`×n split in 2^n
    // ways — 13 s at n=20, unreachable at n=2000. Completing under the test
    // timeout IS the assertion, exactly like the canonical-directory walk test.
    const r = runWith(
      '.github/workflows/wr.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - run:!' + '!!'.repeat(2000) + '\n' +
        '      - name: real\n        working-directory: apps/keeper\n        run: wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a pathological env value terminates the reader (CodeQL js/redos, alert 1957)', () => {
    // `$` and `{` are also non-space, so `${{}}`×n + a forced tail failure
    // doubled per repetition on the old union — ~313 ms at n=22. The value is
    // garbage, so only termination and the step verdict are asserted.
    const r = runWith(
      '.github/workflows/we.yml',
      'name: w\nenv:\n  PATHO: ' + '${{}}'.repeat(2000) + ' !\n' +
        'jobs:\n  d:\n    steps:\n      - working-directory: apps/keeper\n        run: wrangler deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });
});

describe('check-deploy-invocations — #1995 r17', () => {
  const AGENT = '{"name":"@vaipakam/agent","scripts":{"deploy":"wrangler deploy --keep-vars","release":"pnpm run deploy"}}\n';

  it('a manifest ALIAS of the deploy script is the deploy script (r17)', () => {
    seed('apps/agent/package.json', AGENT);
    const r = runWith('x.sh', 'pnpm --filter @vaipakam/agent run release -- --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but the alias WITHOUT forwarded arguments is the safe script (r17 control)', () => {
    seed('apps/agent/package.json', AGENT);
    expect(runWith('x.sh', 'pnpm --filter @vaipakam/agent run release\n').ok).toBe(true);
  });

  it('an alias that runs wrangler BARE cannot launder itself (r17)', () => {
    seed(
      'apps/agent/package.json',
      '{"name":"@vaipakam/agent","scripts":{"deploy":"wrangler deploy --keep-vars","bad":"wrangler deploy"}}\n',
    );
    // Two reports are correct here: the manifest line itself, and the wrapper.
    const r = runWith('x.sh', 'pnpm --filter @vaipakam/agent run bad\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('x.sh');
  });

  it('a sourced helper deploys where ITS OWN cd put it (r17)', () => {
    seed('deploy.sh', 'cd ../agent\nwrangler deploy\n');
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    seed('apps/indexer/package.json', '{"name":"@vaipakam/indexer"}\n');
    const r = runWith('w.sh', 'cd apps/indexer\nsource ../../deploy.sh\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('matrix shell and directory correlate BY LEG (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/m.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        include:\n' +
        '          - dir: apps/agent\n            interp: python\n' +
        '          - dir: apps/indexer\n            interp: bash\n' +
        '    steps:\n      - shell: ${{ matrix.interp }} {0}\n' +
        '        working-directory: ${{ matrix.dir }}\n        run: print("wrangler deploy")\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but a SHELL leg pairing with the scoped directory is reported (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/m.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        include:\n' +
        '          - dir: apps/agent\n            interp: bash\n' +
        '          - dir: apps/www\n            interp: python\n' +
        '    steps:\n      - shell: ${{ matrix.interp }} {0}\n' +
        '        working-directory: ${{ matrix.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a LITERALLY false branch cannot block CI (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    expect(runWith('x.sh', 'if false; then cd apps/agent; wrangler deploy; fi\n').ok).toBe(true);
  });

  it('and the else arm after `if true` is the same shape mirrored (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    expect(
      runWith('x.sh', 'if true; then echo hi; else cd apps/agent; wrangler deploy; fi\n').ok,
    ).toBe(true);
  });

  it('but a LIVE else arm still deploys (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      'x.sh',
      'if false; then echo skip; else cd apps/agent; wrangler deploy; fi\n',
    );
    expect(r.ok).toBe(false);
  });

  it('and a compound condition keeps both arms (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    expect(
      runWith('x.sh', 'if false || true; then cd apps/agent; wrangler deploy; fi\n').ok,
    ).toBe(false);
  });

  it('a shell-STRING process launch is a launch (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/p.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - shell: python\n' +
        '        working-directory: apps/agent\n        run: |\n' +
        '          import subprocess\n          subprocess.run("wrangler deploy", shell=True)\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a static Make variable expands into its recipe (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith('Makefile', 'WORKER := apps/agent\n\ndeploy:\n\tcd $(WORKER) && wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('yarn workspace with the script as a POSITIONAL is detected (r17)', () => {
    seed('apps/agent/package.json', AGENT);
    const r = runWith('x.sh', 'yarn workspace @vaipakam/agent deploy --no-keep-vars\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but the bare workspace invocation is the safe script (r17 control)', () => {
    seed('apps/agent/package.json', AGENT);
    expect(runWith('x.sh', 'yarn workspace @vaipakam/agent deploy\n').ok).toBe(true);
  });

  it('and a workspace naming an UNSCOPED package is out of scope (r17 control)', () => {
    seed('apps/agent/package.json', AGENT);
    seed('apps/www/package.json', '{"name":"@vaipakam/www"}\n');
    expect(runWith('x.sh', 'yarn workspace @vaipakam/www deploy --no-keep-vars\n').ok).toBe(true);
  });

  it('versions upload reads the EXPLICITLY selected config (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    seed('apps/agent/wrangler.jsonc', '{"keep_vars": true}\n');
    seed('apps/agent/unsafe.jsonc', '{"name":"x"}\n');
    const r = runWith('x.sh', 'cd apps/agent\nwrangler versions upload --config unsafe.jsonc\n');
    expect(r.ok).toBe(false);
  });

  it('and a selected config DECLARING keep_vars blesses the upload (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    seed('apps/agent/wrangler.jsonc', '{"name":"x"}\n');
    seed('apps/agent/safe.jsonc', '{"keep_vars": true}\n');
    expect(
      runWith('x.sh', 'cd apps/agent\nwrangler versions upload --config safe.jsonc\n').ok,
    ).toBe(true);
  });

  it('a Windows helper script is walked and read as its interpreter (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith('apps/agent/deploy.ps1', 'wrangler deploy\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a run body that IS an env expression expands to its declared value (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/e.yml',
      'name: w\nenv:\n  DEPLOY_CMD: wrangler deploy\njobs:\n  d:\n    steps:\n' +
        '      - working-directory: apps/agent\n        run: ${{ env.DEPLOY_CMD }}\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a declared value CARRYING the flag stays safe (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/e.yml',
      'name: w\nenv:\n  DEPLOY_CMD: wrangler deploy --keep-vars\njobs:\n  d:\n    steps:\n' +
        '      - working-directory: apps/agent\n        run: ${{ env.DEPLOY_CMD }}\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a declared input DEFAULT resolves the working directory (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/i.yml',
      'name: w\non:\n  workflow_dispatch:\n    inputs:\n      dir:\n        default: apps/agent\n' +
        'jobs:\n  d:\n    steps:\n      - working-directory: ${{ inputs.dir }}\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a function body OPEN across lines is the call, not the definition (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      'x.sh',
      'deploy_worker() {\n  wrangler deploy\n}\ncd apps/agent\ndeploy_worker\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('wrangler-action deploys with no run body at all (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n' +
        '        with:\n          workingDirectory: apps/agent\n          command: deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but wrangler-action carrying the flag is blessed (r17 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n' +
        '        with:\n          workingDirectory: apps/agent\n          command: deploy --keep-vars\n',
    );
    expect(r.ok).toBe(true);
  });

  it('a FLOW-style step mapping runs from the job default directory (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/f.yml',
      'name: w\njobs:\n  d:\n    defaults:\n      run:\n        working-directory: apps/agent\n' +
        '    steps:\n      - { name: deploy, run: wrangler deploy }\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('an if condition ending in a YAML COMMENT is still false (r17)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/c.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - if: false # temporarily disabled\n' +
        '        working-directory: apps/agent\n        run: wrangler deploy\n',
    );
    expect(r.ok).toBe(true);
  });
});

describe('check-deploy-invocations — #1995 r17', () => {
  // A Bash helper written across lines is the ordinary spelling. Each logical
  // line was processed separately, so the definition recorded an EMPTY body,
  // the call after `cd apps/agent` looked up nothing, and the deploy inside
  // the body was scored where it is written — where no scope exists.
  it('a multiline function body whose call runs in a protected package', () => {
    const r = runWith(
      'contracts/script/redeploy.sh',
      'deploy_worker() {\n  wrangler deploy\n}\ncd apps/agent\ndeploy_worker\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('the same definition with its brace on the next line', () => {
    const r = runWith(
      'contracts/script/redeploy.sh',
      'deploy_worker()\n{\n  wrangler deploy\n}\ncd apps/agent\ndeploy_worker\n',
    );
    expect(r.ok).toBe(false);
  });

  it('but the same helper called from an UNPROTECTED directory passes', () => {
    // The caller's state decides which Worker the helper deploys — the same
    // rule the single-line definition already follows.
    const r = runWith(
      'contracts/script/redeploy.sh',
      'deploy_worker() {\n  wrangler deploy\n}\ncd apps/indexer\ndeploy_worker\n',
    );
    expect(r.ok).toBe(true);
  });

  // `cloudflare/wrangler-action` executes `wrangler <command>` (deploy when no
  // `command` input is given) from `workingDirectory` — a real deploy with no
  // line for the prefilter to match, so the workflow was discarded unread.
  it('wrangler-action with a scoped workingDirectory and the default command', () => {
    const r = runWith(
      '.github/workflows/deploy-agent.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          apiToken: ${{ secrets.CF_API_TOKEN }}',
        '          workingDirectory: apps/agent',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('wrangler-action with an explicit `command: deploy`', () => {
    const r = runWith(
      '.github/workflows/deploy-keeper.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/keeper',
        '          command: deploy',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });

  it('but wrangler-action carrying --keep-vars passes', () => {
    const r = runWith(
      '.github/workflows/deploy-agent.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/agent',
        '          command: deploy --keep-vars',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
  });

  it('and wrangler-action deploying an UNPROTECTED package passes', () => {
    const r = runWith(
      '.github/workflows/deploy-indexer.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/indexer',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
  });

  // A step spelled as a flow mapping is the same step, and Actions runs its
  // `run:` from the job's `defaults.run.working-directory` all the same — but
  // the line-anchored `run:` matchers never extracted the mid-mapping key.
  it('a flow-style step under a job-default working-directory', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    defaults:',
        '      run:',
        '        working-directory: apps/agent',
        '    steps:',
        '      - { name: deploy, run: wrangler deploy }',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a flow-style step with its own working-directory key', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        "      - { name: deploy, working-directory: apps/keeper, run: 'wrangler deploy' }",
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });

  // `if: false # temporarily disabled` parses as the boolean false — the step
  // can never run — but the capture kept the comment and the anchored test
  // failed, so a dead step blocked the build. A false red.
  it('a disabled step whose `if: false` carries a trailing comment passes', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: deploy',
        '        if: false # temporarily disabled',
        '        working-directory: apps/agent',
        '        run: wrangler deploy',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
  });
});

describe('check-deploy-invocations — #1995 r18', () => {
  it('a wrangler-action workingDirectory EXPRESSION resolves like the step key (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a.yml',
      'name: w\njobs:\n  d:\n    strategy:\n      matrix:\n        include:\n          - dir: apps/agent\n' +
        '    steps:\n      - uses: cloudflare/wrangler-action@v3\n        with:\n' +
        '          workingDirectory: ${{ matrix.dir }}\n          command: deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('and an env expression resolves the same way (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a2.yml',
      'name: w\nenv:\n  DEPLOY_DIR: apps/agent\njobs:\n  d:\n    steps:\n' +
        '      - uses: cloudflare/wrangler-action@v3\n        with:\n' +
        '          workingDirectory: ${{ env.DEPLOY_DIR }}\n          command: deploy\n',
    );
    expect(r.ok).toBe(false);
  });

  it('a FLOW-mapped wrangler-action step is the same step (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a3.yml',
      'name: w\njobs:\n  d:\n    steps:\n' +
        '      - { uses: cloudflare/wrangler-action@v3, with: { workingDirectory: apps/agent, command: deploy } }\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('a YAML anchor on an action input is a property, not the value (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/a4.yml',
      'name: w\njobs:\n  d:\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n        with:\n' +
        '          workingDirectory: &agent-dir apps/agent\n          command: &cmd deploy\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('the keyword function form without parentheses is a definition (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      'x.sh',
      'function deploy_worker {\n  wrangler deploy\n}\ncd apps/agent\ndeploy_worker\n',
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('mapping-like text inside a QUOTED flow value creates no field (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/q.yml',
      'name: w\njobs:\n  d:\n    defaults:\n      run:\n        working-directory: apps/agent\n' +
        '    steps:\n      - { name: "note, run: wrangler deploy" }\n',
    );
    expect(r.ok).toBe(true);
  });

  it('but a QUOTED KEY still names its field (r18 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      '.github/workflows/q2.yml',
      'name: w\njobs:\n  d:\n    defaults:\n      run:\n        working-directory: apps/agent\n' +
        '    steps:\n      - { "run": wrangler deploy }\n',
    );
    expect(r.ok).toBe(false);
  });

  it('keep_vars inside a string VALUE enables nothing (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    seed('apps/agent/wrangler.jsonc', '{"vars": {"NOTE": "keep_vars: true"}}\n');
    const r = runWith('x.sh', 'cd apps/agent\nwrangler versions upload\n');
    expect(r.ok).toBe(false);
  });

  it('while the real top-level boolean still blesses (r18 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    seed('apps/agent/wrangler.jsonc', '{\n  // comment survives the parse\n  "keep_vars": true,\n}\n');
    expect(runWith('x.sh', 'cd apps/agent\nwrangler versions upload\n').ok).toBe(true);
  });

  it('an alias body deploys where the CALL stands, under expand_aliases (r18)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    const r = runWith(
      'x.sh',
      "shopt -s expand_aliases\nalias deploy_worker='wrangler deploy'\ncd apps/agent\ndeploy_worker\n",
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but without expand_aliases a script alias never expands (r18 control)', () => {
    seed('apps/agent/package.json', '{"name":"@vaipakam/agent"}\n');
    expect(
      runWith(
        'x.sh',
        "alias deploy_worker='wrangler deploy'\ncd apps/agent\ndeploy_worker\n",
      ).ok,
    ).toBe(true);
  });
});

describe('check-deploy-invocations — #1995 r19', () => {
  // A helper EXECUTED as its own process inherits the caller's cwd exactly as
  // a sourced one does, but only `source` was deferred — so the caller was
  // skipped at the prefilter and the helper's own scan had no scope.
  it('a root-level helper executed after cd into a protected package', () => {
    seed('deploy.sh', 'wrangler deploy\n');
    const r = runWith('w.sh', 'cd apps/agent\n../../deploy.sh\n');
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('the same helper launched through an interpreter word', () => {
    seed('deploy.sh', 'wrangler deploy\n');
    const r = runWith('w.sh', 'cd apps/agent\nbash ../../deploy.sh\n');
    expect(r.ok).toBe(false);
  });

  it('but the helper executed from an unprotected directory passes', () => {
    seed('deploy.sh', 'wrangler deploy\n');
    const r = runWith('w.sh', 'cd apps/indexer\n../../deploy.sh\n');
    expect(r.ok).toBe(true);
  });

  // `deploy_worker production` still invokes the recorded helper; the call
  // matcher required the name to be the whole segment.
  it('a recorded helper called with arguments', () => {
    const r = runWith(
      'contracts/script/redeploy.sh',
      'deploy_worker() {\n  wrangler deploy\n}\ncd apps/agent\ndeploy_worker production\n',
    );
    expect(r.ok).toBe(false);
  });

  // A reusable workflow's required input has no default; its checked-in
  // caller supplies `dir: apps/agent`, which is statically known.
  it('a reusable workflow whose caller supplies the protected directory', () => {
    seed(
      '.github/workflows/caller.yml',
      [
        'jobs:',
        '  deploy:',
        '    uses: ./.github/workflows/reusable.yml',
        '    with:',
        '      dir: apps/agent',
        '',
      ].join('\n'),
    );
    const r = runWith(
      '.github/workflows/reusable.yml',
      [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      dir:',
        '        required: true',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: wrangler deploy',
        '        working-directory: ${{ inputs.dir }}',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  it('but a caller supplying an unprotected directory passes', () => {
    seed(
      '.github/workflows/caller.yml',
      [
        'jobs:',
        '  deploy:',
        '    uses: ./.github/workflows/reusable.yml',
        '    with:',
        '      dir: apps/indexer',
        '',
      ].join('\n'),
    );
    const r = runWith(
      '.github/workflows/reusable.yml',
      [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      dir:',
        '        required: true',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: wrangler deploy',
        '        working-directory: ${{ inputs.dir }}',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
  });

  // The command itself lives in a matrix axis: the declaration holds the
  // deploy text with no step scope, and the run body held the unresolved
  // expression.
  it('a matrix-supplied run command paired with a matrix directory', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix:',
        '        dir: [apps/agent]',
        "        cmd: ['wrangler deploy']",
        '    steps:',
        '      - run: ${{ matrix.cmd }}',
        '        working-directory: ${{ matrix.dir }}',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toContain('apps/agent');
  });

  // An alias-only scalar IS the anchored value to YAML; the property strip
  // only handled an alias with a scalar following it on the same node.
  it('an alias-only working-directory resolving to a protected anchor', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      AGENT_DIR: &agent-dir apps/agent',
        '    steps:',
        '      - run: wrangler deploy',
        '        working-directory: *agent-dir',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });

  // wrangler-action's `command:` as a block scalar: the one-line capture took
  // the marker `|` as the command, so the synthesised text held no deploy.
  it('wrangler-action with a literal block-scalar command', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/agent',
        '          command: |',
        '            deploy',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });

  it('wrangler-action with a folded block-scalar command', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/keeper',
        '          command: >',
        '            deploy',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(false);
  });

  it('but a block-scalar command carrying --keep-vars passes', () => {
    const r = runWith(
      '.github/workflows/deploy.yml',
      [
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: cloudflare/wrangler-action@v3',
        '        with:',
        '          workingDirectory: apps/agent',
        '          command: |',
        '            deploy --keep-vars',
        '',
      ].join('\n'),
    );
    expect(r.ok).toBe(true);
  });
});
