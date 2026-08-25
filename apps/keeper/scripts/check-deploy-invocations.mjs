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
const DEPLOY_RE = String.raw`wrangler(?:@[^\s]+)?\s+(?:-{1,2}[A-Za-z0-9-]+(?:[= ][^\s-][^\s]*)?\s+)*deploy\b`;

/** Vendored trees excluded by exact repo-relative path, not by basename. */
const SKIP_PATHS = new Set(['contracts/lib']);

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
  if (!hit) return null;
  // The exemption covers the KNOWN prose occurrence, not the whole line. An
  // allowlisted sentence that later grows a real command beside it —
  // `…a bare \`wrangler deploy\` is dangerous; wrangler deploy` — would
  // otherwise be exempted wholesale (Codex #1924 r27). Remove the matched
  // fragment and see whether a deploy is still standing.
  const rest = line.split(hit.match).join(' ');
  return new RegExp(DEPLOY_RE).test(rest) ? null : hit.why;
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

function stripOtherOptionValues(line) {
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
  return line.replace(
    new RegExp(
      `--(?!keep-vars\\b|dry-run\\b|no-keep-vars\\b|no-dry-run\\b)[A-Za-z0-9-]+(?:=${CHUNKS}|\\s+(?!-)${CHUNKS})`,
      'g',
    ),
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
  const line = stripOtherOptionValues(stripRedirections(rawLine));
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
  const re = new RegExp(
    `(?<![^\\s(\`'"])${flag}(?:=((?:"[^"]*"|'[^']*'|[^\\s"'\`)\\u0000]+)+)` +
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
  const emptyRe = new RegExp(`(?<![^\\s(\`'"])${flag}=(?=\\s|$)`, 'g');
  for (const m of line.matchAll(emptyRe)) events.push({ at: m.index, on: false });
  const negRe = new RegExp(
    `(?<![^\\s(\`'"])--no-${flag.replace(/^--/, '')}\\b`,
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
  const bare = stripOtherOptionValues(stripRedirections(cmd));
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
function isSafe(line) {
  const deploys = splitCommands(line).filter((c) => new RegExp(DEPLOY_RE).test(c));
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

/**
 * Shell continuation / comment rules apply to shell scripts, not to prose.
 * Detected by extension or shebang — the same two signals an editor uses.
 */
function isShellFile(rel, text) {
  return rel.endsWith('.sh') || /^#!.*\b(ba|z|k)?sh\b/.test(text);
}

/**
 * An extensionless file is a shebang candidate — conventional for executable
 * wrappers (`contracts/script/deploy-keeper`). A dotfile is not.
 */
function looksExecutable(entry) {
  return !entry.includes('.') && entry.length > 0;
}

/** Does this `cd`/`pushd` target put the shell in the keeper's directory? */
function isKeeperDir(target) {
  return /(^|\/)apps\/keeper\/?$/.test(target) || /KEEPER_DIR/.test(target);
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
      out.push(...offset(logicalLines(body), start, blockId));
      blockId += 1;
      i = j;
      continue;
    }
    if (flow) {
      const end = flowScalarEnd(lines, i, flow[2], flow[1].length);
      // Only a scalar that actually SPANS lines is folded into a block. A
      // single-line `run:` is already judged correctly as a physical line, and
      // routing it through here as well would report one violation twice.
      if (end > i) {
        let joined = [flow[2], ...lines.slice(i + 1, end + 1)]
          .map((l) => l.trim())
          .join(' ');
        const q = flow[2][0] === '"' || flow[2][0] === "'" ? flow[2][0] : null;
        if (q) {
          joined = joined.slice(1);
          const last = joined.lastIndexOf(q);
          if (last !== -1) joined = joined.slice(0, last) + joined.slice(last + 1);
        }
        // Folds to ONE line, reported at the `run:` line — the line an operator
        // opens to fix it.
        out.push(...offset(logicalLines(joined), i, blockId));
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
    // key. A blank line, a new list item, or a comment ends it.
    let j = i;
    while (
      j + 1 < lines.length &&
      lines[j + 1].trim() !== '' &&
      (lines[j + 1].match(/^\s*/) ?? [''])[0].length > indent &&
      !/^\s*[-#]/.test(lines[j + 1])
    ) {
      j += 1;
    }
    return j;
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
function offset(block, start, blockId) {
  return block.map((l) => ({ text: l.text, line: l.line + start, block: blockId }));
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
    : [...plainLines(text), ...embeddedShellLines(text, /\.ya?ml$/.test(rel))];
  if (!folded.some((l) => new RegExp(DEPLOY_RE).test(l.text))) continue;
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
  const dirStack = [];
  let currentBlock;
  folded.forEach(({ text: line, line: lineNo, block, physical }) => {
    // Each embedded block is a SEPARATE shell — an Actions step starts fresh,
    // and so does the next fenced example. Carrying `cwdIsKeeper` across them
    // made one block's `cd apps/keeper` reject the NEXT block's agent deploy
    // (Codex #1924 r29). That is a false positive, and this guard runs in
    // typecheck, so it would have blocked CI on a correct workflow.
    if (block !== currentBlock) {
      currentBlock = block;
      cwdIsKeeper = false;
      dirStack.length = 0;
    }
    if (/^\s*$/.test(line) || /^\s*(?:`{3,}|~{3,})/.test(line)) {
      cwdIsKeeper = false;
      return;
    }
    let flagged = false;
    if (physical) {
      // Prose cannot cd a shell, so a non-shell line is judged on its own
      // content only — it neither reads nor writes the directory state.
      flagged =
        new RegExp(DEPLOY_RE).test(line) && isKeeperScoped(line, rel) && !isSafe(line);
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
      for (const seg of splitCommands(line).map((c) => c.trim())) {
        const pushed = seg.match(/^pushd\s+["']?([^\s"';&|)]+)/);
        if (pushed) {
          dirStack.push(cwdIsKeeper);
          cwdIsKeeper = isKeeperDir(pushed[1]);
          continue;
        }
        if (/^popd\b/.test(seg)) {
          cwdIsKeeper = dirStack.length > 0 ? dirStack.pop() : false;
          continue;
        }
        const bareCd = seg.match(/^cd\s+["']?([^\s"';&|)]+)/);
        if (bareCd) {
          cwdIsKeeper = isKeeperDir(bareCd[1]);
          continue;
        }
        // `\b` so `wrangler deployments list` is not read as a deploy.
        if (!new RegExp(DEPLOY_RE).test(seg)) continue;
        // Line-level scope still counts alongside the walked cwd:
        // `KEEPER_DIR=apps/keeper; wrangler deploy` names the keeper on the
        // line without any `cd` for the walk to record, and a subshell's
        // `( cd "$KEEPER_DIR" && … )` is deliberately not walked either.
        if (!isKeeperScoped(seg, rel) && !isKeeperScoped(line, rel) && !cwdIsKeeper) continue;
        if (commandIsSafe(seg)) continue;
        flagged = true;
      }
    }

    if (!flagged) return;
    if (allowReason(line)) return;
    violations.push(`${rel}:${lineNo}\n    ${line.trim()}`);
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
