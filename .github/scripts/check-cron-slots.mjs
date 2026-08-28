#!/usr/bin/env node
/**
 * Cron-slot gate: the account's trigger occupancy is stated in ONE file.
 *
 * WHY THIS EXISTS (#1977). The Cloudflare free plan caps the account at 5
 * cron triggers. How many are in use was, until this gate, restated in TEN
 * places — three wrangler configs, four source comments, a README, a design
 * doc and one operator runbook. All ten agreed with each other, and all ten
 * were wrong, because one live trigger belonged — as read from the account on
 * 2026-08-27 — to `vaipakam-offchain-data-archive`, a Worker that has no
 * source in this repository and is therefore invisible to anyone counting
 * `crons` entries across the tree. Whether it is still armed is the
 * authority's table's answer, not this comment's: this file is in
 * `SKIP_EXACT`, so nothing here is ever scanned, and a present-tense ordinal
 * written here would survive the retirement untouched and uncontradicted —
 * the stale copy this gate exists to prevent, inside the gate.
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

import { readFileSync, existsSync, statSync } from 'node:fs';
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
/**
 * What the occupancy scan SKIPS. Everything else tracked and textual is read.
 *
 * Codex #1978 r17: this was a positive list of roots — `apps`, `ops`,
 * `packages`, `docs/ops`, `docs/DesignsAndPlans` — which is a closed world,
 * and the leak was immediate and embarrassing: `.github/scripts/README.md`,
 * the handbook that DOCUMENTS this gate and which this same PR edited, was
 * never scanned. Nor were `.github/workflows/`, `CLAUDE.md`, or
 * `CONTRIBUTING.md`, all of them live guidance where a stale count would be
 * read and believed.
 *
 * That is the third closed world in this file to leak (the extension
 * allowlist twice, now the root list), so it gets the same treatment the
 * others did: replace the enumeration with a decidable test. Scanning is now
 * the default and the exclusions are named individually, each with a reason
 * that is about the FILE'S PURPOSE rather than its location — the only kind
 * of exclusion that cannot silently widen as the tree grows.
 *
 * Measured before the switch: tree-wide, exactly three tracked files carry
 * occupancy claims, and all three are below.
 */
const SKIP_EXACT = new Set([
  // The authority itself states the count — that is its job.
  'docs/ops/CloudflareCronSlots.md',
  // This gate's own source quotes claim shapes in its comments and carries
  // ~56 of them in the selftest fixtures. A checker cannot be its own
  // subject; the fixtures ARE the specification of what a claim looks like.
  '.github/scripts/check-cron-slots.mjs',
]);

/**
 * Directories whose content is a record of what was true ON A DATE, not a
 * claim about now. A release note saying "three of five triggers were live"
 * is correct history and must stay readable as written; rewriting it to
 * satisfy this gate would be falsifying the record.
 */
const SKIP_PREFIXES = [
  'docs/ReleaseNotes/',
  // Codex #1978 r38: `docs/OlderDocs/` holds dated snapshots — several are
  // literally `*_bak20260504.md` — and rewriting one to match today's account
  // would falsify the record it exists to preserve. Both sibling gates in this
  // directory already exclude it for that reason. This is the r18 finding
  // repeated exactly: the same archival tree, the same two siblings agreeing,
  // the same omission here — and the same consequence, a blocking gate firing
  // on a document nobody may correct.
  'docs/OlderDocs/',
  // Codex #1978 r18: this was missing while the comment above NAMED it, and
  // while `check-docs-paths.mjs` and `check-excision-residue.mjs` — the two
  // sibling gates in this directory — both already exclude it. Three places
  // agreed it was historical and one of them was the code. A dated incident
  // report recording "the account had four live cron triggers" is correct
  // history; a blocking gate demanding it be rewritten is the gate falsifying
  // the record.
  'docs/FindingsAndFixes/',
];

/**
 * Paths INSIDE a skipped tree that are scanned anyway.
 *
 * Codex #1978 r36: the `docs/ReleaseNotes/` prefix also exempted
 * `unreleased/`, and a pending fragment is not dated history. It is a
 * forward-looking description of the product as it is about to ship, written
 * by the same PR that changes behaviour — so a fragment saying the account
 * uses four of five triggers is a live claim, and the blanket prefix let it
 * pass indefinitely, including the fragment each of THESE PRs adds to describe
 * its own work.
 *
 * The sibling excision gate already draws exactly this line, for exactly this
 * reason, at `check-excision-residue.mjs`'s `EXCLUSION_CARVEOUTS`. Two gates in
 * one directory disagreeing about whether a pending fragment is history was the
 * kind of split this file has been closing all along.
 */
const SKIP_CARVEOUTS = ['docs/ReleaseNotes/unreleased/'];

/**
 * Whether a tracked file is text this gate should read.
 *
 * This was an extension ALLOWLIST until Codex #1978 r11, and it leaked twice in
 * two rounds: `.mts`/`.cts` (r10, with one such file already tracked), then
 * `.html` (r11, with `apps/app/index.html` and `apps/www/index.html` tracked
 * and both carrying comments). Patching it a third time would have been the
 * third patch on one class — an allowlist is a closed world that the tree keeps
 * reopening, and each reopening is silent, because a file type nobody added to
 * the list is simply not scanned.
 *
 * Replaced with the open-world test, which is decidable and needs no
 * maintenance: git tracks it, it holds no NUL byte in its first 8 KiB, and it
 * is not enormous. Measured on this tree, the allowlist read 961 of 1,053
 * tracked files in scope while only NINE are actually binary — so the closed
 * world was excluding 83 text files, any of which could have carried a
 * restatement past a blocking gate.
 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Paths git itself classifies as BINARY, from `git ls-files --eol`: the `i/`
 * field reads `-text` for a blob git treats as binary, and honours
 * `.gitattributes` over git's own sniffing.
 *
 * Codex #1978 r15: the previous test was "no NUL byte in the first 8 KiB",
 * which excluded `ops/mesh-watcher/src/finding.ts` — tracked, marked text by
 * `.gitattributes`, and containing a perfectly valid `join('\0')`. An
 * occupancy claim in that file's comments would have passed the blocking
 * gate.
 *
 * The irony is worth keeping: a stray `join('\0')` I wrote into THIS script
 * earlier in the same PR made the whole file read as binary to grep, which is
 * how I learned NUL-in-source is a real thing — and I then wrote a classifier
 * that assumed it was not. Git already answers this question, and asking the
 * tool that owns the fact beats re-deriving it, which is this PR's thesis.
 */
function binaryTrackedPaths() {
  const out = execFileSync('git', ['ls-files', '--eol', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const binary = new Set();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // Record shape: `i/<eol> w/<eol> attr/<attrs>\t<path>`.
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const fields = rec.slice(0, tab);
    const path = rec.slice(tab + 1);
    const attr = /attr\/(\S*)/.exec(fields)?.[1] ?? '';

    // An EXPLICIT `.gitattributes` setting wins over git's sniffing, in both
    // directions. This is not a detail: `ops/mesh-watcher/src/finding.ts` is
    // declared `text eol=lf` and STILL reports `i/-text`, because the blob
    // contains a valid `join('\0')` and git's index heuristic sees the NUL.
    // Keying on the index field alone would have left that file excluded —
    // the very file Codex named — so the fix would have shipped looking
    // correct and changing nothing. I only caught it by checking the file the
    // finding was about rather than trusting the mechanism I had just written.
    if (/(^|,)-text(,|$)/.test(attr)) {
      binary.add(path);
      continue;
    }
    // Codex #1978 r26: `text=auto` is NOT a forced-text declaration — it asks
    // git to DETECT, and git's answer is the `i/` field. A repo-wide
    // `* text=auto eol=lf` therefore made every binary look explicitly
    // declared, and the scan decoded and read them; embedded bytes matching an
    // occupancy phrase would fail the blocking gate on a file git calls
    // binary. Only an explicit `text` (no `=auto`) overrides detection.
    if (/(^|,)text(,|$)/.test(attr)) continue; // explicitly forced text: scan it
    if (/(^|\s)i\/-text(\s|$)/.test(fields)) binary.add(path);
  }
  return binary;
}

/**
 * Tracked text files too large to scan, collected so they can be REPORTED.
 *
 * Codex #1978 r36: an oversized file was silently removed from the scan, which
 * is a hole with a size threshold on it — grow a tracked document past 2 MiB,
 * add an occupancy claim, and the blocking gate still prints OK. A generated
 * report or a padded document is enough. Skipping quietly is the one behaviour
 * this gate cannot afford, because "scanned nothing" reads exactly like
 * "found nothing".
 */
const oversized = [];

function isScannableText(path, binary) {
  if (binary?.has(path)) return false;
  try {
    if (statSync(path).size > MAX_SCAN_BYTES) {
      oversized.push(path);
      return false;
    }
    return true;
  } catch {
    return false; // unreadable is not this gate's business
  }
}

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
// The {1,400} / {0,400} bounds are a ReDoS guard, not a formatting opinion
// (Codex #1978 r30 P1, r31). Unbounded, these overlap the lazy spans beside
// them and one whitespace run partitions quadratically — 100k spaces took
// ~22 s. Bounded, 10 ms. The first bound I chose was 40, which was arbitrary
// and cut a REAL claim wrapped onto a 38-space-indented comment line: a
// formatting-dependent cap on the gate's core job. 400 covers any plausible
// indentation and measures the same. If #1990 removes the need to parse
// wrapped comments at all, this goes with it.
const WRAP = String.raw`(?:\s|\*|\/\/|#|>){1,400}`;

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
const GAP = String.raw`(?:\s|\*|\/\/|#|>){0,400}`;

/**
 * Occupancy shapes. Each is a way the ten copies actually said it, plus the
 * near variants an author reaching for the same sentence would produce.
 *
 * NOT here, on purpose: `caps? .{0,24}\b(5|five)\b` and `\b(5|five) per
 * account\b` — those state the cap. See the admission criterion above.
 */
/** Number words the counts are written with, spelled or numeric. */
// `zero` included: Codex #1978 r14 — zero live triggers is a real account
// state and "the account currently has zero live cron triggers" goes stale in
// exactly the way "four" does. Numeric 0 was already covered by `\d+`; only
// the word was missing.
const N = String.raw`(?:\d+|zero|one|two|three|four|five)`;

/**
 * The capacity noun, with its optional compound qualifiers.
 *
 * "triggers", "cron triggers", "account cron triggers", "cron-slots" — one
 * thing, four spellings, and every matcher below needs the same one. It was
 * open-coded in each, and Codex #1978 r30/r31/r32 found the predictable
 * consequence three rounds running: the ratio matcher learned compound
 * qualifiers while its `all five` sibling stayed on a single one, and the
 * separator between qualifiers was `[-\s]{1,10}` in one place and `WRAP` in
 * another — so `4 of 5 account\n// cron triggers` was invisible while the
 * same phrase unwrapped fired.
 *
 * This is the "fix one member of a family, leave the sibling" shape that has
 * cost five rounds on this PR. The durable answer is not to fix the sibling;
 * it is to stop having siblings. One definition, one separator, wrap-aware
 * throughout — a hyphen is admitted alongside the wrap characters so
 * `cron-triggers` reads the same as `cron triggers`.
 *
 * The nested quantifier is safe because a mandatory literal (`cron`/`account`)
 * separates each repetition and the wrap class contains no letters, so the
 * partition is forced rather than searched. That is asserted, not assumed —
 * see the ReDoS guard in the selftest.
 */
const NOUN_GAP = String.raw`(?:\s|\*|\/\/|#|>|-){1,400}`;
const CAP_NOUN = String.raw`(?:(?:cron|account)${NOUN_GAP}){0,2}(?:slots?|triggers?|schedules?)`;

/**
 * Present-state adverbs, which may appear anywhere a claim asserts NOW.
 *
 * Codex #1978 r32: "No cron triggers are **currently** live." matched nothing,
 * because the r31 patterns put the predicate immediately after `are`. The
 * adverb is not incidental — it is the word that makes the sentence a claim
 * about the present, which is precisely what goes stale. Requiring the
 * predicate to be adjacent excluded the most explicitly time-bound form of
 * the very thing being matched.
 */
const TEMPORAL = String.raw`(?:currently|now|today|presently|still|right${WRAP}now|at${WRAP}present)`;

/**
 * A claim explicitly scoped to somewhere OTHER than the inventoried account.
 *
 * Codex #1978 r32: "There are no active cron triggers in local development."
 * is a true and useful sentence for a test or deployment guide, and this gate
 * blocks every PR in the repository — so firing on it is the expensive
 * direction of failure, not the cheap one.
 *
 * Written as a test of the SUBJECT rather than an enumeration of environments,
 * which is the same move that settled `headroom` in r26 and the entitlement
 * subject in r31: if the claim attaches a locative scope, that scope must be
 * the account for the claim to be about the account. An enumeration of the
 * places somebody might mean instead is the open-world list this file has
 * watched leak four times.
 *
 * `FUNCTION_WORD` does the work that would otherwise need a fifth enumeration:
 * "no cron triggers are live in total" attaches a preposition but no scope,
 * and must keep firing. That dependency is why this constant is defined below
 * `FUNCTION_WORD` rather than here beside its siblings.
 */

/**
 * Words that may follow a PREDICATIVE `spare` without it modifying them.
 *
 * Codex #1978 r25: the distinction across the whole corpus is what comes after
 * the word. "a spare B2 credential", "the primary and spare encryption keys" —
 * `spare` modifies a noun, and the sentence is about that noun. "is genuinely
 * spare today", "not spare right now", "never spare in this account",
 * "reserved rather than spare" — `spare` stands alone and the capacity noun
 * before it is what it describes.
 *
 * Enumerating FUNCTION words is defensible where enumerating nouns is not:
 * prepositions and this handful of adverbs are a closed class of English,
 * unlike the open-ended set of things somebody might keep a spare of. Every
 * other closed world in this file leaked because it enumerated an open class.
 */
const FUNCTION_WORD =
  String.raw`(?:in|on|at|for|to|of|by|with|from|right|now|today|tonight|here|there|yet|anymore|and|or|but|so|because|while|since|until|unless|though|although|when|that|before|after|during|per|as|than|then|already|still|total|currently|each|both|only)\b`;

/**
 * Retired in #1978 r39. The trailing-scope lookahead is gone: leading and
 * trailing scope are ONE question, and answering it in two places — a regex
 * lookahead here, a function below — is how r33 came to suppress a sentence
 * that its own mirror correctly allowed. `scopedElsewhere` now decides both,
 * over the claim's whole sentence.
 */
/**
 * The counted thing belongs to some OTHER container.
 *
 * Codex #1978 r47: "all five slots in the connection pool are occupied" and
 * "all five slots in the semaphore" both fired — ordinary implementation prose
 * blocking every PR in the repository. `triggers` and `schedules` name the
 * thing they count; `slot` is a generic English container, so it is the one
 * noun in the capacity list that carries no evidence on its own.
 *
 * Requiring cron/account qualification was tried first and failed a must-fire
 * fixture: one of the ten originals says "this account's five Workers used all
 * five slots", bare. So the test is positional instead — if the noun is
 * immediately handed a container, that container must be the account's.
 * Enumerating pools and semaphores would be the open-class mistake this file
 * has already made four times.
 */
// The determiner is NON-CONSUMING, for the reason r39 established on
// `NOT_SCOPED_ELSEWHERE` and which I reproduced here verbatim before catching
// it: consumed greedily, "in THE account" fails the account test, backtracks
// to the zero-width branch, and then passes the "some other container" test at
// `the` — so the one container that must not suppress suppressed itself.
const NOT_IN_ANOTHER_CONTAINER = String.raw`(?!${GAP}(?:in|of|on)${WRAP}(?!(?:(?:this|the|our|a|an)${WRAP})?(?:cloudflare${WRAP})?(?:account|cron|trigger|schedule|worker)s?\b)[A-Za-z])`;

const NOT_SCOPED_ELSEWHERE = '';

/**
 * ── THE TEN ORIGINALS ARE RE-VERIFIED, NOT ASSUMED ────────────────────────
 *
 * Twenty-five review rounds narrowed these patterns repeatedly — the bare
 * ratio gained a required noun, `spare` gained a predicative test, the context
 * radius stopped being sufficient on its own. Every one of those narrowings
 * was made to stop a FALSE POSITIVE, and each carried the risk of losing the
 * true positives this gate exists for.
 *
 * So the ten restated copies that produced #1977 were re-run against the
 * patterns as they now stand, read out of git history at the merge-base
 * (`e4f36f04`) rather than from memory or from the fixtures below:
 *
 *   apps/indexer/wrangler.jsonc              1     ops/offchain-data-warm/src/index.ts   2
 *   apps/keeper/wrangler.jsonc               1     ops/offchain-data-warm/README.md      2
 *   ops/offchain-data-warm/wrangler.jsonc    2     …/OffChainDataResilience.md           1
 *   apps/indexer/src/index.ts                1     docs/ops/DeploymentRunbook.md         1
 *   apps/indexer/src/cronRouting.ts          1
 *   packages/lib/src/cronCadence.ts          1
 *
 * Ten of ten. The invariant is that NO FILE DROPS TO ZERO; the finding count
 * is deliberately not stated, because it moves whenever a matcher widens —
 * it went from thirteen to fifteen in r32 when the capacity noun was
 * consolidated, and a number here would have been one more restated count in
 * the file whose subject is restated counts. The fixtures below quote several of these
 * verbatim, which is why they are worded so oddly — a fixture invented to
 * describe a rule tests the rule; a fixture lifted from the tree tests the
 * job. If a future narrowing is proposed, re-run this check before believing
 * the selftest: the fixtures cannot notice a pattern that stopped matching
 * text nobody thought to pin.
 */
const OCCUPANCY = [
  // Codex #1978 r45: the BARE EXISTENTIAL — "There are four cron triggers."
  // and "Four cron triggers exist in the account." No predicate at all, so
  // every predicate-keyed shape below misses them, and they are as direct a
  // statement of the live count as the language has.
  //
  // Round 20 rejected a bare ratio beside a capacity noun because it fired on
  // ordinary prose, and this is deliberately narrower: an EXISTENTIAL
  // construction asserts that the things are there, which a ratio inside a
  // sentence about something else does not. Measured against the whole
  // tracked tree before keeping it — zero new findings — so it closes the
  // plainest remaining phrasing at no cost in false alarms today.
  new RegExp(
    String.raw`\bthere${WRAP}(?:are|is)${WRAP}(?:${TEMPORAL}${WRAP})*${N}${WRAP}${CAP_NOUN}\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  new RegExp(
    String.raw`\b${N}${WRAP}${CAP_NOUN}${WRAP}(?:${TEMPORAL}${WRAP})*exists?\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  // "4/5 cron triggers", "3 of 5 slots". The NOUN is required and must be
  // adjacent. Codex #1978 r20: the bare ratio was validated only by cron
  // vocabulary somewhere in a 200-character window, so ordinary prose fired —
  // "The cron handler processes four of five queue partitions on this tick."
  // is a claim about partitions in a sentence that happens to say "cron".
  //
  // That is a FALSE POSITIVE on a gate that scans the whole tree and blocks
  // every PR, which is the most expensive failure this script can have: one
  // implementation note about a cron handler would have stopped all work in
  // the repository. Detached context cannot tell what a number counts; the
  // word next to it can.
  //
  // The must-fire ratio cases survive because they are caught by their own
  // shapes rather than by this one: "3 of 5 in use today" by the in-use
  // pattern, "takes the account to 5 of 5" by the account pattern, and the
  // slash form carries "cron triggers" immediately after it.
  new RegExp(
    String.raw`\b${N}${GAP}(?:of|\/)${GAP}(?:5|five)${WRAP}${CAP_NOUN}\b`,
    'i',
  ),
  // "all five slots", "used all 5 cron triggers". The noun is REQUIRED: "all
  // five concerns" (Stage3WorkerSplitPlan) and "until all five hold"
  // (IncidentRunbook) are five of something else, in windows that happen to
  // mention cron. Bare "all five" fired on both.
  new RegExp(
    // Codex #1978 r47: bare `slots` is not a capacity noun. "All five slots in
    // the connection pool are occupied" and "all five slots in the semaphore"
    // both fired, on a gate that blocks every PR — ordinary implementation
    // prose rejected for counting something else entirely. `triggers` and
    // `schedules` name the thing; `slot` is a generic English container, which
    // is the r20 lesson (the word next to the number tells you what it counts)
    // arriving at the one noun in the list that does not.
    //
    String.raw`\ball${WRAP}(?:5|five)${WRAP}${CAP_NOUN}\b${NOT_IN_ANOTHER_CONTAINER}`,
    'i',
  ),
  // "occupy 3 today", "occupies four", "the rest of the org already occupies 4"
  // Codex #1978 r26: bound by what FOLLOWS the count, the same test that
  // settled `spare` in r25 — because the real claims often have no noun at
  // all ("apps/{agent,indexer} plus this Worker occupy 3", bound by "cron
  // triggers" a line above), while the false ones name the thing they count
  // ("occupies 2 queue partitions", "occupy 3 bytes").
  //
  // My first attempt required a capacity noun AFTER the number and broke that
  // real fixture; my second added a reverse pattern that matched "schedules
  // jobs and already occupies", because `schedules` is also a verb. Neither
  // asked the question this does: is the number counting something the
  // sentence names, and is that something a trigger?
  new RegExp(
    String.raw`(?:cron|account|triggers?|slots?|schedules?)${GAP}[\s\S]{0,120}?\boccup(?:y|ies|ied)\b[^.\n]{0,40}${GAP}\b${N}\b(?![-\s]+(?!${FUNCTION_WORD}|total\b|currently\b|already\b|(?:cron|account)[-\s]|slots?\b|triggers?\b|schedules?\b)[A-Za-z])`,
    'i',
  ),
  // "4 are taken", "four were occupied", "3 in use", "4 in use today"
  // Codex #1978 r28: the FIFTH matcher in this array to need binding. "four
  // are taken by other consumers" counts leases; the subject must be trigger
  // vocabulary, or the count must be followed by it.
  // Codex #1978 r29: the DIRECT form, which the positional binding missed
  // entirely — "Four cron triggers are taken.", "4 cron schedules are in use
  // today." The count sits immediately before the capacity noun, so no window
  // and no subject search is involved. Missing these was the worse half of
  // that finding: a restatement outside the authority is what this gate is
  // for, while a false positive is a nuisance.
  new RegExp(
    // Codex #1978 r38: `running` was missing from the predicate list, which
    // is the r35 finding on the SAME list one round later — r35 added the
    // present-state adjectives and stopped at the ones already in mind. A
    // trigger that is `running` is the plainest possible way to say it.
    String.raw`\b${N}${WRAP}${CAP_NOUN}${WRAP}(?:(?:are|were|is|was)${WRAP})?(?:${TEMPORAL}${WRAP})*(?:taken|occupied|in${WRAP}use|live|active|armed|scheduled|running|enabled|configured)\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  // The postposed participle — "There are four cron triggers running." — and
  // the verbal form, "The account currently runs four cron triggers." Neither
  // puts a predicate adjective after a copula, so neither shape above reaches
  // them.
  new RegExp(
    String.raw`\bthere${WRAP}(?:are|is)${WRAP}${N}${WRAP}${CAP_NOUN}${WRAP}(?:${TEMPORAL}${WRAP})*running\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:(?:this|the|our)${WRAP}(?:cloudflare${WRAP})?(?:account|org)|we)${WRAP}(?:${TEMPORAL}${WRAP})*(?:runs?|uses?|is${WRAP}running|is${WRAP}using)${WRAP}${N}${WRAP}${CAP_NOUN}\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  new RegExp(
    String.raw`(?:account|triggers?|slots?|schedules?)[\s\S]{0,160}?\b${N}${WRAP}(?:(?:are|were|is|was)${WRAP})?(?:taken|occupied|in${WRAP}use)\b(?![-\s]+(?!${FUNCTION_WORD}|total\b|currently\b|already\b)[A-Za-z])`,
    'i',
  ),
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
  // Codex #1978 r25: `spare` must modify CAPACITY, not merely sit near cron
  // vocabulary. Bare, it fired on "The cron worker keeps a spare B2 credential
  // for disaster recovery" and "rotates between the primary and spare
  // encryption keys" — ordinary sentences in this very tree's subject matter,
  // each of which would have blocked EVERY PR in the repository.
  //
  // This is the r20 ratio finding on its sibling. I fixed the bare `N of 5`
  // by requiring an adjacent noun, wrote a reply about detached context being
  // unable to tell what a number counts, and left the other detached-context
  // matcher in the same array untouched. A spare WHAT is the same question as
  // four of five WHAT.
  new RegExp(
    String.raw`\bspare\b${WRAP}(?:(?:cron|account)[-\s]{1,10}){0,2}(?:cron-)?(?:slots?|triggers?|schedules?|capacity)\b`,
    'i',
  ),
  // …and the reverse order: "no cron trigger is spare", "the slot is spare".
  new RegExp(
    String.raw`(?:slots?|triggers?|schedules?|capacity)${GAP}[\s\S]{0,60}?spare\b(?![-\s]+(?!${FUNCTION_WORD})[A-Za-z])`,
    'i',
  ),
  // Codex #1978 r3: `packages/lib/src/cronCadence.ts` said "this account has no
  // headroom to spend on a second one" — a zero-capacity claim in a synonym the
  // patterns did not know, three lines above a sentence saying the count is
  // stated only in the authority.
  //
  // QUANTIFIED, not bare. A bare `headroom` was tried first and fired on four
  // sites, three about something else entirely: bytecode headroom under EIP-170
  // (`OfferModificationDesign.md`), wall-time headroom inside a cron envelope
  // (`apps/keeper/src/matcher.ts`), and retention headroom beside a cron
  // interval (`ops/mesh-watcher/src/env.ts`). Findings about nothing — the one
  // thing the admission criterion forbids, and the third time in this file a
  // word looked specific and was not (`slot`, `schedule`, now `headroom`).
  // Requiring an absence quantifier keeps the claim and drops the measurements.
  // Codex #1978 r31: NEGATIVE quantifiers. "No cron triggers are live.",
  // "There are no active cron triggers.", "None of the cron triggers are in
  // use." — zero is a live account state, this file says so in the fixture
  // for "zero live cron triggers", and every matcher required a NUMBER. The
  // vocabulary knew about zero as a word and not as a quantifier.
  // Codex #1978 r32, both halves: the predicate may carry a present-state
  // adverb ("are CURRENTLY live"), and the claim must not be explicitly scoped
  // somewhere other than this account ("no active cron triggers IN LOCAL
  // DEVELOPMENT" is a true sentence a test guide may write).
  new RegExp(
    String.raw`\b(?:no${WRAP}|none${WRAP}of${WRAP}(?:the${WRAP})?)(?:live${WRAP}|active${WRAP}|enabled${WRAP}|configured${WRAP}|cron${WRAP})*${CAP_NOUN}${WRAP}(?:are|is)${WRAP}(?:${TEMPORAL}${WRAP})*(?:live|active|enabled|configured|in${WRAP}use|taken|occupied)\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  new RegExp(
    String.raw`\bthere${WRAP}(?:are|is)${WRAP}(?:${TEMPORAL}${WRAP})*no${WRAP}(?:live${WRAP}|active${WRAP}|enabled${WRAP}|configured${WRAP}|cron${WRAP})*${CAP_NOUN}\b${NOT_SCOPED_ELSEWHERE}`,
    'i',
  ),
  // Codex #1978 r26: `headroom` must be ABOUT triggers. Unbound it fired on
  // "little headroom under the CPU limit" and "no headroom in its memory
  // budget" — both ordinary notes about a cron Worker's runtime, neither a
  // claim about the account's trigger budget.
  // The SUBJECT must be the thing that has a trigger budget — the account, or
  // the triggers themselves. Not merely cron-adjacent: "The cron invocation
  // has little headroom under the CPU limit" and "The cron job has no
  // headroom in its memory budget" are about an invocation and a job, and my
  // first backward pattern matched both because `cron` appeared somewhere
  // earlier. `cron` is an adjective in all three sentences; what differs is
  // the noun it modifies.
  new RegExp(
    String.raw`\b(?:account|triggers?|slots?|schedules?)${WRAP}[\s\S]{0,30}?(?:no|zero|little|any)${WRAP}[\s\S]{0,30}?(?:headroom|capacity${WRAP}(?:left|remaining|free))\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:no|zero|little|any)${WRAP}(?:cron|trigger|slot|schedule|account)[-\s]*${WRAP}?[\s\S]{0,30}?(?:headroom|capacity${WRAP}(?:left|remaining|free))\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:no|zero|little|any)${WRAP}(?:headroom|capacity${WRAP}(?:left|remaining|free))${WRAP}(?:for|on)${WRAP}[\s\S]{0,40}?(?:cron|triggers?|slots?|schedules?)\b`,
    'i',
  ),
  // Codex #1978 r4 removed two restated VERDICTS — "**This step currently
  // fails**" and "**As things stand this step FAILS**" — but nothing pins the
  // shape, so a third file can reintroduce it. Every pattern above keys on a
  // COUNT, and a verdict restates the same live fact with no number in it.
  //
  // Keyed on the PRESENT-TENSE MARKER, not on the verb. What makes a verdict a
  // restatement is that it asserts the state NOW; "If this step fails, that is
  // the likeliest reason" is the same words about a hypothetical and is the
  // correct way to write it — it is in `apps/keeper/wrangler.jsonc` today. A
  // bare `(this|the) step ... fails` fires on that, which would be the fourth
  // time in this file a pattern proved a word present without reading what the
  // sentence does with it (`slot`, `schedule`, `headroom`, and the `spare`
  // lookbehind that cost round 2). The marker is the claim.
  new RegExp(
    String.raw`\b(?:this|the)${WRAP}step${WRAP}(?:currently|today|now|at${WRAP}present)${WRAP}(?:fails?|succeeds?|passes)\b`,
    'i',
  ),
  new RegExp(
    String.raw`\bas${WRAP}(?:things|it)${WRAP}stands?${WRAP}(?:this|the)${WRAP}step${WRAP}(?:fails?|succeeds?|passes)\b`,
    'i',
  ),
  // Codex #1978 r5: the most natural way to say it was the one shape missing.
  // "The account currently has four live cron triggers" carries the count and
  // the context and matched nothing — every pattern above grew from a phrasing
  // found in the wild, and none of the ten copies happened to be written this
  // way. A gate built only from the phrasings that already existed cannot see
  // the one the next author reaches for.
  //
  // The QUALIFIER is what keeps this off the cap. "caps an account at 5 cron
  // triggers" is the sentence the remediation needs; "5 LIVE cron triggers" is
  // account state. A bare `N (cron )?triggers` would have banned the cap and
  // fought its own fix — the trap the admission criterion names at the top.
  new RegExp(
    String.raw`\b${N}${WRAP}(?:live|active|armed|scheduled|enabled|configured|in-use)${WRAP}(?:cron${WRAP})?triggers?\b`,
    'i',
  ),
  // The SUBJECT is required here for the same reason it is on the verdicts
  // (r6). Codex #1978 r8: a bare `has|have|holds N triggers` fired on the CAP
  // stated as an entitlement — "Free accounts may have five cron triggers",
  // "Cloudflare allows an account to have 5 cron triggers" — which is the rule
  // failing its own remediation, the one thing the criterion at the top
  // forbids. Naming the subject excludes the modal forms without a lookbehind:
  // "accounts MAY have" and "an account TO have" do not put the verb next to
  // the subject, and a claim about this account's current state does.
  new RegExp(
    // Codex #1978 r31: "Free accounts have five cron triggers." and "Each
  // account has five cron triggers." are statements of the CAP — which this
  // gate's own documentation says are permitted, and which the authority
  // itself must make. A plural or plan-qualified subject is generic; a
  // specific one ("this account has 5 cron triggers today") is a live claim.
  // The gate was contradicting its own stated allowance.
  // Codex #1978 r32: the r31 lookbehind only saw the word immediately before
  // `account`, so "Each **Cloudflare** account has five cron triggers" slipped
  // past it — one modifier was enough to hide the determiner that makes the
  // sentence generic. Rejecting a list of generic determiners is the wrong
  // shape for the same reason every other closed world in this file was: it
  // enumerates the ways somebody might write the thing to EXCLUDE.
  //
  // So require the SPECIFIC subject instead. A live claim is about `this`,
  // `the` or `our` account; every generic determiner — named, unnamed, or
  // separated from the noun by any number of modifiers — simply fails to be
  // one of those three, with nothing to enumerate and nothing to keep current.
  String.raw`\b(?:(?:this|the|our)${WRAP}(?:cloudflare${WRAP})?(?:account|org)|we)${WRAP}(?:${TEMPORAL}${WRAP}|already${WRAP})*(?:has|have|holds?)${WRAP}${N}${WRAP}(?:live${WRAP}|active${WRAP})*${CAP_NOUN}\b`,
    'i',
  ),
  // Capacity VERDICTS — the same claim as `spare` and `headroom` with the
  // number removed entirely: "the cron budget is full", "at capacity", "room
  // for one more". Self-found after round 5, whose accepted finding was that
  // building only from phrasings already in the tree leaves the gate blind to
  // the one the next author reaches for. These are that finding applied
  // forward rather than waiting to be told again.
  //
  // Each is tight enough to have ZERO hits in the tree today, checked before
  // adding. `exhausted` bare was tried and dropped: it appears 92 times in
  // scope — VPFI reward budgets, retry budgets, feed cursors — and one of
  // them, `chainIngestDO.ts`'s "Both budgets exhausted — defer the rest to the
  // cron backstop", sits within the context window of the word `cron` while
  // being about DO writes. The noun is what makes it admissible.
  new RegExp(String.raw`\b(?:cron|trigger)s?${WRAP}budget${WRAP}is${WRAP}(?:full|exhausted|spent)\b`, 'i'),
  // Codex #1978 r6: every verdict must name the cron budget as its OWN
  // subject. The first cut of these leaned entirely on the ±200-character
  // CONTEXT window, which any nearby `cron` satisfies — so "when the ingestion
  // queue is at capacity, the cron trigger retries", "room for one more B2
  // write" and "can still take another row before the cron tick ends" all
  // fired, three findings about nothing in patterns I had added while claiming
  // to apply the criterion forward. Context can say the paragraph is about
  // cron; only the phrase can say the CLAIM is.
  new RegExp(
    String.raw`\b(?:cron|trigger)s?${WRAP}(?:budget${WRAP})?(?:is|are)?${WRAP}?at${WRAP}capacity\b`,
    'i',
  ),
  /\bat\s+capacity\s+for\s+(?:cron\s+)?(?:triggers?|schedules?)\b/i,
  /\bno\s+room\s+for\s+(?:a|an|another|one\s+more)?\s*(?:new\s+)?(?:(?:cron|scheduled)\s+workers?|(?:cron\s+|scheduled\s+)?(?:trigger|schedule)s?)\b/i,
  /\broom\s+for\s+(?:one\s+more|another)\s+(?:(?:cron|scheduled)\s+workers?|(?:cron\s+|scheduled\s+)?(?:trigger|schedule)s?)\b/i,
  /\bcan\s+(?:still\s+)?(?:take|fit|hold)\s+(?:one\s+more|another)\s+(?:(?:cron|scheduled)\s+workers?|(?:cron\s+|scheduled\s+)?(?:trigger|schedule)s?)\b/i,
];

/**
 * ── WHAT THIS RULE SHAPE CANNOT REACH ─────────────────────────────────────
 *
 * Named after r5, whose accepted finding was that patterns reverse-engineered
 * from phrasings already in the tree are blind to the one the next author
 * reaches for. Working forward from that, the numeric shapes and the capacity
 * verdicts above are covered. Two families are NOT, and are recorded here
 * rather than half-covered:
 *
 *   - ENUMERATION. "agent, indexer and this Worker are the ones actually
 *     running" states the live set with no count and no verdict. This is not
 *     hypothetical: `OffChainDataResilience.md` carried exactly that sentence
 *     and it was removed BY HAND in this PR, not by any rule. Catching it
 *     needs "a list of Worker names, asserted as the live set", which a regex
 *     cannot distinguish from a list of Worker names appearing in a reason —
 *     and reasons are what this gate asks authors to write instead. A rule
 *     here would fire on its own remediation.
 *
 *   - OPEN PARAPHRASE. The verdicts above are the phrasings worth pre-empting;
 *     English affords unboundedly many more. Chasing them one at a time is how
 *     a closed-world rule turns into an open-world one, which by the criterion
 *     at the top of this file may not ship.
 *
 * Both are DIAGNOSIS gaps rather than holes in the invariant: the summary is
 * still pinned to the inventory and the inventory to the account, so a
 * restatement of either kind is wrong prose beside a checked source, not an
 * unchecked source. Recorded so the next reader knows the boundary was chosen
 * rather than missed.
 */

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
  // COST, measured 2026-08-27 so nobody narrows the scope back for speed:
  // ~4 s wall for the whole offline gate over 5,272 tracked files / 127 MB.
  // Of that, `git ls-files --eol` is ~1.1 s (it inspects every blob), reading
  // the files ~0.6 s, and the rest is the claim scan itself. That is a
  // rounding error inside a workflow that also runs a build, and the previous
  // five-root version's saving bought a gate blind to `.github/` — which is
  // where its own handbook lives. If this ever does need to be faster, cache
  // the eol classification; do not shrink what is scanned.
  //
  // r3's scope-root liveness check is GONE with the roots it guarded. It
  // existed because `git ls-files` on a vanished directory exits 0 and returns
  // nothing, silently shrinking coverage; with no positive roots there is
  // nothing to go stale, and a moved source tree is now scanned wherever it
  // lands rather than needing a constant updated to follow it. The exclusions
  // are checked instead — an exclusion that stops matching is the one that can
  // now drift, and it drifts SAFELY (toward scanning more).
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const binary = binaryTrackedPaths();
  return out
    .split('\0')
    .filter(
      (p) =>
        p &&
        !SKIP_EXACT.has(p) &&
        (!SKIP_PREFIXES.some((pre) => p.startsWith(pre)) ||
          SKIP_CARVEOUTS.some((pre) => p.startsWith(pre))) &&
        isScannableText(p, binary),
    );
}

/**
 * The inventory must be framed as an actual Markdown table.
 *
 * Codex #1978 r22: the header and delimiter checks only ran WHEN one was
 * encountered, so deleting both left every data row parsed and nothing
 * reported — a document Markdown renders as a run of pipe-separated text with
 * no table in it, passing both modes. **Validating a thing when present is not
 * the same as requiring it**, and I added those two checks in the two previous
 * rounds without noticing that neither was mandatory.
 *
 * Document level, not inside {parseInventory}, for the reason the
 * empty-inventory check is: the row fixtures run that against table FRAGMENTS,
 * where having no header is correct. Second time this exact altitude mistake
 * has cost a dozen fixtures, so it is worth saying plainly — a property of the
 * whole document does not belong in the function that parses a piece of it.
 */
function checkInventoryFraming(inv) {
  if (inv.sources.size === 0) return []; // empty inventory is reported elsewhere
  const problems = [];
  const { sawHeader, sawDelimiter } = inv.framing;
  if (sawHeader !== 1) {
    problems.push(
      `the inventory has ${sawHeader} header row(s); it needs exactly one, or ` +
        `Markdown renders no table and the rows below are text a reader cannot ` +
        `read as an inventory`,
    );
  }
  if (sawDelimiter !== 1) {
    problems.push(
      `the inventory has ${sawDelimiter} alignment row(s); it needs exactly one ` +
        `directly under the header, or Markdown renders no table at all`,
    );
  }
  // Codex #1978 r23: ADJACENCY, which the message above already promised and
  // the check did not enforce. Counting one of each accepts a delimiter moved
  // below the first data row, where GFM renders no table — and my own error
  // text said "directly under the header" while nothing verified it. A check
  // whose message describes a stronger rule than it applies is worse than a
  // silent one: it tells the next reader the case is covered.
  const { headerAt, delimiterAt, firstDataAt, lastDataAt, rowCount } = inv.framing;
  // Codex #1978 r25: CONTIGUITY, not just header-to-delimiter adjacency. GFM
  // ends a table at the first blank line, so a blank line or prose after the
  // delimiter leaves the rendered inventory as a header alone with its rows
  // below it as ordinary text — while this parser reads rows anywhere in the
  // section. I fixed adjacency one round ago and checked only the pair I had
  // been shown; a table is a contiguous block, and two of its three joins
  // were unverified.
  if (firstDataAt !== -1 && delimiterAt !== -1 && firstDataAt !== delimiterAt + 1) {
    problems.push(
      `the inventory's first row does not immediately follow the alignment row; ` +
        `Markdown ends the table at the first blank line, so the rows below it ` +
        `render as ordinary text`,
    );
  }
  if (firstDataAt !== -1 && lastDataAt - firstDataAt + 1 !== rowCount) {
    problems.push(
      `the inventory's rows are not contiguous — something sits between them, ` +
        `which ends the table there and leaves the remaining rows as text`,
    );
  }
  if (sawHeader === 1 && sawDelimiter === 1 && delimiterAt !== headerAt + 1) {
    problems.push(
      `the inventory's alignment row is not directly under its header; Markdown ` +
        `renders no table unless they are adjacent, so the rows below are text a ` +
        `reader cannot read as an inventory`,
    );
  }
  return problems;
}

/**
 * The authority must actually CONTAIN an inventory.
 *
 * Codex #1978 r17: wrapping the table in `<!-- ... -->` left every check
 * reporting success over a document whose whole subject had rendered away,
 * with `--live` then comparing the account against nothing at all. The file's
 * own text says "the table above is the whole inventory", so zero rows
 * contradicts the document before it contradicts the account.
 *
 * This lives at DOCUMENT level rather than inside {parseInventory} on purpose:
 * that function is also run against table FRAGMENTS by the row fixtures, where
 * "no rows" is the normal and correct outcome. Putting it there made ten
 * row-parsing fixtures fail for a property none of them was written to test —
 * the check was right and its altitude was wrong.
 */
function checkInventoryPresent(inv) {
  // Codex #1978 r21: "no rows" must mean NO ROWS, not "no rows that hold or
  // reserve a trigger". An account legitimately at zero live and zero reserved,
  // with the table still listing undeployed Workers, is a valid state — and the
  // gate blocked it. `sources` carries every parsed row whatever its status, so
  // it is the collection that answers the question actually being asked.
  //
  // I wrote this check to catch a table hidden inside an HTML comment and
  // tested it by hiding the table; both occupancy collections empty was the
  // symptom I had in front of me, and I encoded the symptom rather than the
  // condition. That reads fine until the symptom has another cause.
  if (inv.sources.size === 0) {
    return [
      'the inventory table has no readable rows — every row is missing, ' +
        'malformed, or hidden inside an HTML comment or code fence; the ' +
        'authority cannot state a count it does not contain',
    ];
  }
  return [];
}

/**
 * Every SKIP_EXACT entry must still name a tracked file.
 *
 * Not symmetry for its own sake: an exclusion whose path has been renamed
 * stops excluding, which is safe, but it ALSO stops telling the truth about
 * why the file is unscanned — and the file it now fails to exclude will start
 * failing the gate for reasons nobody can trace back to here. Failing loudly
 * on a stale exclusion keeps the reason attached to the decision.
 */
function checkSkipList() {
  const problems = [];
  for (const path of SKIP_EXACT) {
    const out = execFileSync('git', ['ls-files', '-z', '--', `:(literal)${path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (out.split('\0').filter(Boolean).length === 0) {
      problems.push(
        `the scan excludes \`${path}\`, which matches no tracked file; if it ` +
          `moved, update SKIP_EXACT — a stale exclusion silently stops ` +
          `explaining why something is unscanned`,
      );
    }
  }
  return problems;
}

/**
 * The authority's `Verified:` stamp — exactly one, well-formed.
 *
 * Codex #1978 r3: nothing read it. Deleting or duplicating the line left both
 * halves reporting success, removing the only signal of how stale a manually
 * maintained account snapshot is — and `--live` would then print "refresh the
 * stamp" pointing at a line that no longer existed. The stamp is the file's
 * whole claim to being current, and an unchecked claim of currency is worse
 * than none, because it reads as reassurance.
 */
/**
 * Is there a stamp that is the document's OWN, rather than one hidden or shown
 * as an example? A line beginning `**Verified:` and outside every code fence.
 *
 * Fences are excluded deliberately, and it took catching myself to get right: a
 * first pass pinned a fenced stamp as ACCEPTABLE, which would have let a
 * document lose its real stamp and keep a format example — a fixture asserting
 * a limitation as correct, the exact trap recorded above MUST_NOT_FIRE.
 */
/**
 * The lines of a Markdown document a READER actually sees: outside fenced code
 * blocks and outside HTML comments.
 *
 * Both hiding mechanisms were found the same way, one round apart. Codex
 * #1978 r12/r14/r15 walked the fence rules (kind, then run length, then the
 * info string); r17 pointed out that none of it touched HTML comments, so
 * `<!--\n**Verified: …**\n-->` was accepted as the document's stamp while
 * rendering as nothing at all. The single-line form `<!-- ... -->` had been
 * handled since r11 — which is exactly the "fixed one member of a family"
 * shape, since the multiline form is the one an editor reaches for when
 * commenting out a BLOCK.
 *
 * Yielding lines rather than answering one question is deliberate: the stamp
 * check and the inventory-table parser were each asking "is this visible?"
 * separately, and only one of them had ever been told about fences.
 */
/** Markdown indentation width: a tab advances to the next multiple of four. */
function indentWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

function* visibleLines(md) {
  // FENCES ONLY. HTML-comment tracking used to live here and is gone —
  // `checkNoHtmlComments` forbids `<!--` in the authority outright instead.
  //
  // Codex #1978 r17-r19 found five defects in that tracking, and TWO OF THEM
  // were false positives I shipped: a `<!--` inside a fenced example swallowed
  // the rest of the document, and an indented code block containing one did
  // the same. On a gate that blocks CI, a false positive is the expensive
  // failure — it stops every correct edit, where a false negative lets one bad
  // edit through. The parser was generating worse bugs than the ones it
  // caught, and each fix enlarged the surface the next round reviewed.
  //
  // Forbidding the construct is decidable in one line and costs nothing: the
  // authority contains no HTML comments, and there is no reason for a file
  // whose entire job is to state one number plainly to hide any of itself.
  // Parsing a language is a bad way to answer a question you can just rule
  // out. (See the escalation on #1978: two thirds of that PR's findings were
  // on this file, and the recent ones were CommonMark edge cases.)
  let openedWith = null; // { kind, len } while inside a fence
  for (const line of md.split('\n')) {
    // At most three leading spaces: four or more is an indented code block,
    // not a fence, in BOTH directions.
    // Codex #1978 r25: FOUR-SPACE INDENTED CODE is not prose either. An
    // indented example of the stamp beside the real one made the gate report
    // two stamps and reject a correct authority — the same false positive the
    // fenced case already avoided, in the other way Markdown marks code.
    //
    // This is inside the surface I said I would defer, and I am fixing it
    // anyway because the deferral was about unbounded hardening against
    // deliberate EVASION, not about tolerating CI breakage on a natural edit.
    // It is also one bounded rule I had already written for fences.
    // Codex #1978 r28: TABS indent code as well. A tab counts to the next
    // multiple of four, so one tab is already an indented code block — and a
    // tab-indented format example beside the real stamp read as a duplicate
    // and BLOCKED the gate. I implemented "four spaces" from the rule's most
    // common spelling rather than from the rule.
    // Codex #1978 r29: measure the indentation WIDTH, expanding tabs to the
    // next multiple of four, instead of matching its spelling. CommonMark
    // allows one to three spaces THEN a tab, which `/^(?: {4,}|\t)/` reads as
    // prose. Fourth iteration on this one rule — four spaces, then a leading
    // tab, now mixed — because each time I matched the form of the example in
    // front of me rather than computing the quantity the rule is about.
    // Codex #1978 r48: a fence inside a BLOCKQUOTE. `> ```md` is how this
    // repository's docs show a format example, and the opener was not
    // recognised through the `>` marker — so `visibleLines` yielded the whole
    // example as prose and `checkStamp` rejected a correct authority for
    // containing a second stamp. A false positive on the authority itself.
    //
    // This was DEFERRED to #1990 at round 30 as one of four CommonMark
    // questions. The deferral is withdrawn for this member, on the same
    // grounds as the escape-parity item in r40: it has a demonstrated
    // CI-blocking consequence, and stripping a leading quote marker is one
    // decidable line, not a specification. The other two stay deferred.
    const bare = line.replace(/^ {0,3}(?:>\s?)+/, '');
    if (openedWith === null && bare.trim() !== '' && indentWidth(bare) >= 4) continue;

    const fence = /^ {0,3}(```+|~~~+)(.*)$/.exec(bare);
    if (fence) {
      const run = fence[1];
      const kind = run[0];
      const info = fence[2];
      if (openedWith === null) {
        // Codex #1978 r19: a BACKTICK fence's info string may not contain a
        // backtick — CommonMark does not treat ``` bad`info as an opener, so
        // opening one here hid the real inventory that followed and failed a
        // valid document. Tilde fences have no such rule.
        if (kind === '`' && info.includes('`')) continue;
        openedWith = { kind, len: run.length };
      } else if (
        openedWith.kind === kind &&
        run.length >= openedWith.len &&
        info.trim() === ''
      ) {
        openedWith = null;
      }
      continue;
    }
    if (openedWith === null) yield line;
  }
}

/**
 * The authority may not contain HTML comments.
 *
 * A blunt rule replacing a parser, and deliberately so — see {visibleLines}.
 * The constraint is invisible in practice (the file has never had one) and it
 * removes an entire class of "the checker and the reader disagree about what
 * this document says", which is the class this gate exists to close.
 */
function checkNoHtmlComments(md) {
  if (!md.includes('<!--')) return [];
  return [
    'the authority contains an HTML comment; this file may not hide any of ' +
      'itself from a reader, because every check here asks what the RENDERED ' +
      'document claims. Delete the comment, or move the note into ordinary ' +
      'prose where it is part of the document rather than concealed in it',
  ];
}

function hasVisibleStamp(md) {
  for (const line of visibleLines(md)) {
    if (/^\*\*Verified:/.test(line)) return true;
  }
  return false;
}

export function checkStamp(md) {
  // Codex #1978 r4: count every MARKER, not every well-formed stamp. Counting
  // only the ones that parsed meant a document holding one valid stamp and one
  // `**Verified: yesterday.**` reported success over two conflicting claims of
  // currency — the malformed one was invisible precisely because it was
  // malformed. The count and the validation are separate questions and the
  // count has to come first.
  // Codex #1978 r10: count markers behind ordinary Markdown prefixes too —
  // list bullets, blockquotes, indentation. A copied stamp pasted as
  // `- **Verified: yesterday.**` was invisible to the DUPLICATE check while
  // being perfectly visible to a reader, which is the stamp's whole audience.
  // The r4 fix counted markers rather than well-formed stamps for exactly this
  // reason and then anchored the count at column zero, so a second stamp could
  // still hide by being indented.
  // Counted ANYWHERE, not behind an enumerated prefix class. Third revision of
  // one count and the first that is not a closed world: r4 counted well-formed
  // stamps (a malformed one hid by being malformed), r10 counted markers
  // anchored at column zero (one hid by being indented), r11 found an
  // ordered-list prefix the class `[ \t>*+-]` does not include. Each fix
  // enumerated the prefixes somebody might use, and Markdown affords more than
  // an enumeration can hold. The LABEL is the marker; where it sits on the line
  // is not this gate's business, and a reader sees it rendered either way.
  // Codex #1978 r14: the marker is the LABEL, terminated or not. Requiring the
  // closing `**` meant `**Verified: yesterday` — reader-visible, and plainly a
  // second claim — was counted as nothing at all. Three rounds have now found
  // the same thing: whatever makes a stamp malformed must not also make it
  // invisible to the count.
  // Codex #1978 r19: count over the VISIBLE document, as checkSummary does.
  // Counting raw text meant a fenced EXAMPLE of the stamp — the natural way to
  // document the format — read as a second stamp and blocked CI on a correct
  // authority. Third false-positive of the same kind, and the same cause each
  // time: two questions ("what does the reader see" / "what does the file
  // contain") answered with whichever text was nearest to hand.
  const visibleMd = [...visibleLines(md)].join('\n');
  const markers = [...visibleMd.matchAll(/\*\*Verified:/g)];
  if (markers.length === 0) {
    return [
      'the "**Verified: <ISO-8601>.**" stamp is missing; it is the only ' +
        'statement of how old this snapshot is',
    ];
  }
  if (markers.length > 1) {
    return [
      `the "Verified:" stamp appears ${markers.length} times; there must be ` +
        `exactly one, or the two can disagree`,
    ];
  }

  // Codex #1978 r12: counting broadly is right for DUPLICATES and wrong for
  // EXISTENCE. Dropping the anchor in r11 (so a prefixed copy could not hide)
  // also accepted a stamp that no reader can see — `<!-- **Verified: …** -->`
  // satisfied the count while the rendered authority carried no timestamp at
  // all. Broad count, canonical validation: the same two-step `checkSummary`
  // uses, and the third place in this file where one question was answered
  // with the other's test.
  if (!hasVisibleStamp(md)) {
    return [
      'the "Verified:" stamp exists only in a form that is not the document\'s ' +
        'own stamp — an HTML comment, or a fenced example. It must appear as a ' +
        'visible line of prose',
    ];
  }

  const canonical = /^\*\*Verified:\s*([^*]*?)\.?\*\*/m.exec(visibleMd);
  if (!canonical) {
    return [
      'the "Verified:" stamp is present but its markup is unterminated; it must ' +
        'read `**Verified: <ISO-8601>.**`',
    ];
  }
  const raw = canonical[1].trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) {
    return [`the "Verified:" stamp reads "${raw}", which is not an ISO-8601 instant`];
  }
  // Shape is not existence. `2026-99-99T99:99:99Z` matches the shape and is not
  // a moment in time; round-tripping through Date is what rejects it.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(/\.\d{3}Z$/, 'Z') !== raw) {
    return [`the "Verified:" stamp reads "${raw}", which is not a real instant`];
  }
  // Codex #1978 r15: a real instant in the FUTURE. `2099-…` is a plausible
  // typo — one digit — and it defeats the only thing this stamp is for. The
  // authority says the count is trustworthy only as of the moment `--live`
  // ran, and a reader judges that by subtracting the stamp from now; a future
  // stamp makes an arbitrarily stale inventory read as freshly verified, and
  // keeps reading that way indefinitely rather than degrading. Every other
  // check here asks "is this well-formed"; this is the one that asks whether
  // the claim is possible.
  //
  // The tolerance is for clock skew between an operator's machine and CI, not
  // for a stamp written ahead of time.
  const SKEW_MS = 5 * 60 * 1000;
  if (parsed.getTime() > Date.now() + SKEW_MS) {
    return [
      `the "Verified:" stamp reads "${raw}", which is in the future; it records ` +
        `when the account was last READ, so it cannot postdate now (allowing ` +
        `5 minutes of clock skew)`,
    ];
  }
  return [];
}

/**
 * Findings for one file's text. Exported shape so the fixtures below drive
 * the same code path CI does, rather than a paraphrase of it.
 */
/**
 * Is the claim scoped to an execution environment that is NOT the inventoried
 * Cloudflare account?
 *
 * ── WHY THIS IS AN ENUMERATION, WHEN NOTHING ELSE HERE IS ─────────────────
 *
 * Three previous rounds tried to answer this grammatically — a scope
 * preposition and the noun it governs — and it oscillated every single round.
 * r33 added the leading form and suppressed "For now, no cron triggers are
 * live". r35 fixed that and left "running locally" firing. r38's `running`
 * predicate made that worse. r39 found BOTH directions at once: purpose
 * phrases ("For capacity planning, ...", "For clarity, ...") silently
 * suppressed, and "Four cron triggers are running locally." falsely firing.
 *
 * The oscillation is the evidence. "Is this phrase an alternate execution
 * environment?" is not answerable from grammar, because `for local
 * development` and `for capacity planning` are the same construction. Only
 * the vocabulary distinguishes them.
 *
 * This file has refused enumerations four times, and was right each time —
 * but every one of those was an enumeration of what makes the gate FIRE,
 * where a gap is a silent miss. This one decides what makes the gate STAY
 * QUIET, so a gap makes the gate fire on a sentence it should have spared.
 * That failure is visible, lands on the author, and is fixed by rewording or
 * by one reviewable skip-list line. Inverting the failure direction is what
 * makes the enumeration admissible here and not elsewhere.
 *
 * Scoped to the claim's own sentence, so a mention of `staging` a paragraph
 * away governs nothing. The residual miss — a real account claim that names
 * an environment in the same sentence for an unrelated reason — is accepted
 * and stated rather than papered over.
 */
const ENVIRONMENT = new RegExp(
  String.raw`\b(?:local|locally|localhost|dev|development|staging|preview|sandbox|emulator|miniflare|fixture|fixtures|test|tests|testing|ci)\b`,
  'i',
);

/**
 * A generic PLAN ENTITLEMENT rather than this account's current state.
 *
 * Codex #1978 r46: the r45 existential fired on "There are five cron triggers
 * per account." and "There are 250 cron triggers on Paid accounts." Those are
 * statements of the CAP, which this gate explicitly permits and its own
 * remediation requires — so firing on them is the gate refusing the sentence
 * it tells authors to write, for the third time on this PR (r8 the modal
 * forms, r31 the declarative, now the existential).
 *
 * The subject test that settled it for `has|have` does not reach here: an
 * existential has no subject to qualify. What marks these is the plan
 * qualifier attached to the noun, so that is what is matched — and, as with
 * the environment vocabulary, an enumeration is admissible because it governs
 * SUPPRESSION: a gap makes the gate fire on a cap statement, which is visible
 * and fixable, rather than silently letting occupancy through.
 */
const PLAN_ENTITLEMENT =
  /\bper\s+(?:cloudflare\s+)?account\b|\b(?:free|paid|each|every|any)\s+(?:cloudflare\s+)?accounts?\b|\baccount\s+plan\b|\bplan\s+limits?\b/i;

function scopedElsewhere(text, at, len) {
  // Codex #1978 r49: the BACKWARD scan knew `.` `;` and newline while the
  // forward scan knew `!` and `?` too — so "Local development uses no
  // schedules! There are four cron triggers." put `local` inside the claim's
  // sentence and suppressed it. One function, two scans, two different ideas
  // of where a sentence ends, and I wrote the second one three rounds after
  // the first without comparing them.
  const before = Math.max(
    ...['.', ';', '!', '?', '\n'].map((ch) => text.lastIndexOf(ch, at - 1)),
  );
  const rest = text.slice(at + len);
  const stop = rest.search(/[.;!?\n]/);
  const sentence = text.slice(before + 1, at + len + (stop === -1 ? rest.length : stop));
  // The environment test is SENTENCE-wide; the plan test is not, and the
  // difference was found by the fixtures. Two of the ten originals state the
  // cap and the occupancy in ONE sentence — "caps cron triggers at 5 per
  // ACCOUNT; all five were taken when this was written" — so a sentence-wide
  // entitlement test silently exempted two of the passages this gate was
  // built from. The qualifier has to attach to THIS claim's noun, which means
  // the window immediately after the match, not the sentence around it.
  // Codex #1978 r47: a fixed 40-character window crosses punctuation, so
  // "There are four cron triggers. Every account has a dashboard." was
  // suppressed by the NEXT sentence's generic vocabulary. A qualifier cannot
  // attach across a clause boundary; the window now stops at one.
  const rawTrailing = text.slice(at + len, at + len + 40);
  // Codex #1978 r48: commas and dashes bound a clause too. "There are four
  // cron triggers, while every account has a dashboard." was suppressed by
  // the SECOND clause's generic vocabulary. Third boundary correction on this
  // one window (r46 sentence-wide, r47 terminal punctuation, now all clause
  // delimiters) — each time I fixed the delimiters I had just been shown.
  // Codex #1978 r49: an en/em dash needs no surrounding spaces — "four cron
  // triggers—every account has a dashboard" is the conventional typography,
  // and requiring spaces was me matching the one spelling I had written in
  // the r48 fixture. FOURTH correction to this window.
  const cut = rawTrailing.search(/[.;:!?,\u2013\u2014\n]|\s-\s/);
  const trailing = cut === -1 ? rawTrailing : rawTrailing.slice(0, cut);
  return ENVIRONMENT.test(sentence) || PLAN_ENTITLEMENT.test(trailing);
}

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
      if (scopedElsewhere(text, at, m[0].length)) continue;
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
  // Populates `oversized` as a side effect; read it after (Codex #1978 r36).
  const inv = parseInventory(authorityMd);
  const summaryProblems = [
    ...checkNoHtmlComments(authorityMd),
    ...checkStamp(authorityMd),
    ...checkSkipList(),
    ...checkInventoryPresent(inv),
    ...checkInventoryFraming(inv),
    ...inv.problems,
    ...checkSources(inv.sources),
    ...checkSummary(authorityMd, countTriggers(inv.live), inv.reserved, [
      ...inv.sources.keys(),
    ]),
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
    if (oversized.length) {
      console.error(
        `Cron-slot gate: ${oversized.length} tracked text file(s) exceed the ` +
          `${MAX_SCAN_BYTES}-byte scan cap and were NOT read:`,
      );
      for (const p of oversized) console.error(`  ${p}`);
      console.error('');
      console.error('That is a hole with a size threshold on it: a document');
      console.error('grown past the cap can restate the count while this gate');
      console.error('reports OK. Split the file, or raise the cap deliberately.');
      return 1;
    }
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
  return body;
}

/** One page, unwrapped — the shape every non-list caller wants. */
async function cfOne(path, token) {
  return (await cf(path, token)).result;
}

/**
 * A list endpoint, complete.
 *
 * Codex #1978 r15 reported that `--live` read `?per_page=100` and stopped
 * while the authority promises it lists EVERY Worker — so past a hundred
 * scripts an armed Worker would be absent and the command would still print
 * "matches the account", the all-clear on the exact condition #1977 is.
 *
 * The concern is right. The pagination fix I wrote for it was WRONG, which I
 * found by asking the API instead of reasoning about it (2026-08-27):
 *
 *     GET /workers/scripts?per_page=5&page=1  -> 11 results
 *     GET /workers/scripts?per_page=5&page=2  -> the SAME 11 results
 *     GET /workers/scripts                    -> 11 results, no result_info
 *
 * The endpoint IGNORES both parameters and returns the whole list, and sends
 * no `result_info` because there is nothing to page through. A page loop
 * against it is worse than the single call it replaced: past 100 scripts each
 * "next page" returns the identical full list, so the accumulator fills with
 * duplicates until the runaway guard throws — a hundred pointless requests to
 * reach a wrong answer.
 *
 * So: one request, because one request is already complete. The `result_info`
 * branch stays as a hinge rather than dead code — if Cloudflare ever does
 * paginate this, it will say so there, and this reads every page on the day
 * that changes instead of silently truncating.
 *
 * Recording the MEASUREMENT rather than the conclusion is the point. "This
 * endpoint is not paginated" is a claim about a live service, which is the
 * category this whole PR exists because nobody re-checks.
 */
async function cfList(path, token, perPage = 100) {
  const joiner = path.includes('?') ? '&' : '?';
  const all = [];
  for (let page = 1; ; page += 1) {
    const body = await cf(`${path}${joiner}per_page=${perPage}&page=${page}`, token);
    const batch = body.result ?? [];
    all.push(...batch);
    const total = body.result_info?.total_count;
    // NO result_info: the endpoint does not paginate, and this response is
    // already the whole list. Returning here is what makes the >100 case
    // correct rather than a duplicate-accumulating spin.
    if (!Number.isFinite(total)) return all;
    if (all.length >= total || batch.length === 0) return all;
    if (page > 100) throw new Error(`${path}: pagination did not terminate`);
  }
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
export function checkSummary(rawMd, liveTriggers, reservedNames, allNames = reservedNames) {
  // Codex #1978 r18: the THIRD member of the visibility family. The table
  // learned about `visibleLines` in r17 and the stamp in r17; the summary,
  // sitting between them and read by both modes, kept matching against the
  // raw document — so all three canonical lines wrapped in `<!-- -->` left
  // this returning no problems over an authority that renders no totals at
  // all. Fixed one sibling, then the second, and walked past the third.
  const md = [...visibleLines(rawMd)].join('\n');
  // Exactly one of each line. Not the first match — this whole change exists
  // because a second, unchecked copy of a count went unnoticed, and `exec`
  // reading only the first would reproduce that defect inside the check meant
  // to prevent it: a duplicated summary section could contradict itself and
  // still pass.
  // Codex #1978 r11: COUNT the label, then VALIDATE the canonical line — the
  // two-step `checkStamp` already used, for the same reason. Collecting only
  // CANONICAL matches meant a malformed second copy ("- **Live right now:**
  // three of five") was invisible to the duplicate check precisely because it
  // was malformed, leaving two contradictory summaries in a document that
  // claims to hold exactly one. The marker is the label; canonical form is a
  // separate question, asked of the single survivor.
  const read = (label, markerRe, canonicalRe) => {
    const markers = [...md.matchAll(new RegExp(markerRe.source, markerRe.flags + 'g'))];
    if (markers.length === 0) {
      return {
        error: `the "${label}" line is missing; the script anchors on its exact wording`,
      };
    }
    if (markers.length > 1) {
      return {
        error: `the "${label}" line appears ${markers.length} times; there must be exactly one, or the two copies can disagree`,
      };
    }
    const m = canonicalRe.exec(md);
    if (!m) {
      return {
        error: `the "${label}" line is present but not in its canonical form; the script anchors on its exact wording`,
      };
    }
    return { value: Number(m[1]) };
  };

  // Codex #1978 r15: the MARKER omits the closing `**` on purpose, exactly as
  // the stamp's duplicate check does. Requiring it made an unterminated second
  // claim — `**Live right now: three of five`, a dropped `**` — invisible to
  // the duplicate arm while staying perfectly visible to a reader. Counting
  // WELL-FORMED copies to answer HOW MANY copies there are is the same
  // question-substitution the stamp check was fixed for one round earlier; I
  // fixed the stamp and left its sibling, which is this PR's most-repeated
  // shape. The canonical regex below still demands the full markup — existence
  // and validity are separate questions asked separately.
  const live = read(
    'Live right now',
    /\*\*Live right now:/,
    /^-\s+\*\*Live right now:\*\*\s+(\d+)\s+of\s+5\s*$/m,
  );
  // Codex #1978 r7: the label is matched EXACTLY. `Committed[^:]*` accepted
  // `**Committed, live only:**` while the value it validates is derived as
  // live PLUS reserved — the authority would have defined the number one way
  // and computed it another, with the gate reporting agreement. The file says
  // its anchors are load-bearing and that rewording one must fail; a wildcard
  // in the middle of the anchor is that promise not being kept.
  const committedLabel = (/\*\*Committed[^*:]*:/.exec(md) ?? [''])[0];
  // TWO canonical labels, because there are two states. Codex #1978 r13: with
  // only the reserve form canonical, the runbook's post-arm refresh had NO
  // satisfiable answer — remove the reserve wording and the canonical check
  // fails; keep it and the r12 reverse check fails, because the reservation is
  // gone. I added a procedure and, in the same round, made it impossible to
  // complete. Two fixes correct in isolation and contradictory together.
  //
  // Still not a wildcard: r7's finding stands, and `Committed[^:]*` would again
  // admit a label that contradicts the derivation. These are two NAMED forms,
  // and which one is required is decided below by whether anything is actually
  // reserved.
  const committed = read(
    'Committed',
    /\*\*Committed[^*:]*:/,
    /^-\s+\*\*Committed, (?:live only|live plus [^*:]+):\*\*\s+(\d+)\s+of\s+5\s*$/m,
  );
  const spare = read(
    'Genuinely spare',
    /\*\*Genuinely spare:/,
    /^-\s+\*\*Genuinely spare:\*\*\s+(\d+)\s*$/m,
  );

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
  const derived = liveTriggers + reservedNames.length;
  if (committed.value !== derived) {
    problems.push(
      `summary says ${committed.value} committed, but the inventory has ${liveTriggers} live ` +
        `+ ${reservedNames.length} reserved = ${derived}`,
    );
  }

  // Codex #1978 r11: WHICH Worker holds the reservation, not just how many.
  // Counting alone let the keeper row become `undeployed` and the mesh-watcher
  // row become `reserved` while the summary still said "the keeper's reserve" —
  // one reserved row either way, so every check passed. Neither unscheduled row
  // has an account witness (the r7 asymmetry again), so this table is the only
  // place that identity exists, and the keeper's re-enable procedure would go
  // on treating its trigger as protected while mesh-watcher held it.
  //
  // Each reserved Worker must be NAMED in the committed label: cheap to
  // satisfy, impossible to satisfy by accident, and moving a reservation now
  // forces the prose to move with it.
  // Codex #1978 r15: this must be an EQUALITY between two sets, not a
  // one-way `includes`. Checking only that every reserved Worker is named
  // let the label name a Worker that holds no reservation — `live plus the
  // keeper and mesh-watcher's reserve` passed with only the keeper reserved,
  // because the string contains "keeper". That is r11/r12's one-direction
  // mistake for the third time: r11 required every reservation to be named,
  // r12 added the reverse for reservations that no longer exist, and neither
  // asked whether a name in the label corresponds to a reservation at all.
  //
  // The candidate set is every Worker IN THE TABLE, which is a closed world
  // this script may legitimately assume — the authority states outright that
  // a Worker not listed holds no trigger, and `--live` enforces exactly that.
  // Closing the world over the inventory is sound; closing it over prose,
  // which is what the earlier substring test effectively did, is not.
  // Codex #1978 r46: stripping the prefix is a MANY-TO-ONE map, and the
  // authority may legitimately list both `keeper` and `vaipakam-keeper` —
  // both are legal Worker names. With both present, a summary naming
  // `vaipakam-keeper`'s reservation also marked the unrelated `keeper` row as
  // claimed and rejected it for not being reserved, while spelling the full
  // name was rejected as unknown: NO passing representation of that account
  // state, which is the third unrepresentable-state defect on this PR.
  //
  // The short form stays accepted, because every row in the table uses it
  // today and the summary reads better for it — but only while it is
  // UNAMBIGUOUS. When two rows collapse to the same token, that token stops
  // being a name and the full spelling is required, which is decidable from
  // the table alone.
  const shortOf = (n) => n.replace(/^vaipakam-/, '').toLowerCase();
  // Codex #1978 r47: counting short-to-short collisions missed the case where
  // a short alias equals a DIFFERENT row's full name — with
  // `vaipakam-keeper` and `vaipakam-vaipakam-keeper` listed, the token
  // `vaipakam-keeper` is one row's full name and the other's short form at the
  // same time, and a single-holder label satisfied both. Uniqueness has to be
  // measured over the UNION of every form every row can go by, which is the
  // r46 fix asking the same question one level too narrowly.
  const claims = new Map();
  const bump = (k) => claims.set(k, (claims.get(k) ?? 0) + 1);
  for (const n of allNames) {
    const full = n.toLowerCase();
    const short = shortOf(n);
    bump(full);
    if (short !== full) bump(short);
  }
  const identifiers = (n) => {
    const full = n.toLowerCase();
    const short = shortOf(n);
    const ids = [full];
    if (short !== full && claims.get(short) === 1) ids.push(short);
    return ids;
  };
  const distinctiveOf = (n) => shortOf(n);
  const label = committedLabel.toLowerCase();
  const reservedSet = new Set(reservedNames);
  // Codex #1978 r17: `includes` again, one layer in. The r15 fix made the
  // COMPARISON a set equality and left MEMBERSHIP a substring test, so
  // `the housekeeper's reserve` still matched `vaipakam-keeper` and the
  // "exact owner check" passed while naming a different holder. Third time
  // this check has been fixed in the direction of the previous fix's blind
  // spot; the token boundary is what makes it an identity test rather than a
  // containment one.
  // Codex #1978 r18: filtering the KNOWN names can only ever find known
  // names. `live plus the keeper and intruder's reserve` passed, because
  // `intruder` is in no table row and so was never a candidate to reject —
  // the closed world I defended as sound in r17 was sound for the question
  // "which known Workers are claimed" and useless for "is anything ELSE
  // claimed". Fourth consecutive round on this check, and the fourth time the
  // fix answered the previous question rather than the next one.
  //
  // So parse the label's holder list instead of testing membership against
  // it. Read the words between "live plus" and "reserve", split on the
  // connectives, and treat every token as a claimed holder — then the
  // comparison with the table is a real set equality in both directions,
  // including for holders the table has never heard of.
  // Both apostrophes. The authority uses ASCII `'` today — verified — but a
  // typographic `’` is what an editor or autocorrect inserts, and with only
  // the ASCII form the holder would parse as `keeper’s`, match no Worker, and
  // be reported as an unknown holder: a blocking gate rejecting a correct
  // document over a character substitution nobody would look for.
  // Codex #1978 r49: NON-GREEDY took the FIRST `reserve`, so a legal name
  // like `vaipakam-cold-reserve` truncated its own label to `cold-` and no
  // spelling could pass — the SEVENTH unrepresentable state, and the exact
  // sibling of r48's `and`. There I resolved known identifiers before
  // splitting on conjunctions and left this extraction, which runs first,
  // still treating a name fragment as syntax. Greedy anchors on the LAST
  // `reserve`, which is the structural one.
  const holderText = /live plus\s+(.*)\s*(?:['’]s)?\s*reserve/.exec(label)?.[1] ?? '';
  // Codex #1978 r48: a legal Worker name can CONTAIN a conjunction —
  // `vaipakam-research-and-development` — and splitting first turned every
  // spelling of it into unknown fragments, so no label could pass: the SIXTH
  // unrepresentable state on this PR. Known identifiers are resolved out of
  // the text first, and only what remains is split on conjunctions.
  const knownIds = [...allNames].flatMap((n) => identifiers(n)).sort((a, b) => b.length - a.length);
  const resolved = [];
  let remainder = holderText;
  for (const id of knownIds) {
    const re = new RegExp(`(?:^|[^a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i');
    const m = re.exec(remainder);
    if (m) {
      resolved.push(id);
      remainder = remainder.slice(0, m.index) + ' ' + remainder.slice(m.index + m[0].length);
    }
  }
  const claimed = resolved.concat(
    remainder
      // Resolving a name out of the middle leaves its article and possessive
      // behind, which the old split consumed as part of the token.
      .replace(/\bthe\b/gi, ' ')
      .replace(/['’]s\b/g, ' ')
      .split(/\s*(?:,|\band\b|\&)\s*/)
    .map((t) => t.replace(/^the\s+/, '').replace(/['’]s$/, '').trim())
      .filter(Boolean),
  );

  // Codex #1978 r32: the holder list was PARSED and then not used for the
  // comparison. r18 replaced substring membership with a parsed list, and both
  // reservation loops kept reading a `namedInLabel` set built by searching the
  // WHOLE label for each known name — so a summary whose holder list was empty
  // still satisfied the "is this reservation named?" check on the strength of
  // the word `keeper` appearing later in the sentence for some other reason.
  // The parse was correct and inert; the fix that replaced containment left
  // containment running beside it. Fifth round on this check, and the first
  // where the previous fix was already present and simply not consulted.
  const claimedSet = new Set(claimed);
  const claimedNames = new Set(
    [...allNames].filter((n) => identifiers(n).some((id) => claimedSet.has(id))),
  );
  for (const token of claimed) {
    if (![...allNames].some((n) => identifiers(n).includes(token))) {
      problems.push(
        `the "Committed" line names \`${token}\` as holding a reservation, but no ` +
          `inventory row names that Worker at all — the summary is claiming a ` +
          `reservation for something the table has never heard of`,
      );
    }
  }
  for (const name of reservedNames) {
    if (!claimedNames.has(name)) {
      problems.push(
        `the inventory reserves a trigger for \`${name}\` but the "Committed" line ` +
          `does not name it — the summary and the table disagree about WHO holds ` +
          `the reservation`,
      );
    }
  }
  for (const name of claimedNames) {
    if (!reservedSet.has(name)) {
      problems.push(
        `the "Committed" line names \`${name}\` as holding a reservation, but the ` +
          `inventory does not reserve one for it — a reservation the table does ` +
          `not grant cannot be spent, and the deployment ordering this file ` +
          `protects would be read off the wrong Worker`,
      );
    }
  }
  // Codex #1978 r12: and the REVERSE. r11 required every reservation to be
  // named; it did not reject a label naming a reservation that no longer
  // exists. After the keeper is re-armed there are no reserved rows, and
  // "live plus the keeper's reserve" would go on describing a reserve that
  // has become a live trigger — with committed and spare both unchanged by
  // that conversion, so nothing else in this function notices.
  if (reservedNames.length === 0 && /\breserv/i.test(committedLabel)) {
    problems.push(
      'the "Committed" line still claims a reserve, but no inventory row is ' +
        'marked reserved — if a reservation was converted to a live trigger, ' +
        'use "**Committed, live only:**"',
    );
  }
  if (reservedNames.length > 0 && !/\breserv/i.test(committedLabel)) {
    problems.push(
      `the "Committed" line says "live only", but ${reservedNames.length} row(s) ` +
        'are marked reserved — use "**Committed, live plus <holder>\'s reserve:**"',
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
  const statuses = new Map(); // every parsed row's status, for checks the account settles
  let sawHeader = 0;
  let sawDelimiter = 0;
  let headerAt = -1;
  let delimiterAt = -1;
  let rowIdx = -1;
  let firstDataAt = -1;
  let lastDataAt = -1;
  /** name -> the `Source in this repo` path, or null for the explicit *none*. */
  const sources = new Map();
  const problems = [];
  const seen = new Set();

  // ── WHY THIS PARSER IS STRICT ────────────────────────────────────────────
  //
  // Four rounds of review found four ways to write a row this parser would
  // half-read — a bolded name (r4), a missing column (r5), an extra column
  // (r6), a case variant (r7). They look like four unrelated lessons and are
  // one, stated here so the fifth is expected rather than discovered:
  //
  //     A LIVE row has a second witness; a RESERVED row does not.
  //
  // For a live row, `--live` compares against the account and a mis-parse
  // eventually surfaces as ACCOUNT ONLY or SCHEDULE. A reserved row has no
  // account schedule to compare — the reservation exists only in this table —
  // so every relaxation in row parsing lands on the reservation, silently,
  // and the summary can then be edited to the parser's answer. That is why
  // each of the four was reachable end-to-end rather than cosmetic, and it
  // predicts where the next one lives better than any of the four fixes does.
  //
  // Practical consequence: prefer REJECTING a row this parser cannot read
  // exactly, over interpreting what it probably meant.
  //
  // Only the inventory section. Bounding it is what lets an UNPARSABLE data row
  // be a finding rather than a skip — outside these bounds a `|` line could be
  // any other table, and demanding it parse as an inventory row would be a
  // finding about nothing.
  // `\Z` is not a JavaScript escape — an earlier revision used it and the
  // regex silently matched nothing, so the parser saw an empty inventory and
  // the summary check reported "0 triggers". Sliced by index instead, which
  // has no such trap.
  // Codex #1978 r14: exactly ONE inventory heading. Slicing the first match
  // meant a second `## The inventory` with a contradictory table produced no
  // finding of any kind — the rendered authority would show two inventories
  // and every check would keep reading only the first. The same "exactly one"
  // discipline the summary anchors and the stamp already have; this was the
  // one structural element without it.
  // Codex #1978 r23: count over the VISIBLE document. A fenced EXAMPLE of the
  // heading — the natural way to show an editor what the section looks like —
  // read as a second section and BLOCKED CI on a correct authority. The
  // section extraction below already derives from visibleLines; the duplicate
  // count sitting three lines above it did not. Same split as the stamp
  // markers in r19, in the same function, found two rounds later.
  const visibleAll = [...visibleLines(md)];
  const headings = visibleAll.filter((l) => /^##\s+The inventory\b/.test(l));
  if (headings.length > 1) {
    problems.push(
      `the authority has ${headings.length} "## The inventory" sections; there ` +
        'must be exactly one, or the checks read a different table than the reader',
    );
  }
  // Codex #1978 r19: visibility isdetermined over the WHOLE document and the
  // section is sliced FROM THE VISIBLE LINES — not the other way round.
  // Slicing first meant a fence opened immediately BEFORE the heading was
  // outside `region`, so `visibleLines(region)` started with a clean slate and
  // parsed every hidden row as visible. A slice cannot inherit state it was
  // cut away from; deciding visibility first is the only ordering that can be
  // right, rather than one more special case bolted onto the wrong one.
  const visible = visibleAll;
  const headIdx = visible.findIndex((l) => /^##\s+The inventory\b/.test(l));
  let lines = visible;
  if (headIdx !== -1) {
    const rest = visible.slice(headIdx + 1);
    const nextIdx = rest.findIndex((l) => /^##\s/.test(l));
    lines = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  }

  for (const line of lines) {
    rowIdx += 1;
    // Codex #1978 r8: a leading pipe is OPTIONAL in Markdown — the table still
    // renders — so skipping lines without one dropped a row a reader can see.
    // The fifth variant of the row-shape defect, and the first the principle
    // above should have predicted rather than review finding it: a reservation
    // written without its leading pipe vanishes, and no account witness exists
    // to notice. Candidacy is now "enough pipes to be a row", and the
    // non-canonical form is rejected by name rather than skipped.
    // Codex #1978 r18: a TRUNCATED row — `| \`vaipakam-keeper\` | *(none)*` —
    // has two pipes and was skipped here, one branch before the column-count
    // guard that exists to report exactly that. Markdown still renders it,
    // with the missing cells empty, so a reader sees the reservation and the
    // parser does not; and `--live` cannot object, because a reserved Worker
    // has no account schedule to compare against. Same silent-skip-before-the-
    // finding shape as r5, in the candidacy test rather than the early-out.
    //
    // Candidacy is now "starts like a row, OR has enough pipes to be one".
    // A leading pipe is the strong signal — prose does not begin with one —
    // and the pipe count still catches the leading-pipe-omitted form the next
    // check reports by name.
    const pipes = (line.match(/\|/g) ?? []).length;
    if (!/^ {0,3}\|/.test(line) && pipes < 3) continue;
    if (!/^\s*\|/.test(line)) {
      problems.push(
        `an inventory row is missing its leading pipe; Markdown renders it, this ` +
          `parser must not have to guess: ${line.trim().slice(0, 80)}`,
      );
      continue;
    }
    // Codex #1978 r27: split on UNESCAPED pipes. GFM renders `\\|` inside a
    // cell, so status prose like `live — warm \\| archive overlap` is ONE cell
    // to a reader and was five columns to this parser — reported malformed and
    // the live Worker dropped. A blocking gate that forbids ordinary
    // explanatory prose in the column meant for explanatory prose.
    // Codex #1978 r40: `(?<!\\)\|` treats a pipe after ANY backslash as
    // escaped, but GFM escapes it only after an ODD-length run — `\|` is a
    // literal pipe, `\\|` is an escaped backslash followed by a real cell
    // separator. Verified against the repository's own Remark GFM parser:
    // `live \\| reserved` renders as two cells while this split produced one,
    // so a fifth cell could render that both gate modes never saw.
    //
    // I DEFERRED this exact item to #1990 at round 30, batched with three
    // CommonMark questions on the argument that they were one decision about
    // how much markup to implement. That was wrong about this member: parity
    // of a backslash run is a single decidable rule, not a specification, and
    // it is settled here in a few lines. The other three stay deferred. A
    // batch is only as deferrable as its least deferrable member, and I did
    // not check that before batching.
    const cells = splitTableRow(line.trim().replace(/^\||\|$/g, ''));
    // The header and the alignment separator are not data.
    if (/^[\s:-]+$/.test(cells[0])) {
      sawDelimiter += 1;
      if (delimiterAt === -1) delimiterAt = rowIdx;
      // Codex #1978 r20: the DELIMITER row, checked like the header row above
      // it. It was skipped on its first cell alone, so `|---|` under a
      // four-column header left every data row parsed and no problem
      // reported — while GFM does not recognise that as a table at all, so
      // the rendered authority shows no inventory. Sibling of the header
      // finding, one line below it, missed in the same round I fixed that.
      // Codex #1978 r23: GFM requires at least THREE hyphens per delimiter
      // cell, so `|-|-|-|-|` renders no table while passing a `-{1,}` test.
      const cellsOk = cells.map((c) => c.trim()).every((c) => /^:?-{3,}:?$/.test(c));
      if (cells.length !== 4 || !cellsOk) {
        problems.push(
          `the inventory's alignment row has ${cells.length} cell(s), not 4 valid ` +
            `delimiters; Markdown then renders no table at all and the rows below ` +
            `are invisible to a reader while this parser still reads them`,
        );
      }
      continue;
    }
    if (/^\s*Worker\s*$/i.test(cells[0])) {
      sawHeader += 1;
      if (headerAt === -1) headerAt = rowIdx;
      // Codex #1978 r19: the header was skipped on its FIRST cell alone, while
      // the data rows below are parsed by fixed position. Reorder the headings
      // to `| Worker | Status | Source in this repo | Schedule |` and the
      // rendered table tells an operator that schedules are statuses — with
      // both modes green, because the parser never read the headings it was
      // disagreeing with. Cheap to check and it is the one row that says what
      // every other row MEANS.
      const want = ['Worker', 'Schedule', 'Source in this repo', 'Status'];
      const got = cells.map((c) => c.trim());
      if (got.length !== want.length || got.some((c, i) => c !== want[i])) {
        problems.push(
          `the inventory header reads \`${got.join(' | ')}\` but this parser reads ` +
            `columns by position as \`${want.join(' | ')}\`; the headings and the ` +
            `parse would describe different tables`,
        );
      }
      continue;
    }
    // Codex #1978 r5: a SHORT row used to `continue` before the malformed-row
    // finding below, so dropping the Status column dropped the reservation with
    // it, in silence — and `--live` cannot recover a reservation, because a
    // reserved Worker has no account schedule to compare against. The early-out
    // was performing the exact silent skip the finding below exists to stop,
    // one branch earlier and out of its reach.
    // Codex #1978 r6: EXACTLY four, not at least four. A fifth cell was
    // accepted and then ignored — `| … | undeployed | reserved |` parsed as
    // undeployed with no reservation, while the rendered table showed the
    // reservation to anyone reading it. "At least" is how a parser disagrees
    // with the document it is parsing.
    if (cells.length !== 4) {
      problems.push(
        `an inventory row has ${cells.length} column(s), not 4: ${line.trim().slice(0, 80)}`,
      );
      continue;
    }

    // Codex #1978 r43: UNDERSCORES are legal in a Worker name — Wrangler
    // accepts them and Cloudflare's own client documents `this-is_my_script-01`
    // — so this alphabet made such a Worker impossible to write down. Not a
    // cosmetic limit: the row is reported unparseable AND `--live` reports the
    // same script as ACCOUNT ONLY, so the authority could not be made correct
    // by any edit. A gate with no passing state is worse than no gate.
    // Codex #1978 r47: the candidacy check allows `{0,3}` leading spaces (GFM
    // renders such a table normally) and this regex demanded column zero, so a
    // formatting-only indent made EVERY data row unparseable in both modes —
    // the fifth unrepresentable state on this PR. The two tests have to agree
    // about what a row looks like.
    // Codex #1978 r49: Wrangler rejects a name starting with a dash, and a
    // RESERVED row has no account-side witness — so the summary could be
    // balanced around a Worker that cannot be deployed. Must start
    // alphanumeric; the underscore alphabet from r43 is retained.
    const row =
      /^ {0,3}\|\s*`([a-z0-9][a-z0-9_-]*)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/i.exec(line);
    // Codex #1978 r4: a row that LOOKS like data and does not parse was silently
    // skipped, and the "bolded name skipped" fixture documented the hole rather
    // than closing it. Bolding the keeper's name would drop its reservation from
    // the parse; the summary could then be edited to match, and `--live` could
    // not object because a reserved Worker has no account schedule to compare.
    // Every data row in this section must parse.
    if (!row) {
      problems.push(
        `an inventory row does not parse — the Worker cell must be exactly one ` +
          `backticked name: ${line.trim().slice(0, 80)}`,
      );
      continue;
    }
    const [, name, scheduleCell, sourceCell, statusCell] = row;

    // Codex #1978 r2: `Map.set` silently overwrote a repeated name, so leaving
    // a stale row behind while adding its replacement produced a table with two
    // contradictory schedules that both halves would accept — they only ever
    // saw the last one. A repeat is now a finding, not a shrug.
    // Codex #1978 r7: the row regex is case-INSENSITIVE while this set was
    // case-sensitive, so `Vaipakam-Keeper` beside `vaipakam-keeper` read as two
    // Workers and counted two reservations. `--live` cannot expose it either —
    // reserved rows have no account schedule to compare. Worker names are
    // lower-case on Cloudflare, so a variant is rejected outright rather than
    // normalised: silently accepting a name the account cannot have is how a
    // typo becomes a second row.
    if (name !== name.toLowerCase()) {
      problems.push(
        `\`${name}\` is not lower-case; Cloudflare Worker names are, so this row ` +
          `cannot match any account entry`,
      );
      continue;
    }
    if (seen.has(name)) {
      problems.push(
        `the inventory lists \`${name}\` more than once; two rows for one Worker can disagree`,
      );
      continue;
    }
    seen.add(name);

    // Each cron expression is its OWN backticked span; the delimiter between
    // spans lives outside them.
    //
    // Codex #1978 r3: the previous revision split ONE span on commas, to make
    // two schedules in a cell count as two triggers (r2's finding). That was
    // worse than what it replaced — a comma is CRON SYNTAX. An ordinary
    // `0 1,13 * * *` became the two nonsense fragments `0 1` and `13 * * *`,
    // overcounting the budget offline and reporting a schedule disagreement in
    // `--live` against a table that exactly reproduced the account.
    // Codex #1978 r14: `.filter(Boolean)` — erasing a cron expression while
    // leaving its backticks produced `['']`, an empty string counted as a live
    // trigger. The totals stay put, so the offline gate passes over a row with
    // no schedule at all; `--live` would catch it, but this is a malformed
    // table rather than account staleness and belongs to the offline half.
    const spans = [...scheduleCell.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    // Only a cell that is NOTHING BUT spans and separators is a schedule.
    // `*(would be `*/15 * * * *`)*` contains a span and is not one.
    const residue = scheduleCell.replace(/`[^`]+`/g, '').replace(/[\s,]/g, '');
    const status = readStatus(statusCell);

    if (firstDataAt === -1) firstDataAt = rowIdx;
    lastDataAt = rowIdx;
    sources.set(name, readSource(sourceCell));
    if (status !== null) statuses.set(name, status);

    // Codex #1978 r35: a span was counted as a trigger on the strength of being
    // non-empty and backticked. `` `not a cron` `` parsed clean, the summary
    // still balanced, and only the credentialed `--live` half would ever have
    // noticed — so CI could accept an authority whose table names a schedule
    // that cannot run. That is the r14 empty-span finding one step out: the
    // question was never "is there text between the backticks" but "is this a
    // schedule", and both times the cheaper question was answered instead.
    //
    // Five fields, each a cron atom. Deliberately syntactic and not a
    // range-checking parser — `99 * * * *` is somebody's problem at deploy
    // time, while `not a cron` is this file's, and the gate has been punished
    // three times for implementing more of a format than it needed.
    //
    // Codex #1978 r37: RANGES too, not only shape. `99 99 99 99 99` is
    // lexically perfect and cannot execute, so it parsed clean and was counted
    // as a live trigger. My own comment here argued an out-of-range value was
    // "somebody's problem at deploy time" — that reasoning was wrong in the
    // direction that matters: Cloudflare rejects it, so no trigger is ever
    // armed, so the row describes a schedule that does not exist and the
    // budget derived from it is overstated. That is precisely this file's
    // problem. And unlike Markdown or English, cron IS a closed specified
    // format with five fields and known bounds — the argument against
    // implementing more of a format does not reach a grammar this small.
    // Codex #1978 r44: `L`, `W` and `#` are part of Cloudflare's supported
    // cron syntax, and this validator rejected them — so an account legally
    // scheduled `0 0 L * *` could not be written into the authority, the
    // offline gate failed, and `--live` could not accept an inventory that
    // exactly matched the account. That is the SECOND unrepresentable legal
    // state in two rounds, after the underscore in a Worker name, and both
    // came from validating against what I pictured instead of what the
    // platform documents.
    //
    // So the posture is corrected along with the grammar. This check exists
    // to catch a cell that is not a schedule at all — `not a cron` — and its
    // failure direction is a FALSE REJECTION, which has no remedy: the
    // operator cannot edit the file into a passing state, and the only way
    // out is to switch the gate off. It is therefore deliberately permissive
    // about anything built from the platform's alphabet, and strict only
    // where a token is unambiguously numeric and out of range.
    const NAMES = {
      3: /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i,
      4: /^(?:sun|mon|tue|wed|thu|fri|sat)$/i,
    };
    const BOUNDS = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 7],
    ];
    const atomOk = (atom, [lo, hi], idx) => {
      if (atom === '*') return true;
      // Codex #1978 r50: `?` is not a wildcard in every field — it stands for
      // "no specific value" and is meaningful only in day-of-month and
      // day-of-week, where one of the pair is left unspecified. Accepting it
      // unconditionally admitted `? ? ? ? ?`, which Cloudflare will never
      // register. Its step/range positions are rejected below with `*`.
      if (atom === '?') return idx === 2 || idx === 4;
      // Extended forms are FIELD-SCOPED and still BOUNDED (#1978 r44
      // follow-on). Accepting them structurally in any field reopened the very
      // hole the range check was added to close one round earlier: `L 0 * * *`
      // (last-day in the MINUTE column), `0 0 32W * *`, `0 0 * * 8#1` and
      // `0 0 * * 5#7` were all accepted as live triggers, and not one of them
      // can run. Widening a grammar is where a range rule quietly stops
      // applying, so the widening carries the range with it.
      //
      // `L`/`W` mean something only in day-of-month, `L`/`#` only in
      // day-of-week, and every number these forms carry obeys its own field —
      // with `#` taking 1-5, there being no sixth same-weekday in a month.
      const ext =
        idx === 2
          ? [/^L$/i, /^LW$/i, /^(\d{1,2})W$/i]
          : idx === 4
            ? [/^L$/i, /^(\d)L$/i, /^(\d)#([1-5])$/]
            : [];
      for (const re of ext) {
        const m = re.exec(atom);
        if (!m) continue;
        const n = m[1] === undefined ? null : Number(m[1]);
        return n === null || (n >= lo && n <= hi);
      }
      if (NAMES[idx]?.test(atom)) return true;
      if (/^\d+$/.test(atom)) {
        const n = Number(atom);
        return n >= lo && n <= hi;
      }
      return false;
    };
    // Codex #1978 r46: an extended form is a COMPLETE component, not a range
    // endpoint or a step base. Decomposing first and validating the fragments
    // accepted `15W-20`, `L/2` and `5#2-6` - each fragment legal on its own,
    // the composite unrunnable. So the special form is tested at the whole
    // component BEFORE any `/` or `-` splitting, and a component carrying
    // `L`, `W` or `#` without being one is rejected outright, not decomposed.
    // Codex #1978 r47: searching a component for `l`/`w`/`#` also hits the
    // LETTERS IN NAMES — `JUL-AUG` was rejected for the L in JUL, `WED-FRI`
    // for the W in WED. That is the fourth unrepresentable legal state on this
    // PR, and it was caused by the r46 fix for the third. A character search
    // is not a form test; ask whether the component IS a special form, and
    // otherwise reject only extension characters that appear where no valid
    // atom could carry them.
    const extFormsFor = (idx) =>
      idx === 2
        ? [/^L$/i, /^LW$/i, /^\d{1,2}W$/i]
        : idx === 4
          ? [/^L$/i, /^\dL$/i, /^\d#[1-5]$/]
          : [];
    const fieldOk = (f, bounds, idx) =>
      f.split(',').every((part) => {
        if (extFormsFor(idx).some((re) => re.test(part))) {
          return atomOk(part, bounds, idx);
        }
        // A `#` is only ever part of a complete nth-weekday form, and an
        // `L`/`W` only inside a name or a complete form — anywhere else the
        // component is a composite that cannot run.
        const stray = part
          .split(/[-/]/)
          .some(
            (a) =>
              /[lw#]/i.test(a) && !(NAMES[idx] && NAMES[idx].test(a)) && !/^\d+$/.test(a),
          );
        if (stray) return false;
        // Codex #1978 r38: destructuring two names out of `split('/')` DROPS
        // everything after the second, so `*/2/3` validated as `*` step `2`
        // and was counted as a live trigger. Destructuring is silent about
        // extra elements by design, which makes it the wrong tool for
        // validating a grammar: the test belongs on the split's LENGTH, not on
        // the two names bound out of it.
        const parts = part.split('/');
        if (parts.length > 2) return false;
        const [range, step] = parts;
        // Codex #1978 r50: `?` is a complete atom, so it cannot be a step
        // BASE either — `?/2` parsed as a stepped range. r48 closed the range
        // position and left the step position, which is the same half-closed
        // shape as r46's composite finding.
        if (step !== undefined && range === '?') return false;
        // Codex #1978 r37 follow-on: a step of zero never advances, so `*/0`
        // names no times at all. That is the same "shaped like a schedule,
        // cannot run" defect the bounds close, one atom smaller.
        if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) {
          return false;
        }
        const ends = range.split('-');
        if (ends.length > 2) return false;
        // Codex #1978 r48: `*` and `?` are COMPLETE atoms, not range
        // endpoints — `*-5` and `JAN-*` passed because each end validated on
        // its own. Same shape as r46's composite finding, at the other end of
        // the grammar: a token legal alone is not legal in every position.
        if (ends.length === 2 && ends.some((e) => e === '*' || e === '?')) return false;
        if (!ends.every((e) => atomOk(e, bounds, idx))) return false;
        if (ends.length === 2 && ends.every((e) => /^\d+$/.test(e))) {
          return Number(ends[0]) <= Number(ends[1]);
        }
        return true;
      });
    for (const span of spans) {
      const fields = span.split(/\s+/);
      if (fields.length !== 5 || !fields.every((f, i) => fieldOk(f, BOUNDS[i], i))) {
        problems.push(
          `\`${name}\` carries \`${span}\` as a schedule, which is not a cron ` +
            `expression — five space-separated fields, each within its own ` +
            `range (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday ` +
            `0-7), are required. An ` +
            `unrunnable schedule counted as a live trigger is a budget this ` +
            `file states wrongly while every offline check passes`,
        );
      }
    }

    if (spans.length && residue === '') {
      live.set(name, spans);
      if (status !== 'live') {
        problems.push(
          `\`${name}\` carries a schedule but its status is ` +
            `${status === null ? 'unrecognised' : `"${status}"`}; a scheduled row must be "live"`,
        );
      }
      continue;
    }

    // Codex #1978 r23: a cell carrying backticked spans PLUS prose was
    // silently classified as no-schedule, so `\`* * * * *\` active` on a row
    // marked `reserved` passed both modes while the rendered row plainly
    // claims a live schedule. The residue test decided "not a schedule" and
    // nothing then asked whether the cell was a legitimate NO-schedule form
    // either — it fell into the gap between the two categories.
    // The ONE legitimate span-plus-prose form: `*(would be `*/15 * * * *`)*`,
    // which the mesh-watcher row uses to show the schedule it WOULD register.
    // Codex named it and I implemented the rule without it, breaking that row
    // — the rule and its stated exception arrived together and I took half.
    // Codex #1978 r24: the WHOLE cell, not a prefix. I wrote this exception one
    // round ago as a startsWith test, so `*(would be `…`)* active now` — and
    // any amount of trailing prose, and multiple spans — sailed through the
    // very check that had just been added to catch span-plus-prose cells. An
    // exception matched on a prefix is a hole shaped like whatever follows it.
    const isWouldBe = /^\s*\*\(\s*would\s+be\s+`[^`]+`\s*\)\*\s*$/i.test(scheduleCell);
    // Codex #1978 r25: and the SPAN-FREE case. My r23 fix only rejected cells
    // that had spans AND residue, so `every minute` — no spans at all —
    // classified as no-schedule and the status alone decided occupancy, while
    // the rendered row plainly claims a cadence. One branch of a two-branch
    // condition, again: I wrote the rule for the shape in the finding and not
    // for the question it was asking.
    // Codex #1978 r30: the CANONICAL spelling only. This accepted `none`,
    // `(none)`, `**none**`, and malformed halves like `(none` or `*(none)**`
    // — while the diagnostic it guards tells the editor the form is
    // `*(none)*`. A check that names one spelling and accepts six is not
    // enforcing a convention, it is describing one.
    // Codex #1978 r31: the CELL may be padded (Markdown tables are written
    // with alignment spaces); the VALUE may not. `*( none )*` and `*(NONE)*`
    // are not the spelling the diagnostic names, and my r30 "exact" fix still
    // admitted both through an inner `\s*` and the `i` flag. Trim the cell,
    // then compare exactly.
    const isNone = scheduleCell.trim() === '*(none)*';
    // Codex #1978 r28: the empty cell is NOT exempt. I wrote
    // `scheduleCell.trim() !== ''` into the r25 rule without asking what an
    // empty Schedule column claims — which is nothing a reader can act on,
    // in the one column whose whole job is to say whether a trigger is spent.
    // Every other non-canonical value is reported; blank was exempted purely
    // because it was not the shape in front of me.
    if (!spans.length && !isNone && !isWouldBe) {
      problems.push(
        `\`${name}\`'s schedule cell reads ${scheduleCell.trim() ? scheduleCell.trim().slice(0, 60) : '(empty)'}, which is ` +
          `neither a backticked cron expression nor a canonical no-schedule form ` +
          `(\`*(none)*\` or \`*(would be ...)*\`); a reader cannot tell what it claims ` +
          `and this parser assumes it claims nothing`,
      );
      continue;
    }
    if (spans.length && residue !== '' && !isWouldBe) {
      problems.push(
        `\`${name}\`'s schedule cell carries a cron span AND other text ` +
          `(${scheduleCell.trim().slice(0, 60)}); a reader sees a schedule and this ` +
          `parser does not. Use a bare backticked expression, \`*(none)*\`, or the ` +
          `explicit \`*(would be ...)*\` form`,
      );
      continue;
    }

    // No schedule, so the status cell alone decides whether the budget is
    // spoken for. It must therefore be unambiguous — see readStatus.
    if (status === null) {
      problems.push(
        `\`${name}\` has no schedule and its status is not one of ` +
          `${[...STATUSES].map((s) => `"${s}"`).join(', ')}; the parser cannot tell ` +
          `whether it holds a trigger`,
      );
    } else if (status === 'reserved') {
      reserved.push(name);
    } else if (status === 'live') {
      problems.push(`\`${name}\` is marked "live" but carries no schedule`);
    }
  }

  return { live, reserved, sources, statuses, framing: { sawHeader, sawDelimiter, headerAt, delimiterAt, firstDataAt, lastDataAt, rowCount: sources.size }, problems };
}

/**
 * The `Source in this repo` cell: a backticked path, or null for the explicit
 * `*none*` marker, or undefined when it is neither.
 */
export function readSource(cell) {
  const backticked = /^\s*`([^`]+)`\s*$/.exec(cell);
  if (backticked) return backticked[1].trim();
  if (/^\s*\*+\s*none\s*\*+\s*$/i.test(cell)) return null;
  return undefined;
}

/**
 * The controlled vocabulary a Status cell must LEAD with.
 *
 * Codex #1978 r3: the previous revision tested the whole cell for the word
 * `reserved`, and got the answer wrong in both directions at once — "no longer
 * reserved" counted as reserved, "reservation held for its return" did not.
 * Substring-matching a word cannot read a sentence, which is the same lesson
 * the `spare` lookbehind had already cost a round earlier: a pattern proves a
 * word is present, never what the sentence does with it.
 *
 * So the machine-readable part is a keyword the cell BEGINS with, and prose
 * follows. Anything unrecognised is a FINDING rather than a silent zero — an
 * operator inventing a status must be told the parser did not understand it,
 * not have it quietly not count.
 */
const STATUSES = new Set(['live', 'reserved', 'undeployed']);

/**
 * Split one GFM table row on its UNESCAPED pipes, honouring backslash parity.
 *
 * A backslash run of even length is escaped backslashes and leaves the pipe
 * as a separator; an odd run escapes the pipe into content. Written as a scan
 * because a lookbehind can only ask about the character immediately before,
 * and the question is about the length of the run.
 */
export function splitTableRow(row) {
  const cells = [];
  let cur = '';
  let slashes = 0;
  for (const ch of row) {
    if (ch === '\\') {
      slashes += 1;
      cur += ch;
      continue;
    }
    if (ch === '|' && slashes % 2 === 0) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
    slashes = 0;
  }
  cells.push(cur);
  // Unescape only the pipes that were escaped: an odd run before a pipe.
  return cells.map((c) => c.replace(/(\\*)\|/g, (m, run) => (run.length % 2 ? run.slice(1) + '|' : m)));
}

/** The leading status keyword, or null if the cell does not start with one. */
export function readStatus(cell) {
  // Codex #1978 r30: the keyword must END at a real boundary. `[a-z]+` stops
  // before a digit or underscore, so `reserved2`, `live123` and
  // `undeployed_v2` were read as their valid prefixes — and `reserved2`
  // silently creates a reservation that NO account check can contradict,
  // because a reserved Worker has no schedule to compare against. A typo in
  // the status cell was the one class of damage this parser promised to
  // reject and quietly accepted.
  //
  // Codex #1978 r31 made the boundary Unicode-aware; r32 found that combining
  // marks are category `M`, so `reserved́` still read as `reserved` — the
  // mark is part of the preceding grapheme, and a reader sees a word this
  // parser does not. `\p{M}` closes it. Third narrowing of one lookahead, and
  // the direction is always the same: what the RENDERED cell says is one
  // grapheme cluster, and matching code points is not the same question.
  // Codex #1978 r43: a HYPHEN continues a word too. `reserved-ish` read as
  // `reserved` — a status the table renders as explicitly equivocal and the
  // parser records as a definite reservation, which is the one row with no
  // account-side witness. Fourth narrowing of this lookahead; the class is
  // "characters a reader sees as part of the same token", and `-` is the
  // obvious member I had not enumerated. (`.` and `/` are excluded for the
  // same reason.)
  const m = /^[\s*_]*([a-z]+)(?![\p{L}\p{N}\p{M}_\-./])/iu.exec(cell);
  const word = m?.[1]?.toLowerCase();
  return word && STATUSES.has(word) ? word : null;
}

/**
 * Every inventory source path must resolve to tracked content.
 *
 * Codex #1978 r4: the Source column was parsed and thrown away, so renaming a
 * source directory left a stale path with no finding from either half. That
 * column is not decoration — the source-versus-`*none*` distinction is this
 * document's whole explanation of how #1977 happened, and a Worker whose source
 * silently stops existing is the beginning of the same story.
 *
 * Shells out, so it is separate from the pure parser the fixtures drive.
 */
export function checkSources(sources) {
  const problems = [];
  for (const [name, path] of sources) {
    if (path === null) {
      // Codex #1978 r20: an explicit *none* is a CLAIM about the tree — and
      // it is the claim this whole authority exists to make legible, because
      // "no source in this repository" is exactly the condition that hid
      // `vaipakam-offchain-data-archive` for three weeks. Accepting it
      // unchecked meant a maintained Worker could be marked account-only and
      // both modes would stay green, with the row asserting the very thing
      // #1977 is about.
      const declared = trackedWranglerNames();
      if (declared.has(name)) {
        problems.push(
          `\`${name}\`'s source says *none*, but \`${declared.get(name)}\` declares ` +
            `that Worker — it HAS a source in this repository, and *none* is the ` +
            `account-only condition this file exists to make visible`,
        );
      }
      continue;
    } // explicit *none* — the #1977 case, stated
    if (path === undefined) {
      problems.push(
        `\`${name}\`'s source cell is neither a backticked path nor the ` +
          `explicit *none* marker`,
      );
      continue;
    }
    // Codex #1978 r15: `git ls-files` reads its argument as a PATHSPEC, so a
    // cell of `apps/*` — or `:(glob)apps/**` — resolves happily and KEEPS
    // resolving after the Worker's real source directory is renamed or
    // deleted. That is precisely the drift this column exists to catch, so a
    // pattern here is worse than a wrong path: it cannot go stale. The cell
    // must name one literal path, and the lookup disables magic explicitly so
    // a future cell cannot turn it back on.
    // Codex #1978 r50: a substring test for `..` also rejects `ops/foo..bar`,
    // a perfectly legal directory name — and with the row rejected AND
    // `*none*` falsifiable by `trackedWranglerNames`, that Worker had no
    // passing representation at all. Eighth such state on this PR. Traversal
    // is a path COMPONENT equal to `..`, not the two characters appearing
    // anywhere.
    const traverses = path.split('/').some((seg) => seg === '..');
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || traverses) {
      problems.push(
        `\`${name}\`'s source \`${path}\` is not a literal repository path; a glob ` +
          `or pathspec keeps matching after the real source moves, which is the ` +
          `drift this column exists to catch`,
      );
      continue;
    }
    const out = execFileSync('git', ['ls-files', '-z', '--', `:(literal)${path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const tracked = out.split('\0').filter(Boolean);
    if (tracked.length === 0) {
      problems.push(
        `\`${name}\`'s source \`${path}\` matches no tracked files; if it moved, ` +
          `update the row — if it is genuinely gone, say *none* and note why`,
      );
      continue;
    }

    // Codex #1978 r17: "resolves to something tracked" is far weaker than it
    // reads. `:(literal)apps` resolves to all 676 files under `apps/`, so a
    // cell broadened to an ANCESTOR passes forever — the glob defect again,
    // reached without a glob, and immune to the r15 fix because `apps` is a
    // perfectly literal path.
    //
    // A Worker's source directory is identifiable rather than merely present:
    // every one of them holds a `wrangler` config directly beneath it, and no
    // ancestor does. That is the property to test — "this names A WORKER",
    // not "this names something". Checked against the tree when written: all
    // five sourced rows satisfy it and bare `apps` / `ops` do not.
    const configPath = tracked.find((f) =>
      /^wrangler\.(jsonc|json|toml)$/.test(f.slice(path.length + 1)),
    );
    if (configPath) {
      // Codex #1978 r18, and a straight reversal of my r17 refusal. I declined
      // to match the config's name against the row on the grounds that "no
      // current defect reaches it"; the counterexample is one line —
      // checkSources(Map([['vaipakam-agent', 'apps/indexer']])) passed. Two
      // swapped or copy-pasted source cells are permanently green, and the
      // column's whole job is to say WHICH source belongs to WHICH Worker.
      //
      // "No defect reaches it" was a claim about the space of edits, made
      // without looking. It is the same move as the counts this gate exists to
      // catch: an assertion about the world that nothing checks.
      //
      // Read with a regex rather than a JSONC parser — the file is
      // comment-laden and this needs one top-level string field. A config that
      // declares no name is not a finding here; `--live` already ties Worker
      // NAMES to the account, so this check exists for the DIRECTORY binding.
      const declaredName = readWranglerName(configPath);
      if (declaredName && declaredName !== name) {
        problems.push(
          `\`${name}\`'s source \`${path}\` holds a wrangler config for ` +
            `\`${declaredName}\` — the row points at another Worker's directory`,
        );
      }
    }
    if (!configPath) {
      problems.push(
        `\`${name}\`'s source \`${path}\` resolves, but holds no \`wrangler\` config ` +
          `directly beneath it, so it does not identify a Worker's source — an ` +
          `ancestor like \`apps\` resolves forever and can never go stale, which ` +
          `is the drift this column exists to catch`,
      );
    }
  }
  return problems;
}

/**
 * Remove `//` and block comments from JSONC/TOML-ish text, honouring strings.
 *
 * A single left-to-right scan with three states, because the delimiters are
 * only delimiters outside a string and outside another comment. Codex #1978
 * r27 demonstrated the alternative: a regex that treats `/*` inside a line
 * comment as an opener, and a later `"*&#47;15 * * * *"` cron literal as its close.
 */
function stripJsonLikeComments(text) {
  let out = '';
  let i = 0;
  let quote = null; // the quote char while inside a string
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue; // keep the newline itself on the next pass
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The Worker name a `wrangler` config declares, or null.
 *
 * ONE reader, deliberately. Codex #1978 r22: there were two — this logic in
 * `trackedWranglerNames` and a JSON-only copy in `checkSources` — and r21
 * taught the TOML literal-string form to one of them. The copy then accepted
 * a `.toml` config, failed to read its name, and let a swapped source cell
 * pass. That is the same divergence `visibleLines` was extracted to stop, two
 * hundred lines further down the same file, and I created it in the round
 * where I added the second call site.
 *
 * Regex rather than a parser: `.jsonc` is comment-laden, `.toml` is a
 * different grammar again, and one top-level string field is all that is
 * wanted. `^ {0,2}` keeps it to top level — `apps/agent/wrangler.jsonc` has
 * eleven `"name"` fields and only the first is the Worker's.
 */
function readWranglerName(configPath) {
  try {
    return wranglerNameFrom(
      readFileSync(configPath, 'utf8'),
      /\.toml$/i.test(configPath),
    );
  } catch {
    return null; // unreadable config is not this check's business
  }
}

/**
 * The PARSING half of {@link readWranglerName}, over text rather than a path.
 *
 * Split out so the selftest can state a case directly. Six rounds have landed
 * on this logic and none of them could be pinned, because the function only
 * ever took a PATH: every fix was exercised through whatever tracked config
 * happened to contain the shape, and a shape no committed config held could
 * not be written down at all. That is the actual reason an escaped quote
 * survived to round 40 — not the regex, which was only how it survived.
 */
export function wranglerNameFrom(raw, isToml) {
  // Codex #1978 r39: TOML was routed past the extension check and then run
  // through the JSON brace-depth tracker anyway, with only JSON comments
  // stripped. So `# template syntax: {{` in a TOML comment raised the depth
  // to two and `readWranglerName` returned null — and a null here silently
  // disables BOTH swapped-source detection and false-`*none*` falsification.
  //
  // FIFTH round on this function. r38 chose the grammar correctly and then
  // handed the file to the wrong parser regardless, which is the r32 shape:
  // the fix was made, was right, and the code it was meant to replace kept
  // running. TOML has no braces around top-level keys at all, so brace depth
  // is not merely fragile here — it is meaningless. The top-level table is
  // everything before the first `[section]` header, and that is the whole
  // rule.
  if (isToml) {
    // Codex #1978 r47: a multiline value BROKEN ACROSS PHYSICAL LINES still
    // read as empty, because the r46 fix matched triple quotes but kept
    // iterating one line at a time. Tenth distinct way this function has
    // failed to read a valid config, and the ninth to do it silently.
    //
    // So the top-level table is taken as ONE BLOCK and matched as one string:
    // a multiline value is by definition not a line, and iterating lines was
    // the assumption underneath both this and the r41 JSON finding. `#`
    // comments are stripped only at line starts, since a `#` inside a name is
    // content.
    const lines = raw.split('\n');
    const stop = lines.findIndex((l) => /^\s*\[/.test(l));
    const head = (stop === -1 ? lines : lines.slice(0, stop))
      .join('\n')
      .replace(/(^|\n)\s*#[^\n]*/g, '$1');
    const m = new RegExp(
      String.raw`(?:^|\n)\s*"?name"?\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\]|\\.)*)"|'([^']*)')`,
    ).exec(head);
    if (!m) return null;
    // Groups: 1 multiline-basic, 2 multiline-literal, 3 basic, 4 literal.
    // Literal forms are RAW by definition and returned untouched — decoding
    // them would be a new bug in the other direction. A multiline value's
    // opening newline is not part of it, per the TOML spec.
    if (m[2] !== undefined) return m[2].replace(/^\r?\n/, '');
    if (m[4] !== undefined) return m[4];
    // Codex #1978 r48: a multiline basic string may end a line with `\` to
    // strip the newline and the following indentation — TOML's line
    // continuation. Wrangler deploys the joined value; this returned the
    // backslash and newline literally, so the Worker was indexed under a
    // name that does not exist. Eleventh route, same silent consequence.
    const basic =
      m[1] !== undefined
        ? m[1].replace(/^\r?\n/, '').replace(/\\\r?\n[ \t]*/g, '')
        : m[3];
    return basic.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (whole, esc) => {
      if (esc[0] === 'u' || esc[0] === 'U') {
        return String.fromCodePoint(parseInt(esc.slice(1), 16));
      }
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
      return simple[esc] ?? whole;
    });
  }
  // Codex #1978 r41: the JSON side was still LINE-based — depth was updated
  // after each line's check, and `name` had to begin its line — so
  // `{"name":"vaipakam-agent"}` returned null, as did any line carrying
  // another property first. Ordinary reformatting therefore switched off both
  // swapped-source validation and false-`*none*` rejection.
  //
  // SEVENTH round on this function, and the fourth in a row whose cause was
  // "this scan cannot see X": r25 indentation, r27 comment delimiters inside
  // strings, r39 the wrong language entirely, r40 escaped quotes, now line
  // layout. Every one of those is a property of the TEXT and none is a
  // property of JSON — a tokenizer has no concept of a line at all, so the
  // whole class goes with the rewrite instead of one more member of it.
  //
  // Also closes #1990's fourth deferred item, which was this same assumption.
  const text = stripJsonLikeComments(raw);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let strStart = -1;
  let lastKey = null;
  let lastKeyDepth = -1;
  let awaitingValue = false;
  let found = null;
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        const literal = text.slice(strStart, k);
        if (awaitingValue && lastKey === 'name' && lastKeyDepth === 1) {
          // Codex #1978 r42: `\\(.)` drops the backslash and keeps the rest,
          // which is right for `\"` and `\\` and WRONG for every multi-
          // character escape — `a` became the literal `u0061`. Wrangler
          // decodes and deploys `vaipakam-agent` as `vaipakam-agent`, so
          // the Worker was indexed under a name that does not exist and an
          // inventory row claiming `*none*` for the real one passed silently.
          //
          // Decoded with JSON's own semantics rather than a hand-rolled
          // table: the string came from a JSON file, so the language that
          // defines the escape is the one that should undo it. Falls back to
          // the raw literal if the fragment will not parse, since a malformed
          // config is not this check's business.
          // Codex #1978 r43: Wrangler takes the LAST duplicate top-level
          // `name`, so returning on the first indexed the config under a
          // Worker it does not deploy. Record and keep scanning.
          try {
            found = JSON.parse(`"${literal}"`);
          } catch {
            found = literal;
          }
          lastKey = null;
          awaitingValue = false;
          continue;
        }
        lastKey = literal;
        lastKeyDepth = depth;
        awaitingValue = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      strStart = k + 1;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      awaitingValue = false;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      awaitingValue = false;
    } else if (ch === ':') {
      awaitingValue = true;
    } else if (ch === ',') {
      awaitingValue = false;
    }
  }
  return found;
}

/**
 * Every Worker name declared by a tracked `wrangler` config, mapped to its
 * config path. Used to falsify an explicit *none* claim in the source column.
 */
function trackedWranglerNames() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*wrangler.jsonc', '*wrangler.json', '*wrangler.toml'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const names = new Map();
  for (const f of out.split('\0').filter(Boolean)) {
    const declaredName = readWranglerName(f);
    if (declaredName && !names.has(declaredName)) names.set(declaredName, f);
  }
  return names;
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

  const scripts = await cfList(`/accounts/${account}/workers/scripts`, token);
  const live = new Map();
  // Codex #1978 r21: keep the DEPLOYED set, not just the scheduled one. A
  // Worker with a script and no cron was dropped here, so an `undeployed` row
  // for it passed and `--live` reported a match over a false status. The
  // account distinguishes three states — absent, deployed-unscheduled,
  // scheduled — and this loop was collapsing the first two, which is exactly
  // the distinction `reserved` vs `undeployed` exists to record.
  const deployed = new Set(scripts.map((s) => s.id));
  for (const s of scripts) {
    const r = await cfOne(
      `/accounts/${account}/workers/scripts/${s.id}/schedules`,
      token,
    );
    const crons = (r?.schedules ?? []).map((x) => x.cron).filter(Boolean);
    if (crons.length) live.set(s.id, crons);
  }

  const authorityMd = readFileSync(AUTHORITY, 'utf8');
  const inv = parseInventory(authorityMd);
  const committed = inv.live;

  // `undeployed` claims the account has no script at all. Checked here because
  // only the account can falsify it — the offline half has no way to know.
  const undeployedProblems = [];
  for (const [name, status] of inv.statuses ?? []) {
    // Codex #1978 r23, and this is the gap I FLAGGED MYSELF two rounds ago
    // and did not close — "the reverse is now the remaining unchecked case…
    // it is the safer direction, but it is not checked". Naming a hole is not
    // closing it, and a reply saying so is not a tracking issue either.
    if (status === 'reserved' && !deployed.has(name)) {
      undeployedProblems.push(
        `\`${name}\` is marked "reserved" but the account has no script for it at ` +
          `all; "reserved" means deployed-without-a-trigger, so either the script ` +
          `was deleted (the row should read "undeployed") or the reservation is ` +
          `being held for something that no longer exists`,
      );
    }
    if (status === 'undeployed' && deployed.has(name)) {
      undeployedProblems.push(
        `\`${name}\` is marked "undeployed" but the account has a deployed script ` +
          `for it (it simply holds no schedule); "reserved" is the status that ` +
          `means deployed-without-a-trigger`,
      );
    }
  }

  const problems = [
    ...undeployedProblems.map((p) => `STATUS        ${p}`),
    ...checkStamp(authorityMd).map((p) => `STAMP         ${p}`),
    ...checkInventoryFraming(inv).map((p) => `INVENTORY     ${p}`),
    ...inv.problems.map((p) => `INVENTORY     ${p}`),
    ...checkSources(inv.sources).map((p) => `SOURCE        ${p}`),
  ];
  // Same self-consistency check the offline half runs. Without it, `--live`
  // could compare the account to the inventory rows, find them equal, and
  // print "matches the account" over a summary saying something else.
  // Codex #1978 r20: `--live` must run the document-level comment ban too.
  // The ban replaced comment tracking inside visibleLines, so with it wired
  // only into the offline path an operator running `--live` against a
  // working-tree authority whose table, summary and stamp are all inside an
  // HTML comment would be told the inventory MATCHES THE ACCOUNT — over a
  // document that renders none of it. Deleting the parser moved this
  // responsibility to a caller, and I updated one of the two callers: the
  // same one-sibling-of-two miss this PR keeps producing, this time created
  // by the fix for it.
  // Codex #1978 r23: `--live` must run the document-level inventory checks the
  // offline half runs. With an account at zero scheduled triggers, an authority
  // whose data rows were all deleted and whose summary read 0/0/5 passed here
  // while the offline gate correctly rejected it — the two halves disagreeing
  // about whether the document is well-formed at all. Third time a check has
  // been wired into one of the two entry points; the pattern is that offline is
  // where I write them and live is where I forget them.
  for (const p of checkInventoryPresent(inv)) {
    problems.push(`INVENTORY     ${p}`);
  }
  for (const p of checkNoHtmlComments(authorityMd)) {
    problems.push(p);
  }
  for (const p of checkSummary(authorityMd, countTriggers(committed), inv.reserved, [
    ...inv.sources.keys(),
  ])) {
    problems.push(`SUMMARY       ${p}`);
  }
  // Compared as multisets, not as joined strings: two schedules in one cell are
  // two triggers, and the account may report them in either order.
  // Compared ELEMENT-WISE rather than by joining on a separator — an earlier
  // revision joined on one, and the separator it ended up with was a literal
  // NUL byte, which made this whole file read as BINARY to grep and every
  // text-scanning tool. Comparing the arrays directly needs no separator.
  const sameSchedules = (a, b) => {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
  };
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
  // ...and the mirror: a leading scope naming the ACCOUNT must NOT suppress.
  // Suppressing on any leading preposition would have silently disarmed the
  // gate for the exact sentences it exists to catch.
  [
    'a leading scope naming the account still fires',
    'In this Cloudflare account, there is no spare cron trigger.',
  ],
  ['a leading production scope still fires', 'In production, there is no spare cron trigger.'],
  // Codex #1978 r35: the r33 suppression read every clause opening with a
  // scope word as a foreign environment, so three claims about the account's
  // present state went quiet. A time is not a place.
  ['a leading temporal qualifier is not a scope', 'For now, no cron triggers are live.'],
  [
    'a leading circumstance is not a scope',
    'During the current outage, no cron triggers are live.',
  ],
  [
    'a leading subordinate clause is not a scope',
    'While maintenance continues, no cron triggers are live.',
  ],
  // Codex #1978 r35: the direct form with a PRESENT-STATE predicate. The r29
  // pattern took `taken|occupied|in use` only, so reordering "there are four
  // live cron triggers" into "four cron triggers are live" walked past the
  // gate — a restatement of the live count, which is the whole subject.
  ['the direct form with a live predicate', 'Four cron triggers are live.'],
  ['the direct form with an armed predicate', '4 cron schedules are armed today.'],
  // Codex #1978 r38: `running` — the plainest word for it — was the one the
  // r35 predicate list left out.
  ['the direct form with a running predicate', 'Four cron triggers are running.'],
  ['the postposed participle', 'There are four cron triggers running.'],
  ['the verbal form', 'The account currently runs four cron triggers.'],
  // Codex #1978 r41: `uses` — the verb the authority's own summary uses for
  // this ("Live right now") and the one an author reaches for first.
  ['the verbal form with uses', 'The account currently uses four cron triggers.'],
  // r43: `enabled` — the word the Cloudflare dashboard itself puts on a
  // trigger, and the one an operator copies out of it.
  ['the direct form with an enabled predicate', 'Four cron triggers are enabled.'],
  ['the attributive enabled form', 'There are four enabled cron triggers.'],
  ['the zero form with an enabled predicate', 'There are no enabled cron triggers.'],
  // r44: `configured` — Cloudflare's own term for a Cron Trigger that exists
  // on the account.
  ['the direct form with a configured predicate', 'Four cron triggers are configured.'],
  ['the attributive configured form', 'There are four configured cron triggers.'],
  // r45: no predicate at all — the plainest way to state the count.
  ['the bare existential', 'There are four cron triggers.'],
  ['the exist form', 'Four cron triggers exist in the account.'],
  // r47: the plan qualifier may not reach across a clause boundary.
  [
    'a claim followed by a generic sentence still fires',
    'There are four cron triggers. Every account has a dashboard.',
  ],
  [
    'a claim followed by a generic clause still fires',
    'There are four cron triggers in this account; every account has an owner.',
  ],
  // r48: commas and dashes bound a clause too.
  [
    'a claim followed by a comma clause still fires',
    'There are four cron triggers, while every account has a dashboard.',
  ],
  // r49: an unspaced em dash is the conventional typography, and the leading
  // scan must know the same sentence enders the trailing one does.
  [
    'a claim followed by an unspaced dash clause still fires',
    'There are four cron triggers\u2014every account has a dashboard.',
  ],
  [
    'an environment sentence ending in ! does not reach the next claim',
    'Local development uses no schedules! There are four cron triggers.',
  ],
  ['the verbal form, possessive subject', 'Our Cloudflare account uses 4 cron triggers today.'],
  // Codex #1978 r39: a purpose phrase opens exactly like an environment scope
  // and is not one. These are the cases the grammatical test could not tell
  // apart from "for local development", which is why the test is now lexical.
  [
    'a leading purpose phrase is not a scope',
    'For capacity planning, four cron triggers are running.',
  ],
  [
    'a leading discourse phrase is not a scope',
    'For clarity, the account has four live cron triggers.',
  ],
  // Codex #1978 r4: the verdict shape — a live conclusion carrying no number.
  [
    'a restated verdict on the capacity step',
    'Confirm a cron trigger is free. **This step currently fails**: an un-retired Worker holds the reserve.',
  ],
  [
    'a restated verdict in a wrapped comment',
    '// 3. Confirm a cron trigger is free —\n//    as things stand this step FAILS.',
  ],
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
  // Codex #1978 r21: the compound, hyphenated. The adjacency fix in r20 was
  // right and its noun phrase was too narrow — WRAP cannot cross a hyphen.
  ['hyphenated compound noun', 'The account is using 4 of 5 cron-trigger slots.'],
  // Codex #1978 r5: the shape nobody had written yet, and the most natural one.
  ['direct live count', 'The account currently has four live cron triggers.'],
  ['zero is a live-account state too', 'The account currently has zero live cron triggers.'],
  ['has N triggers', 'This account has 5 cron triggers today.'],
  // Codex #1978 r31: zero as a QUANTIFIER, not just as a word. Every matcher
  // required a number, so the natural phrasings for an empty account escaped.
  ['no triggers are live', 'No cron triggers are live.'],
  ['there are no active triggers', 'There are no active cron triggers.'],
  ['none of the triggers in use', 'None of the cron triggers are in use.'],
  // …and the compound qualifier my r30 collapse had dropped.
  ['compound qualifier, ratio', '4 of 5 account cron triggers are in use.'],
  ['compound qualifier, taken', 'four account cron triggers are taken.'],
  ['a claim wrapped onto a deeply indented line', '4 of 5\n' + ' '.repeat(38) + '// cron triggers'],
  ['the org holds N', '// the org holds three triggers today'],
  // Capacity verdicts — the claim with the number removed entirely. Self-found
  // after r5 rather than reported, by asking what a restatement looks like
  // once every numeric shape is covered.
  ['budget is full', '// The cron budget is full.'],
  ['at capacity', '// The account is at capacity for cron triggers.'],
  ['at capacity, subject first', '// The cron triggers are at capacity.'],
  ['no room for another', '// There is no room for another cron trigger.'],
  ['room for one more', '// The account has room for one more scheduled Worker; the cron cap allows it.'],
  ['can still take another', '// The account can still take one more scheduled Worker before the cron cap binds.'],
  // Codex #1978 r3: the synonym the patterns did not know, verbatim from
  // `packages/lib/src/cronCadence.ts` before the reword.
  [
    'no headroom — a count of zero in a synonym',
    ' * Cloudflare free plan caps cron triggers at FIVE per ACCOUNT, and\n' +
      ' * this account has no headroom to spend on a second one.',
  ],
  // Codex #1978 r2's counterexamples, promoted from MUST_NOT_FIRE. Negated in
  // the shape the old lookbehind exempted, and identical in meaning to the
  // fixture two lines above — which is what proved the exemption unsound.
  ['negated, but still a capacity claim', 'Cron capacity is not spare right now.'],
  ['never spare', 'Cron triggers are never spare in this account.'],
  ['the wording the exemption protected', "// the keeper's cron trigger is reserved rather than spare"],
];

/**
 * ── WHAT A FIXTURE ASSERTING *NO FINDING* MAY MEAN ────────────────────────
 *
 * Every entry below, and every `0` in the inventory / summary / stamp cases,
 * asserts an ABSENCE. Codex #1978 r4 found the trap in that:
 * `'bolded name skipped'` asserted zero problems on a row the parser could not
 * read, so it did not merely miss the gap — it encoded the gap as CORRECT, and
 * closing it failed the selftest and read as a regression. A fixture pinning a
 * limitation is worse than no fixture, because it recruits the test suite to
 * defend the defect.
 *
 *     A fixture may assert "no finding" ONLY where silence is the RIGHT
 *     answer — never where it is merely the CURRENT one.
 *
 * When you are tempted to pin what the checker happens to do today, you have
 * found a finding, not a fixture. Write the issue instead.
 *
 * Every entry here, and the zero-problem cases elsewhere, were re-read against
 * that rule after r4 and each asserts a right answer: the CAP is permitted by
 * design, the reservation policy and the conditional verdict are the shapes
 * this gate asks for, and "room to spare" / "2 spare bits" / bytecode and
 * wall-time headroom are other people's budgets.
 *
 * (An earlier revision of this paragraph opened "All fourteen entries here".
 * Two commits later there were seventeen. A restated count, gone stale inside
 * the comment explaining why not to restate counts — which is either the
 * funniest instance of this PR's defect or the most convincing one. The number
 * is gone rather than corrected; `runSelftest` prints the real counts, and it
 * cannot be wrong about them.)
 */
const MUST_NOT_FIRE = [
  // Codex #1978 r33: the scope test was a LOOKAHEAD, so it only saw text after
  // the claim. These three say nothing about the inventoried account, and this
  // gate blocks every PR in the repository.
  ['a leading environment scope', 'In local development, no cron triggers are live.'],
  ['a leading purpose scope', 'For local development, no cron triggers are live.'],
  // The r35 widening of the direct form must not reach a scoped sentence.
  ['the direct form scoped elsewhere', 'Four cron triggers are live in local development.'],
  ['the running form scoped elsewhere', 'Four cron triggers are running in local development.'],
  // Codex #1978 r39: the ADVERB form. `running locally` says the same thing as
  // `running in local development` and carried no preposition for the old
  // test to key on, so one was quiet and the other fired.
  ['the adverb form', 'Four cron triggers are running locally.'],
  ['the enabled form scoped elsewhere', 'Four cron triggers are enabled locally.'],
  ['the configured form scoped elsewhere', 'Four cron triggers are configured locally.'],
  ['the bare existential scoped elsewhere', 'There are four cron triggers in local development.'],
  // r46: the existential form of a CAP statement, which the gate must permit
  // — bound to the matched span, because two of the ten originals state the
  // cap and the occupancy in one sentence.
  ['the existential cap statement', 'There are five cron triggers per account.'],
  // r47: `slot` is a generic container; the count belongs to whatever the
  // sentence hands it.
  [
    'slots in another container',
    'The cron handler uses a database pool. All five slots in the connection pool are occupied.',
  ],
  [
    'slots in a semaphore',
    'The trigger queues work only after all five slots in the semaphore are available.',
  ],
  ['the existential plan entitlement', 'There are 250 cron triggers on Paid accounts.'],
  ['the postposed participle scoped elsewhere', 'There are four cron triggers running locally.'],
  ['the verbal form scoped elsewhere', 'The account runs four cron triggers locally.'],
  ['a leading temporal scope', 'When running locally, no cron triggers are live.'],
  // The CONDITIONAL is the correct way to write it, and is what
  // `apps/keeper/wrangler.jsonc` says today. If this ever starts firing, the
  // pattern has regressed into mood-guessing.
  [
    'a conditional, which is the correct wording',
    'Confirm a cron trigger is free. If this step fails, that is the likeliest reason.',
  ],
  ['a pipeline step failing near cron vocabulary', 'The cron handler retries when a step fails closed.'],
  ['each-step wording', 'Each step fails closed before the trigger fires.'],
  ['bare cap', '// the free plan caps cron triggers at FIVE per ACCOUNT'],
  ['cap, numeral', 'The Cloudflare Workers free plan caps an account at 5 cron triggers.'],
  ['cap plus error code', '// caps triggers at FIVE per ACCOUNT (API error 10072 on the sixth)'],
  // Codex #1978 r8: the CAP stated as an ENTITLEMENT. A bare `has|have|holds N
  // triggers` failed the gate on both, which is the rule fighting its own
  // remediation — the replacement sentence has to be able to say what the plan
  // permits.
  ['cap as entitlement, modal', 'Free accounts may have five cron triggers.'],
  ['cap as entitlement, allows-to', 'Cloudflare allows an account to have 5 cron triggers.'],
  ['unrelated N-of-5', ' * twice before it did: the first cut caught 3 of 5 known violation forms,'],
  // Codex #1978 r25: a spare SOMETHING ELSE, in a sentence about cron. Either
  // of these would have blocked every PR in the repository.
  ['a spare credential, near cron', 'The cron worker keeps a spare B2 credential for disaster recovery.'],
  // Codex #1978 r26: three more matchers relying on detached context.
  ['headroom under a CPU limit', 'The cron invocation has little headroom under the CPU limit.'],
  ['headroom in a memory budget', 'The cron job has no headroom in its memory budget.'],
  ['occupying bytes', 'The cron worker stores metadata whose fields occupy 3 bytes.'],
  ['occupying queue partitions', 'The cron Worker schedules jobs and already occupies 2 queue partitions.'],
  // The rest of the r26 sweep. These already passed; pinning them turns a
  // one-off audit into a standing one, which is the whole lesson of that
  // round — the unbound-matcher family was visible for three rounds and
  // nobody had enumerated it. A new matcher added later gets swept by these
  // whether or not its author thinks to try them.
  ['a ratio counting shards', 'The cron tick found 3 of 5 shards already in use.'],
  ['no room for a retry', 'This cron worker has no room for another retry attempt.'],
  ['at capacity for retention', 'Cron logs are at capacity for retention.'],
  // Codex #1978 r31: statements of the CAP, which this gate documents as
  // permitted — the authority itself has to make one.
  ['a plan entitlement, plural subject', 'Free accounts have five cron triggers.'],
  ['a plan entitlement, distributive subject', 'Each account has five cron triggers.'],
  // Codex #1978 r28: three more, and the sweep grows with them.
  ['leases taken by consumers', 'The cron handler requests five leases; four are taken by other consumers.'],
  ['a worker in a thread pool', 'The cron dispatcher has no room for another worker in its thread pool.'],
  ['a worker in a parser pool', 'This cron tick leaves room for one more worker in the parser pool.'],
  ['a spare key, near cron', 'The cron trigger rotates between the primary and spare encryption keys.'],
  // Codex #1978 r20: a cron IMPLEMENTATION note. The window contains "cron",
  // the ratio counts something else entirely, and firing here would have
  // blocked every PR in the repository.
  [
    'a ratio about something else, in a sentence about cron',
    'The cron handler processes four of five queue partitions on this tick.',
  ],
  [
    'a trigger-shaped ratio counting retries',
    'Each cron trigger retries three of five times before giving up.',
  ],
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
  // The three real sites a BARE `headroom` pattern fired on, each measuring
  // something that is not this account's trigger budget. Pinned because the
  // narrow pattern's whole job is to stay off them.
  ['headroom, wall-time', ' * 90 s per chain leaves headroom for ~3 multi-chain ticks within a 5-min cron envelope.'],
  // The r11 open-world change put 83 more tracked files in front of this rule,
  // and 17 of them use cron/trigger vocabulary in a DIFFERENT domain. None
  // produces a finding today; these two are pinned because they are the real
  // corpus text a future loosening would hit first, and a near-miss is worth
  // more as a fixture than a case nobody has written.
  [
    'UI triggers, not cron triggers',
    '.navbar-group-trigger { }\n/* Weight 700 is intentional — the dropdown triggers are two of the four */',
  ],
  [
    'a latency trigger in a migration comment',
    '-- The Alchemy webhook is a LATENCY trigger, not a correctness one; the\n-- cron backstop is what guarantees the five events arrive.',
  ],
  // `exhausted` bare was tried and dropped for this line: a DO-write budget,
  // inside the context window of the word `cron`, about something else.
  ['exhausted, a different budget', '    // Both budgets exhausted — defer the rest to the cron backstop.'],
  ['exhausted, a reward cap', 'Once the 69,000,000 VPFI category cap is exhausted, emissions stop.'],
  // Codex #1978 r6: OTHER bounded resources described beside cron prose. The
  // first cut of the capacity verdicts fired on all three, because CONTEXT can
  // say the paragraph is about cron and only the phrase can say the CLAIM is.
  ['another budget at capacity', 'When the ingestion queue is at capacity, the cron trigger retries on the next tick.'],
  ['room for a different write', 'The cron handler batches uploads while there is room for one more B2 write.'],
  ['another budget can take one', 'The D1 write budget can still take another row before the cron tick ends.'],
  [
    'headroom, retention beside a cron interval',
    ' * ticks that is ~112, so 130 (~32.5h) leaves headroom. RETUNE THIS if\n * you change the cron interval.',
  ],
  [
    'headroom, unquantified warning',
    '// Do not reopen the two-schedule design on the strength of apparent\n// headroom. Headroom here is temporary — the trigger is reserved.',
  ],
];

/**
 * ── ACCEPTED RESIDUALS: sentences that FIRE and arguably should not ───────
 *
 * Recorded rather than fixed, and recorded rather than left implicit. Both
 * use this project's reserved vocabulary for trigger capacity — "cron slots",
 * "cron budget" — to mean something else:
 *
 *   "Cron retries occupy 4 slots in the local queue buffer."
 *   "The cron budget is exhausted for this billing period."
 *
 * They are NOT in MUST_NOT_FIRE because they would fail; they are here so the
 * next person knows the state was chosen rather than missed.
 *
 * The reason for stopping: every attempt to separate these from real claims
 * has to distinguish two senses of the same noun in the same document, and
 * this file's record on that is bad. Tightening produced the r25 hyphen miss
 * (`cron-trigger slots` stopped matching) and, in one cycle, two opposite
 * `headroom` regressions. A gate that occasionally objects to a sentence
 * using "cron slots" for something else is cheap to satisfy — reword it, or
 * say "queue slots" — while a gate that has been tuned until it misses a real
 * restatement has failed at its only job.
 *
 * If a legitimate sentence in this tree ever trips one of these, that is the
 * signal to revisit. Until then this is a deliberate asymmetry, not an
 * oversight.
 */
const _ACCEPTED_RESIDUALS = [
  'Cron retries occupy 4 slots in the local queue buffer.',
  'The cron budget is exhausted for this billing period.',
  // Codex #1978 r29: the positional binding still reaches across a sentence
  // boundary — "The cron triggers call the allocator for leases. Four are
  // taken by other consumers." Separating it from the genuine "cron triggers.
  // Counting it as occupied, 4 are taken" needs to tell two senses of one
  // noun apart across a full stop, which is where this file's tightening has
  // repeatedly overshot. The DIRECT form ("Four cron triggers are taken") is
  // now matched adjacently, which was the half that mattered: a restatement
  // escaping the authority defeats the gate, while a false positive is a
  // nuisance an author fixes by rewording.
  'The cron triggers call the allocator for leases. Four are taken by other consumers.',
];
void _ACCEPTED_RESIDUALS;

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
    '| `vaipakam-agent` | `* * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['* * * * *'] },
    [],
    0,
  ],
  [
    'reserved row counts toward committed',
    '| `vaipakam-keeper` | *(none)* | `apps/keeper` | reserved — held for its return |',
    {},
    ['vaipakam-keeper'],
    0,
  ],
  [
    'undeployed is neither live nor reserved',
    '| `vaipakam-mesh-watcher` | *(would be `*/15 * * * *`)* | `ops/mesh-watcher` | undeployed — code-complete |',
    {},
    [],
    0,
  ],
  // Codex #1978 r35: a backticked span was counted as a trigger without ever
  // being asked whether it is a schedule. Only `--live` would have noticed,
  // and `--live` needs credentials CI does not have.
  // r44 follow-on: the extended forms are legal only where they mean
  // something, and only with in-range numbers. Both directions, because the
  // widening that admitted them is exactly where the range rule can lapse.
  [
    'last-day-of-month is legal in its own field',
    '| `vaipakam-agent` | `0 0 L * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 L * *'] },
    [],
    0,
  ],
  [
    'nearest-weekday is legal in day-of-month',
    '| `vaipakam-agent` | `0 0 15W * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 15W * *'] },
    [],
    0,
  ],
  [
    'nth-weekday is legal in day-of-week',
    '| `vaipakam-agent` | `0 0 * * 5#3` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 5#3'] },
    [],
    0,
  ],
  [
    'last-day in the MINUTE field is a finding',
    '| `vaipakam-agent` | `L 0 * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['L 0 * * *'] },
    [],
    1,
  ],
  [
    'a 32nd day-of-month is a finding even with W',
    '| `vaipakam-agent` | `0 0 32W * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 32W * *'] },
    [],
    1,
  ],
  [
    'an out-of-range weekday is a finding even with a hash',
    '| `vaipakam-agent` | `0 0 * * 8#1` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 8#1'] },
    [],
    1,
  ],
  [
    'there is no seventh same-weekday in a month',
    '| `vaipakam-agent` | `0 0 * * 5#7` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 5#7'] },
    [],
    1,
  ],
  [
    'nor a zeroth one',
    '| `vaipakam-agent` | `0 0 * * 5#0` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 5#0'] },
    [],
    1,
  ],
  [
    'a span that is not a cron expression is a finding',
    '| `vaipakam-agent` | `not a cron` | `apps/agent` | live |',
    { 'vaipakam-agent': ['not a cron'] },
    [],
    1,
  ],
  [
    'a four-field schedule is a finding',
    '| `vaipakam-agent` | `17 3 * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['17 3 * *'] },
    [],
    1,
  ],
  // r44: Cloudflare's EXTENDED syntax. Rejecting these made a legal account
  // state unrepresentable — the offline gate failed and `--live` could not
  // accept an inventory exactly matching the account.
  [
    'last-day-of-month is accepted',
    '| `vaipakam-mw` | `0 0 L * *` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 L * *'] },
    [],
    0,
  ],
  [
    'nth-weekday and nearest-weekday are accepted',
    '| `vaipakam-mw` | `0 0 15W * *` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 15W * *'] },
    [],
    0,
  ],
  [
    'month and weekday names are accepted',
    '| `vaipakam-mw` | `0 0 * JAN MON` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 * JAN MON'] },
    [],
    0,
  ],
  // r46: an extended form is a complete component, not a range endpoint or a
  // step base. Each fragment is legal alone; the composite cannot run.
  [
    'an extended form inside a range is a finding',
    '| `vaipakam-agent` | `0 0 15W-20 * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 15W-20 * *'] },
    [],
    1,
  ],
  [
    'an extended form as a step base is a finding',
    '| `vaipakam-agent` | `0 0 L/2 * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 L/2 * *'] },
    [],
    1,
  ],
  [
    'an nth-weekday inside a range is a finding',
    '| `vaipakam-agent` | `0 0 * * 5#2-6` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 5#2-6'] },
    [],
    1,
  ],
  // r47: the letters in NAMES are not extension characters. Rejecting these
  // was the fourth unrepresentable legal state, caused by the r46 fix for the
  // third.
  // r48: `*` and `?` are complete atoms, not range endpoints.
  // r49: Wrangler rejects a leading dash, and a reserved row has no
  // account-side witness to contradict it.
  [
    'a leading dash in a Worker name is a finding',
    '| `-future-worker` | *(none)* | `ops/future` | reserved — held |',
    {},
    [],
    1,
  ],
  // r50: `?` means "no specific value" and is meaningful only in the
  // day-of-month / day-of-week pair; it is also a complete atom, so it cannot
  // be a step base.
  [
    'a question mark outside its fields is a finding',
    '| `vaipakam-agent` | `? ? ? ? ?` | `apps/agent` | live |',
    { 'vaipakam-agent': ['? ? ? ? ?'] },
    [],
    1,
  ],
  [
    'a question mark as a step base is a finding',
    '| `vaipakam-agent` | `?/2 * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['?/2 * * * *'] },
    [],
    1,
  ],
  [
    'a question mark in day-of-week is accepted',
    '| `vaipakam-mw` | `0 0 1 * ?` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 1 * ?'] },
    [],
    0,
  ],
  [
    'a wildcard range endpoint is a finding',
    '| `vaipakam-agent` | `*-5 * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['*-5 * * * *'] },
    [],
    1,
  ],
  [
    'a named wildcard range endpoint is a finding',
    '| `vaipakam-agent` | `0 0 * JAN-* *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * JAN-* *'] },
    [],
    1,
  ],
  [
    'a named month range is accepted',
    '| `vaipakam-mw` | `0 0 * JUL-AUG *` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 * JUL-AUG *'] },
    [],
    0,
  ],
  [
    'a named weekday range is accepted',
    '| `vaipakam-mw` | `0 0 * * WED-FRI` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['0 0 * * WED-FRI'] },
    [],
    0,
  ],
  // r47: GFM renders a table indented up to three spaces, and the candidacy
  // check already allowed it; the row regex demanded column zero, so a
  // formatting-only edit made every row unparseable in both modes.
  [
    'a row indented two spaces parses',
    '  | `vaipakam-agent` | `* * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['* * * * *'] },
    [],
    0,
  ],
  [
    'step and list syntax is accepted',
    '| `vaipakam-mw` | `*/15 0,12 1-7 * *` | `ops/mesh-watcher` | live |',
    { 'vaipakam-mw': ['*/15 0,12 1-7 * *'] },
    [],
    0,
  ],
  // Codex #1978 r37: lexically perfect, unable to execute. Counted as a live
  // trigger until the ranges were checked.
  [
    'an out-of-range schedule is a finding',
    '| `vaipakam-agent` | `99 99 99 99 99` | `apps/agent` | live |',
    { 'vaipakam-agent': ['99 99 99 99 99'] },
    [],
    1,
  ],
  [
    'an inverted range is a finding',
    '| `vaipakam-agent` | `5-2 * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['5-2 * * * *'] },
    [],
    1,
  ],
  // Codex #1978 r40: GFM escapes a pipe only after an ODD backslash run, so
  // `\\|` is an escaped backslash followed by a real separator — five cells to
  // a reader, four to the old lookbehind.
  [
    'a double-escaped pipe renders a fifth cell',
    '| `vaipakam-agent` | `* * * * *` | `apps/agent` | live \\\\| reserved |',
    {},
    [],
    1,
  ],
  [
    'a single-escaped pipe stays content',
    '| `vaipakam-agent` | `* * * * *` | `apps/agent` | live \\| reserved |',
    { 'vaipakam-agent': ['* * * * *'] },
    [],
    0,
  ],
  // Codex #1978 r38: destructuring dropped the third component silently.
  [
    'a double step is a finding',
    '| `vaipakam-agent` | `*/2/3 * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['*/2/3 * * * *'] },
    [],
    1,
  ],
  [
    'a zero step never advances and is a finding',
    '| `vaipakam-agent` | `*/0 * * * *` | `apps/agent` | live |',
    { 'vaipakam-agent': ['*/0 * * * *'] },
    [],
    1,
  ],
  // The mirror, so tightening cannot quietly reject legal schedules: every
  // field at its upper bound, plus weekday 7 (Sunday, both spellings).
  [
    'boundary values are accepted',
    '| `vaipakam-agent` | `59 23 31 12 0` | `apps/agent` | live |',
    { 'vaipakam-agent': ['59 23 31 12 0'] },
    [],
    0,
  ],
  [
    'weekday seven is accepted',
    '| `vaipakam-agent` | `0 0 * * 7` | `apps/agent` | live |',
    { 'vaipakam-agent': ['0 0 * * 7'] },
    [],
    0,
  ],
  // Codex #1978 r3: substring-matching `reserved` got BOTH directions wrong.
  // A leading keyword cannot be negated by what follows it.
  [
    'a released row is not reserved',
    '| `vaipakam-r` | *(none)* | `ops/r` | undeployed — no longer reserved |',
    {},
    [],
    0,
  ],
  // r43: a hyphenated qualifier is not the status. `reserved-ish` renders as
  // equivocal and parsed as a definite reservation — the row with no
  // account-side witness.
  [
    'a hyphenated status qualifier is a finding',
    '| `vaipakam-q` | *(none)* | `ops/q` | reserved-ish |',
    {},
    [],
    1,
  ],
  // r43: underscores are legal in a Worker name; rejecting them left such a
  // Worker impossible to write down while `--live` called it ACCOUNT ONLY.
  [
    'an underscore in a Worker name parses',
    '| `valid_worker` | `* * * * *` | `ops/valid` | live |',
    { valid_worker: ['* * * * *'] },
    [],
    0,
  ],
  [
    'an unrecognised status is a finding, not a silent zero',
    '| `vaipakam-q` | *(none)* | `ops/q` | reservation held for its return |',
    {},
    [],
    1,
  ],
  [
    'a scheduled row must say live',
    '| `vaipakam-p` | `0 1 * * *` | `ops/p` | reserved — held |',
    { 'vaipakam-p': ['0 1 * * *'] },
    [],
    1,
  ],
  [
    'a live row must carry a schedule',
    '| `vaipakam-o` | *(none)* | `ops/o` | live |',
    {},
    [],
    1,
  ],
  // Codex #1978 r4: this fixture used to assert ZERO problems, which meant it
  // DOCUMENTED the hole rather than closing it — bolding the keeper's name
  // would have dropped its reservation from the parse, the summary could then
  // be edited to match, and `--live` could not object because a reserved Worker
  // has no account schedule to compare against. Every data row in the inventory
  // section must parse.
  [
    'a row that looks like data and does not parse is a finding',
    '| **`vaipakam-x`** | `0 1 * * *` | `ops/x` | live |',
    {},
    [],
    1,
  ],
  // Codex #1978 r2: TWO triggers in one cell. Counting Map entries made this
  // row worth one against a cap the account counts as two.
  [
    'two spans are two triggers',
    '| `vaipakam-y` | `* * * * *` `0 1 * * *` | `ops/y` | live |',
    { 'vaipakam-y': ['* * * * *', '0 1 * * *'] },
    [],
    0,
  ],
  // Codex #1978 r3: a comma is CRON SYNTAX. Splitting one span on commas made
  // this ordinary expression two nonsense fragments, overcounting the budget
  // and reporting a false SCHEDULE disagreement against a correct table.
  // Codex #1978 r14: backticks left around nothing are not a schedule.
  [
    // Codex #1978 r15 pinned that an emptied span is not counted as a trigger;
    // r25's span-free rule now also REPORTS it, because `` is not a canonical
    // no-schedule form and a reader cannot tell what it claims. Both hold: the
    // row still contributes no trigger, and it is now a finding rather than a
    // silent reclassification. Expectation updated deliberately, not relaxed.
    'an emptied schedule span is not a trigger, and is now also reported',
    '| `vaipakam-e` | `` | `ops/e` | reserved — parked |',
    {},
    [],
    1,
  ],
  [
    'a comma INSIDE one expression is one trigger',
    '| `vaipakam-w` | `0 1,13 * * *` | `ops/w` | live |',
    { 'vaipakam-w': ['0 1,13 * * *'] },
    [],
    0,
  ],
  // Codex #1978 r2: a stale row left beside its replacement. `Map.set` kept
  // only the last, so both halves accepted a table stating two contradictory
  // schedules for one Worker.
  // Codex #1978 r7: the row regex is case-insensitive; the duplicate set was
  // not, so a case variant read as a second Worker and a second reservation.
  [
    'a non-lower-case Worker name is a finding',
    '| `vaipakam-keeper` | *(none)* | `apps/keeper` | reserved — held |\n| `Vaipakam-Keeper` | *(none)* | `apps/keeper` | reserved — held |',
    {},
    ['vaipakam-keeper'],
    1,
  ],
  [
    'a repeated Worker is a finding, not an overwrite',
    '| `vaipakam-z` | `0 1 * * *` | `ops/z` | live |\n| `vaipakam-z` | `0 2 * * *` | `ops/z` | live |',
    { 'vaipakam-z': ['0 1 * * *'] },
    [],
    1,
  ],
  // Codex #1978 r5: a row that loses a column dropped its reservation in
  // silence, one branch before the malformed-row finding could see it.
  [
    'a row missing a column is a finding',
    '| `vaipakam-keeper` | *(none)* | `apps/keeper` |',
    {},
    [],
    1,
  ],
  // Codex #1978 r6: a FIFTH cell was accepted and then ignored, so the parser
  // read `undeployed` while the rendered table showed a reservation.
  [
    'a row with an extra column is a finding',
    '| `vaipakam-keeper` | *(none)* | `apps/keeper` | undeployed | reserved |',
    {},
    [],
    1,
  ],
  // Codex #1978 r8: the fifth row-shape variant. Markdown makes the leading
  // pipe optional and renders the row anyway, so skipping it dropped a
  // reservation a reader can plainly see.
  [
    'a row missing its leading pipe is a finding',
    '`vaipakam-keeper` | *(none)* | `apps/keeper` | reserved — held |',
    {},
    [],
    1,
  ],
  ['header row ignored', '| Worker | Schedule | Source in this repo | Status |', {}, [], 0],
  ['separator ignored', '|---|---|---|---|', {}, [], 0],
];

/** Stamp fixtures: `[name, markdown, expectedProblemCount]`. */
const STAMP_CASES = [
  // Codex #1978 r15: a four-backtick block is not closed by three, so this
  // stamp is still inside the fenced example and must not count as visible.
  [
    'a shorter fence does not close a longer one',
    '````\n```\n**Verified: 2026-08-27T16:21:53Z.**\n````',
    1,
  ],
  ['well-formed', '**Verified: 2026-08-27T16:21:53Z.** Re-verify with', 0],
  ['missing', 'Verified recently, honest.', 1],
  ['not a timestamp', '**Verified: yesterday.**', 1],
  // Codex #1978 r12: dropping the anchor in r11 (so a prefixed duplicate could
  // not hide) also accepted a stamp no reader can see. Counting broadly is
  // right for duplicates and wrong for existence.
  ['commented out — invisible to a reader', '<!-- **Verified: 2026-08-27T16:21:53Z.** -->', 1],
  ['only inside a code fence — an example, not the stamp', '```\n**Verified: 2026-08-27T16:21:53Z.**\n```', 1],
  // Codex #1978 r14: a `~~~` line does not close a ``` fence, so a boolean
  // toggle read everything after it as visible.
  ['a mismatched fence delimiter does not close the block', '```\n~~~\n**Verified: 2026-08-27T16:21:53Z.**\n```', 1],
  // The label is the marker, terminated or not.
  ['an unterminated second stamp still counts', '**Verified: 2026-08-27T16:21:53Z.**\n\n**Verified: yesterday', 1],
  ['the only stamp is unterminated', '**Verified: yesterday', 1],
  [
    'duplicated',
    '**Verified: 2026-08-27T16:21:53Z.**\n\n**Verified: 2026-01-01T00:00:00Z.**',
    1,
  ],
  // Codex #1978 r10: a second stamp behind an ordinary Markdown prefix. The r4
  // fix counted MARKERS rather than well-formed stamps precisely so a bad one
  // could not hide by being bad; anchoring that count at column zero let it
  // hide by being indented instead.
  [
    'a second stamp as a list item',
    '**Verified: 2026-08-27T16:21:53Z.**\n\n- **Verified: yesterday.**',
    1,
  ],
  [
    'a second stamp in a blockquote',
    '**Verified: 2026-08-27T16:21:53Z.**\n\n> **Verified: 2026-01-01T00:00:00Z.**',
    1,
  ],
  // Codex #1978 r4: counting only the stamps that PARSED meant a valid stamp
  // beside a malformed one reported success over two conflicting claims — the
  // bad one invisible precisely because it was bad.
  [
    'one valid, one malformed',
    '**Verified: 2026-08-27T16:21:53Z.**\n\n**Verified: yesterday.**',
    1,
  ],
  // Shape is not existence.
  ['shaped like an instant but impossible', '**Verified: 2026-99-99T99:99:99Z.**', 1],
  ['a day February does not have', '**Verified: 2026-02-30T00:00:00Z.**', 1],
  // Codex #1978 r15: real, well-formed, and impossible as a record of a READ.
  ['a real instant in the future', '**Verified: 2099-08-27T16:21:53Z.**', 1],
  // Codex #1978 r17: the multiline comment form. The single-line form has been
  // handled since r11 — this is its sibling, and the one an editor reaches for
  // when hiding a block.
  // Codex #1978 r19: a COMMENTED stamp is now caught by checkNoHtmlComments,
  // not here — the authority may not contain HTML comments at all, so this
  // check no longer needs to model them. Kept as a fixture pointing at where
  // the case moved, because deleting it would look like the case stopped
  // being covered.
  // Codex #1978 r19: a COMMENTED stamp is now checkNoHtmlComments' case, not
  // this one — the authority may not contain HTML comments at all, so this
  // check no longer models them and reads the stamp as present. Pinned at 0
  // deliberately, with COMMENT_CASES below covering where the case moved:
  // deleting the fixture would make it look like the case stopped mattering,
  // and leaving it at 1 would assert a defence this function no longer has.
  ['a commented stamp is the comment ban\'s case, not this one', '<!--\n**Verified: 2026-08-27T16:21:53Z.**\n-->', 0],
  // A comment that CLOSES leaves the rest of the document visible.
  [
    'a closed comment does not hide the stamp after it',
    '<!-- unrelated -->\n**Verified: 2026-08-27T16:21:53Z.**',
    0,
  ],
];

/**
 * {checkNoHtmlComments} fixtures: `[name, markdown, expectedProblems]`.
 *
 * This check replaced ~80 lines of HTML-comment tracking inside
 * {visibleLines}, which produced three false positives in three rounds. The
 * fixtures are correspondingly boring, which is the point.
 */
const COMMENT_CASES = [
  ['no comment', '# fine\n\n**Verified: 2026-08-27T16:21:53Z.**', 0],
  ['a multiline comment', '<!--\nhidden\n-->', 1],
  ['a single-line comment', '<!-- hidden -->', 1],
  ['a comment inside a fence is still a comment for this rule', '```\n<!-- x -->\n```', 1],
];

/** Source-cell fixtures: `[name, cell, expected readSource value]`. */
/**
 * {checkSources} fixtures: `[name, Map(name -> parsed cell), expectedProblems]`.
 *
 * SOURCE_CASES below exercises the cell PARSER; these exercise the resolution
 * that follows it, which is where a pathspec slips through — `apps/*` is a
 * perfectly well-formed backticked path and only fails once git is asked to
 * resolve it literally.
 */
/**
 * `wranglerNameFrom` fixtures — one per round this function has been through.
 */
const WRANGLER_NAME_CASES = [
  ['a plain top-level name', '{\n  "name": "vaipakam-agent"\n}\n', false, 'vaipakam-agent'],
  // r25: layout is not structure.
  ['four-space indentation', '{\n    "name": "vaipakam-agent"\n}\n', false, 'vaipakam-agent'],
  // r41: neither is the LINE. The whole config on one line, and a line whose
  // `name` is not the first property, both returned null while the scan was
  // line-based — an ordinary reformat switched off both source checks.
  ['the whole config on one line', '{"name":"vaipakam-agent"}\n', false, 'vaipakam-agent'],
  // r42: a Unicode escape is a valid spelling of an ASCII character, and
  // Wrangler deploys the DECODED name. Indexing the undecoded one let a
  // `*none*` source claim for the real Worker pass.
  [
    'a unicode escape in the name',
    '{"name":"vaipakam-\\u0061gent"}\n',
    false,
    'vaipakam-agent',
  ],
  ['an escaped quote in the name', '{"name":"vaipakam-\\"odd\\""}\n', false, 'vaipakam-"odd"'],
  // r43: Wrangler takes the LAST duplicate top-level key; returning on the
  // first indexed the config under a Worker it does not deploy.
  [
    'duplicate top-level names take the last',
    '{"name":"first-worker","name":"second-worker"}\n',
    false,
    'second-worker',
  ],
  // r43: the r42 escape fix reached only the JSON branch.
  ['a toml basic-string escape', 'name = "vaipakam-\\u0061gent"\n', true, 'vaipakam-agent'],
  // r46: TOML multiline strings are valid and Wrangler deploys them; the
  // single-line pattern read `"""x"""` as an empty value.
  ['a toml multiline basic string', 'name = """cron-check"""\n', true, 'cron-check'],
  ["a toml multiline literal string", "name = '''cron-check'''\n", true, 'cron-check'],
  // r47: broken across PHYSICAL LINES — the tenth way this function has
  // failed to read a valid config, and the reason the TOML head is now
  // matched as one block rather than line by line.
  // r48: TOML's line continuation — `\` strips the newline and the indent.
  [
    'a toml multiline name with a line continuation',
    'name = @@@vaipakam-\\\n  agent@@@\n'.replace(/@@@/g, '"'.repeat(3)),
    true,
    'vaipakam-agent',
  ],
  [
    'a toml multiline name across lines',
    'name = @@@\ncron-check@@@\n'.replace(/@@@/g, '"'.repeat(3)),
    true,
    'cron-check',
  ],
  // ...and NOT the literal-string form, which is raw by definition.
  ["a toml literal string is raw", "name = 'vaipakam-\\u0061gent'\n", true, 'vaipakam-\\u0061gent'],
  [
    'a property before name on the same line',
    '{ "main": "src/index.ts", "name": "vaipakam-keeper" }\n',
    false,
    'vaipakam-keeper',
  ],
  [
    'a nested name on the opening line does not win',
    '{ "vars": { "name": "inner" }, "name": "vaipakam-agent" }\n',
    false,
    'vaipakam-agent',
  ],
  [
    'a nested name does not win',
    '{\n  "ratelimit": {\n    "name": "inner"\n  },\n  "name": "vaipakam-agent"\n}\n',
    false,
    'vaipakam-agent',
  ],
  // r27: a route glob in a line comment must not open a block comment that a
  // later cron expression closes.
  [
    'a route glob in a line comment',
    '{\n  // Example route: watcher.vaipakam.com/*\n  "triggers": { "crons": ["*/15 * * * *"] },\n  "name": "vaipakam-agent"\n}\n',
    false,
    'vaipakam-agent',
  ],
  // r40: an escaped quote followed by an unbalanced brace. The brace was
  // counted as structure, depth never returned to 1, and the null return
  // silently disabled BOTH source checks for that config.
  [
    'an escaped quote before a brace',
    String.raw`{
  "vars": { "note": "a quote \" then a brace {" },
  "name": "vaipakam-agent"
}
`,
    false,
    'vaipakam-agent',
  ],
  // r38/r39: TOML has no braces around top-level keys.
  ['a TOML top-level name', 'name = "vaipakam-agent"\n', true, 'vaipakam-agent'],
  [
    'a TOML comment containing braces',
    '# template syntax: {{\nname = "vaipakam-agent"\n',
    true,
    'vaipakam-agent',
  ],
  [
    'a TOML name below a table header is not top level',
    '[env.production]\nname = "vaipakam-agent"\n',
    true,
    null,
  ],
];

const CHECK_SOURCES_CASES = [
  ['a real tracked path resolves', new Map([['vaipakam-keeper', 'apps/keeper']]), 0],
  ['the none marker is accepted for a Worker with no source', new Map([['vaipakam-offchain-data-archive', null]]), 0],
  // Codex #1978 r20: *none* is a CLAIM about the tree, and it is the exact
  // claim that hid the archive Worker for three weeks. A maintained Worker
  // marked account-only must fail.
  ['*none* is rejected when the tree declares that Worker', new Map([['vaipakam-agent', null]]), 1],
  // Codex #1978 r15: a glob keeps resolving after the real source moves, so it
  // can never go stale — worse than a wrong path, for this column's purpose.
  ['a glob is rejected', new Map([['vaipakam-a', 'apps/*']]), 1],
  ['explicit pathspec magic is rejected', new Map([['vaipakam-a', ':(glob)apps/**']]), 1],
  ['a parent-directory escape is rejected', new Map([['vaipakam-a', '../etc']]), 1],
  ['a vanished literal path is still reported', new Map([['vaipakam-a', 'apps/gone-away']]), 1],
  // Codex #1978 r17: an ANCESTOR resolves to hundreds of tracked files and so
  // can never go stale — the glob defect reached without a glob.
  ['a bare ancestor directory is rejected', new Map([['vaipakam-a', 'apps']]), 1],
  ['another ancestor is rejected', new Map([['vaipakam-a', 'ops']]), 1],
  ['a real Worker source is accepted', new Map([['vaipakam-agent', 'apps/agent']]), 0],
  // Codex #1978 r18: the row must point at ITS OWN Worker's directory. Both
  // of these resolve and both hold a wrangler config; only one is correct.
  ['a source cell pointing at another Worker is rejected', new Map([['vaipakam-agent', 'apps/indexer']]), 1],
  ['the matching source is accepted', new Map([['vaipakam-indexer', 'apps/indexer']]), 0],
  // Self-review after r18: `apps/agent/wrangler.jsonc` has ELEVEN "name"
  // fields — one top-level, ten nested binding names. This pins that the
  // top-level one is what is read, so reordering the config cannot make the
  // check compare a rate-limit binding's name against the row.
  ['a config with many nested name fields reads the top-level one', new Map([['vaipakam-agent', 'apps/agent']]), 0],
];

const SOURCE_CASES = [
  ['a backticked path', ' `apps/agent` ', 'apps/agent'],
  ['the explicit none marker', ' *none* ', null],
  ['bold none', ' **none** ', null],
  ['prose is neither', ' probably somewhere ', undefined],
  ['empty is neither', '  ', undefined],
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
  // Codex #1978 r15: the label naming a holder the table does not reserve.
  // Substring matching passed this because the string contains "keeper".
  [
    'the label names an unreserved Worker as a holder',
    GOOD_SUMMARY.replace(
      "live plus the keeper's reserve",
      "live plus the keeper and mesh-watcher's reserve",
    ),
    4,
    1,
    1,
  ],
  // Codex #1978 r15: an unterminated SECOND claim, reader-visible, invisible
  // to a duplicate check that counted only well-formed labels.
  [
    'a second Live line with its closing markup dropped',
    `${GOOD_SUMMARY}\n\n**Live right now: three of five`,
    4,
    1,
    1,
  ],
  [
    'a second Committed line with its closing markup dropped',
    `${GOOD_SUMMARY}\n\n**Committed, live only: 3 of 5`,
    4,
    1,
    1,
  ],
  [
    'a second Genuinely spare line with its closing markup dropped',
    `${GOOD_SUMMARY}\n\n**Genuinely spare: 2`,
    4,
    1,
    1,
  ],
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
    // THREE problems, and all three are real and distinct: committed no longer
    // follows from the inventory; the label names `vaipakam-keeper` as a holder
    // the table does not reserve (r15's owner-identity check); and the label
    // claims a reserve when no row is marked reserved at all (r12's reverse
    // direction, which this fixture reached first by accident).
    //
    // The last two overlap on this input without being redundant — r12's fires
    // for an UNNAMED reserve ("live plus a reserve"), which r15's cannot see,
    // and r15's names the specific Worker, which is what an editor needs to fix
    // it. Collapsing them would lose one case each way.
    3,
  ],
  ['a line is missing', '- **Live right now:** 4 of 5', 4, 1, 2],
  ['a line was reworded', GOOD_SUMMARY.replace('Genuinely spare', 'Spare'), 4, 1, 1],
  // Codex #1978 r7: `Committed[^:]*` accepted a label that CONTRADICTED the
  // derivation — "live only", for a value computed as live plus reserved.
  [
    // r7 caught this via the canonical regex. Since r13 made "live only" a
    // second CANONICAL label — the runbook's post-arm state needs one — the
    // rejection now comes from the two identity checks instead, and reports
    // BOTH true things: the label says live-only while a row is reserved, and
    // the reserved Worker is not named. Same finding, better message, and r7's
    // protection is intact by a different route.
    'the committed label contradicts its derivation',
    GOOD_SUMMARY.replace("Committed, live plus the keeper's reserve", 'Committed, live only'),
    4,
    1,
    2,
  ],
  // The post-arm state the runbook's step 6 produces. Codex #1978 r13: with
  // only the reserve label canonical, this document could not exist.
  [
    'no reservation, live-only label — the state after a re-arm',
    [
      '- **Live right now:** 5 of 5',
      '- **Committed, live only:** 5 of 5',
      '- **Genuinely spare:** 0',
    ].join('\n'),
    5,
    0,
    0,
  ],
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
  for (const [name, map, expected] of CHECK_SOURCES_CASES) {
    const got = checkSources(map).length;
    if (got !== expected) {
      console.error(`selftest: checkSources case "${name}" reported ${got} problem(s), expected ${expected}`);
      bad++;
    }
  }
  for (const [name, raw, isToml, expected] of WRANGLER_NAME_CASES) {
    const got = wranglerNameFrom(raw, isToml);
    if (got !== expected) {
      console.error(
        `selftest: wrangler-name case "${name}" read ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      );
      // Codex #1978 r48: this said `problems`, which does not exist here —
      // so the FIRST wrangler-name regression threw a ReferenceError before
      // any later fixture ran or the summary printed. The suite still failed,
      // but it lost exactly the aggregated diagnostics a parser regression
      // needs. Every sibling loop increments `bad`.
      bad += 1;
    }
  }
  for (const [name, cell, expected] of SOURCE_CASES) {
    const got = readSource(cell);
    if (got !== expected) {
      console.error(
        `selftest: source case "${name}" read ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      );
      bad++;
    }
  }
  for (const [name, md, expected] of STAMP_CASES) {
    const got = checkStamp(md).length;
    if (got !== expected) {
      console.error(`selftest: stamp case "${name}" reported ${got} problem(s), expected ${expected}`);
      bad++;
    }
  }
  // ── CATASTROPHIC BACKTRACKING GUARD ──────────────────────────────────
  //
  // Codex #1978 r27 (self-found): every matcher runs against pathological
  // input and must finish fast. Two rounds of binding matchers to their nouns
  // introduced `(?:\w+<whitespace-star>){0,N}?` in FOUR patterns — a nested
  // quantifier, and the classic ReDoS shape. A 5,000-character run with no
  // spaces hung the scan; this gate reads 127 MB across the tree on every PR,
  // and long unbroken runs are ordinary content. It would not have failed
  // loudly — it would have hung the blocking step.
  //
  // I caught it because a verification command timed out, not because I was
  // looking. So the check is now standing: the shape is easy to reintroduce
  // (both fixes that caused it were correct about matching) and impossible to
  // notice in a selftest of short strings.
  //
  // WHAT THIS ACTUALLY DOES, stated precisely because the obvious reading is
  // wrong. Catastrophic backtracking does not return slowly — it does not
  // return. So this does NOT fail with the message below; the selftest HANGS
  // here and CI kills it. Verified by reintroducing the nested quantifier:
  // the run was terminated at 45 s, never reaching the comparison.
  //
  // That is still the point. It converts a silent hang of the blocking SCAN,
  // during a normal PR, into a visible hang of the SELFTEST, in the step
  // whose job is to fail — and the elapsed-time branch does catch the merely
  // slow case, which a healthy matcher clears in single-digit milliseconds. A
  // guard that reliably localises the fault is worth having even when it
  // cannot pretty-print it.
  {
    // TWO shapes, because the r27 guard only had one and missed the r29
    // regression entirely: a long run with NO whitespace (catastrophic
    // backtracking inside a token repeat) and a long run OF whitespace
    // (quadratic partitioning between two separator quantifiers). The second
    // is what Codex measured at ~19 s, on a matcher added the round after the
    // guard was written — a guard testing one pathological input is a guard
    // for one bug.
    // THREE shapes now. Codex #1978 r32's compound-noun consolidation admits
    // `-` into the qualifier separator so `cron-triggers` reads as one noun,
    // which makes a long hyphen run a separator run — a class the two existing
    // shapes do not produce. Adding the input costs nothing and the omission
    // is exactly how the r29 regression got past the r27 guard.
    const pathological =
      'cron triggers spare headroom occupy ' +
      'x'.repeat(50_000) +
      ' trigger context 4 cron' +
      ' '.repeat(50_000) +
      ' 4 of 5 account' +
      '-'.repeat(50_000) +
      'zzz';
    const started = Date.now();
    findOccupancyClaims(pathological);
    const ms = Date.now() - started;
    if (ms > 2_000) {
      console.error(
        `selftest: matching 50k characters took ${ms} ms — a matcher is ` +
          `backtracking catastrophically. Look for a nested quantifier: ` +
          `a token repeat wrapping a whitespace repeat.`,
      );
      bad++;
    }
  }

  for (const [name, md, expected] of COMMENT_CASES) {
    const got = checkNoHtmlComments(md).length;
    if (got !== expected) {
      console.error(`selftest: comment case "${name}" reported ${got} problem(s), expected ${expected}`);
      bad++;
    }
  }
  for (const [name, md, liveTriggers, reservedRows, expected] of SUMMARY_CASES) {
    // Fixtures carry a COUNT; the checker takes names. Synthesise keeper-shaped
    // names so the identity check is satisfied by the canonical label and the
    // fixtures keep testing what they were written to test.
    const names = Array.from({ length: reservedRows }, () => 'vaipakam-keeper');
    // The UNIVERSE the label is read against is every Worker in the table, not
    // just the reserved ones — that is what makes "names a Worker that holds
    // no reservation" detectable at all (Codex #1978 r15).
    const universe = ['vaipakam-keeper', 'vaipakam-mesh-watcher', 'vaipakam-agent'];
    const got = checkSummary(md, liveTriggers, names, universe).length;
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
      `${INVENTORY_CASES.length} inventory rows, ${SUMMARY_CASES.length} summaries, ` +
      `${STAMP_CASES.length} stamps, ${COMMENT_CASES.length} comment rules, ${SOURCE_CASES.length} sources, ${WRANGLER_NAME_CASES.length} wrangler names, ` +
      `${CHECK_SOURCES_CASES.length} source resolutions).`,
  );
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────────────

// Codex #1978 r10: an UNKNOWN argument is an error, never a fallback to the
// offline scan. `--lve` used to print "Cron-slot gate OK" and exit 0 without
// contacting Cloudflare at all — and the flow that command was added to is the
// keeper re-enable procedure, whose step 3 is "confirm a cron trigger is free".
// A typo there returns the reassuring line, the operator deploys, and the
// account rejects the sixth trigger with 10072. Answering a question that was
// not asked, in the affirmative, is the worst thing a check can do.
const MODES = new Set(['--live', '--selftest']);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !MODES.has(a));
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    console.error('Usage: check-cron-slots.mjs [--live | --selftest]');
    console.error('');
    console.error('No argument runs the OFFLINE scan. It is not a fallback for a');
    console.error('mistyped flag: an offline pass says nothing about the account,');
    console.error('and reading it as "a trigger is free" is how a deploy meets 10072.');
    process.exit(2);
  }
  if (args.includes('--live') && args.includes('--selftest')) {
    console.error('--live and --selftest are separate modes; run one at a time.');
    process.exit(2);
  }
  let code;
  if (args.includes('--live')) code = await runLive();
  else if (args.includes('--selftest')) code = runSelftest();
  else code = runOffline();
  process.exit(code);
}
