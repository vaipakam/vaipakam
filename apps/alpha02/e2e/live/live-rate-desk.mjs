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
// Diamond, and the real indexer. The indexer-backed surfaces are
// ASSERTED healthy: the /offers/markets summary behind the pair
// dropdown (step 1) and the market-scoped /loans/recent tape (step 7)
// must render real data or their honest empty copy. Production has
// carried real market data since D1 migrations 0029–0031 were applied
// (2026-07-10), so a degraded indexer — either surface showing its
// "couldn't load" copy (`copy.desk.marketsUnavailable` /
// `copy.desk.tapeUnavailable`) — now FAILS the drive by design. The
// book itself is a chain read and is asserted healthy regardless.
//
// Money discipline: ONE offer, AMOUNT_WETH escrow + gas at risk; the
// cancel refunds the escrow. If the UI cancel can't be reached after
// an offer was created, the cleanup handler cancels directly on-chain
// via viem (waiting out the cooldown first) — and failing THAT, it
// reports the orphaned offer id loudly for a manual cancel. If Post
// was clicked but no create ever surfaced in the offer index (a tx
// still pending past the cleanup's extended watch), the run exits
// non-zero as CLEANUP-UNKNOWN rather than claiming "cancelled".
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
import { pad, parseUnits, toEventSelector } from 'viem';
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

// Minimal ERC-20 read surface — the Diamond bundle carries no token
// ABI, and the escrow/decimals asserts below read the tokens directly.
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
];
const erc20Read = (token, functionName, args = []) =>
  pub.readContract({ address: token, abi: ERC20_ABI, functionName, args });

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

// Expected on-chain amounts (Codex round-1 P2 #1) — mirror of the
// ticket's payload mapping (`toCreateOfferPayload` in
// src/lib/offerSchema.ts, used by OrderTicket with fill mode Partial):
//   - amountMax          = the headline lend size,
//   - amount             = minPartialFillAmount = amountMax / 10,
//                          floored at 1 wei (Partial-mode lender),
//   - collateralAmount   = collateralAmountMax (lender collateral is
//                          single-value by contract invariant).
// Decimals are read LIVE from the tokens, exactly like the ticket does
// — a hardcoded 18 would mask the very drift this assert exists for.
const [WETH_DECIMALS, TLIQ_DECIMALS] = await Promise.all([
  erc20Read(WETH, 'decimals'),
  erc20Read(TLIQ, 'decimals'),
]);
const EXPECTED_AMOUNT_MAX = parseUnits(AMOUNT_WETH, WETH_DECIMALS);
const EXPECTED_AMOUNT_MIN_PARTIAL =
  EXPECTED_AMOUNT_MAX / 10n > 0n ? EXPECTED_AMOUNT_MAX / 10n : 1n;
const EXPECTED_COLLATERAL = parseUnits(COLLATERAL_TLIQ, TLIQ_DECIMALS);
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

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

/** Length of `creator`'s LIFETIME offer index. getUserOffersPaginated
 *  (MetricsFacet) returns `(page-slice-at-offset, total)` over the
 *  append-only `userOfferIds[user]` array — a limit-0 read is a cheap
 *  total-only probe. */
async function offerIndexTotal(creator) {
  const [, total] = await pub.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName: 'getUserOffersPaginated',
    args: [creator, 0n, 0n],
  });
  return total;
}

/** Every offer id appended to `creator`'s index AFTER `beforeTotal` —
 *  pages from the END (Codex round-1 P2 #3: a fixed offset-0/limit-200
 *  read stops seeing new offers once the reused lender has >200
 *  historical ones), looping until the slice is exhausted. Sound
 *  because the index is append-only: `OfferCreateFacet` push is its
 *  only writer and cancel never removes entries, so the delta since
 *  the pre-post snapshot is exactly this run's offers. */
async function offerIdsAppendedSince(creator, beforeTotal) {
  const out = [];
  const PAGE = 200n;
  for (let offset = beforeTotal; ; ) {
    const [ids, total] = await pub.readContract({
      address: DIAMOND,
      abi: ABI,
      functionName: 'getUserOffersPaginated',
      args: [creator, offset, PAGE],
    });
    out.push(...ids);
    offset += BigInt(ids.length);
    if (ids.length === 0 || offset >= total) return out;
  }
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
// True once the ticket's Post button has actually been clicked (Codex
// round-2 P2 #1) — from that moment a create tx may exist even if
// unmined, so an empty cleanup sweep no longer proves "nothing
// escrowed"; the cleanup must extend its watch and, failing that,
// report CLEANUP-UNKNOWN instead of "cancelled".
let postAttempted = false;
// Snapshot of the lender's offer-index LENGTH just before the post —
// module scope so the cleanup sweep can find the run's offer(s) even
// if the drive failed before an id was discovered ("Order posted"
// renders at SEND time; the tx can mine after a failure). The index
// is append-only, so every id at offsets >= this total is this run's.
let beforePostTotal = null;
// Lender wallet WETH just before the post (Codex round-1 P2 #2) — the
// escrow-pulled and escrow-refunded asserts both compare against it.
let wethBeforePost = null;

// Open-orders row for THIS run's offer — id-scoped, so reused roles
// and leftover offers can never satisfy (or break) an assert.
const ordersRow = () =>
  page.locator('.row-list > div').filter({ hasText: `#${offerId} ·` }).first();
const ownLadderRow = (pct) =>
  page.locator('.desk-ladder-row.desk-own').filter({ hasText: pct });

try {
  // ---- step 1: initial /desk state — markets summary ASSERTED healthy
  // (Codex round-2 P2 #3: production carries real markets data since
  // the 2026-07-10 D1 migrations, so this is PASS/FAIL, not observed.)
  await page.goto(`${SITE}/desk`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: 'Rate Desk', level: 1 })
    .waitFor({ timeout: 30_000 });
  const deskHeader = page.locator('.desk-header');
  // `copy.desk.marketsUnavailable` — the degraded /offers/markets copy.
  const marketsDegraded = deskHeader.getByText(/markets list couldn.t load right now/i);
  // `copy.desk.marketsEmpty` — the honest zero-markets copy.
  const marketsEmptyCopy = deskHeader.getByText(/no live markets right now/i);
  // `copy.desk.pickPair` — the dropdown's no-selection placeholder. A
  // loaded summary auto-selects the most active market (Desk.tsx's
  // default-market effect), so the trigger showing a real pair label
  // proves the dropdown lists at least one market beyond the
  // "Custom pair…" escape hatch.
  const PAIR_PLACEHOLDER = /pick a market to load its book/i;
  const pairLabel = async () =>
    (await page.locator('#desk-pair').innerText().catch(() => '')).trim();
  await pollChain(
    'the markets summary to reach a terminal state',
    async () => {
      if (await marketsDegraded.isVisible().catch(() => false)) return true;
      if (await marketsEmptyCopy.isVisible().catch(() => false)) return true;
      const label = await pairLabel();
      return label !== '' && !PAIR_PLACEHOLDER.test(label);
    },
    { timeoutMs: 45_000, intervalMs: 2_000 },
  );
  const pairButton = await pairLabel();
  await snap('rate-desk-01-initial');
  if (await marketsDegraded.isVisible().catch(() => false)) {
    throw new Error(
      'markets summary rendered DEGRADED (`copy.desk.marketsUnavailable`) — ' +
        'the indexer /offers/markets route regressed',
    );
  }
  if (
    (await marketsEmptyCopy.isVisible().catch(() => false)) ||
    pairButton === '' ||
    PAIR_PLACEHOLDER.test(pairButton)
  ) {
    throw new Error(
      `markets summary loaded no real market — dropdown shows "${pairButton}"; ` +
        'production steady state has live markets (post-2026-07-10 migrations), ' +
        'so an empty summary is a regression',
    );
  }
  record(
    '1. /desk initial — markets summary healthy (indexer-backed)',
    'PASS',
    `dropdown auto-selected "${pairButton}"`,
  );

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

  beforePostTotal = await offerIndexTotal(lenderAddr);
  // Escrow baseline: the create pulls the WETH escrow out of the
  // WALLET (vault deposit via transferFrom / Permit2 — either way the
  // wallet balance drops), gas is paid in ETH, and the cancel refund
  // withdraws back to the wallet — so this exact value must be
  // restored after cancel.
  wethBeforePost = await erc20Read(WETH, 'balanceOf', [lenderAddr]);

  const post = page.getByRole('button', { name: /^post order$/i });
  await consentAndWaitEnabled(page, post);
  postAttempted = true; // a create tx may exist from here on, mined or not
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
  // index grows past the pre-post snapshot, then take a settle beat
  // and recompute the FULL delta: one Post click must have minted
  // EXACTLY one offer (Codex round-1 P2 #4 — a duplicate create
  // otherwise slips through on "first new id wins" and leaves a
  // second escrowed offer behind; the cleanup sweep below cancels
  // every delta id either way).
  await pollChain('the posted offer to mine', async () => {
    const ids = await offerIdsAppendedSince(lenderAddr, beforePostTotal);
    return ids.length > 0;
  });
  await new Promise((r) => setTimeout(r, 8_000)); // let a straggler duplicate mine
  const newIds = await offerIdsAppendedSince(lenderAddr, beforePostTotal);
  if (newIds.length !== 1) {
    throw new Error(
      `one Post click minted ${newIds.length} offers [${newIds.join(', ')}] — ` +
        'expected exactly one; cleanup will cancel every one of them',
    );
  }
  offerId = newIds[0];
  const posted = await getOffer(offerId);
  offerCreatedAt = Number(posted.createdAt);
  // Full-term mismatch list (Codex round-1 P2 #1): assets and amounts
  // included — a custom-pair regression posting the wrong asset or a
  // mis-scaled amount must fail here, not pass on rate/tenor alone.
  const mismatches = [
    Number(posted.offerType) === 0 ? null : `offerType=${posted.offerType}`,
    sameAddr(posted.lendingAsset, WETH) ? null : `lendingAsset=${posted.lendingAsset}`,
    sameAddr(posted.collateralAsset, TLIQ) ? null : `collateralAsset=${posted.collateralAsset}`,
    posted.amountMax === EXPECTED_AMOUNT_MAX ? null : `amountMax=${posted.amountMax}`,
    posted.amount === EXPECTED_AMOUNT_MIN_PARTIAL ? null : `amount=${posted.amount}`,
    posted.collateralAmount === EXPECTED_COLLATERAL
      ? null
      : `collateralAmount=${posted.collateralAmount}`,
    posted.collateralAmountMax === EXPECTED_COLLATERAL
      ? null
      : `collateralAmountMax=${posted.collateralAmountMax}`,
    Number(posted.interestRateBps) === POST.bps ? null : `rate=${posted.interestRateBps}`,
    // Lender rate CEILING left open (Codex round-2 P2 #2): the ticket's
    // payload mapping (`toCreateOfferPayload` in src/lib/offerSchema.ts)
    // sets `interestRateBpsMax = MAX_INTEREST_BPS` (10_000 = 100% APR)
    // for lender offers — no upper limit on rates they'd accept.
    Number(posted.interestRateBpsMax) === 10_000
      ? null
      : `interestRateBpsMax=${posted.interestRateBpsMax}`,
    Number(posted.durationDays) === tenor ? null : `days=${posted.durationDays}`,
    Number(posted.fillMode) === 0 ? null : `fillMode=${posted.fillMode}`,
    Number(posted.expiresAt) === 0 ? null : `expiresAt=${posted.expiresAt}`,
  ].filter(Boolean);
  if (mismatches.length) {
    throw new Error(`offer #${offerId} on-chain terms mismatch: ${mismatches.join(', ')}`);
  }
  // Escrow proof (Codex round-1 P2 #2): the lender ERC-20 create
  // pre-vaults exactly `amountMax` in the lending asset, pulled from
  // the WALLET; gas is ETH and an approve/permit leg moves no WETH —
  // so the wallet's WETH must now read the pre-post snapshot minus
  // the escrow, exactly.
  await pollChain(
    `lender wallet WETH to drop by the ${AMOUNT_WETH} escrow`,
    async () =>
      (await erc20Read(WETH, 'balanceOf', [lenderAddr])) ===
      wethBeforePost - EXPECTED_AMOUNT_MAX,
    { timeoutMs: 60_000 },
  );
  record(
    '4. on-chain terms of the posted offer',
    'PASS',
    `offer #${offerId}: lend ${AMOUNT_WETH} WETH vs ${COLLATERAL_TLIQ} tLIQ, ` +
      `${POST.bps} bps, ${tenor}d, Partial, GTC; single create; ` +
      `wallet WETH down exactly ${EXPECTED_AMOUNT_MAX} wei (escrow pulled)`,
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
  // Block mark just before Save — the single-modifyOffer event count
  // below scans [preSaveBlock, latest].
  const preSaveBlock = await pub.getBlockNumber();
  await page.getByRole('button', { name: /save changes/i }).click();
  await pollChain(
    `offer #${offerId} rate to become ${AMEND.bps} bps`,
    async () => Number((await getOffer(offerId)).interestRateBps) === AMEND.bps,
  );
  const idsAfterAmend = await offerIdsAppendedSince(lenderAddr, beforePostTotal);
  if (idsAfterAmend.length !== 1 || idsAfterAmend[0] !== offerId) {
    throw new Error(
      `amend minted NEW offer(s) — index delta is now [${idsAfterAmend.join(', ')}], ` +
        `expected in-place #${offerId} only`,
    );
  }
  // Exactly ONE OfferModified for this offer since just before Save
  // (Codex round-1 P2 #6) — the event OfferMutateFacet emits on every
  // mutation entry point, with `offerId` as topic1, so getLogs can
  // filter server-side over this short block range.
  const offerModifiedAbi = ABI.find((e) => e.type === 'event' && e.name === 'OfferModified');
  if (!offerModifiedAbi) throw new Error('OfferModified event missing from the bundled ABI');
  const modLogs = await pollChain(
    `the OfferModified log for offer #${offerId}`,
    async () => {
      const logs = await pub.getLogs({
        address: DIAMOND,
        event: offerModifiedAbi,
        args: { offerId },
        fromBlock: preSaveBlock,
        toBlock: 'latest',
      });
      return logs.length ? logs : undefined; // [] is truthy — gate on length
    },
    { timeoutMs: 60_000 },
  );
  if (modLogs.length !== 1) {
    throw new Error(
      `expected exactly 1 OfferModified for offer #${offerId} since block ` +
        `${preSaveBlock}, saw ${modLogs.length}`,
    );
  }
  // Amend must change interestRateBps and NOTHING else (Codex round-1
  // P2 #5). OfferMutateFacet.modifyOffer writes only the caller-changed
  // clusters (amount/amountMax, interestRateBps/interestRateBpsMax,
  // collateralAmount/collateralAmountMax) and mutates no bookkeeping
  // fields (no updatedAt/nonce — see modifyOffer's storage writes), so
  // every other getOffer field must round-trip identical. The rate
  // cluster does re-write interestRateBpsMax, but to the same value
  // the form seeded from the live read — so it too must compare equal.
  const amended = await getOffer(offerId);
  const changedFields = Object.keys(posted).filter(
    (k) => String(posted[k]) !== String(amended[k]),
  );
  if (changedFields.length !== 1 || changedFields[0] !== 'interestRateBps') {
    throw new Error(
      `amend touched unexpected fields [${changedFields.join(', ')}] — ` +
        'expected only interestRateBps to change',
    );
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
    `same offer #${offerId}; exactly 1 OfferModified (tx ${modLogs[0].transactionHash}); ` +
      `chain=${AMEND.bps} bps with every other term unchanged; row + own ladder level updated`,
  );

  // ---- step 7: tape panel — indexer-backed, ASSERTED healthy ---------
  // (Codex round-2 P2 #3.) The market-scoped /loans/recent route is
  // production-healthy post-migration, so the tape must resolve to
  // real fills or the honest empty copy (`copy.desk.tapeEmpty`:
  // "No fills yet for this market.") — the unavailable copy
  // (`copy.desk.tapeUnavailable`: "We couldn't load recent fills right
  // now.") is a FAIL.
  const tapeCard = page.locator('.card').filter({ hasText: 'Recent fills' }).first();
  await tapeCard.waitFor({ timeout: 30_000 });
  const tapeEmpty = tapeCard.getByText('No fills yet for this market.', { exact: true });
  const tapeUnavailable = tapeCard.getByText(/couldn.t load recent fills right now/i);
  const tapeRows = tapeCard.locator('.desk-tape-row');
  await pollChain(
    'the tape to resolve out of its loading state',
    async () =>
      (await tapeEmpty.isVisible().catch(() => false)) ||
      (await tapeUnavailable.isVisible().catch(() => false)) ||
      (await tapeRows.count().catch(() => 0)) > 0,
    { timeoutMs: 45_000, intervalMs: 2_000 },
  );
  if (await tapeUnavailable.isVisible().catch(() => false)) {
    throw new Error(
      'tape rendered UNAVAILABLE (`copy.desk.tapeUnavailable`) — ' +
        'the indexer /loans/recent route regressed',
    );
  }
  const tapeFillCount = await tapeRows.count();
  record(
    '7. tape panel — indexer-backed fills healthy',
    'PASS',
    tapeFillCount > 0
      ? `${tapeFillCount} fill row(s) rendered`
      : 'honest market-scoped empty state ("No fills yet for this market.")',
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
  // Escrow refund proof (Codex round-1 P2 #2): cancel withdraws the
  // unfilled escrow (here: all of it) back to the creator's WALLET,
  // and no WETH was spent on gas — so the balance must return to
  // EXACTLY the pre-post snapshot.
  await pollChain(
    'lender wallet WETH to return exactly to the pre-post snapshot',
    async () => (await erc20Read(WETH, 'balanceOf', [lenderAddr])) === wethBeforePost,
    { timeoutMs: 60_000 },
  );
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
    `offer #${offerId} creator zeroed on-chain; wallet WETH restored to the exact ` +
      'pre-post balance (escrow refunded); row left Open orders + ladder',
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
  // cancel directly on-chain (waiting out the cooldown first). The
  // sweep covers EVERY id the append-only index gained since the
  // pre-post snapshot — not just the first (Codex round-1 P2 #4: a
  // duplicate create from one Post click must not leave a second
  // escrowed offer live) — and pages from the snapshot offset, so
  // >200 historical offers can't hide this run's (P2 #3). The tx can
  // mine AFTER a failure ("Order posted" renders at send time).
  if (!cancelled && beforePostTotal !== null) {
    try {
      if (offerId === null) {
        // Give a still-pending create a moment to mine, then sweep.
        await new Promise((r) => setTimeout(r, 15_000));
      }
      let sweepIds = await offerIdsAppendedSince(lenderAddr, beforePostTotal);
      if (sweepIds.length === 0 && postAttempted) {
        // Post WAS clicked, so a create tx may still sit in the
        // mempool (Codex round-2 P2 #1: "Order posted" renders at
        // SEND time, and Base Sepolia can hold a tx past the normal
        // 120 s poll + 15 s grace). An empty index delta here does
        // NOT prove "nothing escrowed" — keep watching the
        // append-only index for up to 3 more minutes.
        console.log(
          'cleanup: Post was clicked but the index delta is empty — ' +
            'extended watch (up to 180s) for a late-mining create…',
        );
        const extendedDeadline = Date.now() + 180_000;
        while (sweepIds.length === 0 && Date.now() < extendedDeadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          sweepIds = await offerIdsAppendedSince(lenderAddr, beforePostTotal);
        }
      }
      if (sweepIds.length === 0) {
        if (postAttempted) {
          // CLEANUP-UNKNOWN — NOT "cancelled": a create sent this run
          // could still mine after we exit, leaving a live escrowed
          // offer nobody is watching. Fail loudly with the pre-post
          // index total so the operator can check the delta manually.
          record(
            'cleanup: CLEANUP-UNKNOWN',
            'FAIL',
            'Post was clicked but no create surfaced in the offer index even ' +
              'after the extended watch — if the tx mines later, a live offer ' +
              `with ${AMOUNT_WETH} WETH escrowed will exist unwatched. Check ` +
              `getUserOffersPaginated(${lenderAddr}) on ${DIAMOND}: any id at ` +
              `offset >= ${beforePostTotal} (the pre-post total) is this run's — ` +
              'cancelOffer it manually after the 300 s cooldown.',
          );
        } else {
          cancelled = true; // Post never clicked — nothing could have escrowed
        }
      } else {
        const stillLive = [];
        for (const id of sweepIds) {
          try {
            const live = await getOffer(id);
            if (ZERO_CREATOR.test(String(live.creator))) continue; // already cancelled
            const now = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
            const wait = Math.max(0, Number(live.createdAt) + CANCEL_COOLDOWN_SECS + 5 - now);
            console.log(`cleanup: direct on-chain cancelOffer(#${id}) in ~${wait}s…`);
            await new Promise((r) => setTimeout(r, wait * 1000));
            const hash = await clientsFor(CHAIN_ID)
              .wallet('lender')
              .writeContract({
                address: DIAMOND,
                abi: ABI,
                functionName: 'cancelOffer',
                args: [id],
              });
            await pub.waitForTransactionReceipt({ hash });
            record('cleanup: direct on-chain cancel', 'PASS', `offer #${id} — tx ${hash}`);
          } catch (idErr) {
            stillLive.push(id);
            record(
              'cleanup: direct on-chain cancel',
              'FAIL',
              `OFFER #${id} MAY STILL BE LIVE WITH ESCROW HELD — cancel it ` +
                `manually (cancelOffer on ${DIAMOND}). ${idErr.message}`,
            );
          }
        }
        if (stillLive.length === 0) cancelled = true;
      }
    } catch (cleanupErr) {
      record(
        'cleanup: offer sweep',
        'FAIL',
        `could not enumerate this run's offers — offer #${offerId ?? '(unknown)'} ` +
          `may still be live with ${AMOUNT_WETH} WETH escrowed ` +
          `(cancelOffer on ${DIAMOND}). ${cleanupErr.message}`,
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
