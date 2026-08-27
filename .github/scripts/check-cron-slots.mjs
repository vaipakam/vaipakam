#!/usr/bin/env node
/**
 * Cron-slot gate: the account's trigger occupancy is stated in ONE file.
 *
 * WHY THIS EXISTS (#1977). The Cloudflare free plan caps the account at 5
 * cron triggers. How many are in use was, until this gate, restated in TEN
 * places — three wrangler configs, three source comments, a README, a design
 * doc and two operator runbooks. All ten agreed with each other, and all ten
 * were wrong, because the fourth live trigger belongs to
 * `vaipakam-offchain-data-archive` — a Worker that has no source in this
 * repository and is therefore invisible to anyone counting `crons` entries
 * across the tree.
 *
 * That is the whole shape of the defect: an occupancy count is a claim about
 * an ACCOUNT, and the account changes without touching the tree. Care while
 * editing cannot keep such a claim true, and ten careful copies did not.
 * So the count lives once, in `docs/ops/CloudflareCronSlots.md`, with the
 * date it was last checked; everywhere else says why a Worker registers one
 * schedule rather than two, and links there.
 *
 * ── THE ADMISSION CRITERION ───────────────────────────────────────────────
 *
 * Same criterion as `check-docs-paths.mjs`, and for the same reason:
 *
 *     A rule may ship here ONLY IF its finding is a real defect of the text
 *     even when the fragment it fired on is malformed.
 *
 * The offline rule below is CLOSED-WORLD POSITIVE — "does this text state an
 * occupancy?" A hit means the text really does restate a count that lives
 * elsewhere, whatever surrounds it. It cannot fire on nothing.
 *
 * What it deliberately does NOT ban is the CAP. "the free plan caps cron
 * triggers at 5 per ACCOUNT" is a fact about Cloudflare's pricing, true
 * independent of this account, and useful exactly where a reader meets a
 * `crons` array. Only OCCUPANCY — how many of those 5 are spoken for — is
 * account state. The patterns are written to that line, and the fixtures at
 * the bottom pin both sides of it, because a rule that also banned the cap
 * would fight its own remediation: the replacement sentence has to say what
 * the constraint IS.
 *
 * ── WHAT THE OFFLINE HALF CANNOT DO ───────────────────────────────────────
 *
 * It cannot tell whether the count in the authority file is CURRENT. Nothing
 * textual can — the truth is in the account. `--live` is that half: it reads
 * the account and diffs it against the table. CI runs the offline half only,
 * because CI has no account credentials, and because restating is the part a
 * reviewer cannot see happening while a stale stamp at least announces its
 * own age.
 *
 * Two halves, two different claims. Do not let a green offline run be read as
 * "the inventory is current" — it means "nobody re-copied the inventory".
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The one file allowed to state occupancy. */
const AUTHORITY = 'docs/ops/CloudflareCronSlots.md';

/**
 * Where a restated count actually costs something: the configs and comments
 * an author reads while deciding whether they may add a schedule, and the
 * operator/design docs they consult next. A positive scope rather than a
 * blocklist — historical records (`docs/ReleaseNotes/`,
 * `docs/FindingsAndFixes/`) state past counts correctly and must not be
 * rewritten to match today.
 */
const SCOPE = ['apps', 'ops', 'packages', 'docs/ops', 'docs/DesignsAndPlans'];

const TEXT_EXT = /\.(mjs|js|ts|tsx|jsonc|json|md|sh|toml|yml|yaml)$/;

/**
 * Context tokens. An occupancy shape only means cron occupancy if the
 * surrounding text is about cron triggers at all; "3 of 5 known violation
 * forms" in a keeper test is about something else entirely.
 *
 * Neither `schedule` nor `slot` is here, though both are the obvious next
 * words, and each was tried and removed against the real corpus:
 *
 *   - `schedule` is ordinary English here — a loan's periodic repayment
 *     schedule — and fired inside `apps/app/e2e/COVERAGE.md` on lender-cadence
 *     prose with no connection to Cloudflare.
 *   - `slot` is ordinary English here too. `apps/app/src/lib/rateChart.test.ts`
 *     names chart buckets "slots" and has a case for "no occupied slots, one
 *     slot, or adjacent slots" — every occupancy word in the vocabulary, about
 *     a rate chart.
 *
 * Both were findings about NOTHING, which is the one thing the admission
 * criterion forbids. `cron` and `trigger` have no second meaning in this
 * repository, and every genuine site says one or the other within the window,
 * because the sentence has to name what is being counted.
 */
const CONTEXT = /\b(cron|crons|trigger|triggers)\b/i;

/**
 * A gap between two words of one phrase. Not `\s+`: every site that matters is
 * a WRAPPED comment, so the words are routinely separated by a newline plus a
 * comment marker — `used all five\n// slots` in `apps/indexer/wrangler.jsonc`
 * is one phrase that `\s+` reads as two. The line-wrap-hides-the-match failure
 * has cost this repository real review rounds in ordinary prose; a rule that
 * inspects prose must not inherit it.
 */
const WRAP = String.raw`(?:\s|\*|\/\/|#|>)+`;

/**
 * The same gap where a separator is OPTIONAL — `5/5` has none around the
 * slash, `3 of 5` has one.
 *
 * Codex #1978 r1 found the cost of applying `WRAP` to one pattern and leaving
 * the rest on `\s`: `apps/indexer/src/index.ts` carries `all five were\n//
 * taken`, the gate reported success, and an in-scope file went on restating
 * the count. Every boundary in every pattern below is now wrap-tolerant, and
 * that exact phrase is a must-fire fixture, because the class of defect the
 * gate exists to catch was hiding in the gate itself.
 */
const GAP = String.raw`(?:\s|\*|\/\/|#|>)*`;

/**
 * Occupancy shapes. Each is a way the ten copies actually said it, plus the
 * near variants an author reaching for the same sentence would produce.
 *
 * NOT here, on purpose: `caps? .{0,24}\b(5|five)\b` and `\b(5|five) per
 * account\b` — those state the cap. See the admission criterion above.
 */
/** Number words the counts are written with, spelled or numeric. */
const N = String.raw`(?:\d+|one|two|three|four|five)`;

const OCCUPANCY = [
  // "3 of 5", "5/5", "4 of five", "three of 5"
  new RegExp(String.raw`\b${N}${GAP}(?:of|\/)${GAP}(?:5|five)\b`, 'i'),
  // "all five slots", "used all 5 cron triggers". The noun is REQUIRED: "all
  // five concerns" (Stage3WorkerSplitPlan) and "until all five hold"
  // (IncidentRunbook) are five of something else, in windows that happen to
  // mention cron. Bare "all five" fired on both.
  new RegExp(
    String.raw`\ball${WRAP}(?:5|five)${WRAP}(?:(?:cron|account)${WRAP})?(?:slots?|triggers?|schedules?)\b`,
    'i',
  ),
  // "occupy 3 today", "occupies four", "the rest of the org already occupies 4"
  new RegExp(String.raw`\boccup(?:y|ies|ied)\b[^.\n]{0,40}${GAP}\b${N}\b`, 'i'),
  // "4 are taken", "four were occupied", "3 in use", "4 in use today"
  new RegExp(String.raw`\b${N}${WRAP}(?:(?:are|were|is|was)${WRAP})?(?:taken|occupied|in${WRAP}use)\b`, 'i'),
  // "takes the account to 5", "brings the account to five"
  new RegExp(
    String.raw`\b(?:takes?|brings?|puts?)${WRAP}the${WRAP}account${WRAP}to${WRAP}${N}\b`,
    'i',
  ),
  // "one slot is genuinely SPARE", "leaving one spare", "no spare slot".
  // Near-bare, because the CONTEXT requirement already scopes it: "spare"
  // beside cron/trigger vocabulary is an occupancy claim however the sentence
  // is arranged, and the arrangements varied across all ten copies.
  // Anchoring it to a preceding number word missed the commonest one.
  //
  // There was a lookbehind here exempting DENIALS — "not spare", "never
  // spare", "reserved rather than spare" — on the theory that those state the
  // reservation POLICY rather than a count. Codex #1978 r2 falsified it, and
  // the counterexample is decisive: "Cron capacity is not spare right now" and
  // "Cron triggers are never spare" are negated in exactly the same shape and
  // are account-wide zero-capacity claims, identical in meaning to the
  // must-fire fixture "There is no spare cron trigger." A lookbehind can prove
  // the preceding word is `not`; it cannot tell what the sentence's SUBJECT is,
  // and that is the whole distinction. So the gate silently permitted a
  // restated count in two phrasings while firing on a third.
  //
  // Dropped rather than narrowed. "Spare" is a claim about available capacity
  // whichever way the sentence runs, and the policy it was protecting says
  // itself better without the word: "the keeper's trigger is reserved" needs no
  // "rather than spare". Sweeping the tree confirmed the exemption was
  // protecting exactly one sentence, which is now reworded — every other
  // "spare" in scope is ordinary English ("room to spare", "spare bits") and
  // nowhere near cron vocabulary, so CONTEXT keeps the gate off them.
  /\bspare\b/i,
];

/**
 * How far either side of a hit is searched for a context token, in CHARACTERS
 * rather than lines.
 *
 * Lines were the first attempt and are wrong for this corpus: `COVERAGE.md`
 * writes one coverage row as a single 20,000-character line, so a two-line
 * radius there spans three rows of unrelated prose, while in a wrapped source
 * comment it spans about 140 characters. A character window means the same
 * thing in both, which is what "nearby" was supposed to mean all along.
 */
const CONTEXT_RADIUS = 200;

// ── Scanning ────────────────────────────────────────────────────────────────

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', ...SCOPE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p && TEXT_EXT.test(p) && p !== AUTHORITY);
}

/**
 * Findings for one file's text. Exported shape so the fixtures below drive
 * the same code path CI does, rather than a paraphrase of it.
 */
export function findOccupancyClaims(text) {
  const found = [];
  const seen = new Set();
  for (const re of OCCUPANCY) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(global)) {
      const at = m.index ?? 0;
      const window = text.slice(
        Math.max(0, at - CONTEXT_RADIUS),
        at + m[0].length + CONTEXT_RADIUS,
      );
      if (!CONTEXT.test(window)) continue;
      const line = text.slice(0, at).split('\n').length;
      if (seen.has(line)) continue; // one finding per line, whichever shape hit
      seen.add(line);
      found.push({ line, text: excerpt(text, at, m[0].length) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * The match plus a little either side, on one printable line. Reporting the
 * whole source line is useless here: the same corpus that forced a character
 * context window would print a 20,000-character "excerpt".
 */
function excerpt(text, at, len) {
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + len + 60);
  const pad = (s) => s.replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${pad(text.slice(from, to))}${to < text.length ? '…' : ''}`;
}

function runOffline() {
  if (!existsSync(AUTHORITY)) {
    console.error(`Cron-slot gate: the authority file ${AUTHORITY} is missing.`);
    console.error('It is where the occupancy count lives; without it this gate');
    console.error('would ban every statement of the count and offer nowhere to');
    console.error('put it. Restore the file rather than deleting this check.');
    return 1;
  }

  // The authority file's own internal consistency, first. If its summary and
  // its inventory disagree, the file is not an authority yet, and reporting
  // "occupancy stated only here" would be reporting on a contradiction.
  const authorityMd = readFileSync(AUTHORITY, 'utf8');
  const inv = parseInventory(authorityMd);
  const summaryProblems = [
    ...inv.problems,
    ...checkSummary(authorityMd, countTriggers(inv.live), inv.reserved.length),
  ];
  if (summaryProblems.length) {
    console.error(`Cron-slot gate: ${AUTHORITY} disagrees with itself.\n`);
    for (const p of summaryProblems) console.error(`  ${p}`);
    console.error('');
    console.error('The summary under "What that adds up to" is derived from the');
    console.error('inventory table and must be updated with it. This check is');
    console.error('offline on purpose: it catches the drift in CI, where there are');
    console.error('no account credentials to run --live with.');
    return 1;
  }

  const findings = [];
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable or binary-in-disguise; not this gate's business
    }
    for (const f of findOccupancyClaims(text)) findings.push({ file, ...f });
  }

  if (findings.length === 0) {
    console.log(`Cron-slot gate OK — occupancy stated only in ${AUTHORITY}.`);
    return 0;
  }

  console.error('Cron-slot gate: cron-trigger OCCUPANCY is restated outside');
  console.error(`${AUTHORITY}.\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text}`);
  console.error('');
  console.error('An occupancy count is a claim about the Cloudflare account, and');
  console.error('the account changes without touching this tree. Ten copies of');
  console.error('this count agreed with each other and were wrong together (#1977).');
  console.error('');
  console.error('To fix: say WHY the Worker registers one schedule rather than two,');
  console.error('and link to the authority for the arithmetic. Stating the CAP');
  console.error('("the free plan caps cron triggers at 5 per account") is fine and');
  console.error('is not what fired here — only how many of them are spoken for.');
  return 1;
}

// ── Live half ───────────────────────────────────────────────────────────────

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(path, token) {
  // Bounded: this runs interactively in an operator's terminal, and Node's
  // fetch has no default timeout — a hung call would sit there indefinitely
  // with nothing printed, which reads as "still checking" rather than as a
  // problem.
  const res = await fetch(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(
      `Cloudflare API ${path} failed: ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body.result;
}

/**
 * Parse the inventory table out of the authority file. Deliberately narrow:
 * it reads the first column's backticked Worker name and the second column's
 * backticked schedule, and ignores rows whose schedule cell is not a
 * backticked cron expression (the "(none)" / "(would be ...)" rows describe
 * Workers that hold no slot).
 */
/** Cloudflare Workers free-plan cron-trigger cap. */
const CAP = 5;

/**
 * The authority file's three-line summary, and whether it agrees with the
 * inventory table above it.
 *
 * WHY THIS EXISTS (Codex #1978 r1). The summary is a SECOND copy of the count,
 * inside the one file whose purpose is that there be only one — and in the
 * first revision it was unchecked. Retiring the archive Worker and deleting
 * its inventory row would have left the summary saying four were live while
 * the table showed three, and `--live` would still have reported a match,
 * because it compares rows to the account and never reads the summary.
 *
 * Keeping the summary and pinning it beats deleting it: a reader needs the
 * total and nobody counts rows. Pinning also puts the check OFFLINE, so CI
 * catches the drift without account credentials.
 *
 * A missing or reworded line is a FAILURE, never a skip. A summary parser that
 * silently matches nothing is the inventory parser's failure mode with the
 * loudness removed — it would report agreement it never tested.
 */
export function checkSummary(md, liveTriggers, reservedRows) {
  // Exactly one of each line. Not the first match — this whole change exists
  // because a second, unchecked copy of a count went unnoticed, and `exec`
  // reading only the first would reproduce that defect inside the check meant
  // to prevent it: a duplicated summary section could contradict itself and
  // still pass.
  const read = (label, re) => {
    const all = [...md.matchAll(new RegExp(re.source, re.flags + 'g'))];
    if (all.length === 0) {
      return {
        error: `the "${label}" line is missing or reworded; the script anchors on its exact wording`,
      };
    }
    if (all.length > 1) {
      return {
        error: `the "${label}" line appears ${all.length} times; there must be exactly one, or the two copies can disagree`,
      };
    }
    return { value: Number(all[0][1]) };
  };

  const live = read('Live right now', /^-\s+\*\*Live right now:\*\*\s+(\d+)\s+of\s+5\s*$/m);
  const committed = read(
    'Committed',
    /^-\s+\*\*Committed[^:]*:\*\*\s+(\d+)\s+of\s+5\s*$/m,
  );
  const spare = read('Genuinely spare', /^-\s+\*\*Genuinely spare:\*\*\s+(\d+)\s*$/m);

  const problems = [];
  for (const r of [live, committed, spare]) if (r.error) problems.push(r.error);
  if (problems.length) return problems;

  if (live.value !== liveTriggers) {
    problems.push(
      `summary says ${live.value} live, but the inventory table accounts for ${liveTriggers} trigger(s)`,
    );
  }
  // Codex #1978 r2: `committed >= live` was not a check, it was a range. It
  // passed whether the keeper's reservation row was present or absent, and
  // passed either "5 committed / 0 spare" or "4 committed / 1 spare" while the
  // row still said reserved. Committed is now DERIVED — live triggers plus the
  // rows the table itself marks reserved — so the summary is constrained by the
  // inventory it claims to summarise rather than merely being no smaller.
  const derived = liveTriggers + reservedRows;
  if (committed.value !== derived) {
    problems.push(
      `summary says ${committed.value} committed, but the inventory has ${liveTriggers} live ` +
        `+ ${reservedRows} reserved = ${derived}`,
    );
  }
  if (spare.value !== CAP - committed.value) {
    problems.push(
      `summary says ${spare.value} spare, but ${CAP} − ${committed.value} committed is ${CAP - committed.value}`,
    );
  }
  return problems;
}

export function parseInventory(md) {
  /** name -> the cron expressions that row carries, one entry per TRIGGER. */
  const live = new Map();
  /** names of rows the table marks reserved (no schedule, but budget spoken for). */
  const reserved = [];
  const problems = [];
  const seen = new Set();

  for (const line of md.split('\n')) {
    const row = /^\|\s*`([a-z0-9-]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/i.exec(line);
    if (!row) continue;
    const [, name, scheduleCell, , statusCell] = row;

    // Codex #1978 r2: `Map.set` silently overwrote a repeated name, so leaving
    // a stale row behind while adding its replacement produced a table with two
    // contradictory schedules that both halves would accept — they only ever
    // saw the last one. A repeat is now a finding, not a shrug.
    if (seen.has(name)) {
      problems.push(
        `the inventory lists \`${name}\` more than once; two rows for one Worker can disagree`,
      );
      continue;
    }
    seen.add(name);

    const schedule = /^\s*`([^`]+)`\s*$/.exec(scheduleCell);
    if (schedule) {
      // Codex #1978 r2: split on commas. One cell can legitimately carry two
      // schedules, and counting Map ENTRIES rather than triggers made such a
      // row worth one against a cap the account counts as two — with `--live`
      // printing the higher account total and still concluding "matches".
      live.set(
        name,
        schedule[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (/\breserved\b/i.test(statusCell)) {
      reserved.push(name);
    }
  }

  return { live, reserved, problems };
}

/** Triggers, not rows: a row carrying two schedules spends two of the five. */
export function countTriggers(live) {
  let n = 0;
  for (const crons of live.values()) n += crons.length;
  return n;
}

async function runLive() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.error('--live needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
    console.error('(Workers Scripts read is enough; this makes no writes).');
    return 2;
  }

  const scripts = await cf(`/accounts/${account}/workers/scripts?per_page=100`, token);
  const live = new Map();
  for (const s of scripts) {
    const r = await cf(
      `/accounts/${account}/workers/scripts/${s.id}/schedules`,
      token,
    );
    const crons = (r?.schedules ?? []).map((x) => x.cron).filter(Boolean);
    if (crons.length) live.set(s.id, crons);
  }

  const authorityMd = readFileSync(AUTHORITY, 'utf8');
  const inv = parseInventory(authorityMd);
  const committed = inv.live;

  const problems = inv.problems.map((p) => `INVENTORY     ${p}`);
  // Same self-consistency check the offline half runs. Without it, `--live`
  // could compare the account to the inventory rows, find them equal, and
  // print "matches the account" over a summary saying something else.
  for (const p of checkSummary(authorityMd, countTriggers(committed), inv.reserved.length)) {
    problems.push(`SUMMARY       ${p}`);
  }
  // Compared as multisets, not as joined strings: two schedules in one cell are
  // two triggers, and the account may report them in either order.
  const sameSchedules = (a, b) =>
    a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
  for (const [name, crons] of [...live].sort()) {
    if (!committed.has(name)) {
      problems.push(
        `ACCOUNT ONLY  ${name} is armed on \`${crons.join(', ')}\` and is absent from the inventory.`,
      );
    } else if (!sameSchedules(crons, committed.get(name))) {
      problems.push(
        `SCHEDULE      ${name}: account has \`${crons.join(', ')}\`, inventory says \`${committed.get(name).join(', ')}\`.`,
      );
    }
  }
  for (const [name, crons] of [...committed].sort()) {
    if (!live.has(name)) {
      problems.push(
        `INVENTORY ONLY ${name} is listed as armed on \`${crons.join(', ')}\` but the account has no schedule for it.`,
      );
    }
  }

  const total = [...live.values()].reduce((n, c) => n + c.length, 0);
  console.log(`Live cron triggers: ${total} of 5 (cap is Cloudflare's free plan).`);
  for (const [name, crons] of [...live].sort()) {
    console.log(`  ${name.padEnd(32)} ${crons.join(', ')}`);
  }

  if (problems.length === 0) {
    console.log(`\nInventory in ${AUTHORITY} matches the account.`);
    console.log('Refresh its "Verified:" stamp in the same commit as any edit.');
    return 0;
  }

  console.error(`\n${AUTHORITY} disagrees with the account:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  console.error('An ACCOUNT ONLY row is the #1977 failure mode exactly: a Worker');
  console.error('with no source in this tree, holding a slot nobody is counting.');
  return 1;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The rule's whole value is the line it draws between the CAP (allowed, and
// the replacement text needs it) and the OCCUPANCY (banned). A line drawn in
// regexes is not self-evident from reading them, so both sides are pinned.
// `--selftest` runs them; CI runs it before the scan, because a rule whose
// fixtures never execute is decoration.

const MUST_FIRE = [
  // The first two are quoted with the neighbouring line they actually had in
  // the tree, because the context token that qualifies them lives there and
  // not on the counting line. A one-line fixture would have pinned a rule
  // that never fires on the very text it was written for.
  [
    'the count, #1977 verbatim',
    '// account at 5 cron triggers total. apps/{agent,indexer} take one each\n' +
      '// (every-minute) and this Worker takes a third — 3 of 5 in use today,',
  ],
  [
    'occupy N',
    '* Why one cron at all: free-plan account cap of 5 cron triggers\n' +
      '* across the org. apps/{agent,indexer} plus this Worker occupy 3',
  ],
  // Wrapped across a comment marker, exactly as `apps/indexer/wrangler.jsonc`
  // carries it. `\s+` between "five" and "slots" does not match this, which is
  // why WRAP exists.
  [
    'all five, wrapped',
    "// cron triggers at\n// FIVE per ACCOUNT and this account's five Workers used all five\n// slots",
  ],
  [
    'takes the account to N',
    '// slot yet. Deploying it takes the account to 5 of 5. Splitting backup +\n' +
      '// healthcheck into two crons here would push past the cap',
  ],
  ['N are taken', 'cron triggers. Counting it as occupied, 4 are taken; the fifth is'],
  // The phrase the gate MISSED on its first pass (Codex #1978 r1), verbatim
  // from `apps/indexer/src/index.ts`. The wrap falls between "were" and
  // "taken", which `\s+` cannot cross — so the gate passed while an in-scope
  // file went on restating the count. Pinned so it cannot regress.
  [
    'N were taken, wrapped mid-phrase',
    '// (the free plan caps cron triggers at 5 per ACCOUNT; all five were\n' +
      '// taken when this was written, and the slot apps/keeper freed in',
  ],
  ['spare slot', 'One cron slot is genuinely SPARE today:'],
  ['no spare — a count of zero', 'There is no spare cron trigger.'],
  ['slash form', 'the account sits at 4/5 cron triggers'],
  // Codex #1978 r2's counterexamples, promoted from MUST_NOT_FIRE. Negated in
  // the shape the old lookbehind exempted, and identical in meaning to the
  // fixture two lines above — which is what proved the exemption unsound.
  ['negated, but still a capacity claim', 'Cron capacity is not spare right now.'],
  ['never spare', 'Cron triggers are never spare in this account.'],
  ['the wording the exemption protected', "// the keeper's cron trigger is reserved rather than spare"],
];

const MUST_NOT_FIRE = [
  ['bare cap', '// the free plan caps cron triggers at FIVE per ACCOUNT'],
  ['cap, numeral', 'The Cloudflare Workers free plan caps an account at 5 cron triggers.'],
  ['cap plus error code', '// caps triggers at FIVE per ACCOUNT (API error 10072 on the sixth)'],
  ['unrelated N-of-5', ' * twice before it did: the first cut caught 3 of 5 known violation forms,'],
  ['cadence modulo', '// acts only on minutes divisible by 5 (free-plan DO rows_written diet)'],
  ['a cron expression', '"crons": ["17 3 * * *"],'],
  ['pointer, the intended fix', '// One schedule, not two — see docs/ops/CloudflareCronSlots.md for the budget.'],
  // The reservation policy stated WITHOUT a capacity word — the rewording the
  // dropped exemption forced, and the shape to reach for. It says the same
  // thing and cannot go stale when the account changes, which was the property
  // the exemption was reaching for and could not express.
  ['reserve policy, no capacity word', "- **`apps/keeper`'s empty `\"crons\": []` is a reservation.**"],
  ['reserve policy, plain', "// the keeper's cron trigger is reserved for its return"],
  // "Spare" outside cron vocabulary. CONTEXT, not the pattern, is what keeps
  // the gate off these — which is why dropping the lookbehind cost nothing.
  ['ordinary English, room to spare', 'one external swap clears with room to spare'],
  ['ordinary English, spare bits', '`KEEPER_ACTION_SIGNED_FILL = 1 << 6` (2 spare bits today; bump'],
];

/**
 * Inventory-parser fixtures. The `--live` half is the one CI never runs, so
 * without these its parser has no coverage at all — and it is the half that
 * renders a verdict ("matches the account") rather than a list.
 *
 * The property being pinned is NOT "every row parses". It is that a row the
 * parser SKIPS can never become a silent pass: an armed Worker that fails to
 * parse is absent from `committed`, so `runLive` reports it as ACCOUNT ONLY,
 * which is the loudest finding the script has. Each `skip` case below is a
 * plausible way to write a row wrong; each is asserted to yield nothing rather
 * than a wrong schedule.
 */
const INVENTORY_CASES = [
  // [name, markdown, expected {live}, expected reserved[], expected problem count]
  [
    'plain row',
    '| `vaipakam-agent` | `* * * * *` | `apps/agent` | **live** |',
    { 'vaipakam-agent': ['* * * * *'] },
    [],
    0,
  ],
  [
    'reserved row counts toward committed',
    '| `vaipakam-keeper` | *(none)* | `apps/keeper` | unscheduled; slot **reserved** for its return |',
    {},
    ['vaipakam-keeper'],
    0,
  ],
  [
    'hypothetical schedule is neither live nor reserved',
    '| `vaipakam-mesh-watcher` | *(would be `*/15 * * * *`)* | `ops/mesh-watcher` | code-complete, **undeployed** |',
    {},
    [],
    0,
  ],
  ['bolded name skipped', '| **`vaipakam-x`** | `0 1 * * *` | `ops/x` | live |', {}, [], 0],
  // Codex #1978 r2: TWO triggers in one cell. Counting Map entries made this
  // row worth one against a cap the account counts as two.
  [
    'two schedules in one cell are two triggers',
    '| `vaipakam-y` | `* * * * *, 0 1 * * *` | `ops/y` | live |',
    { 'vaipakam-y': ['* * * * *', '0 1 * * *'] },
    [],
    0,
  ],
  // Codex #1978 r2: a stale row left beside its replacement. `Map.set` kept
  // only the last, so both halves accepted a table stating two contradictory
  // schedules for one Worker.
  [
    'a repeated Worker is a finding, not an overwrite',
    '| `vaipakam-z` | `0 1 * * *` | `ops/z` | live |\n| `vaipakam-z` | `0 2 * * *` | `ops/z` | live |',
    { 'vaipakam-z': ['0 1 * * *'] },
    [],
    1,
  ],
  ['header row ignored', '| Worker | Schedule | Source in this repo | Status |', {}, [], 0],
  ['separator ignored', '|---|---|---|---|', {}, [], 0],
];

/**
 * Summary fixtures.
 * `[name, markdown, liveTriggers, reservedRows, expectedProblemCount]`.
 *
 * The zero-problem case is the one that would have shipped broken: a summary
 * agreeing with its inventory must pass, and every way of disagreeing —
 * including a line that is simply absent — must not.
 */
const GOOD_SUMMARY = [
  '- **Live right now:** 4 of 5',
  "- **Committed, live plus the keeper's reserve:** 5 of 5",
  '- **Genuinely spare:** 0',
].join('\n');

const SUMMARY_CASES = [
  ['agrees with its inventory', GOOD_SUMMARY, 4, 1, 0],
  ['live disagrees with the trigger count', GOOD_SUMMARY, 3, 1, 2], // live wrong, committed then wrong too
  [
    'spare does not follow from committed',
    GOOD_SUMMARY.replace('**Genuinely spare:** 0', '**Genuinely spare:** 1'),
    4,
    1,
    1,
  ],
  // Codex #1978 r2: the old `committed >= live` accepted both of these while
  // the keeper row still said reserved. Committed is derived now, so each is a
  // finding rather than a permitted range.
  [
    'committed ignores the reservation row',
    GOOD_SUMMARY.replace("reserve:** 5 of 5", 'reserve:** 4 of 5'),
    4,
    1,
    2, // committed wrong, and spare no longer follows from it
  ],
  [
    'the reservation row was removed but committed still counts it',
    GOOD_SUMMARY,
    4,
    0,
    1,
  ],
  ['a line is missing', '- **Live right now:** 4 of 5', 4, 1, 2],
  ['a line was reworded', GOOD_SUMMARY.replace('Genuinely spare', 'Spare'), 4, 1, 1],
  ['no summary at all', '# Some other document', 4, 1, 3],
  // The recursion: a duplicated summary section is itself a second unchecked
  // copy of the count. Reading only the first match would let two contradicting
  // copies pass — the defect this check exists to prevent, inside the check.
  ['the summary appears twice', `${GOOD_SUMMARY}\n\n${GOOD_SUMMARY}`, 4, 1, 3],
  [
    'a contradicting second copy',
    `${GOOD_SUMMARY}\n\n${GOOD_SUMMARY.replace('**Live right now:** 4', '**Live right now:** 2')}`,
    4,
    1,
    3,
  ],
];

function runSelftest() {
  let bad = 0;
  for (const [name, md, liveTriggers, reservedRows, expected] of SUMMARY_CASES) {
    const got = checkSummary(md, liveTriggers, reservedRows).length;
    if (got !== expected) {
      console.error(`selftest: summary case "${name}" reported ${got} problem(s), expected ${expected}`);
      bad++;
    }
  }
  for (const [name, md, expectedLive, expectedReserved, expectedProblems] of INVENTORY_CASES) {
    const inv = parseInventory(md);
    const got = Object.fromEntries(inv.live);
    if (JSON.stringify(got) !== JSON.stringify(expectedLive)) {
      console.error(
        `selftest: inventory case "${name}" parsed live as ${JSON.stringify(got)}, expected ${JSON.stringify(expectedLive)}`,
      );
      bad++;
    }
    if (JSON.stringify(inv.reserved) !== JSON.stringify(expectedReserved)) {
      console.error(
        `selftest: inventory case "${name}" parsed reserved as ${JSON.stringify(inv.reserved)}, expected ${JSON.stringify(expectedReserved)}`,
      );
      bad++;
    }
    if (inv.problems.length !== expectedProblems) {
      console.error(
        `selftest: inventory case "${name}" reported ${inv.problems.length} problem(s), expected ${expectedProblems}`,
      );
      bad++;
    }
  }
  for (const [name, text] of MUST_FIRE) {
    if (findOccupancyClaims(text).length === 0) {
      console.error(`selftest: MUST_FIRE missed — ${name}\n    ${text}`);
      bad++;
    }
  }
  for (const [name, text] of MUST_NOT_FIRE) {
    const hits = findOccupancyClaims(text);
    if (hits.length > 0) {
      console.error(`selftest: MUST_NOT_FIRE fired — ${name}\n    ${text}`);
      bad++;
    }
  }
  if (bad) {
    console.error(`\n${bad} fixture(s) failed.`);
    return 1;
  }
  console.log(
    `Cron-slot gate selftest OK (${MUST_FIRE.length} fire, ${MUST_NOT_FIRE.length} quiet, ` +
      `${INVENTORY_CASES.length} inventory rows, ${SUMMARY_CASES.length} summaries).`,
  );
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let code;
  if (args.includes('--live')) code = await runLive();
  else if (args.includes('--selftest')) code = runSelftest();
  else code = runOffline();
  process.exit(code);
}
