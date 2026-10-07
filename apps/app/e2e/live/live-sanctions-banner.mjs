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
// A banner verdict is only drawn from an answer the PAGE got. The app fails
// open (no banner) when its own read of this wallet errors, and words the
// recourse as unknown when an explanation read errors, so each verdict
// needs the page's own read behind it, answered, for THIS wallet on THIS
// Diamond / list: without it the run is BLOCKED, not FAIL. A write the
// read-only session refused is a FAIL whatever the banner did.
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pad, parseAbi, toFunctionSelector, zeroAddress } from 'viem';
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
  'function isSanctioned(address) view returns (bool)',
]);

/** One of the page's reads, recognised in an `eth_call`: the selector with
 *  this wallet as its argument (contiguous in the calldata whether the call
 *  is plain or inside a multicall), addressed to `target` directly or
 *  carried for it inside a multicall's calldata. */
function pageRead(signature, target) {
  const strip = (hex) => hex.slice(2).toLowerCase();
  return {
    call: strip(toFunctionSelector(signature)) + strip(pad(WALLET)),
    target: strip(target),
  };
}
const PAGE_READS = {
  /** The flag itself — what shows or hides the banner. */
  flag: pageRead('isSanctionedAddress(address)', DIAMOND),
  /** The test-list explanation — what the test-list contact line rests on.
   *  It is only sent once the page has read the configured oracle. */
  testList: pageRead('flaggedByOverlay(address)', OVERLAY),
};
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

// When each of the page's own reads last came back answered: the matching
// JSON-RPC request, by id, got a `result` and no `error`. A transport
// failure, an HTTP error, an RPC error or an unreadable body leaves it as it
// was.
const lastAnswered = { flag: null, testList: null };
const asList = (v) => (Array.isArray(v) ? v : [v]);
page.on('response', (res) => {
  const req = res.request();
  if (req.method() !== 'POST' || res.status() !== 200) return;
  let calls;
  try {
    calls = asList(JSON.parse(req.postData() ?? 'null'));
  } catch {
    return;
  }
  const wanted = new Map(); // JSON-RPC id -> which reads it carries
  for (const c of calls) {
    if (!c || c.method !== 'eth_call') continue;
    const tx = c.params?.[0] ?? {};
    const data = String(tx.data ?? tx.input ?? '').toLowerCase();
    const to = String(tx.to ?? '').toLowerCase().replace(/^0x/, '');
    const kinds = Object.entries(PAGE_READS)
      .filter(([, r]) => data.includes(r.call) && (to === r.target || data.includes(r.target)))
      .map(([k]) => k);
    if (kinds.length > 0) wanted.set(c.id, kinds);
  }
  if (wanted.size === 0) return;
  res
    .text()
    .then((text) => {
      for (const r of asList(JSON.parse(text))) {
        if (!r || !wanted.has(r.id) || r.result === undefined || r.error !== undefined) continue;
        for (const k of wanted.get(r.id)) lastAnswered[k] = Date.now();
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

/** A banner verdict counts against the app only when the page's own read
 *  of `kind` was answered after `since`; otherwise the page never had the
 *  answer the verdict would hold against it, and the run is BLOCKED. */
async function blockedUnlessAnswered(kind, since, what) {
  if (lastAnswered[kind] === null || lastAnswered[kind] < since) {
    await done();
    await blocked(
      `${what}, but the page's own ${kind === 'flag' ? 'sanctions read of this wallet' : 'test-list read for this wallet'} ` +
        'got no answer in that window — its RPC is the cause, not the banner',
    );
  }
}

if (wantFlagged) {
  const started = Date.now();
  const { text } = await waitForBanner(shown, BANNER_WINDOW_MS);
  const ok = shown(text);
  // No banner at all rests on the flag read; a banner without the
  // test-list line rests on the test-list read.
  if (!ok) {
    await blockedUnlessAnswered(
      text === null ? 'flag' : 'testList',
      started,
      text === null ? 'no flagged banner appeared' : 'the banner lacks the test-list contact line',
    );
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} flagged: banner with the test-list contact line`);
  console.log(`  banner: ${text === null ? '(none)' : JSON.stringify(text)}`);
  if (!ok) failures++;
} else {
  const started = Date.now();
  const { seen } = await waitForBanner(() => false, BANNER_WINDOW_MS);
  const ok = seen === null;
  // An absent banner is coverage only if the page actually read the flag.
  if (ok) await blockedUnlessAnswered('flag', started, 'no banner appeared');
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
  if (!ok) await blockedUnlessAnswered('flag', clearedAt, 'the banner stayed after the chain cleared');
  const secs = Math.round((Date.now() - clearedAt) / 1000);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} cleared without reload: banner ${ok ? `gone ${secs}s after the chain cleared` : 'still shown'}`,
  );
  if (!ok) failures++;
}

// The read-only session refused something the page asked for: a signature,
// a state-changing wallet call, or a request outside the read-only
// boundary. Whatever the banner did, that is a defect to surface.
if (blockedRequests.length > 0) {
  console.log(`FAIL read-only: the page attempted ${blockedRequests.length} refused request(s)`);
  for (const b of blockedRequests) console.log(`  ${b.reason} — ${b.url}`);
  failures++;
}

await done();
process.exit(failures === 0 ? 0 : 1);
