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
// A banner verdict is only drawn from an answer the PAGE got: the app fails
// open (no banner) when its own sanctions read errors, so a missing banner
// with no answered sanctions read on the page's RPC is BLOCKED, not FAIL.
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, toFunctionSelector, zeroAddress } from 'viem';
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

const ABI = parseAbi([
  'function getSanctionsOracle() view returns (address)',
  'function isSanctionedAddress(address) view returns (bool)',
  'function flaggedByOverlay(address) view returns (bool)',
  'function vaultBannedSource(address) view returns (address)',
]);
/** The Diamond's sanctions read, as hex in a request body (plain or inside
 *  a multicall), without the 0x — how the page's own reads are recognised. */
const SANCTIONS_SELECTOR = toFunctionSelector('isSanctionedAddress(address)').slice(2).toLowerCase();
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
  const flagged = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'isSanctionedAddress',
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

const { page, ctx, done } = await launch({ role: ROLE, readOnly: true, freshProfile: true });
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

// The page's own sanctions reads: the time of the last one that came back
// with a JSON-RPC result and no error. A transport failure, an HTTP error
// or an RPC error leaves it unset.
let lastPageAnswer = null;
page.on('response', (res) => {
  const req = res.request();
  if (req.method() !== 'POST') return;
  const body = (req.postData() ?? '').toLowerCase();
  if (!body.includes(SANCTIONS_SELECTOR) || res.status() !== 200) return;
  res
    .text()
    .then((text) => {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (items.length > 0 && items.every((r) => r && r.result !== undefined && r.error === undefined)) {
        lastPageAnswer = Date.now();
      }
    })
    .catch(() => {
      /* unreadable body: not an answer */
    });
});

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
  for (;;) {
    text = await bannerText();
    if (seen === null && text !== null) seen = text;
    if (want(text) || Date.now() > deadline) return { text, seen };
    await page.waitForTimeout(2_000);
  }
}

const shown = (t) => t !== null && t.includes(TEST_LIST_LINE);
let failures = 0;

/** No banner where one is expected only counts against the app when the
 *  page got an answer to its own sanctions read after `since`. */
async function blockedUnlessAnswered(since, what) {
  if (lastPageAnswer === null || lastPageAnswer < since) {
    await done();
    await blocked(`${what}, but the page's own sanctions read got no answer after that point — its RPC is the cause, not the banner`);
  }
}

if (wantFlagged) {
  const started = Date.now();
  const { text } = await waitForBanner(shown, BANNER_WINDOW_MS);
  const ok = shown(text);
  if (!ok) await blockedUnlessAnswered(started, 'no flagged banner appeared');
  console.log(`${ok ? 'PASS' : 'FAIL'} flagged: banner with the test-list contact line`);
  console.log(`  banner: ${text === null ? '(none)' : JSON.stringify(text)}`);
  if (!ok) failures++;
} else {
  const { seen } = await waitForBanner(() => false, BANNER_WINDOW_MS);
  const ok = seen === null;
  console.log(`${ok ? 'PASS' : 'FAIL'} clear: no sanctions banner at any point across ${BANNER_WINDOW_MS / 1000}s`);
  if (!ok) {
    console.log(`  banner: ${JSON.stringify(seen)}`);
    failures++;
  }
}

if (EXPECT === 'flagged-then-clear' && failures === 0) {
  console.log(`waiting for setFlagged(${WALLET}, false) on ${OVERLAY} — do not reload the page`);
  const deadline = Date.now() + CLEAR_WAIT_MS;
  let clearedAt = null;
  while (Date.now() < deadline) {
    try {
      const s = await chainState();
      if (!s.flagged) {
        clearedAt = Date.now();
        break;
      }
    } catch {
      /* transient read failure: keep waiting */
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (clearedAt === null) {
    await done();
    await blocked(`the flag was not cleared within ${CLEAR_WAIT_MS / 60_000} minutes`);
  }
  const { text } = await waitForBanner((t) => t === null, BANNER_WINDOW_MS);
  const ok = text === null;
  if (!ok) await blockedUnlessAnswered(clearedAt, 'the banner stayed after the chain cleared');
  const secs = Math.round((Date.now() - clearedAt) / 1000);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} cleared without reload: banner ${ok ? `gone ${secs}s after the chain cleared` : 'still shown'}`,
  );
  if (!ok) failures++;
}

await done();
process.exit(failures === 0 ? 0 : 1);
