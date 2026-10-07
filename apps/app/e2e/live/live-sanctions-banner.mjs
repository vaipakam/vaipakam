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
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi } from 'viem';
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

let state;
try {
  state = await chainState();
} catch (err) {
  await blocked('could not read the sanctions state from the chain', err);
}
console.log(
  `chain: oracle=${state.oracle} flagged=${state.flagged} onTestList=${state.onTestList} wallet=${WALLET} (${ROLE})`,
);
if (state.oracle.toLowerCase() !== OVERLAY.toLowerCase()) {
  await blocked(`the Diamond does not screen against the recorded test list (${OVERLAY})`);
}
const wantFlagged = EXPECT !== 'clear';
if (state.flagged !== wantFlagged || state.onTestList !== wantFlagged) {
  await blocked(
    wantFlagged
      ? `the wallet is not flagged on the test list yet — run setFlagged(${WALLET}, true) on ${OVERLAY} first`
      : `the wallet is still flagged — run setFlagged(${WALLET}, false) on ${OVERLAY} first`,
  );
}

const { page, done } = await launch({ role: ROLE, readOnly: true, freshProfile: true });
await visit(page, '/');
await ensureConnected(page);

const banner = page.locator('[role="alert"].banner-danger').filter({ hasText: TITLE });

/** Polls until `want(text|null)` holds or the window ends; returns the last text. */
async function waitForBanner(want, windowMs) {
  const deadline = Date.now() + windowMs;
  let text = null;
  for (;;) {
    text = (await banner.count()) > 0 ? await banner.first().innerText() : null;
    if (want(text) || Date.now() > deadline) return text;
    await page.waitForTimeout(2_000);
  }
}

const shown = (t) => t !== null && t.includes(TEST_LIST_LINE);
let failures = 0;

if (wantFlagged) {
  const text = await waitForBanner(shown, BANNER_WINDOW_MS);
  const ok = shown(text);
  console.log(`${ok ? 'PASS' : 'FAIL'} flagged: banner with the test-list contact line`);
  console.log(`  banner: ${text === null ? '(none)' : JSON.stringify(text)}`);
  if (!ok) failures++;
} else {
  const text = await waitForBanner(() => false, BANNER_WINDOW_MS);
  const ok = text === null;
  console.log(`${ok ? 'PASS' : 'FAIL'} clear: no sanctions banner across ${BANNER_WINDOW_MS / 1000}s`);
  if (!ok) failures++;
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
  const text = await waitForBanner((t) => t === null, BANNER_WINDOW_MS);
  const ok = text === null;
  const secs = Math.round((Date.now() - clearedAt) / 1000);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} cleared without reload: banner ${ok ? `gone ${secs}s after the chain cleared` : 'still shown'}`,
  );
  if (!ok) failures++;
}

await done();
process.exit(failures === 0 ? 0 : 1);
