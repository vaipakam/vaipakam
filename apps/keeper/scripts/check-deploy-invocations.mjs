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
  return /wrangler\s+deploy\b/.test(rest) ? null : hit.why;
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
  const line = stripOtherOptionValues(rawLine);
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
    `(?<![^\\s(\`'"])${flag}(?:[=\\s]+(?:"([^"]*)"|'([^']*)'|((?![-#])[^\\s"'\`)\\u0000]+)))?`,
    'g',
  );
  const events = [];
  for (const m of line.matchAll(re)) {
    // `(?![-#])` keeps the NEXT option and a trailing comment marker from being
    // read as this flag's value: under the true-only rule a bare
    // `--keep-vars # note` in prose was otherwise scored false.
    const value = m[1] ?? m[2] ?? m[3];
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
function isSafe(line) {
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
function embeddedShellLines(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^\s*```(?:bash|sh|shell|console)?\s*$/);
    const run = lines[i].match(/^(\s*)(?:-\s+)?run:\s*[|>][-+]?\s*$/);
    if (fence) {
      const start = i + 1;
      let j = start;
      while (j < lines.length && !/^\s*```/.test(lines[j])) j += 1;
      out.push(...offset(logicalLines(lines.slice(start, j).join('\n')), start));
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
      out.push(...offset(logicalLines(lines.slice(start, j).join('\n')), start));
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Shift a block's logical lines back to real file line numbers. */
function offset(block, start) {
  return block.map((l) => ({ text: l.text, line: l.line + start }));
}

/** Physical lines, 1-based, for everything that is not a shell script. */
function plainLines(text) {
  return text.split('\n').map((t, i) => ({ text: t, line: i + 1 }));
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
    : [...plainLines(text), ...embeddedShellLines(text)];
  if (!folded.some((l) => /wrangler\s+deploy/.test(l.text))) continue;
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
  folded.forEach(({ text: line, line: lineNo }) => {
    if (/^\s*$/.test(line) || /^\s*```/.test(line)) {
      cwdIsKeeper = false;
    } else {
      // `pushd` moves the shell exactly as `cd` does and is ordinary in deploy
      // wrappers; recognising only `cd` let `pushd apps/keeper` plus a bare
      // deploy on the next line through (Codex #1924 r27). `popd` returns
      // somewhere this scanner cannot know, so it conservatively clears scope.
      // `pushd`/`popd` are a STACK: after `pushd apps/keeper; pushd ../agent;
      // popd` the shell is back in apps/keeper. A single boolean lost that and
      // skipped the deploy underneath (Codex #1924 r28).
      const pushed = line.match(/^\s*pushd\s+["']?([^\s"';&|)]+)/);
      const popped = /^\s*popd\b/.test(line);
      const bareCd = line.match(/^\s*cd\s+["']?([^\s"';&|)]+)/);
      if (pushed) {
        dirStack.push(cwdIsKeeper);
        cwdIsKeeper = isKeeperDir(pushed[1]);
      } else if (popped) {
        cwdIsKeeper = dirStack.length > 0 ? dirStack.pop() : false;
      } else if (bareCd) {
        cwdIsKeeper = isKeeperDir(bareCd[1]);
      }
    }

    // `\b` so `wrangler deployments list` is not read as a deploy.
    if (!/wrangler\s+deploy\b/.test(line)) return;
    if (!isKeeperScoped(line, rel) && !cwdIsKeeper) return;
    if (isSafe(line)) return;
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
