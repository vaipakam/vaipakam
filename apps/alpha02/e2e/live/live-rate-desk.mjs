// #1129/#1134 post-merge live review — Rate Desk phase 1 on production
// alpha02: drive the desk's chain-path feature end-to-end as the lender
// (custom-pair market load → post a GTC/Partial lend order → amend it
// in place → wait out the real 300 s protocol cooldown → cancel), with
// every offer-scoped assert verified BOTH in the UI and directly
// on-chain via viem.
//
// This driver is the "remaining live half" of the COVERAGE.md Rate
// Desk row: the fork spec (tests/17-rate-desk.spec.ts) owns the exact
// ladder math and time-travels past the cooldown; this drive proves
// the same journey against the deployed site, the real Base Sepolia
// Diamond, and the real indexer — INCLUDING the desk's honest degraded
// states when the indexer's market routes are down (/offers/markets
// and the market-scoped /loans/recent). Those degraded states are
// OBSERVED and reported, never asserted as failures: the desk's
// doctrine is honest copy over faked data, and the book itself is a
// chain read that must keep working regardless.
//
// Money discipline: ONE offer, AMOUNT_WETH escrow + gas at risk; the
// cancel refunds the escrow. If the UI cancel can't be reached after
// an offer was created, the cleanup handler cancels directly on-chain
// via viem (waiting out the cooldown first) — and failing THAT, it
// reports the orphaned offer id loudly for a manual cancel.
//
//   TESTNET_WALLETS_FILE=~/secrets/wallets.json node live-rate-desk.mjs
//
// NB for the batch runner: this script performs real testnet writes
// (approve/permit + create + modify + cancel) and blocks ~5–7 minutes
// on the genuine cancel cooldown. It self-cleans, so batch inclusion
// is safe — just slow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pad, toEventSelector } from 'viem';
import {
  addressOf,
  chooseMenuValue,
  clientsFor,
  ensureConnected,
  launch,
  SITE,
} from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- contracts plumbing — the SAME source files the app ships with
// (packages/contracts/src), mirroring e2e/lib/artifacts.ts so this
// driver can never drift from the app's own address/ABI source. ------
const CONTRACTS_SRC = path.resolve(HERE, '../../../../packages/contracts/src');

function loadDiamondAbi() {
  const dir = path.join(CONTRACTS_SRC, 'abis');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out;
}

const CHAIN_ID = 84532;
const deployment = JSON.parse(
  fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
)[String(CHAIN_ID)];
const DIAMOND = deployment.diamond;
const WETH = deployment.weth;
const TLIQ = deployment.testnetMocks?.liquidToken;
if (!WETH || !TLIQ) throw new Error('bundle missing weth/testnetMocks.liquidToken');
const ABI = loadDiamondAbi();
const { pub } = clientsFor(CHAIN_ID);

// Distinctive rates on purpose — nothing else on the live book quotes
// these, so a UI row showing them is unambiguously THIS run's offer.
const POST = { bps: 843, text: '8.43', pct: '8.43%' };
const AMEND = { bps: 1127, text: '11.27', pct: '11.27%' };
const AMOUNT_WETH = '0.002';
const COLLATERAL_TLIQ = '100';
const CANCEL_COOLDOWN_SECS = 300;
// Same preference order as the fork spec: 365 stays clear of the
// duration cap, 30 goes last (the app-wide default other flows post
// into).
const BUCKET_PREFERENCE = [60, 90, 14, 180, 7, 30];
const ZERO_CREATOR = /^0x0{40}$/i;

// ---- step ledger — PASS/OBSERVED/FAIL per drive step ---------------
const steps = [];
const shotPaths = [];
function record(name, status, detail = '') {
  steps.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- chain read helpers --------------------------------------------
async function getOffer(offerId) {
  return pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'getOffer',
    args: [offerId],
  });
}

/** Newest offer id created by `creator` (the lib/flows.ts pattern) —
 *  roles are reused across runs, so "newest" is the one this run just
 *  minted; the caller additionally checks it against the pre-post
 *  snapshot. */
async function newestOfferIdFor(creator) {
  const [ids] = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'getUserOffersPaginated',
    args: [creator, 0n, 200n],
  });
  if (!ids.length) throw new Error(`no offers for ${creator}`);
  return ids.reduce((a, b) => (b > a ? b : a));
}

async function pollChain(label, fn, { timeoutMs = 120_000, intervalMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A WETH/tLIQ tenor bucket with no live offers on the real book right
 *  now (the ranked view is active-only); falls back to the least-
 *  populated bucket if every one is taken. */
async function pickTenor() {
  const [rankings] = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'getActiveOffersByAssetPairRanked',
    args: [WETH, TLIQ],
  });
  const counts = new Map();
  for (const r of rankings) {
    const d = Number(r.durationDays);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  for (const d of BUCKET_PREFERENCE) if (!counts.has(d)) return { days: d, empty: true };
  const least = [...BUCKET_PREFERENCE].sort(
    (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0),
  )[0];
  return { days: least, empty: false };
}

/** Every Diamond tx this run emitted an offer-lifecycle event for THIS
 *  offer id in — the on-chain evidence trail (create/modify/cancel tx
 *  hashes). Best-effort: a getLogs-limited RPC degrades to the
 *  injected wallet's eth_sendTransaction count. */
async function txEvidence(fromBlock, offerId) {
  const names = {};
  for (const e of ABI) {
    if (e.type !== 'event') continue;
    try {
      names[toEventSelector(e)] = e.name;
    } catch {
      /* unnamed/duplicate — selector map is best-effort */
    }
  }
  const logs = await pub.getLogs({ address: DIAMOND, fromBlock, toBlock: 'latest' });
  const wanted = pad(`0x${offerId.toString(16)}`, { size: 32 }).toLowerCase();
  const out = new Map();
  for (const log of logs) {
    if ((log.topics[1] ?? '').toLowerCase() !== wanted) continue;
    const prior = out.get(log.transactionHash) ?? [];
    out.set(log.transactionHash, [...prior, names[log.topics[0]] ?? log.topics[0]]);
  }
  return [...out.entries()].map(([hash, events]) => ({ hash, events }));
}

// ---- UI helpers -----------------------------------------------------
/** Consent tick + wait-enabled, mirroring e2e/lib/flows.ts: late
 *  disclosures legitimately RESET the checkbox, so keep re-ticking
 *  until every canPost gate clears. */
async function consentAndWaitEnabled(page, button, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
      if (!(await box.isChecked().catch(() => true))) {
        await box.check().catch(() => {});
      }
    }
    if (await button.isEnabled().catch(() => false)) return;
    if (Date.now() > deadline) {
      throw new Error('post button never enabled (consent gates did not clear)');
    }
    await page.waitForTimeout(750);
  }
}

async function selectTenor(page, days) {
  await page
    .getByRole('group', { name: 'Term' })
    .getByRole('button', { name: `${days}d`, exact: true })
    .click();
}

// ---------------------------------------------------------------------
const lenderAddr = addressOf('lender');
const startBlock = await pub.getBlockNumber();
const { days: tenor, empty: tenorEmpty } = await pickTenor();
console.log(
  `run: lender=${lenderAddr} market=WETH/tLIQ tenor=${tenor}d` +
    `${tenorEmpty ? ' (verified live-empty)' : ' (least-populated fallback)'} site=${SITE}`,
);

const { page, shot, done, consoleErrors } = await launch({ role: 'lender' });
const snap = async (name) => shotPaths.push(await shot(name));

let offerId = null;
let offerCreatedAt = 0;
let cancelled = false;
let failed = false;
// Snapshot of the lender's offer ids just before the post — module
// scope so the cleanup sweep can find the run's offer even if the
// drive failed before its id was discovered ("Order posted" renders
// at SEND time; the tx can mine after a failure).
let beforePostIds = null;

// Open-orders row for THIS run's offer — id-scoped, so reused roles
// and leftover offers can never satisfy (or break) an assert.
const ordersRow = () =>
  page.locator('.row-list > div').filter({ hasText: `#${offerId} ·` }).first();
const ownLadderRow = (pct) =>
  page.locator('.desk-ladder-row.desk-own').filter({ hasText: pct });

try {
  // ---- step 1: initial /desk state + degraded markets summary -------
  await page.goto(`${SITE}/desk`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: 'Rate Desk', level: 1 })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(5_000); // let the markets query settle
  const headerText = await page.locator('.desk-header').innerText();
  const pairButton = (await page.locator('#desk-pair').innerText()).trim();
  await snap('rate-desk-01-initial');
  if (/pair discovery is limited/i.test(headerText)) {
    const line = headerText
      .split('\n')
      .find((l) => /pair discovery is limited/i.test(l));
    record(
      '1. /desk initial — markets summary degraded honestly',
      'OBSERVED',
      `dropdown="${pairButton}" · copy="${line?.trim()}"`,
    );
  } else if (/no live markets right now/i.test(headerText)) {
    record('1. /desk initial — markets summary', 'OBSERVED', 'markets list empty (not degraded)');
  } else {
    record('1. /desk initial — markets summary', 'OBSERVED', `dropdown="${pairButton}" (markets list loaded)`);
  }

  // ---- step 2: load WETH/tLIQ via the custom-pair branch ------------
  await chooseMenuValue(page, 'desk-pair', '__custom__');
  await page.locator('#desk-custom-lend').fill(WETH);
  await page.locator('#desk-custom-coll').fill(TLIQ);
  await page.getByRole('button', { name: 'Load market' }).click();
  await selectTenor(page, tenor);
  // The book is the CHAIN-read path — it must resolve to a real state
  // (empty copy or ladder rows), never the unavailable copy.
  const emptyCopy = page.getByText(/no open offers for this market yet/i);
  const ladder = page.locator('.desk-ladder');
  await Promise.race([
    emptyCopy.waitFor({ timeout: 45_000 }),
    ladder.waitFor({ timeout: 45_000 }),
  ]);
  if (await page.getByText(/couldn.t load the order book/i).isVisible().catch(() => false)) {
    throw new Error('order book rendered UNAVAILABLE — the chain read path is down');
  }
  const bookState = (await emptyCopy.isVisible().catch(() => false))
    ? 'honest empty-market copy'
    : `ladder with ${await ladder.locator('.desk-ladder-row').count()} row(s)`;
  await snap('rate-desk-02-market-loaded');
  record(`2. load market WETH/tLIQ @ ${tenor}d (custom pair, chain book)`, 'PASS', bookState);

  // ---- step 3: connect + post the lend order ------------------------
  await ensureConnected(page);
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.locator('#desk-amount').fill(AMOUNT_WETH);
  await page.locator('#desk-rate').fill(POST.text);
  const collAssetShort = `${TLIQ.slice(0, 6)}…${TLIQ.slice(-4)}`;
  const collAssetText = await page.locator('#desk-collateral-asset').innerText();
  if (!new RegExp(collAssetShort.replace('…', '.'), 'i').test(collAssetText)) {
    throw new Error(
      `read-only collateral asset shows "${collAssetText}", expected ${collAssetShort}`,
    );
  }
  await page.locator('#desk-collateral-amount').fill(COLLATERAL_TLIQ);
  await page
    .getByRole('group', { name: 'Expiry' })
    .getByRole('button', { name: 'GTC', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Fill mode' })
    .getByRole('button', { name: 'Partial', exact: true })
    .click();

  [beforePostIds] = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'getUserOffersPaginated',
    args: [lenderAddr, 0n, 200n],
  });

  const post = page.getByRole('button', { name: /^post order$/i });
  await consentAndWaitEnabled(page, post);
  await post.click();
  // Real testnet tx (possibly approve + create, or Permit2 + create).
  await page.getByText(/order posted/i).waitFor({ timeout: 120_000 });
  await snap('rate-desk-03-posted');
  record(
    `3. post lend order (${AMOUNT_WETH} WETH @ ${POST.pct}, ${COLLATERAL_TLIQ} tLIQ, GTC, Partial)`,
    'PASS',
    'ticket confirmed "Order posted"',
  );

  // ---- step 4: on-chain verification of the posted terms ------------
  // "Order posted" renders when the wallet returns the tx HASH — the
  // tx may still be in the mempool. Poll until the lender's offer
  // enumeration shows an id the pre-post snapshot didn't have.
  offerId = await pollChain('the posted offer to mine', async () => {
    const id = await newestOfferIdFor(lenderAddr);
    return beforePostIds.includes(id) ? undefined : id;
  });
  const posted = await getOffer(offerId);
  offerCreatedAt = Number(posted.createdAt);
  const mismatches = [
    Number(posted.offerType) === 0 ? null : `offerType=${posted.offerType}`,
    Number(posted.interestRateBps) === POST.bps ? null : `rate=${posted.interestRateBps}`,
    Number(posted.durationDays) === tenor ? null : `days=${posted.durationDays}`,
    Number(posted.fillMode) === 0 ? null : `fillMode=${posted.fillMode}`,
    Number(posted.expiresAt) === 0 ? null : `expiresAt=${posted.expiresAt}`,
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(`offer #${offerId} on-chain terms mismatch: ${mismatches.join(', ')}`);
  }
  record(
    '4. on-chain terms of the posted offer',
    'PASS',
    `offer #${offerId}: lend, ${POST.bps} bps, ${tenor}d, Partial, GTC`,
  );

  // ---- step 5: UI — own ladder row + open-orders row + cooldown gate -
  await ownLadderRow(POST.pct).first().waitFor({ timeout: 30_000 });
  await ordersRow().waitFor({ timeout: 30_000 });
  const rowText = await ordersRow().innerText();
  if (!rowText.includes(POST.pct) || !/no expiry/i.test(rowText)) {
    throw new Error(`open-orders row missing rate/no-expiry: "${rowText.replace(/\n/g, ' · ')}"`);
  }
  const cancelBtn = ordersRow().getByRole('button', { name: /^cancel$/i });
  await cancelBtn.waitFor({ timeout: 15_000 });
  const blockedNow = await cancelBtn.isDisabled();
  const cooldownTitle = await cancelBtn.getAttribute('title');
  await snap('rate-desk-04-own-order');
  if (blockedNow && /cancel available in \d+s/i.test(cooldownTitle ?? '')) {
    record(
      '5. own order in ladder + Open orders; cancel gated by cooldown',
      'PASS',
      `countdown copy: "${cooldownTitle}"`,
    );
  } else {
    // A slow post→verify stretch can legitimately outlive the window;
    // anything else is a real gate failure.
    const now = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
    if (now < offerCreatedAt + CANCEL_COOLDOWN_SECS) {
      throw new Error(
        `cancel not cooldown-gated inside the window (disabled=${blockedNow}, title=${cooldownTitle})`,
      );
    }
    record(
      '5. own order in ladder + Open orders; cancel gate',
      'OBSERVED',
      'cooldown already elapsed before the UI check — gate copy not capturable this run',
    );
  }

  // ---- step 6: amend in place (ONE modifyOffer, same offer id) ------
  await ordersRow().getByRole('button', { name: /amend/i }).click();
  const rateInput = page.locator(`#amend-${offerId}-rate`);
  await pollChain(
    'amend form to seed from the live getOffer read',
    async () => (await rateInput.inputValue()) === POST.text,
    { timeoutMs: 30_000, intervalMs: 1_000 },
  );
  await rateInput.fill(AMEND.text);
  await page.getByRole('button', { name: /save changes/i }).click();
  await pollChain(
    `offer #${offerId} rate to become ${AMEND.bps} bps`,
    async () => Number((await getOffer(offerId)).interestRateBps) === AMEND.bps,
  );
  const amendedId = await newestOfferIdFor(lenderAddr);
  if (amendedId !== offerId) {
    throw new Error(`amend minted a NEW offer #${amendedId} — expected in-place #${offerId}`);
  }
  await pollChain(
    'open-orders row to show the amended rate',
    async () => (await ordersRow().innerText()).includes(AMEND.pct),
    { timeoutMs: 45_000, intervalMs: 2_000 },
  );
  await ownLadderRow(AMEND.pct).first().waitFor({ timeout: 45_000 });
  await snap('rate-desk-05-amended');
  record(
    '6. amend in place to ' + AMEND.pct,
    'PASS',
    `same offer #${offerId}; chain=${AMEND.bps} bps; row + own ladder level updated`,
  );

  // ---- step 7: tape panel (degraded /loans/recent expected) ----------
  const tapeCard = page.locator('.card').filter({ hasText: 'Recent fills' }).first();
  const tapeText = (await tapeCard.innerText().catch(() => '')).replace(/\n+/g, ' · ');
  record(
    '7. tape panel state',
    'OBSERVED',
    tapeText ? `"${tapeText}"` : 'tape card not found',
  );

  // ---- step 8: wait out the REAL cooldown, then cancel ---------------
  const chainNow = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
  const remaining = Math.max(0, offerCreatedAt + CANCEL_COOLDOWN_SECS - chainNow);
  console.log(`waiting out the cancel cooldown — ~${remaining}s left on chain time…`);
  await pollChain(
    'cancel button to enable after the cooldown',
    async () => !(await cancelBtn.isDisabled().catch(() => true)),
    { timeoutMs: (remaining + 120) * 1000, intervalMs: 5_000 },
  );
  await cancelBtn.click();
  await pollChain(
    `offer #${offerId} to be cancelled on-chain`,
    async () => ZERO_CREATOR.test(String((await getOffer(offerId)).creator)),
  );
  cancelled = true;
  await pollChain(
    'cancelled offer to leave Open orders and the ladder',
    async () =>
      (await page
        .locator('.row-list > div')
        .filter({ hasText: `#${offerId} ·` })
        .count()) === 0 && (await ownLadderRow(AMEND.pct).count()) === 0,
    { timeoutMs: 45_000, intervalMs: 2_000 },
  );
  await snap('rate-desk-06-cancelled');
  record(
    '8. cancel after the real 300 s cooldown',
    'PASS',
    `offer #${offerId} creator zeroed on-chain; row left Open orders + ladder (escrow refunded)`,
  );
} catch (err) {
  failed = true;
  record('drive', 'FAIL', err.message);
  await snap('rate-desk-99-failure').catch(() => {});
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '(page text unavailable)');
  console.log('--- page text at failure ---\n' + body.slice(0, 4_000) + '\n---');
} finally {
  // Never leave the lender's WETH escrowed in an orphaned live offer:
  // if the post was attempted but the UI cancel didn't complete,
  // cancel directly on-chain (waiting out the cooldown first). When
  // the drive failed before the offer id was even discovered, sweep
  // the enumeration for ids the pre-post snapshot didn't have — the
  // tx can mine AFTER a failure ("Order posted" renders at send time).
  if (!cancelled && beforePostIds !== null) {
    try {
      if (offerId === null) {
        // Give a still-pending create a moment to mine, then sweep.
        await new Promise((r) => setTimeout(r, 15_000));
        const [ids] = await pub.readContract({
          address: DIAMOND,
          abi: ABI,
          functionName: 'getUserOffersPaginated',
          args: [lenderAddr, 0n, 200n],
        });
        offerId = ids.find((id) => !beforePostIds.includes(id)) ?? null;
      }
      if (offerId === null) {
        cancelled = true; // nothing ever landed — nothing escrowed
      } else {
        const live = await getOffer(offerId);
        if (ZERO_CREATOR.test(String(live.creator))) {
          cancelled = true;
        } else {
          const now = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
          const wait = Math.max(0, Number(live.createdAt) + CANCEL_COOLDOWN_SECS + 5 - now);
          console.log(`cleanup: direct on-chain cancelOffer(#${offerId}) in ~${wait}s…`);
          await new Promise((r) => setTimeout(r, wait * 1000));
          const hash = await clientsFor(CHAIN_ID)
            .wallet('lender')
            .writeContract({
              address: DIAMOND,
              abi: ABI,
              functionName: 'cancelOffer',
              args: [offerId],
            });
          await pub.waitForTransactionReceipt({ hash });
          cancelled = true;
          record('cleanup: direct on-chain cancel', 'PASS', `tx ${hash}`);
        }
      }
    } catch (cleanupErr) {
      record(
        'cleanup: direct on-chain cancel',
        'FAIL',
        `OFFER #${offerId ?? '(unknown)'} MAY STILL BE LIVE WITH ${AMOUNT_WETH} WETH ESCROWED — ` +
          `cancel it manually (cancelOffer on ${DIAMOND}). ${cleanupErr.message}`,
      );
    }
  }
  await done().catch(() => {});
}

// ---- evidence + structured summary ----------------------------------
let evidence = [];
if (offerId !== null) {
  evidence = await txEvidence(startBlock, offerId).catch((e) => {
    console.log(`(tx-evidence getLogs degraded: ${e.message})`);
    return [];
  });
}

console.log('\n━━━ live-rate-desk summary ━━━');
for (const s of steps) console.log(`${s.status.padEnd(8)} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
console.log(`offer id: ${offerId ?? '(none created)'} · cancelled: ${cancelled}`);
for (const t of evidence) console.log(`tx ${t.hash} — ${t.events.join(', ')}`);
console.log(`screenshots: ${shotPaths.join(', ') || '(none)'}`);
if (consoleErrors.length) {
  console.log(`console errors (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  ${e}`);
} else {
  console.log('console errors: none');
}

const ok = !failed && steps.every((s) => s.status !== 'FAIL') && (offerId === null || cancelled);
console.log(ok ? 'PASS — Rate Desk live review complete' : 'FAIL — see steps above');
process.exit(ok ? 0 : 1);
