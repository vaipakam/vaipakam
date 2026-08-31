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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// `CHECK_DEPLOY_ROOT` exists so the test suite can point this at a fixture
// tree instead of appending to real repo files. An earlier throwaway harness
// did mutate the repo and its cleanup reverted a real fix mid-run; scanning a
// temp directory removes that whole class of accident.
import { parseJsonc } from './lib/jsonc.mjs';

/** Collapse `.`, `..` and repeated separators in a repo-relative path. */
function normalizeRel(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

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
  // Generated analysis output, gitignored, and LARGE — `graph.json` reached
  // 198 MB in one working session because the graph rebuilds on every commit,
  // and scanning it cost 91 s of a 161 s run. Nothing is lost: whatever it
  // quotes is derived from sources this walk already reads, so a command can
  // only appear here as a copy of one scanned at its origin. Same class as
  // `dist` and `out` above — generated, not authored.
  'graphify-out',
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
// `(?:\.(?:cmd|ps1|bat))?`: npm installs Windows SHIMS beside the executable,
// and `wrangler.cmd deploy` in a `shell: cmd` step is the same deployment. The
// shell allow-list admits those steps, so not recognising the shim meant
// admitting the step and then seeing nothing in it (#1995 r16).
const DEPLOY_RE = String.raw`wrangler2?(?:\.(?:cmd|ps1|bat))?(?:@[^\s]+)?\s+(?:-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?\s+)*(?:deploy|versions(?:\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?)*\s+upload)\b`;
/**
 * `spawn('wrangler', ['deploy', …])` and its execa/child_process siblings.
 *
 * A JS deploy helper names the executable and its arguments as ARGV, with no
 * whitespace between them, so the shell-string pattern could not match and the
 * file-level prefilter skipped the helper entirely (#1995 r16). This repo
 * already uses that spawn form elsewhere, so it is an ordinary spelling here
 * rather than an exotic one.
 *
 * Deliberately loose about what sits between the two: an options object, a
 * spread, a variable holding the argument list. Being loose can only bring more
 * files INTO the scan, where the ordinary scoring applies.
 */
// Narrowed twice over (#1995 r16). A stored ARRAY is not an invocation — the
// pattern is the final predicate, not only a prefilter, so `const args =
// ['wrangler', 'deploy']` was reported as a deployment that never runs. And
// `versions` alone is not the guarded operation: `versions list` lists recent
// versions, while only `versions upload` uploads. Both were false REDS.
//
// A CALL is what a child-process spawner names, so the executable has to follow
// one of those function names. Loose about what sits BETWEEN the executable and
// the subcommand, because being loose there can only bring more files into the
// ordinary scoring; strict about what sits BEFORE it, because that is what
// decides whether anything runs at all.
// `[^'"\`\s]*[/\\]` before the name: `spawnSync('./node_modules/.bin/wrangler',
// …)` runs the same local executable, and requiring the quote to be followed
// immediately by `wrangler` missed every path-qualified spelling (#1995 r16).
const ARGV_DEPLOY_RE = String.raw`\b(?:spawnSync|spawn|execFileSync|execFile|execaSync|execaCommandSync|execaCommand|execa|fork|subprocess\.[A-Za-z_]+|check_call|check_output)\s*\(\s*\[?\s*(['"\`])(?:[^'"\`\s]*[/\\])?wrangler2?(?:\.(?:cmd|ps1|bat))?\1[\s\S]{0,200}?(['"\`])(?:deploy|versions\2\s*,\s*(['"\`])upload)\3?`;

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
// `yarn deploy` runs the package script WITHOUT the `run` keyword — Yarn's own
// `run -h` says so — and the pattern required the keyword, so the file was
// skipped entirely (#1995 r16). Yarn only, because `pnpm deploy` and
// `npm deploy` are different commands: pnpm's is its own publish-style command
// and npm has none, so admitting them would invent invocations.
// `yarn workspace <name> <script>` runs the named package's script with the
// script as a POSITIONAL — Yarn's own usage line — so the run-alias
// alternative never matched the run-less spelling and
// `yarn workspace @vaipakam/agent deploy --no-keep-vars` was invisible
// (#1995 r17). The `run` spelling of the same form was already covered by the
// generic token-stepper.
const RUN_DEPLOY_RE = String.raw`(?:(?:pnpm|npm|yarn)(?:\s+[^\s]+)*?\s+(?:${RUN_ALIASES})|yarn\s+workspace\s+[^\s]+|yarn)(?:\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?)*\s+deploy\b`;
/** What counts as "this line performs a deploy" for DETECTION purposes. */
// A process API can take the command as ONE SHELL STRING as well as an argv
// array: `subprocess.run("wrangler deploy", shell=True)` and
// `os.system("wrangler deploy")` execute the deploy exactly as the argv form
// does, but only argv-shaped calls kept a non-shell step's block, so the
// step's working-directory never reached the command (#1995 r17). The quote
// is a NAMED group so this pattern never renumbers `ARGV_DEPLOY_RE`'s
// backreferences if the two are ever composed; the tempered dot keeps the
// scan inside one string literal.
// `versions upload` ships code and config exactly as `deploy` does and is
// already a deploy to `ARGV_DEPLOY_RE` and `DEPLOY_RE` — but the shell-string
// predicate recognised only `deploy`, so a non-shell step's block was
// discarded and the upload never met its `working-directory` (#1995 r21).
const SHELLSTR_DEPLOY_RE = String.raw`\b(?:os\.system|system|subprocess\.(?:run|call|check_call|check_output|Popen)|execSync|exec|execaCommandSync|execaCommand|execa)\s*\(\s*[frbu]{0,3}(?<sq>['"\`])(?:(?!\k<sq>)[\s\S])*?wrangler2?(?:\.(?:cmd|ps1|bat))?\s(?:(?!\k<sq>)[\s\S])*?\b(?:deploy|versions\s+upload)\b`;
const launchesDeployText = (t) =>
  new RegExp(ARGV_DEPLOY_RE).test(t) || new RegExp(SHELLSTR_DEPLOY_RE).test(t);
const ANY_DEPLOY_RE = `(?:${DEPLOY_RE}|${RUN_DEPLOY_RE}|${ARGV_DEPLOY_RE})`;

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

// A helper EXECUTED as its own process, by any filename the walk itself will
// open. Requiring `.sh` missed the extensionless and `.bash` spellings that
// `looksExecutable` and `SHELL_EXTENSIONS` explicitly admit (#1995 r20).
//
// Three spellings, and the narrowness of each is load-bearing:
//
//   `bash helper`      — a launcher names its script, whatever it is called
//   `./deploy-helper`  — PATH-QUALIFIED and EXTENSIONLESS, the conventional
//                        executable wrapper `looksExecutable` also admits
//   `path/to/x.sh`     — any of the shell extensions the walk itself opens
//
// A bare word is a `$PATH` lookup or a function call, not a file in this
// tree. Two earlier cuts were too wide and both were caught by measurement
// rather than by review: accepting ANY slashed token made `cd apps/agent`
// look like an executed helper, and allowing a DOTTED basename after `./`
// meant `./src/index.ts` did too — so the walk read and fully parsed every
// TypeScript file it saw mentioned. That took the real-tree run from 101 s
// to over 400 s, on 1096 matching lines where `.sh` alone matches 250.
//
// A WINDOWS helper is the same proposition in the other family: `call
// ..\..\deploy.cmd` after `cd /d apps\agent` runs the child in the protected
// directory, and both matchers knew only POSIX names — so the helper was
// scanned on its own, scopeless (#1995 r21). Its alternative REQUIRES one of
// the Windows extensions, which is what keeps the optional launcher prefix
// from re-opening the width problem above: no bare word can match it.
//
// A NODE-launched helper is the third family: `node ../../deploy.mjs`, whose
// `spawnSync('wrangler', ['deploy'])` inherits the caller's directory exactly
// as a shell helper's does (#1995 r22). BOTH the launcher word and a script
// extension are required — that is what keeps it away from the r20 width
// problem, since a bare `./x.ts` still matches nothing here.
const EXEC_HELPER_RE = String.raw`(?:(?:bash|sh|zsh|ksh|dash)\s+(?:-\S+\s+)*(?:[\w.@-]+\/)*[\w.@-]+|\.{0,2}\/(?:[\w.@-]+\/)*[\w@-]+|(?:[\w.@-]+\/)*[\w.@-]+\.(?:sh|bash|zsh|ksh)|(?:(?:call|cmd\s+\/[cCkK]|powershell|pwsh)(?:\s+[-\/]\S+(?:\s+(?![-\/])[^\s\\\/]+(?=\s))?)*\s+)?(?:[\w.@-]+[\\\/])*[\w.@-]+\.(?:cmd|bat|ps1)|(?:node|bun|tsx)(?:\s+-\S+(?:\s+(?!-)[^\s]+(?=\s))?)*\s+(?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|ts)|(?:python3?|py)(?:\s+-\S+(?:\s+(?!-)[^\s]+(?=\s))?)*\s+(?:[\w.@-]+\/)*[\w.@-]+\.py)`;

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
  // `.mdx` is handled everywhere `.md` is — the markdown branch tests for it —
  // but `walk` never yielded the file, so that handling was unreachable and an
  // MDX runbook was not opened at all (#1995 r16).
  '.mdx',
  '.ts',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  // Windows deployment helpers. `walk` never yielded these, so a
  // `deploy.ps1` beside a protected worker was not opened at all — even
  // though workflow BODIES under pwsh/cmd were already modelled (#1995 r17).
  // A standalone `.py` helper can carry an argv deploy that `ARGV_DEPLOY_RE`
  // already recognises — the detector existed, the walk simply never yielded
  // the file (#1995 r22).
  '.py',
  // `makefileBlocks` has always matched `*.mk`, and the walk never yielded one
  // — so that branch was unreachable and an included deploy fragment was read
  // as prose, while the identical content named `Makefile` was rejected
  // (#1995 r23). The third time a handled extension was not a WALKED one, after
  // `.mdx` and `.py`.
  '.mk',
  '.ps1',
  '.cmd',
  '.bat',
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
  // Scanned LINEARLY rather than matched. The pattern this replaces nested a
  // quantified word (`CHUNKS`) inside a quantified assignment group, which is
  // the ambiguous shape this file has been bitten by three times: a segment
  // that does not match explores every partition of its leading run. It cost
  // 29.5 s on ONE file — `contracts/script/deploy-chain.sh` — once #1995 r20
  // began calling this per SEGMENT to find assignment-prefixed helper calls,
  // taking the whole tree from 101 s to over 400 s. Same contract: drop
  // opening punctuation, then any run of `NAME=<word>` prefixes, where a word
  // may mix quoted and unquoted chunks and carry escapes.
  let t = cmd.replace(/^[\s(){]*/, '');
  for (;;) {
    // `env [OPTION]... [NAME=VALUE]... COMMAND [ARG]...` RUNS the command, so
    // the executed command is what follows the wrapper — the same proposition
    // this function already models for a bare assignment prefix. Without it,
    // `env ../../deploy-helper.sh` named `env` as the command word and the
    // helper was never followed (#1995 r23).
    //
    // Options are skipped, and the four that take a SEPARATED value consume it
    // (`-u NAME`, `-C DIR`, `-S STR`, and their long forms use `=`, which the
    // token skip already covers). Looping means `env A=1 env B=2 cmd` unwraps
    // as bash runs it. `--` ends the options, and anything after it is the
    // command.
    const envLead = /^env(?:\s|$)/.exec(t);
    if (envLead) {
      let u = t.slice(envLead[0].length).replace(/^\s*/, '');
      for (;;) {
        const opt = /^(--?[A-Za-z0-9-]+)(=\S*)?(?:\s+|$)/.exec(u);
        if (!opt) break;
        if (opt[1] === '--') {
          u = u.slice(opt[0].length);
          break;
        }
        u = u.slice(opt[0].length).replace(/^\s*/, '');
        // A separated value belongs to the option, not to the command.
        // The LONG forms take a separated value too — `env --chdir ../agent
        // helper.sh` is valid, and consuming the flag but not its argument
        // made `../agent` look like the command (#1995 r23). An attached
        // `=value` is already inside `opt[2]`.
        if (!opt[2] && /^(?:-[uCS]|--(?:unset|chdir|split-string))$/.test(opt[1])) {
          const val = /^\S+\s*/.exec(u);
          if (val) u = u.slice(val[0].length);
        }
      }
      // Only treat it as the wrapper if something is actually left to run;
      // a bare `env` prints the environment and executes nothing.
      if (u.trim() !== '') {
        t = u;
        continue;
      }
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(t);
    if (!m) break;
    let j = m[0].length;
    let quote = null;
    while (j < t.length) {
      const c = t[j];
      if (quote) {
        if (c === quote) quote = null;
        j += 1;
      } else if (c === '"' || c === "'") {
        quote = c;
        j += 1;
      } else if (c === '\\') {
        j += 2;
      } else if (/\s/.test(c)) {
        break;
      } else {
        j += 1;
      }
    }
    // The group being replaced ended in `\s+`, so an assignment with NO
    // separator after it is not a prefix at all — `A=1` and the `B=2` of
    // `A=1 B=2` stay put. Verified against the old pattern over a corpus that
    // includes exactly these, which is how this rule was found.
    const ws = t.slice(j).match(/^\s+/)?.[0].length ?? 0;
    if (ws === 0) break;
    t = t.slice(j + ws);
  }
  return t;
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

/**
 * Strip comments before reading a config setting.
 *
 * A JSONC or TOML file that merely DOCUMENTS the remedy — `// "keep_vars": true`
 * — was read as enabling it, so a config saying "you could set this" blessed a
 * destructive upload (#1995 r16). Line and block comments both, in the two
 * comment styles those formats use.
 */
/**
 * `cmdCwd` is the directory the command RUNS in, as the walk models it, and is
 * used only to resolve an explicitly selected `--config`. Wrangler resolves
 * that path against the process cwd, so reading it relative to the target
 * Worker's directory could bless an upload through a DIFFERENT file than the
 * one selected (#1995 r22).
 */
function commandIsSafe(cmd, scopeHint = null, cmdCwd = '') {
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
  // A CHILD-PROCESS call carries its flags in the argv ARRAY. The third
  // argument is process options, and `spawnSync('wrangler', ['deploy'], { env:
  // { NOTE: '--keep-vars' } })` passes wrangler only the bare `deploy` — but a
  // whole-text scan read the environment value as an enabled flag and blessed a
  // destructive invocation (#1995 r16). Scored from the array alone.
  const argv = cmd.match(new RegExp(`${ARGV_DEPLOY_RE}[\\s\\S]*?\\]`));
  const flagText = argv ? argv[0] : forFlags;
  if (flagEnabled(flagText, '--keep-vars') || flagEnabled(flagText, '--dry-run')) {
    return true;
  }
  // CONFIGURED preservation makes the command safe — for BOTH verbs.
  //
  // `versions upload` has no `--keep-vars` at all: the pinned wrangler lists
  // only `--dry-run` for it and derives `keepVars` from `config.keep_vars`, so
  // the guard was blessing a command that cannot run while blocking every
  // upload that can (#1995 r16). That was the first half of the rule.
  //
  // The second half is that `deploy` reads the SAME field —
  // `const keepVars = props.keepVars || config.keep_vars` in wrangler 4.90.0 —
  // and this predicate did not, so it went on demanding a per-invocation flag
  // for a Worker whose config already preserves its vars. Requiring the flag
  // at every call site means keeping an UNBOUNDED set of spellings correct
  // across runbooks, scripts, workflows and package manifests; #1995 spent 242
  // findings establishing that. Reading the config instead asks the bounded
  // question wrangler itself asks.
  //
  // So this guard now activates precisely when the root fix is ABSENT: with
  // `keep_vars: true` declared, every spelling is safe and nothing is
  // reported; remove it and the whole spelling-detection surface comes back.
  // Defence in depth that switches itself off when it is not needed.
  {
    // The config of the worker THIS command deploys, not of any scoped worker.
    // Reading either config meant one package enabling `keep_vars` blessed a
    // bare upload in the OTHER — the caller already knows which, from the cwd
    // or the file, so it says (#1995 r16).
    const target =
      SCOPED.find((sc) => new RegExp(`(^|/)${sc.dir}(/|$)`).test(cmd)) ?? scopeHint;
    // `-c, --config` selects the file wrangler actually reads — the pinned CLI
    // defines it as the path to the configuration — so an upload passing
    // `--config unsafe.jsonc` is judged by THAT file, and the default names
    // only when nothing was selected (#1995 r17). Anchored AFTER the wrangler
    // word so an outer shell's `sh -c` is never mistaken for it. A selection
    // this scanner cannot resolve statically (absolute, computed, or
    // root-climbing) blesses nothing.
    // Read from the comment-stripped ORIGINAL, not from `bare`:
    // `stripOtherOptionValues` deletes exactly the value this is after.
    const cfgText = stripShellComment(cmd);
    const wi = cfgText.search(/\bwrangler2?\b/);
    const cfgRegion = wi >= 0 ? cfgText.slice(wi) : cfgText;
    const cfgSel =
      cfgRegion.match(/\s(?:-c|--config)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/) ??
      // ATTACHED SHORT FORM, the same gap `selectorScope` had (Codex #2036 r1)
      // and the same fix, because it is the same option read twice. Here the
      // consequence is the mirror image: an unrecognised selection makes this
      // read the Worker's DEFAULT config, which may declare `keep_vars` while
      // the selected one does not — blessing an upload rather than reporting it.
      // Narrowed to a path-shaped value for the reason given there.
      (() => {
        const m = cfgRegion.match(
          /(?<![\w-])-c(?=[^\s=-])(?:"([^"]*)"|'([^']*)'|([^\s"']+))/,
        );
        if (!m) return null;
        const v = m[1] ?? m[2] ?? m[3];
        return v.includes('/') || /\.(?:jsonc?|toml)$/.test(v) ? m : null;
      })();
    // …and the ARGV spelling, where the flag and its value are separate array
    // elements: `subprocess.run(["wrangler","deploy","--config","x.jsonc"])`.
    // `ARGV_DEPLOY_RE` admits those arrays, so the deploy was recognised while
    // its selected config was not — and the guard then read the Worker's
    // DEFAULT config, which may declare `keep_vars` while the selected one
    // does not (#1995 r23). The separator is `","` however it is quoted or
    // spaced, which is what distinguishes this from the shell form above.
    const cfgArgv = cfgSel
      ? null
      : cfgRegion.match(
          /["'](?:-c|--config)["']\s*,\s*["']([^"']+)["']/,
        );
    const cfgName = cfgSel
      ? (cfgSel[1] ?? cfgSel[2] ?? cfgSel[3])
      : cfgArgv
        ? cfgArgv[1]
        : null;
    const cfgNames =
      cfgName === null
        ? ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
        : /^\/|\$|^\.\./.test(cfgName)
          ? []
          : [cfgName];
    // Parsed STRUCTURALLY, top level only — wrangler reads
    // `rawConfig.keep_vars`, and the text regex that stood here matched the
    // words inside a string VALUE, so `"vars": {"NOTE": "keep_vars: true"}`
    // blessed an upload the CLI runs destructively (#1995 r18). For TOML the
    // top level ends at the first table header. A config that does not parse
    // blesses nothing.
    const keepVarsEnabled = (path) => {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        return false;
      }
      if (/\.toml$/.test(path)) {
        for (const line of text.split('\n')) {
          if (/^\s*\[/.test(line)) break;
          if (/^\s*keep_vars\s*=\s*true\s*(?:#.*)?$/.test(line)) return true;
        }
        return false;
      }
      try {
        const cfg = parseJsonc(text);
        return cfg !== null && typeof cfg === 'object' && cfg.keep_vars === true;
      } catch {
        return false;
      }
    };
    for (const sc of target ? [target] : SCOPED) {
      for (const name of cfgNames) {
        // Resolved AS WRANGLER RESOLVES IT: an explicitly selected config is
        // relative to the command's own working directory. Reading it under
        // the target Worker's directory meant a repo-root
        // `--config configs/agent.jsonc` was answered by
        // `apps/agent/configs/agent.jsonc` — a different file, which could
        // say `true` while the selected one says `false` (#1995 r22).
        //
        // The Worker directory stays as a FALLBACK, taken only when the
        // cwd-resolved path names nothing on disk. The modelled cwd is a guess
        // when no `cd` was seen — the walk deliberately does not assume a
        // script's own directory — so an unresolvable selection should not
        // become a false red. Where the finding's harm lives, the cwd-resolved
        // file DOES exist, so the fallback never runs and the wrong file
        // cannot answer.
        // ONLY an explicitly selected config resolves against the cwd. The
        // DEFAULT names belong to the Worker being deployed and are read under
        // its directory — `cd apps/keeper` then
        // `env --chdir ../agent wrangler versions upload` deploys the AGENT,
        // and resolving `wrangler.jsonc` against the shell's cwd let the
        // KEEPER's config answer for it. That is the r16 wrong-worker defect
        // returning by another door, and its standing control caught it.
        const underWorker = name.startsWith(`${sc.dir}/`)
          ? `${REPO_ROOT}/${name}`
          : `${REPO_ROOT}/${sc.dir}/${name}`;
        const candidates =
          cfgName === null
            ? [underWorker]
            : [`${REPO_ROOT}/${normalizeRel(`${cmdCwd}/${name}`)}`, underWorker];
        const chosen = candidates.find((c) => existsSync(c)) ?? candidates[0];
        if (keepVarsEnabled(chosen)) return true;
      }
    }
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
      // The run-less `yarn deploy` form has to be admitted HERE as well as in
      // detection. Widening only the detector made a correct `yarn deploy` — the
      // package script, which carries the flag — read as an unrecognised bare
      // deploy and reported: a false red I introduced in the same change, caught
      // by a control probe. These are two halves of one decision, which is the
      // drift this file keeps being bitten by.
      `${hasWrangler ? '^' : ''}(pnpm|npm|yarn)(?:\\s+workspace\\s+[^\\s]+)?(?:(?:\\s+[^\\s]+)*?` +
        `\\s+(?:${RUN_ALIASES}))?(?:\\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\\s-][^\\s]*)?)*\\s+deploy\\b([\\s\\S]*)$`,
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
 * The scope of a deploy whose target this scanner could not name (#1996).
 *
 * A SINGLETON, compared by identity everywhere `scope` is, so it groups and
 * de-duplicates like any other scope while belonging to no package. It carries
 * no `filter`, `workerName` or `vars` on purpose — every one of those would be
 * a claim about a Worker that has not been identified, and the reporting path
 * gives this group its own remedy rather than borrowing a package's.
 */
const UNNAMED_SCOPE = {
  dir: 'a Worker this scanner could not name',
};

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

const pkgScriptsCache = new Map();
function packageScripts(dir) {
  if (!pkgScriptsCache.has(dir)) {
    let scripts = null;
    try {
      scripts = JSON.parse(readFileSync(`${REPO_ROOT}/${dir}/package.json`, 'utf8')).scripts ?? null;
    } catch {
      scripts = null;
    }
    pkgScriptsCache.set(dir, scripts);
  }
  return pkgScriptsCache.get(dir);
}

/**
 * Rewrite a run-script ALIAS into the invocation it performs.
 *
 * `"release": "pnpm run deploy"` makes `pnpm --filter @vaipakam/agent run
 * release -- --no-keep-vars` a deploy: pnpm appends the forwarded arguments
 * to the alias, the alias forwards them again, and wrangler parses
 * `--keep-vars --no-keep-vars` as keepVars:false — but no detector matched
 * `run release`, so the destructive spelling was invisible (#1995 r17).
 *
 * Resolved STATICALLY from the selected package's manifest, chain bounded at
 * three hops. An alias that runs the `deploy` script rewrites to `run
 * deploy`, so the ordinary appended-argument rules judge it; one that runs
 * wrangler DIRECTLY splices its body in (dropping the now-consumed `--`), so
 * an unsafe body cannot launder itself into the blessed script name. Only
 * SCOPED packages are consulted — an alias elsewhere cannot produce a
 * violation this guard reports.
 */
function resolveRunAlias(text, ctxDir = null) {
  if (!/\b(?:pnpm|npm|yarn)\b/.test(text)) return null;
  const m = text.match(
    new RegExp(
      `\\b(pnpm|npm|yarn)\\b((?:\\s+-{1,2}[A-Za-z0-9-]+(?:[= ][^\\s-][^\\s]*)?|\\s+workspace\\s+[^\\s]+)*)\\s+(?:${RUN_ALIASES})\\s+([A-Za-z_][\\w:.-]*)`,
    ),
  );
  if (!m || m[3] === 'deploy') return null;
  const sel = m[2].match(
    /(?:--filter(?:-prod)?|-F)[=\s]+("[^"]*"|'[^']*'|[^\s]+)|workspace\s+([^\s]+)/,
  );
  const selName = sel ? dequote(sel[1] ?? sel[2]) : null;
  // With NO selector the package manager runs the CURRENT package's script —
  // `pnpm run release` inside apps/agent is the agent's alias — and returning
  // null there missed the most ordinary spelling of all (#1995 r20). The
  // caller supplies that context from the file's own path or the modelled
  // cwd; an explicit selector still wins, and a selector naming something
  // unscoped still resolves to nothing rather than falling back.
  const dir = selName
    ? (SCOPED.find((sc) => sc.filter === selName)?.dir ?? null)
    : ctxDir;
  if (!dir) return null;
  let cur = m[3];
  for (let hop = 0; hop < 3; hop += 1) {
    const body = packageScripts(dir)?.[cur];
    if (typeof body !== 'string') return null;
    if (new RegExp(DEPLOY_RE).test(body)) {
      return text
        .replace(new RegExp(`(?:${RUN_ALIASES})\\s+${m[3]}\\b`), body.trim())
        .replace(/\s--(?=\s|$)/, ' ');
    }
    const inner = body
      .trim()
      .match(new RegExp(`^(?:pnpm|npm|yarn)(?:\\s+(?:${RUN_ALIASES}))?\\s+([A-Za-z_][\\w:.-]*)\\s*$`));
    if (!inner) return null;
    if (inner[1] === 'deploy') {
      return text.replace(new RegExp(`((?:${RUN_ALIASES})\\s+)${m[3]}\\b`), '$1deploy');
    }
    cur = inner[1];
  }
  return null;
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
  // `yarn workspace <name>` names its package as a POSITIONAL, not an
  // option, so no selector reader saw it and the invocation fell through to
  // textual scope (#1995 r17). An exact name that is not a scoped package is
  // a REAL selection of something else, and correctly leaves the selection
  // empty rather than deferring to the cwd.
  for (const wsm of line.matchAll(
    /(?:^|\s)yarn\s+workspace\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g,
  )) {
    sawSelector = true;
    sawPositive = true;
    const wsName = wsm[1] ?? wsm[2] ?? wsm[3];
    const wsHit = SCOPED.find((entry) => entry.filter === wsName);
    if (wsHit) included.add(wsHit);
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
    // `^` is pnpm's EXCLUSIVE marker — `...^X` is X's dependents WITHOUT X
    // itself. The dots were stripped and the caret left in the pattern, so the
    // selector matched no package name at all and resolved to an authoritative
    // empty (#1995 r16).
    //
    // The ANCHOR is then dropped from the result, which my first cut did not
    // do. I claimed exclusion "only removes the matched package, and a scoped
    // package is never the one being excluded here in practice" — that is
    // simply false: `...^@vaipakam/agent` excludes the agent, and the agent is
    // exactly a scoped package. The selector reported a deploy pnpm does not
    // perform, which is a false red produced by my own reasoning rather than by
    // the code it replaced.
    const exclusive = /^\.\.\.\^|\^\.\.\.$/.test(pat);
    pat = pat.replace(/^\.\.\.\^?|\^?\.\.\.$/g, '');
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
      // A NEGATIVE selector whose changed-since set is unknown cannot subtract.
      // `--filter X --filter '!{apps/agent}[HEAD]'` selects the agent when
      // nothing changed, but stripping the suffix excluded it unconditionally
      // and the destructive command passed (#1995 r16). The positive direction
      // stays conservative — the suffix only NARROWS what the prefix selects —
      // and the negative one has to be conservative the other way round.
      if (negated) continue;
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
    // With the exclusive marker the anchor itself is NOT selected.
    const matched = [...new Set(exclusive ? viaGraph : [...direct, ...viaGraph])];
    if (negated) {
      for (const sc of matched) excluded.add(sc);
    } else {
      sawPositive = true;
      for (const sc of matched) included.add(sc);
    }
  }
  // An unresolved selector defers ONLY when nothing else resolved. pnpm runs on
  // packages satisfying AT LEAST ONE selector, so `--filter . --filter
  // '@vaipakam/*gent'` selects the agent whatever `.` turns out to be — and
  // discarding the resolved half because the other one was unknown threw away a
  // protected selection that was right there (#1995 r16).
  if (!sawSelector) return null;
  if (unresolved && included.size === 0) return null;
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
/**
 * Literal `NAME=<word>` assignments anywhere in a file, for DETECTION only.
 *
 * `WRANGLER=wrangler` then `"$WRANGLER" deploy` is a bare deploy that neither
 * the raw nor the dequoted text spells, so the file-level prefilter skipped the
 * whole file and nothing downstream ever saw it (#1995 r16). `CMD=deploy` with
 * `wrangler "$CMD"` is the same defect on the other command word.
 *
 * File-wide and order-free ON PURPOSE. This map decides only whether text is
 * WORTH SCANNING and which lines carry a deploy; it never decides scope or
 * safety, which stay with the ordered `shellVars` walk.
 *
 * Values may hold SPACES, because an alias can: `WRANGLER="pnpm exec wrangler"`
 * word-splits to a real command. What keeps that from resurrecting the r19
 * defect — `MSG="wrangler deploy"` then `echo "$MSG"` reported as a deploy — is
 * WHERE the expansion is allowed, not what the value contains: a multiword
 * value is substituted only in COMMAND POSITION, which `echo "$MSG"` is not.
 * Single-word values expand anywhere, since a command word is one.
 *
 * The leading boundary admits a QUOTE or BACKTICK as well as whitespace, so a
 * runbook's `` `CMD=wrangler; "$CMD" deploy` `` code span reaches this at all.
 */
function staticCommandVars(text) {
  const vars = new Map();
  for (const m of text.matchAll(
    /(?:^|[\s;&|(`'"])([A-Za-z_][A-Za-z0-9_]*)=(?:"([A-Za-z0-9_.\/ -]*)"|'([A-Za-z0-9_.\/ -]*)'|([A-Za-z0-9_.\/-]+))(?=[\s;&|)`'"]|$)/gm,
  )) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value) vars.set(m[1], value);
  }
  return vars;
}

/**
 * Fold adjacent STRING LITERALS, for DETECTION only.
 *
 * `spawnSync('wrangler', ['de' + 'ploy'])` runs the destructive argument —
 * JavaScript evaluates the concatenation — but the pattern required the
 * subcommand to occupy one literal and the file was skipped at the prefilter
 * (#1995 r16).
 *
 * Same-quote pairs only, and repeated so a chain of three or more collapses.
 * Bounded: this runs over whole files, and an unbounded loop over adversarial
 * input is not something a CI guard should own.
 */
function foldStringConcat(text) {
  let out = text;
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(/(['"`])([^'"`\n]*)\1\s*\+\s*\1([^'"`\n]*)\1/g, '$1$2$3$1');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Substitute those assignments into a line, for DETECTION only. */
function expandCommandVars(text, vars) {
  if (!vars || vars.size === 0 || !/\$/.test(text)) return text;
  // A MULTIWORD value only substitutes at the head of the text, which is the
  // command position for a segment. Anywhere else it is an argument or a
  // message, and expanding it there is what reported `echo "$MSG"` as a deploy.
  // `eval` EXECUTES its argument, so the word after it is a command position
  // too: `CMD='wrangler deploy'; eval "$CMD"` runs the deploy, but the head
  // test saw `eval` as the command word and left `$CMD` an inert argument
  // (#1995 r21). Only `eval` — the point of the head rule is that an ordinary
  // argument is data, and `echo "$MSG"` must stay silent.
  // A shell's `-c` PAYLOAD is a command position for the same reason `eval`'s
  // argument is: `CMD='wrangler deploy'; bash -c "$CMD"` executes the deploy
  // (#1995 r22). Both spellings, one rule — the launcher and its options are
  // stepped over, and what follows is treated as the command word.
  const evalLead = text.match(
    /^\s*(?:eval|(?:bash|sh|zsh|ksh|dash)\s+(?:-[A-Za-z]*c[A-Za-z]*|-\S+\s+-[A-Za-z]*c[A-Za-z]*))\s+/,
  );
  const rest = evalLead ? text.slice(evalLead[0].length) : text;
  const head = rest.match(/^\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?/);
  if (head && vars.has(head[1]) && /\s/.test(vars.get(head[1]))) {
    return (evalLead?.[0] ?? '') + rest.replace(head[0], vars.get(head[1]));
  }
  return text.replace(
      // `${TARGET:?missing}` and its siblings (`:-`, `:+`, `:=`, `#`, `%`) are
      // the SAME variable with an operator. Matching only `${TARGET` left the
      // operator text attached, so the modelled path became
      // `apps/agent:?missing` and matched no package (#1995 r16).
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[:#%][^}]*|[-+=?][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (m, braced, bare) => {
      const v = vars.get(braced ?? bare);
      // Away from the head, a MULTIWORD value is an argument or a message and
      // is left alone. Substituting it there is exactly what reported
      // `echo "$MSG"` as a deploy — my own control caught the regression the
      // moment the value rule was widened to admit spaces.
      return v === undefined || /\s/.test(v) ? m : v;
    },
  );
}

function isShellFile(rel, text) {
  // `dash` and `ash` are POSIX shells and their names END in `sh` without a
  // word boundary before it, so a `\b(ba|z|k)?sh\b` test matched neither and
  // an extensionless `#!/bin/dash` wrapper was scanned as PROSE — its `cd` then
  // could not reach the deploy below it (#1995 r16).
  return (
    SHELL_EXTENSIONS.some((e) => rel.endsWith(e)) ||
    /^#!.*\b(?:ba|z|k|da|a)?sh\b/.test(text) ||
    /^#!.*\benv\s+(?:ba|z|k|da|a)?sh\b/.test(text)
  );
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
      // `${TARGET:?missing}` and its siblings (`:-`, `:+`, `:=`, `#`, `%`) are
      // the SAME variable with an operator. Matching only `${TARGET` left the
      // operator text attached, so the modelled path became
      // `apps/agent:?missing` and matched no package (#1995 r16).
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[:#%][^}]*|[-+=?][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (m, braced, bare) => vars.get(braced ?? bare) ?? m,
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
  // A repository SYMLINK resolves to what it points at. `cd worker` where
  // `worker -> apps/agent` is tracked puts the shell physically in the agent and
  // wrangler finds that configuration, but a purely lexical resolver recorded
  // the link name and matched no package (#1995 r16).
  //
  // Only links that exist INSIDE the tree being scanned, and only when the
  // destination stays inside it: a link out of the repository is not a scoped
  // package, and following one would attribute a deploy to a directory this
  // guard does not own.
  if (!/\$/.test(target) && !target.startsWith('/')) {
    const candidate = `${cwd ? `${cwd}/` : ''}${target}`.replace(/^\.\//, '');
    try {
      const rootReal = realpathSync(REPO_ROOT);
      const real = realpathSync(`${REPO_ROOT}/${candidate}`);
      if (real !== rootReal && real.startsWith(`${rootReal}/`)) {
        const inside = real.slice(rootReal.length + 1);
        if (inside !== candidate) return inside;
      }
    } catch {
      /* not a path in this tree */
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
 * The Worker a configuration file NAMES, or `null` when the file cannot say.
 *
 * `null` is "this file does not answer", never "this file names nothing":
 * every caller falls back to its own reasoning on `null`, so an unreadable,
 * unparseable or name-less config costs the guard nothing it had before
 * (#1996). Absence is deliberately indistinguishable from failure here —
 * wrangler has no config without a name, so a config that parses and declares
 * none is a file this scanner has misidentified rather than a Worker called
 * nothing.
 *
 * Parsed STRUCTURALLY, top level only, for the reason `keep_vars` is: the text
 * form matches inside string VALUES, so `"vars": {"NOTE": "name: x"}` would
 * name a Worker (#1995 r18). For TOML the top level ends at the first table
 * header. A name carrying a `$` is a template whose deployed value this
 * scanner cannot know, so it does not answer either.
 */
/**
 * Decode a TOML BASIC string's escape sequences, or `null` if any is invalid.
 *
 * TOML v1.0.0 defines exactly these: `\b \t \n \f \r \" \\`, `\uXXXX` and
 * `\UXXXXXXXX`. Anything else is a parse error in TOML itself, so this returns
 * `null` rather than passing the text through — a name decoded WRONGLY is worse
 * than one this scanner declines to read, because a wrong name is treated as an
 * authoritative answer.
 */
function decodeTomlBasic(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const c = raw[i + 1];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (c in simple) {
      out += simple[c];
      i += 1;
      continue;
    }
    if (c === 'u' || c === 'U') {
      const width = c === 'u' ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null;
      const cp = parseInt(hex, 16);
      // A scalar outside Unicode, or a lone surrogate, is invalid TOML.
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
      out += String.fromCodePoint(cp);
      i += 1 + width;
      continue;
    }
    return null;
  }
  return out;
}

function declaredWorkerName(absPath) {
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let name;
  if (/\.toml$/.test(absPath)) {
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) break;
      // BOTH TOML string forms. A single-quoted literal string is as valid a
      // name as a double-quoted basic one, and accepting only the latter meant
      // a perfectly ordinary config silently declined to answer.
      const m = line.match(/^\s*name\s*=\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'([^']*)')\s*(?:#.*)?$/);
      if (m) {
        // A BASIC string's ESCAPES are decoded; a LITERAL string's are not.
        // That asymmetry is TOML's, not a shortcut: `'…'` has no escape
        // sequences at all, so decoding one would corrupt a name containing a
        // backslash. Undecoded, `name = "vaipakam-agent"` — which wrangler
        // accepts and reads as `vaipakam-agent` — compared as the raw escaped
        // spelling, matched no protected Worker, and was then treated as an
        // AUTHORITATIVE unprotected answer, blessing a live deploy of the agent
        // (Codex #2036 r1). An unknown escape yields no name rather than a
        // guess, because a name this scanner has decoded WRONGLY is worse than
        // one it declines to read.
        if (m[2] !== undefined) {
          name = m[2];
        } else {
          const decoded = decodeTomlBasic(m[1]);
          if (decoded !== null) name = decoded;
        }
        break;
      }
    }
  } else {
    try {
      const cfg = parseJsonc(text);
      if (cfg !== null && typeof cfg === 'object') name = cfg.name;
    } catch {
      return null;
    }
  }
  if (typeof name !== 'string' || name === '' || /\$/.test(name)) return null;
  return name;
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
    //
    // `env` is kept because the config-identity read below CONSULTS it (#1996)
    // — not for its value, but for its presence, which is enough to make the
    // declared `name` stop being the deployed one. The strip replaces an
    // option AND its value with a single placeholder, so without the entry
    // `--env staging` vanished entirely and the suppression never fired: the
    // drift this list's own comment warns about, arriving immediately.
    ['name', 'config', 'cwd', 'dir', 'C', 'prefix', 'env'],
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
  // A NESTED SHELL's `-c` is not wrangler's `--config`. `sh -c 'cd apps/agent;
  // wrangler deploy'` had the shell's own flag read as a config path, and the
  // resulting authoritative no-scope answer suppressed BOTH the literal target
  // inside the payload and the scoped-file fallback (#1995 r16).
  //
  // Answered by REGION rather than by naming every wrapper: the option is read
  // only from wrangler's own argument text, which begins at its command word.
  //
  // BOTH spellings, not just the short one. My first cut kept `--config` on the
  // whole segment on the reasoning that the long form is unambiguous — true, but
  // a `--config` outside wrangler's argv is not wrangler's whatever it is
  // spelled, and the distinction turned out to have no observable effect: a
  // segment with no wrangler word has the whole of itself as its region, which
  // is every package-script line. Mutation showed the two forms agreeing on the
  // entire suite, so this is one rule rather than two with an untested seam.
  const wranglerRegion = (() => {
    const at = clean.search(/\bwrangler2?(?:\.(?:cmd|ps1|bat))?\b/);
    return at === -1 ? clean : clean.slice(at);
  })();
  const valueOf = (spellings, region = clean) => {
    // LAST occurrence, because that is what the CLIs do — the same rule the
    // safety flag is scored by. `pnpm --dir apps/indexer --dir apps/agent run
    // deploy` runs the AGENT script (confirmed against the pinned pnpm), and
    // taking the first match handed the guard an out-of-scope directory and
    // blessed a destructive deploy (#1995 r16).
    const all = [...region.matchAll(new RegExp(`(?<![\\w-])(?:${spellings})(?:=|\\s+)${VALUE}`, 'g'))];
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
        ? v.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:[:#%][^}]*|[-+=?][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, braced, bare) => vars.get(braced ?? bare) ?? m)
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

  // THREE SPELLINGS OF ONE SELECTOR, and `commandIsSafe` already knew two of
  // them. Adding the identity read here without them is the two-halves drift
  // this file keeps producing (Codex #2036 r1): the config reader landed in one
  // function with the option parser of the other left behind, so a deploy whose
  // config `commandIsSafe` can see was invisible to the scope decision — and an
  // invisible `--config` reaches neither the identity read nor the inversion,
  // which means it PASSES.
  const cfgRaw =
    valueOf('--config|-c', wranglerRegion) ??
    // ATTACHED SHORT FORM. yargs accepts `-cconfigs/custom.jsonc` as one word,
    // and wrangler 4.90.0 processes it — verified in the review by dry run.
    //
    // NARROWED to something that looks like a config path, and the narrowing is
    // load-bearing rather than cosmetic: this region is anchored at the wrangler
    // word but still contains whatever follows it, so a bare `-c` + rest would
    // read `tar -czf out.tgz` as selecting a config called `zf` — and under the
    // inversion an unreadable config REPORTS, so that is a CI-blocking false red
    // rather than a harmless misread. A path or a wrangler config extension is
    // what distinguishes the two.
    (() => {
      const all = [
        ...wranglerRegion.matchAll(
          /(?<![\w-])-c(?=[^\s=-])((?:"[^"]*"|'[^']*'|[^\s"'`;&|)\\]+)+)/g,
        ),
      ];
      const m = all[all.length - 1];
      if (!m) return null;
      const v = m[1].replace(/\\([\s\S])/g, '$1').replace(/["'`]/g, '');
      return v.includes('/') || /\.(?:jsonc?|toml)$/.test(v) ? v : null;
    })() ??
    // ARGV-ARRAY FORM, the spelling `commandIsSafe` learned at #1995 r23:
    // `subprocess.run(["wrangler","deploy","--config","x.jsonc"])`. The flag and
    // its value are separate array elements, so no `=` or space joins them and
    // `valueOf` sees nothing.
    (() => {
      const all = [
        ...wranglerRegion.matchAll(/["'](?:-c|--config)["']\s*,\s*["']([^"']+)["']/g),
      ];
      const m = all[all.length - 1];
      return m ? m[1] : null;
    })();
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
    // …except for a COMPUTED `--config`, which is the commonest way to select a
    // Worker this scanner cannot name and so the case the #1996 inversion is
    // for. "A target was named and I cannot say what it is" is precisely the
    // answer that must not pass silently; deferring here let
    // `wrangler deploy --config "$GENERATED"` through with no report at all.
    //
    // NARROWED to `--config` on purpose. `--cwd`/`--dir` reach the same
    // not-known state, but they are ordinary in wrappers and were not measured;
    // the zero-invocation basis this inversion rests on was counted for
    // `--config` alone. Widening to them is a separate change with its own
    // measurement, not a tidy-up of this one.
    //
    // Prose keeps deferring to the text, as below.
    if (hasCwdState && cfgRaw !== null && cfg === null) {
      return { scope: UNNAMED_SCOPE };
    }
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

  // THE CONFIG'S `name` IS THE WORKER'S IDENTITY — not the directory the file
  // happens to sit in (#1996, deferred out of #1995 r8).
  //
  // Wrangler's `getScriptName` is `args.name ?? config.name`, so a config
  // living anywhere at all and declaring `"name": "vaipakam-agent"` deploys the
  // protected agent. The directory answer below says "`configs/` is out of
  // scope" and the guard exits 0 on a destructive deploy; verified against
  // wrangler 4.90.0 in the #1995 review. Read here rather than left as a
  // recorded limit because the machinery the deferral was about — resolve a
  // path against the modelled cwd, open the file, parse JSONC, read a field —
  // was built for `keep_vars` in `commandIsSafe` during that same PR, so this
  // is now one more field out of a file already being opened.
  //
  // Authoritative when the file answers, exactly as `--name` is above: once
  // wrangler's own identity field has been read there is nothing left to guess.
  // That cuts both ways — a config UNDER a scoped directory naming a different
  // Worker deploys that different Worker, whose vars are not the protected
  // ones.
  //
  // DEGRADES SILENTLY, which is what the deferral was really about: this guard
  // runs inside `typecheck`, so a false red blocks every PR in the repo.
  // Everything that stops the file answering — a path built from a variable or
  // climbing out of the tree (already `null` by the time we are here), a file
  // absent from the checkout because it is generated at build time, one that
  // does not parse, one with no literal `name` — falls through to the directory
  // heuristic that was here before, never to a report.
  //
  // `--env` suppresses it, and that is a REAL limit rather than caution:
  // wrangler derives the deployed script name from the environment
  // (`vaipakam-agent-staging`), so the declared `name` is not what ships, and an
  // exact match against the protected set would answer "out of scope" for a
  // deploy that is squarely inside it. The directory heuristic is the safer
  // answer there and keeps its job.
  let answered = false;
  // AN ENVIRONMENT IS NOT ONLY A FLAG. Wrangler resolves it as
  // `args.env ?? getCloudflareEnv()`, so `CLOUDFLARE_ENV` selects one just as
  // `--env` does, and it then reads the environment-specific `name` — which
  // this scanner does not parse. Checking only the flags meant
  // `CLOUDFLARE_ENV=staging wrangler deploy --config x.jsonc` trusted the
  // TOP-LEVEL name, so a config whose top level names something unprotected and
  // whose `env.staging.name` is `vaipakam-agent` was answered "out of scope"
  // authoritatively (Codex #2036 r1).
  //
  // Read from the RAW segment, not from `clean`: `executedCommand` strips a
  // leading assignment as environment rather than argv, which is correct for
  // everything else and is exactly what hid this one. An empty value selects no
  // environment, hence the `\S`.
  const envAssigned = /(?:^|[\s;&|(])(?:export\s+)?CLOUDFLARE_ENV=\S/.test(
    stripShellComment(seg),
  );
  if (
    cfg !== null &&
    !envAssigned &&
    !/(?<![\w-])(?:--env|-e)(?:=|\s+)\S/.test(wranglerRegion)
  ) {
    for (const b of bases) {
      // Resolved AS WRANGLER RESOLVES IT — against the command's own working
      // directory — the same rule `commandIsSafe` follows for `keep_vars`. An
      // absolute path is outside anything this scanner can reason about.
      if (cfg.startsWith('/')) break;
      const rel = normalizeRel(`${b}/${cfg}`);
      // A path that climbs OUT of the checkout is not this repository's config
      // and must not be opened. `normalizeRel` keeps leading `..` rather than
      // clamping, so without this the scanner would read a file beside the
      // repository — outside anything it is allowed to reason about, and in the
      // fixture harness outside the temporary tree.
      //
      // EQUIVALENT MUTANT, recorded as one: an escaping path resolves to no
      // directory scope either, so removing this line changes no verdict on any
      // tree whose parent holds no wrangler config. Kept because "do not read
      // outside the checkout" is a property worth holding independently of
      // whether today's fallback happens to agree, and pinning it would mean
      // planting a file in the shared temp directory that concurrent fixture
      // roots could see.
      if (rel.startsWith('..')) continue;
      const declared = declaredWorkerName(`${REPO_ROOT}/${rel}`);
      if (declared === null) continue;
      // EXACT, or the protected name plus an environment suffix.
      //
      // The suffix half is not tidiness — without it this read was a way to
      // LOSE a report. Wrangler derives an environment's script name by
      // appending to the top-level one, so a `vaipakam-keeper-staging` config
      // sitting in `apps/keeper` deploys the keeper's staging Worker, which
      // carries the same dashboard-managed values; an exact-match-only answer
      // called that out of scope, where the directory heuristic it replaced
      // reported it. Matching the prefix errs toward reporting, which is the
      // direction to err in: the cost is a false red on a Worker that merely
      // shares the prefix, and the alternative cost is silence on a live
      // destructive deploy.
      //
      // The SEPARATOR is what stops the rule swallowing the namespace:
      // `vaipakam-keeperbot` is a different Worker, not an environment.
      const hit = SCOPED.find(
        (s) => s.workerName === declared || declared.startsWith(`${s.workerName}-`),
      );
      // KEEP SEARCHING PAST A NON-MATCH, exactly as the directory loop below
      // does. Returning on the first base that merely ANSWERED made an
      // unprotected name at one reachable cwd suppress a protected one at
      // another — "this file names no protected Worker" and "no reachable path
      // names one" collapsed into a single authoritative answer. That is the
      // one-spelling-for-two-answers defect this file has now produced three
      // times (#1995 r8's `filterScopes` is the same shape), so the loop is
      // written to the same rule as its neighbour rather than to a new one.
      if (hit) return { scope: hit };
      answered = true;
    }
  }
  // Every reachable base that could answer said the same thing: not a protected
  // Worker. That IS authoritative — wrangler has told us the identity — and it
  // is the half of this read that lets a config under a protected directory
  // name a different Worker and pass.
  if (answered) return { scope: null };

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
  // BURDEN INVERTED for a selected config this scanner could not identify.
  //
  // Everything above answers "which Worker"; this answers "what to do when
  // nothing could". Wrangler takes the identity from the config's `name`, so a
  // `--config` whose file cannot be read, parsed, or resolved is a deploy of an
  // UNKNOWN Worker — and returning "no scope" for it is the scanner asserting
  // something it does not know. The file's own rule for that is to refuse to
  // stay silent rather than to infer: the same inversion `ALLOWED` documents
  // for prose.
  //
  // MEASURED before adopting, because over-reporting is safe only while it
  // stays rare: the tree carries 132 deploy mentions and ZERO that select a
  // config, so this rule cannot produce a single report on the tree as it
  // stands. Re-measure before assuming that is still true.
  //
  // The remedy is benign, which is what makes the inversion affordable here
  // rather than an allowlist generator: `--keep-vars` is never wrong for any
  // Worker — it only preserves dashboard-managed values — so someone adding a
  // legitimate `--config` deploy fixes the report by making the command safe,
  // not by asking for an exemption.
  //
  // PROSE IS DELIBERATELY EXCLUDED: the `!hasCwdState` branch above has already
  // returned, deferring to the surrounding text, which on a runbook line is the
  // better answer and names a package the reader can act on.
  if (cfg !== null) return { scope: UNNAMED_SCOPE };
  return { scope: null };
}

/**
 * A destination the scanner cannot name. Matches nothing in `scopeOfCwd`
 * except through a static SUFFIX, so a deploy that runs there is attributed to
 * no package — which is the honest answer when the shell has been sent
 * somewhere the text does not say.
 */
const UNKNOWN_DIR = '\u0000unknown';

/**
 * Apply a SOURCED helper's directory moves to the caller's state.
 *
 * `source helper.sh` and `. helper.sh` run the file's commands in the CURRENT
 * shell — bash's `help source` says so — so a helper whose whole job is
 * `cd apps/agent` moves the caller. Neither file contains both the scope and
 * the deploy, so scanning them independently saw nothing in either (#1995 r16).
 *
 * Statically named helpers only, read from the tree the scanner is already
 * walking. A path that cannot be read contributes nothing rather than clearing
 * scope: the helper might do anything, and the caller's own `cd`s remain the
 * best evidence available.
 *
 * `depth` bounds recursion — helpers that source helpers are ordinary, helpers
 * that source each other in a cycle are not, and a guard must terminate either
 * way.
 */
function applySourcedFile(state, relPath, vars, depth = 0) {
  if (depth > 3 || !relPath || /\u0000/.test(relPath)) return state;
  let text;
  try {
    text = readFileSync(`${REPO_ROOT}/${relPath.replace(/^\.\//, '')}`, 'utf8');
  } catch {
    return state;
  }
  let cur = state;
  for (const { text: line } of logicalLines(text)) {
    for (const part of splitCommands(line)) {
      const d = dirDirective(part.text.trim());
      if (!d) continue;
      cur =
        d.kind === 'source'
          ? applySourcedFile(cur, resolveDir(cur.cwd, d.target, vars), vars, depth + 1)
          : applyDir(cur, d, vars);
    }
  }
  return cur;
}

/**
 * The UNSAFE deploy commands a sourced helper runs.
 *
 * `cd apps/agent` then `source deploy.sh`, where the helper holds
 * `wrangler deploy`, deploys the agent — but the helper's own scan has no
 * protected scope and the caller's scan discarded everything in the helper that
 * was not a directory directive, so neither file saw a violation (#1995 r16).
 *
 * Returns the commands rather than a verdict, because the SCOPE is the
 * caller's: the same helper sourced from two directories deploys two different
 * Workers, and only the caller's state says which.
 */
const sourcedDeployCache = new Map();
function sourcedDeploys(relPath, depth = 0) {
  if (depth > 3 || !relPath || /\u0000/.test(relPath)) return [];
  const key = `${depth}:${relPath}`;
  if (sourcedDeployCache.has(key)) return sourcedDeployCache.get(key);
  let out = [];
  try {
    const raw = readFileSync(`${REPO_ROOT}/${relPath.replace(/^\.\//, '')}`, 'utf8');
    // A deferred helper gets the SAME interpreter transform the top-level walk
    // applies to a file of that extension. Sending a `.cmd` body straight
    // through the POSIX scanner missed `Wrangler deploy`, which Windows runs
    // case-insensitively, and left `^` continuations unfolded (#1995 r22) —
    // the transform is a property of the FILE, and this reader had skipped it.
    const winInterp = /\.(?:cmd|bat)$/i.test(relPath)
      ? 'cmd'
      : /\.ps1$/i.test(relPath)
        ? 'pwsh'
        : null;
    const text = winInterp ? forInterpreter(raw, winInterp) : raw;
    const segs = [];
    for (const { text: line } of logicalLines(text)) {
      for (const part of splitCommands(line)) segs.push(part.text.trim());
    }
    out = unsafeWithDirs(segs, depth);
  } catch {
    out = [];
  }
  sourcedDeployCache.set(key, out);
  return out;
}

/**
 * The unsafe deploys in a helper BODY — a sourced file or a shell function —
 * each carrying the directory directives that precede it there.
 *
 * Returning bare command text lost the helper's own moves: a caller in
 * `apps/indexer` sourcing a helper that runs `cd ../agent; wrangler deploy`
 * deploys the AGENT, but every returned deploy was scored against the
 * caller's entry state, so the guard exited 0 (#1995 r17). The dirs are
 * applied to the caller's reachable states at the call site, because the same
 * helper invoked from two directories still lands two different places.
 */
/** Net `{`/`}` count — how much deeper a segment leaves a function body. */
function braceDelta(t) {
  return (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
}

function unsafeWithDirs(segs, depth = 0) {
  const dirs = [];
  const out = [];
  for (const seg of segs) {
    const d = dirDirective(seg);
    if (d?.kind === 'source') {
      out.push(
        ...sourcedDeploys(resolveDir('', d.target, null), depth + 1).map((e) => ({
          cmd: e.cmd,
          dirs: [...dirs, ...e.dirs],
        })),
      );
      continue;
    }
    if (d) {
      dirs.push(d);
      continue;
    }
    const isDeploy =
      new RegExp(ANY_DEPLOY_RE).test(seg) || new RegExp(ANY_DEPLOY_RE).test(dequote(seg));
    if (isDeploy && !commandIsSafe(seg)) out.push({ cmd: seg, dirs: [...dirs] });
  }
  return out;
}

/** Apply one directory directive to one reachable state. */
function applyDir(state, dir, vars = null) {
  if (dir.kind === 'source') {
    return applySourcedFile(state, resolveDir(state.cwd, dir.target, vars), vars);
  }
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
  // The wrapped command runs elsewhere; the SHELL does not move. Modelled as a
  // no-op transition so the segment's own scope resolution can use the target
  // without the rest of the line inheriting it.
  if (dir.kind === 'env-chdir') return state;
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
  // `env -C DIR cmd` / `env --chdir=DIR cmd` runs the WRAPPED command in DIR
  // and leaves the shell where it was, which is why it is answered here as a
  // per-segment fact rather than as a directive that moves the state (#1995
  // r16). GNU env documents the option; the selector logic modelled pnpm's and
  // wrangler's cwd options and not this wrapper's.
  // The short option's value may be ATTACHED — `env -C"$TARGET" wrangler
  // deploy` and `env -Capps/agent pwd` are both accepted by GNU env, which
  // documents `-C, --chdir=DIR` — but requiring a space or `=` after `-C`
  // missed the attached spelling entirely (#1995 r21). Captured as a WORD so
  // an attached QUOTED value stays one argument.
  const envChdir = seg.match(
    new RegExp(
      String.raw`(?:^|\s)env\s+(?:-[A-Za-z]+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:--chdir[= ]\s*|-C[= ]?\s*)(${WORD})`,
    ),
  );
  if (envChdir) return { kind: 'env-chdir', target: dequote(envChdir[1]) };
  // A `case` ARM LABEL sits in front of the command the same way `then` does —
  // `splitCommands` hands this function `agent) cd ../agent`, and a prefix
  // grammar that knew only the control words left the move unrecorded (#1995
  // r16).
  //
  // A `(` is deliberately NOT here. An opener whose group closes in the same
  // segment nets zero depth, so the restore never fires and the move would leak
  // into the parent — the r6/r12/r13 fixtures say exactly that. The caller
  // strips the opener only when the group STAYS OPEN, which is the case where
  // the depth machinery will put the parent state back.
  const LEAD = String.raw`(?:(?:then|do|else)\s+)*(?:[A-Za-z0-9_*?.\[\]-]+\)\s+)?(?:\{\s+)?(?:(?:builtin|command)\s+)?`;
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
  // `source <file>` / `. <file>` runs the file IN THIS SHELL.
  const sourced = seg.match(new RegExp(`^${LEAD}(?:source|\\.)\\s+(${WORD})`));
  if (sourced) return { kind: 'source', target: dequote(sourced[1]) };
  const winCd = seg.match(
    new RegExp(
      `^${LEAD}(?:Set-Location|Push-Location|chdir|sl)\\s+(?:-(?:Literal)?Path\\s+)?(${WORD})`,
      'i',
    ),
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
/**
 * Contiguous runs of INDENTED lines, as one shell block each.
 *
 * Two shapes need this and neither was reached (#1995 r16):
 *   - CommonMark's four-space indented code block, the fence-free spelling of
 *     the same copyable example. `cd apps/agent` and `wrangler deploy` stayed
 *     independent prose lines, so the first line's directory could not reach
 *     the second.
 *   - A Makefile recipe, whose lines start with a TAB and whose `\`
 *     continuations GNU Make preserves — `cd apps/agent && \` then `wrangler
 *     deploy` is one command, and each physical line alone says nothing.
 *
 * Only blocks that actually CONTAIN a deploy are emitted. An indented run is
 * otherwise indistinguishable from indented prose, and scanning every one of
 * them would put paragraph text through a shell parser — the r27 mistake,
 * which cost four false positives on a clean tree.
 *
 * Dropping that condition is an EQUIVALENT MUTANT as the code stands, and is
 * recorded as one rather than given a fixture that would only look like
 * coverage: a block with no deploy in either its raw or its dequoted form
 * contributes no reportable line, and blocks share no state. It is kept as a
 * bound on how much text reaches the shell parser at all, which is a property
 * of the blast radius rather than of any one verdict.
 *
 * The DEQUOTED half of the condition is NOT equivalent — mutation showed it
 * changing a verdict — and has its own fixture.
 *
 * The common indent is stripped so `logicalLines` sees ordinary commands, and
 * each line keeps the number of the physical line it came from.
 */
function indentedBlocks(lines, indentRe, startAt = 0) {
  const out = [];
  let i = startAt;
  let blockId = 0;
  while (i < lines.length) {
    if (!indentRe.test(lines[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && (indentRe.test(lines[j]) || lines[j].trim() === '')) j += 1;
    // Trailing blank lines belong to the prose after the block, not to it.
    let end = j;
    while (end > i && lines[end - 1].trim() === '') end -= 1;
    const body = lines.slice(i, end);
    // The DEQUOTED form too, the r9 rule: `wrang"ler" deploy` is a deploy and
    // a raw-text-only filter skipped the block that contained it — the same
    // composition defect the prefilter had, in the newer reader. Found by
    // mutation: widening the filter changed a verdict, which a filter that was
    // only a blast-radius bound could not have done.
    if (
      body.some(
        (l) => new RegExp(ANY_DEPLOY_RE).test(l) || new RegExp(ANY_DEPLOY_RE).test(dequote(l)),
      )
    ) {
      const strip = Math.min(
        ...body.filter((l) => l.trim() !== '').map((l) => (l.match(/^[ \t]*/) ?? [''])[0].length),
      );
      out.push(
        ...offset(
          logicalLines(body.map((l) => l.slice(strip)).join('\n')),
          i,
          `indent${blockId}`,
        ),
      );
      blockId += 1;
    }
    i = j;
  }
  return out;
}

/**
 * Makefile recipes, as the sub-shells Make actually runs.
 *
 * Two corrections in one place (#1995 r16), because they are the same question
 * — WHICH LINES SHARE A SHELL — answered in both directions:
 *
 *   - Without `.ONESHELL:`, GNU Make runs EACH recipe line in its own shell, so
 *     `cd apps/agent` on one line and `wrangler deploy` on the next do NOT share
 *     a directory. Grouping every tabbed run reported an agent deploy that runs
 *     from the repo root — a false red. Only backslash-continued lines are one
 *     command there, and `logicalLines` already folds those.
 *   - With `.ONESHELL:`, the whole recipe IS one shell, and the ordinary `@`
 *     prefix on the first line left the directive reading `@cd`, so the move was
 *     never recorded.
 *
 * `@`, `-` and `+` are Make's recipe-control prefixes and are stripped either
 * way; they are not part of the command.
 */
function makefileBlocks(text) {
  const oneshell = /^\s*\.ONESHELL:/m.test(text);
  // `WORKER := apps/agent` then `cd $(WORKER)` deploys from the protected
  // package — Make expands the variable before the shell sees the recipe, but
  // the scanner received `$(WORKER)` and modelled an unknown directory, so the
  // bare deploy under it passed (#1995 r17). Literal values only, last
  // assignment wins, `?=` yields to an existing one, and a computed value
  // CLEARS the name — the same rules the shell-variable model follows.
  // Collected over the whole file because recursive `=` variables resolve at
  // use, not at definition.
  const mkVars = new Map();
  for (const l of text.split('\n')) {
    if (/^\t/.test(l)) continue;
    const m = l.match(/^([A-Za-z_]\w*)\s*(\?=|:{1,2}=|=)\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[2] === '?=' && mkVars.has(m[1])) continue;
    if (/\$/.test(m[3])) mkVars.delete(m[1]);
    else mkVars.set(m[1], m[3]);
  }
  const expandMk = (l) =>
    l.replace(/\$[({]([A-Za-z_]\w*)[)}]/g, (m0, n) => mkVars.get(n) ?? m0);
  const lines = text
    .split('\n')
    .map((l) => (/^\t/.test(l) ? expandMk(l.replace(/^(\t+)[@+-]+\s*/, '$1')) : l));
  if (oneshell) return indentedBlocks(lines, /^\t/);
  // One block per PHYSICAL recipe line, so nothing carries between them. A
  // backslash continuation is still one command and `logicalLines` folds it,
  // which is why the run is walked rather than each line taken alone.
  const out = [];
  let i = 0;
  let blockId = 0;
  while (i < lines.length) {
    if (!/^\t/.test(lines[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && /\\\s*$/.test(lines[j])) j += 1;
    const body = lines.slice(i, j + 1);
    if (body.some((l) => new RegExp(ANY_DEPLOY_RE).test(l) || new RegExp(ANY_DEPLOY_RE).test(dequote(l)))) {
      out.push(
        ...offset(logicalLines(body.map((l) => l.replace(/^\t+/, '')).join('\n')), i, `mk${blockId}`),
      );
      blockId += 1;
    }
    i = j + 1;
  }
  return out;
}

/**
 * Substitute statically declared Actions `env` values into a run body.
 *
 * `env: { DEPLOY_CMD: wrangler deploy }` then `run: ${{ env.DEPLOY_CMD }}` is
 * substituted by Actions BEFORE the shell starts, so the body the runner
 * executes contains the deploy — but the scanner read the unresolved
 * expression and saw nothing (#1995 r17). Unknown names stay as written: an
 * expression this cannot resolve carries no command text either way, and
 * blanking it would only move the miss.
 */
/** Drop a leading YAML anchor/alias/tag property — YAML hands the node on. */
function stripYamlProps(v) {
  return v.replace(/^(?:[&*][\w-]+\s+|!!?[\w:.-]*\s+)+/, '');
}

/**
 * `ctx['key']` is `ctx.key`. Actions accepts both spellings for every context,
 * and SEVEN matchers in this file recognise only the dot form — so an indexed
 * reference fell through to the unknown-expression rule, which blanks the whole
 * value, and a step running from a protected directory scoped nothing
 * (#1995 r22).
 *
 * Done as a NORMALISATION at each reader's entry rather than by widening seven
 * patterns: one rule, in one place, and the alternative is seven chances to
 * write it differently — which is precisely how the three `run:` ingest points
 * drifted apart earlier in this PR.
 *
 * Only the contexts this file resolves, and only a literal key: `matrix[x]`
 * names a key computed at runtime, which is not answerable from the text.
 */
/**
 * The body of a nested flow mapping — `with: { … }` — by BRACE BALANCE, with
 * `${{ … }}` treated as opaque and quotes respected.
 *
 * A `[^}]*` capture ends at the first `}` of an expression's `}}`, which
 * truncates the mapping mid-value (#1995 r22). Returns null when no balanced
 * mapping is found, which the caller reads as "no inputs" exactly as before.
 */
function flowMappingBody(text, key) {
  const open = new RegExp(String.raw`["']?${key}["']?:\s*\{`).exec(text);
  if (!open) return null;
  let i = open.index + open[0].length;
  const start = i;
  let depth = 1;
  let quote = null;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (text.startsWith('${{', i)) {
      const end = text.indexOf('}}', i + 3);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? text.slice(start, i - 1) : null;
}

/**
 * An action step's (directory, command) pairs, held to their matrix LEG.
 *
 * Returns null when leg pairing does not apply — either input carries no
 * matrix reference, or no `include:` leg defines every key both of them use —
 * and the caller then keeps the cross-product behaviour, which is correct for
 * plain axis lists because every combination really does run.
 */
function actionMatrixLegPairs(lines, runIdx, rawWd, rawCmd) {
  const MREF = /\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g;
  const wdRaw = normalizeCtxRefs(rawWd ?? '');
  const cmdRaw = normalizeCtxRefs(rawCmd ?? '');
  const keysOf = (t) => [...t.matchAll(MREF)].map((m) => m[1]);
  const wdKeys = keysOf(wdRaw);
  const cmdKeys = keysOf(cmdRaw);
  if (wdKeys.length === 0 || cmdKeys.length === 0) return null;
  const needed = [...new Set([...wdKeys, ...cmdKeys])];
  const legs = matrixIncludeLegs(lines, runIdx).filter((l) => needed.every((k) => l.has(k)));
  if (legs.length === 0) return null;
  const sub = (t, leg) => t.replace(MREF, (m0, k) => leg.get(k) ?? m0);
  return legs.map((leg) => ({ wd: sub(wdRaw, leg), cmd: sub(cmdRaw, leg) }));
}

function normalizeCtxRefs(text) {
  if (!text || !text.includes('[')) return text;
  return text.replace(
    /(\$\{\{\s*(?:env|matrix|inputs|github|vars|secrets|needs|steps|inputs)\s*)\[\s*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)')\s*\]/g,
    (_m, head, dq, sq) => `${head}.${dq ?? sq}`,
  );
}

function expandActionsEnv(body, envMap) {
  const src = normalizeCtxRefs(body);
  if (!envMap || envMap.size === 0 || !/\$\{\{/.test(src)) return src;
  return src.replace(
    /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (m0, n) => envMap.get(n) ?? m0,
  );
}

function embeddedShellLines(text, isYaml = false, isMarkdown = false) {
  const lines = text.split('\n');
  const out = [];
  // CommonMark's indented code block is the fence-free spelling of the same
  // copyable example, and only fenced ones were grouped (#1995 r16). Markdown
  // only: in YAML and JSON an indented run is ordinary structure, and putting
  // those through a shell parser is the r27 mistake.
  if (isMarkdown) out.push(...indentedBlocks(lines, /^ {4,}\S/));
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
    // `&anchor` / `*alias` / `!!tag` may sit between the key and the block
    // indicator — `- run: &deploy |` is a valid step — and rejecting the line
    // sent the whole block down the flow-scalar path, where the indicator, the
    // `cd` and the deploy folded into ordinary text (#1995 r16).
    // `"run"` is the same mapping key after YAML parsing, and an unquoted-only
    // matcher never extracted the block, so the step's working-directory was
    // never associated with the deploy inside it (#1995 r16).
    //
    // The FLOW matcher below carries the same quoting, and the two mask each
    // other: reverting this one alone changes no verdict, because the flow path
    // then claims `"run": |` and treats the `|` as its scalar. Measured by
    // reverting both, which does break it. Kept here because a block scalar is
    // a block, and the flow path handling it is an accident rather than the
    // model — a fixture cannot tell them apart, so this says so instead.
    // The property items require a trailing `\s+`, not `\s*`: YAML separates
    // a tag or anchor from its node with whitespace, and with every part of
    // the tag item optional a run of `!!` could be split between one `!!` tag
    // and two `!` tags in 2^n ways — `run:!` followed by repeated `!!` and no
    // indicator took 13 s at twenty repetitions (CodeQL js/redos, alert 1958).
    // Mandatory whitespace makes the split deterministic. The only strings
    // this stops matching are `run:!|` shapes that glue the property to the
    // indicator — not a mapping to YAML in the first place.
    const run = lines[i].match(
      /^(\s*)(?:-\s+)?["']?run["']?:\s*(?:[&*][\w-]+\s+|!!?[\w:.-]*\s+)*([|>])(?:[-+]?\d?|\d?[-+]?)\s*(?:#.*)?$/,
    );
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
      isYaml && !run ? lines[i].match(/^(\s*)(?:-\s+)?["']?run["']?:[ \t]+(\S.*)$/) : null;
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
      // A non-shell step is not scanned as SHELL, but it can still LAUNCH the
      // deploy: `shell: python {0}` with `subprocess.run(["wrangler","deploy"])`
      // is a real deployment, and dropping the block left the argv text to the
      // physical-line scan, which has no working directory to attribute it to
      // (#1995 r16). The block is kept when the body carries an argv-shaped
      // invocation, so the step's `working-directory` still reaches it.
      //
      // Shell state is not modelled for those bodies and does not need to be —
      // an argv call names its own executable and arguments, and what the guard
      // needs from the step is WHERE it runs.
      const launchesDeploy = launchesDeployText(body);
      if (
        !isYaml ||
        ((stepIsShell(lines, i) || launchesDeploy) && !stepIsDisabled(lines, i))
      ) {
        const interp = isYaml ? stepShellName(lines, i) : null;
        const env = isYaml ? stepEnvVars(lines, i) : null;
        const base = expandActionsEnv(body, env);
        const wd0 = isYaml ? workingDirFor(lines, i, !launchesDeploy) : '';
        // One block per matrix expansion of the body (#1995 r19); a body
        // carrying no resolvable matrix expression is its own single variant.
        for (const b of (isYaml ? expandMatrixVariants(lines, i, base) : null) ?? [base]) {
          out.push(...offset(logicalLines(forInterpreter(b, interp)), start, blockId, wd0, env));
          blockId += 1;
        }
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
      // The same allowance as the block path: a non-shell step can still LAUNCH
      // the deploy, and what the guard needs from it is WHERE it runs. Adding it
      // to one ingest point and not the others is how this file drifts, and a
      // single-line `run:` is exactly where the argv spelling fits.
      const flowLaunches = launchesDeployText(flow[2]);
      if (
        end === i &&
        isYaml &&
        (stepIsShell(lines, i) || flowLaunches) &&
        !stepIsDisabled(lines, i)
      ) {
        const wd = workingDirFor(lines, i, !flowLaunches);
        // An inline step with NO working-directory was dropped entirely, so
        // its body never reached `forInterpreter` — and a Windows step needs
        // that transform to be read at all: `wrangler.cmd deploy --config
        // apps\agent\wrangler.jsonc` names the package only once the
        // backslashes are separators. The physical-line scan that would
        // otherwise judge it does not know the interpreter, which is why the
        // identical body passed inline and failed as a block scalar (#1995
        // r20). Emitted with an empty cwd, where the command's own selectors
        // establish scope; the duplicate with the physical line is removed by
        // the dedupe at the reporting site, as it already is for a seeded one.
        const stepInterp = stepShellName(lines, i);
        const needsTransform =
          stepInterp === 'cmd' || stepInterp === 'pwsh' || stepInterp === 'powershell';
        if (wd || needsTransform) {
          const env = stepEnvVars(lines, i);
          const base = expandActionsEnv(flow[2], env);
          for (const b of expandMatrixVariants(lines, i, base) ?? [base]) {
            out.push(
              ...offset(logicalLines(forInterpreter(b, stepInterp)), i, blockId, wd, env),
            );
            blockId += 1;
          }
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
        const multiLaunches = launchesDeployText(foldFlowScalar(parts, q));
        if (
          !isYaml ||
          ((stepIsShell(lines, i) || multiLaunches) && !stepIsDisabled(lines, i))
        ) {
          const env = isYaml ? stepEnvVars(lines, i) : null;
          const base = expandActionsEnv(foldFlowScalar(parts, q), env);
          const wd0 = isYaml ? workingDirFor(lines, i, !multiLaunches) : '';
          for (const b of (isYaml ? expandMatrixVariants(lines, i, base) : null) ?? [base]) {
            out.push(
              ...offset(
                logicalLines(forInterpreter(b, isYaml ? stepShellName(lines, i) : null)),
                i,
                blockId,
                wd0,
                env,
              ),
            );
            blockId += 1;
          }
        }
        i = end + 1;
        continue;
      }
    }
    // A step written as a FLOW mapping — `- { name: deploy, run: wrangler
    // deploy }` — is the same step YAML-wise, but the start-anchored `run:`
    // matchers above cannot see a mid-mapping key, so the job's default
    // working-directory never reached the command (#1995 r17). Values are read
    // with the same quote alternatives the block form gets; a step key present
    // in the braces wins over the step-level readers, which cannot see it.
    const flowStep = isYaml && !run && !flow ? lines[i].match(/^\s*-\s*\{(.*)\}\s*$/) : null;
    if (flowStep) {
      // Keys are located on a SCRUBBED copy — quoted spans blanked, except a
      // quoted KEY (a span a colon follows) — and values are then read from
      // the original at that position. Searching the raw text let mapping-like
      // text INSIDE a quoted value create a field: `name: "note, run: wrangler
      // deploy"` runs nothing, but a synthetic `run` was extracted from it and
      // the guard blocked a workflow with no command at all (#1995 r18).
      const scrub = flowStep[1].replace(/"[^"]*"(?!\s*:)|'[^']*'(?!\s*:)/g, (m) =>
        ' '.repeat(m.length),
      );
      const flowValue = (key) => {
        const km = new RegExp(`(?:^|[,{\\s])["']?${key}["']?:`).exec(scrub);
        if (!km) return null;
        let at = km.index + km[0].length;
        while (flowStep[1][at] === ' ') at += 1;
        const q = flowStep[1][at] === '"' || flowStep[1][at] === "'" ? flowStep[1][at] : null;
        if (q) {
          const close = flowStep[1].indexOf(q, at + 1);
          return close === -1 ? null : flowStep[1].slice(at + 1, close);
        }
        let end = at;
        while (end < flowStep[1].length && !/[,}]/.test(scrub[end])) end += 1;
        return flowStep[1].slice(at, end).trim() || null;
      };
      // A flow-mapped ACTION step deploys with no `run:` key at all —
      // `- { uses: cloudflare/wrangler-action@v3, with: { … } }` — and the
      // block-form `uses:` matcher below is line-anchored, so the whole step
      // was invisible (#1995 r18). Same synthesis as the block form.
      const flowUses = flowValue('uses');
      if (flowUses && /^cloudflare\/wrangler-action(?:@|$)/.test(flowUses.trim())) {
        const disabledF = flowValue('if');
        const isOff = disabledF
          ? /^(?:false|\$\{\{\s*false\s*\}\})$/.test(disabledF.replace(/\s+#.*$/, '').trim())
          : stepIsDisabled(lines, i);
        if (!isOff) {
          // BRACE-BALANCED, and an expression is opaque. `[^}]*` ended at the
          // first `}` of a `${{ … }}` inside the mapping, so a nested
          // `with:` carrying an expression produced a truncated command that
          // could not then be expanded (#1995 r22).
          const withBody = flowMappingBody(flowStep[1], 'with');
          const inWith = (key) =>
            withBody === null
              ? []
              : (withBody
                  .match(
                    new RegExp(
                      `["']?${key}["']?:\\s*(?:"([^"]*)"|'([^']*)'|((?:\\$\\{\\{[^}]*\\}\\}|[^,}])+))`,
                    ),
                  )
                  ?.slice(1) ?? []);
          const wm = inWith('workingDirectory');
          const cm = inWith('command');
          const cmdF = cm[0] ?? cm[1] ?? cm[2] ?? null;
          const wdF = wm[0] ?? wm[1] ?? wm[2] ?? null;
          const cleanCmdF = cmdF === null ? 'deploy' : stripYamlProps(cmdF.trim());
          const cwdF = wdF === null ? '' : workingDirFor(lines, i, false, wdF.trim());
          // Same expression resolution as the block-style action step above
          // (#1995 r21) — this is the flow spelling of one configuration, and
          // giving it to one and not the other is how this file drifts.
          const envF = stepEnvVars(lines, i);
          // Same leg pairing as the block-style action step (#1995 r22).
          const legPairsF = actionMatrixLegPairs(lines, i, wdF, cleanCmdF);
          if (legPairsF) {
            for (const p of legPairsF) {
              out.push(
                ...offset(
                  logicalLines(`wrangler ${p.cmd}`),
                  i,
                  blockId,
                  workingDirFor(lines, i, false, p.wd) ?? '',
                  null,
                ),
              );
              blockId += 1;
            }
          } else {
            const baseF = expandActionsEnv(cleanCmdF, envF);
            for (const variant of expandMatrixVariants(lines, i, baseF) ?? [baseF]) {
              out.push(
                ...offset(logicalLines(`wrangler ${variant}`), i, blockId, cwdF ?? '', null),
              );
              blockId += 1;
            }
          }
        }
        i += 1;
        continue;
      }
      const runV = flowValue('run');
      if (runV) {
        const body = runV.trim();
        const shellName = flowValue('shell')?.trim() ?? null;
        const ifV = flowValue('if');
        const isShell = shellName
          ? SHELL_KEYWORDS.has(interpreterOf(shellName))
          : stepIsShell(lines, i);
        const disabled = ifV
          ? /^(?:false|\$\{\{\s*false\s*\}\})$/.test(ifV.replace(/\s+#.*$/, '').trim())
          : stepIsDisabled(lines, i);
        const launches = launchesDeployText(body);
        const wd = flowValue('working-directory')?.trim() ?? workingDirFor(lines, i, !launches);
        const flowInterp = shellName ? interpreterOf(shellName) : stepShellName(lines, i);
        // The same allowance the BLOCK-style inline step got at r20, which
        // this branch did not receive: with no working-directory the step was
        // dropped before `forInterpreter` could run, and a Windows body needs
        // that transform to name a package at all — `wrangler.cmd deploy
        // --config apps\agent\wrangler.jsonc` is agent-scoped only once the
        // backslashes are separators. So the identical body was caught
        // block-style and passed flow-mapped (#1995 r21). Empty cwd; the
        // command's own selectors establish scope, and the duplicate with the
        // physical line is removed by the reporting dedupe.
        const flowNeedsTransform =
          flowInterp === 'cmd' || flowInterp === 'pwsh' || flowInterp === 'powershell';
        if ((isShell || launches) && !disabled && (wd || flowNeedsTransform)) {
          const env = stepEnvVars(lines, i);
          const base = expandActionsEnv(body, env);
          for (const b of expandMatrixVariants(lines, i, base) ?? [base]) {
            out.push(...offset(logicalLines(forInterpreter(b, flowInterp)), i, blockId, wd, env));
            blockId += 1;
          }
        }
      }
      i += 1;
      continue;
    }
    // `cloudflare/wrangler-action` deploys WITHOUT any `run:` — the action
    // invokes wrangler itself from its `with:` inputs, defaulting the command
    // to `deploy` — so no line matched a deploy pattern and the workflow was
    // discarded before this loop ever saw it (#1995 r17). The step is read
    // into the synthetic command it performs and scored by the ordinary
    // machinery: `--keep-vars` in `command:` blesses it, a bare one is
    // reported at the `uses:` line. `workingDirectory` is taken literally; an
    // expression there stays unresolved rather than guessed.
    const usesAction = isYaml
      ? lines[i].match(
          /^\s*(?:-\s+)?["']?uses["']?:\s*["']?cloudflare\/wrangler-action(?:@[^\s"']*)?["']?\s*$/,
        )
      : null;
    if (usesAction && !stepIsDisabled(lines, i)) {
      const step = stepBounds(lines, i);
      let cmd = null;
      let wd = null;
      if (step) {
        for (let k = step.start; k < step.end && k < lines.length; k += 1) {
          const cm = lines[k].match(
            /^(\s*)["']?command["']?:\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/,
          );
          if (cm && cmd === null) {
            const rawCmd = (cm[2] ?? cm[3] ?? cm[4]).replace(/\s+#.*$/, '').trim();
            // A BLOCK-SCALAR command: `command: |` runs each following line as
            // its own wrangler invocation, and the one-line capture took the
            // scalar MARKER as the command — so the synthesised text carried
            // no deploy and the guard passed a bare scoped one (#1995 r19). A
            // folded scalar (`>`) is one command, joined the way YAML folds it.
            const bs = rawCmd.match(/^([|>])(?:[-+]?\d?|\d?[-+]?)$/);
            if (bs) {
              const bodyLines = [];
              for (let b = k + 1; b < step.end && b < lines.length; b += 1) {
                if (lines[b].trim() === '') continue;
                if (((lines[b].match(/^\s*/) ?? [''])[0]).length <= cm[1].length) break;
                bodyLines.push(lines[b].trim());
              }
              cmd = bs[1] === '>' ? bodyLines.join(' ') : bodyLines.join('\n');
            } else {
              cmd = rawCmd;
            }
          }
          // Rest-of-line, not `\S+`: an expression value contains spaces, and
          // the one-token capture kept only `${{` — the r11 working-directory
          // defect, repeated in the reader written after it (#1995 r18).
          const wm = lines[k].match(
            /^\s*["']?workingDirectory["']?:\s*(?:"([^"]*)"|'([^']*)'|(\S.*))$/,
          );
          if (wm && wd === null) {
            wd = (wm[1] ?? wm[2] ?? wm[3]).replace(/\s+#.*$/, '').trim();
          }
          const fcm = lines[k].match(
            /with:\s*\{[^}]*["']?command["']?:\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/,
          );
          if (fcm && cmd === null) cmd = (fcm[1] ?? fcm[2] ?? fcm[3]).trim();
          const fwm = lines[k].match(
            /with:\s*\{[^}]*["']?workingDirectory["']?:\s*(?:"([^"]*)"|'([^']*)'|([^,}\s]+))/,
          );
          if (fwm && wd === null) wd = fwm[1] ?? fwm[2] ?? fwm[3];
        }
      }
      const cleanCmd = cmd === null ? 'deploy' : stripYamlProps(cmd);
      // No shell legs to correlate on an action step, and the input may carry
      // an expression or an anchor — both resolve exactly as the step key
      // would (#1995 r18).
      const cwd = wd === null ? '' : workingDirFor(lines, i, false, wd);
      // EACH line of a multiline command is its own `wrangler <line>` — that
      // is how the action executes a block-scalar input — so each gets the
      // prefix, not just the first (#1995 r19).
      // The command input is an EXPRESSION as often as the directory is:
      // `command: ${{ matrix.cmd }}` with `cmd: deploy` synthesised the
      // literal `wrangler ${{ matrix.cmd }}`, which carries no deploy — the
      // directory half had this resolution since r18 and the command half
      // never got it (#1995 r21). Same resolvers, so the two halves cannot
      // drift apart again.
      const actEnv = stepEnvVars(lines, i);
      const synthOf = (variant) =>
        variant
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => `wrangler ${c}`)
          .join('\n') || 'wrangler deploy';
      // Matrix LEGS first: a directory and a command drawn from the same
      // `include:` entry travel together, and crossing them invents a
      // combination the workflow never runs (#1995 r22).
      const legPairs = actionMatrixLegPairs(lines, i, wd, cleanCmd);
      if (legPairs) {
        for (const p of legPairs) {
          out.push(
            ...offset(
              logicalLines(synthOf(p.cmd)),
              i,
              blockId,
              workingDirFor(lines, i, false, p.wd) ?? '',
              null,
            ),
          );
          blockId += 1;
        }
        i += 1;
        continue;
      }
      const cmdBase = expandActionsEnv(cleanCmd, actEnv);
      for (const variant of expandMatrixVariants(lines, i, cmdBase) ?? [cmdBase]) {
        out.push(...offset(logicalLines(synthOf(variant)), i, blockId, cwd ?? '', null));
        blockId += 1;
      }
      i += 1;
      continue;
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
function offset(block, start, blockId, cwd = '', env = null) {
  return block.map((l) => ({
    text: l.text,
    line: l.line + start,
    block: blockId,
    cwd,
    env,
  }));
}

/**
 * The literal `env` a workflow step actually runs with.
 *
 * Actions EXPORTS these, so `cd "$DEPLOY_DIR"` in the body resolves against
 * them — but each block cleared `shellVars` and seeded nothing, so the variable
 * was unknown and the modelled cwd went with it (#1995 r16).
 *
 * Workflow, then job, then step, so the NEAREST declaration wins the same way
 * `workingDirFor`'s own reader resolves it.
 *
 * An unresolvable `${{ … }}` substitutes EMPTY rather than voiding the whole
 * value — the same rule the working-directory resolver takes, and for the same
 * reason: the LITERAL segments still identify the package. `${{ env.X }}/apps/agent`
 * is the agent whatever X holds.
 *
 * My first cut refused any value carrying an expression. Mutation showed that
 * choice was observable and WRONG rather than merely cautious: `resolveDir`
 * keeps a static suffix after an unknown prefix, so refusing the value lost a
 * package the path names outright.
 */
function stepEnvVars(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const out = new Map();
  const jobsIdx = lines.findIndex((l) => /^\s*jobs:\s*$/.test(l));
  const topIndent = jobsIdx >= 0 ? indentOf(lines[jobsIdx]) : 0;
  const step = stepBounds(lines, runIdx);
  const job = jobBounds(lines, runIdx);
  const levels = [
    [0, lines.length, topIndent],
    job && [job.start, job.end, job.indent + 2],
    step && [step.start, step.end, step.keyIndent],
  ].filter(Boolean);
  for (const [from, to, atIndent] of levels) {
    for (let i = from; i < to && i < lines.length; i += 1) {
      if (!/^\s*env:\s*$/.test(lines[i]) || indentOf(lines[i]) !== atIndent) continue;
      const ei = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) <= ei) break;
        // The unquoted alternative admits an EXPRESSION, which contains
        // spaces. `\S+` stopped at the space inside `${{ env.X }}` and the
        // whole value then failed to match, so the binding was never recorded —
        // the identical defect the `working-directory` pattern had two rounds
        // ago, in the reader written after it.
        // Two linear steps — take the rest of the line, then unquote or strip
        // the ` #` comment — rather than one alternation. The alternation form
        // went exponential once already (CodeQL js/redos, alert 1957), and its
        // repaired version still refused an unquoted MULTIWORD value, so
        // `DEPLOY_CMD: wrangler deploy` was never recorded and the run body
        // `${{ env.DEPLOY_CMD }}` expanded to nothing (#1995 r17). A plain
        // scalar with spaces is ordinary YAML, and command values are exactly
        // where they appear.
        const kv = lines[j].match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)$/);
        let raw = null;
        if (kv) {
          const v = kv[2].trim();
          if (v[0] === '"' || v[0] === "'") {
            const close = v.indexOf(v[0], 1);
            raw = close > 0 ? v.slice(1, close) : null;
          } else {
            raw = v.replace(/\s+#.*$/, '').trim() || null;
          }
        }
        // Empty components are dropped, which is what `normalizePath` does for
        // a working-directory: an expression that expanded to nothing leaves a
        // separator behind, and `${{ env.X }}/apps/agent` is the agent rather
        // than an absolute path that happens to end in it.
        //
        // Dropping them is an EQUIVALENT MUTANT and recorded as one — the same
        // equivalence `normalizePath`'s root-climb guard carries, for the same
        // reason: `scopeOfCwd` matches a package on a `/` boundary anywhere in
        // the path, so `/apps/agent` and `apps/agent` reach the same verdict.
        // Kept because the normalised form is the faithful one.
        const value = raw
          ? raw
              .replace(/\$\{\{[^}]*\}\}/g, '')
              .split('/')
              .filter((part) => part !== '' && part !== '.')
              .join('/')
          : raw;
        if (kv && value) out.set(kv[1], value);
      }
    }
  }
  return out.size > 0 ? out : null;
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
// The POSIX families a runner may have, not just the two Actions documents by
// name: a `shell: zsh {0}` template really does execute the body, and treating
// it as non-shell dropped the block (#1995 r16). Same list `isShellFile` uses
// for shebangs, which is where the omission showed as an inconsistency.
const SHELL_KEYWORDS = new Set([
  'bash',
  'sh',
  'zsh',
  'ksh',
  'dash',
  'ash',
  'pwsh',
  'powershell',
  'cmd',
]);

/**
 * The declared values a `shell:` matrix expression can take.
 *
 * ANY leg being a shell is enough to scan: the guard must see the body if even
 * one leg executes it. Reusing `workingDirFor`'s resolver was not an option —
 * that one answers "which value lands in a scoped package", which is the wrong
 * question for an interpreter name.
 */
/**
 * The interpreter a `shell:` value names.
 *
 * The first token, BASENAMED: `shell: "/bin/bash -e {0}"` is a valid template
 * and an exact-token test classified `/bin/bash` as non-shell, skipping the run
 * body of a real deploy (#1995 r16).
 */
function interpreterOf(value) {
  let words = value.trim().split(/\s+/).filter(Boolean);
  // `env` RUNS a command: `/usr/bin/env bash -e {0}` is bash. Reading the first
  // token alone answered `env` and skipped a real deploy's body (#1995 r16).
  // Its own options and any `NAME=value` assignments are stepped over, which is
  // what `env --help` documents its command form as accepting.
  // The counter is an EQUIVALENT MUTANT and is recorded as one rather than
  // fixtured: `words` strictly shrinks on every iteration, so the loop
  // terminates on its own. Kept because a reader should not have to prove that
  // to be sure a guard cannot hang.
  let guard = 0;
  while (words.length > 1 && guard < 8) {
    const head = words[0].slice(words[0].lastIndexOf('/') + 1);
    if (head !== 'env') break;
    words = words.slice(1);
    while (
      words.length > 1 &&
      (/^-/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))
    ) {
      words = words.slice(1);
    }
    guard += 1;
  }
  const first = words[0] ?? '';
  return first.slice(first.lastIndexOf('/') + 1);
}

/**
 * `defaults.run.shell`, resolved job-then-workflow.
 *
 * Same shape as `workingDirFor`'s defaults lookup and deliberately separate
 * from it: that one answers "where", this one answers "run by what", and
 * folding them would make one reader serve two questions.
 */
function defaultShellFor(lines, runIdx) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const SH = /^\s*shell:\s*(?:"([^"]*)"|'([^']*)'|(\S+))/;
  const inRange = (from, to, atIndent = null) => {
    for (let i = from; i < to && i < lines.length; i += 1) {
      const flow = lines[i].match(
        /defaults:\s*\{[^}]*shell:\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/,
      );
      if (flow && (atIndent === null || indentOf(lines[i]) === atIndent)) {
        return flow[1] ?? flow[2] ?? flow[3];
      }
      if (!/^\s*defaults:\s*$/.test(lines[i])) continue;
      if (atIndent !== null && indentOf(lines[i]) !== atIndent) continue;
      const di = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() !== '' && indentOf(lines[j]) <= di) break;
        const m = lines[j].match(SH);
        if (m) return m[1] ?? m[2] ?? m[3];
      }
    }
    return null;
  };
  const job = jobBounds(lines, runIdx);
  if (job) {
    // At the job's OWN key column. A job-wide text search accepted `defaults:` /
    // `run:` / `shell: python` written INSIDE an earlier step's `run: |` payload
    // — heredoc data, say — as Actions metadata, and a later ordinary bash step
    // was then classified as python and omitted (#1995 r16). The `env` reader
    // took the same correction; this one is its sibling and did not have it.
    const v = inRange(job.start, job.end, job.indent + 2);
    if (v !== null) return v;
  }
  const jobsIdx = lines.findIndex((l) => /^\s*jobs:\s*$/.test(l));
  const topIndent = jobsIdx >= 0 ? indentOf(lines[jobsIdx]) : 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*defaults:\s*$/.test(lines[i]) || indentOf(lines[i]) !== topIndent) continue;
    const v = inRange(i, lines.length, topIndent);
    if (v !== null) return v;
  }
  return null;
}

function matrixShellValues(lines, runIdx, rawIn) {
  // Indexed spelling too (#1995 r22).
  const raw = normalizeCtxRefs(rawIn);
  const mm = raw.match(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/);
  if (!mm) return [];
  const key = mm[1];
  const vals = [];
  // BOUNDED TO THE JOB, the same correction the working-directory collector
  // took one round earlier. This one was written afterwards and did not get it:
  // an axis of the same name in an unrelated job answered for this step, so a
  // python-only deploy job was read as bash and its `print(...)` reported
  // (#1995 r16). A false red, and the two collectors disagreeing about scope.
  const jb = jobBounds(lines, runIdx);
  const from = jb ? jb.start : 0;
  const to = jb ? jb.end : lines.length;
  for (let i = from; i < to; i += 1) {
    const inline = lines[i].match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`));
    if (inline) vals.push(...inline[1].split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')));
    for (const fa of lines[i].matchAll(new RegExp(`[{,]\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'g'))) {
      vals.push(...fa[1].split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')));
    }
    const inc = lines[i].match(
      new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`),
    );
    if (inc) vals.push(inc[1] ?? inc[2] ?? inc[3]);
  }
  return vals.filter(Boolean);
}
/**
 * The interpreter a step will actually use, or null when unresolved.
 *
 * Same precedence as `stepIsShell` and read from the same places; kept separate
 * because that one answers "is this shell at all" and this one answers "which",
 * and a caller that needs the name should not have to re-derive it from a
 * boolean.
 */
function stepShellName(lines, runIdx) {
  const m = scanStepKeys(
    lines,
    runIdx,
    /^\s*(?:-\s+)?shell:\s*(?:"([^"]*)"|'([^']*)'|(\$\{\{[^}]*\}\}|\S+))/,
  );
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : defaultShellFor(lines, runIdx);
  if (!raw || /\$\{\{/.test(raw)) return null;
  return interpreterOf(raw);
}

/**
 * `cmd` continues a line with a trailing CARET, and routing every workflow body
 * through the Unix-oriented folder left `wrangler ^` and `deploy` as two source
 * lines, so the deploy was never detected (#1995 r16).
 *
 * Applied only where the step's interpreter is known to be `cmd`: `^` at the end
 * of a POSIX line is an ordinary character, and folding it there would join
 * lines the shell never joined — the r27 mistake in another spelling.
 */
function foldCaretContinuations(body) {
  return body.replace(/\^\r?\n/g, ' ');
}

/**
 * Rewrite `\\` to `/` in a body a WINDOWS shell will run.
 *
 * `cd apps\\agent` enters the agent under PowerShell, and `dequote` removes the
 * backslash as a Bash escape, modelling `appsagent` (#1995 r16). The
 * `Set-Location` and `cd /d` forms carried their own conversion because the
 * COMMAND identified the platform; the plain `cd` alias does not, so the
 * conversion has to come from the step's interpreter instead.
 *
 * My first attempt converted whenever the result named a scoped package, with no
 * interpreter at all. That is not decidable without one, and it broke the
 * standing control that `cd apps\\agent` in BASH is `cd appsagent` — the same
 * text means different things and only the `shell:` key says which.
 *
 * Scoped to path-shaped words, so a caret continuation or a `\\"` escape
 * elsewhere in the body is left alone.
 */
function windowsSeparators(body) {
  return (
    body
      .replace(/(?<=[\w.$}])\\(?=[\w.$])/g, '/')
      // Windows resolves an executable case-insensitively, so `Wrangler deploy`
      // in a pwsh or cmd step runs the same shim — and a case-sensitive
      // detector saw nothing at all (#1995 r16). Normalised here, where the
      // interpreter is known, rather than by making the pattern
      // case-insensitive everywhere: on a POSIX runner `Wrangler` is a
      // different file, and matching it there would invent a command.
      .replace(/\bWrangler(2?)\b/g, 'wrangler$1')
  );
}

/**
 * Rewrite PowerShell's `$name = 'value'` into the POSIX shape the state walk
 * already understands.
 *
 * `$target = 'apps/agent'` then `Set-Location $target` is the ordinary pwsh
 * sequence, and the assignment branch recognised only `NAME=value`, so the
 * variable stayed unresolved and the modelled cwd went unknown (#1995 r16).
 *
 * Done as a REWRITE at block ingest rather than as a second assignment parser
 * in the walk: the interpreter is known here and not there, and one assignment
 * model with a translation in front of it cannot drift the way two models can.
 * Literal values only, matching what the POSIX branch remembers.
 *
 * Widening it to admit COMPUTED values is an EQUIVALENT MUTANT, recorded as
 * one: the POSIX assignment branch this feeds already refuses a value it cannot
 * parse and DELETES the binding, so a rewritten `$x = (Get-Item .).Name` ends up
 * unresolved either way. The narrow pattern states the rule where a reader
 * looks for it rather than leaving it to be inferred two functions away.
 */
function powershellAssignments(body) {
  return body.replace(
    /^(\s*)\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"$`]*)")\s*$/gm,
    (_m, pad, name, sq, dq) => `${pad}${name}=${sq ?? dq}`,
  );
}

/**
 * A step (or its job) whose condition is STATICALLY FALSE never runs.
 *
 * `if: ${{ false }}` on a step with a bare deploy blocked the unfiltered CI job
 * over a command Actions will not execute (#1995 r16) — a false red, and the
 * same shape as a matrix `exclude`, which is already honoured.
 *
 * Only the literal spellings. Anything referencing a context is a runtime
 * question, and treating an unknown condition as false would silence real
 * deploys — the direction this must not err in.
 */
function stepIsDisabled(lines, runIdx) {
  const FALSE = /^(?:false|\$\{\{\s*false\s*\}\}|'false'|"false")$/;
  // `if: false # temporarily disabled` is the boolean `false` to YAML — a
  // comment needs whitespace before its `#`, and `false#x` has none, so only
  // the real comment form is stripped (#1995 r17).
  const uncommented = (v) => v.trim().replace(/\s+#.*$/, '');
  const m = scanStepKeys(lines, runIdx, /^\s*(?:-\s+)?if:\s*(\S.*?)\s*$/);
  if (m && FALSE.test(uncommented(m[1]))) return true;
  const job = jobBounds(lines, runIdx);
  if (!job) return false;
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  for (let i = job.start; i < job.end && i < lines.length; i += 1) {
    if (indentOf(lines[i]) !== job.indent + 2) continue;
    const jm = lines[i].match(/^\s*if:\s*(\S.*?)\s*$/);
    if (jm && FALSE.test(uncommented(jm[1]))) return true;
  }
  return false;
}

/**
 * Everything a body needs before the shell scanner reads it, given the step's
 * interpreter.
 *
 * ONE function, because this is the third time an interpreter transform went in
 * at one of the three `run:` ingest points and not the others — carets, then
 * separators, then the case-fold. A body reaching the scanner untransformed
 * looks exactly like a body with nothing to transform, so the omission is
 * invisible until a fixture happens to use that spelling.
 */
function forInterpreter(body, interp) {
  if (interp === 'cmd') return windowsSeparators(foldCaretContinuations(body));
  if (interp === 'pwsh' || interp === 'powershell') {
    return windowsSeparators(powershellAssignments(body));
  }
  return body;
}

function stepIsShell(lines, runIdx) {
  const m = scanStepKeys(
    lines,
    runIdx,
    /^\s*(?:-\s+)?shell:\s*(?:"([^"]*)"|'([^']*)'|(\$\{\{[^}]*\}\}|\S+))/,
  );
  if (!m) {
    // No step-level `shell:` means the DEFAULT applies, and `defaults.run.shell`
    // may name a non-shell interpreter. Returning true unconditionally reported
    // a python step's `print("wrangler deploy")` as a destructive deploy
    // (#1995 r16) — a false red on a correct workflow.
    const dflt = defaultShellFor(lines, runIdx);
    return dflt === null ? true : SHELL_KEYWORDS.has(interpreterOf(dflt));
  }
  // `shell: ${{ matrix.shell }}` is not the literal token `${{`. Testing it
  // against the keyword set classified a real bash leg as non-shell and skipped
  // its body entirely (#1995 r16). An UNRESOLVED expression is scanned rather
  // than skipped: skipping is the fail-open direction here, and the whole point
  // of the allow-list is that an unknown interpreter must not silence a deploy
  // it might well execute.
  const rawShell = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (/\$\{\{/.test(rawShell)) {
    const resolved = matrixShellValues(lines, runIdx, rawShell);
    if (resolved.length === 0) return true;
    return resolved.some((v) => SHELL_KEYWORDS.has(interpreterOf(v)));
  }
  // Actions accepts a custom TEMPLATE — `bash -e {0}` — and the interpreter is
  // its first token. Comparing the whole scalar classified a quoted
  // `shell: "bash -e {0}"` as non-shell and skipped a real deploy (#1995 r16).
  // The unquoted spelling happened to work for the wrong reason: the `\S+`
  // alternative stopped at the space, so it captured `bash` by accident. Both
  // spellings take the first token now, deliberately.
  const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return SHELL_KEYWORDS.has(interpreterOf(value));
}

/**
 * The declared values of ONE matrix key, in any of the shapes Actions
 * accepts: inline array, block sequence, flow mappings, and `include:`
 * entries (kept paired for the shell-axis filter), minus `exclude:`d values.
 *
 * Hoisted out of `workingDirFor` so the run-body matrix expansion (#1995
 * r19) consults the SAME lists the working-directory resolver does — a
 * second reader of the matrix would drift exactly the way the three run
 * ingest points used to.
 */
/**
 * The `include:` LEGS of the containing job's matrix, each as a Map.
 *
 * `matrixValuesFor` flattens these into per-key lists, which is right for one
 * axis and wrong for two: an action step drawing its DIRECTORY and its COMMAND
 * from the same leg must keep them paired. Taking the cross product invented a
 * combination the workflow never runs — pairing `{dir: apps/agent, cmd: deploy
 * --keep-vars}` with the indexer leg's bare `deploy` reported a synthetic bare
 * agent deploy and failed CI on a correct workflow (#1995 r22). A false red.
 *
 * One collector, called by both readers, so the flat and paired views cannot
 * disagree about what a leg is.
 */
function matrixIncludeLegs(lines, runIdx) {
  return matrixValuesFor(lines, runIdx, null, null, true);
}

function matrixValuesFor(lines, runIdx, key, shellAxisKey, legsOnly = false) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  const vals = [];
  const includeLegs = [];
  // BOUNDED TO THE CONTAINING JOB. Scanning the whole workflow let an axis of
  // the same name in an UNRELATED job scope this one — a deploy job whose
  // `dir` is only the indexer was reported as the agent because another job
  // declared an agent leg (#1995 r16). A false red, and the wrong package.
  const jb = jobBounds(lines, runIdx);
  const from = jb ? jb.start : 0;
  const to = jb ? jb.end : lines.length;
  for (let i = legsOnly ? to : from; i < to; i += 1) {
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
    // `include:` entries are read STRUCTURALLY after this loop, so a leg's
    // values stay together — the per-line matcher that stood here could not
    // tell which entry a member belonged to (#1995 r17).
    // A flow mapping may also carry an ARRAY-valued axis:
    // `strategy: { matrix: { dir: [apps/agent] } }`. The start-anchored
    // inline matcher above never sees it, and the scalar flow matcher below
    // reads mapping members, not arrays — so an ordinary matrix written in
    // flow style resolved to nothing (#1995 r16).
    for (const fa of lines[i].matchAll(
      new RegExp(`[{,]\\s*${key}:\\s*\\[([^\\]]*)\\]`, 'g'),
    )) {
      vals.push(...fa[1].split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')));
    }
    // FLOW-style mappings put the key mid-line: `include: [{ dir: apps/agent }]`
    // has no line beginning with `dir:`, so an anchored matcher recorded
    // nothing. The block form was added first and the flow form is the same
    // configuration written the other way — the identical omission the
    // `defaults:` reader had at r13 (#1995 r16).
    // Flow-style INCLUDE entries belong to the structured reader below,
    // where their members stay paired; matching them here too would put the
    // value back without its leg.
    if (!/\binclude:\s*\[/.test(lines[i])) {
      for (const fm of lines[i].matchAll(
        new RegExp(`[{,]\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}\\]]+))`, 'g'),
      )) {
        vals.push(fm[1] ?? fm[2] ?? fm[3]);
      }
    }
  }
  // `include:` ENTRIES, one Map per leg. An entry contributes its value for
  // this key only when the leg can actually run the step: with the shell
  // axis matrix-driven, an entry pairing this key with a NON-shell
  // interpreter runs no shell there. Entries without the shell axis, and
  // every value from a plain axis list, stay — a cross product pairs those
  // with every interpreter.
  for (let i = from; i < to && i < lines.length; i += 1) {
    const flowInc = lines[i].match(/\binclude:\s*\[(.*)\]/);
    if (flowInc) {
      for (const em of flowInc[1].matchAll(/\{([^}]*)\}/g)) {
        const entry = new Map();
        for (const kv of em[1].matchAll(
          /([A-Za-z_][\w-]*):\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g,
        )) {
          entry.set(kv[1], kv[2] ?? kv[3] ?? kv[4]);
        }
        if (entry.size > 0) includeLegs.push(entry);
      }
      continue;
    }
    if (!/^\s*include:\s*$/.test(lines[i])) continue;
    const ii = indentOf(lines[i]);
    let cur = null;
    for (let j = i + 1; j < lines.length && j < to; j += 1) {
      if (lines[j].trim() === '') continue;
      if (indentOf(lines[j]) <= ii) break;
      const flowEntry = lines[j].match(/^\s*-\s*\{([^}]*)\}\s*$/);
      if (flowEntry) {
        const entry = new Map();
        for (const kv of flowEntry[1].matchAll(
          /([A-Za-z_][\w-]*):\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g,
        )) {
          entry.set(kv[1], kv[2] ?? kv[3] ?? kv[4]);
        }
        if (entry.size > 0) includeLegs.push(entry);
        cur = null;
        continue;
      }
      const dash = lines[j].match(
        /^\s*-\s+([A-Za-z_][\w-]*):\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/,
      );
      const member = lines[j].match(
        /^\s*([A-Za-z_][\w-]*):\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/,
      );
      if (dash) {
        cur = new Map();
        includeLegs.push(cur);
        cur.set(dash[1], dash[2] ?? dash[3] ?? dash[4]);
      } else if (member && cur) {
        cur.set(member[1], member[2] ?? member[3] ?? member[4]);
      }
    }
  }
  if (legsOnly) return includeLegs;
  for (const entry of includeLegs) {
    if (!entry.has(key)) continue;
    if (
      shellAxisKey &&
      entry.has(shellAxisKey) &&
      !SHELL_KEYWORDS.has(interpreterOf(entry.get(shellAxisKey)))
    ) {
      continue;
    }
    vals.push(entry.get(key));
  }
  // `exclude:` removes LEGS. A matrix declaring the agent and the indexer and
  // then excluding the agent runs no agent leg at all, but the collector kept
  // the declared value and reported a violation for a leg that does not exist
  // (#1995 r16). Another false red.
  //
  // Single-axis reading, which is what this resolver models: a value named
  // under `exclude` is dropped. A multi-axis exclusion removes a COMBINATION
  // rather than a value, and dropping the value there would be too eager, so
  // an exclude entry carrying more than one key is left alone — which keeps
  // the leg and errs toward reporting.
  const excluded = new Set();
  for (let i = from; i < to; i += 1) {
    if (/^\s*exclude:\s*$/.test(lines[i])) {
      const ei = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length && j < to; j += 1) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) <= ei) break;
        const only = lines[j].match(
          new RegExp(`^\\s*-\\s+${key}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`),
        );
        if (only) excluded.add(only[1] ?? only[2] ?? only[3]);
      }
    }
    for (const fm of lines[i].matchAll(
      new RegExp(
        `exclude:\\s*\\[\\s*\\{\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}]+))\\s*\\}`,
        'g',
      ),
    )) {
      excluded.add(fm[1] ?? fm[2] ?? fm[3]);
    }
  }
  return vals.filter(Boolean).filter((v) => !excluded.has(v));
}

/**
 * Every body a matrix-templated `run:` can execute as.
 *
 * `run: ${{ matrix.cmd }}` with `cmd: ['wrangler deploy']` executes the deploy
 * from that leg's directory, but run-body expansion handled only `env`
 * expressions — so the seeded block kept the unresolved text while the matrix
 * declaration held the deploy with no step scope beside it (#1995 r19).
 *
 * Substituted from the SAME flat per-key lists the working-directory resolver
 * consults, include-leg values included — which is that resolver's own
 * approximation: values combine by cross product rather than being held to
 * their include pairing, erring toward reporting. A key with no declared
 * values keeps its expression (it carries no command text either way), and
 * the product is capped the way `resolveExpression`'s is.
 */
function expandMatrixVariants(lines, runIdx, body) {
  body = normalizeCtxRefs(body);
  if (!/\$\{\{\s*matrix\./.test(body)) return null;
  const keys = [
    ...new Set(
      [...body.matchAll(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g)].map((m) => m[1]),
    ),
  ];
  let variants = [body];
  let expanded = false;
  for (const k of keys) {
    const vals = matrixValuesFor(lines, runIdx, k, null);
    if (vals.length === 0) continue;
    expanded = true;
    const next = [];
    for (const b of variants) {
      for (const v of vals) {
        next.push(b.replace(new RegExp(String.raw`\$\{\{\s*matrix\.${k}\s*\}\}`, 'g'), v));
        if (next.length >= 32) break;
      }
      if (next.length >= 32) break;
    }
    variants = next;
  }
  return expanded ? variants : null;
}

/**
 * Values a reusable workflow's input is CALLED with, from checked-in callers.
 *
 * A required input has no default, so the callee's own text resolves it to
 * nothing — but `jobs.<id>.uses: ./.github/workflows/<this-file>` with
 * `with: dir: apps/agent` in a sibling workflow is statically known, and
 * Actions runs the callee's bare deploy with exactly that value (#1995 r19).
 * Callers are read from the same workflows directory. The current file is
 * MODULE STATE set once per file in the main loop rather than threaded
 * through every resolver signature — this scanner is single-threaded, and
 * the alternative touches five signatures for one consumer.
 *
 * Block-form `with:` only. The flow spelling cannot be tied to its `uses:`
 * line from a text match, and an untied match would let an unrelated step's
 * input scope this one — the false-red direction.
 */
let CURRENT_REL = '';
function callerSuppliedInputs(key) {
  if (!/^\.github\/workflows\/[^/]+$/.test(CURRENT_REL)) return [];
  const base = CURRENT_REL.slice('.github/workflows/'.length);
  const vals = [];
  let entries = [];
  try {
    entries = readdirSync(join(REPO_ROOT, '.github/workflows'));
  } catch {
    return [];
  }
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  for (const f of entries) {
    if (!/\.ya?ml$/.test(f) || f === base) continue;
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, '.github/workflows', f), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(base)) continue;
    const ls = text.split('\n');
    for (let i = 0; i < ls.length; i += 1) {
      if (
        !new RegExp(
          // FULLY escaped, not just the dots. A filename may legally contain
          // `+`, `(`, `[` or a backslash, and escaping one metacharacter class
          // while interpolating the rest builds a pattern that means something
          // other than the literal name (CodeQL js/incomplete-sanitization).
          // Same escape the scope matchers use.
          String.raw`^\s*uses:\s*["']?\./\.github/workflows/${base.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )}["']?(?:@|\s|$)`,
        ).test(ls[i])
      ) {
        continue;
      }
      const ui = indentOf(ls[i]);
      for (let j = i + 1; j < ls.length; j += 1) {
        if (ls[j].trim() === '') continue;
        if (indentOf(ls[j]) < ui) break;
        if (indentOf(ls[j]) !== ui) continue;
        // A FLOW `with: { dir: apps/agent }` is the same input, and only the
        // block spelling was read — so a required input resolved to nothing
        // and the callee's bare deploy passed (#1995 r22). Tied to this
        // `uses:` by the same indent anchoring the block form uses.
        const flowWith = ls[j].match(/^\s*with:\s*\{(.*)\}\s*$/);
        if (flowWith) {
          const fm = flowWith[1].match(
            new RegExp(`["']?${key}["']?:\\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))`),
          );
          if (fm) {
            const v = (fm[1] ?? fm[2] ?? fm[3]).trim();
            if (!/\$\{\{/.test(v)) vals.push(v);
          }
          break;
        }
        if (!/^\s*with:\s*$/.test(ls[j])) continue;
        for (let k = j + 1; k < ls.length; k += 1) {
          if (ls[k].trim() === '') continue;
          if (indentOf(ls[k]) <= ui) break;
          // The unquoted alternative admits an EXPRESSION, which contains
          // spaces: `dir: ${{ matrix.dir }}` had `\S+` stop at the brace and
          // recorded the unusable fragment `${{` (#1995 r20) — the r11
          // working-directory defect, now in its third reader. A caller-side
          // matrix expression resolves against the CALLER's own declarations,
          // bounded to the job that carries the `uses:` line, which is what
          // `matrixValuesFor` already does for a step.
          const kv = ls[k].match(
            new RegExp(`^\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S.*?))\\s*$`),
          );
          if (!kv) continue;
          const rawVal = normalizeCtxRefs((kv[1] ?? kv[2] ?? kv[3]).replace(/\s+#.*$/, '').trim());
          const expr = rawVal.match(/^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/);
          if (expr) vals.push(...matrixValuesFor(ls, i, expr[1], null));
          else if (!/\$\{\{/.test(rawVal)) vals.push(rawVal);
        }
        break;
      }
    }
  }
  return vals.filter(Boolean);
}

/**
 * An ALIAS-ONLY scalar resolves to its anchor's value.
 *
 * `working-directory: *agent-dir`, with `&agent-dir apps/agent` declared
 * anywhere in the file, is the protected directory to YAML — but the property
 * strip removes an alias only when a scalar FOLLOWS it on the same node, so an
 * alias that IS the node stayed as `*agent-dir`, which scopes nothing (#1995
 * r19). Resolved against the first `&name <scalar>` in the file; an anchor
 * that cannot be found resolves to nothing rather than to the alias text —
 * `*agent-dir` is not a directory name, the r11 rule again.
 */
function resolveYamlAliasOnly(lines, value) {
  const m = /^\*([\w-]+)$/.exec(value ?? '');
  if (!m) return value;
  for (const l of lines) {
    const am = l.match(new RegExp(`&${m[1]}\\s+(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`));
    if (am) return am[1] ?? am[2] ?? am[3];
  }
  return '';
}

function workingDirFor(lines, runIdx, legShellFilter = true, rawValue = null) {
  const indentOf = (l) => (l.match(/^\s*/) ?? [''])[0].length;
  // When the step's SHELL is itself matrix-driven, a directory and an
  // interpreter drawn from the same `include:` entry travel together: the
  // agent leg of `{dir: apps/agent, interp: python}` never runs a shell, and
  // resolving the two axes independently reported that leg's directory under
  // another leg's interpreter — a false red (#1995 r17). The caller passes
  // `legShellFilter: false` when it kept the block for a LAUNCH, where the
  // interesting leg is precisely the non-shell one.
  const shellM = scanStepKeys(
    lines,
    runIdx,
    /^\s*(?:-\s+)?shell:\s*(?:"([^"]*)"|'([^']*)'|(\$\{\{[^}]*\}\}|\S+))/,
  );
  const shellRaw = shellM ? normalizeCtxRefs((shellM[1] ?? shellM[2] ?? shellM[3] ?? '').trim()) : null;
  const shellAxisKey = legShellFilter
    ? (shellRaw?.match(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/)?.[1] ?? null)
    : null;
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
  // `&anchor` / `*alias` / `!!tag` may sit between the key and the value —
  // `working-directory: &agent-dir apps/agent` is `apps/agent` to YAML — and
  // capturing the property instead of the scalar missed the package (#1995
  // r16). The `run:` matcher already stepped over them; this one did not.
  // The unquoted branch carries the same expression-or-char union the env
  // value reader had to disambiguate (js/redos): nothing follows the union
  // HERE, so today it cannot be forced to backtrack — but that safety is one
  // appended anchor away from gone, so it takes the same `$`-lookahead form.
  const WD =
    /^\s*(?:-\s+)?["']?working-directory["']?:\s*(?:[&*][\w-]+\s+|!!?[\w:.-]*\s+)*(?:"([^"]*)"|'([^']*)'|((?:\$\{\{[^}]*\}\}|\$(?!\{\{[^}]*\}\})|[^$\s])+))/;
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
    // `\` is a separator on a Windows runner, and `working-directory:
    // apps\agent` really does enter the agent — splitting on `/` alone left the
    // whole string as one component and `scopeOfCwd` missed it (#1995 r16).
    // Safe for POSIX paths too: a backslash is not a legal separator there and
    // is vanishingly rare inside a directory NAME, so treating it as one can
    // only resolve a path that would otherwise match nothing.
    for (const part of raw.split(/[\\/]/)) {
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
  const matrixValues = (key) => matrixValuesFor(lines, runIdx, key, shellAxisKey);

  /**
   * The values a workflow `env` key can hold at one precedence level.
   *
   * Scoped to an actual `env:` MAPPING, which the first cut was not: it
   * matched any `KEY: value` line in range, so an action input under
   * `with: { DEPLOY_DIR: … }` was read as an environment declaration and
   * shadowed the real one (#1995 r16).
   */
  const envValueIn = (key, from, to, atIndent) => {
    for (let i = from; i < to && i < lines.length; i += 1) {
      if (!/^\s*env:\s*$/.test(lines[i])) continue;
      // The mapping's OWN level. A job's range contains every STEP's `env`, and
      // the workflow's range contains every job's and step's — so the first
      // `env:` found in range was often a deeper one, and a sibling step's
      // override shadowed the top-level value the step actually inherits
      // (#1995 r16, on the r16 scoping fix itself).
      if (atIndent !== null && indentOf(lines[i]) !== atIndent) continue;
      const ei = indentOf(lines[i]);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) <= ei) break;
        const kv = lines[j].match(
          new RegExp(`^\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))\\s*$`),
        );
        if (kv) return kv[1] ?? kv[2] ?? kv[3];
      }
      // Flow form: `env: { DEPLOY_DIR: apps/agent }` on one line.
    }
    for (let i = from; i < to && i < lines.length; i += 1) {
      const fm = lines[i].match(
        new RegExp(`env:\\s*\\{[^}]*?[{,]?\\s*${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}]+))`),
      );
      if (fm) return fm[1] ?? fm[2] ?? fm[3];
    }
    return null;
  };

  /** `env` resolved from the STEP, then the JOB, then the workflow. */
  const envValues = (key) => {
    const step = stepBounds(lines, runIdx);
    const job = jobBounds(lines, runIdx);
    // Each level names the indent its OWN `env:` sits at. A step's is bounded
    // by `stepBounds` already, so it needs none; a job's is the job key's first
    // child column; the workflow's is the top level.
    const jobsIdx = lines.findIndex((l) => /^\s*jobs:\s*$/.test(l));
    const topIndent = jobsIdx >= 0 ? indentOf(lines[jobsIdx]) : 0;
    const ranges = [
      step && [step.start, step.end, step.keyIndent],
      job && [job.start, job.end, job.indent + 2],
      [0, lines.length, topIndent],
    ].filter(Boolean);
    for (const [from, to, atIndent] of ranges) {
      const v = envValueIn(key, from, to, atIndent);
      if (v !== null) return [v];
    }
    return [];
  };

  /**
   * The DECLARED default of a workflow input.
   *
   * `workflow_dispatch` inputs pre-fill from `default:`, so a step with
   * `working-directory: ${{ inputs.dir }}` and `default: apps/agent` runs in
   * the agent on the one-click dispatch — but the resolver blanked every
   * `inputs` expression and the bare deploy under it passed (#1995 r17). Only
   * the declared default is modelled; a dispatcher typing something else is
   * outside static reach, and the default leg is the one a reader clicks.
   */
  const inputDefaultValues = (key) => {
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*inputs:\s*$/.test(lines[i])) continue;
      const ii = indentOf(lines[i]);
      let childIndent = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue;
        const ind = indentOf(lines[j]);
        if (ind <= ii) break;
        if (childIndent === null) childIndent = ind;
        if (ind === childIndent && new RegExp(`^\\s*${key}:\\s*$`).test(lines[j])) {
          for (let k = j + 1; k < lines.length; k += 1) {
            if (lines[k].trim() === '') continue;
            const ki = indentOf(lines[k]);
            if (ki <= childIndent) break;
            const dm = lines[k].match(/^\s*default:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/);
            if (dm) return [dm[1] ?? dm[2] ?? dm[3]];
          }
        }
      }
    }
    return [];
  };

  /**
   * Substitute EVERY `${{ … }}` in a value, of either kind.
   *
   * Four separate reports, one shape (#1995 r16). The first cut resolved ONE
   * expression, of ONE kind, and the `env` branch RETURNED its value instead of
   * substituting it — so `${{ env.ROOT }}/apps/agent` became `.`, and
   * `${{ matrix.root }}/${{ matrix.app }}` kept its second expression whole.
   *
   * Values are chosen by COMBINATION, because with more than one expression the
   * choices interact: the question is not "does this leg land in a scoped
   * package" but "does this ASSIGNMENT of all of them". The product is capped —
   * a matrix wide enough to exceed it is not one a workflow writes by hand, and
   * exceeding it resolves to nothing rather than to a guess.
   *
   * An expression whose values cannot be found makes the whole value
   * unresolvable, rather than being left in place: `${{` is not a directory
   * name, which is what recorded it as one before r11.
   */
  const resolveExpression = (rawIn) => {
    // Indexed spelling too (#1995 r22).
    let raw = normalizeCtxRefs(rawIn);
    const found = [...raw.matchAll(/\$\{\{\s*(env|matrix|inputs)\.([A-Za-z_][\w-]*)\s*\}\}/g)];
    if (!/\$\{\{/.test(raw)) return raw;
    const axes = found.map((m) => ({
      whole: m[0],
      values:
        m[1] === 'env'
          ? envValues(m[2])
          : m[1] === 'inputs'
            ? [...inputDefaultValues(m[2]), ...callerSuppliedInputs(m[2])]
            : matrixValues(m[2]),
    }));
    const known = axes.filter((a) => a.values.length > 0);
    // EVERY expression that cannot be resolved substitutes EMPTY — an axis with
    // no declared values, and equally one this resolver does not model at all
    // (`${{ inputs.x }}`, `${{ github.workspace }}`). That is Actions' own
    // semantics, an undefined context expression evaluates to the empty string,
    // and it keeps the LITERAL segments: `apps/agent/${{ matrix.x }}` runs
    // inside the agent whatever `x` turns out to be.
    //
    // Discarding the whole value instead lost that, and treating the text as a
    // PATH was the r11 defect — `${{` recorded as a directory name. Empty
    // substitution is the reading that satisfies both, because an expression
    // that is the whole value still substitutes to nothing.
    const keep = new Set(known.map((a) => a.whole));
    raw = raw.replace(/\$\{\{[^}]*\}\}/g, (m) => {
      if (keep.has(m)) return m;
      // A STATIC STRING LITERAL evaluates to itself: `${{ 'apps/agent' }}` is
      // the agent directory, and blanking it made a real deploy unattributed
      // (#1995 r16, on last round's empty-substitution rule). Only a bare
      // quoted literal — anything with an operator, a function call or a
      // context reference is still not evaluable from the text.
      const lit = m.match(/^\$\{\{\s*(?:'([^']*)'|"([^"]*)")\s*\}\}$/);
      return lit ? lit[1] ?? lit[2] : '';
    });
    // With nothing left to choose BETWEEN, the substituted path is the answer:
    // there is no list of legs to pick a scoped one from.
    if (known.length === 0) return raw;
    let combos = [raw];
    for (const axis of known) {
      const next = [];
      for (const base of combos) {
        for (const v of axis.values) {
          next.push(base.split(axis.whole).join(v));
          if (next.length >= 256) break;
        }
        if (next.length >= 256) break;
      }
      combos = next;
    }
    // NORMALISED before the scope test. `ROOT: .` substitutes to
    // `./apps/agent`, which is the agent and matched nothing (#1995 r16). The
    // caller normalises the RESULT, which is too late to choose between
    // combinations — the choice is what needs the normal form.
    return (
      combos.find((c) =>
        SCOPED.some(
          (sc) => normalizePath(c) === sc.dir || normalizePath(c).startsWith(`${sc.dir}/`),
        ),
      ) ?? ''
    );
  };
  const valueOf = (m) =>
    normalizePath(resolveExpression(resolveYamlAliasOnly(lines, m[1] ?? m[2] ?? m[3])));
  /**
   * The same resolution for a FLOW-style capture.
   *
   * `defaults: { run: { working-directory: X } }` returned its capture raw, so
   * it reached neither the expression resolver nor the normaliser — the r13
   * branch was added before either existed and never joined them (#1995 r16).
   * Two return sites, job-level and workflow-level, and both had it.
   */
  const flowValueOf = (m) =>
    normalizePath(resolveExpression(resolveYamlAliasOnly(lines, m[1] ?? m[2] ?? m[3])));

  // A RAW VALUE from elsewhere — a wrangler-action `workingDirectory:` input —
  // takes the same resolution the step key gets: property strip, expression
  // resolution, normalisation. Taking it literally left `${{ matrix.dir }}`
  // as a directory name, which scopes nothing (#1995 r18).
  if (rawValue !== null) {
    return normalizePath(
      resolveExpression(resolveYamlAliasOnly(lines, stripYamlProps(rawValue))),
    );
  }

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

const walkedDirs = new Set();
function* walk(dir) {
  // A canonical directory is walked ONCE. Containment stops the walk leaving
  // the repository, but two internal links back to an ancestor (`a -> .`,
  // `b -> .`) still branch: each alias is inside the tree, so each is followed,
  // and the traversal multiplies. A minimal fixture exceeded two seconds and the
  // shape scales into the workflow timeout (#1995 r16) — the containment fix
  // bounded WHERE the walk goes and not HOW OFTEN it goes there.
  try {
    const real = realpathSync(dir);
    if (walkedDirs.has(real)) return;
    walkedDirs.add(real);
  } catch {
    return;
  }
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
      // A directory SYMLINK must not carry the walk out of the repository.
      // `statSync` follows it, so a link to the parent had the guard scanning
      // whatever sits beside the checkout and reporting violations in files it
      // does not own — and a link back into the tree recurses forever. Found
      // while writing a control for the symlink RESOLUTION above; it is not
      // caused by that change and predates it.
      let inside = true;
      try {
        const real = realpathSync(full);
        const rootReal = realpathSync(REPO_ROOT);
        inside = real === rootReal || real.startsWith(`${rootReal}/`);
      } catch {
        inside = false;
      }
      if (!inside) continue;
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

/** The scoped package a path sits inside, for alias resolution context. */
function packageContextOf(rel) {
  return SCOPED.find((sc) => rel === sc.dir || rel.startsWith(`${sc.dir}/`))?.dir ?? null;
}

/**
 * The package a selector-less `pnpm run <alias>` runs in, for the shell walk.
 *
 * The MODELLED cwd first and the file only as a fallback, which is the same
 * precedence the scope resolution uses a few lines down: a wrapper that has
 * `cd`-ed somewhere runs the script of the package it stands in, whatever
 * tree the wrapper itself is stored in.
 */
function aliasContext(states, rel) {
  const at = states.map((st) => scopeOfCwd(st.cwd)).find(Boolean);
  return at ? at.dir : packageContextOf(rel);
}

const violations = [];
for (const file of walk(REPO_ROOT)) {
  const rel = relative(REPO_ROOT, file);
  // For `callerSuppliedInputs` — see its doc for why this is module state.
  CURRENT_REL = rel;
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
  // A Windows helper script is SHELL to this guard, read through the same
  // transforms its workflow-body form gets: backslash paths, case-folded
  // Wrangler, and (for cmd) caret continuations. Transformed BEFORE the
  // variable pass so `$target = 'apps/agent'` feeds the same assignment
  // model everywhere (#1995 r17).
  const winInterp = /\.ps1$/i.test(rel) ? 'pwsh' : /\.(?:cmd|bat)$/i.test(rel) ? 'cmd' : null;
  if (winInterp) text = forInterpreter(text, winInterp);
  const fileVars = staticCommandVars(text);
  // Folded ONCE per file, for the prefilter and for the per-line detection
  // tests that follow. Not for scoring: the concatenation is a JavaScript fact,
  // and rewriting a line before `commandIsSafe` reads it would put text in
  // front of the safety predicate that the file does not contain.
  const foldedText = foldStringConcat(text);
  const folded = winInterp || isShellFile(rel, text)
    ? logicalLines(text)
    : [
        ...(/\.jsonc?$/.test(rel) ? jsonValueLines(text) : plainLines(text)),
        ...embeddedShellLines(text, /\.ya?ml$/.test(rel), /\.mdx?$/.test(rel)),
        // Makefile recipes are tab-indented and are shell, whatever the file
        // extension says. Kept out of `embeddedShellLines` because the trigger
        // is the FILE, not a construct inside it.
        ...(/(^|\/)([Mm]akefile|.*\.mk)$/.test(rel) ? makefileBlocks(text) : []),
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
        new RegExp(ANY_DEPLOY_RE).test(dequote(l.text)) ||
        // …and on the form with statically assigned command words substituted.
        new RegExp(ANY_DEPLOY_RE).test(expandCommandVars(dequote(l.text), fileVars)) ||
        // …and on the form with adjacent string literals folded.
        new RegExp(ANY_DEPLOY_RE).test(foldStringConcat(l.text)) ||
        // Case-insensitively too. Windows resolves an executable without
        // regard to case, and the normalisation that handles it happens at
        // BLOCK ingest — which never runs if the file is skipped here first
        // (#1995 r16). This only ADMITS the file; whether the command counts is
        // still decided per interpreter, so a POSIX `Wrangler` is scanned and
        // then correctly ignored.
        new RegExp(ANY_DEPLOY_RE, 'i').test(l.text) ||
        // …and on the form with a manifest ALIAS resolved: `run release`
        // carries no deploy text at all until the alias chain is followed.
        // ANY scoped package as the alias context, not just this file's own.
        // The prefilter is per-FILE and cannot know where the shell will have
        // `cd`-ed by the time the command runs: a wrapper stored outside a
        // protected package that enters one — `cd ../agent; pnpm run release`
        // — resolved to nothing here and the whole file was skipped before the
        // walk could apply its modelled cwd (#1995 r20, caught by a control).
        // Admission only; which package the command belongs to is still
        // decided per segment by the cwd-aware context.
        SCOPED.some((sc) =>
          new RegExp(ANY_DEPLOY_RE).test(resolveRunAlias(l.text, sc.dir) ?? ''),
        ) ||
        // `cloudflare/wrangler-action` performs the deploy with no deploy
        // TEXT anywhere in the file — the action synthesises the command from
        // its inputs — so the prefilter discarded exactly the workflows the
        // action branch below exists to read (#1995 r17).
        /cloudflare\/wrangler-action/.test(l.text) ||
        // A file that SOURCES another may hold the scope for a deploy written
        // somewhere else. `cd apps/agent` then `source ../../deploy.sh` carries
        // no deploy TEXT, so the prefilter skipped the caller and the helper's
        // own scan had no protected scope — neither file was ever judged with
        // both halves (#1995 r16).
        //
        // This is the one thing the prefilter cannot decide from the line
        // alone, so it defers: sourcing is a reason to LOOK, and the walk then
        // reads the helper and scores its deploys against the caller's state.
        /(?:^|[\s;&|(])(?:source|\.)\s+\S/.test(l.text) ||
        // …and a helper EXECUTED as its own process: `cd apps/agent` then
        // `../../deploy.sh` (or `bash ../../deploy.sh`) carries no deploy
        // text either, and deferring only `source` skipped exactly this
        // caller (#1995 r19). Admits the file; the walk decides what the
        // helper actually contains.
        new RegExp(String.raw`(?:^|[\s;&|(])${EXEC_HELPER_RE}(?:\s|$)`).test(
          l.text,
        ),
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
  // Subshell nesting belongs to the BLOCK, not to a line. A `( … )` that spans
  // lines re-created its depth and its snapshot stack on every callback, so the
  // closing `)` had nothing to restore and the subshell's `cd` leaked into the
  // parent — `cd apps/agent`, then `(` / `cd ../indexer` / `)`, then a bare
  // deploy, ran in the AGENT while the model stood in the indexer (#1995 r16).
  // The same-line form was fixed at r13 and this is that fix's other half.
  let depth = 0;
  const stateStack = [];
  // One entry per OPEN `if`, so a literally-disabled arm can be skipped —
  // block-scoped like `depth`, because the disable idiom is written across
  // lines at least as often as on one.
  const condStack = [];
  /** Functions whose body deploys unsafely, by name, for the current block. */
  const deployFns = new Map();
  // A function definition OPEN across lines: `deploy_worker() {` on one line,
  // the body beneath, `}` at the end. Each logical line was processed alone,
  // so the opener recorded an EMPTY body and the call was ignored (#1995 r17).
  // Brace-counted, crudely — braces in strings are rare in these helpers and
  // the cost of a miscount is falling back to today's per-line reading.
  let pendingFn = null;
  /** Aliases whose body deploys unsafely — consulted only under expand_aliases. */
  const deployAliases = new Map();
  // Bash expands aliases in a NON-interactive shell only when
  // `shopt -s expand_aliases` has run, and expansion happens when the CALL is
  // parsed — so the gate is read at the call site, not at the definition.
  let aliasesOn = false;
  folded.forEach(({ text: line, line: lineNo, block, physical, cwd: blockCwd, env: blockEnv }) => {
    // Each embedded block is a SEPARATE shell — an Actions step starts fresh,
    // and so does the next fenced example. Carrying `cwdIsKeeper` across them
    // made one block's `cd apps/keeper` reject the NEXT block's agent deploy
    // (Codex #1924 r29). That is a false positive, and this guard runs in
    // typecheck, so it would have blocked CI on a correct workflow.
    if (block !== currentBlock) {
      currentBlock = block;
      shellVars.clear();
      deployFns.clear();
      condStack.length = 0;
      pendingFn = null;
      deployAliases.clear();
      aliasesOn = false;
      // A new shell starts outside every subshell the previous one opened.
      depth = 0;
      stateStack.length = 0;
      // A workflow step's `working-directory` is where its commands actually
      // run, so the block starts THERE rather than at an empty cwd (#1995 r7).
      states = blockCwd ? [{ cwd: blockCwd.replace(/\/+$/, ''), stack: [] }] : INITIAL;
      prior = states;
      // A step's effective `env` is EXPORTED, so the block starts with those
      // bindings rather than with none (#1995 r16).
      if (blockEnv) for (const [k, v] of blockEnv) shellVars.set(k, v);
    }
    if (/^\s*$/.test(line) || /^\s*(?:`{3,}|~{3,})/.test(line)) {
      states = INITIAL;
      prior = INITIAL;
      condStack.length = 0;
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
      // A markdown CODE SPAN is a command boundary, and prose has no shell
      // separator between two of them. `Use `wrangler deploy --keep-vars` for
      // the keeper and `wrangler deploy` for the agent.` is ONE segment to
      // `splitCommands`, so the safe span blessed the bare one beside it —
      // and the bare one is exactly the copyable command this guard exists to
      // reject (#1995 r16).
      //
      // APPENDED to the segments rather than replacing them, so this can only
      // make the pass stricter. A span that is the whole command scores
      // identically either way, which is why the fenced and shell paths see no
      // change at all.
      //
      // TWO OR MORE spans must each carry a deploy before any of them counts.
      // With only one, the other spans are COMMENTARY ABOUT it, not commands
      // beside it — `keeper-scoped `wrangler deploy` that lacks `--keep-vars``
      // is one command described across two spans, and scoring the first alone
      // reported a documentation sentence as a destructive deploy. That
      // sentence is a standing #1924 r19 fixture, and splitting on every span
      // broke it, which is how the rule was found.
      //
      // Each span carries the CLAUSE THAT FOLLOWS IT as its scope hint. Without
      // that, a span names no package and falls back to the whole line — which,
      // when the line names two, resolved to whichever is first in SCOPED and
      // reported the keeper for an agent problem. That is the r1 defect
      // exactly: the wrong package means the wrong remedy, and a reader acts on
      // the remedy.
      const spanMatches = [...line.matchAll(/`([^`]*)`/g)];
      const hasDeploy = (t) =>
        new RegExp(ANY_DEPLOY_RE).test(t) || new RegExp(ANY_DEPLOY_RE).test(dequote(t));
      const commandSpans = spanMatches.filter((m) => hasDeploy(m[1]));
      const spans =
        commandSpans.length > 1
          ? commandSpans.map((m) => {
              const after = spanMatches.find((n) => n.index > m.index);
              return {
                isSpan: true,
                text: m[1],
                scopeHint: line.slice(m.index + m[0].length, after ? after.index : line.length),
              };
            })
          : [];
      for (const part of [...splitCommands(line), ...spans]) {
        const seg = part.text;
        // The dequoted fallback belongs here too (#1995 r9). Only the shell
        // path had it, so `From apps/agent run pnpm run de"ploy"
        // --no-keep-vars` in a runbook was accepted while the identical text
        // in a `.sh` fixture was rejected — the same sentence judged two ways
        // by which file it sits in, and prose is what an operator copies.
        if (
          !new RegExp(ANY_DEPLOY_RE).test(expandCommandVars(dequote(seg), fileVars)) &&
          // Folded literals reach the per-line test as well as the prefilter.
          // Wiring one and not the other admits the FILE and then sees nothing
          // in it, which is the shape the shell/safety split keeps producing.
          //
          // PROSE side only. `'de' + 'ploy'` is JavaScript, and a JS helper is
          // read on this path; the shell walk cannot encounter a `+`
          // concatenation as command syntax. A copy there survived every
          // mutation because nothing could reach it, so it is gone rather than
          // kept as untested code.
          !new RegExp(ANY_DEPLOY_RE).test(foldStringConcat(seg)) &&
          !new RegExp(ANY_DEPLOY_RE).test(seg) &&
          !new RegExp(ANY_DEPLOY_RE).test(dequote(seg)) &&
          !new RegExp(ANY_DEPLOY_RE).test(resolveRunAlias(seg, packageContextOf(rel)) ?? '')
        ) {
          continue;
        }
        // Statically-known SINGLE-WORD values are expanded before the safety
        // question too. `FLAGS=--keep-vars` then `wrangler deploy "$FLAGS"` is a
        // safe deploy that bash really does make safe, and scoring the raw
        // segment reported it — a false red on a correct command (#1995 r16).
        //
        // `expandCommandVars` leaves multiword values alone away from the head,
        // so this cannot resurrect the `echo "$MSG"` case: what it admits here
        // is a lone flag word, which is what the reported wrapper writes.
        // The scope the caller already has, so a `versions upload` reads the
        // config of the worker it actually deploys.
        const safeHint = lineScope ?? null;
        // The alias-resolved form is judged INSTEAD of the raw one when it
        // resolves: `run release` is whatever the manifest says it is, both
        // for blessing the safe spelling and for catching the forwarded
        // negation.
        const aliased = resolveRunAlias(seg, packageContextOf(rel));
        if (
          commandIsSafe(aliased ?? seg, safeHint) ||
          (aliased === null && commandIsSafe(expandCommandVars(seg, fileVars), safeHint))
        ) {
          continue;
        }
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
        // `''` and not `rel` for the hint: the file-level fallback would give
        // every span the enclosing package's scope, which is the whole-line
        // answer again under another name.
        const hinted = part.scopeHint ? scopeOf(part.scopeHint, '') : null;
        // A SPAN never falls back to the whole line, and that restriction is
        // what makes span-splitting safe to ship. A line offering two commands
        // attributes each one — "`…` for apps/agent" — so the clause after the
        // span names its package. A line that merely QUOTES the bare command
        // does not, and the whole-line fallback would then report every
        // sentence warning against it.
        //
        // That is not hypothetical: without this, the staging deploy plan's own
        // row explaining that a bare `wrangler deploy` must NOT be used for the
        // agent was reported as an agent violation, on the real tree. The
        // guard blocking CI over the sentence telling you not to do the thing
        // is precisely how a guard gets switched off.
        const scope = sel
          ? sel.scope
          : scopeOf(seg, rel) ?? hinted ?? (part.isSpan ? null : lineScope);
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
      // The previous line ran to completion, so this line starts from `states`.
      prior = states;
      // Continues at the depth the PREVIOUS line left, not at zero. Resetting
      // here made every line start outside any open subshell, so the close
      // logic fired immediately and popped a snapshot that belonged to a
      // subshell still open (#1995 r16).
      let pendingDepth = depth;
      // Indexed, because whether a segment runs in a subshell depends on the
      // separator that FOLLOWS it, and `sep` records the one that PRECEDES.
      // The snapshot stack is BLOCK-scoped — declared above — so a subshell
      // that spans lines still has its parent state to restore.
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
        // Body segments of an OPEN function definition accumulate rather than
        // execute — bash runs them at the CALL, not here — and the closer
        // finalises the recorded body (#1995 r17).
        if (pendingFn) {
          // `name()` with its brace on the NEXT line is the same definition —
          // bash accepts the newline before `{` — so the opener may arrive as
          // its own segment. Anything else in that position means the
          // parenthesised line was not a definition after all, and it is
          // released to ordinary processing.
          if (pendingFn.awaitingBrace) {
            if (/^\{/.test(seg)) {
              const rest = seg.replace(/^\{\s*/, '');
              pendingFn.awaitingBrace = false;
              pendingFn.depth = 1 + braceDelta(rest);
              if (rest.trim()) pendingFn.segs.push(rest.trim());
              if (pendingFn.depth <= 0) {
                const entries = unsafeWithDirs(pendingFn.segs.map((t) => t.replace(/\}\s*$/, '').trim()).filter(Boolean));
                if (entries.length > 0) deployFns.set(pendingFn.name, entries);
                pendingFn = null;
              }
              continue;
            }
            pendingFn = null;
          }
        }
        if (pendingFn) {
          const delta = braceDelta(seg);
          if (pendingFn.depth + delta <= 0) {
            const tail = seg.replace(/\}\s*$/, '').trim();
            const entries = unsafeWithDirs([...pendingFn.segs, ...(tail ? [tail] : [])]);
            if (entries.length > 0) deployFns.set(pendingFn.name, entries);
            pendingFn = null;
          } else {
            pendingFn.depth += delta;
            pendingFn.segs.push(seg);
          }
          continue;
        }
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
        // A branch whose condition is the LITERAL `true`, `false` or `:` is
        // decided here: `if false; then …; fi` is the standing idiom for
        // disabling a block, and scoring its body blocked CI over commands the
        // shell can never run (#1995 r17) — the `else` after `if true` is the
        // same shape mirrored. Only the exact literal, standing alone as the
        // whole condition (the NEXT segment must open with `then`), decides
        // anything: `if false || true` or a real command keeps both arms,
        // which is the walk's normal conservatism. Keyword segments still
        // maintain the stack inside a dead region, so nesting closes where
        // bash closes it.
        if (/^if\b/.test(seg)) {
          const lit =
            nextPart && /^then\b/.test(nextPart.text.trim())
              ? seg.match(/^if\s+(true|false|:)\s*$/)?.[1] ?? null
              : null;
          condStack.push({
            taken: lit === 'true' || lit === ':',
            deadArm: lit === 'false',
            seenElse: false,
            deadRest: false,
          });
        } else if (/^fi\b/.test(seg)) {
          condStack.pop();
        } else if (/^elif\b/.test(seg)) {
          const top = condStack[condStack.length - 1];
          if (top) {
            // After a TAKEN arm no later arm runs; otherwise the elif opens a
            // fresh, undecided arm and the earlier verdicts stop applying.
            if (top.taken) top.deadRest = true;
            top.deadArm = false;
            top.taken = false;
            top.seenElse = false;
          }
        } else if (/^else\b/.test(seg)) {
          const top = condStack[condStack.length - 1];
          if (top) top.seenElse = true;
        }
        if (condStack.some((c) => c.deadRest || (c.seenElse ? c.taken : c.deadArm))) {
          continue;
        }
        // Snapshot BEFORE this segment's own `cd` is applied: the paren opens
        // at its start, so the state entering the subshell is `input`.
        if (segDepth > depth) {
          for (let k = depth; k < segDepth; k += 1) stateStack.push(input);
        }
        // `(cd ../agent && wrangler deploy)` moves the shell for the REST OF
        // THE GROUP, and the group's own restore undoes it afterwards — but the
        // opener kept the directive matcher from seeing the `cd` at all, so the
        // deploy beside it was scored against the outer directory (#1995 r16).
        // Stripped only when the segment leaves the group OPEN: one that closes
        // its own paren nets zero depth, nothing would restore it, and applying
        // the move there is the r6 defect.
        const dir = dirDirective(segDepth > depth ? seg.replace(/^\(\s*/, '') : seg);
        // `env --chdir DIR wrangler deploy` runs THIS command in DIR, so the
        // segment is scoped there even though the shell never moved. Declared
        // beside `dir` because BOTH the scope resolution and the safety hint
        // read it, and they are far apart — my first placement put it after the
        // first reader and the guard threw on every file.
        const envDir =
          dir?.kind === 'env-chdir'
            ? input
                .map((st) => scopeOfCwd(resolveDir(st.cwd, dir.target, shellVars)))
                .find(Boolean) ?? null
            : null;
        // Where THIS command runs, which is not always where the shell stands:
        // `env --chdir X helper.sh` execs the helper with cwd X, so both the
        // helper's own PATH and the scope its deploys land in resolve there
        // (#1995 r23). Falls back to the shell's cwd for every other segment.
        const execCwd =
          dir?.kind === 'env-chdir'
            ? resolveDir(input[0]?.cwd ?? '', dir.target, shellVars)
            : (input[0]?.cwd ?? '');
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
        // A CONDITIONAL BODY may not run, and the state before it stays
        // reachable either way (#1995 r16). `cd apps/agent`, then `if false;
        // then cd ../indexer; fi`, leaves bash in the AGENT — but the branch's
        // move was applied unconditionally and the bare deploy after it passed.
        // The if/else form is the same question twice: both outcomes are
        // reachable, and taking only the last one lost the agent leg.
        //
        // `do` is included for the zero-iteration loop, which is the same
        // shape: a `for`/`while` body need never execute.
        //
        // Modelled as a UNION rather than by tracking `fi`, because the union
        // is what the rest of this walk already speaks — `||` has worked this
        // way since r9 — and a `fi` tracker would be a second, parallel model
        // of reachability for one construct.
        const branchBody = /^(?:then|else|elif|do)\b/.test(seg);
        const after2 = branchBody ? dedupeStates([...input, ...after]) : after;
        const skipped = nextPart?.sep === '&&' ? [] : prior;
        const next =
          part.sep === '||'
            ? dedupeStates([...states, ...after2])
            : part.sep === '&&'
              ? dedupeStates([...skipped, ...after2])
              : after2;
        prior = input;
        states = next;
        // BEFORE the directive short-circuit below. `source` is now a
        // directive, so `if (dir) continue` skipped the very segment that
        // carries the helper — the deferred handling was written after it and
        // was unreachable for exactly the case it exists for. Traced, not
        // guessed: two hypotheses about the prefilter and about path
        // resolution were both wrong before the segment trace showed the loop
        // exiting here.
        const deferred = [];
        if (dir?.kind === 'source') {
          deferred.push(...sourcedDeploys(resolveDir(execCwd, dir.target, shellVars)));
        }
        // A helper EXECUTED as its own process inherits this shell's cwd just
        // as a sourced one does — `cd apps/agent; ../../deploy.sh` (or
        // `bash ../../deploy.sh`) runs the helper's bare deploy FROM the agent
        // — but only `source` deferred, so the caller was skipped and the
        // helper's own scan had no scope (#1995 r19). Unlike source, the
        // child's directory changes never return to this shell; that falls
        // out of the detection being read-only — nothing here touches the
        // walk's states, and `sourcedDeploys` applies the helper's moves only
        // to the deferred entries themselves.
        // Leading `VAR=value` words are ENVIRONMENT, not the command — the
        // same reading `executedCommand` gives every other command word.
        const runWord = executedCommand(seg);
        // The third alternative is the WINDOWS family — `call ..\..\deploy.cmd`
        // and its launcher spellings (#1995 r21). It requires one of the
        // Windows extensions, which is what lets the optional launcher prefix
        // stay optional without admitting a bare word.
        // `env --chdir X helper.sh` IS a directive AND a command — the same
        // reason the directive short-circuit below exempts `env-chdir`. Gating
        // this on `!dir` skipped the helper entirely (#1995 r23).
        const execHelper =
          (!dir || dir.kind === 'env-chdir') &&
          runWord.match(
            new RegExp(
              String.raw`^(?:(?:bash|sh|zsh|ksh|dash)\s+(?:-\S+\s+)*((?:[\w.@-]+\/)*[\w.@-]+)|(\.{0,2}\/(?:[\w.@-]+\/)*[\w@-]+|(?:[\w.@-]+\/)*[\w.@-]+\.(?:sh|bash|zsh|ksh))|(?:(?:call|cmd\s+\/[cCkK]|powershell|pwsh)(?:\s+[-\/]\S+(?:\s+(?![-\/])[^\s\\\/]+(?=\s))?)*\s+)?((?:[\w.@-]+[\\\/])*[\w.@-]+\.(?:cmd|bat|ps1))|(?:node|bun|tsx)(?:\s+-\S+(?:\s+(?!-)[^\s]+(?=\s))?)*\s+((?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|ts))|(?:python3?|py)(?:\s+-\S+(?:\s+(?!-)[^\s]+(?=\s))?)*\s+((?:[\w.@-]+\/)*[\w.@-]+\.py))(?:\s|$)`,
            ),
          );
        if (execHelper) {
          // A Windows path names the same file with the other separator, and
          // `resolveDir` speaks `/`.
          const target = (
            execHelper[1] ??
            execHelper[2] ??
            execHelper[3] ??
            execHelper[4] ??
            execHelper[5]
          ).replace(/\\/g, '/');
          deferred.push(
            ...sourcedDeploys(resolveDir(execCwd, target, shellVars)),
          );
        }
        if (/^shopt\s+-s\b[^;]*\bexpand_aliases\b/.test(seg)) aliasesOn = true;
        const aliasDef = seg.match(
          /^alias\s+([A-Za-z_][\w-]*)=("[^"]*"|'[^']*'|[^\s]+)\s*$/,
        );
        if (aliasDef) {
          const entries = unsafeWithDirs(
            splitCommands(dequote(aliasDef[2])).map((c) => c.text.trim()),
          );
          if (entries.length > 0) deployAliases.set(aliasDef[1], entries);
          continue;
        }
        // The COMMAND WORD, arguments allowed: `deploy_worker production`
        // still invokes the recorded helper, and requiring the name to be the
        // whole segment missed every call that passes one (#1995 r19). Only
        // names actually recorded in `deployFns`/`deployAliases` resolve, so
        // ordinary commands' first words look up nothing.
        // …and the call itself may be assignment-prefixed: `MODE=production
        // deploy_worker arg` still invokes the recorded helper, but the
        // matcher required the name to be the segment's first word (#1995
        // r20). Read from the same `executedCommand` view.
        const callName = runWord.match(/^([A-Za-z_][\w-]*)(?:\s+\S.*)?$/)?.[1];
        if (callName && deployFns.has(callName)) deferred.push(...deployFns.get(callName));
        if (callName && aliasesOn && deployAliases.has(callName)) {
          deferred.push(...deployAliases.get(callName));
        }
        // Each deferred deploy is scored where the helper's OWN directory
        // moves put it, starting from the caller's reachable states — a
        // helper that runs `cd ../agent` before its deploy lands somewhere
        // the caller never stood (#1995 r17).
        for (const e of deferred) {
          const from =
            dir?.kind === 'env-chdir' ? [{ cwd: execCwd, stack: [] }] : input;
          const landed = from.map((st) => e.dirs.reduce((acc, d) => applyDir(acc, d, null), st));
          const at = landed.map((st) => scopeOfCwd(st.cwd)).find(Boolean) ?? null;
          if (at) {
            flagged = true;
            hitScopes.add(at);
          }
        }
        // `env-chdir` is not a move, it is a WRAPPER around the command in this
        // same segment — so the segment must go on to be scored. Skipping it
        // here is the third time the directive short-circuit has swallowed a
        // segment that still had a deploy in it (`source` was the second).
        if (dir && dir.kind !== 'env-chdir') continue;
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
          // A GLOB is a list, not an unknown. `for TARGET in apps/*` iterates
          // the real directories, one of which is a protected package — and
          // dropping the value left `cd "$TARGET"` unresolved, so the loop's
          // bare deploy passed (#1995 r16). Expanded against the tree the
          // scanner is already walking, one path component at a time; a glob in
          // the DIRECTORY part is left unexpanded rather than guessed.
          const expandGlob = (pat) => {
            // The `$` guard is an EQUIVALENT MUTANT and is recorded as one
            // rather than fixtured: a pattern carrying an unresolved variable
            // fails the directory lookup anyway, because no path on disk is
            // spelled with it. Measured over eleven patterns mixing leading,
            // interior and quoted variables against the real tree; guarded and
            // unguarded agreed on all eleven. Kept because it states the rule
            // — an unknown expands to nothing — where a reader looks for it.
            if (/\$/.test(pat)) return [];
            const slash = pat.lastIndexOf('/');
            const dir = slash === -1 ? '' : pat.slice(0, slash);
            const base = slash === -1 ? pat : pat.slice(slash + 1);
            if (/[*?]/.test(dir)) return [];
            let entries = [];
            try {
              entries = readdirSync(dir ? `${REPO_ROOT}/${dir}` : REPO_ROOT);
            } catch {
              return [];
            }
            const re = new RegExp(
              `^${base
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.')}$`,
            );
            return entries.filter((e) => re.test(e)).map((e) => (dir ? `${dir}/${e}` : e));
          };
          // A BRACE LIST is a list too: `apps/{indexer,agent}` is two words to
          // bash, and splitting on whitespace alone left it a single literal
          // that matched no package (#1995 r16).
          //
          // A `$` in ONE alternative does not make the others unknown: bash
          // expands `apps/{$X,agent}` to both, and the agent iteration really
          // does run. Refusing the whole group there was my first cut and it
          // was simply wrong — the per-value `$` filter below already drops the
          // alternatives that stay unresolved, which is the right granularity.
          // Mutation caught it: widening the pattern changed a verdict, and the
          // widened answer was the correct one.
          const expandBraces = (v) => {
            const m = v.match(/^([^{}]*)\{([^{}]*)\}([^{}]*)$/);
            if (!m) return [v];
            return m[2].split(',').map((alt) => `${m[1]}${alt}${m[3]}`);
          };
          const vals = loop[2]
            .split(/\s+/)
            .map((v) => dequote(v))
            .filter(Boolean)
            .flatMap(expandBraces)
            .flatMap((v) => (/[*?]/.test(v) ? expandGlob(v) : /\$/.test(v) ? [] : [v]));
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
          // EVERY binding in the command, not just the first. Bash persists all
          // of `TARGET=apps/agent OTHER=x`, but the matcher above is
          // end-anchored and so accepted only a lone pair — the combined form
          // parsed as nothing, the binding was dropped, and a later
          // `cd "$TARGET"` cleared scope (#1995 r16).
          //
          // Same literal-only rule as the single form: a computed value CLEARS
          // its name rather than leaving the previous binding standing, which
          // is r14's rule applied per name.
          for (const one of seg.matchAll(
            new RegExp(
              `(?:^|\\s)([A-Za-z_][A-Za-z0-9_]*)=` +
                '((?:"[^"]*"|\'[^\']*\'|[^\\s"\'`;&|)\\\\])*)',
              'g',
            ),
          )) {
            if (one[2] && !/\$/.test(one[2])) shellVars.set(one[1], dequote(one[2]));
            else shellVars.delete(one[1]);
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
        // A deploy whose TEXT lives elsewhere but whose STATE is here (#1995
        // r16). Two spellings, one proposition: the command runs in the
        // caller's directory, and neither file alone shows both halves.
        //
        //   `deploy_worker() { wrangler deploy; }` … `cd apps/agent`;
        //   `deploy_worker`     — the definition was read before any protected
        //                         scope existed, and the CALL was ignored.
        //   `cd apps/agent`;
        //   `source deploy.sh`  — the helper's own scan has no scope, and the
        //                         caller discarded everything in it that was
        //                         not a directory directive.
        //
        // Scope comes from the CALLER's reachable states, because the same
        // helper or function invoked from two directories deploys two different
        // Workers and only the state says which.
        // Both spellings bash accepts: `name() {` (keyword optional) and the
        // keyword form WITHOUT parentheses, `function name {` — the second
        // requires the keyword, or any brace-group after a word would read as
        // a definition (#1995 r18).
        const fnDef =
          seg.match(/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{([\s\S]*)$/) ??
          seg.match(/^function\s+([A-Za-z_][\w-]*)\s*\{([\s\S]*)$/);
        if (fnDef) {
          const open = 1 + braceDelta(fnDef[2]);
          const body = fnDef[2].replace(/\}\s*$/, '').trim();
          if (open <= 0) {
            const entries = unsafeWithDirs(splitCommands(body).map((c) => c.text.trim()));
            if (entries.length > 0) deployFns.set(fnDef[1], entries);
          } else {
            pendingFn = { name: fnDef[1], depth: open, segs: body ? [body] : [] };
          }
          continue;
        }
        const fnOpen =
          seg.match(/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*$/) ??
          seg.match(/^function\s+([A-Za-z_][\w-]*)\s*$/);
        if (fnOpen) {
          pendingFn = { name: fnOpen[1], depth: 0, segs: [], awaitingBrace: true };
          continue;
        }
        // `\b` so `wrangler deployments list` is not read as a deploy.
        if (
          !new RegExp(ANY_DEPLOY_RE).test(expandCommandVars(dequote(seg), fileVars)) &&
          !new RegExp(ANY_DEPLOY_RE).test(seg) &&
          // Same widening as the prefilter above (#1995 r9).
          !new RegExp(ANY_DEPLOY_RE).test(dequote(seg)) &&
          !new RegExp(ANY_DEPLOY_RE).test(
            resolveRunAlias(seg, aliasContext(input, rel)) ?? '',
          )
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
            (dir?.kind === 'env-chdir'
              ? envDir
              : input.map((st) => scopeOfCwd(st.cwd)).find(Boolean)) ??
            null;
        if (!scope) continue;
        // Statically-known SINGLE-WORD values are expanded before the safety
        // question too. `FLAGS=--keep-vars` then `wrangler deploy "$FLAGS"` is a
        // safe deploy that bash really does make safe, and scoring the raw
        // segment reported it — a false red on a correct command (#1995 r16).
        //
        // `expandCommandVars` leaves multiword values alone away from the head,
        // so this cannot resurrect the `echo "$MSG"` case: what it admits here
        // is a lone flag word, which is what the reported wrapper writes.
        // The cwd first, then the FILE. `apps/agent/release.sh` running a bare
        // `versions upload` with no `cd` has no cwd scope at all, and falling
        // through to "any scoped config" let the KEEPER's `keep_vars` bless an
        // AGENT upload (#1995 r16) — the caller does know which worker, just
        // not from the directory walk.
        // When `env --chdir` moves the command, its target is the ONLY scope:
        // the shell's own directory is not where this command runs, and falling
        // back to it reported the agent for a deploy that runs in `apps/www`.
        //
        // On THIS read — the safety hint — the restriction is an EQUIVALENT
        // MUTANT, recorded rather than fixtured. It differs from the fallback
        // only when `envDir` is null, and in that case the SCOPE resolution
        // below is null too, so the segment is not reported whatever the safety
        // answer is. It is written the same way as the scope read so the two
        // agree by construction, not because a verdict depends on it.
        const safeHint = dir?.kind === 'env-chdir'
          ? envDir
          : input.map((st) => scopeOfCwd(st.cwd)).find(Boolean) ??
            SCOPED.find((sc) => rel.startsWith(`${sc.dir}/`)) ??
            null;
        const aliased = resolveRunAlias(seg, aliasContext(input, rel));
        // The modelled cwd, so an explicitly selected `--config` resolves the
        // way wrangler resolves it.
        const cmdCwd = input.map((st) => st.cwd).find(Boolean) ?? '';
        if (
          commandIsSafe(aliased ?? seg, safeHint, cmdCwd) ||
          (aliased === null && commandIsSafe(expandCommandVars(seg, fileVars), safeHint, cmdCwd))
        ) {
          continue;
        }
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
      // Carry the depth the line ENDS at into the next one. `depth` is assigned
      // at each segment's START, so after the loop it still held the last
      // segment's entry depth — a line that is nothing but `(` left it at 0,
      // and the next line therefore began outside the subshell it had just
      // opened. That is why hoisting the stack alone changed nothing.
      depth = pendingDepth;
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
  // `UNNAMED_SCOPE` is appended rather than folded into `SCOPED`: it is a
  // reporting group, not a protected package, and every other reader of
  // `SCOPED` — the directory matcher, the filter matcher, the config lookup —
  // would start treating it as one. Iterating `SCOPED` alone here would have
  // dropped its violations from the output entirely while still counting them
  // in the header, which is the worst of both.
  for (const s of [...SCOPED, UNNAMED_SCOPE]) {
    const hits = violations.filter((v) => v.scope === s);
    if (hits.length === 0) continue;
    console.error(`  ${s.dir}:\n`);
    for (const v of hits) console.error(`    ${v.where}\n      ${v.line}\n`);
    if (s === UNNAMED_SCOPE) {
      // The remedy is SYNTAX, so it has to be the syntax of the file the
      // operator will actually edit. A flat `"keep_vars": true` is invalid TOML,
      // and it was the ONLY remedy offered for `versions upload`, where the CLI
      // flag genuinely does not exist — so a TOML user following the message
      // exactly would produce a config that no longer parses (Codex #2036 r1).
      // Both spellings are shown unless the reported lines settle which applies.
      const exts = hits.map((v) => (/--config[= ]\S*\.toml\b|\.toml\b/.test(v.line) ? 'toml' : 'json'));
      const only = exts.every((e) => e === exts[0]) ? exts[0] : null;
      const decl =
        only === 'toml'
          ? '`keep_vars = true`'
          : only === 'json'
            ? '`"keep_vars": true`'
            : '`keep_vars = true` (TOML) / `"keep_vars": true` (JSON)';
      console.error(
        `    This command selects a configuration file, and wrangler takes the Worker's\n` +
          `    identity from that file's \`name\` — which could not be read here (the path\n` +
          `    is computed, the file is absent from the checkout, it does not parse, or it\n` +
          `    declares no literal name).\n\n` +
          `    Rather than guess which Worker this deploys, the guard asks the command to\n` +
          `    be safe for whatever it targets: add --keep-vars, or declare\n` +
          `    ${decl} in the selected config — which is also the only remedy\n` +
          `    for \`versions upload\`, where the flag does not exist.\n`,
      );
      continue;
    }
    console.error(
      `    Use \`pnpm --filter ${s.filter} run deploy\` (the package script carries\n` +
        `    the flag), or add --keep-vars explicitly. A bare deploy deletes every var\n` +
        `    not in ${s.dir}/wrangler.jsonc — including the ${s.vars}\n` +
        `    tuning its source reads.\n`,
    );
    // `versions upload` takes no `--keep-vars` — the pinned wrangler derives
    // `keepVars` from `config.keep_vars` — so the remedy above is not a command
    // an operator can run for that path. Naming the real one matters: a remedy
    // the CLI rejects sends the reader in a circle, and the finding that
    // surfaced this was as much about what the guard RECOMMENDS as about what
    // it accepts (#1995 r16).
    if (hits.some((v) => /\bversions\b[\s\S]*?\bupload\b/.test(v.line))) {
      console.error(
        `    For \`versions upload\` the flag does not exist: set \`"keep_vars": true\`\n` +
          `    in ${s.dir}/wrangler.jsonc, which is where wrangler reads it from.\n`,
      );
    }
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
