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
// `[= ]` and not `=` alone: a package-manager option may take a SEPARATED
// value, and `pnpm help run` documents `-C, --dir <dir>` as exactly that. The
// pattern could only step over `--opt` or `--opt=value`, so `pnpm run -C
// apps/agent deploy --no-keep-vars` never reached `deploy` and the whole
// destructive line was invisible to detection (#1995 r16). `[^\s-]` on the
// first character of the value keeps the NEXT option from being eaten as this
// one's value — the same rule `stripOtherOptionValues` uses, and the same one
// `DEPLOY_RE` above has carried since it was written.
const RUN_DEPLOY_RE = String.raw`(?:pnpm|npm|yarn)(?:\s+[^\s]+)*?\s+(?:${RUN_ALIASES})(?:\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?)*\s+deploy\b`;
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
  // DEQUOTED as well as raw, for the same reason detection is (#1995 r16).
  // `wrang"ler" deploy` appended to an allowlisted sentence is a real command
  // that the dequoted detector flags — and this residue test, reading raw
  // text only, saw no command left and exempted the whole line, cancelling the
  // detection. An exemption is only sound if it looks for everything detection
  // looks for, in every spelling detection accepts.
  const deploysLeft =
    new RegExp(ANY_DEPLOY_RE).test(rest) || new RegExp(ANY_DEPLOY_RE).test(dequote(rest));
  return deploysLeft ? null : hits.map((h) => h.why).join(' ');
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
    // `<(` and `>(` open a PROCESS SUBSTITUTION, not a redirection. Stripping
    // the bare operator ate `(echo` as its operand and left the substitution's
    // remaining words standing as real arguments — so a `--keep-vars` written
    // inside one blessed a bare deploy (#1995 r16). The lookahead is on the
    // single-character alternatives only; no multi-character operator can be
    // followed by `(` in that sense.
    //
    // Adding it to the multi-character operators as well is an EQUIVALENT
    // MUTANT, recorded as one rather than fixtured: whichever operator the
    // lookahead refuses, the alternation matches a shorter one at the same
    // position and the strip happens anyway. Measured over ten shapes —
    // `<<<(`, `>>(`, `<<(`, `2>(`, here-docs and plain redirects — and the
    // narrow and wide forms produced identical output on all ten.
    /(?:&>>|&>|\d?(?:<<<|<<|<>|>>|>&|<&|>(?!\()|<(?!\()))\s*&?\s*(?:"[^"]*"|'[^']*'|[^\s"';&|)]+)/g,
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
 * Replaced with a placeholder DISTINCT from the one
 * `stripOtherOptionValues` leaves behind, and that distinction is the whole
 * point (#1995 r16). Both are single characters, so neither manufactures a
 * token boundary the shell did not see — but one is INERT (another option's
 * value, which cannot be an option) and the other is OPAQUE (text that can
 * expand to anything, including a negation of the flag being scored). Sharing
 * `\u0000` made them indistinguishable and the opaque one was read as inert.
 */
function stripCommandSubstitutions(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      out += text[i] + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    // `<( … )` and `>( … )` are PROCESS substitutions. They are as opaque as
    // `$( … )` — the shell hands the command a `/dev/fd` path, never the text
    // inside — but only `$(` was blanked, so safety-looking words inside one
    // were scored as if they were arguments (#1995 r16). Same walk, same
    // placeholder; only the opener differs.
    if ((text[i] === '<' || text[i] === '>') && text[i + 1] === '(') {
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
      out += '\u0001';
      i = j - 1;
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
      out += '\u0001';
      i = j - 1;
      continue;
    }
    out += text[i];
  }
  return out;
}

/**
 * Expand a STATIC brace group attached to an option word.
 *
 * `--{,no-}keep-vars` is one written token that Bash hands the command as two
 * arguments, `--keep-vars --no-keep-vars`, so the deploy is destructive — but
 * the literal text spells neither, and every spelling test read it as
 * unrelated and blessed the deploy (#1995 r16).
 *
 * Narrow on purpose. The word must START with a dash and the alternatives must
 * be literal, so nothing here touches the JSON, YAML and JavaScript braces that
 * fill the files this guard walks, nor the `{ builtin cd x; }` group form
 * (space after the brace, and the word does not begin with a dash).
 */
function expandOptionBraces(text) {
  return text.replace(
    /(?<![^\s(`'"])(-{1,2}[A-Za-z0-9-]*)\{([A-Za-z0-9_,.=/-]*)\}([A-Za-z0-9_.=/-]*)/g,
    (_whole, pre, body, post) =>
      body
        .split(',')
        .map((alt) => `${pre}${alt}${post}`)
        .join(' '),
  );
}

/**
 * Offsets of text that can expand to ANYTHING — including a negation.
 *
 * Command substitutions and parameter expansions are not decidable from the
 * source, and the guard has always said so for the case where they DELETE a
 * safety flag. The other direction was missed: `--keep-vars $(printf %s
 * --no-keep-vars)` and `FLAG=--no-keep-vars … deploy "$FLAG"` both leave a
 * literal `--keep-vars` standing as the last thing the scorer can see, and
 * both were blessed (#1995 r16).
 *
 * Reported as POSITIONS so the caller can order them against the flag events
 * it already collects: an opaque word before the last literal occurrence is
 * harmless, because the literal is what the CLI reads last.
 *
 * Single-quoted text is skipped — it expands to itself. Double-quoted text is
 * NOT, because `"$FLAG"` is a live expansion. Backticks are deliberately not
 * treated as substitutions here, the same recorded limit
 * `stripCommandSubstitutions` carries: this predicate also runs on prose,
 * where a backtick opens a Markdown code span around the command being judged.
 */
function opaqueOffsets(line) {
  const out = [];
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (c === '"') {
        q = null;
        continue;
      }
    } else if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === '\u0001') out.push(i);
    else if (c === '$' && /[A-Za-z_{(]/.test(line[i + 1] ?? '')) out.push(i);
  }
  return out;
}

/**
 * Every spelling of one option that the CLI answers to.
 *
 * yargs — which wrangler uses — accepts the camel-case form of any kebab-case
 * option, so `--no-keepVars` really does set `keepVars:false` (confirmed
 * against the pinned 4.90.0). The scorer knew only the kebab spelling, so the
 * camel one read as unrelated text and left an earlier `--keep-vars` standing
 * (#1995 r16). The `no-` prefix stays kebab: yargs strips it before
 * camel-casing what remains.
 */
function flagSpellings(name) {
  const m = /^--(no-)?(.+)$/.exec(name);
  if (!m) return [name];
  const [, neg = '', rest] = m;
  const camel = rest.replace(/-([a-z0-9])/g, (_c, ch) => ch.toUpperCase());
  return camel === rest ? [name] : [name, `--${neg}${camel}`];
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

/** Quote-tolerant pattern matching EVERY spelling the CLI accepts. */
function flagPattern(name) {
  return `(?:${flagSpellings(name).map(quoteTolerant).join('|')})`;
}

/** The `--no-` negation of an option name. */
function negationOf(flag) {
  return `--no-${flag.replace(/^--/, '')}`;
}

function flagEnabled(rawLine, flag) {
  // `executedCommand` FIRST (#1995 r6). A leading environment assignment is
  // passed through the ENVIRONMENT, never as an argument, so
  // `NOTE="--keep-vars" wrangler deploy` is a bare, destructive deploy — but
  // the flag was read out of the assignment's quoted value and BLESSED it.
  // This is the r40 `run deploy` case and the r4 `--name` case in a third
  // spelling. Both of those were fixed at their own call site, which is why
  // this one survived: the SAFETY predicate had never been asked the question.
  // Brace expansion happens BEFORE the shell looks at anything else, so it
  // happens before this pipeline too: `--{,no-}keep-vars` has to have become
  // two arguments by the time any of the strippers or the scorer sees it.
  const line = stripOtherOptionValues(
    executedCommand(
      stripCommandSubstitutions(
        stripRedirections(normalizeFlagEquals(expandOptionBraces(rawLine))),
      ),
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
  const flagRe = flagPattern(flag);
  const re = new RegExp(
    `(?<![^\\s(\`'"])${flagRe}(?:=((?:"[^"]*"|'[^']*'|[^\\s"'\`)\\u0000\\u0001]+)+)` +
      `|\\s+(?:"([^"]*)"|'([^']*)'|((?![-#])[^\\s"'\`)\\u0000\\u0001]+)))?`,
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
    const separated = m[2] ?? m[3] ?? m[4];
    // `wrangler deploy [script]` takes a POSITIONAL entrypoint, and
    // `--keep-vars` is a boolean. `wrangler deploy --keep-vars
    // apps/agent/src/index.ts` therefore passes the path as the script, not as
    // the flag's value — but the separated branch consumed it and, under the
    // true-only rule, scored the flag OFF. A correct, explicit-entrypoint
    // deploy was reported as destructive (#1995 r16), which is a false red.
    //
    // Only a boolean LITERAL is taken as a separated value; anything else is a
    // positional and leaves the flag bare, i.e. enabled. This does not touch
    // the ATTACHED form, where `--keep-vars=yes` and `=garbage` really are
    // values and really are false (r28) — the two forms have needed different
    // rules since r29 and this is the same distinction again.
    const value =
      attached ??
      (separated !== undefined && /^(?:true|false|1|0)$/i.test(separated.trim())
        ? separated
        : undefined);
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
    `(?<![^\\s(\`'"])${flagPattern(negationOf(flag))}(?![\\w-])`,
    'g',
  );
  for (const m of line.matchAll(negRe)) events.push({ at: m.index, on: false });
  // Text that can expand to anything is an event too, and it disables — not
  // because it necessarily negates, but because after it the final state is
  // UNKNOWN, and a safety predicate cannot report unknown as safe. Ordered
  // with the literals, so an opaque word BEFORE the last real occurrence
  // changes nothing: the literal is still what the CLI reads last.
  for (const at of opaqueOffsets(line)) events.push({ at, on: false, opaque: true });
  // Every event opaque means the flag was never mentioned at all, which is the
  // same "not enabled" this returns for an empty line — but going through the
  // sort would have said so for the wrong reason.
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

/**
 * `--help` / `-h` prints usage and uploads nothing.
 *
 * The pinned wrangler documents `-h, --help  Show help [boolean]` and exits
 * without building. Reporting `wrangler deploy --help` as destructive blocks
 * the unfiltered CI job over a command that deploys nothing (#1995 r16) —
 * a false red, and the credibility of a guard is spent on those.
 *
 * Before the option TERMINATOR only, for the same reason the selector reader
 * stops there: what follows `--` is not an option wrangler acts on. And scored
 * through `flagEnabled` rather than by substring, so `--help=false` and a
 * `--message="see --help"` are read the way the CLI reads them.
 */
function isHelpInvocation(cmd) {
  const upTo = cmd.replace(
    /(\bwrangler2?(?:@\S+)?\b[^\n]*?\b(?:deploy|versions\s+upload)\b[\s\S]*?)\s--(?=\s|$)[\s\S]*$/,
    '$1',
  );
  return flagEnabled(upTo, '--help') || flagEnabled(upTo, '-h');
}

function commandIsSafe(cmd) {
  if (isHelpInvocation(cmd)) return true;
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
        `\\s+(?:${RUN_ALIASES})(?:\\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\\s-][^\\s]*)?)*\\s+deploy\\b([\\s\\S]*)$`,
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
  return !appendedTurnsOff(appended, '--keep-vars');
}

/**
 * Does what a package script had appended to it turn the safety flag off?
 *
 * The script itself passes `--keep-vars`, so anything appended arrives after
 * it and the CLI takes the last occurrence. The question is therefore narrow,
 * and it is asked narrowly ON PURPOSE: the older form handed the whole
 * appended text to `flagEnabled` as if it were the flag's own value, which is
 * right for argv and wrong for prose, where "`pnpm … run deploy`, whose …"
 * made `,` the value and produced four false reds on the real tree.
 *
 * What replaced it — "does this text spell keep-vars?" — was narrow in the
 * wrong dimension. A spelling test is only sound over text that is decidable,
 * and five different shell constructs can hand wrangler `--no-keep-vars`
 * without spelling it: quotes, a variable, a command substitution, a brace
 * group, and yargs' camel-case form (#1995 r16, five separate reports of one
 * defect). Quotes, braces and camel-case are decidable and are now decided;
 * the two that are not are answered with "cannot prove it survives", which is
 * the side a safety predicate errs on.
 */
function appendedTurnsOff(appended, flag) {
  const text = expandOptionBraces(appended);
  // The same neutralisation the scorer runs, so an opaque word inside ANOTHER
  // option's value — `--var "SHA:$COMMIT"` — is gone before opacity is judged.
  // It cannot introduce an argument, so it must not be read as if it could.
  const scored = stripOtherOptionValues(
    stripCommandSubstitutions(stripRedirections(normalizeFlagEquals(text))),
  );
  if (opaqueOffsets(scored).length > 0) return true;
  const mentions = new RegExp(`${flagPattern(flag)}|${flagPattern(negationOf(flag))}`);
  if (!mentions.test(scored)) return false;
  return !flagEnabled(text, flag);
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
function manifestDeps(dir) {
  if (!workspaceDepsCache.has(dir)) {
    let names = [];
    try {
      const m = JSON.parse(readFileSync(`${REPO_ROOT}/${dir}/package.json`, 'utf8'));
      names = [
        ...Object.keys(m.dependencies ?? {}),
        ...Object.keys(m.devDependencies ?? {}),
        ...Object.keys(m.peerDependencies ?? {}),
      ];
    } catch {
      names = [];
    }
    workspaceDepsCache.set(dir, names);
  }
  return workspaceDepsCache.get(dir);
}

/**
 * Every workspace package's name and declared dependencies.
 *
 * Needed because `...<pattern>` is DIRECT AND INDIRECT — pnpm's own wording.
 * A one-level read answered the direct question correctly and silently missed
 * the transitive one: with `apps/agent -> @vaipakam/contracts -> @vaipakam/lib`,
 * `--filter '...@vaipakam/lib'` selects the agent, and the guard saw only the
 * agent's own manifest and resolved the selector to nothing (#1995 r16).
 *
 * Built from the conventional workspace roots rather than from
 * `pnpm-workspace.yaml`, which would need a YAML parse for two directory
 * names. A package outside them is simply absent from the graph, which costs a
 * transitive edge and never invents one.
 */
let workspaceIndexCache = null;
function workspaceIndex() {
  if (workspaceIndexCache) return workspaceIndexCache;
  const byName = new Map();
  for (const root of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(`${REPO_ROOT}/${root}`);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      try {
        const m = JSON.parse(
          readFileSync(`${REPO_ROOT}/${root}/${e}/package.json`, 'utf8'),
        );
        if (m.name) byName.set(m.name, manifestDeps(`${root}/${e}`));
      } catch {
        /* not a package */
      }
    }
  }
  workspaceIndexCache = byName;
  return byName;
}

/**
 * Workspace dependency names a scoped package reaches, DIRECTLY OR NOT.
 *
 * Resolved from the manifests rather than guessed. The conservative
 * alternative — attributing every `...` selector to every scoped package —
 * would report the keeper for `...@vaipakam/agent`, which is a false red unless
 * the keeper really does depend on the agent.
 */
function scopedWorkspaceDeps(sc) {
  const index = workspaceIndex();
  const seen = new Set();
  const queue = [...manifestDeps(sc.dir)];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    // Only WORKSPACE packages have edges to follow; a registry dependency is a
    // leaf. A cycle terminates on `seen`, which pnpm's own graph may contain.
    for (const next of index.get(name) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return [...seen];
}

/**
 * A fan-out flag counts only when it is ENABLED.
 *
 * `pnpm --recursive=false run --if-present deploy` runs no workspace script at
 * all, and `npm --workspaces=false` likewise — but a bare presence test read
 * both as "every package" and failed CI on a command that deploys nothing
 * (#1995 r16). Same shape, and the same last-occurrence rule, as the safety
 * flag's own scoring; the difference is that being wrong here produces a false
 * RED rather than a false green, which is the failure mode that gets a guard
 * switched off.
 */
function fanOutEnabled(line, spellings) {
  let on = false;
  for (const m of line.matchAll(
    new RegExp(`(?<![\\w-])(?:${spellings})(?:=(\\S*))?(?=[\\s;&|]|$)`, 'g'),
  )) {
    on = m[1] === undefined || /^(true|1)$/i.test(m[1]);
  }
  return on;
}

function filterScopes(rawLine) {
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
  // Neutralise OTHER options' values before scanning, exactly as
  // `selectorScope` does — keeping our own. A forwarded wrangler string
  // carrying filter-like text (`--message="--filter !@vaipakam/agent"`) parsed
  // as a real selector and SUBTRACTED the package the command actually deploys
  // (#1995 r16). The same defect `selectorScope` was fixed for at r3, in the
  // one selector reader that had not been asked the question.
  // EVERY option this function goes on to read must be kept, fan-out flags
  // included. `selectorScope`'s own comment warns that the keep list and the
  // readers "are two halves of one decision and drift silently, because a
  // missing entry looks exactly like an option that was not present" — and
  // omitting the fan-out spellings here proved it immediately: `npm
  // --workspaces run deploy` had `--workspaces run` swallowed as an
  // option-and-value, so a command that deploys EVERY package read as naming
  // none. Caught by a control probe, not by the finding being fixed.
  const line = stripOtherOptionValues(rawLine, [
    'filter',
    'filter-prod',
    'F',
    'recursive',
    'workspaces',
  ]);
  const included = new Set();
  const excluded = new Set();
  let sawSelector = false;
  let sawPositive = false;
  // A selector that is REAL but cannot be resolved from the text is not an
  // empty selection. Those had the same spelling, so `--filter .` — which pnpm
  // documents as the packages under the CWD — came out as "selects nothing",
  // authoritatively, and suppressed the cwd scope that would have named the
  // package (#1995 r16). Deferring hands the question to the modelled or
  // stated directory, which is the thing that actually answers it.
  let unresolved = false;
  // `-r` / `--recursive` runs the script in EVERY workspace package, naming
  // none of them, so no textual, filter or cwd signal exists at all (#1995 r8).
  //
  // pnpm spells the same thing as a COMMAND as well as an option: `pnpm help
  // recursive` documents `recursive`, `multi` and `m` as running an action
  // across every package (#1995 r9). r8 added the option spellings and stopped
  // there, so `pnpm recursive --if-present run deploy --no-keep-vars` — every
  // protected Worker, destructively — passed the guard.
  if (
    fanOutEnabled(line, '-r|--recursive') ||
    /(?:^|\s)pnpm\s+(?:recursive|multi|m)(?:\s|$)/.test(line) ||
    // npm's spelling of the same fan-out: `npm run --help` documents
    // `[--workspaces]`, with `-ws` as its shorthand (#1995 r10).
    fanOutEnabled(line, '--workspaces|-ws')
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
    // `\}` and not `\}$`: the brace may be followed by a changed-since suffix
    // (`{apps/agent}[HEAD~100]`), and an end-anchored strip left the closing
    // brace embedded in the pattern (#1995 r16).
    pat = pat.replace(/^\{|\}(?=\[|$)/g, '').replace(/^\.\//, '').replace(/\/+$/, '');
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
    // The changed-since suffix COMPOSES with a directory selector — pnpm
    // documents the shape as `{}[]` — and only the standalone `[]`
    // form was handled, so `{apps/agent}[HEAD~100]` fell through to the glob
    // test, matched nothing, and became an authoritative empty scope (#1995
    // r16). The suffix only ever NARROWS what the prefix selects, so
    // attributing the prefix's packages is the conservative reading.
    const since = pat.match(/^(.*)\[[^\]]*\]$/);
    if (since) {
      pat = since[1];
      // `{}[]` with nothing but a ref left is the standalone form again.
      if (pat === '') {
        sawPositive = true;
        for (const sc of SCOPED) included.add(sc);
        continue;
      }
    }
    // `.` and `./` select the packages UNDER THE CURRENT DIRECTORY, which the
    // selector text cannot name. Real, and unresolvable — not empty.
    if (pat === '' || pat === '.') {
      sawSelector = true;
      unresolved = true;
      continue;
    }
    const re = new RegExp(
      `^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    // A positive LITERAL is a real selection and is resolved here now. It used
    // to be skipped as "handled by scopeOf", which was true while selections
    // were only ever added — but a negation has to subtract from something.
    // pnpm matches an UNSCOPED name against the scoped package: `--filter
    // agent` selects `@vaipakam/agent`, which its own help documents with the
    // example `foo`. Comparing only the full name resolved the selection to an
    // authoritative empty and suppressed every other source of scope (#1995
    // r16).
    const direct = SCOPED.filter(
      (sc) => re.test(isDir ? sc.dir : sc.filter) || (!isDir && re.test(sc.filter.replace(/^@[^/]+\//, ''))),
    );
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
  if (!sawSelector || unresolved) return null;
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
    return kept ? `${UNKNOWN_DIR}/${kept}` : UNKNOWN_DIR;
  }
  // `CDPATH` is bash's search path for a RELATIVE `cd` target, per `help cd`:
  // `CDPATH=apps` then `cd agent` enters `apps/agent`. Resolving the target
  // only against the modelled cwd recorded a directory called `agent`, which
  // matches no package, so the bare deploy under it passed (#1995 r16).
  //
  // Statically known values only, the same rule every other expansion here
  // follows, and only when the entry actually lands on a SCOPED package —
  // a search path that resolves somewhere unremarkable changes nothing, and
  // guessing at one would invent scope rather than find it. A target that
  // begins with `/`, `.` or `..` is not searched, which is bash's own rule.
  //
  // That condition is an EQUIVALENT MUTANT, recorded as one rather than
  // fixtured: a candidate carrying a `./` or `../` segment cannot match a
  // scoped directory, which is stored normalised, so removing it changes no
  // verdict. Measured over twelve CDPATH/target pairs mixing absolute,
  // dot-relative, hidden and multi-entry forms; all twelve agreed. Kept
  // because it states bash's rule where a reader looks for it.
  //
  // The scoped-package condition below is NOT equivalent, and the same
  // measurement is what told them apart: it makes the loop keep SEARCHING past
  // an entry that matches nothing, so `CDPATH=vendor:apps` still finds the
  // agent. That case is fixtured.
  if (vars && !/^[/.]/.test(target)) {
    const cdpath = vars.get('CDPATH');
    if (cdpath && !/\$/.test(cdpath)) {
      for (const entry of cdpath.split(':')) {
        if (!entry || /^[/.]/.test(entry)) continue;
        const candidate = `${entry.replace(/\/+$/, '')}/${target}`;
        if (SCOPED.some((sc) => candidate === sc.dir || candidate.startsWith(`${sc.dir}/`))) {
          return candidate;
        }
      }
    }
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
function selectorScope(seg, states, hasCwdState = true, vars = null) {
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
  )
    // Everything after WRANGLER's `--` is inert. Verified against 4.90.0:
    // `wrangler deploy --dry-run -- --name vaipakam-indexer` still processed
    // the local configuration, so the trailing `--name` names nothing — yet it
    // was read as an authoritative selector and suppressed the cwd scope of a
    // live agent deploy (#1995 r16).
    //
    // Anchored AFTER the deploy verb on purpose, because `--` does not mean
    // the same thing everywhere on the line. pnpm's own `--` FORWARDS to
    // wrangler, and this function must keep reading past it: r9 established
    // that `pnpm --dir ../agent run deploy -- --cwd .` chains, the package
    // manager moving first and wrangler starting where it was left.
    // Anchored on WRANGLER's own invocation, not on the verb. `deploy` is also
    // the name of the package SCRIPT, and the two `--`s mean opposite things:
    // pnpm CONSUMES its own and appends what follows to the script's arguments
    // (so `pnpm --dir apps/agent run deploy -- --cwd .` leaves `--cwd` LIVE,
    // which is r9's chaining), while wrangler PASSES its own through and makes
    // everything after it inert. Keying on the verb alone would cut at the
    // first of those and silently un-do r9. Both directions are fixtured.
    .replace(
      /(\bwrangler2?(?:@\S+)?\b[^\n]*?\b(?:deploy|versions\s+upload)\b[\s\S]*?)\s--(?=\s|$)[\s\S]*$/,
      '$1',
    );
  // `--config` before `-c` so the long spelling wins the alternation, and a
  // lookbehind so `-c` cannot match inside `--config` or at the tail of another
  // token. `-c` is wrangler's DOCUMENTED alias (4.90.0: "-c, --config  Path to
  // Wrangler configuration file"); `--cwd` and `--name` have none.
  const valueOf = (spellings) => {
    // LAST occurrence, because that is what the CLIs do — the same rule the
    // safety flag is scored by. `pnpm --dir apps/indexer --dir apps/agent run
    // deploy` runs the AGENT script (confirmed against the pinned pnpm), and
    // taking the first match handed the guard an out-of-scope directory and
    // blessed a destructive deploy (#1995 r16).
    const all = [...clean.matchAll(new RegExp(`(?<![\\w-])(?:${spellings})(?:=|\\s+)${VALUE}`, 'g'))];
    const m = all[all.length - 1];
    if (!m) return null;
    // Quotes are removed and BACKSLASH ESCAPES decoded: the shell hands wrangler
    // `vaipakam-agent` for `vaipakam\\-agent`, and comparing the escaped form
    // made it an authoritative non-match (#1995 r5).
    return m[1].replace(/\\([\s\S])/g, '$1').replace(/["'`]/g, '');
  };
  /**
   * A value we cannot resolve carries no information — treat it as absent.
   *
   * But a variable assigned a LITERAL earlier in the same block IS resolvable,
   * and `resolveDir` has carried those for directory targets since r8. The
   * selector readers did not, so `NAME=vaipakam-agent` followed by `wrangler
   * deploy --name "$NAME"` deployed the protected agent while the guard
   * treated the selector as unknown and found no other scope (#1995 r16) —
   * the same incoherent pair r8 named: resolvable one way and not the other.
   */
  const known = (v) => {
    if (v === null) return null;
    const expanded =
      vars && /\$/.test(v)
        ? v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => vars.get(name) ?? m)
        : v;
    return /\$/.test(expanded) ? null : expanded;
  };

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

/**
 * A destination the scanner cannot name. Matches nothing in `scopeOfCwd`
 * except through a static SUFFIX, so a deploy that runs there is attributed to
 * no package — which is the honest answer when the shell has been sent
 * somewhere the text does not say.
 */
const UNKNOWN_DIR = '\u0000unknown';

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
  // `popd +N` / `popd -N` / `popd -n` remove a stack ENTRY and, per bash's
  // `help popd`, only the no-argument form changes directory. Collapsing every
  // spelling onto the top-pop transition moved the model somewhere the shell
  // never went: `pushd apps/indexer; pushd ../agent; popd +1; wrangler deploy`
  // still runs in the AGENT while the guard had walked to the indexer (#1995
  // r16).
  //
  // Recorded limit: the stack is left as-is rather than having the indexed
  // entry removed. The index is what decides scope only through a LATER popd,
  // and modelling a wrong removal is not better than modelling none.
  if (dir.kind === 'popd-keep') return state;
  // The stack gains the directory; the shell does not move. In bash's own
  // ordering the new entry sits directly below the current directory, which is
  // the END of `state.stack` here — `stack` is oldest-first and `popd` reads
  // its last element.
  if (dir.kind === 'pushd-stack') {
    return {
      cwd: state.cwd,
      stack: [...state.stack, resolveDir(state.cwd, dir.target, vars)],
      prev: state.prev,
    };
  }
  // `pushd` with no arguments EXCHANGES the top two directories (bash's `help
  // pushd`), so it is a move even though it names no destination — and one
  // that walks BACK into a package the shell had left. It was ignored
  // entirely, so `pushd apps/agent; pushd ../indexer; cd ../www; pushd;
  // wrangler deploy` deployed the agent while the guard stood in www (#1995
  // r16). With an empty stack bash errors and stays put.
  // The directory STACK as bash presents it: the current directory is entry 0
  // and the saved ones follow, most recent first. `state.stack` holds the same
  // set oldest-first, which is why this reverses.
  if (dir.kind === 'pushd-rotate') {
    const ds = [state.cwd, ...[...state.stack].reverse()];
    const idx = dir.sign === '+' ? dir.n : ds.length - 1 - dir.n;
    if (idx <= 0 || idx >= ds.length) return state;
    const rotated = [...ds.slice(idx), ...ds.slice(0, idx)];
    return {
      cwd: rotated[0],
      stack: [...rotated.slice(1)].reverse(),
      prev: state.cwd,
    };
  }
  if (dir.kind === 'pushd-swap') {
    return state.stack.length > 0
      ? {
          cwd: state.stack[state.stack.length - 1],
          stack: [...state.stack.slice(0, -1), state.cwd],
          prev: state.cwd,
        }
      : state;
  }
  // `cd` with no argument goes to `$HOME`, and `cd ~…` starts there — neither
  // of which the text names. Ignoring them held the OLD cwd over a deploy that
  // runs elsewhere, which reported the wrong package rather than the right one
  // (#1995 r16). An unknown destination is the existing answer for an
  // unresolved variable; this is the same question in another spelling.
  if (dir.kind === 'cd-home') {
    return { cwd: UNKNOWN_DIR, stack: state.stack, prev: state.cwd };
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
  // `then` / `do` / `else` open the BODY of a compound command, and the body
  // runs in the current shell like any other command. `splitCommands` hands
  // this function the segment `then cd "$TARGET"`, and a prefix that admitted
  // only braces and the two builtins did not recognise it — so `if true; then
  // cd "$TARGET"; wrangler deploy; fi` moved the shell into the agent while
  // the model stayed at the root (#1995 r16). The same shape as the r14
  // `builtin`/`command` fix and the r12 brace-group fix: a word in front of
  // `cd` that does not stop `cd` from running.
  const LEAD = String.raw`(?:(?:then|do|else)\s+)*(?:\{\s+)?(?:(?:builtin|command)\s+)?`;
  // `pushd +N` / `-N` ROTATES the stack so that entry becomes current; it is
  // not a destination, and it must be tested BEFORE the destination match or
  // that match claims `+1` as a directory name — which is what it did, so my
  // first cut of this fix changed nothing at all. Falling through modelled a
  // directory literally named `+1` (#1995 r16). `-n` suppresses the change of
  // directory altogether.
  const rot = seg.match(new RegExp(`^${LEAD}pushd\\s+([+-])(\\d+)\\s*$`));
  if (rot) return { kind: 'pushd-rotate', sign: rot[1], n: Number(rot[2]) };
  // `pushd -n <dir>` pushes the directory onto the stack and suppresses the
  // change of directory. Modelling it as "nothing happened" was wrong in the
  // other direction: a later `popd` then went somewhere the shell would not.
  const pushNoCd = seg.match(new RegExp(`^${LEAD}pushd\\s+-n\\s+${OPTS}(${WORD})`));
  if (pushNoCd) return { kind: 'pushd-stack', target: dequote(pushNoCd[1]) };
  if (new RegExp(`^${LEAD}pushd\\s+-n\\s*$`).test(seg)) return { kind: 'popd-keep' };
  const pushed = seg.match(new RegExp(`^${LEAD}pushd\\s+${OPTS}(${WORD})`));
  if (pushed) return { kind: 'pushd', target: dequote(pushed[1]) };
  // Ordered AFTER the destination form, so only a genuinely bare `pushd`
  // reaches the swap. `-n` and `+N` take no destination either and are not
  // swaps, so they are excluded by name rather than by the absence of a word.
  if (new RegExp(`^${LEAD}pushd\\s*$`).test(seg)) return { kind: 'pushd-swap' };
  const popped = seg.match(new RegExp(`^${LEAD}popd\\b(.*)$`));
  if (popped) {
    const args = popped[1].trim();
    // `+0` IS the top of the stack, so it is the ordinary pop.
    const idx = /^\+0\b/.test(args);
    return args === '' || idx ? { kind: 'popd' } : { kind: 'popd-keep' };
  }
  // WINDOWS shells. The `shell:` allow-list admits `pwsh` and `cmd`, and their
  // bodies were then handed to a scanner that understands only `cd`/`pushd` —
  // so `Set-Location apps/agent` moved nothing in the model and the bare deploy
  // under it passed (#1995 r16, on the r16 allow-list itself). Admitting the
  // interpreters without teaching the model their directory commands widened
  // what is scanned without widening what is understood.
  //
  // The names are unambiguous — no POSIX utility is called `Set-Location` — and
  // the BACKSLASH conversion is scoped to exactly these commands. `\` is an
  // escape in bash, so `cd apps\agent` really is `appsagent` there; it is a
  // separator only where the command itself is Windows-specific, which is why
  // the conversion happens here and not in `dequote`.
  const winCd = seg.match(
    new RegExp(`^${LEAD}(?:Set-Location|Push-Location|chdir|sl)\\s+(?:-Path\\s+)?(${WORD})`, 'i'),
  );
  if (winCd) {
    const target = dequote(winCd[1].replace(/\\/g, '/'));
    return /^~/.test(target)
      ? { kind: 'cd-home' }
      : { kind: /Push-Location/i.test(seg) ? 'pushd' : 'cd', target };
  }
  if (new RegExp(`^${LEAD}Pop-Location\\b`, 'i').test(seg)) return { kind: 'popd' };
  // `cd /d <dir>` is cmd's drive-and-directory form; `/d` is an option, not the
  // destination, and its path uses backslashes.
  const cmdCd = seg.match(new RegExp(`^${LEAD}cd\\s+/[dD]\\s+(${WORD})`));
  if (cmdCd) return { kind: 'cd', target: dequote(cmdCd[1].replace(/\\/g, '/')) };
  const cd = seg.match(new RegExp(`^${LEAD}cd\\s+${OPTS}(${WORD})`));
  if (cd) {
    const target = dequote(cd[1]);
    // `~` and `~/…` are `$HOME` and a path under it. `cd "$HOME"` already
    // resolved to an unknown destination through the variable rule; the tilde
    // spelling reached `resolveDir` as a literal directory named `~`.
    return /^~/.test(target) ? { kind: 'cd-home' } : { kind: 'cd', target };
  }
  // Ordered last for the same reason as the pushd swap: a `cd` naming a
  // destination is handled above, so what is left really is the bare form.
  // The option terminator is consumed, or `cd --` reads as a destination.
  return new RegExp(`^${LEAD}cd\\s*(?:--\\s*)?$`).test(seg) ? { kind: 'cd-home' } : null;
}

/**
 * Dedupe reachable states, and CAP them. The cap is a runaway guard only: a
 * line would need dozens of `||`-chained `cd`s to approach it, and dropping the
 * tail can only lose scope, never invent it.
 */
function dedupeStates(states) {
  const seen = new Map();
  // PROTECTED states first. The cap is a runaway guard, but it was applied in
  // ARRIVAL order, so a long `||` chain of failing `cd`s could fill it with
  // thirty-two irrelevant directories and drop the one scoped destination that
  // arrives last — the only state that decides anything (#1995 r16). Ordering
  // by relevance keeps the guard's purpose (bounded work) while removing its
  // ability to lose the answer. Dropping the tail can still only lose an
  // unprotected state, which is what the original note claimed for all of
  // them and was true of none.
  for (const pass of [true, false]) {
    for (const st of states) {
      if ((scopeOfCwd(st.cwd) !== null) !== pass) continue;
      // `prev` is part of the state: two states with the same cwd but different
      // OLDPWD diverge on the next `cd -` (#1995 r14).
      const key = `${st.cwd}\u0000${st.stack.join('/')}\u0000${st.prev ?? ''}`;
      if (!seen.has(key)) seen.set(key, st);
      if (seen.size >= 32) break;
    }
    if (seen.size >= 32) break;
  }
  return [...seen.values()];
}

/**
 * Remove the `$` prompt a runbook writes in front of a copyable command.
 *
 * ```console` is an accepted fence, and a prompted block is exactly the form an
 * operator copies and runs. But the directive matchers are `^`-anchored, so
 * `$ cd apps/agent` recorded no move and the `$ wrangler deploy` under it was
 * judged from the repo root — a directly copyable destructive deploy that
 * exited 0 (#1995 r16). Detection itself was never anchored, which is why only
 * the SCOPE was lost and not the command.
 *
 * `$` only, never `#`. A root prompt is indistinguishable from a comment, and
 * this guard walks docs full of `# wrangler deploy` written as commentary;
 * reading those as commands would flag documentation that runs nothing. A
 * missed root-prompted example is a recorded limit — inventing commands out of
 * comments would be a new false-red class.
 *
 * The `$` must be followed by whitespace, so no real shell word can match:
 * `$FOO` and `$(cmd)` have no space after the sigil.
 */
function stripConsolePrompts(blockLines) {
  return blockLines.map((l) => l.replace(/^(\s*)\$[ \t]+/, '$1'));
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
        out.push(
          ...offset(
            logicalLines(stripConsolePrompts(lines.slice(start, j)).join('\n')),
            start,
            blockId,
          ),
        );
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
      // A step that names a NON-SHELL interpreter does not execute shell, and
      // feeding its body to the scanner reported `print("wrangler deploy")` as
      // a live deploy (#1995 r16). Checked at each of the three ingest points
      // rather than inside the scanner, because it is a property of the STEP.
      if (!isYaml || stepIsShell(lines, i)) {
        out.push(
          ...offset(logicalLines(body), start, blockId, isYaml ? workingDirFor(lines, i) : ''),
        );
        blockId += 1;
      }
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
      if (end === i && isYaml && stepIsShell(lines, i)) {
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
        if (!isYaml || stepIsShell(lines, i)) {
          out.push(
            ...offset(
              logicalLines(foldFlowScalar(parts, q)),
              i,
              blockId,
              isYaml ? workingDirFor(lines, i) : '',
            ),
          );
          blockId += 1;
        }
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
/**
 * The first match of `re` among a step's OWN metadata keys.
 *
 * Extracted so "read a step's metadata" has ONE implementation. It grew a
 * depth rule at r16 — a heredoc line that happens to read like Actions
 * metadata is not Actions metadata — and a second copy of the walk would have
 * been a place for that rule to go missing.
 */
/**
 * The line range of the step containing `runIdx`, and the column its own keys
 * sit at. One implementation, because three things now need it: the metadata
 * scan, the shell check, and `env` precedence.
 */
function stepBounds(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const runIndent = indentOf(lines[runIdx]);
  let start = runIdx;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) {
    if (lines[start].trim() !== '' && indentOf(lines[start]) < runIndent) break;
    start -= 1;
  }
  if (!/^\s*-\s/.test(lines[start])) return null;
  const stepIndent = indentOf(lines[start]);
  const keyIndent =
    stepIndent + (lines[start].slice(stepIndent).match(/^-\s*/)?.[0].length ?? 2);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    const ind = indentOf(lines[i]);
    if (ind < stepIndent || (ind === stepIndent && /^\s*-\s/.test(lines[i]))) {
      end = i;
      break;
    }
  }
  return { start, end, stepIndent, keyIndent };
}

/**
 * The line range of the JOB containing `runIdx`.
 *
 * Bounded by the job key and the next key at the same indent, the same rule
 * `workingDirFor` uses for `defaults:` — a job's `env` must not leak into a
 * later job any more than its `defaults` may.
 */
function jobBounds(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const jobsIdx = lines.findIndex((l) => /^\s*jobs:\s*$/.test(l));
  if (jobsIdx < 0 || runIdx <= jobsIdx) return null;
  const ji = indentOf(lines[jobsIdx]);
  let jobStart = -1;
  let jobIndent = -1;
  for (let i = jobsIdx + 1; i <= runIdx; i += 1) {
    if (lines[i].trim() === '') continue;
    const ind = indentOf(lines[i]);
    if (ind <= ji) break;
    if (jobIndent === -1) jobIndent = ind;
    if (ind === jobIndent && /^\s*(?:"[^"]*"|'[^']*'|[\w.-]+):\s*$/.test(lines[i])) jobStart = i;
  }
  if (jobStart < 0) return null;
  let jobEnd = lines.length;
  for (let i = jobStart + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && indentOf(lines[i]) <= jobIndent) {
      jobEnd = i;
      break;
    }
  }
  return { start: jobStart, end: jobEnd, indent: jobIndent };
}

function scanStepKeys(lines, runIdx, re) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const bounds = stepBounds(lines, runIdx);
  if (!bounds) return null;
  const { start, stepIndent } = bounds;
  // A step's own keys sit at the column the dash's first key opens. Scanning
  // every nested line let SHELL PAYLOAD stand in for Actions metadata: a
  // heredoc whose data happens to read `working-directory: apps/indexer`
  // overrode the real cwd and the agent deploy under it passed (#1995 r16).
  // Depth is what distinguishes a sibling key from text inside a value, and
  // the scan had no notion of it.
  const { keyIndent } = bounds;
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && lines[i].trim() !== '') {
      const ind = indentOf(lines[i]);
      if (ind < stepIndent || (ind === stepIndent && /^\s*-\s/.test(lines[i]))) break;
      if (ind !== keyIndent) continue;
    }
    const m = lines[i].match(re);
    if (m) return m;
  }
  return null;
}

/**
 * Whether a workflow step's body is executed by a SHELL at all.
 *
 * `shell: python` with `run: print("wrangler deploy")` prints a string and
 * deploys nothing, but the body went through the shell scanner and was
 * reported as a live deploy — a false red on a correct workflow, which is the
 * failure mode that gets a guard switched off (#1995 r16).
 *
 * Allow-list rather than deny-list: an unset `shell` is the runner's default
 * shell and must be scanned, and an unrecognised value is not known to be a
 * shell. Actions' documented shell keywords are the ones here; a custom
 * `command {0}` template names its own interpreter and is not among them.
 */
const SHELL_KEYWORDS = new Set(['bash', 'sh', 'pwsh', 'powershell', 'cmd']);
function stepIsShell(lines, runIdx) {
  const m = scanStepKeys(
    lines,
    runIdx,
    /^\s*(?:-\s+)?shell:\s*(?:"([^"]*)"|'([^']*)'|(\S+))/,
  );
  if (!m) return true;
  // Actions accepts a custom TEMPLATE — `bash -e {0}` — and the interpreter is
  // its first token. Comparing the whole scalar classified a quoted
  // `shell: "bash -e {0}"` as non-shell and skipped a real deploy (#1995 r16).
  // The unquoted spelling happened to work for the wrong reason: the `\S+`
  // alternative stopped at the space, so it captured `bash` by accident. Both
  // spellings take the first token now, deliberately.
  const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return SHELL_KEYWORDS.has(value.split(/\s+/)[0]);
}

function workingDirFor(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  // The unquoted alternative must admit an EXPRESSION: `${{ matrix.dir }}`
  // contains spaces, so `\S+` captured only `${{` (#1995 r11).
  // `(?:-\s+)?`: `- working-directory: apps/agent` as the FIRST key on a step's
  // dash line is ordinary Actions YAML, and an anchor that admitted only
  // leading whitespace could not see it — so the step had no scope and its
  // bare deploy passed. Found while probing the six reported cases; nobody
  // reported this one (#1995 r16).
  // The unquoted alternative admits an expression ANYWHERE in the value, not
  // only as the whole of it. `${{ matrix.dir }}` was handled at r11 by giving
  // the expression its own branch, which works exactly when the value IS the
  // expression — so `apps/${{ matrix.app }}`, the more ordinary spelling, had
  // `\S+` stop at the first space and captured `apps/${{` (#1995 r16).
  // Ordered expression-first so the braces' inner spaces are consumed by that
  // branch rather than ending the word.
  const WD =
    /^\s*(?:-\s+)?working-directory:\s*(?:"([^"]*)"|'([^']*)'|((?:\$\{\{[^}]*\}\}|[^\s])+))/;
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
  /**
   * Collapse `.`, `..` and repeated separators.
   *
   * `working-directory: apps/indexer/../agent` starts the runner in
   * `apps/agent`; storing the raw path meant `scopeOfCwd` could not recognise
   * it and a bare agent deploy passed (#1995 r16).
   *
   * A `..` that would climb above the repo root is kept rather than popping an
   * empty stack. That branch is an EQUIVALENT MUTANT and is recorded as one
   * instead of being fixtured: `scopeOfCwd` matches a package on a `/`
   * boundary ANYWHERE in the path, so `../apps/agent` and `apps/agent` reach
   * the same verdict. Checked against eleven paths mixing leading, interior and
   * root-crossing `..`, and the two forms agreed on all of them. It is kept
   * because it is the faithful normalisation — a caller that ever reads the
   * PATH rather than the verdict would need it — not because a test proves it.
   */
  const normalizePath = (raw) => {
    if (!raw || /\$/.test(raw)) return raw;
    const out = [];
    for (const part of raw.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  };

  /**
   * The declared values of a matrix key, in any of the three shapes Actions
   * accepts: an inline array, a block sequence, and `include:` entries.
   *
   * Only the inline array was read, so `include: [{ dir: apps/agent }]` — the
   * standard object form — resolved to nothing and its bare agent deploy
   * passed (#1995 r16).
   */
  const matrixValues = (key) => {
    const vals = [];
    for (let i = 0; i < lines.length; i += 1) {
      const inline = lines[i].match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`));
      if (inline) {
        vals.push(...inline[1].split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')));
        continue;
      }
      // Block sequence: `dir:` on its own line, values as `- x` beneath it.
      if (new RegExp(`^\\s*${key}:\\s*$`).test(lines[i])) {
        const di = (lines[i].match(/^\s*/) ?? [''])[0].length;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j].trim() === '') continue;
          const ind = (lines[j].match(/^\s*/) ?? [''])[0].length;
          if (ind <= di) break;
          const item = lines[j].match(/^\s*-\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/);
          if (item) vals.push(item[1] ?? item[2] ?? item[3]);
        }
        continue;
      }
      // `include:` entries carry the key as an ordinary mapping member, with or
      // without the leading dash on the same line.
      const inc = lines[i].match(
        new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`),
      );
      if (inc) vals.push(inc[1] ?? inc[2] ?? inc[3]);
      // FLOW-style mappings put the key mid-line: `include: [{ dir: apps/agent }]`
      // has no line beginning with `dir:`, so an anchored matcher recorded
      // nothing. The block form was added first and the flow form is the same
      // configuration written the other way — the identical omission the
      // `defaults:` reader had at r13 (#1995 r16).
      for (const fm of lines[i].matchAll(
        new RegExp(`[{,]\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}\\]]+))`, 'g'),
      )) {
        vals.push(fm[1] ?? fm[2] ?? fm[3]);
      }
    }
    return vals.filter(Boolean);
  };

  /**
   * An expression is not a literal directory (#1995 r11, widened at r16).
   *
   * `matrix.*` resolves against the declared legs: if any lands in a scoped
   * package that value is used; if the values are found and none do, the step
   * is genuinely out of scope; if they cannot be found at all, the expression
   * resolves to nothing rather than being taken literally — which is what
   * recorded `${{` as a directory name before.
   *
   * `env.*` is the same question with a different source, and it was left
   * whole: a workflow declaring `env: { DEPLOY_DIR: apps/agent }` ran its bare
   * deploy from the agent while `scopeOfCwd` matched nothing (#1995 r16).
   * Static declarations only — anything computed stays unresolved, the same
   * rule `shellVars` follows.
   */
  const resolveExpression = (raw) => {
    const em = raw.match(/\$\{\{\s*env\.([A-Za-z_][\w-]*)\s*\}\}/);
    if (em) {
      // Actions resolves `env` from the STEP, then the JOB, then the workflow,
      // and the nearer declaration wins. Scanning the whole file and taking the
      // first match ignored that entirely: a workflow-level value shadowed the
      // job-level override beneath it, so a step that really runs in the agent
      // was seeded with the indexer (#1995 r16, on the r16 fix itself).
      const step = stepBounds(lines, runIdx);
      const job = jobBounds(lines, runIdx);
      const ranges = [
        step && [step.start, step.end],
        job && [job.start, job.end],
        [0, lines.length],
      ].filter(Boolean);
      for (const [from, to] of ranges) {
        for (let i = from; i < to; i += 1) {
          const kv = lines[i].match(
            new RegExp(`^\\s*${em[1]}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`),
          );
          if (kv) return kv[1] ?? kv[2] ?? kv[3];
        }
      }
      return '';
    }
    const mm = raw.match(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/);
    if (!mm) return raw;
    const vals = matrixValues(mm[1]);
    if (vals.length === 0) return '';
    // SUBSTITUTE into the surrounding path, rather than returning the leg on
    // its own. `working-directory: apps/${{ matrix.app }}` with `app: [agent]`
    // runs in `apps/agent`, but returning the raw leg required the leg itself
    // to BE a package path — so the far more ordinary spelling, where the
    // expression is one component of a larger path, resolved to nothing
    // (#1995 r16). The whole-value case still works: substituting into a
    // string that is only the expression gives the value back.
    const candidates = vals.map((v) => raw.replace(mm[0], v));
    return (
      candidates.find((c) =>
        SCOPED.some((sc) => c === sc.dir || c.startsWith(`${sc.dir}/`)),
      ) ?? ''
    );
  };
  const valueOf = (m) => normalizePath(resolveExpression(m[1] ?? m[2] ?? m[3]));
  /**
   * The same resolution for a FLOW-style capture.
   *
   * `defaults: { run: { working-directory: X } }` returned its capture raw, so
   * it reached neither the expression resolver nor the normaliser — the r13
   * branch was added before either existed and never joined them (#1995 r16).
   * Two return sites, job-level and workflow-level, and both had it.
   */
  const flowValueOf = (m) => normalizePath(resolveExpression(m[1] ?? m[2] ?? m[3]));

  // STEP level wins over the job default, which is Actions' own precedence.
  const stepWd = scanStepKeys(lines, runIdx, WD);
  if (stepWd) return valueOf(stepWd);

  // DEFAULTS, confined to the CONTAINING JOB. Taking the nearest preceding
  // `defaults:` let one job's default leak into a later job that has none —
  // reporting a repo-root deploy as the agent's, which is a false red (#1995
  // r8). Job scope is bounded by the job-key line and the next key at the same
  // indent; a workflow-level `defaults:` outside `jobs:` still applies.
  const declaredIn = (from, to) => {
    for (let i = from; i < to && i < lines.length; i += 1) {
      const flowJob = lines[i].match(FLOW_DEFAULTS_WD);
      if (flowJob) return flowValueOf(flowJob);
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
      // A job key may be QUOTED — `"deploy-agent":` is ordinary YAML — and an
      // identifier-only matcher skipped that job entirely, so its
      // `defaults.run.working-directory` was never consulted (#1995 r16).
      if (ind === jobIndent && /^\s*(?:"[^"]*"|'[^']*'|[\w.-]+):\s*$/.test(lines[i])) {
        jobStart = i;
      }
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
      return flowValueOf(flowTop);
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
  // EVERY string value on the line, not just one at the end. The pattern was
  // end-anchored, so a MINIFIED manifest — every key on one line — had only its
  // last value read and the rest never scanned at all. Found while fixing the
  // escape decoding below: the decoded case passed pretty-printed and failed
  // minified, which is the escape working and the extraction not (#1995 r16).
  //
  // One entry per value, all carrying the same physical line number, so a
  // violation still points where an operator can open it. Values are NOT
  // joined: concatenating them would put two unrelated scripts in one
  // "command" and could manufacture a `cd` / deploy sequence that no script
  // performs.
  return text.split('\n').flatMap((t, i) => {
    const all = [...t.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)];
    if (all.length > 0) {
      return all.map((mm) => ({
        text: decodeJsonString(mm[1]),
        line: i + 1,
        physical: true,
      }));
    }
    const m = null;
    return { text: t, line: i + 1, physical: true };
  });
}

/**
 * A JSON string body, decoded with JSON semantics rather than by dropping
 * backslashes.
 *
 * `\u0079` is the letter `y`, and stripping the backslash left the literal
 * text `u0079` — so a manifest whose script reads `wrangler deplo\u0079` was
 * scanned as `wrangler deployu0079`, matched no deploy, and the whole file was
 * skipped at the prefilter (#1995 r16). The package manager runs
 * `wrangler deploy`.
 *
 * `JSON.parse` on the re-quoted body, so every escape the format defines is
 * handled rather than the two that were thought of. The fallback keeps the old
 * behaviour when the body is not valid JSON — a `.jsonc` comment, say — so a
 * malformed file degrades to the previous reading instead of vanishing.
 */
function decodeJsonString(body) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body.replace(/\\(.)/g, '$1');
  }
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
      // A FENCE DELIMITER is punctuation, not a command. `From apps/agent:`
      // followed by the usual ```bash block had the label attached to the
      // opener and reset before the command inside it ever arrived — so the
      // one shape a runbook actually uses was the one shape this could not
      // carry (#1995 r16). Skipped like a blank line: it neither consumes the
      // label nor clears it.
      if (/^(?:`{3,}|~{3,})/.test(t)) continue;
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
        // `&&` corrected twice over (#1995 r15), both by the same reasoning:
        // WHEN is this segment skipped, and where does the shell stand then?
        //
        // It is skipped iff the PREVIOUS command failed, and in that case the
        // cwd is the one from before THAT command — `prior`, not `states`.
        // Unioning `states` modelled "we are where the previous cd left us and
        // this one did not run", which cannot happen: if the previous `cd`
        // failed it moved nothing. That reported `cd apps/agent && cd
        // ../indexer && wrangler deploy` against the AGENT, although the deploy
        // runs only when both moves succeeded and therefore runs from the
        // indexer. A false red, from my own r13 fix.
        //
        // And the skipped branch cannot reach a further `&&` at all: the chain
        // short-circuits, so a later `&&` command does not run either. It is
        // dropped when the next separator is `&&`, rather than carried into a
        // command it can never reach.
        const skipped = nextPart?.sep === '&&' ? [] : prior;
        const next =
          part.sep === '||'
            ? dedupeStates([...states, ...after])
            : part.sep === '&&'
              ? dedupeStates([...skipped, ...after])
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
        // A `for` LOOP binds its variable just as an assignment does
        // (#1995 r12). `for TARGET in apps/agent; do` … `cd "$TARGET"` enters
        // the protected package, but only standalone `VAR=` was tracked, so
        // the `cd` cleared scope instead.
        //
        // With several values, each ITERATION binds a different one; if any
        // lands in a scoped package then that iteration deploys from it, so
        // that value is the one to model — the same rule the matrix
        // working-directory uses. A list with no scoped value binds nothing,
        // and an unknown one CLEARS the name rather than leaving a stale
        // binding, which is the r14 rule applied here.
        const loop = seg.match(
          /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*$/,
        );
        if (loop) {
          const vals = loop[2]
            .split(/\s+/)
            .map((v) => dequote(v))
            .filter((v) => v && !/[$*?]/.test(v));
          const hit = vals.find((v) =>
            SCOPED.some((sc) => v === sc.dir || v.startsWith(`${sc.dir}/`)),
          );
          if (hit) shellVars.set(loop[1], hit);
          else shellVars.delete(loop[1]);
          namedPrefix.push({ text: seg, depth: segDepth });
        } else if (new RegExp(`^${DECL_PREFIX}[A-Za-z_][A-Za-z0-9_]*=`).test(seg)) {
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
        const sel = selectorScope(seg, input, true, shellVars);
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
