#!/usr/bin/env node
/**
 * Guard: every keeper deploy must preserve dashboard-managed vars.
 *
 * WHY THIS EXISTS. `wrangler deploy` without `--keep-vars` "will delete all
 * vars before setting those found in the Wrangler configuration". The keeper's
 * `wrangler.jsonc` declares exactly one var (`TG_BOT_USERNAME`, which nothing
 * reads), while `env.ts` reads eight more that live only in the Cloudflare
 * dashboard: `HF_SCALE`, the `LIQ_CONFIDENCE_*` and `LIQ_TIER3_*` thresholds,
 * `SPLIT_MIN_IMPROVEMENT_BPS`, `PARTIAL_LIQ_MIN_HF_BPS`. A bare deploy silently
 * erases the tuning that governs liquidation behaviour.
 *
 * The loss is invisible while the keeper is unscheduled (#1896) — nothing runs
 * to reveal it — and a later `--keep-vars` deploy then faithfully preserves the
 * ABSENCE, arming liquidation on defaults at the exact moment it starts
 * mattering.
 *
 * `apps/keeper/package.json`'s `deploy` script carries the flag, so
 * `pnpm --filter @vaipakam/keeper run deploy` is always safe. This guard exists
 * because that is not self-enforcing: PR #1924 fixed the package script, then
 * found the same bare invocation in three deploy wrappers, then in a rollout
 * runbook, then in a deployment runbook, then in the staging plan — four review
 * rounds, each finding the caller the previous fix had not looked at. Fixing
 * call sites one at a time demonstrably does not converge; asserting the
 * property over the whole tree does.
 *
 * WHAT COUNTS AS A VIOLATION: any keeper-scoped line mentioning
 * `wrangler deploy` without `--keep-vars` (or `--dry-run`, or the safe
 * `run deploy` form). That deliberately includes prose — see `ALLOWED` below
 * for why the burden is inverted rather than inferred.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// `CHECK_DEPLOY_ROOT` exists so the test suite can point this at a fixture
// tree instead of appending to real repo files. An earlier throwaway harness
// did mutate the repo and its cleanup reverted a real fix mid-run; scanning a
// temp directory removes that whole class of accident.
const REPO_ROOT = (
  process.env.CHECK_DEPLOY_ROOT ??
  new URL('../../../', import.meta.url).pathname
).replace(/\/$/, '');

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.wrangler', 'lib', 'cache', 'broadcast', 'artifacts', '.next',
]);

// `.json` is here for ONE file that matters more than the rest combined:
// `apps/keeper/package.json`. Its `deploy` script is the canonical entry point
// every corrected wrapper now calls, so a regression there re-breaks the whole
// tree-wide invariant while each wrapper still looks right (Codex #1924 r12).
const EXTENSIONS = ['.md', '.sh', '.ts', '.mjs', '.js', '.json', '.jsonc', '.yml', '.yaml'];

/**
 * DEFAULT-DENY. Every keeper-scoped `wrangler deploy` without `--keep-vars`
 * is a violation unless it appears here with a reason.
 *
 * The first cut of this guard tried to tell commands from prose by shape, and
 * missed two of the five forms it was written to catch — including the one
 * from the review round that prompted it. Distinguishing "run `wrangler
 * deploy`" from "a bare `wrangler deploy` deletes all vars" by regex is not a
 * problem worth solving: both are the same characters, and only intent
 * differs. So the burden is inverted. New prose that quotes the unsafe command
 * fails this check until someone adds it below and says why — which is
 * cheap, and is the point.
 *
 * Match is a substring of the line, so it survives reflow but not a rewrite.
 */
const ALLOWED = [
  {
    match: 'That reasoning was backwards: a bare `wrangler deploy`',
    why: 'README explains the hazard itself; naming the unsafe command is the subject.',
  },
  {
    match: 'editing `wrangler.jsonc` **and** running `wrangler deploy`',
    why: 'README: describes that a file edit alone does not re-arm the keeper.',
  },
  {
    match: 'Prefer the dashboard over `wrangler deploy` for this.',
    why: 'README: recommends AGAINST deploying on this path.',
  },
  {
    match: '`wrangler deploy` at the repo root picks up the ROOT',
    why: 'wrangler.jsonc: names the wrong command while explaining not to run it.',
  },
  {
    match: 'The claim was: a bare `wrangler deploy` of `apps/keeper` deletes',
    why: 'IncidentRunbook: quotes the hazard as the finding under discussion.',
  },
  {
    match: 'cf-keeper       — wrangler deploy apps/keeper (autonomous keeper).',
    why: 'deploy-mainnet.sh --help text: a phase summary, not an invocation.',
  },
  {
    match: 'cf-keeper        — wrangler deploy apps/keeper (autonomous keeper).',
    why: 'deploy-testnet.sh --help text: a phase summary, not an invocation.',
  },
];

function allowReason(line) {
  const hit = ALLOWED.find((a) => line.includes(a.match));
  return hit ? hit.why : null;
}

/**
 * A flag counts only when it is actually ENABLED. `--keep-vars=false` is a
 * live deploy that deletes vars, and `--dry-run=false` really does deploy —
 * a bare substring test reads both as safe (Codex #1924 r12, reproduced).
 * `--flag`, `--flag true` and `--flag=true` all enable; only an explicit
 * false-ish value disables.
 */
/**
 * Neutralize OTHER options' quoted values before looking for safety flags.
 *
 * `--message="remember --keep-vars"` is a destructive bare deploy, but the
 * text inside the message read as the real flag (Codex #1924 r19). The narrow
 * property that fixes it: a safety flag never counts when it sits inside
 * another option's QUOTED value.
 *
 * This is deliberately not a shell tokenizer. A full one was written first and
 * failed six correct lines, because markdown backticks, a JSON string wrapper
 * and an apostrophe in "keeper's" are all indistinguishable from shell quoting
 * by shape — and every fix for one uncovered another. Matching only the
 * `--opt="…"` shape leaves prose alone entirely.
 *
 * The safety flags themselves are excluded from the strip, so
 * `--keep-vars="true"` survives. Unquoted values are not stripped and should
 * not be: in `--message remember --keep-vars` the shell really does see a
 * separate `--keep-vars`.
 */
function stripOtherOptionValues(line) {
  // Replaced with a NUL escape, NOT a space (Codex #1924 r23). A space would
  // create a token boundary the shell never saw: in
  // `--message='note'--keep-vars` the shell builds ONE argument,
  // `--message=note--keep-vars`, and no flag is enabled — but stripping to a
  // space left ` --keep-vars`, which then read as a real, token-initial flag.
  // The strip must not manufacture the very boundary the lookbehind tests for,
  // so it leaves a character that is not an allowed predecessor.
  return line.replace(
    /--(?!keep-vars\b|dry-run\b)[A-Za-z0-9-]+(?:=|\s+)(?:"[^"]*"|'[^']*')/g,
    '\u0000',
  );
}

/**
 * A flag counts only when it is actually ENABLED. `--keep-vars=false` is a
 * live deploy that deletes vars, and `--dry-run=false` really does deploy —
 * a bare substring test reads both as safe (Codex #1924 r12, reproduced).
 * `--flag`, `--flag true` and `--flag=true` all enable; only an explicit
 * false-ish value disables.
 */
function flagEnabled(rawLine, flag) {
  const line = stripOtherOptionValues(rawLine);
  // Quoted values are values. An earlier pattern excluded quotes from the
  // captured value, so `--keep-vars="false"` failed the capture, backtracked
  // to the optional-group-absent branch, and read as a bare — i.e. ENABLED —
  // flag (Codex #1924 r13, reproduced).
  // LAST occurrence wins, because that is what the CLI does. Verified against
  // wrangler 4.90.0: `--keep-vars --keep-vars=false` parses as
  // `keepVars: false`, yet a single `.match()` accepted the first, enabling
  // occurrence and blessed a destructive deploy (Codex #1924 r20).
  // `(?!-)` on the unquoted alternative: a token starting with `-` is the NEXT
  // option, not this flag's value. Without it the first `--keep-vars` in
  // `--keep-vars --keep-vars=false` swallowed the second as its own value, so
  // matchAll yielded ONE match reading as enabled and "last occurrence wins"
  // silently did nothing. It has to be in the pattern: matchAll iterates a
  // CLONE, so adjusting `lastIndex` from the loop body has no effect.
  // `(?<![^\\s(\`'"])` — the flag must BEGIN a shell token. Without it,
  // `--message=remember--keep-vars` had its suffix read as a real flag and the
  // destructive deploy passed (Codex #1924 r21). The r19 fix only neutralized
  // QUOTED option values, so the unquoted same-argument form slipped through.
  //
  // `=` is NOT an allowed predecessor (Codex #1924 r22). Admitting it let
  // `--message=--keep-vars` — another option whose entire value looks like the
  // flag — pass as well. It was never needed: in `--keep-vars=true` the flag
  // is preceded by whitespace and it is the VALUE that follows the `=`.
  const re = new RegExp(
    `(?<![^\\s(\`'"])${flag}(?:[=\\s]+(?:"([^"]*)"|'([^']*)'|((?!-)[^\\s"'\`)]+)))?`,
    'g',
  );
  let effective = null;
  for (const m of line.matchAll(re)) {
    const value = m[1] ?? m[2] ?? m[3];
    effective = value === undefined ? true : !/^(false|0|no|off)$/i.test(value.trim());
  }
  return effective === true;
}

/**
 * Strip a trailing shell comment before looking for safety tokens.
 *
 * `wrangler deploy # TODO: add --keep-vars` executes a BARE deploy, but a
 * whole-line search finds the flag in the comment and passes it (Codex #1924
 * r17, reproduced). The inverse is worse: an unsafe command followed by a
 * comment mentioning `run deploy` also passed. Safety must be read from what
 * the shell runs, not from what the line says somewhere.
 *
 * `#` inside quotes is not a comment, so quoted regions are skipped. Markdown
 * prose is unaffected: it reaches here only via the default-deny path, where a
 * stripped `#` cannot make an unsafe line look safe.
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1; // escaped char, including \#, is literal
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    // A `#` is a comment only at a TOKEN BOUNDARY. Inside a word it is a
    // literal character — `--message fix#1896` is a real wrangler flag value,
    // and truncating there removed a genuine `--keep-vars` further along the
    // line and FAILED a correct command (Codex #1924 r18). A guard that
    // blocks valid CI is a guard that gets deleted.
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * One line can carry several commands. `pnpm run deploy && wrangler deploy`
 * has a safe token and an unsafe invocation; judging the line as a whole
 * blessed both (Codex #1924 r18). Split on the shell separators that start a
 * new command, respecting quotes, and judge each piece on its own.
 */
function splitCommands(line) {
  const parts = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(line.slice(start, i));
      start = i + 2;
      i += 1;
    } else if (ch === ';' || ch === '|' || ch === '&') {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

function commandIsSafe(cmd) {
  // `run deploy` gets the same option-value strip the flags do: it was a raw
  // substring test, so `--message="run deploy"` blessed a bare deploy that
  // never invokes the package script (Codex #1924 r22). `flagEnabled` already
  // strips internally; this call is for the `run deploy` test.
  const bare = stripOtherOptionValues(cmd);
  return (
    flagEnabled(cmd, '--keep-vars') ||
    flagEnabled(cmd, '--dry-run') ||
    /(?:^|\s)(?:pnpm|npm|yarn)(?:\s+[^\s]+)*?\s+run\s+deploy\b/.test(bare)
  );
}

/**
 * Safe only if EVERY `wrangler deploy` on the line is safe. A line with no
 * deploy at all is safe by vacuity — the caller has already established that
 * the line mentions one, so this cannot mask anything.
 */
function isSafe(rawLine) {
  const line = stripComment(rawLine);
  const deploys = splitCommands(line).filter((c) => /wrangler\s+deploy\b/.test(c));
  if (deploys.length === 0) return true;
  return deploys.every(commandIsSafe);
}

/**
 * Keeper-scoped by explicit reference, or by living in the keeper's own tree.
 *
 * The brace form matters and is not decoration: the staging plan writes
 * `apps/{keeper,indexer,agent}`, which contains neither the literal
 * `apps/keeper` nor a pnpm filter. An earlier cut of this guard missed exactly
 * that line — the one violation the review round was about — because it only
 * looked for the expanded spelling.
 */
function isKeeperScoped(line, filePath) {
  return (
    /@vaipakam\/keeper/.test(line) ||
    /KEEPER_DIR/.test(line) ||
    /apps\/keeper/.test(line) ||
    /apps\/\{[^}]*keeper[^}]*\}/.test(line) ||
    filePath.startsWith('apps/keeper/')
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.some((e) => entry.endsWith(e))) {
      yield full;
    }
  }
}

const violations = [];
for (const file of walk(REPO_ROOT)) {
  const rel = relative(REPO_ROOT, file);
  // This guard's own documentation quotes the unsafe form on purpose, and its
  // test file is ENTIRELY unsafe fixtures — that is what it tests. Skipping
  // both by name rather than by content, so no real file can hide here.
  if (rel.endsWith('check-deploy-invocations.mjs')) continue;
  if (rel.endsWith('test/checkDeployInvocations.test.ts')) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes('wrangler deploy')) continue;
  // Directory context carries across lines, but only within a CONTIGUOUS
  // block. The form to catch is
  //     cd apps/keeper
  //     wrangler deploy
  // where the deploy line names nothing keeper-related, so a per-line scope
  // test passes it (Codex #1924 r11, reproduced before fixing).
  //
  // The first fix tracked the last `cd` seen with no block boundary, which
  // leaked context through entire files: in `deploy-testnet.sh` the keeper
  // phase's `cd` made every later phase — indexer, agent — look keeper-scoped,
  // producing seven false positives on a clean tree. A guard that cries wolf
  // on correct code gets disabled, so the scope is now deliberately narrow:
  // a blank line, a fence, or any other `cd` ends it.
  //
  // A same-line subshell (`( cd "$KEEPER_DIR" && … )`) is NOT tracked here —
  // its `cd` cannot outlive the subshell, and the per-line test already
  // covers it.
  let cwdIsKeeper = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*$/.test(line) || /^\s*```/.test(line)) {
      cwdIsKeeper = false;
    } else {
      const bareCd = line.match(/^\s*cd\s+["']?([^\s"';&|)]+)/);
      if (bareCd) {
        cwdIsKeeper =
          /(^|\/)apps\/keeper\/?$/.test(bareCd[1]) || /KEEPER_DIR/.test(bareCd[1]);
      }
    }

    // `\b` so `wrangler deployments list` is not read as a deploy.
    if (!/wrangler\s+deploy\b/.test(line)) return;
    if (!isKeeperScoped(line, rel) && !cwdIsKeeper) return;
    if (isSafe(line)) return;
    if (allowReason(line)) return;
    violations.push(`${rel}:${i + 1}\n    ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    `\n[check-deploy-invocations] ${violations.length} keeper deploy(s) missing --keep-vars:\n`,
  );
  for (const v of violations) console.error(`  ${v}\n`);
  console.error(
    'Use `pnpm --filter @vaipakam/keeper run deploy` (the package script carries\n' +
      'the flag), or add --keep-vars explicitly. A bare deploy deletes every var\n' +
      'not in apps/keeper/wrangler.jsonc — including the HF_SCALE / LIQ_* / SPLIT_*\n' +
      '/ PARTIAL_LIQ_* tuning that env.ts reads and that governs liquidation.\n',
  );
  process.exit(1);
}

console.log('[check-deploy-invocations] OK — every keeper deploy preserves vars.');
