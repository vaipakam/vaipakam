// #2439 post-merge live review — the sanctions banner on a wallet flagged
// by this test network's own test list (TestnetSanctionsOverlay).
//
// This drive only OBSERVES. Flagging and clearing are the operator's
// on-chain writes (`setFlagged` on the overlay, owner-only), done outside
// it, so the drive never holds the admin key. It reads the chain itself
// first and exits BLOCKED when the chain is not in the state the mode
// expects, so a skipped write is never reported as a banner defect.
//
// Modes (EXPECT):
//   flagged            — the wallet is flagged on the test list: the banner
//                        shows, with the test-list contact line.
//   clear              — nothing flags the wallet: no banner.
//   flagged-then-clear — starts as `flagged`, then waits (without reloading
//                        the page) for the operator to clear the flag, and
//                        requires the banner to leave on its own within two
//                        refresh cycles.
//
//   SITE_URL=https://<deployment> EXPECT=flagged-then-clear \
//     SANCTIONS_ROLE=newBorrower node live-sanctions-banner.mjs
//
// Every banner verdict is judged against what the PAGE was told, through
// one rule (`check` below): the page's own flag reads of this wallet,
// started inside the window and decoded (`pageSanctionsReads.mjs`). The
// page never asking is FAIL; asking and getting no answer, or an answer
// that contradicts the chain, is BLOCKED (its RPC, not the banner); an
// answer that matches the chain leaves the banner to decide. The banner's
// EXPLANATION is judged by its own words: a recourse line in which the app
// says it could not read why is BLOCKED. A request the read-only session
// refused is a FAIL and outranks every BLOCKED.
//
// Not keyless yet: it launches through the signing harness, so it needs the
// role's key in the wallet file although it never signs (#2447).
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, zeroAddress } from 'viem';
import {
  addressOf,
  blocked,
  blockedSync,
  clientsFor,
  ensureConnected,
  launch,
  requireSiteUrl,
  requireSigningRole,
  visit,
} from './driver.mjs';
import { attachLedger, createReadLedger, watchedRead } from './pageSanctionsReads.mjs';
import { withVisibility } from './visibility.mjs';

requireSiteUrl();

const MODES = ['flagged', 'clear', 'flagged-then-clear'];
const EXPECT = process.env.EXPECT ?? '';
if (!MODES.includes(EXPECT)) {
  blockedSync(`EXPECT must be one of ${MODES.join(', ')} (got ${JSON.stringify(EXPECT)})`);
}
const ROLE = process.env.SANCTIONS_ROLE ?? 'newBorrower';
// The wallet file is the only source of the address; no key is used to
// sign (the launch below is read-only).
requireSigningRole(ROLE);
const WALLET = addressOf(ROLE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 84532;

/** The app refreshes the check every 30s; two cycles plus page settle. */
const BANNER_WINDOW_MS = 75_000;
/** How long `flagged-then-clear` waits for the operator's clearing write. */
const CLEAR_WAIT_MS = 15 * 60_000;

function readJson(rel) {
  const file = path.join(HERE, rel);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return blockedSync(`cannot read ${file}\n  ${err.message}`);
  }
}

const deployment = readJson('../../../../packages/contracts/src/deployments.json')[String(CHAIN_ID)];
const DIAMOND = deployment?.diamond;
const OVERLAY = deployment?.sanctionsTestnetOverlay;
for (const [name, v] of [['diamond', DIAMOND], ['sanctionsTestnetOverlay', OVERLAY]]) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    blockedSync(`the deployments bundle's ${CHAIN_ID}.${name} is not an address: ${JSON.stringify(v)}`);
  }
}

// The copy the banner renders, from the shipped English catalogue, so a
// copy change cannot leave this drive matching text the app no longer has.
const en = readJson('../../src/i18n/locales/en.json');
const TITLE = en?.copy?.sanctions?.title;
const TEST_LIST_LINE = en?.copy?.sanctions?.recourseTestList;
if (typeof TITLE !== 'string' || typeof TEST_LIST_LINE !== 'string') {
  blockedSync('en.json no longer carries copy.sanctions.title / recourseTestList');
}
// The recourse lines in which the APP says it could not read part of the
// explanation (`recourseUnknown` and every `…Unread` line). When the banner
// carries one, the page itself is reporting a failed read, so the run is
// BLOCKED on the page's own words rather than on a guess about its RPC.
const UNREAD_LINES = Object.entries(en.copy.sanctions)
  .filter(([k, v]) => k.startsWith('recourse') && (k === 'recourseUnknown' || k.endsWith('Unread')) && typeof v === 'string')
  .map(([, v]) => v);
if (UNREAD_LINES.length === 0) {
  blockedSync('en.json no longer carries the unread recourse lines (recourseUnknown / …Unread)');
}

/** What the banner's recourse says, in the app's own copy:
 *  `unread` — the page says it could not read part of why;
 *  `expected` — exactly the test-list line, which is this wallet's case
 *  (flagged on the test list, no flagged recovery sender — preflighted);
 *  `wrong` — any other explanation. */
function recourseOf(text) {
  if (UNREAD_LINES.some((l) => text.includes(l))) return 'unread';
  return text.includes(TEST_LIST_LINE) ? 'expected' : 'wrong';
}

const ABI = parseAbi([
  'function getSanctionsOracle() view returns (address)',
  'function isSanctionedAddress(address) view returns (bool)',
  'function flaggedByOverlay(address) view returns (bool)',
  'function vaultBannedSource(address) view returns (address)',
  'function isSanctioned(address) view returns (bool)',
]);

const { pub } = clientsFor(CHAIN_ID);

/** What the chain says right now about the wallet. */
async function chainState() {
  const [oracle, flagged, onTestList] = await Promise.all([
    pub.readContract({ address: DIAMOND, abi: ABI, functionName: 'getSanctionsOracle' }),
    pub.readContract({ address: DIAMOND, abi: ABI, functionName: 'isSanctionedAddress', args: [WALLET] }),
    pub.readContract({ address: OVERLAY, abi: ABI, functionName: 'flaggedByOverlay', args: [WALLET] }),
  ]);
  return { oracle, flagged, onTestList };
}

/** Whether the wallet has a SECOND active cause: a recovery sender it
 *  declared that is itself flagged. Clearing the wallet's own test-list
 *  entry would not lift that one, so the clear step could never pass. */
async function flaggedSender() {
  const source = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'vaultBannedSource',
    args: [WALLET],
  });
  if (source === zeroAddress) return null;
  // The configured list's own answer for the sender — the cause the Diamond
  // folds into the wallet's flag. Not the Diamond's composite view, which
  // would also count the sender's own recovery sender, a cause that does
  // not reach this wallet.
  const flagged = await pub.readContract({
    address: OVERLAY,
    abi: ABI,
    functionName: 'isSanctioned',
    args: [source],
  });
  return flagged ? source : null;
}

let state;
let sender;
try {
  state = await chainState();
  sender = await flaggedSender();
} catch (err) {
  await blocked('could not read the sanctions state from the chain', err);
}
console.log(
  `chain: oracle=${state.oracle} flagged=${state.flagged} onTestList=${state.onTestList} wallet=${WALLET} (${ROLE})`,
);
if (state.oracle.toLowerCase() !== OVERLAY.toLowerCase()) {
  await blocked(`the Diamond does not screen against the recorded test list (${OVERLAY})`);
}
if (sender !== null) {
  await blocked(
    `the wallet's declared recovery sender ${sender} is flagged, which flags the wallet ` +
      'whatever the test list says — pick another SANCTIONS_ROLE, or clear that sender first',
  );
}
const wantFlagged = EXPECT !== 'clear';
if (state.flagged !== wantFlagged || state.onTestList !== wantFlagged) {
  await blocked(
    wantFlagged
      ? `the wallet is not flagged on the test list yet — run setFlagged(${WALLET}, true) on ${OVERLAY} first`
      : `the wallet is still flagged — run setFlagged(${WALLET}, false) on ${OVERLAY} first`,
  );
}

const { page, ctx, done, blockedRequests } = await launch({ role: ROLE, readOnly: true, freshProfile: true });
// English before the first paint: the expected lines come from the English
// catalogue, and a fresh profile would otherwise follow the machine's
// locale (the shared i18n factory's key, as live-refinance.mjs seeds it).
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vaipakam:language', 'en');
  } catch {
    /* storage blocked — the banner match then fails visibly */
  }
});

// The page's own flag read — what shows or hides the banner. The
// EXPLANATION needs no wire tracking: the banner states in its own words
// when it could not read why (see `recourseOf`).
const ledger = createReadLedger({
  flag: watchedRead('isSanctionedAddress(address)', DIAMOND, WALLET),
});
attachLedger(page, ledger);

/** A request the read-only session refused outranks every other outcome:
 *  print it and FAIL, before any BLOCKED can hide it. */
async function failIfRefused() {
  if (blockedRequests.length === 0) return;
  console.log(`FAIL read-only: the page attempted ${blockedRequests.length} refused request(s)`);
  for (const b of blockedRequests) console.log(`  ${b.reason} — ${b.url}`);
  await done();
  process.exit(1);
}

/** Every BLOCKED exit after launch goes through here. */
async function stopBlocked(reason) {
  await failIfRefused();
  await done();
  await blocked(reason);
}

const loadedAt = Date.now();
await visit(page, '/');
await ensureConnected(page);

/** The VISIBLE text of the sanctions banner, or null when none is shown.
 *  Visibility uses the shared predicate, so an alert that is mounted but
 *  hidden counts as not shown. */
async function bannerText() {
  return page.evaluate(
    withVisibility((V, title) => {
      for (const el of document.querySelectorAll('[role="alert"].banner-danger')) {
        if (!V.visible(el)) continue;
        const text = V.visibleTextOf(el);
        if (text.includes(title)) return text;
      }
      return null;
    }),
    TITLE,
  );
}

/** Polls until `want(text|null)` holds or the window ends. Returns the last
 *  text and the first banner seen at any poll, so a banner that flashes and
 *  goes is not lost. */
async function waitForBanner(want, windowMs) {
  const deadline = Date.now() + windowMs;
  let text = null;
  let seen = null;
  let seenAt = null;
  for (;;) {
    text = await bannerText();
    if (seen === null && text !== null) {
      seen = text;
      seenAt = Date.now();
    }
    if (want(text) || Date.now() > deadline) return { text, seen, seenAt };
    await page.waitForTimeout(2_000);
  }
}

let failures = 0;

/**
 * One banner check, through one rule. `expected` is the flag the chain
 * holds; the page's own flag reads STARTED at or after `since` (and, with
 * `until`, ANSWERED by then — what the page knew when the banner was
 * seen) are judged first:
 *   - never sent            → FAIL: the app did not ask;
 *   - sent, never answered  → BLOCKED: its RPC, not the banner;
 *   - answered the opposite → BLOCKED: a stale provider, not the banner;
 *   - answered `expected`   → `outcome` decides: 'pass', 'fail', or
 *                             'unread' (the banner's own words say it could
 *                             not read why — BLOCKED).
 */
async function check(label, expected, since, until, outcome, banner) {
  const j = ledger.judge('flag', since, expected, until);
  const show = () => {
    if (banner !== undefined) console.log(`  banner: ${banner === null ? '(none)' : JSON.stringify(banner)}`);
  };
  if (j.state === 'none') {
    console.log(`FAIL ${label}: the page never sent its sanctions read of this wallet in this window`);
    show();
    failures++;
    return;
  }
  if (j.state === 'unanswered') {
    await stopBlocked(
      `${label}: the page sent its sanctions read of this wallet ${j.attempts} time(s) in this window and got ` +
        'no answer — its RPC is the cause, not the banner',
    );
  }
  if (j.state === 'disagrees') {
    await stopBlocked(
      `${label}: the page's RPC answered ${j.value} where the chain holds ${expected} — a stale provider, ` +
        'not the banner',
    );
  }
  if (outcome === 'unread') {
    show();
    await stopBlocked(`${label}: the banner says the page could not read why the wallet is flagged`);
  }
  console.log(`${outcome === 'pass' ? 'PASS' : 'FAIL'} ${label}`);
  show();
  if (outcome !== 'pass') failures++;
}

if (wantFlagged) {
  // Wait for the expected line or the deadline; an `unread` or `wrong`
  // explanation can still be replaced by the next refresh.
  const { text } = await waitForBanner((t) => t !== null && recourseOf(t) === 'expected', BANNER_WINDOW_MS);
  const recourse = text === null ? null : recourseOf(text);
  await check(
    'flagged: banner with the test-list contact line',
    true,
    loadedAt,
    Infinity,
    recourse === null ? 'fail' : recourse === 'expected' ? 'pass' : recourse === 'unread' ? 'unread' : 'fail',
    text,
  );
} else {
  const { seen, seenAt } = await waitForBanner(() => false, BANNER_WINDOW_MS);
  // A banner seen at any point is judged against what the page knew THEN.
  await check(
    `clear: no sanctions banner at any point across ${BANNER_WINDOW_MS / 1000}s`,
    false,
    loadedAt,
    seenAt ?? Infinity,
    seen === null ? 'pass' : 'fail',
    seen,
  );
}

if (EXPECT === 'flagged-then-clear' && failures === 0) {
  console.log(`waiting for setFlagged(${WALLET}, false) on ${OVERLAY} — do not reload the page`);
  const deadline = Date.now() + CLEAR_WAIT_MS;
  let clearedAt = null;
  let last = null; // the last chain state actually read, and when
  let readErrors = 0;
  while (Date.now() < deadline) {
    try {
      const s = await chainState();
      last = { at: new Date().toISOString(), ...s };
      if (s.oracle.toLowerCase() !== OVERLAY.toLowerCase()) {
        await stopBlocked(`the Diamond stopped screening against the test list (${OVERLAY}) during the wait; now ${s.oracle}`);
      }
      // Cleared means the operator's write landed AND nothing else flags
      // the wallet — the state the banner is expected to follow.
      if (!s.onTestList && !s.flagged) {
        clearedAt = Date.now();
        break;
      }
    } catch {
      readErrors++;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (clearedAt === null) {
    await stopBlocked(
      last === null
        ? `could not read the chain at all during the ${CLEAR_WAIT_MS / 60_000}-minute wait (${readErrors} failed reads), so whether the flag was cleared is unknown`
        : `the wallet was still flagged at the last successful read (${last.at}: onTestList=${last.onTestList}, ` +
            `flagged=${last.flagged}; ${readErrors} failed reads during the wait)`,
    );
  }
  // Done only when the banner is gone AND the page has read the cleared
  // flag — a read the page made just before `clearedAt` does not count, so
  // keep polling for the next refresh rather than judging too early.
  const { text } = await waitForBanner(
    (t) => t === null && ledger.judge('flag', clearedAt, false).state === 'agrees',
    BANNER_WINDOW_MS,
  );
  const secs = Math.round((Date.now() - clearedAt) / 1000);
  await check(
    `cleared without reload: banner ${text === null ? `gone, page read the clear within ${secs}s` : 'still shown'}`,
    false,
    clearedAt,
    Infinity,
    text === null ? 'pass' : 'fail',
    text,
  );
}

await failIfRefused();
await done();
process.exit(failures === 0 ? 0 : 1);
