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

const EXTENSIONS = ['.md', '.sh', '.ts', '.mjs', '.js', '.jsonc', '.yml', '.yaml'];

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

function isSafe(line) {
  return /--keep-vars/.test(line) || /--dry-run/.test(line) || /\brun\s+deploy\b/.test(line);
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
