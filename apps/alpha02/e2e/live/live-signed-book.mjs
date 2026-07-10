// #1131/#1145 post-merge live review — Rate Desk phase 3, the GASLESS
// signed-offer book on production alpha02: drive the sign-only posting
// mode end-to-end as the lender (market load → Gasless posting mode →
// ONE EIP-712 signature, ZERO transactions → the signed row lands on
// the indexer book + the ladder's "Signed" chip + the own-signed block
// in Open orders → on-chain cancelSignedOffer), with the ledger and
// order-hash asserts verified directly on the deployed Base Sepolia
// Diamond via viem, the wire asserts against the production indexer
// Worker, and — the observation the fork tier structurally cannot make
// (its stub has no WebSocket rail; spec 15 pins that posture) — the
// production PUSH rail observed from a Node-side WebSocket on
// `wss://<indexer>/ws/chain/84532`: after the cancel's ingest scan, an
// `invalidate` frame whose keys include 'offer.changed' (the key
// KEY_MAP maps to deskSignedBook, Codex #1145 r8) must arrive with
// `scannedTo` at/past the cancel block.
//
// This driver is the "live half" the COVERAGE.md phase-3 row deferred
// to the next live-review touch: the fork spec
// (tests/19-rate-desk-phase3.spec.ts) owns the exact wire-shape pins,
// the taker-fill loop and the §5.2 crossable-band both-directions
// math; this drive proves the maker journey against the deployed site,
// the real indexer Worker (migration 0033 applied), and the real
// Diamond. The crossable-band previewMatch strip is NOT reproducible
// live without seeding (and resting!) a contract-matchable crossed
// book on the public testnet, so this drive records its absence
// honestly (the driven market's book is not crossed) instead of
// pretending to exercise it — the band's full loop is fork-covered.
//
// Money discipline: a gasless post moves NOTHING on-chain — no escrow,
// no approval, no gas. The single real transaction in this drive is
// the on-chain cancelSignedOffer (gas only; `cancelSignedOffer` has NO
// cooldown — it is signer-only and immediate, unlike offer-cancel's
// 300 s window — verified against SignedOfferFacet.sol). The signed
// order itself is the rest-risk: until cancelled it is fillable by any
// taker against the maker's vault free balance, so the cleanup handler
// ALWAYS hunts the book for this run's signer+rate rows and cancels
// them directly on-chain if the primary UI cancel didn't happen,
// verifying the fill ledger reads the ceiling afterwards (the
// poison-to-ceiling IS the revocation). A signature that was created
// but never accepted by the book rests nowhere (the market-scoped GET
// is the book's only publication surface), but the run stays loud
// about any state it could not positively verify.
//
//   TESTNET_WALLETS_FILE=~/secrets/wallets.json node live-signed-book.mjs
//
// NB for the batch runner: ONE real testnet write (the cancel), no
// cooldown wait — but the drive blocks up to ~5 minutes on the genuine
// indexer ingest cadence (the round-robin scan that flips the
// cancelled row's status and pushes the WS invalidate frame). It
// self-cleans, so batch inclusion is safe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnits } from 'viem';
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
// (packages/contracts/src), mirroring live-rate-desk.mjs so this driver
// can never drift from the app's own address/ABI source. --------------
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

const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
];

// ---- indexer wire (same conventions as live-rate-desk.mjs) ----------
const INDEXER = process.env.INDEXER_ORIGIN ?? 'https://indexer.vaipakam.com';
// wss:// origin derived from the probe origin — the same derivation the
// app's indexerWsOrigin() performs on VITE_INDEXER_ORIGIN.
const INDEXER_WS = INDEXER.replace(/^http/, 'ws');

/** GET an indexer route; returns { status, headers, body } with the
 *  body parsed leniently (null on non-JSON). Bounded — a hung fetch
 *  must never keep the run from its cleanup. */
async function indexerGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

/** Validate an address loaded from a bundle/wallet FILE and rebuild it
 *  numerically before it may enter a probe URL (CodeQL
 *  js/file-data-in-outbound-network-request) — same helper as
 *  live-rate-desk.mjs. */
function asAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} is not a 0x-40-hex address: "${value}"`);
  }
  return `0x${BigInt(value).toString(16).padStart(40, '0')}`;
}

function signedBookUrl(days) {
  return (
    `${INDEXER}/signed-offers?chainId=${CHAIN_ID}` +
    `&lendingAsset=${asAddress(WETH, 'bundle weth')}` +
    `&collateralAsset=${asAddress(TLIQ, 'bundle liquidToken')}` +
    `&durationDays=${days}`
  );
}

// Distinctive rate on purpose — nothing else on the live book quotes
// it, so a Signed-chip ladder level at this rate is unambiguously THIS
// run's row (phase-1's 8.43/11.27 stay reserved for live-rate-desk).
const POST = { bps: 931, text: '9.31', pct: '9.31%' };
// Tiny on purpose: the signed commitment must sit comfortably inside
// the lender vault's FREE WETH (~0.0129 at the time of writing) so the
// ticket's escrow-reality preflight has no reason to warn — the drive
// asserts the warning's ABSENCE as part of the happy path.
const AMOUNT_WETH = '0.0001';
const COLLATERAL_TLIQ = '5';
// Same preference order as the fork spec + live-rate-desk. A signed
// order consumes no on-chain tenor bucket, but an empty bucket keeps
// the driven ladder free of third-party levels.
const BUCKET_PREFERENCE = [60, 90, 14, 180, 7, 30];
// The indexer's ingest scan is alarm-driven round-robin (~3 min per
// chain in steady state) — the post-cancel milestones (row leaving the
// book, WS invalidate frame) poll generously past one full cycle.
const SCAN_WAIT_MS = 330_000;

const [WETH_DECIMALS, TLIQ_DECIMALS] = await Promise.all([
  pub.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'decimals' }),
  pub.readContract({ address: TLIQ, abi: ERC20_ABI, functionName: 'decimals' }),
]);
const EXPECTED_AMOUNT = parseUnits(AMOUNT_WETH, WETH_DECIMALS);
const EXPECTED_COLLATERAL = parseUnits(COLLATERAL_TLIQ, TLIQ_DECIMALS);
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---- step ledger — PASS/OBSERVED/FAIL per drive step -----------------
const steps = [];
const shotPaths = [];
function record(name, status, detail = '') {
  steps.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- chain read helpers ----------------------------------------------
const diamondRead = (functionName, args) =>
  pub.readContract({ address: DIAMOND, abi: ABI, functionName, args });

/** Wire order (all-strings JSON) → the typed struct viem's ABI encoder
 *  expects for `cancelSignedOffer` / `signedOfferOrderHash` — the same
 *  mapping as the app's `signedOfferTypedMessage`. */
function wireToStruct(o) {
  return {
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset,
    amount: BigInt(o.amount),
    amountMax: BigInt(o.amountMax),
    interestRateBps: BigInt(o.interestRateBps),
    interestRateBpsMax: BigInt(o.interestRateBpsMax),
    collateralAsset: o.collateralAsset,
    collateralAmount: BigInt(o.collateralAmount),
    collateralAmountMax: BigInt(o.collateralAmountMax),
    durationDays: BigInt(o.durationDays),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    tokenId: BigInt(o.tokenId),
    quantity: BigInt(o.quantity),
    collateralTokenId: BigInt(o.collateralTokenId),
    collateralQuantity: BigInt(o.collateralQuantity),
    prepayAsset: o.prepayAsset,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    expiresAt: BigInt(o.expiresAt),
    fillMode: Number(o.fillMode),
    periodicInterestCadence: Number(o.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
    useFullTermInterest: o.useFullTermInterest,
    signer: o.signer,
    nonce: BigInt(o.nonce),
    deadline: BigInt(o.deadline),
  };
}

/** The order's principal ceiling — mirrors `SignedOfferFacet._ceiling`:
 *  `amountMax == 0 ? amount : amountMax`. The cancel poisons the fill
 *  ledger to exactly this value. */
const ceilingOf = (o) =>
  BigInt(o.amountMax) === 0n ? BigInt(o.amount) : BigInt(o.amountMax);

async function pollFor(label, fn, { timeoutMs = 120_000, intervalMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** True once the account's PENDING tx count equals its LATEST count —
 *  this process's injected wallet is the account's only signer, so
 *  equal nonces prove no tx from this run is still in flight (same
 *  gate live-rate-desk.mjs uses before trusting its cleanup sweep). */
async function noncesSettled(address, { timeoutMs = 120_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [pending, latest] = await Promise.all([
      pub.getTransactionCount({ address, blockTag: 'pending' }),
      pub.getTransactionCount({ address, blockTag: 'latest' }),
    ]);
    if (pending === latest) return true;
    if (Date.now() > deadline) return false;
    console.log(
      `cleanup: tx in flight for ${address} (nonce pending=${pending} > latest=${latest}) — waiting…`,
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A WETH/tLIQ tenor bucket with no live ON-CHAIN offers right now
 *  (keeps the driven ladder free of third-party levels); falls back to
 *  the least-populated bucket if every one is taken. */
async function pickTenor() {
  const [rankings] = await diamondRead('getActiveOffersByAssetPairRanked', [WETH, TLIQ]);
  const counts = new Map();
  for (const r of rankings) {
    const d = Number(r.durationDays);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  for (const d of BUCKET_PREFERENCE) if (!counts.has(d)) return d;
  return [...BUCKET_PREFERENCE].sort(
    (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0),
  )[0];
}

// ---- WS collector — the production push rail, observed from Node ----
// The page's own WebSocket cannot carry this observation in the
// sandbox (driver.mjs routes page traffic through undici precisely
// because the egress gateway resets Chromium TLS, and route() does not
// cover WebSockets) — so the rail is observed from THIS process, which
// rides the same optional LIVE_PROXY_SETUP dispatcher swap as every
// other probe. Frames are timestamped at arrival; the collector
// auto-reconnects so a mid-drive idle close can't blind the post-cancel
// observation window (a gap is recorded either way).
function startWsCollector(url) {
  const frames = [];
  const lifecycle = [];
  let socket = null;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(url);
    lifecycle.push({ at: Date.now(), ev: 'connect' });
    socket.addEventListener('message', (ev) => {
      let obj = null;
      try {
        obj = JSON.parse(String(ev.data));
      } catch {
        /* non-JSON frame — recorded raw */
      }
      frames.push({ at: Date.now(), obj, raw: String(ev.data) });
    });
    socket.addEventListener('close', (ev) => {
      lifecycle.push({ at: Date.now(), ev: `close ${ev.code}` });
      if (!stopped) setTimeout(connect, 2_000);
    });
    socket.addEventListener('error', () => {
      lifecycle.push({ at: Date.now(), ev: 'error' });
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    });
  };
  connect();
  return {
    frames,
    lifecycle,
    stop: () => {
      stopped = true;
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ---- UI helpers (same idioms as live-rate-desk.mjs) ------------------
/** Consent tick + wait-enabled: late disclosures legitimately RESET the
 *  checkbox, so keep re-ticking until every gate clears. */
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

// ----------------------------------------------------------------------
const lenderAddr = addressOf('lender');
const tenor = await pickTenor();
console.log(
  `run: lender=${lenderAddr} market=WETH/tLIQ tenor=${tenor}d site=${SITE}` +
    ` indexer=${INDEXER} ws=${INDEXER_WS}/ws/chain/${CHAIN_ID} (phase 3 gasless signed book)`,
);

const { page, shot, done, consoleErrors, rpcLog } = await launch({ role: 'lender' });
const snap = async (name) => shotPaths.push(await shot(name));

let failed = false;
// The signed row this run put on the book — module scope so the
// cleanup can revoke it even when the drive fails between milestones.
let orderHash = null;
let wireOrder = null; // the exact replay payload GET served (cancel needs it)
let signClicked = false; // a signature may exist from here on
let ledgerPoisoned = false; // signedOfferFilledAmount(orderHash) == ceiling verified
let cancelTxHash = null;
let ws = null;

// Own-signed ladder level for THIS run's distinctive rate.
const signedLadderRow = () =>
  page
    .locator('.desk-ladder-row')
    .filter({ hasText: POST.pct })
    .filter({ has: page.locator('.desk-signed-chip') });

try {
  // ---- step 1: preflight — vault funding + the production wire ------
  // The gasless post escrows nothing, but the ticket's escrow-reality
  // check reads the maker's VAULT free balance (tracked − encumbered;
  // createSignedOfferVault funds fills from vault free balance, so the
  // wallet would be the wrong pocket) and warns on shortfall. The
  // drive wants the CLEAN path, so the order size must sit inside the
  // live free balance — assert that before touching the UI.
  const [tracked, encumbered] = await Promise.all([
    diamondRead('getProtocolTrackedVaultBalance', [lenderAddr, WETH]),
    diamondRead('getEncumbered', [lenderAddr, WETH, 0n]),
  ]);
  const freeWeth = tracked > encumbered ? tracked - encumbered : 0n;
  if (freeWeth < EXPECTED_AMOUNT) {
    throw new Error(
      `lender vault free WETH ${freeWeth} < the ${EXPECTED_AMOUNT} this drive ` +
        'commits — deposit WETH to the vault (or shrink AMOUNT_WETH) before running',
    );
  }
  // The production route the whole drive rides: market-scoped GET must
  // 200 with the { chainId, offers } shape and `no-store` (the desk's
  // mutation flows refetch this URL expecting fresh state — a cached
  // body would replay a cancelled row; Codex #1145 r8 P3).
  const probe = await indexerGet(signedBookUrl(tenor));
  const cacheControl = probe.headers?.get('cache-control') ?? '';
  if (
    probe.status !== 200 ||
    probe.body?.chainId !== CHAIN_ID ||
    !Array.isArray(probe.body?.offers)
  ) {
    throw new Error(
      `GET /signed-offers probe failed — status ${probe.status}, ` +
        `body ${JSON.stringify(probe.body)?.slice(0, 300)}`,
    );
  }
  if (!/no-store/i.test(cacheControl)) {
    throw new Error(
      `GET /signed-offers Cache-Control is "${cacheControl}" — expected no-store ` +
        '(the #1145 r8 header; a cacheable body can replay a cancelled row)',
    );
  }
  record(
    '1. preflight — vault funding + production /signed-offers route',
    'PASS',
    `vault free WETH=${freeWeth} (≥ ${EXPECTED_AMOUNT} committed); ` +
      `GET 200, Cache-Control "${cacheControl}", ${probe.body.offers.length} ` +
      `pre-existing row(s) on WETH/tLIQ@${tenor}d`,
  );
  // Ingest-freshness gate for the step-7 observations: the signed-book
  // LIFECYCLE flip (row leaving GET after cancel) and the WS invalidate
  // frame both ride the chain-ingest scan. A stalled cursor makes them
  // structurally unobservable no matter how long step 7 polls — say so
  // NOW, loudly, so a step-7 timeout later reads as the environment
  // incident it is (first hit live 2026-07-10: cursor wedged ~14 h at
  // block 43949149 while Arb Sepolia's cursor was current — a
  // chain-scoped ingest stall that predated the phase-3 deploy).
  const statsProbe = await indexerGet(`${INDEXER}/offers/stats?chainId=${CHAIN_ID}`);
  const ingestCursor = statsProbe.body?.indexer ?? null;
  const cursorAgeSec =
    ingestCursor?.updatedAt != null
      ? Math.round(Date.now() / 1000 - ingestCursor.updatedAt)
      : null;
  record(
    '1b. ingest cursor freshness (step-7 precondition)',
    'OBSERVED',
    ingestCursor
      ? `lastBlock=${ingestCursor.lastBlock}, advanced ${cursorAgeSec}s ago` +
        (cursorAgeSec > 600
          ? ' — STALE (>10 min): the post-cancel lifecycle + push observations ' +
            'will time out until production ingest recovers'
          : '')
      : `unavailable (status ${statsProbe.status}) — freshness unknown`,
  );

  // ---- step 2: the production WS push rail — hello handshake --------
  ws = startWsCollector(`${INDEXER_WS}/ws/chain/${CHAIN_ID}`);
  const hello = await pollFor(
    'the WS hello frame',
    async () => ws.frames.find((f) => f.obj?.t === 'hello'),
    { timeoutMs: 20_000, intervalMs: 500 },
  );
  if (hello.obj.chainId !== CHAIN_ID) {
    throw new Error(
      `WS hello answered for chain ${hello.obj.chainId}, expected ${CHAIN_ID}`,
    );
  }
  record(
    '2. WS rail connected (production push, Node-side observer)',
    'PASS',
    `hello frame: chainId=${hello.obj.chainId}, ingestActive=${hello.obj.ingestActive}` +
      (hello.obj.ingestActive
        ? ''
        : ' — WARNING: ingest reports inactive; the post-cancel push may not come'),
  );

  // ---- step 3: load the market, arm the gasless ticket ---------------
  await page.goto(`${SITE}/desk`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: 'Rate Desk', level: 1 })
    .waitFor({ timeout: 30_000 });
  await chooseMenuValue(page, 'desk-pair', '__custom__');
  await page.locator('#desk-custom-lend').fill(WETH);
  await page.locator('#desk-custom-coll').fill(TLIQ);
  await page.getByRole('button', { name: 'Load market' }).click();
  await selectTenor(page, tenor);
  const emptyCopy = page.getByText(/no open offers for this market yet/i);
  const ladder = page.locator('.desk-ladder');
  await Promise.race([
    emptyCopy.waitFor({ timeout: 45_000 }),
    ladder.waitFor({ timeout: 45_000 }),
  ]);
  await ensureConnected(page);
  await page.getByRole('button', { name: 'Lend', exact: true }).click();
  await page.locator('#desk-amount').fill(AMOUNT_WETH);
  await page.locator('#desk-rate').fill(POST.text);
  await page.locator('#desk-collateral-amount').fill(COLLATERAL_TLIQ);
  await page
    .getByRole('group', { name: 'Expiry' })
    .getByRole('button', { name: 'GTC', exact: true })
    .click();

  // The AON-forcing observation needs the PRE-state pinned: in on-chain
  // mode the ticket's fill-mode default is Partial — switching to
  // gasless as the lender must auto-flip it to AON and disable the
  // Partial chip (a ranged/sliceable lender signed order can never pass
  // the matcher's constant-ratio check; #1145 round-2).
  const fillGroup = page.getByRole('group', { name: 'Fill mode' });
  const partialChip = fillGroup.getByRole('button', { name: 'Partial', exact: true });
  const aonChip = fillGroup.getByRole('button', { name: 'AON', exact: true });
  if (!/\bactive\b/.test((await partialChip.getAttribute('class')) ?? '')) {
    throw new Error('pre-state: Partial is not the active fill mode in on-chain mode');
  }
  await page
    .getByRole('group', { name: 'Posting' })
    .getByRole('button', { name: 'Gasless (sign only)', exact: true })
    .click();
  await pollFor(
    'the gasless lender AON auto-flip',
    async () =>
      /\bactive\b/.test((await aonChip.getAttribute('class')) ?? '') &&
      (await partialChip.isDisabled()),
    { timeoutMs: 10_000, intervalMs: 500 },
  );
  const aonNote = page.getByText(/gasless lend orders fill only as one whole loan/i);
  const escrowNote = page.getByText(/nothing is escrowed when you sign/i);
  if (!(await aonNote.first().isVisible().catch(() => false))) {
    throw new Error('gasless lender AON note not rendered after the mode switch');
  }
  if (!(await escrowNote.isVisible().catch(() => false))) {
    throw new Error(
      'gasless escrow note not rendered — either the mode chip did not take ' +
        'or the deployed app has no indexer origin configured',
    );
  }
  await snap('signed-book-01-gasless-armed');
  record(
    '3. ticket armed in Gasless sign-only mode',
    'PASS',
    `WETH/tLIQ@${tenor}d, lend ${AMOUNT_WETH} WETH @ ${POST.pct}, ` +
      `${COLLATERAL_TLIQ} tLIQ, GTC; Partial→AON auto-flip observed ` +
      '(Partial chip disabled, AON active, honest note rendered)',
  );

  // ---- step 4: Sign & post — ZERO transactions ------------------------
  // The gasless property itself, pinned at BOTH boundaries: the
  // injected provider's eth_sendTransaction count (the same
  // sentTransactions pin the fork spec uses) and the account's on-chain
  // pending nonce must be unchanged across the whole post.
  const sendsBefore = rpcLog.filter((m) => m === 'eth_sendTransaction').length;
  const typedSignsBefore = rpcLog.filter((m) => m === 'eth_signTypedData_v4').length;
  const nonceBefore = await pub.getTransactionCount({
    address: lenderAddr,
    blockTag: 'pending',
  });
  const signBtn = page.getByRole('button', { name: /^sign & post to the book$/i });
  await consentAndWaitEnabled(page, signBtn);
  signClicked = true; // a valid signature may exist from here on
  await signBtn.click();
  // Sign-only: several live chain READS (sanctions, caps, paused
  // assets, chain-time deadline anchor, vault preflight) + one
  // EIP-712 signature + one POST — generous but far below tx time.
  await page
    .getByText(/signed order posted to the book — no gas spent/i)
    .waitFor({ timeout: 90_000 });
  const sendsAfter = rpcLog.filter((m) => m === 'eth_sendTransaction').length;
  const typedSignsAfter = rpcLog.filter((m) => m === 'eth_signTypedData_v4').length;
  const nonceAfter = await pub.getTransactionCount({
    address: lenderAddr,
    blockTag: 'pending',
  });
  if (sendsAfter !== sendsBefore) {
    throw new Error(
      `gasless post sent ${sendsAfter - sendsBefore} transaction(s) through the ` +
        'injected wallet — the sign-only mode is not gasless',
    );
  }
  if (nonceAfter !== nonceBefore) {
    throw new Error(
      `lender pending nonce moved ${nonceBefore}→${nonceAfter} across the gasless ` +
        'post — something transacted on-chain',
    );
  }
  if (typedSignsAfter - typedSignsBefore !== 1) {
    throw new Error(
      `expected exactly 1 eth_signTypedData_v4 for the post, saw ` +
        `${typedSignsAfter - typedSignsBefore}`,
    );
  }
  // The escrow-reality warning must NOT have fired — step 1 proved the
  // vault free balance covers the commitment.
  if (
    await page
      .getByText(/vault.s free balance is below/i)
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error(
      'vault-funding warning rendered although step 1 verified free balance ' +
        'covers the order — the preflight read the wrong pocket',
    );
  }
  await snap('signed-book-02-posted');
  record(
    '4. gasless post — ONE signature, ZERO transactions',
    'PASS',
    `success copy rendered; eth_sendTransaction delta 0, eth_signTypedData_v4 ` +
      `delta 1, pending nonce pinned at ${nonceAfter}; no vault-funding warning. ` +
      'NB deployed behaviour: the success copy does not print the order hash — ' +
      'row identity is proven in step 5 via the wire + the Diamond hash view',
  );

  // ---- step 5: the row lands — wire, chain-hash cross-check, ladder,
  // own-signed block ----------------------------------------------------
  // The POST writes D1 synchronously, so the row should be served on
  // the next GET; poll briefly for wire/network slack. Identity: OUR
  // signer + THIS run's distinctive rate.
  const row = await pollFor(
    "this run's signed row on GET /signed-offers",
    async () => {
      const res = await indexerGet(signedBookUrl(tenor));
      if (res.status !== 200 || !Array.isArray(res.body?.offers)) return undefined;
      return res.body.offers.find(
        (r) =>
          sameAddr(r.signer, lenderAddr) &&
          r.order?.interestRateBps === String(POST.bps) &&
          r.order?.amountMax === EXPECTED_AMOUNT.toString(),
      );
    },
    { timeoutMs: 45_000, intervalMs: 3_000 },
  );
  orderHash = row.orderHash;
  wireOrder = row.order;
  // Chain-side identity: the Diamond's own pure hash view over the
  // EXACT wire payload must reproduce the indexer's key — proves the
  // stored replay payload hashes to the ledger key a fill would use.
  const chainHash = await diamondRead('signedOfferOrderHash', [wireToStruct(wireOrder)]);
  if (!sameAddr(chainHash, orderHash)) {
    throw new Error(
      `Diamond signedOfferOrderHash(${chainHash}) != indexer orderHash (${orderHash}) ` +
        '— the stored replay payload does not hash to the served key',
    );
  }
  // The collapsed single-value AON shape (#1145 round-2) on the wire.
  const wireMismatches = [
    row.status === 'active' ? null : `status=${row.status}`,
    wireOrder.amount === EXPECTED_AMOUNT.toString() ? null : `amount=${wireOrder.amount}`,
    wireOrder.amountMax === EXPECTED_AMOUNT.toString()
      ? null
      : `amountMax=${wireOrder.amountMax}`,
    wireOrder.fillMode === '1' ? null : `fillMode=${wireOrder.fillMode} (expected AON=1)`,
    wireOrder.interestRateBpsMax === '10000'
      ? null
      : `interestRateBpsMax=${wireOrder.interestRateBpsMax}`,
    wireOrder.collateralAmount === EXPECTED_COLLATERAL.toString()
      ? null
      : `collateralAmount=${wireOrder.collateralAmount}`,
    wireOrder.collateralAmountMax === EXPECTED_COLLATERAL.toString()
      ? null
      : `collateralAmountMax=${wireOrder.collateralAmountMax}`,
    wireOrder.durationDays === String(tenor) ? null : `durationDays=${wireOrder.durationDays}`,
    wireOrder.expiresAt === '0' ? null : `expiresAt=${wireOrder.expiresAt} (expected GTC=0)`,
    BigInt(wireOrder.deadline) > 0n ? null : `deadline=${wireOrder.deadline} (GTC policy = chainNow+7d)`,
    sameAddr(wireOrder.lendingAsset, WETH) ? null : `lendingAsset=${wireOrder.lendingAsset}`,
    sameAddr(wireOrder.collateralAsset, TLIQ) ? null : `collateralAsset=${wireOrder.collateralAsset}`,
    row.filledAmount === '0' ? null : `filledAmount=${row.filledAmount}`,
  ].filter(Boolean);
  if (wireMismatches.length) {
    throw new Error(`signed row wire-shape mismatch: ${wireMismatches.join(', ')}`);
  }
  // Fresh order — the on-chain fill ledger must read 0.
  const ledgerAtPost = await diamondRead('signedOfferFilledAmount', [orderHash]);
  if (ledgerAtPost !== 0n) {
    throw new Error(
      `signedOfferFilledAmount(${orderHash}) reads ${ledgerAtPost} on a fresh order`,
    );
  }
  // UI: the ladder level at our rate carries the Signed chip and the
  // own marker (the maker's own signed depth). The post path's targeted
  // deskSignedBook invalidation makes this near-immediate.
  await signedLadderRow().first().waitFor({ timeout: 60_000 });
  const ladderRowClass = (await signedLadderRow().first().getAttribute('class')) ?? '';
  if (!/\bdesk-own\b/.test(ladderRowClass)) {
    throw new Error(
      `the ${POST.pct} Signed ladder row is not marked as own (class="${ladderRowClass}")`,
    );
  }
  // UI: the own-signed block in Open orders — market-scoped, with the
  // Signed chip, the short order hash, and the on-chain cancel armed.
  const shortHash = `${orderHash.slice(0, 6)}…${orderHash.slice(-4)}`;
  await page.getByText('Signed orders (this market)').waitFor({ timeout: 30_000 });
  const signedRowUi = page.locator('.item-row').filter({ hasText: shortHash });
  await signedRowUi.waitFor({ timeout: 30_000 });
  const cancelBtn = signedRowUi.getByRole('button', { name: 'Cancel on-chain' });
  await cancelBtn.waitFor({ timeout: 15_000 });
  // Phase-3 slice B honesty note: the crossable-band previewMatch strip
  // must be ABSENT on this un-crossed book (rendering it would violate
  // the §5.2 rule the band is built on). Not a crossed-book exercise —
  // that loop is fork-covered (spec 19).
  const bandAbsent = (await page.locator('.desk-match-band').count()) === 0;
  await snap('signed-book-03-row-landed');
  record(
    '5. signed row landed — wire + chain cross-check + both UI surfaces',
    'PASS',
    `orderHash=${orderHash} (Diamond signedOfferOrderHash matches); wire shape ` +
      `single-value AON, deadline=${wireOrder.deadline}; ledger reads 0; ladder ` +
      `level ${POST.pct} carries the Signed chip + own marker; own-signed block ` +
      'lists the row with Cancel on-chain armed',
  );
  record(
    '5b. crossable-band previewMatch strip',
    'OBSERVED',
    bandAbsent
      ? 'absent on this un-crossed book — the honest §5.2 state; the matchable ' +
        'loop is fork-covered (spec 19) and needs a seeded crossed book to show live'
      : 'a match band rendered on the driven market (crossed book present this run)',
  );

  // ---- step 6: cancel on-chain — the ONLY revocation -------------------
  // cancelSignedOffer has NO cooldown (signer-only, immediate — unlike
  // offer-cancel's 300 s window). It poisons the fill ledger to the
  // ceiling; the indexer's next scan flips the row and the push rail
  // must carry offer.changed (→ deskSignedBook per KEY_MAP).
  const preCancelBlock = await pub.getBlockNumber();
  await cancelBtn.click();
  await page
    .getByText(/signed order cancelled on-chain/i)
    .waitFor({ timeout: 150_000 });
  const cancelledEvt = ABI.find((e) => e.type === 'event' && e.name === 'SignedOfferCancelled');
  if (!cancelledEvt) throw new Error('SignedOfferCancelled missing from the bundled ABI');
  const cancelLogs = await pollFor(
    'the SignedOfferCancelled log',
    async () => {
      const logs = await pub.getLogs({
        address: DIAMOND,
        event: cancelledEvt,
        args: { orderHash },
        fromBlock: preCancelBlock,
        toBlock: 'latest',
      });
      return logs.length ? logs : undefined;
    },
    { timeoutMs: 90_000 },
  );
  cancelTxHash = cancelLogs[0].transactionHash;
  const receipt = await pub.getTransactionReceipt({ hash: cancelTxHash });
  if (receipt.status !== 'success') {
    throw new Error(`cancel tx ${cancelTxHash} mined but reverted`);
  }
  const cancelObservedAt = Date.now();
  // (a) the ledger poisoned to the ceiling — the revocation itself.
  const ceiling = ceilingOf(wireOrder);
  const ledgerAfter = await diamondRead('signedOfferFilledAmount', [orderHash]);
  if (ledgerAfter !== ceiling) {
    throw new Error(
      `signedOfferFilledAmount(${orderHash}) reads ${ledgerAfter} after cancel — ` +
        `expected the ceiling ${ceiling}`,
    );
  }
  ledgerPoisoned = true;
  await snap('signed-book-04-cancelled');
  record(
    '6. cancelSignedOffer on-chain (no cooldown)',
    'PASS',
    `tx ${cancelTxHash} (block ${receipt.blockNumber}); ledger poisoned to the ` +
      `ceiling ${ceiling} — the signature is dead`,
  );

  // ---- step 7: the indexer + push rail catch up ------------------------
  // Two independent milestones over the same scan (~3 min round-robin;
  // poll past one full cycle): the row leaving the market-scoped GET
  // (status flip to 'cancelled' — GET serves active only), and the WS
  // invalidate frame with offer.changed at/past the cancel block. The
  // frame criterion is block-pinned via scannedTo so an unrelated
  // earlier scan's offer.changed can't be credited.
  let wireGoneAt = null;
  let creditedFrame = null;
  const scanMilestones = pollFor(
    'the cancelled row to leave GET /signed-offers AND the offer.changed push frame',
    async () => {
      if (wireGoneAt === null) {
        const res = await indexerGet(signedBookUrl(tenor));
        if (
          res.status === 200 &&
          Array.isArray(res.body?.offers) &&
          !res.body.offers.some((r) => r.orderHash === orderHash)
        ) {
          wireGoneAt = Date.now();
          console.log(
            `  milestone: row left /signed-offers +${((wireGoneAt - cancelObservedAt) / 1000).toFixed(0)}s after cancel`,
          );
        }
      }
      if (creditedFrame === null) {
        creditedFrame =
          ws.frames.find(
            (f) =>
              f.obj?.t === 'invalidate' &&
              Array.isArray(f.obj.keys) &&
              f.obj.keys.includes('offer.changed') &&
              Number(f.obj.scannedTo) >= Number(receipt.blockNumber),
          ) ?? null;
        if (creditedFrame) {
          console.log(
            `  milestone: offer.changed push frame +${((creditedFrame.at - cancelObservedAt) / 1000).toFixed(0)}s ` +
              `after cancel (scannedTo=${creditedFrame.obj.scannedTo})`,
          );
        }
      }
      return wireGoneAt !== null && creditedFrame !== null;
    },
    { timeoutMs: SCAN_WAIT_MS, intervalMs: 5_000 },
  );
  try {
    await scanMilestones;
  } catch (scanErr) {
    // Timed out — diagnose WHICH failure this is before rethrowing:
    // an ingest cursor still short of the cancel block means the scan
    // never ran over the cancel at all (environment: production ingest
    // stalled — the phase-3 lifecycle handlers were never given the
    // event), while a cursor PAST the cancel block with the row still
    // active / no frame is a genuine phase-3 lifecycle/push regression.
    const stats = await indexerGet(
      `${INDEXER}/offers/stats?chainId=${CHAIN_ID}`,
    ).catch(() => null);
    const cur = stats?.body?.indexer ?? null;
    if (cur && Number(cur.lastBlock) < Number(receipt.blockNumber)) {
      throw new Error(
        `${scanErr.message} — DIAGNOSIS: production ingest is STALLED for this ` +
          `chain (cursor at block ${cur.lastBlock}, last advanced ` +
          `${Math.round(Date.now() / 1000 - cur.updatedAt)}s ago; the cancel is at ` +
          `block ${receipt.blockNumber}, never scanned). Environment incident — ` +
          'the signed-offer lifecycle handlers + push rail were never handed the ' +
          'event; re-run once the cursor advances past the cancel block.',
      );
    }
    throw new Error(
      `${scanErr.message} — ingest cursor ${cur ? `at block ${cur.lastBlock}` : 'unreadable'} ` +
        `is PAST the cancel block ${receipt.blockNumber} (or unknown): the scan ran ` +
        'and the row/frame still did not materialize — treat as a signed-book ' +
        'lifecycle/push regression.',
    );
  }
  const invalidateCount = ws.frames.filter((f) => f.obj?.t === 'invalidate').length;
  record(
    '7. indexer scan + WS push after the cancel',
    'PASS',
    `row left /signed-offers +${((wireGoneAt - cancelObservedAt) / 1000).toFixed(0)}s; ` +
      `invalidate frame keys=[${creditedFrame.obj.keys.join(', ')}] ` +
      `scannedTo=${creditedFrame.obj.scannedTo} (cancel block ${receipt.blockNumber}) ` +
      `+${((creditedFrame.at - cancelObservedAt) / 1000).toFixed(0)}s; ` +
      `${invalidateCount} invalidate frame(s) total this drive — ` +
      'the fork tier cannot make this observation (no WS rail); observed live here',
  );

  // ---- step 8: the UI lets the dead row go ------------------------------
  // The page in this sandbox has NO WebSocket (driver.mjs routes page
  // traffic through undici; route() does not cover WS), so the UI here
  // converges via the 30 s poll — the push-rail half was proven in
  // step 7 from the Node observer. A tab flip nudges a remount refetch
  // (staleTime 15 s) to keep the assert snappy.
  await page.getByRole('button', { name: 'Positions', exact: true }).click();
  await page.getByRole('button', { name: 'Open orders', exact: true }).click();
  await pollFor(
    'the cancelled signed row to leave the ladder and the own-signed block',
    async () =>
      (await signedLadderRow().count()) === 0 &&
      (await page.locator('.item-row').filter({ hasText: shortHash }).count()) === 0,
    { timeoutMs: 120_000, intervalMs: 5_000 },
  );
  await snap('signed-book-05-row-gone');
  record(
    '8. UI converged — Signed row left the ladder + own-signed block',
    'PASS',
    'poll-path convergence (the sandboxed page has no WS; the live rail was ' +
      'proven Node-side in step 7)',
  );
} catch (err) {
  failed = true;
  record('drive', 'FAIL', err.message);
  await snap('signed-book-99-failure').catch(() => {});
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '(page text unavailable)');
  console.log('--- page text at failure ---\n' + body.slice(0, 4_000) + '\n---');
} finally {
  // Never leave this run's signed order revocable-but-live: an
  // uncancelled signed row is fillable by ANY taker against the vault
  // free balance until its deadline. The ledger poison is the only
  // real revocation, so the cleanup drives it directly on-chain when
  // the primary UI cancel didn't get there.
  try {
    if (signClicked && !ledgerPoisoned) {
      // Recover the replay payload if the drive failed before step 5
      // enumerated it — the market-scoped GET is the book's only
      // publication surface, so this run's signer+rate rows there are
      // exactly the orders that could rest.
      if (wireOrder === null) {
        try {
          const res = await indexerGet(signedBookUrl(tenor));
          const mine = (res.body?.offers ?? []).find(
            (r) =>
              sameAddr(r.signer, lenderAddr) &&
              r.order?.interestRateBps === String(POST.bps),
          );
          if (mine) {
            orderHash = mine.orderHash;
            wireOrder = mine.order;
          }
        } catch {
          /* handled below — wireOrder stays null */
        }
      }
      if (wireOrder === null) {
        // No row on the book: either the POST never succeeded (the
        // signature was never published anywhere) or the book is
        // unreachable. The first rests nothing; the second cannot be
        // verified from here — stay loud.
        record(
          'cleanup: signed order',
          'FAIL',
          'sign was clicked but no matching row could be read back from ' +
            `${INDEXER}/signed-offers — if the POST did land, a live signed order ` +
            `for ${AMOUNT_WETH} WETH @ ${POST.pct} rests under signer ${lenderAddr}. ` +
            'Re-run the book GET when the indexer is reachable and cancelSignedOffer ' +
            'it (or invalidateSignedOfferNonce its nonce) manually.',
        );
      } else {
        const ledger = await diamondRead('signedOfferFilledAmount', [orderHash]);
        const ceiling = ceilingOf(wireOrder);
        if (ledger >= ceiling) {
          ledgerPoisoned = true; // already consumed/cancelled — nothing rests
          record(
            'cleanup: signed order',
            'PASS',
            `ledger already reads the ceiling for ${orderHash} — order not fillable`,
          );
        } else {
          console.log(`cleanup: direct on-chain cancelSignedOffer(${orderHash})…`);
          const hash = await clientsFor(CHAIN_ID)
            .wallet('lender')
            .writeContract({
              address: DIAMOND,
              abi: ABI,
              functionName: 'cancelSignedOffer',
              args: [wireToStruct(wireOrder)],
            });
          const receipt = await pub.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') {
            throw new Error(`cleanup cancel tx ${hash} mined but reverted`);
          }
          const after = await diamondRead('signedOfferFilledAmount', [orderHash]);
          if (after !== ceiling) {
            throw new Error(
              `cleanup cancel mined but ledger reads ${after}, expected ${ceiling}`,
            );
          }
          ledgerPoisoned = true;
          cancelTxHash = cancelTxHash ?? hash;
          record(
            'cleanup: direct on-chain cancel',
            'PASS',
            `order ${orderHash} — tx ${hash} (receipt success, ledger at ceiling)`,
          );
        }
      }
    }
    // Settle gate — a cancel tx from the UI click could still be in
    // flight; never exit claiming a state a pending tx may change.
    if (signClicked && !(await noncesSettled(lenderAddr))) {
      record(
        'cleanup: CLEANUP-UNKNOWN',
        'FAIL',
        'the lender account still has an in-flight tx after 120 s — re-verify ' +
          `signedOfferFilledAmount(${orderHash ?? '(unknown)'}) on ${DIAMOND} manually`,
      );
    }
  } catch (cleanupErr) {
    record(
      'cleanup: signed order',
      'FAIL',
      `ORDER ${orderHash ?? '(unknown)'} MAY STILL BE FILLABLE — cancelSignedOffer ` +
        `it manually on ${DIAMOND} (signer ${lenderAddr}). ${cleanupErr.message}`,
    );
  }
  ws?.stop();
  await done().catch(() => {});
}

// ---- structured summary ------------------------------------------------
console.log('\n━━━ live-signed-book summary (phase 3 gasless signed-offer book) ━━━');
for (const s of steps) console.log(`${s.status.padEnd(8)} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
console.log(
  `order hash: ${orderHash ?? '(none posted)'} · ledger poisoned: ${ledgerPoisoned}` +
    ` · cancel tx: ${cancelTxHash ?? '(none)'}`,
);
if (ws) {
  const invalidates = ws.frames.filter((f) => f.obj?.t === 'invalidate');
  console.log(
    `ws frames: ${ws.frames.length} total, ${invalidates.length} invalidate; ` +
      `lifecycle: ${ws.lifecycle.map((l) => l.ev).join(' → ')}`,
  );
  for (const f of invalidates.slice(0, 20)) {
    console.log(
      `  invalidate @${new Date(f.at).toISOString()} keys=[${f.obj.keys.join(',')}] scannedTo=${f.obj.scannedTo}`,
    );
  }
}
console.log(`screenshots: ${shotPaths.join(', ') || '(none)'}`);
if (consoleErrors.length) {
  console.log(`console errors (${consoleErrors.length}):`);
  for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(`  ${e}`);
} else {
  console.log('console errors: none');
}

const ok =
  !failed &&
  steps.every((s) => s.status !== 'FAIL') &&
  (!signClicked || ledgerPoisoned);
console.log(ok ? 'PASS — signed-book live review complete' : 'FAIL — see steps above');
process.exit(ok ? 0 : 1);
