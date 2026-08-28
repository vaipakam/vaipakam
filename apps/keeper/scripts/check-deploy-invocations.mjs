#!/usr/bin/env node
/**
 * Guard: every deploy of a SCOPED Worker must preserve dashboard-managed vars.
 *
 * Scope is `apps/keeper` and `apps/agent` — see `SCOPED` below for the evidence
 * that puts each one there, and for the Workers audited and deliberately left
 * out. It covered only the keeper until #1933; the agent had the identical
 * hazard and nine bare invocations that this guard could not see.
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
 * KNOWN LIMIT, recorded rather than fixed: in a SHELL file, a
 * `wrangler deploy` written inside a multi-line quoted string is reported as
 * a violation even though bash would only print it. Telling a command from
 * the same text inside a quoted argument needs shell word analysis, and every
 * attempt at that in PR #1924 broke a real case instead — the last one blanked
 * `"$KEEPER_DIR"`, which is precisely how the deploy wrappers identify keeper
 * scope. The workaround is to reword the string. Over-reporting is the safe
 * direction PROVIDED it stays rare; if this fires on real content, reconsider
 * the approach rather than widening `ALLOWED`.
 *
 * SECOND KNOWN LIMIT, also recorded rather than fixed: an `ALLOWED` prose
 * exemption applies in shell files too, so `echo "…a bare \`wrangler deploy\`"`
 * — which bash runs as command substitution — inherits it. Restricting
 * exemptions to non-shell files was tried and FAILED real content: the
 * `--help` usage text in `deploy-{testnet,mainnet}.sh` lives inside a heredoc,
 * where it is data rather than a command, and the guard began reporting two
 * correct lines. Telling heredoc data from commands is another slice of shell
 * parsing, and this loop has repeatedly shown that each slice costs a false
 * positive elsewhere. The exposure is narrow — it needs someone to embed an
 * allowlisted SENTENCE verbatim in executable shell — and the entries are
 * long, specific strings.
 *
 * THIRD KNOWN LIMIT, recorded after being tried and reverted: a `cd` that
 * FAILS at runtime leaves the shell where it was, so
 * `cd apps/keeper && cd missing; wrangler deploy` really does deploy from the
 * keeper — and this scanner reads it as apps/keeper/missing and stays quiet
 * (Codex #1924 r40). It is not fixable from the text alone. Modelling every
 * `cd` as possibly-failing is the sound reading of "we cannot know", and it
 * immediately rejects `cd apps/keeper; cd ../agent; wrangler deploy` — an
 * ordinary correct wrapper, and the exact case r38 required NOT be flagged.
 * The two cannot both hold: the forms are structurally identical and differ
 * only in whether the target happens to exist.
 *
 * Deciding it on existence was implemented and reverted the same round. It
 * failed five regression tests standing for previously accepted findings, and
 * on the real tree it makes the verdict depend on whether a directory is
 * present in this checkout — so an ordinary `cd` into a not-yet-generated
 * build directory would start holding keeper scope. For a guard that runs
 * inside `typecheck`, a false red on correct code is the more expensive error,
 * and this loop has produced that trade twice already (r19/r20, r35). The
 * exposure needs a wrapper that is ALREADY broken — cd-ing somewhere absent —
 * and the deploy it then misses is one the wrapper's own failure surfaces.
 *
 * WHAT COUNTS AS A VIOLATION: any line in a scoped package mentioning
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

/**
 * Directories never worth walking — matched by BASENAME at every level, which
 * is why `lib` is NOT in here (Codex #1924 r24).
 *
 * This repo has first-party `lib` directories: `contracts/script/lib` holds
 * `FacetSelectors.sol`, and `packages/lib` is a workspace package. Skipping
 * every directory named `lib` therefore punched a hole straight through the
 * "tree-wide" claim — a deploy helper added under `contracts/script/lib` was
 * invisible to the guard. The vendored tree that motivated the entry is
 * `contracts/lib` (forge submodules), so it is excluded by PATH below instead
 * of by name.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.wrangler', 'cache', 'broadcast', 'artifacts', '.next',
]);

/**
 * `deploy` need not be the word straight after `wrangler`: global flags may
 * precede the subcommand, and `wrangler --cwd apps/keeper deploy` is a real
 * bare deploy that every literal `wrangler deploy` test missed (Codex #1924
 * r31). Intervening tokens are allowed as long as they look like options.
 * The executable may also be version-qualified — `npx wrangler@4.90.0 deploy`
 * is the ordinary npm pinning form (Codex #1924 r33).
 */
// `wrangler2` is the SAME binary: wrangler's package manifest maps both names
// to `./bin/wrangler.js`, and `wrangler2 deploy --help` describes the same
// command (#1995 r13).
// `versions upload` erases vars exactly as `deploy` does (#1995 r14). Checked
// against the wrangler in this workspace (4.94.0) rather than taken on trust:
//
//   --keep-vars   When not used (or set to false), Wrangler will delete all
//                 vars before setting those found in the Wrangler configuration.
//
// Same sentence the `deploy` flag carries, and neither scoped `wrangler.jsonc`
// sets `keep_vars`, so an unflagged `versions upload` deletes the dashboard
// tuning the same way. It takes the same flag, so the remedy is the same one.
const DEPLOY_RE = String.raw`wrangler2?(?:@[^\s]+)?\s+(?:-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?\s+)*(?:deploy|versions\s+upload)\b`;

/**
 * The PACKAGE-SCRIPT form is a deploy too, and the guard could not see it
 * (#1995 r4). `pnpm --filter @vaipakam/agent run deploy --no-keep-vars` expands
 * to `wrangler deploy --keep-vars --no-keep-vars`, which wrangler parses as
 * keepVars:false — a destructive deploy on a line containing no `wrangler
 * deploy` at all, so nothing here ever examined it.
 *
 * `run-script` is a documented alias of `run` (verified: `pnpm help run` lists
 * it), so both spellings count (#1995 r5).
 */
// `run` itself takes options before the script name — pnpm documents
// `--if-present` — and requiring `deploy` to be the very next token missed
// `run --if-present deploy` entirely (#1995 r6).
// `npm run --help` lists `run-script`, `rum` and `urn` as aliases of `run`
// (#1995 r10). A wrapper using one of them was not recognised as a deploy at
// all, so the file prefilter skipped it.
/**
 * The spellings of `run`, in ONE place (#1995 r11).
 *
 * `npm run --help` lists `run-script`, `rum` and `urn` as aliases. r10 taught
 * the DETECTOR about them and left the SAFETY matcher on `run|run-script`, so
 * `npm rum deploy` — which invokes the package's `--keep-vars` script — became
 * a deploy candidate that could never be judged safe, and was reported as a
 * violation. A false red, from widening one of two matchers that have to agree.
 *
 * They read the same constant now, so the next alias is one edit rather than
 * two that can drift apart.
 */
const RUN_ALIASES = String.raw`run(?:-script)?|rum|urn`;
const RUN_DEPLOY_RE = String.raw`(?:pnpm|npm|yarn)(?:\s+[^\s]+)*?\s+(?:${RUN_ALIASES})(?:\s+-{1,2}[A-Za-z0-9-]+(?:=[^\s]*)?)*\s+deploy\b`;
/** What counts as "this line performs a deploy" for DETECTION purposes. */
const ANY_DEPLOY_RE = `(?:${DEPLOY_RE}|${RUN_DEPLOY_RE})`;

/**
 * ONE SHELL WORD: adjacent quoted, unquoted and escaped chunks, which bash
 * concatenates into a single argument. `--name vaipakam"-"agent`,
 * `cd "$ROOT"/apps/agent`, `--filter '@vaipakam/'"*gent"` and `de"ploy"` are all
 * one word each.
 *
 * This is the single most repeated defect in this file — #1924 r23/r24, r30,
 * #1995 r4a, r6c, and three more in r8 — always with the same tell: a pattern
 * that stops at the first chunk. It is named here so the next site copies THIS
 * rather than a neighbouring single-chunk pattern.
 */
// The unquoted alternative EXCLUDES backslash (#1995 r15 follow-on). With it
// admitted, a backslash matched both `(?:\\[\s\S])` and this class, so a run
// of them could be partitioned exponentially many ways and any non-match walked
// all of them. Measured on `^cd\s+(WORD)$` against `cd \a\a…` with a trailing
// space: 10 repeats 207 ms, 14 repeats 14.7 SECONDS, 18 repeats did not finish
// in five minutes. Disjoint, the same inputs are 0.1 ms.
//
// CodeQL flagged the sibling `$'…'` pattern and not this one; it was found by
// sweeping the shape rather than the alert.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|(?:\\[\s\S])|[^\s"'\`;&|)\\]+)+`;
/**
 * Shell DECLARATION builtins that may precede an assignment (#1995 r12).
 *
 * `export TARGET=apps/agent` binds the variable exactly as `TARGET=apps/agent`
 * does, but only the bare spelling was recognised, so a later `cd "$TARGET"`
 * cleared scope instead of entering the protected package.
 *
 * ONE constant, read by both the gate and the matcher below it. Those two have
 * to agree about what an assignment looks like, and the last thing to break on
 * this file was exactly that shape of drift — a widened detector beside an
 * unwidened judge (#1995 r11).
 */
const DECL_PREFIX = String.raw`(?:(?:export|declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?`;

/** Collapse a captured word to what the shell would hand the command. */
function dequote(w) {
  return (
    w
      // `$'…'` is ANSI-C quoting — a quoted WORD. Stripping the quotes first
      // and the `$` never left a stray `$`, which then read as an unresolved
      // parameter expansion and cleared scope on a static target: bash enters
      // `apps/agent` for `cd apps/$'agent'` (#1995 r15).
      // `[^'\\]`, not `[^']` — CodeQL js/redos, high (#1995 r15 follow-on).
      // A backslash matched BOTH alternatives, so a run of them could be
      // partitioned exponentially many ways, and an unterminated `$'…` forced
      // the engine through all of them. Measured before and after: 24 repeats
      // of `\&` took 226 ms on the overlapping form and 0.007 ms on this one,
      // roughly quadrupling per two characters added.
      //
      // Same defect I introduced in the assignment matcher earlier in this PR
      // and fixed the same way: make the alternatives DISJOINT so each
      // character has exactly one parse.
      .replace(/\$'((?:\\[\s\S]|[^'\\])*)'/g, '$1')
      .replace(/\\([\s\S])/g, '$1')
      .replace(/["'`]/g, '')
  );
}

/** Vendored trees excluded by exact repo-relative path, not by basename. */
const SKIP_PATHS = new Set(['contracts/lib']);

// `.json` is here for ONE file that matters more than the rest combined:
// `apps/keeper/package.json`. Its `deploy` script is the canonical entry point
// every corrected wrapper now calls, so a regression there re-breaks the whole
// tree-wide invariant while each wrapper still looks right (Codex #1924 r12).
// `.bash` / `.zsh` / `.ksh` are ordinary names for a shell wrapper, and they
// fell through EVERY arm of the file selection: they are not `.sh`, and
// `looksExecutable` rejects anything containing a dot, so a shebang-bearing
// `apps/keeper/release.bash` with a bare deploy was never opened
// (Codex #1924 r38).
const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh'];
const EXTENSIONS = [
  ...SHELL_EXTENSIONS,
  '.md',
  '.ts',
  '.mjs',
  '.js',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
];

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
    match: 'scoped to the `wrangler versions upload` flow',
    why: "keeper README: names the command while explaining that `wrangler triggers deploy` is NOT the answer; it invokes nothing.",
  },
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
  {
    match: 'cf-agent        — wrangler deploy apps/agent (notifications, frames).',
    why: 'deploy-mainnet.sh --help text: a phase summary, not an invocation.',
  },
  {
    match: 'cf-agent         — wrangler deploy apps/agent (notifications, frames).',
    why: 'deploy-testnet.sh --help text: a phase summary, not an invocation.',
  },
  {
    match: '`run deploy`, NOT `exec wrangler deploy` — the line above used to spell',
    why: 'apps/agent/src/index.ts: a comment contrasting the safe form with the unsafe one.',
  },
  {
    match: '`wrangler deploy`-ed since wrangler.jsonc gained the binding), we',
    why: 'apps/agent/src/quoteProxy.ts: names the event that changed the binding, not a command to run.',
  },
  {
    match: 'Re-add the rate-limit binding to `apps/agent/wrangler.jsonc` and `npx wrangler deploy`.',
    why: 'ReleaseNotes-2026-06-10: a HISTORICAL record of what the operator did. Editing shipped release notes to add a flag would falsify the account.',
  },
  {
    match: 'added the matching binding to `apps/agent/wrangler.jsonc` + `npx wrangler deploy` (live version',
    why: 'docs/ToDo.md OP-001: the OUTCOME half of the same closed 2026-06-08 record.',
  },
  {
    match: 'the commented block shows the exact declaration; replace `<chosen-id>` with the id from step 2) + `cd apps/agent && npx wrangler deploy`',
    why: 'docs/ToDo.md OP-001: a CLOSED item recording a completed 2026-06-08 operator action; the live instruction it points at (DeploymentRunbook) carries the flag.',
  },
];

function allowReason(line) {
  // EVERY matching exemption is removed, not just the first (#1933). One line
  // can carry two allowlisted quotes: `docs/ToDo.md`'s OP-001 entry records the
  // same completed operator action twice — once in its outcome and once in the
  // steps it superseded — so removing one fragment left the other standing and
  // the whole line was reported. Composing them keeps the r27 property intact,
  // because what is tested afterwards is whatever is LEFT.
  const hits = ALLOWED.filter((a) => line.includes(a.match));
  if (hits.length === 0) return null;
  // The exemption covers the KNOWN prose occurrences, not the whole line. An
  // allowlisted sentence that later grows a real command beside it —
  // `…a bare \`wrangler deploy\` is dangerous; wrangler deploy` — would
  // otherwise be exempted wholesale (Codex #1924 r27). Remove the matched
  // fragments and see whether a deploy is still standing.
  let rest = line;
  for (const h of hits) rest = rest.split(h.match).join(' ');
  // ANY_DEPLOY_RE, not DEPLOY_RE: once the package-script form counts as a
  // deploy (#1995 r4), an exemption that leaves `pnpm … run deploy
  // --no-keep-vars` standing must not clear the line (#1995 r5). The residue
  // test only means anything if it looks for everything detection looks for.
  return new RegExp(ANY_DEPLOY_RE).test(rest) ? null : hits.map((h) => h.why).join(' ');
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
/**
 * A redirection operand is a FILENAME. `wrangler deploy > --keep-vars` runs a
 * bare deploy and creates a file called `--keep-vars`, but the operand read as
 * an enabled flag (Codex #1924 r30). Removed before any flag scanning.
 */
function stripRedirections(line) {
  // Longest operator first: `<<<` is a here-string, and matching a bare `<`
  // consumed the remaining `<<` as its operand, leaving the real operand to be
  // counted as an enabled flag (Codex #1924 r31).
  return line.replace(
    /(?:&>>|&>|\d?(?:<<<|<<|<>|>>|>&|<&|>|<))\s*&?\s*(?:"[^"]*"|'[^']*'|[^\s"';&|)]+)/g,
    ' ',
  );
}

function stripOtherOptionValues(line, keep = []) {
  // Replaced with a NUL escape, NOT a space (Codex #1924 r23). A space would
  // create a token boundary the shell never saw: in
  // `--message='note'--keep-vars` the shell builds ONE argument,
  // `--message=note--keep-vars`, and no flag is enabled — but stripping to a
  // space left ` --keep-vars`, which then read as a real, token-initial flag.
  // The strip must not manufacture the very boundary the lookbehind tests for,
  // so it leaves a character that is not an allowed predecessor.
  // One shell argument can MIX quoted and unquoted chunks with no whitespace
  // between them: `--message=note'--keep-vars'` is a single argument,
  // `--message=note--keep-vars`, enabling nothing. Matching only wholly-quoted
  // values let the quoted suffix survive and read as a real flag (Codex #1924
  // r24). A value is therefore one-or-more adjacent chunks, and whitespace is
  // what ends it — so `--message remember --keep-vars`, where the shell really
  // does pass a separate flag, is still left alone.
  // `(?:\\[\s\S])` in the chunk set: an ESCAPED character — including an
  // escaped space — is part of the value, not the end of it. Bash passes
  // `--message=note\ --keep-vars` as ONE argument, so nothing is enabled, but
  // a pattern that stopped at the backslash-space left `--keep-vars` looking
  // token-initial (Codex #1924 r25).
  // Two forms, and the difference is load-bearing (Codex #1924 r26):
  //   `--opt=<value>`  — attached, so the value is whatever follows the `=`.
  //   `--opt <value>`  — separated, and the value must NOT begin with `-`.
  // Without that `(?!-)`, a boolean option before the flag —
  // `wrangler deploy --strict --keep-vars`, both booleans per wrangler's own
  // help — had `--keep-vars` consumed as `--strict`'s value, and the guard
  // REJECTED a perfectly safe command. That is the failure mode that gets a
  // guard deleted: it runs in typecheck, so it would block CI on valid input.
  const CHUNKS = '(?:"[^"]*"|\'[^\']*\'|(?:\\\\[\\s\\S])|[^\\s"\'\\\\]+)+';
  // `keep` extends the never-stripped set. `selectorScope` passes its own
  // flags, because it needs the SAME neutralisation for everything else:
  // `--message="note --name vaipakam-indexer"` had its quoted text parsed as a
  // real target selector, and the fake name then authoritatively suppressed the
  // cwd scope of a bare agent deploy (#1995 r3).
  const never = ['keep-vars', 'dry-run', 'no-keep-vars', 'no-dry-run', ...keep]
    .map((f) => `${f}\\b`)
    .join('|');
  return line.replace(
    new RegExp(`--(?!${never})[A-Za-z0-9-]+(?:=${CHUNKS}|\\s+(?!-)${CHUNKS})`, 'g'),
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
/**
 * Blank COMMAND SUBSTITUTIONS before scoring safety flags (#1995 r14).
 *
 * `wrangler deploy $(echo --keep-vars >&2)` runs a bare deploy — the
 * substitution writes to stderr and contributes no argument — but its source
 * text contains `--keep-vars`, and that was enough to bless it.
 *
 * A flag whose presence depends on what a command PRINTS cannot be verified
 * from the text, so it must not count as safe. That is the direction this file
 * takes everywhere else for unknowns: an assignment whose value contains `$`
 * is left unremembered rather than guessed. The cost is that
 * `deploy $(echo --keep-vars)` — which really does emit the flag — is now
 * reported; that is a contrived spelling, and erring toward reporting is the
 * side a SAFETY predicate should err on.
 *
 * `$( … )` only, and deliberately NOT backticks: `flagEnabled` also runs on
 * prose, where a backtick is a Markdown code span and the command itself sits
 * inside one. Blanking those would delete the command being judged. Backtick
 * substitution in a shell file is a recorded limit, not a claim.
 *
 * Replaced with the same NUL placeholder `stripOtherOptionValues` uses, so no
 * token boundary is manufactured where the shell saw none.
 */
function stripCommandSubstitutions(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      out += text[i] + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '(') {
      // The depth walk has to respect QUOTING and escapes, or a quoted paren
      // inside the substitution ends it early and leaves its contents visible:
      // `wrangler deploy $(echo ')' --keep-vars >&2)` produces no stdout, so
      // the deploy is bare, but the inert `--keep-vars` blessed it (#1995 r15).
      let depth = 1;
      let j = i + 2;
      let q = null;
      for (; j < text.length && depth > 0; j += 1) {
        const c = text[j];
        if (c === '\\') {
          j += 1;
          continue;
        }
        if (q) {
          if (c === q) q = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') q = c;
        else if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
      }
      out += '\u0000';
      i = j - 1;
      continue;
    }
    out += text[i];
  }
  return out;
}

/**
 * A flag name with optional quote characters between its letters.
 *
 * Bash concatenates `--no-keep-"vars"` into `--no-keep-vars`, and scoring the
 * raw text read it as an unknown token and left an earlier `--keep-vars`
 * standing (#1995 r15). Tolerating quotes only INSIDE THE NAME is deliberate:
 * my first attempt dequoted whole flag tokens and ran into their VALUES,
 * breaking seven #1924 cases where quoting round the `=` or the value is
 * load-bearing (`--keep-vars"="false`, `--keep-vars"=true garbage"`).
 */
function quoteTolerant(name) {
  const Q = `["'\`]*`;
  return name
    .split('')
    .map((c) => (/[a-z0-9]/i.test(c) ? c : `\\${c}`))
    .join(Q);
}

function flagEnabled(rawLine, flag) {
  // `executedCommand` FIRST (#1995 r6). A leading environment assignment is
  // passed through the ENVIRONMENT, never as an argument, so
  // `NOTE="--keep-vars" wrangler deploy` is a bare, destructive deploy — but
  // the flag was read out of the assignment's quoted value and BLESSED it.
  // This is the r40 `run deploy` case and the r4 `--name` case in a third
  // spelling. Both of those were fixed at their own call site, which is why
  // this one survived: the SAFETY predicate had never been asked the question.
  const line = stripOtherOptionValues(
    executedCommand(
      stripCommandSubstitutions(stripRedirections(normalizeFlagEquals(rawLine))),
    ),
  );
  // Quoted values are values. An earlier pattern excluded quotes from the
  // captured value, so `--keep-vars="false"` failed the capture, backtracked
  // to the optional-group-absent branch, and read as a bare — i.e. ENABLED —
  // flag (Codex #1924 r13, reproduced).
  // LAST occurrence wins, because that is what the CLI does. Verified against
  // wrangler 4.90.0: `--keep-vars --keep-vars=false` parses as
  // `keepVars: false`, yet a single `.match()` accepted the first, enabling
  // occurrence and blessed a destructive deploy (Codex #1924 r20).
  // `\u0000` is excluded from the value class: it is the placeholder
  // `stripOtherOptionValues` leaves behind. Once assigned values had to
  // parse as literally true, capturing that placeholder as a value turned a
  // bare `--dry-run --outdir …` into a violation — a false positive I
  // introduced with the stricter rule and caught on the live tree.
  //
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
  // The NAME is quote-tolerant; the value patterns are untouched, because
  // quoting there is load-bearing (#1995 r15).
  const flagRe = quoteTolerant(flag);
  const re = new RegExp(
    `(?<![^\\s(\`'"])${flagRe}(?:=((?:"[^"]*"|'[^']*'|[^\\s"'\`)\\u0000]+)+)` +
      `|\\s+(?:"([^"]*)"|'([^']*)'|((?![-#])[^\\s"'\`)\\u0000]+)))?`,
    'g',
  );
  const events = [];
  for (const m of line.matchAll(re)) {
    // `(?![-#])` keeps the NEXT option and a trailing comment marker from being
    // read as this flag's value: under the true-only rule a bare
    // `--keep-vars # note` in prose was otherwise scored false.
    // ATTACHED (`--flag=x`) and SEPARATED (`--flag x`) values need different
    // rules, and collapsing them was wrong in both directions (Codex #1924
    // r29). Only a SEPARATED value can be mistaken for the next option or a
    // comment, so `(?![-#])` belongs there alone: in `--keep-vars=#false` the
    // `#` is part of the argument, and excluding it made the whole value
    // branch fail and backtrack to "bare flag, enabled" — blessing a deploy
    // wrangler itself parses as false.
    // An ATTACHED value is one shell WORD, and a word can mix adjacent quoted
    // and unquoted chunks: `--keep-vars='true'garbage` is the single argument
    // `--keep-vars=truegarbage`, which is not true. Stopping at the quoted
    // prefix scored it safe (Codex #1924 r30), so the attached branch captures
    // the whole word and the quotes are removed afterwards.
    const attached = m[1] === undefined ? undefined : m[1].replace(/["'`]/g, '');
    const value = attached ?? m[2] ?? m[3] ?? m[4];
    events.push({
      at: m.index,
      // wrangler declares these `[boolean] [default: false]`, and its parser
      // evaluates anything that is not literally true-ish as FALSE — so
      // `--keep-vars=yes`, `=garbage` and `=` are all destructive deploys.
      // An allow-list of false-ish words got that backwards (Codex #1924 r28).
      on: value === undefined ? true : /^(true|1)$/i.test(value.trim()),
    });
  }
  // wrangler supports the `--no-<flag>` negation, and it is simply another
  // later occurrence: `--keep-vars --no-keep-vars` parses as keepVars:false
  // (verified against 4.90.0). Scanning only the positive spelling blessed it
  // (Codex #1924 r27). Merge both streams and let POSITION decide, exactly as
  // the CLI does.
  // `--keep-vars=` with nothing after it is an EMPTY value, which wrangler
  // parses as false rather than as a bare flag. It cannot ride in the pattern
  // above: an optional `=` capture there swallows the equals before the value
  // alternation can, breaking every `--keep-vars=true` (caught by the
  // fixtures). Scanned separately, positioned like any other event.
  const emptyRe = new RegExp(`(?<![^\\s(\`'"])${flagRe}=(?=\\s|$)`, 'g');
  for (const m of line.matchAll(emptyRe)) events.push({ at: m.index, on: false });
  const negRe = new RegExp(
    `(?<![^\\s(\`'"])${quoteTolerant(`--no-${flag.replace(/^--/, '')}`)}(?![\\w-])`,
    'g',
  );
  for (const m of line.matchAll(negRe)) events.push({ at: m.index, on: false });
  if (events.length === 0) return false;
  events.sort((a, b) => a.at - b.at);
  return events[events.length - 1].on === true;
}

/**
 * Split a file into LOGICAL shell lines: comments removed, backslash
 * continuations folded, quote state maintained throughout.
 *
 * These were three separate heuristics and they kept contradicting each other,
 * one review round at a time (Codex #1924 r17, r23, r25, r26, r27). A comment
 * ending in `\` swallowed the command below it. A comment opening right after
 * `;` was not recognised, so its safety token blessed the joined deploy. A
 * quoted string spanning lines was mistaken for a comment, failing valid
 * shell. Each fix broke a neighbour because the state is genuinely shared:
 * quoting decides what is a comment, comments decide what continues,
 * continuations decide where a line ends.
 *
 * One pass, one state machine. It is NOT a shell parser and does not try to
 * be — it tracks quotes, comments and continuations, which is exactly what
 * "what does the shell execute here" needs and no more.
 *
 * Each logical line keeps the 1-based number of the physical line it STARTED
 * on, so a violation still points where an operator can open it.
 */
function logicalLines(text) {
  const out = [];
  let quote = null;
  let ansiC = false;
  let inComment = false;
  let buf = '';
  let startLine = 1;
  let line = 1;
  let pendingStart = true;
  let prev = '';

  const flush = () => {
    if (buf.trim() !== '') out.push({ text: buf, line: startLine });
    buf = '';
    pendingStart = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '\n') {
      line += 1;
      if (inComment) {
        // A comment ends at the newline and NEVER continues, whatever it ends
        // with — bash ignores a trailing backslash inside a comment.
        inComment = false;
        if (!quote) flush();
        prev = ' ';
        continue;
      }
      if (quote) {
        buf += ' '; // a newline inside quotes is part of the string
        prev = ' ';
        continue;
      }
      if (buf.endsWith('\\')) {
        buf = `${buf.slice(0, -1)} `; // a real continuation
        prev = ' ';
        continue;
      }
      flush();
      prev = ' ';
      continue;
    }

    if (inComment) continue;

    if (pendingStart && !/\s/.test(ch)) {
      startLine = line;
      pendingStart = false;
    }

    if (quote) {
      // `$'…'` (ANSI-C) processes escapes, plain `'…'` does not — so an
      // escaped apostrophe inside `$'it\\'s'` does NOT close the string
      // (Codex #1924 r28).
      if (ch === '\\' && (quote !== "'" || ansiC)) {
        buf += ch + (text[i + 1] ?? '');
        i += 1;
        prev = 'x';
        continue;
      }
      if (ch === quote) {
        quote = null;
        ansiC = false;
      }
      buf += ch;
      prev = ch;
      continue;
    }

    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        buf += ch; // let the newline branch consume it
        prev = '\\';
        continue;
      }
      buf += ch + (text[i + 1] ?? '');
      i += 1;
      prev = 'x';
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      ansiC = ch === "'" && prev === '$';
      buf += ch;
      prev = ch;
      continue;
    }

    // `#` opens a comment at a token boundary: start of line, after
    // whitespace, or immediately after a shell operator (Codex #1924 r27).
    if (ch === '#' && (prev === '' || /[\s;|&()]/.test(prev))) {
      inComment = true;
      continue;
    }

    buf += ch;
    prev = ch;
  }

  // EOF ends a comment just as a newline does, and the executable text BEFORE
  // it must still be emitted. Skipping the flush discarded a whole command in
  // a file with no trailing newline (Codex #1924 r28).
  flush();
  return out;
}

/**
 * One line can carry several commands. `pnpm run deploy && wrangler deploy`
 * has a safe token and an unsafe invocation; judging the line as a whole
 * blessed both (Codex #1924 r18). Split on the shell separators that start a
 * new command, respecting quotes, and judge each piece on its own.
 */
/**
 * Split a line into command segments, each carrying the separator that PRECEDES
 * it. The separator is not decoration: `||` runs its right-hand side only when
 * the left one FAILED, which decides what directory that segment starts in
 * (Codex #1924 r39).
 */
function splitCommands(line) {
  const parts = [];
  let quote = null;
  let sep = null;
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
    // A descriptor duplication (`2>&1`, `>&2`, `<&0`) contains an `&` that is
    // NOT a command separator. Treating it as one split `wrangler deploy 2>`
    // from `1 --keep-vars` and REJECTED a safe deploy (Codex #1924 r31) —
    // a false positive, and this runs in typecheck.
    // Redirections that CONTAIN `&` are not separators: a descriptor
    // duplication (`2>&1`, `>&2`) and bash's combined form (`&>`, `&>>`).
    // Treating either `&` as a boundary split the command and REJECTED a safe
    // deploy — the fifth consecutive round in which a guard fix produced a
    // false positive (Codex #1924 r31, r32).
    if (ch === '&' && /[<>]$/.test(line.slice(0, i))) continue;
    if (/^[<>]&/.test(line.slice(i - 1, i + 1))) continue;
    if (ch === '&' && /^&>>?/.test(line.slice(i))) {
      i += /^&>>/.test(line.slice(i)) ? 2 : 1;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push({ text: line.slice(start, i), sep });
      sep = two;
      start = i + 2;
      i += 1;
    } else if (ch === ';' || ch === '|' || ch === '&') {
      parts.push({ text: line.slice(start, i), sep });
      sep = ch;
      start = i + 1;
    }
  }
  parts.push({ text: line.slice(start), sep });
  return parts;
}

/**
 * Resolve the shell quoting that can sit between a flag name and its `=`.
 *
 * Bash removes it before wrangler ever sees the argument: `--keep-vars\=false`,
 * `--keep-vars"="false` and `--keep-vars'='false` all arrive as the single
 * argument `--keep-vars=false`. The scoring regex requires a RAW `=`, so each of
 * those spellings read as a bare — i.e. ENABLED — flag and blessed a deploy that
 * deletes vars (Codex #1924 r39).
 *
 * Deliberately narrow: ONLY the separator between a flag token and its `=` is
 * normalised, so no other spacing or quoting on the line shifts and the tuned
 * value rules below keep working unchanged. Escapes elsewhere in an argument
 * are a recorded limit, not a claim. Every rewrite here can only turn a
 * bare-looking flag into one with a value, which is the conservative direction
 * for a default-deny guard.
 */
function normalizeFlagEquals(line) {
  const FLAG = '(--?[A-Za-z0-9][A-Za-z0-9-]*)';
  return line
    .replace(new RegExp(`${FLAG}\\\\=`, 'g'), '$1=')
    .replace(new RegExp(`${FLAG}(["'])=\\2`, 'g'), '$1=')
    // MOVE the quote across the `=`, never drop it. `--keep-vars"=true garbage"`
    // is ONE bash argument, `--keep-vars=true garbage`, which wrangler parses as
    // false; deleting the opening quote left the matcher stopping at the space
    // and reading the value as exactly `true` (Codex #1924 r40). Rewriting it to
    // `--keep-vars="true garbage"` keeps the word boundary the shell gave it, and
    // the quoted-value branch below already strips the quotes.
    .replace(new RegExp(`${FLAG}(["'])=`, 'g'), '$1=$2');
}

/**
 * Strip what precedes the command a segment actually executes: grouping
 * punctuation and leading `VAR=value` environment assignments, whose values
 * bash never runs.
 */
function executedCommand(cmd) {
  // An assignment's value is ONE SHELL WORD, and a word can mix adjacent quoted
  // and unquoted chunks or carry escaped whitespace: bash reads
  // `NOTE=foo" --keep-vars"` as a single assignment and passes wrangler only
  // `deploy`. Matching wholly-quoted or whitespace-free values left the quoted
  // tail behind as apparent arguments (#1995 r6) — the same chunked-word lesson
  // as #1924 r23/r24 and #1995 r4a, in its fourth place.
  const CHUNKS = '(?:"[^"]*"|\'[^\']*\'|(?:\\\\[\\s\\S])|[^\\s"\'\\\\]+)*';
  return cmd
    .replace(/^[\s(){]*/, '')
    .replace(new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=${CHUNKS}\\s+)*`), '');
}

/**
 * Drop a trailing shell COMMENT, quote-aware (#1995 r10).
 *
 * Shell files have comments removed upstream by `logicalLines`; prose does not,
 * so a runbook line reading ``wrangler deploy # TODO: add --keep-vars`` scored
 * the flag inside the comment and was blessed — while copying that command into
 * a terminal performs the bare, destructive deploy the guard exists to stop.
 *
 * A `#` only opens a comment at a TOKEN BOUNDARY, so `https://host/#frag` and
 * `--name a#b` are untouched.
 *
 * BACKTICKS ARE NOT QUOTES HERE, unlike everywhere else in this file. In prose
 * the command sits inside a Markdown code span, so treating its delimiters as
 * shell quoting put the whole command "inside a string" and no comment was ever
 * found — the first version of this did exactly that and the fixture caught it.
 * Inside a real backtick substitution a token-boundary `#` still starts a
 * comment in the subshell, so truncating there is right as well; and where it
 * is not, the error is an extra violation rather than a missed one.
 */
function stripShellComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function commandIsSafe(cmd) {
  // `run deploy` gets the same option-value strip the flags do: it was a raw
  // substring test, so `--message="run deploy"` blessed a bare deploy that
  // never invokes the package script (Codex #1924 r22). `flagEnabled` already
  // strips internally; this call is for the `run deploy` test.
  const bare = stripOtherOptionValues(stripRedirections(cmd));
  // Wrangler stops parsing options at `--`, so `wrangler deploy -- --dry-run`
  // is a LIVE bare deploy and the trailing flag is inert (#1995 r10). A
  // package manager does the opposite — `pnpm run deploy -- --no-keep-vars`
  // FORWARDS what follows to the script — so the terminator may only truncate
  // when a direct wrangler command is present, which is exactly what
  // `hasWranglerCmd` says. Comments come off first, for the prose case.
  const forFlags = (() => {
    const noComment = stripShellComment(cmd);
    // The terminator must come AFTER the wrangler command to be wrangler's.
    // Cutting at the first `--` anywhere made `pnpm exec -- wrangler deploy
    // --keep-vars` — a safe deploy, where `--` ends PNPM's options — report a
    // violation. That is a CI-blocking false red, and it is what a
    // `hasWranglerCmd`-only guard still allowed: the mutation that removed the
    // guard passed every test, which is how the gap surfaced.
    const m = noComment.match(new RegExp(DEPLOY_RE));
    if (!m) return noComment;
    const from = m.index + m[0].length;
    const rel = noComment.slice(from).search(/(?:^|\s)--(?=\s|$)/);
    return rel === -1 ? noComment : noComment.slice(0, from + rel);
  })();
  if (
    flagEnabled(forFlags, '--keep-vars') ||
    flagEnabled(forFlags, '--dry-run')
  ) {
    return true;
  }

  // ANCHORED at the segment's executed command. As a free substring test,
  // `NOTE=" pnpm run deploy" wrangler deploy` — a bare deploy carrying an
  // unrelated environment assignment — matched inside the quoted value and was
  // blessed (Codex #1924 r40). The package script is a safe deploy only when it
  // is the thing being RUN.
  // ANCHORED only when a wrangler deploy is actually present. That anchor
  // exists because `NOTE=" pnpm run deploy" wrangler deploy` blessed itself
  // through a quoted value (#1924 r40) — a hazard that needs a wrangler command
  // to exist. In PROSE the package-script form is the whole content of the line
  // ("Use `pnpm --filter … run deploy`"), where an anchored match fails and
  // would report the recommended command as a violation.
  const hasWrangler = new RegExp(DEPLOY_RE).test(bare);
  // Quote-collapse for the package-script test: `pnpm run de"ploy"` invokes the
  // `deploy` script, and matching raw characters missed it (#1995 r8). Only the
  // script-name comparison uses this view; flag parsing keeps the raw text,
  // where quoting is meaningful.
  const source = dequote(hasWrangler ? executedCommand(bare) : bare);
  const runDeploy = source.match(
    new RegExp(
      `${hasWrangler ? '^' : ''}(pnpm|npm|yarn)(?:\\s+[^\\s]+)*?` +
        `\\s+(?:${RUN_ALIASES})(?:\\s+-{1,2}[A-Za-z0-9-]+(?:=[^\\s]*)?)*\\s+deploy\\b([\\s\\S]*)$`,
    ),
  );
  if (!runDeploy) return false;

  // npm forwards ONLY what follows `--` (`npm run <command> [-- <args>]`);
  // pnpm and yarn forward directly. Treating npm's own options as forwarded
  // arguments reported `npm run deploy --no-keep-vars` as destructive when npm
  // actually warns about an unknown option and runs the script with nothing
  // appended — a false CI failure on a correct command (#1995 r5).
  const appended =
    runDeploy[1] === 'npm'
      ? (runDeploy[2].match(/(?:^|\s)--(?:\s|$)([\s\S]*)$/)?.[1] ?? '')
      : runDeploy[2];

  // ARGUMENTS APPENDED TO THE PACKAGE SCRIPT STILL COUNT. `pnpm --filter
  // @vaipakam/agent run deploy --no-keep-vars` expands to
  // `wrangler deploy --keep-vars --no-keep-vars`, which wrangler parses as
  // keepVars:false — a destructive deploy that the bare `run deploy` test
  // blessed on the strength of the script name alone (#1995 r4).
  //
  // The script supplies `--keep-vars`, so anything appended arrives AFTER it
  // and the CLI takes the last occurrence. Reconstructing that order and
  // re-using `flagEnabled` gets every negation spelling for free —
  // `--no-keep-vars`, `--keep-vars=false`, `--keep-vars=` — rather than
  // enumerating them here and missing one.
  // SAFE UNLESS EXPLICITLY NEGATED. The earlier form asked
  // `flagEnabled("--keep-vars " + appended)`, which reads whatever follows as
  // the flag's VALUE — fine for real argv, wrong for prose, where
  // "`pnpm … run deploy`, whose …" made `,` the value and scored it false. That
  // was latent behind the backtick being excluded from the value class until
  // the r8 dequoting removed the accident, and it produced four false reds on
  // the real tree. Ask the narrower question instead: does the appended text
  // actually turn keep-vars off? Text that never mentions it cannot.
  if (!/--(?:no-)?keep-vars/.test(appended)) return true;
  return flagEnabled(appended, '--keep-vars');
}

/**
 * Safe only if EVERY `wrangler deploy` on the line is safe. A line with no
 * deploy at all is safe by vacuity — the caller has already established that
 * the line mentions one, so this cannot mask anything.
 */
function isSafe(line) {
  const deploys = splitCommands(line)
    .map((c) => c.text)
    .filter(
      (c) =>
        new RegExp(ANY_DEPLOY_RE).test(c) || new RegExp(RUN_DEPLOY_RE).test(dequote(c)),
    );
  if (deploys.length === 0) return true;
  return deploys.every(commandIsSafe);
}

/**
 * The Workers whose deploys must preserve dashboard vars, and why each is here.
 *
 * SCOPE IS EVIDENCE, NOT CAUTION (#1933). A Worker belongs here when its source
 * reads an env name that is neither a secret nor a binding nor declared in its
 * own `wrangler.jsonc` — because those are exactly the values a bare deploy
 * deletes. Secrets and bindings survive a deploy, so a Worker that reads only
 * those is genuinely safe bare and is deliberately LEFT OUT: every package in
 * scope makes prose and runbooks that quote the unsafe command fail until
 * someone allowlists them, which is a real cost to pay for a property that does
 * not hold.
 *
 * VERIFIED CLEAN, recorded so the next reader does not re-derive it:
 *   - `apps/indexer` (#1924 r43) — its env reads are secrets (`RPC_*`,
 *     `OPENSEA_API_KEY`), bindings (`DB`, `CHAIN_INGEST_DO`, the rate-limit
 *     namespaces, `CF_VERSION_METADATA`) or declared vars.
 *   - `ops/mesh-watcher` (#1933) — every non-secret, non-binding name it reads
 *     is declared: `ALERT_REPEAT_SECONDS`, `BUCKET_COVERAGE_TOLERANCE_WEI`,
 *     `CANONICAL_CHAIN_ID`, `COMPOSITION_SLACK_TOLERANCE_WEI`,
 *     `REPORT_LAG_WINDOW_TICKS`, `STALE_LOCAL_SECONDS`, `STUCK_WINDOW_TICKS`,
 *     `TG_OPS_CHAT_ID`. Its bare `deploy` script is safe as written.
 *   - `ops/offchain-data-warm` (#1933) — it LOOKS unsafe: `wrangler.jsonc`
 *     carries `"vars": {}` while the source reads FIVE settings absent from it.
 *     Every one is accounted for, in two groups (corrected in #1995 r4 — an
 *     earlier version of this note said "three", conflating the groups, and
 *     this record is what a future maintainer is told to re-verify from).
 *
 *     SECRET-MANAGED, so a deploy never touches them: `B2_ENDPOINT`,
 *     `B2_BUCKET`, `TG_OPS_CHAT_ID`. That Worker's own config says so —
 *     "All three of B2_ENDPOINT, B2_BUCKET, and TG_OPS_CHAT_ID are
 *     operator-configured via `wrangler secret put` rather than baked into this
 *     JSONC file" — with reasons (region-specific endpoint, globally unique
 *     bucket names, and chat-id obfuscation).
 *
 *     OPTIONAL COMMITTED VARS, currently unset on purpose:
 *     `ARCHIVE_FIRST_MONTHLY` / `ARCHIVE_FIRST_YEARLY`. The documented way to
 *     set them (`npm run archive:baselines`) prints them for pasting into the
 *     COMMITTED wrangler config — its own output says they "are plain
 *     configuration, NOT secrets … so they belong in the committed wrangler
 *     config where a reviewer can see them" — and a value that lives in the
 *     config is re-applied by every deploy, bare or not.
 *
 *     So its README's claim that "every operator-specific value lives in the
 *     secret store, so `wrangler deploy` takes no flags" is accurate, and adding
 *     it to scope would have contradicted a correct document.
 * Re-verify rather than inherit any of these if the config changes.
 *
 * The static front-end packages (`apps/{www,app,alpha02,…}`) upload assets and
 * are out of scope.
 */
const SCOPED = [
  {
    dir: 'apps/keeper',
    dirVar: 'KEEPER_DIR',
    filter: '@vaipakam/keeper',
    // The DEPLOYED Worker name, so `--name vaipakam-keeper` is recognised as
    // targeting this package from anywhere (#1995 r1).
    workerName: 'vaipakam-keeper',
    // Declares only TG_BOT_USERNAME (which nothing reads); env.ts reads eight
    // dashboard-only values that govern liquidation.
    vars: 'HF_SCALE / LIQ_* / SPLIT_* / PARTIAL_LIQ_*',
  },
  {
    dir: 'apps/agent',
    dirVar: 'AGENT_DIR',
    filter: '@vaipakam/agent',
    workerName: 'vaipakam-agent',
    // env.ts reads both; wrangler.jsonc declares neither (OPENSEA_OFFERS_MAX_PAGES
    // appears there only inside a comment). A bare deploy silently switches
    // recipient-token validation off and resets OpenSea pagination.
    vars: 'RECIPIENT_VALIDATING_TOKENS / OPENSEA_OFFERS_MAX_PAGES',
  },
];

/**
 * In scope by explicit reference, or by living in a scoped package's tree.
 *
 * The brace form matters and is not decoration: the staging plan writes
 * `apps/{keeper,indexer,agent}`, which contains neither the literal
 * `apps/keeper` nor a pnpm filter. An earlier cut of this guard missed exactly
 * that line — the one violation the review round was about — because it only
 * looked for the expanded spelling. The brace test now checks the package's
 * BASENAME, so `apps/{keeper,agent}` matches on either.
 */
/**
 * The scope a package-manager `--filter` selects, including pattern form.
 *
 * pnpm's filter accepts globs, so `--filter '@vaipakam/*gent'` selects the agent
 * without either its literal name or its path appearing on the line (verified
 * against pnpm 10.4.1) — and the textual match required one of those spellings
 * (#1995 r5). Only `*` is translated; a filter is matched against the package
 * NAME, which is the spelling a wrapper uses.
 */
/**
 * Workspace dependency names a scoped package declares, read once per package.
 *
 * pnpm's `...<pattern>` selects the pattern's DEPENDENTS and `<pattern>...` its
 * DEPENDENCIES (#1995 r9). Stripping the dots and matching the remainder as a
 * plain literal reduced `--filter ...@vaipakam/lib` to a name no scoped package
 * has, so it selected nothing — while pnpm selects BOTH protected Workers,
 * because each declares `@vaipakam/lib`.
 *
 * Resolved from the manifests rather than guessed. The conservative
 * alternative — attributing every `...` selector to every scoped package —
 * would report the keeper for `...@vaipakam/agent`, which is a false red unless
 * the keeper really does depend on the agent.
 */
const workspaceDepsCache = new Map();
function scopedWorkspaceDeps(sc) {
  if (!workspaceDepsCache.has(sc.dir)) {
    let names = [];
    try {
      const m = JSON.parse(
        readFileSync(`${REPO_ROOT}/${sc.dir}/package.json`, 'utf8'),
      );
      names = [
        ...Object.keys(m.dependencies ?? {}),
        ...Object.keys(m.devDependencies ?? {}),
        ...Object.keys(m.peerDependencies ?? {}),
      ];
    } catch {
      names = [];
    }
    workspaceDepsCache.set(sc.dir, names);
  }
  return workspaceDepsCache.get(sc.dir);
}

function filterScopes(line) {
  // EVERY selector, not the first: pnpm runs on packages satisfying "at least
  // one of the selectors", so a protected glob sitting second was ignored
  // (#1995 r6). `--filter-prod` is the same selector with a different name.
  //
  // And every selector may select MORE THAN ONE package: `--filter
  // '@vaipakam/*'` covers both scoped Workers, and returning the first left the
  // other's remedy out of the same report (#1995 r7).
  // POSITIVES are unioned and NEGATIVES are then subtracted, which is what
  // pnpm does (#1995 r9). Adding each negation's complement independently made
  // `--filter @vaipakam/agent --filter '!@vaipakam/agent'` — which pnpm reports
  // as selecting NO projects — come out as a keeper violation.
  //
  // Returns `null` when the line carries no selector at all, and an ARRAY when
  // it does, so callers can tell "nothing said" from "said, and it selects
  // nothing". Those had the same spelling before, and only the first may fall
  // through to matching package names in the surrounding text.
  const included = new Set();
  const excluded = new Set();
  let sawSelector = false;
  let sawPositive = false;
  // `-r` / `--recursive` runs the script in EVERY workspace package, naming
  // none of them, so no textual, filter or cwd signal exists at all (#1995 r8).
  //
  // pnpm spells the same thing as a COMMAND as well as an option: `pnpm help
  // recursive` documents `recursive`, `multi` and `m` as running an action
  // across every package (#1995 r9). r8 added the option spellings and stopped
  // there, so `pnpm recursive --if-present run deploy --no-keep-vars` — every
  // protected Worker, destructively — passed the guard.
  if (
    /(?:^|\s)(?:-r|--recursive)(?:\s|=|$)/.test(line) ||
    /(?:^|\s)pnpm\s+(?:recursive|multi|m)(?:\s|$)/.test(line) ||
    // npm's spelling of the same fan-out: `npm run --help` documents
    // `[--workspaces]`, with `-ws` as its shorthand (#1995 r10).
    /(?:^|\s)(?:--workspaces|-ws)(?:\s|=|$)/.test(line)
  ) {
    sawSelector = true;
    sawPositive = true;
    for (const sc of SCOPED) included.add(sc);
  }
  // `-F` is pnpm's documented shorthand for `--filter` (#1995 r10). The
  // lookbehind keeps it from matching the tail of another token.
  const all = line.matchAll(
    new RegExp(`(?<![\\w-])(?:--filter(?:-prod)?|-F)(?:=|\\s+)(${WORD})`, 'g'),
  );
  for (const m of all) {
    sawSelector = true;
    let pat = dequote(m[1]);
    // Which DIRECTION the dependency selector runs, before the dots are lost.
    const wantsDependents = /^\.\.\./.test(pat);
    const wantsDependencies = /\.\.\.$/.test(pat);
    pat = pat.replace(/^\.\.\.|\.\.\.$/g, '');
    // A LEADING `!` excludes: pnpm selects the packages NOT matching, so
    // `--filter '!@vaipakam/indexer'` reaches both protected Workers (#1995 r8).
    const negated = pat.startsWith('!');
    if (negated) pat = pat.slice(1);
    // A filter may name a DIRECTORY rather than a package: pnpm documents
    // `--filter ./<dir>` and `--filter {<dir>}`, and matching only against
    // package names missed `--filter './apps/*gent'` entirely (#1995 r7).
    const isDir = /^[.{]/.test(pat);
    pat = pat.replace(/^\{|\}$/g, '').replace(/^\.\//, '').replace(/\/+$/, '');
    // `[<since>]` selects whatever changed since a ref (#1995 r10). Which
    // packages that is cannot be known from the text, and it demonstrably
    // reaches a protected one, so it is attributed to every scoped package the
    // way `-r` is — the conservative direction for a selector we cannot
    // resolve. Checked before the glob test, which would discard it.
    if (/^\[.*\]$/.test(pat)) {
      sawPositive = true;
      for (const sc of SCOPED) included.add(sc);
      continue;
    }
    const re = new RegExp(
      `^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    // A positive LITERAL is a real selection and is resolved here now. It used
    // to be skipped as "handled by scopeOf", which was true while selections
    // were only ever added — but a negation has to subtract from something.
    const direct = SCOPED.filter((sc) => re.test(isDir ? sc.dir : sc.filter));
    // `...X` reaches whatever DEPENDS on X; `X...` reaches what X depends on.
    const viaGraph = wantsDependents
      ? SCOPED.filter((sc) => scopedWorkspaceDeps(sc).some((d) => re.test(d)))
      : wantsDependencies
        ? SCOPED.filter((sc) =>
            direct.some((d) => scopedWorkspaceDeps(d).includes(sc.filter)),
          )
        : [];
    const matched = [...new Set([...direct, ...viaGraph])];
    if (negated) {
      for (const sc of matched) excluded.add(sc);
    } else {
      sawPositive = true;
      for (const sc of matched) included.add(sc);
    }
  }
  if (!sawSelector) return null;
  // With only negations, the base is every package — that is what
  // `--filter '!@vaipakam/indexer'` means, and it still reaches both.
  const base = sawPositive ? included : new Set(SCOPED);
  for (const sc of excluded) base.delete(sc);
  return [...base];
}

function scopeOf(line, filePath) {
  const byFilter = filterScopes(line);
  // An explicit selection that resolves to NOTHING stops here: falling through
  // to the text would report a package the command demonstrably does not
  // deploy (#1995 r9).
  if (byFilter) return byFilter.length > 0 ? byFilter[0] : null;
  for (const s of SCOPED) {
    const base = s.dir.slice(s.dir.lastIndexOf('/') + 1);
    const parent = s.dir.slice(0, s.dir.lastIndexOf('/'));
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A trailing boundary is required, or a longer SIBLING name is claimed as
    // this package: `apps/agent-backup` and `@vaipakam/agent-tools` both
    // contained the agent's spellings as substrings and were reported with the
    // agent's remedy (#1995 r3). This guard blocks an unfiltered CI job, so a
    // false red on an unrelated Worker is expensive.
    //
    // A DOT breaks the boundary too — `apps/agent.backup` and
    // `@vaipakam/agent.tools` are distinct names (#1995 r4) — but only when a
    // name CONTINUES after it. A bare `.` is how prose ends a sentence, and
    // disallowing it outright would stop matching "Deploy apps/agent." which is
    // the commonest spelling in a runbook.
    const BOUND = '(?![\\w-])(?!\\.[A-Za-z0-9_-])';
    if (
      new RegExp(`${esc(s.filter)}${BOUND}`).test(line) ||
      new RegExp(`\\b${esc(s.dirVar)}\\b`).test(line) ||
      new RegExp(`${esc(s.dir)}${BOUND}`).test(line) ||
      new RegExp(`${esc(parent)}/\\{[^}]*\\b${esc(base)}\\b[^}]*\\}`).test(line) ||
      filePath.startsWith(`${s.dir}/`)
    ) {
      return s;
    }
  }
  return null;
}

/**
 * Shell continuation / comment rules apply to shell scripts, not to prose.
 * Detected by extension or shebang — the same two signals an editor uses.
 */
function isShellFile(rel, text) {
  return SHELL_EXTENSIONS.some((e) => rel.endsWith(e)) || /^#!.*\b(ba|z|k)?sh\b/.test(text);
}

/**
 * An extensionless file is a shebang candidate — conventional for executable
 * wrappers (`contracts/script/deploy-keeper`). A dotfile is not.
 */
function looksExecutable(entry) {
  return !entry.includes('.') && entry.length > 0;
}

/**
 * Resolve a `cd`/`pushd` target against the directory the shell is already in.
 *
 * Reducing each target to a boolean on its own lost every relative move BETWEEN
 * siblings: `cd apps/agent; cd ../keeper` ends in apps/keeper, but `../keeper`
 * matched nothing and recorded non-keeper scope, so the guard exited 0 on a
 * destructive deploy (Codex #1924 r39). The cwd is tracked as a real path and
 * normalised instead.
 *
 * The base is unknown — a wrapper is invoked from wherever the operator stands
 * — so this is a path RELATIVE to that base, and `scopeOfCwd` matches on the
 * suffix. `..` past the base is kept as `..` rather than silently collapsing,
 * which would make unrelated directories look like the keeper's.
 */
function resolveDir(cwd, target, vars = null) {
  // Substitute variables whose value was assigned STATICALLY earlier in the
  // same shell block. `TARGET=apps/agent` then `cd "$TARGET"` is deterministic,
  // and treating every `$` as unknown cleared scope on an ordinary wrapper —
  // while the same commands on ONE line were rejected, which is an incoherent
  // pair (#1995 r8). Only literal assignments are carried; anything computed
  // stays unresolved.
  if (vars && /\$/.test(target)) {
    target = target.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (m, name) => vars.get(name) ?? m,
    );
  }
  // A `$KEEPER_DIR` / `$AGENT_DIR` reference is that package wherever it
  // happens to be defined.
  for (const s of SCOPED) {
    if (new RegExp(`\\b${s.dirVar}\\b`).test(target)) return s.dir;
  }
  // An UNRESOLVED variable is an unknown destination, and #1924 r40 settled
  // that it must CLEAR scope rather than be treated as a literal path segment.
  // Appending it (`apps/keeper` + `$INDEXER_DIR`) was harmless while the cwd
  // test was end-anchored; once descendants count, the nested spelling would
  // hold the outer package's scope over a deploy that runs somewhere unknown.
  //
  // But a variable PREFIX does not erase a static SUFFIX. `cd "$ROOT/apps/agent"`
  // is an ordinary root-relative wrapper, and the segments after the variable
  // identify the package regardless of where the root points (#1995 r5). Root
  // the path at an unknown marker and keep the rest — `scopeOfCwd` matches on a
  // `/` boundary, so the suffix still resolves while a bare `$VAR` does not.
  if (/\$/.test(target)) {
    const kept = target
      .split('/')
      .filter((x, i) => i > 0 && x && x !== '.' && !/\$/.test(x))
      .join('/');
    return kept ? `\u0000unknown/${kept}` : '\u0000unknown';
  }
  // A target naming a repository package root is REPO-ROOT-relative, not
  // cwd-relative: wrappers write `cd apps/indexer` from the repo root, never
  // from inside another package. Modelling it as nested is what produced
  // `apps/keeper/apps/indexer` and forced a tail exclusion that then dropped
  // real subdirectories like `apps/agent/packages/generated` (#1995 r5).
  // Normalised component-wise, not just trimmed: the early return skipped the
  // walk below, so `cd apps//agent` was stored literally and `scopeOfCwd` did
  // not recognise it, while bash resolves it to apps/agent (#1995 r15).
  if (/^(?:apps|ops|packages)\//.test(target)) {
    const norm = [];
    for (const part of target.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') norm.push(part);
      else if (norm.length > 0 && norm[norm.length - 1] !== '..') norm.pop();
      else norm.push('..');
    }
    return norm.join('/');
  }
  const parts = target.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') {
      parts.push(part);
      continue;
    }
    if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push('..');
  }
  return parts.join('/');
}

/** Net change in subshell nesting across a fragment, ignoring quoted text. */
function netParens(text) {
  let n = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
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
    if (ch === '(') n += 1;
    else if (ch === ')') n -= 1;
  }
  return n;
}

/**
 * The scoped package the shell is standing in, if any — INCLUDING from a
 * subdirectory of it.
 *
 * The end-anchored form this replaces missed `cd apps/agent/src && wrangler
 * deploy` (#1995 r1). Wrangler walks UP for its configuration: verified against
 * the repo's wrangler 4.90.0, a dry run from `apps/agent/src` reports
 * `Processing ../wrangler.jsonc configuration` — so standing anywhere beneath a
 * scoped package deploys that package, and the guard has to say so. The bug
 * predates this PR (the keeper-only predicate was anchored the same way); it is
 * fixed for both rather than carried forward.
 */
function scopeOfCwd(cwd) {
  return (
    SCOPED.find((s) => {
      const m = cwd.match(
        new RegExp(`(^|/)${s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/(.*))?$`),
      );
      // Any descendant counts. The tail exclusion this replaces existed only to
      // undo the scanner's own modelling of a sibling move as a nested path;
      // `resolveDir` now treats a package-root-relative target as repo-relative,
      // so `apps/keeper` + `apps/indexer` lands on `apps/indexer` and the
      // nesting never arises. Excluding the tail also dropped REAL subdirectories
      // — `apps/agent/packages/generated` is inside the agent, and wrangler walks
      // up from it to the agent's own config (#1995 r5).
      return Boolean(m);
    }) ?? null
  );
}

/**
 * The scope a segment names through wrangler's own TARGET SELECTORS, rather
 * than through the path the shell happens to be standing in (#1995 r1).
 *
 * `wrangler deploy --config ../agent/wrangler.jsonc` from anywhere deploys the
 * agent; so does `--cwd ../agent`, and so does `--name vaipakam-agent`. All
 * three were invisible to a purely path-based predicate. Values are resolved
 * against every REACHABLE cwd, the same states the `cd` walk maintains, so a
 * relative selector lands where the shell would put it.
 */
function selectorScope(seg, states, hasCwdState = true) {
  // A value is ONE SHELL WORD, and a word can mix adjacent quoted and unquoted
  // chunks: `--name vaipakam"-"agent` is the single argument `vaipakam-agent`.
  // Capturing only the first chunk made the value `vaipakam`, which matched no
  // package — and that non-match then read as authoritative no-scope, so the
  // deploy passed (#1995 r4). The same shape as #1924 r23/r24, one function
  // over. Quotes are removed after capture.
  //
  // The backtick is excluded from the unquoted chunk, matching `flagEnabled`'s
  // own value pattern: selectors are read from PROSE too, where a command lives
  // in a code span, and without this `--cwd ../agent`` captured the closing
  // backtick and named `agent``.
  // Backslash excluded from the unquoted class, as in `WORD` above — same
  // overlapping-alternative ReDoS (#1995 r15 follow-on).
  const VALUE = `((?:"[^"]*"|'[^']*'|(?:\\\\[\\s\\S])|[^\\s"'\`;&|)\\\\]+)+)`;
  // Neutralise OTHER options' values first, exactly as `commandIsSafe` does,
  // keeping our own flags. Scanning the raw segment let
  // `--message="note --name vaipakam-indexer"` parse as a real selector, and
  // the fake name then suppressed the cwd scope of a bare agent deploy
  // (#1995 r3).
  // `executedCommand` FIRST: a leading `VAR=value` assignment is environment,
  // not argv, so `NOTE="--name vaipakam-indexer" wrangler deploy` passes no
  // such option — but the text was parsed as a real selector and the fake name
  // then suppressed the cwd scope of a bare agent deploy (#1995 r4).
  // `commandIsSafe` already strips these for the package-script test.
  const clean = stripOtherOptionValues(
    executedCommand(stripRedirections(seg)),
    // Every option whose VALUE this function goes on to read must be kept, or
    // the strip blanks it first and `valueOf` finds only a placeholder — which
    // is why npm's `--prefix` read as absent even after it was added to the
    // `valueOf` alternation (#1995 r9). The list and the alternation are two
    // halves of one decision and drift silently, because a missing entry looks
    // exactly like an option that was not present.
    //
    // `C` is here defensively rather than as a fix: `pnpm -C ../agent run
    // deploy --no-keep-vars` was ALREADY reported before this change, so it
    // reaches scope by another path. Measured, not assumed — an earlier draft
    // of this comment claimed `-C` was broken.
    ['name', 'config', 'cwd', 'dir', 'C', 'prefix'],
  );
  // `--config` before `-c` so the long spelling wins the alternation, and a
  // lookbehind so `-c` cannot match inside `--config` or at the tail of another
  // token. `-c` is wrangler's DOCUMENTED alias (4.90.0: "-c, --config  Path to
  // Wrangler configuration file"); `--cwd` and `--name` have none.
  const valueOf = (spellings) => {
    const m = clean.match(new RegExp(`(?<![\\w-])(?:${spellings})(?:=|\\s+)${VALUE}`));
    if (!m) return null;
    // Quotes are removed and BACKSLASH ESCAPES decoded: the shell hands wrangler
    // `vaipakam-agent` for `vaipakam\\-agent`, and comparing the escaped form
    // made it an authoritative non-match (#1995 r5).
    return m[1].replace(/\\([\s\S])/g, '$1').replace(/["'`]/g, '');
  };
  /** A value we cannot resolve carries no information — treat it as absent. */
  const known = (v) => (v !== null && !/\$/.test(v) ? v : null);

  // EACH SELECTOR IS JUDGED ON ITS OWN. A single early return on "any value is
  // dynamic" discarded a perfectly resolved `--name` whenever some other
  // selector happened to be a variable, so
  // `--name vaipakam-agent --config "$CFG"` passed the guard (#1995 r3).
  const name = known(valueOf('--name'));
  if (name !== null) {
    // wrangler's `getScriptName` is `args.name ?? config.name`, so an explicit
    // name is authoritative no matter what the config path turns out to be.
    return { scope: SCOPED.find((s) => s.workerName === name) ?? null };
  }

  const cfgRaw = valueOf('--config|-c');
  // `--cwd` is wrangler's; `--dir` / `-C` is pnpm's own, documented as "change
  // to that directory", and it decides which package's script runs (#1995 r8).
  // `--prefix` is npm's spelling of the same idea — its config documentation
  // says a command-line prefix "forces non-global commands to run in the
  // specified folder" — and it was missed when pnpm's was added (#1995 r9).
  // Same resolution for all three, so they are read here rather than
  // duplicated elsewhere.
  //
  // They COMPOSE, and are read separately for that reason (#1995 r9). A `??`
  // here took whichever appeared first and ignored the other, so
  // `pnpm --dir ../agent run deploy -- --cwd .` resolved wrangler's `--cwd`
  // straight from the shell's directory instead of from the one pnpm had
  // already moved to. The package manager moves first and wrangler starts
  // where it was left, so the two chain rather than compete.
  const pkgDirRaw = valueOf('--dir|-C|--prefix');
  const wrCwdRaw = valueOf('--cwd');
  const cfg = known(cfgRaw);
  const pkgDir = known(pkgDirRaw);
  const wrCwd = known(wrCwdRaw);
  // A path selector is present but unresolvable: we know a target was named and
  // cannot say what it is, so defer rather than assert "targets nothing".
  if (
    (cfgRaw !== null && cfg === null) ||
    (pkgDirRaw !== null && pkgDir === null) ||
    (wrCwdRaw !== null && wrCwd === null)
  ) {
    return null;
  }
  if (cfg === null && pkgDir === null && wrCwd === null) return null;

  // ORDER MATTERS: `--cwd` runs wrangler "as if started in the specified
  // directory", so a relative `--config` resolves FROM it. Resolving the two
  // independently let `--cwd apps/indexer --config ../agent/wrangler.jsonc` —
  // verified against 4.90.0 to bundle the AGENT — pass the guard (#1995 r2).
  const bases = states.map((st) => {
    // Package manager first, wrangler second — the order the shell runs them.
    let base = st.cwd;
    if (pkgDir !== null) base = resolveDir(base, pkgDir);
    if (wrCwd !== null) base = resolveDir(base, wrCwd);
    return base;
  });
  // `--config` names a FILE; its directory is the package.
  const target =
    cfg !== null ? cfg.slice(0, cfg.lastIndexOf('/') + 1) || '.' : null;

  for (const b of bases) {
    const hit = scopeOfCwd(target === null ? b : resolveDir(b, target));
    if (hit) return { scope: hit };
  }

  // NOT AUTHORITATIVE WITHOUT A CWD. On the prose path there is no shell state,
  // so a RELATIVE selector was being resolved against an invented empty cwd and
  // its failure then read as "targets nothing" — which suppressed the correct
  // textual scope and let "From apps/agent, run `wrangler deploy --config
  // wrangler.jsonc`" pass (#1995 r3). A relative value there is unresolved, not
  // resolved-to-nothing, so defer to the text.
  if (!hasCwdState) {
    // Both directory selectors are candidates here, most specific first
    // (#1995 r9) — `cwdFlag` was one variable before they were split apart.
    const raw = (target ?? wrCwd ?? pkgDir ?? '').replace(/\/+$/, '');
    // Before deferring, read what the value NAMES. `--cwd ../agent` cannot be
    // resolved without knowing where the reader stands, but its trailing
    // segments identify the package on their own, and no text elsewhere on the
    // line has to say so. Compared as whole PATH SEGMENTS, so `../agent-backup`
    // does not match `apps/agent`.
    const tail = raw
      .split('/')
      .filter((x) => x && x !== '.' && x !== '..')
      .join('/');
    if (tail) {
      const named = SCOPED.find((s) => s.dir === tail || s.dir.endsWith(`/${tail}`));
      if (named) return { scope: named };
    }
    if (!raw.startsWith('/')) return null;
  }
  return { scope: null };
}

/** Apply one directory directive to one reachable state. */
function applyDir(state, dir, vars = null) {
  if (dir.kind === 'popd') {
    return state.stack.length > 0
      ? {
          cwd: state.stack[state.stack.length - 1],
          stack: state.stack.slice(0, -1),
          prev: state.cwd,
        }
      : { cwd: '', stack: [], prev: state.cwd };
  }
  // `cd -` is `$OLDPWD`, per bash's `help cd` — not a child directory called
  // `-` (#1995 r14). `cd apps/agent; cd ../indexer; cd -` is back in the agent,
  // while resolving it as a path produced `apps/indexer/-`, which matches no
  // package, so the bare deploy that followed was not attributed at all.
  if (dir.kind === 'cd' && dir.target === '-') {
    return { cwd: state.prev ?? '', stack: state.stack, prev: state.cwd };
  }
  return {
    cwd: resolveDir(state.cwd, dir.target, vars),
    stack: dir.kind === 'pushd' ? [...state.stack, state.cwd] : state.stack,
    prev: state.cwd,
  };
}

/** The directory directive a segment performs, if any. */
function dirDirective(seg) {
  // `cd` and `pushd` take OPTIONS before the destination — bash's `help cd`
  // gives `cd [-L|[-P [-e]] [-@]] [dir]` — and recording the option as the
  // target moved the modelled cwd to `-P` instead of the directory, so
  // `cd -P apps/agent; wrangler deploy` resolved nowhere (#1995 r6). The
  // standard `--` terminator is consumed too, or it becomes the destination
  // (#1995 r7).
  const OPTS = String.raw`(?:-[LPe@]+\s+)*(?:--\s+)?`;
  // The destination is ONE SHELL WORD. Stopping at the first closing quote lost
  // the static suffix of `cd "$ROOT"/apps/agent` — bash concatenates the chunks
  // and enters apps/agent (#1995 r8).
  // A BRACE GROUP runs in the CURRENT shell, so its `cd` persists — unlike a
  // `( … )` subshell (#1995 r12). `{ cd apps/agent; }` on one line left the
  // process in apps/agent, but this matcher is `^cd`-anchored and the segment
  // begins `{ cd …`, so the move was never recorded and the next line's bare
  // deploy was judged from the repo root.
  //
  // `\{\s+` and not `\{\s*`: bash requires the space, and `{cd x; }` is a
  // command named `{cd`, not a group. Braces are also deliberately absent from
  // `netParens` — they open no subshell, so nothing here needs restoring on
  // close, which is exactly the difference from the paren case.
  // `builtin cd` and `command cd` both run `cd` in the CURRENT shell —
  // bash's `help builtin` and `help command` say so — and an anchored `^cd`
  // saw neither (#1995 r14). Ordered after the brace so `{ builtin cd x; }`
  // resolves too.
  const LEAD = String.raw`(?:\{\s+)?(?:(?:builtin|command)\s+)?`;
  const pushed = seg.match(new RegExp(`^${LEAD}pushd\\s+${OPTS}(${WORD})`));
  if (pushed) return { kind: 'pushd', target: dequote(pushed[1]) };
  if (new RegExp(`^${LEAD}popd\\b`).test(seg)) return { kind: 'popd' };
  const cd = seg.match(new RegExp(`^${LEAD}cd\\s+${OPTS}(${WORD})`));
  return cd ? { kind: 'cd', target: dequote(cd[1]) } : null;
}

/**
 * Dedupe reachable states, and CAP them. The cap is a runaway guard only: a
 * line would need dozens of `||`-chained `cd`s to approach it, and dropping the
 * tail can only lose scope, never invent it.
 */
function dedupeStates(states) {
  const seen = new Map();
  for (const st of states) {
    // `prev` is part of the state: two states with the same cwd but different
    // OLDPWD diverge on the next `cd -` (#1995 r14).
    const key = `${st.cwd}\u0000${st.stack.join('/')}\u0000${st.prev ?? ''}`;
    if (!seen.has(key)) seen.set(key, st);
    if (seen.size >= 32) break;
  }
  return [...seen.values()];
}

/**
 * Shell lives INSIDE non-shell files too: a workflow's `run: |` block and a
 * fenced ```bash example are both executed by a shell. Scoping shell semantics
 * to `.sh` files (r27) fixed the markdown false positives but opened this gap —
 * a workflow step with `cd apps/keeper` and a `wrangler \` continuation ran a
 * bare deploy that no scanned line contained (Codex #1924 r28).
 *
 * Each embedded block is run through the same scanner, and its logical lines
 * are OFFSET back to real file line numbers. Results are appended to the plain
 * physical lines rather than replacing them, so prose that merely quotes a
 * command is still caught by the default-deny path.
 */
function embeddedShellLines(text, isYaml = false) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let blockId = 0;
  while (i < lines.length) {
    // EVERY fence must be consumed in pairs, whatever its language. Matching
    // only shell fences meant a ```jsonc opener was skipped and its CLOSING
    // ``` was then read as an opener — so the prose after it was scanned as
    // shell, and three allowlisted README lines were reported (Codex #1924
    // r31, caught on the live tree). Only shell-tagged blocks are scanned;
    // the rest are tracked purely to stay in sync.
    // A fence is THREE OR MORE of one character, and its closer must use the
    // same character and be at least as long (CommonMark). Matching exactly
    // three missed `~~~~bash` entirely (Codex #1924 r32, r33).
    // A fence's INFO STRING may carry more than the language —
    // ```bash title="keeper deploy" is valid — so take the whole remainder and
    // use its first word as the language (Codex #1924 r34).
    const anyFence = lines[i].match(/^\s*(`{3,}|~{3,})\s*(\S*)[^\n]*$/);
    const fence = anyFence && /^(bash|sh|shell|console|)$/.test(anyFence[2]);
    // A YAML comment may follow the block indicator (`run: | # deploy keeper`),
    // and the indicator itself decides the folding (Codex #1924 r29).
    // A block scalar may carry an explicit INDENTATION indicator as well as a
    // chomping one, in either order: `|2`, `|2-`, `>+2` (Codex #1924 r30).
    const run = lines[i].match(/^(\s*)(?:-\s+)?run:\s*([|>])(?:[-+]?\d?|\d?[-+]?)\s*(?:#.*)?$/);
    // A `run:` value does not have to be a BLOCK scalar to span lines. A quoted
    // or plain multiline flow scalar folds its newlines to spaces just as `>`
    // does, so `run: "cd apps/keeper;` with `wrangler deploy"` beneath it
    // executes as the single script `cd apps/keeper; wrangler deploy`.
    // Recognising only `|` and `>` left that to the physical-line scan, which
    // sees the scope and the deploy on SEPARATE lines and passed the
    // destructive command (Codex #1924 r37).
    //
    // YAML files only: folding is a YAML rule, and applying it to prose that
    // merely contains `run:` would join lines the author never joined — the
    // same scoping mistake the shell scanner made over markdown at r27.
    const flow =
      isYaml && !run ? lines[i].match(/^(\s*)(?:-\s+)?run:[ \t]+(\S.*)$/) : null;
    if (anyFence) {
      const start = i + 1;
      let j = start;
      const closer = new RegExp(`^\\s*${anyFence[1][0] === '`' ? '`' : '~'}{${anyFence[1].length},}\\s*$`);
      while (j < lines.length && !closer.test(lines[j])) j += 1;
      if (fence) {
        out.push(...offset(logicalLines(lines.slice(start, j).join('\n')), start, blockId));
        blockId += 1;
      }
      i = j + 1;
      continue;
    }
    if (run) {
      const indent = run[1].length;
      const start = i + 1;
      let j = start;
      while (
        j < lines.length &&
        (lines[j].trim() === '' || (lines[j].match(/^\s*/) ?? [''])[0].length > indent)
      ) {
        j += 1;
      }
      // `run: >` is a FOLDED scalar: YAML replaces ordinary newlines with
      // spaces before the shell ever sees it, so `cd apps/keeper;` / `wrangler`
      // / `deploy` on three source lines executes as one command. Scanning the
      // unfolded source missed it entirely (Codex #1924 r29).
      const raw = lines.slice(start, j);
      const body = run[2] === '>' ? foldYamlScalar(raw) : raw.join('\n');
      out.push(
        ...offset(logicalLines(body), start, blockId, isYaml ? workingDirFor(lines, i) : ''),
      );
      blockId += 1;
      i = j;
      continue;
    }
    if (flow) {
      const end = flowScalarEnd(lines, i, flow[2], flow[1].length);
      // Only a scalar that actually SPANS lines is folded into a block. A
      // single-line `run:` is already judged correctly as a physical line, and
      // routing it through here as well would report one violation twice.
      // A single-line `run:` needs the same seeding: Actions runs it from
      // `working-directory` too, and only the multiline branch was reaching
      // `workingDirFor` (#1995 r8). Emitted as its own block so the cwd applies;
      // the duplicate with the physical line is removed by the dedupe at the
      // reporting site.
      if (end === i && isYaml) {
        const wd = workingDirFor(lines, i);
        if (wd) {
          out.push(...offset(logicalLines(flow[2]), i, blockId, wd));
          blockId += 1;
        }
      }
      if (end > i) {
        const q = flow[2][0] === '"' || flow[2][0] === "'" ? flow[2][0] : null;
        const parts = [flow[2], ...lines.slice(i + 1, end + 1)];
        if (q) {
          parts[0] = parts[0].slice(1);
          const last = parts.length - 1;
          const close = parts[last].lastIndexOf(q);
          if (close !== -1) {
            parts[last] = parts[last].slice(0, close) + parts[last].slice(close + 1);
          }
        }
        out.push(
          ...offset(
            logicalLines(foldFlowScalar(parts, q)),
            i,
            blockId,
            isYaml ? workingDirFor(lines, i) : '',
          ),
        );
        blockId += 1;
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/**
 * Index of the LAST line of a YAML flow scalar whose content opens on
 * `lines[i]` as `content`, with its key at `indent`.
 */
function flowScalarEnd(lines, i, content, indent) {
  const q = content[0] === '"' || content[0] === "'" ? content[0] : null;
  if (!q) {
    // A plain multiline scalar continues while lines are MORE indented than the
    // key. A new list item or a comment ends it.
    //
    // A BLANK LINE does not: YAML keeps it as a line break and the scalar
    // carries on while the content after it is still indented. Ending
    // extraction there left `cd apps/keeper;` and an indented `wrangler deploy`
    // in separate blocks, so the physical scan saw scope and deploy apart and
    // passed the destructive command (Codex #1924 r38). Look PAST the blanks
    // before deciding.
    let j = i;
    for (;;) {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === '') k += 1;
      if (
        k >= lines.length ||
        (lines[k].match(/^\s*/) ?? [''])[0].length <= indent ||
        /^\s*[-#]/.test(lines[k]) ||
        // A SIBLING MAPPING KEY ends the scalar. `indent` is measured to the
        // dash of a list item, so a step's own `working-directory:` sits one
        // level deeper and was folded INTO the shell text:
        //
        //     - run: wrangler deploy --keep-vars
        //       working-directory: apps/agent
        //
        // became `wrangler deploy --keep-vars working-directory: apps/agent`,
        // where `--keep-vars` reads as having the VALUE `working-directory:` —
        // not literally true, so the flag scored as DISABLED and a correct
        // step was reported as a violation. A false red on the ordinary
        // spelling of a workflow step, and this guard blocks the unfiltered CI
        // job. Found while fixing the matrix expression beside it, not
        // reported.
        //
        // Shell continuation lines do not start `word:` — the r38 case is
        // `cd apps/keeper;` followed by an indented `wrangler deploy` — so
        // this ends scalars that YAML ends and leaves those alone.
        /^\s*[A-Za-z_][A-Za-z0-9_.-]*:(?:\s|$)/.test(lines[k])
      ) {
        return j;
      }
      j = k;
    }
  }
  let rest = content.slice(1);
  let j = i;
  for (;;) {
    if (closesQuote(rest, q)) return j;
    j += 1;
    // An unterminated scalar is malformed YAML; stop at the last line rather
    // than running off the end.
    if (j >= lines.length) return j - 1;
    rest = lines[j];
  }
}

/**
 * Fold a YAML FLOW scalar's physical lines the way YAML does: an ordinary line
 * break becomes a space, a blank line becomes a real break.
 */
function foldFlowScalar(parts, q) {
  let out = '';
  for (const part of parts) {
    const t = part.trim();
    if (t === '') {
      out += '\n';
      continue;
    }
    if (out === '' || out.endsWith('\n')) {
      out += t;
      continue;
    }
    // A double-quoted scalar may end a line with `\`, YAML's ESCAPED LINE
    // BREAK: the newline is removed OUTRIGHT rather than folded to a space, so
    // `wrangler \` + `deploy` runs as `wrangler deploy`. Joining with a space
    // produced `wrangler \ deploy`, which matches nothing — the guard exited 0
    // on a destructive command (Codex #1924 r38). Only an ODD run of trailing
    // backslashes escapes the break; `\\` is a literal backslash.
    if (q === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(out)) {
      out = `${out.slice(0, -1)}${t}`;
      continue;
    }
    out += ` ${t}`;
  }
  return out;
}

/** Does `s` contain the closing `q` of an already-open YAML quoted scalar? */
function closesQuote(s, q) {
  for (let k = 0; k < s.length; k += 1) {
    // `\"` escapes inside a double-quoted scalar; `''` is a literal quote
    // inside a single-quoted one.
    if (q === '"' && s[k] === '\\') {
      k += 1;
      continue;
    }
    if (s[k] === q) {
      if (q === "'" && s[k + 1] === "'") {
        k += 1;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Shift a block's logical lines back to real file line numbers. */
function offset(block, start, blockId, cwd = '') {
  return block.map((l) => ({
    text: l.text,
    line: l.line + start,
    block: blockId,
    cwd,
  }));
}

/**
 * The directory a workflow step actually runs in.
 *
 * Actions executes a `run:` body from `working-directory` when one is set, at
 * the step or through `defaults.run` — both established patterns in this repo's
 * own workflows. The scanner extracted only the run BODY, so a step that sets
 * `working-directory: apps/agent` and then runs a bare `wrangler deploy`
 * contained no scope text anywhere and passed (#1995 r7).
 *
 * Step level wins over the job default, which is Actions' own precedence.
 */
function workingDirFor(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  // The unquoted alternative must admit an EXPRESSION: `${{ matrix.dir }}`
  // contains spaces, so `\S+` captured only `${{` (#1995 r11).
  const WD =
    /^\s*working-directory:\s*(?:"([^"]*)"|'([^']*)'|(\$\{\{[^}]*\}\}|\S+))/;
  // FLOW-style mapping (#1995 r13): `defaults: { run: { working-directory: X } }`
  // is the same Actions configuration as the block form, and only the block
  // form was recognised — so a workflow written this way ran its inline deploy
  // from the protected directory with the guard reporting success. `WD` cannot
  // see it because that pattern is anchored at the start of a line.
  const FLOW_DEFAULTS_WD =
    /defaults:\s*\{[^}]*working-directory:\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/;
  /**
   * A matrix expression is not a literal directory (#1995 r11).
   *
   * `working-directory: ${{ matrix.dir }}` with `dir: [apps/agent, ...]` runs
   * one leg of the matrix FROM the protected package, so that leg must be
   * reported. Resolved against the declared values: if any of them lands in a
   * scoped package, that value is used; if the list is found and none do, the
   * step is genuinely out of scope; if the list cannot be found at all, the
   * expression resolves to nothing rather than being taken literally — which
   * is what recorded `${{` as a directory name before.
   */
  const resolveMatrix = (raw) => {
    const mm = raw.match(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/);
    if (!mm) return raw;
    for (const l of lines) {
      const km = l.match(new RegExp(`^\\s*${mm[1]}:\\s*\\[([^\\]]*)\\]`));
      if (!km) continue;
      const vals = km[1]
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      const hit = vals.find((v) =>
        SCOPED.some((sc) => v === sc.dir || v.startsWith(`${sc.dir}/`)),
      );
      return hit ?? '';
    }
    return '';
  };
  const valueOf = (m) => resolveMatrix(m[1] ?? m[2] ?? m[3]);

  // STEP: walk up to this step's `- ` marker, then scan the step's own body.
  const runIndent = indentOf(lines[runIdx]);
  let start = runIdx;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) {
    if (lines[start].trim() !== '' && indentOf(lines[start]) < runIndent) break;
    start -= 1;
  }
  if (/^\s*-\s/.test(lines[start])) {
    const stepIndent = indentOf(lines[start]);
    for (let i = start; i < lines.length; i += 1) {
      if (i > start && lines[i].trim() !== '') {
        const ind = indentOf(lines[i]);
        if (ind < stepIndent || (ind === stepIndent && /^\s*-\s/.test(lines[i]))) break;
      }
      const m = lines[i].match(WD);
      if (m) return valueOf(m);
    }
  }

  // DEFAULTS, confined to the CONTAINING JOB. Taking the nearest preceding
  // `defaults:` let one job's default leak into a later job that has none —
  // reporting a repo-root deploy as the agent's, which is a false red (#1995
  // r8). Job scope is bounded by the job-key line and the next key at the same
  // indent; a workflow-level `defaults:` outside `jobs:` still applies.
  const declaredIn = (from, to) => {
    for (let i = from; i < to && i < lines.length; i += 1) {
      const flowJob = lines[i].match(FLOW_DEFAULTS_WD);
      if (flowJob) return flowJob[1] ?? flowJob[2] ?? flowJob[3];
      if (!/^\s*defaults:\s*$/.test(lines[i])) continue;
      const di = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() !== '' && indentOf(lines[j]) <= di) break;
        const m = lines[j].match(WD);
        if (m) return valueOf(m);
      }
    }
    return '';
  };

  const jobsIdx = lines.findIndex((l) => /^\s*jobs:\s*$/.test(l));
  let jobStart = -1;
  let jobIndent = -1;
  if (jobsIdx >= 0 && runIdx > jobsIdx) {
    const ji = indentOf(lines[jobsIdx]);
    for (let i = jobsIdx + 1; i <= runIdx; i += 1) {
      if (lines[i].trim() === '') continue;
      const ind = indentOf(lines[i]);
      if (ind <= ji) break;
      if (jobIndent === -1) jobIndent = ind;
      if (ind === jobIndent && /^\s*[\w.-]+:\s*$/.test(lines[i])) jobStart = i;
    }
  }
  if (jobStart >= 0) {
    let jobEnd = lines.length;
    for (let i = jobStart + 1; i < lines.length; i += 1) {
      if (lines[i].trim() !== '' && indentOf(lines[i]) <= jobIndent) {
        jobEnd = i;
        break;
      }
    }
    const inJob = declaredIn(jobStart, jobEnd);
    if (inJob) return inJob;
  }
  // Workflow level: a top-level `defaults:` applies to every job WHEREVER it is
  // declared. YAML mapping order is not significant, so searching only the text
  // before `jobs:` missed a perfectly valid workflow that declares `jobs:`
  // first (#1995 r10) — and missing it means an inline bare deploy runs from
  // the agent's directory with the guard reporting success.
  //
  // Selected by INDENT rather than by position: anything belonging to a job is
  // more deeply indented than `jobs:` itself, so the indent test excludes
  // job-level blocks without needing to bound the jobs region. That keeps the
  // r8 property — one job's default must not leak into a later job — which is
  // handled above by `declaredIn` over the containing job.
  const topIndent = jobsIdx >= 0 ? indentOf(lines[jobsIdx]) : 0;
  for (let i = 0; i < lines.length; i += 1) {
    const flowTop = lines[i].match(FLOW_DEFAULTS_WD);
    if (flowTop && indentOf(lines[i]) === topIndent) {
      return flowTop[1] ?? flowTop[2] ?? flowTop[3];
    }
    if (!/^\s*defaults:\s*$/.test(lines[i])) continue;
    if (indentOf(lines[i]) !== topIndent) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= topIndent) break;
      const m = lines[j].match(WD);
      if (m) return valueOf(m);
    }
  }
  return '';
}

/**
 * YAML folded-scalar (`>`) semantics: ordinary newlines become spaces; a blank
 * line is a real line break; a MORE-indented line keeps its newline.
 */
function foldYamlScalar(raw) {
  const base = Math.min(
    ...raw.filter((l) => l.trim() !== '').map((l) => (l.match(/^\s*/) ?? [''])[0].length),
  );
  let out = '';
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k];
    if (l.trim() === '') {
      out += '\n';
      continue;
    }
    const indent = (l.match(/^\s*/) ?? [''])[0].length;
    if (indent > base) {
      // A more-indented line keeps its own line breaks on BOTH sides. Adding
      // one only before it let the NEXT base-indented line join the
      // more-indented one — so a `# note` swallowed the `wrangler deploy`
      // beneath it (Codex #1924 r30).
      out += `\n${l}\n`;
      continue;
    }
    out += (out === '' || out.endsWith('\n') ? '' : ' ') + l.trim();
  }
  return out;
}

/** Physical lines, 1-based, for everything that is not a shell script. */
/**
 * Lines of a JSON/JSONC file, with each string VALUE unwrapped (#1995 r14).
 *
 * In `"deploy": "wrangler deploy && wrangler deploy --keep-vars"` the shell
 * command is the value. Handing the quoted form to `splitCommands` made the
 * enclosing double quotes read as SHELL quoting, so the `&&` never split, and
 * `commandIsSafe` saw the trailing flag and blessed the whole value — while
 * `pnpm run deploy` runs the BARE deploy first, erases the dashboard vars, and
 * only then runs the safe one.
 *
 * JSON escapes are resolved, so `\"` inside a script becomes a quote the shell
 * splitter can reason about rather than a delimiter it cannot.
 */
function jsonValueLines(text) {
  return text.split('\n').map((t, i) => {
    const m = t.match(/:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/);
    return {
      text: m ? m[1].replace(/\\(.)/g, '$1') : t,
      line: i + 1,
      physical: true,
    };
  });
}

function plainLines(text) {
  // `physical: true` marks a line that is NOT part of a shell script. Such a
  // line cannot establish a working directory for a LATER line — a markdown
  // paragraph is not a command sequence — and letting it try was the r29 fix
  // being incomplete: every plainLines entry had `block === undefined`, they
  // all sort before the embedded blocks, so one file's `cd apps/keeper` in
  // prose still rejected an unrelated agent deploy further down (Codex #1924
  // r30). Directory state now belongs exclusively to real shell blocks.
  return text.split('\n').map((t, i) => ({ text: t, line: i + 1, physical: true }));
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
    if (SKIP_PATHS.has(relative(REPO_ROOT, full))) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.some((e) => entry.endsWith(e)) || looksExecutable(entry)) {
      // The header claims shebang detection, but an extension allow-list never
      // yields an extensionless file, so `contracts/script/deploy-keeper` with
      // a bash shebang was never even opened (Codex #1924 r28). Extensionless
      // candidates are yielded and `isShellFile` decides from the shebang.
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
  // Fold shell line continuations FIRST. A wrapper may spell the command
  // `wrangler \` / newline / `deploy`, which bash runs as a bare
  // `wrangler deploy` — but the literal prefilter below never matched it, so
  // the whole FILE was skipped (Codex #1924 r25). This is an ordinary form in
  // shell scripts, not an exotic one.
  //
  // Folding shifts line numbers, so each folded line keeps the 1-based number
  // of the line it STARTED on: that is the line an operator needs to open.
  // Shell semantics apply to SHELL files. A markdown runbook has no line
  // continuations and no `#` comments — `#` is a heading and a backtick opens
  // a code span, not a quoted string — so running the shell scanner over prose
  // folded whole paragraphs into single "lines" and produced four false
  // positives on a clean tree. Every file still gets scanned; only the model
  // of what a line IS differs (Codex #1924 r27).
  const folded = isShellFile(rel, text)
    ? logicalLines(text)
    : [
        ...(/\.jsonc?$/.test(rel) ? jsonValueLines(text) : plainLines(text)),
        ...embeddedShellLines(text, /\.ya?ml$/.test(rel)),
      ];
  if (
    !folded.some(
      (l) =>
        new RegExp(ANY_DEPLOY_RE).test(l.text) ||
        // ANY_DEPLOY_RE on the dequoted form too (#1995 r9). The fallback was
        // added for composed package-script names and used RUN_DEPLOY_RE only,
        // so `wrang"ler" deploy` and `wrangler de"ploy"` skipped the WHOLE
        // FILE at the prefilter — the composition defect the fallback exists
        // for, on the other half of the same alternation.
        new RegExp(ANY_DEPLOY_RE).test(dequote(l.text)),
    )
  ) {
    continue;
  }
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
  // A SET of reachable states, not one boolean. `cd apps/keeper || cd apps/agent`
  // runs the right-hand `cd` only if the left one FAILED, so applying both
  // unconditionally ended in agent scope and passed a deploy that in this tree
  // runs from the keeper (Codex #1924 r39). Each state carries its own pushd
  // stack. A deploy is judged against every state that can reach it: for a
  // default-deny guard, one reachable keeper state is enough to flag.
  // A runbook often puts the package on a LABEL line and the copyable command
  // on the next: "From apps/agent, run:" then `wrangler deploy`. The command
  // line names nothing, so line-local scope loses it (#1995 r15).
  //
  // DELIBERATELY NARROW, because this is prose and this guard blocks the
  // unfiltered CI job. The label must END WITH A COLON — i.e. it introduces
  // what follows — and must name EXACTLY ONE scoped package; a line mentioning
  // two, or mentioning one in passing without introducing a command, hands over
  // nothing. Blank lines between label and command are allowed; anything else
  // resets it.
  const rawLines = text.split('\n');
  const labelScope = new Map();
  {
    let pending = null;
    for (let i = 0; i < rawLines.length; i += 1) {
      const t = rawLines[i].trim();
      if (t === '') continue;
      if (pending) labelScope.set(i + 1, pending);
      if (/:\s*$/.test(t)) {
        const named = SCOPED.filter((sc) => scopeOf(t, '') === sc || new RegExp(
          `${sc.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`,
        ).test(t));
        pending = named.length === 1 ? named[0] : null;
      } else {
        pending = null;
      }
    }
  }
  const INITIAL = [{ cwd: '', stack: [] }];
  /** Literal `VAR=value` assignments seen so far in the current shell block. */
  const shellVars = new Map();
  let states = INITIAL;
  let prior = INITIAL;
  let currentBlock;
  folded.forEach(({ text: line, line: lineNo, block, physical, cwd: blockCwd }) => {
    // Each embedded block is a SEPARATE shell — an Actions step starts fresh,
    // and so does the next fenced example. Carrying `cwdIsKeeper` across them
    // made one block's `cd apps/keeper` reject the NEXT block's agent deploy
    // (Codex #1924 r29). That is a false positive, and this guard runs in
    // typecheck, so it would have blocked CI on a correct workflow.
    if (block !== currentBlock) {
      currentBlock = block;
      shellVars.clear();
      // A workflow step's `working-directory` is where its commands actually
      // run, so the block starts THERE rather than at an empty cwd (#1995 r7).
      states = blockCwd ? [{ cwd: blockCwd.replace(/\/+$/, ''), stack: [] }] : INITIAL;
      prior = states;
    }
    if (/^\s*$/.test(line) || /^\s*(?:`{3,}|~{3,})/.test(line)) {
      states = INITIAL;
      prior = INITIAL;
      return;
    }
    let flagged = false;
    // EVERY offending scope on the line, not the first (#1995 r6). A line can
    // carry an unsafe deploy for both packages — "For apps/keeper run wrangler
    // deploy; for apps/agent run wrangler deploy" — and reporting one of them
    // omits the other's remedy entirely, so the second is only discovered on a
    // later CI round after the first is fixed.
    const hitScopes = new Set();
    if (physical) {
      // Prose cannot cd a shell, so a non-shell line is judged on its own
      // content only — it neither reads nor writes the directory state.
      // PER SEGMENT, not per line (#1995 r1). One prose line can name both
      // packages — "for apps/keeper use pnpm run deploy; for apps/agent use
      // wrangler deploy" — and attributing it to the whole line reported the
      // KEEPER, purely because it is first in SCOPED, with the keeper's filter
      // and HF_SCALE remedy beside an agent problem. The scope has to come from
      // the segment carrying the unsafe command.
      const lineScope = scopeOf(line, rel) ?? labelScope.get(lineNo) ?? null;
      for (const part of splitCommands(line)) {
        const seg = part.text;
        // The dequoted fallback belongs here too (#1995 r9). Only the shell
        // path had it, so `From apps/agent run pnpm run de"ploy"
        // --no-keep-vars` in a runbook was accepted while the identical text
        // in a `.sh` fixture was rejected — the same sentence judged two ways
        // by which file it sits in, and prose is what an operator copies.
        if (
          !new RegExp(ANY_DEPLOY_RE).test(seg) &&
          !new RegExp(ANY_DEPLOY_RE).test(dequote(seg))
        ) {
          continue;
        }
        if (commandIsSafe(seg)) continue;
        // Fall back to the whole line only when the segment itself names
        // nothing: prose often establishes the package in an earlier clause,
        // and a file inside a scoped tree scopes every line in it.
        const sel = selectorScope(seg, [{ cwd: '', stack: [] }], false);
        // A single filter can select BOTH packages, and each needs its own
        // remedy in the same report (#1995 r7).
        const many = filterScopes(seg) ?? [];
        if (!sel && many.length > 1) {
          flagged = true;
          for (const sc of many) hitScopes.add(sc);
          continue;
        }
        const scope = sel ? sel.scope : scopeOf(seg, rel) ?? lineScope;
        if (!scope) continue;
        flagged = true;
        hitScopes.add(scope);
      }
    } else {
      // `pushd` moves the shell exactly as `cd` does and is ordinary in deploy
      // wrappers; recognising only `cd` let `pushd apps/keeper` plus a bare
      // deploy on the next line through (Codex #1924 r27). `popd` returns
      // somewhere this scanner cannot know, so it conservatively clears scope.
      // `pushd`/`popd` are a STACK: after `pushd apps/keeper; pushd ../agent;
      // popd` the shell is back in apps/keeper. A single boolean lost that and
      // skipped the deploy underneath (Codex #1924 r28).
      // Prose cannot cd the shell, so a non-shell line neither reads nor
      // writes this state. An early version used `return` here — which exits
      // the whole callback and silently skipped EVERY markdown line. Twenty
      // fixtures went red at once, which is exactly what they are for.
      // Directory changes are matched PER COMMAND SEGMENT, not only at the
      // start of the logical line: `set -e; cd apps/keeper` is an ordinary
      // wrapper preamble, and a start-anchored match never saw the `cd`
      // (Codex #1924 r35). splitCommands already knows where the boundaries
      // are, and it is quote- and redirection-aware.
      // Applied IN ORDER, every segment. Taking the first match of each kind
      // meant `set -e; cd apps/agent; cd apps/keeper` recorded AGENT scope —
      // and the reverse order produced a false rejection (Codex #1924 r36).
      // The shell ends up wherever the LAST one put it.
      //
      // The scope is also READ here, in the same walk, rather than snapshotted
      // at the start of the line. A `cd` affects the commands that FOLLOW it:
      // reaching a line with keeper scope and then running
      // `cd ../agent; wrangler deploy` executes that deploy from apps/agent,
      // but a line-start snapshot judged it as keeper and rejected it
      // (Codex #1924 r37) — a false positive, in a guard that runs in
      // typecheck.
      // What the line SAYS is scope only for the part of it that is not a
      // directory change. `cd apps/keeper; cd ../agent; wrangler deploy` walks
      // to apps/agent, but the line still contains the string `apps/keeper`, so
      // a whole-line fallback let a SUPERSEDED `cd` override the walk and
      // rejected the agent deploy (Codex #1924 r38). Directory changes are
      // already represented by `cwdIsKeeper`; only the rest can name the keeper
      // independently — `KEEPER_DIR=…` assignments and the subshell form, which
      // is not `^cd`-shaped and so stays in this prefix.
      // Entries carry the PAREN DEPTH they were added at. A directory change
      // inside a subshell does not outlive it — `(cd apps/agent && echo x);
      // wrangler deploy` runs the deploy from the original directory — but the
      // prefix was carried through the rest of the line and reported it as an
      // agent violation (#1995 r6). A false red, in the unfiltered CI job.
      const namedPrefix = [];
      let depth = 0;
      // The previous line ran to completion, so this line starts from `states`.
      prior = states;
      let pendingDepth = 0;
      // Indexed, because whether a segment runs in a subshell depends on the
      // separator that FOLLOWS it, and `sep` records the one that PRECEDES.
      // States entering each open subshell, so `)` can restore them (#1995 r13).
      const stateStack = [];
      const segments = splitCommands(line);
      for (let pi = 0; pi < segments.length; pi += 1) {
        const part = segments[pi];
        const nextPart = segments[pi + 1];
        // Close any subshell the PREVIOUS segment ended.
        if (pendingDepth < depth) {
          for (let k = namedPrefix.length - 1; k >= 0; k -= 1) {
            if (namedPrefix[k].depth > pendingDepth) namedPrefix.splice(k, 1);
          }
          // A `( … )` subshell cannot move the PARENT either (#1995 r13). The
          // r9 fix covered `|` and `&` and stopped there, so
          // `cd apps/agent; (echo x; cd ../indexer); wrangler deploy` still
          // recorded the indexer while bash stays in apps/agent. Restore the
          // state that was current when each level opened.
          for (let k = depth; k > pendingDepth; k -= 1) {
            const saved = stateStack.pop();
            if (saved) states = saved;
          }
        }
        depth = pendingDepth;
        const seg = part.text.trim();
        // Depth AFTER this segment. The segment is evaluated at the CURRENT
        // depth, because a closing paren at its end comes after the command it
        // contains: in `( cd X && wrangler deploy )` the deploy is still inside
        // the subshell. Entries are dropped only once the segment is done.
        const segDepth = Math.max(0, depth + netParens(part.text));
        // Applied as a deferred transition so it runs for EVERY segment,
        // including the ones below that `continue` early.
        pendingDepth = segDepth;
        // `||` means the PREVIOUS segment failed, so this one starts from the
        // state that preceded it — a failed `cd` moves nothing.
        const input = part.sep === '||' ? prior : states;
        // Snapshot BEFORE this segment's own `cd` is applied: the paren opens
        // at its start, so the state entering the subshell is `input`.
        if (segDepth > depth) {
          for (let k = depth; k < segDepth; k += 1) stateStack.push(input);
        }
        const dir = dirDirective(seg);
        // A `cd` that runs as a PIPELINE or BACKGROUND element executes in a
        // SUBSHELL and cannot move the parent (#1995 r9). In
        // `cd apps/agent; cd ../indexer | cat; wrangler deploy` bash is still
        // in apps/agent when the deploy runs, but the scanner recorded the
        // indexer and the protected bare deploy passed.
        //
        // Both sides of the segment matter: `sep` is the separator BEFORE this
        // part, so a downstream pipeline stage carries `|` itself, while an
        // upstream one is identified by the NEXT part's separator. `&`
        // backgrounds a subshell the same way.
        const inSubshell =
          part.sep === '|' || nextPart?.sep === '|' || nextPart?.sep === '&';
        const after =
          dir && !inSubshell ? input.map((st) => applyDir(st, dir, shellVars)) : input;
        // An explicit `cd` that MOVES THE PARENT SHELL establishes where the
        // command actually runs, so an assignment naming a different package
        // earlier on the line stops being evidence of scope:
        // `TARGET=apps/agent; cd apps/indexer; wrangler deploy` is a valid bare
        // indexer deploy, and preferring the unused TARGET text over the
        // modelled cwd was a false red (#1995 r15). Assignments still feed
        // `shellVars`, which is how `cd "$TARGET"` resolves; what they stop
        // doing is standing in for a cwd the shell has since been told. Not
        // applied for a subshell/pipeline `cd`, which never reached the parent.
        if (dir && !inSubshell && dir.kind !== 'popd') {
          for (let k = namedPrefix.length - 1; k >= 0; k -= 1) {
            if (namedPrefix[k].assignment) namedPrefix.splice(k, 1);
          }
        }
        // After `A || B` both outcomes remain reachable: A succeeded and B was
        // skipped, or A failed and B ran.
        //
        // `&&` is the mirror and was missing (#1995 r13): its right-hand side
        // runs ONLY if the left succeeded, so `false && cd ../indexer` may move
        // nothing at all. Applying it unconditionally let a later bare deploy
        // be judged against a directory the shell need never have entered.
        const next =
          part.sep === '||' || part.sep === '&&'
            ? dedupeStates([...states, ...after])
            : after;
        prior = input;
        states = next;
        if (dir) continue;
        // Only constructs that can actually ESTABLISH a target carry forward:
        // a `VAR=…` assignment, or a directory expression the dir-walk could
        // not claim (the subshell form `( cd "$AGENT_DIR" && …`, which is not
        // `^cd`-shaped). Accumulating EVERY preceding command let an unrelated
        // mention scope a later deploy — `echo apps/agent; cd apps/indexer;
        // wrangler deploy` was reported as an agent violation even though the
        // `cd` moves to the explicitly out-of-scope indexer (#1995 r5). That is
        // a false red in a check that blocks the unfiltered CI job.
        if (new RegExp(`^${DECL_PREFIX}[A-Za-z_][A-Za-z0-9_]*=`).test(seg)) {
          // Deliberately NOT the WORD pattern: anchoring its nested quantifiers
          // with `$` backtracks catastrophically on a non-matching line and hung
          // the guard. A literal value needs only simple alternatives, and a
          // mixed-chunk assignment simply stays unremembered — which is the safe
          // direction, since an unknown variable clears scope.
          // The value is a shell WORD, not one chunk of one (#1995 r9).
          // `TARGET=apps/"agent"` is the literal `apps/agent` to bash; this
          // matcher rejected it, the variable stayed unremembered, and a later
          // `cd "$TARGET"` then cleared scope instead of entering the agent.
          // Spelled with a ONE-CHARACTER unquoted alternative rather than the
          // shared `WORD`, which ends in `[^...]+` nested inside a `(?:...)+`.
          // That is ambiguous — a run of n characters can be partitioned n
          // ways — and ANCHORED here with `$`, every NON-matching segment
          // explores all of them. Using `WORD` here took the guard from ~30s
          // to over five minutes on this tree before it was caught. One
          // character per iteration admits exactly one partition.
          const asg = seg.match(
            new RegExp(
              `^${DECL_PREFIX}([A-Za-z_][A-Za-z0-9_]*)=` +
                '((?:"[^"]*"|\'[^\']*\'|\\\\[\\s\\S]|[^\\s"\'`;&|)\\\\])*)\\s*$',
            ),
          );
          // Only a LITERAL value is remembered; one containing a `$` is still
          // computed as far as this scanner can tell.
          // A COMPUTED value invalidates the binding rather than leaving the
          // previous one standing (#1995 r14). `TARGET=apps/indexer` then
          // `TARGET=$(printf %s apps/agent)` kept resolving to the indexer,
          // so `cd "$TARGET"` modelled the wrong package and the protected
          // deploy passed. Not knowing must clear what was known.
          // The name is read from the GATE, not from `asg` — a value the
          // matcher cannot parse at all (`TARGET=$(printf %s apps/agent)`
          // stops at the space inside the substitution) leaves `asg` null, and
          // that is precisely the case where the old binding must go.
          const named = seg.match(
            new RegExp(`^${DECL_PREFIX}([A-Za-z_][A-Za-z0-9_]*)=`),
          );
          if (asg && asg[2] && !/\$/.test(asg[2])) {
            shellVars.set(asg[1], dequote(asg[2]));
          } else if (named) {
            shellVars.delete(named[1]);
          }
          // Recorded with the depth AND marked as an assignment, so a later
          // explicit `cd` on the same line can supersede it (#1995 r15).
          namedPrefix.push({ text: seg, depth: segDepth, assignment: true });
        } else {
          const at = seg.search(/(?:^|[\s({])(?:cd|pushd)\s/);
          if (at >= 0) {
            // The depth the directory change happens AT, and the depth this
            // segment ends at. A subshell that opens and closes within one
            // segment nets zero, so the transition below never sees it —
            // `(cd apps/agent); wrangler deploy` kept agent scope for the rest
            // of the line and reported a false violation (#1995 r6). If the
            // segment ends shallower than the change, the change is confined to
            // a subshell that has already closed and never applied outside it.
            const atDepth = depth + netParens(seg.slice(0, at + 1));
            if (segDepth >= atDepth) {
              namedPrefix.push({ text: seg, depth: atDepth });
            }
          }
        }
        // `\b` so `wrangler deployments list` is not read as a deploy.
        if (
          !new RegExp(ANY_DEPLOY_RE).test(seg) &&
          // Same widening as the prefilter above (#1995 r9).
          !new RegExp(ANY_DEPLOY_RE).test(dequote(seg))
        ) {
          continue;
        }
        // An explicit selector WINS. wrangler's help makes `--name` the "Name
        // of the Worker", so `For apps/keeper: wrangler deploy --name
        // vaipakam-agent` deploys the AGENT however the line reads — and
        // reporting it under the keeper handed the reader the wrong remedy
        // (#1995 r2). Textual and cwd scope apply only when no selector
        // resolved.
        const sel = selectorScope(seg, input);
        // An explicit `cd` OUTRANKS where the wrapper file happens to live
        // (#1995 r9). `scopeOf`'s last resort is "this file is inside a scoped
        // package", and it ran before the modelled cwd — so in a script under
        // `apps/agent`, `cd apps/indexer; wrangler deploy` was reported as an
        // AGENT violation although the shell is demonstrably in the indexer,
        // which is not a protected package at all. A false red, in a check that
        // blocks the unfiltered CI job.
        //
        // Passing an empty path suppresses only that fallback; the textual
        // signals in `scopeOf` still apply, and the cwd model answers next.
        const movedCwd = input.some((st) => st.cwd !== '');
        const scope = sel
          ? sel.scope
          : scopeOf(
              [...namedPrefix.map((e) => e.text), seg].join(' '),
              movedCwd ? '' : rel,
            ) ??
            input.map((st) => scopeOfCwd(st.cwd)).find(Boolean) ??
            null;
        if (!scope) continue;
        if (commandIsSafe(seg)) continue;
        flagged = true;
        const many = sel ? [] : filterScopes(seg) ?? [];
        if (many.length > 1) for (const sc of many) hitScopes.add(sc);
        else hitScopes.add(scope);
      }
      // A subshell that closes at the END of the line restores HERE. The pop
      // above runs at the start of the next segment, and there may not be one
      // (#1995 r13) — which is exactly the reported shape, `(echo x; cd
      // ../indexer)` on a line of its own, leaking the indexer into the state
      // the following line's deploy is judged against.
      for (let k = depth; k > pendingDepth; k -= 1) {
        const saved = stateStack.pop();
        if (saved) states = saved;
      }
    }

    if (!flagged) return;
    if (allowReason(line)) return;
    if (hitScopes.size === 0) {
      violations.push({ where: `${rel}:${lineNo}`, line: line.trim(), scope: null });
      return;
    }
    for (const sc of hitScopes) {
      const where = `${rel}:${lineNo}`;
      // A line can now reach the reporter twice — once as a physical line and
      // once as a seeded workflow block — so the same (line, package) pair is
      // reported once (#1995 r8).
      if (violations.some((v) => v.where === where && v.scope === sc)) continue;
      violations.push({ where, line: line.trim(), scope: sc });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\n[check-deploy-invocations] ${violations.length} deploy(s) missing --keep-vars:\n`,
  );
  // Grouped by package, because the remedy names a package: the reader needs
  // the right pnpm filter and the right list of vars at risk, and a single
  // keeper-worded message next to an agent violation sends them to the wrong
  // wrangler.jsonc (#1933).
  for (const s of SCOPED) {
    const hits = violations.filter((v) => v.scope === s);
    if (hits.length === 0) continue;
    console.error(`  ${s.dir}:\n`);
    for (const v of hits) console.error(`    ${v.where}\n      ${v.line}\n`);
    console.error(
      `    Use \`pnpm --filter ${s.filter} run deploy\` (the package script carries\n` +
        `    the flag), or add --keep-vars explicitly. A bare deploy deletes every var\n` +
        `    not in ${s.dir}/wrangler.jsonc — including the ${s.vars}\n` +
        `    tuning its source reads.\n`,
    );
  }
  const unattributed = violations.filter((v) => !v.scope);
  for (const v of unattributed) {
    console.error(`  ${v.where}\n    ${v.line}\n`);
  }
  process.exit(1);
}

console.log(
  `[check-deploy-invocations] OK — every deploy in ${SCOPED.length} scoped ` +
    'package(s) preserves vars.',
);
