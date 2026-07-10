// "Instant indexer" for the fork tier — a tiny HTTP server that
// serves the exact route/response shapes of apps/indexer (the subset
// alpha02 reads: src/data/indexer.ts) but hydrates EVERY request live
// from the fork's own paginated chain views. No ingestion, no lag, no
// database: offers/loans created by a test are visible to the app on
// the next request, and the freshness cursor tracks the fork's latest
// block so time travel never reads as a stalled indexer.
//
// Plain .mjs on purpose: global-setup spawns it with the stock `node`
// binary (no TS loader needed in the child).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http as viemHttp } from 'viem';

const CHAIN_ID = 84532;
const ANVIL_URL = process.env.ALPHA02_E2E_ANVIL_URL ?? 'http://127.0.0.1:8545';
const PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);

// fs-load the app's own contract artifacts (Node ESM refuses the
// workspace barrel's attribute-less JSON imports; vite doesn't mind).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_SRC = path.resolve(HERE, '..', '..', '..', '..', 'packages', 'contracts', 'src');
const DIAMOND_ABI_VIEM = fs
  .readdirSync(path.join(CONTRACTS_SRC, 'abis'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .flatMap((f) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(CONTRACTS_SRC, 'abis', f), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  });
const DIAMOND = JSON.parse(
  fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
)[String(CHAIN_ID)].diamond;
const pub = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: 'fork',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL] } },
  },
  transport: viemHttp(ANVIL_URL),
});

const read = (functionName, args = []) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName, args });

// On-chain LoanStatus → indexer row status (apps/alpha02/src/lib/types.ts).
const LOAN_STATUS = ['active', 'repaid', 'defaulted', 'settled', 'fallback_pending', 'internal_matched'];

const s = (v) => (v === undefined || v === null ? '0' : String(v));
const n = (v) => Number(v ?? 0);

// MetricsFacet.OfferState — the CANONICAL lifecycle view. The raw
// getOffer struct cannot express a ConsumedBySale terminal (the row
// still reads open), so status must come from getOfferState, exactly
// like the real indexer's derivation. Unknown enum values throw (500)
// rather than guess.
const OFFER_STATE = ['active', 'accepted', 'cancelled', 'consumed_by_sale'];

// The FORK's clock, not the host's: evm_increaseTime moves
// block.timestamp far from wall time, and the facets judge expiry
// against block.timestamp — the stub must use the same clock or a
// time-travelled offer reads active while acceptOffer would revert.
async function forkNowSec() {
  const block = await pub.getBlock({ blockTag: 'latest' });
  return Number(block.timestamp);
}

async function mapOffer(id, chainNowSec) {
  // No catch: a zeroed struct is the legitimate "gone" signal below;
  // an RPC/ABI failure must bubble to the handler's 500 instead of
  // silently dropping the row. getOfferLinkedLoanId backs the worker's
  // `isSaleVehicle` / `isOffsetVehicle` markers (D1 columns,
  // migrations 0029 + 0031) — the stub derives both live, matching
  // production semantics exactly: the worker sets is_sale_vehicle on
  // LoanSaleOfferLinked (always a borrower-style offer) and
  // is_offset_vehicle on OffsetOfferCreated (always a lender-style
  // offer, Codex #1134 round-5), so linked + offerType decides which
  // flag a row carries.
  const [o, stateRaw, linkedLoanId] = await Promise.all([
    read('getOffer', [BigInt(id)]),
    read('getOfferState', [BigInt(id)]),
    read('getOfferLinkedLoanId', [BigInt(id)]),
  ]);
  if (!o) return null;
  if (!o.creator || /^0x0{40}$/i.test(o.creator)) return null; // slot deleted
  const nowSec = Math.floor(Date.now() / 1000);
  let status = OFFER_STATE[n(stateRaw)];
  if (status === undefined) {
    throw new Error(`unknown OfferState ${stateRaw} for offer ${id}`);
  }
  // GTT expiry overlay on an Open row — judged on the FORK's
  // block.timestamp with the facets' own >= boundary
  // (OfferAcceptFacet rejects at block.timestamp >= expiresAt).
  if (status === 'active' && n(o.expiresAt) !== 0 && chainNowSec >= n(o.expiresAt)) {
    status = 'expired';
  }
  return {
    chainId: CHAIN_ID,
    offerId: Number(id),
    status,
    creator: o.creator,
    offerType: n(o.offerType),
    lendingAsset: o.lendingAsset,
    collateralAsset: o.collateralAsset,
    assetType: n(o.assetType),
    collateralAssetType: n(o.collateralAssetType),
    principalLiquidity: n(o.principalLiquidity),
    collateralLiquidity: n(o.collateralLiquidity),
    tokenId: s(o.tokenId),
    collateralTokenId: s(o.collateralTokenId),
    quantity: s(o.quantity),
    collateralQuantity: s(o.collateralQuantity),
    amount: s(o.amount),
    amountMax: s(o.amountMax),
    amountFilled: s(o.amountFilled),
    interestRateBps: n(o.interestRateBps),
    interestRateBpsMax: n(o.interestRateBpsMax),
    collateralAmount: s(o.collateralAmount),
    durationDays: n(o.durationDays),
    positionTokenId: s(o.positionTokenId),
    prepayAsset: o.prepayAsset,
    useFullTermInterest: Boolean(o.useFullTermInterest),
    creatorRiskAndTermsConsent: Boolean(o.creatorRiskAndTermsConsent),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    firstSeenBlock: 0,
    firstSeenAt: n(o.createdAt) || nowSec,
    updatedAt: nowSec,
    createdAt: n(o.createdAt) || undefined,
    expiresAt: n(o.expiresAt) || undefined,
    fillMode: n(o.fillMode),
    isSaleVehicle: n(o.offerType) === 1 && n(linkedLoanId) !== 0,
    isOffsetVehicle: n(o.offerType) === 0 && n(linkedLoanId) !== 0,
  };
}

async function mapLoan(id) {
  // No catch — same rule as mapOffer: zeroed struct = unknown id,
  // read failure = 500.
  const l = await read('getLoanDetails', [BigInt(id)]);
  if (!l) return null;
  const Z = /^0x0{40}$/i;
  if (Z.test(l.lender) && Z.test(l.borrower)) return null; // unknown id: zeroed struct
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    chainId: CHAIN_ID,
    loanId: Number(id),
    offerId: n(l.offerId),
    // Unknown enum values fail closed (500) — labelling a future
    // status 'active' would exercise actions the app can't represent.
    status:
      LOAN_STATUS[n(l.status)] ??
      (() => {
        throw new Error(`unknown LoanStatus ${l.status} for loan ${id}`);
      })(),
    lender: l.lender,
    borrower: l.borrower,
    principal: s(l.principal),
    collateralAmount: s(l.collateralAmount),
    assetType: n(l.assetType),
    collateralAssetType: n(l.collateralAssetType),
    lendingAsset: l.principalAsset,
    collateralAsset: l.collateralAsset,
    durationDays: n(l.durationDays),
    tokenId: s(l.tokenId),
    collateralTokenId: s(l.collateralTokenId),
    lenderTokenId: s(l.lenderTokenId),
    borrowerTokenId: s(l.borrowerTokenId),
    interestRateBps: n(l.interestRateBps),
    startTime: n(l.startTime),
    allowsPartialRepay: Boolean(l.allowsPartialRepay),
    startBlock: 0,
    startAt: n(l.startTime),
    terminalBlock: null,
    terminalAt: n(l.status) === 0 ? null : nowSec,
    updatedAt: nowSec,
  };
}

// Rate Desk phase 2 (#1130) — executed-rate candle enums + fold.
// Small re-implementation of apps/indexer/src/rateCandles.ts (the
// SOURCE OF TRUTH — keep the two in sync; the worker's version is
// unit-tested, this one only mirrors it for the fork tier): fills
// sort chronologically with the loan-id tiebreak, only buckets with
// >= 1 fill are emitted (§5.3 rule 1 — gaps render as gaps, no
// interpolation), and principal folds with BigInt into a decimal
// STRING (18-dec base-unit sums overflow doubles; a JSON number
// would silently lose precision).
const CANDLE_INTERVALS = { '1h': 3600, '4h': 14400, '1d': 86400 };
const CANDLE_RANGES = { '7d': 7, '30d': 30, '90d': 90, all: null };

function foldRateCandles(rows, intervalSec) {
  const sorted = [...rows].sort(
    (x, y) => x.startAt - y.startAt || x.loanId - y.loanId,
  );
  const buckets = new Map();
  for (const row of sorted) {
    const rate = row.rateBps;
    const t = Math.floor(row.startAt / intervalSec) * intervalSec;
    const acc = buckets.get(t);
    if (!acc) {
      buckets.set(t, {
        open: rate,
        high: rate,
        low: rate,
        close: rate,
        fills: 1,
        principalTotal: row.principal,
      });
    } else {
      acc.high = Math.max(acc.high, rate);
      acc.low = Math.min(acc.low, rate);
      acc.close = rate; // rows are chronological — last write wins
      acc.fills += 1;
      acc.principalTotal += row.principal;
    }
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([t, acc]) => ({
      t,
      open: acc.open,
      high: acc.high,
      low: acc.low,
      close: acc.close,
      fills: acc.fills,
      principalTotal: acc.principalTotal.toString(),
    }));
}

// A revert is a SEMANTIC answer (e.g. ownerOf on a burned position
// NFT = "nobody holds it"); a transport/ABI failure is not — the
// caller must let those 500. viem wraps read reverts in
// ContractFunctionRevertedError/ZeroData on the cause chain.
function isRevertError(e) {
  if (typeof e?.walk === 'function') {
    return (
      e.walk(
        (x) =>
          x?.name === 'ContractFunctionRevertedError' ||
          x?.name === 'ContractFunctionZeroDataError',
      ) != null
    );
  }
  return /revert/i.test(String(e?.message ?? ''));
}

// Exhaustive id walks. The stub's responses advertise `nextBefore:
// null` (= "this page is complete"), so every page must actually BE
// complete: truncating at one chain page would silently hide rows
// from the app's pagination-following client. Chain-read failures are
// deliberately NOT caught here — they bubble to the handler's 500
// path so the app renders "indexer unavailable" instead of a
// confident empty market (an ABI/RPC break must fail CI, not pass it).
const WALK_CAP = 2000;
const PAGE = 200n;

async function activeOfferIds() {
  const ids = [];
  for (let offset = 0n; ids.length < WALK_CAP; offset += PAGE) {
    const page = await read('getActiveOffersPaginated', [offset, PAGE]);
    ids.push(...page);
    if (page.length < Number(PAGE)) return ids;
  }
  throw new Error(`active-offer walk exceeded the ${WALK_CAP} cap`);
}

// getUserOffersPaginated returns (offerIds slice, total) — walk until
// the collected count reaches the reported total.
async function userOfferIds(addr) {
  const ids = [];
  for (let offset = 0n; ids.length < WALK_CAP; offset += PAGE) {
    const [page, total] = await read('getUserOffersPaginated', [addr, offset, PAGE]);
    ids.push(...page);
    if (ids.length >= Number(total) || page.length === 0) return ids;
  }
  throw new Error(`user-offer walk exceeded the ${WALK_CAP} cap`);
}

// getUserPositionLoansPaginated returns (loanIds, positionTokenIds,
// totalBalance) — loans whose position NFT the wallet HOLDS, both
// roles mixed; `offset` indexes the wallet's NFT inventory and
// totalBalance bounds it. Returns aligned {loanId, tokenId} pairs —
// the HELD token id is what decides which SIDE the wallet occupies
// (production's by-lender/by-borrower routes key on the CURRENT
// position-NFT owner, so a transferred/bought position must surface
// for its new holder, not the original party).
async function userPositionLoans(addr) {
  const rows = [];
  for (let offset = 0n; ; offset += PAGE) {
    const [loanIds, tokenIds, totalBalance] = await read(
      'getUserPositionLoansPaginated',
      [addr, offset, PAGE],
    );
    for (let i = 0; i < loanIds.length; i++) {
      rows.push({ loanId: loanIds[i], tokenId: tokenIds[i] });
    }
    if (offset + PAGE >= totalBalance) return rows;
    if (offset >= BigInt(WALK_CAP)) {
      throw new Error(`position-loan walk exceeded the ${WALK_CAP} cap`);
    }
  }
}

// Cross-status loan-id walk (Rate Desk #1130). getAllLoansPaginated
// pages over the 1-INDEXED ID SPACE (offset is an id offset, not a
// row offset; `total` is the highest assigned id), so completeness is
// judged on `offset + PAGE >= total`, never on page length — pages
// legitimately come back short where ids were skipped.
async function allLoanIds() {
  const ids = [];
  for (let offset = 0n; ; offset += PAGE) {
    const [page, total] = await read('getAllLoansPaginated', [offset, PAGE]);
    ids.push(...page);
    if (offset + PAGE >= total) return ids;
    if (ids.length >= WALK_CAP) {
      throw new Error(`all-loan walk exceeded the ${WALK_CAP} cap`);
    }
  }
}

// Every loan the wallet was EVER a party to — the chain's own
// append-only userLoanIds index (LoanFacet pushes BOTH parties at
// init, all statuses, never deletes). getUserLoansPaginated returns
// (ids slice, total) like the sibling user-offer walk. De-duped: a
// self-loan (same wallet both sides) lands in the index twice.
async function userAllLoanIds(addr) {
  const ids = [];
  for (let offset = 0n; ids.length < WALK_CAP; offset += PAGE) {
    const [page, total] = await read('getUserLoansPaginated', [addr, offset, PAGE]);
    ids.push(...page);
    if (ids.length >= Number(total) || page.length === 0) {
      return [...new Set(ids.map((id) => Number(id)))];
    }
  }
  throw new Error(`user-loan walk exceeded the ${WALK_CAP} cap`);
}

// A loan is the lender-sale TEMP BOOKKEEPING row (never a fresh rate
// print — §7) when the offer that initiated it is a borrower-style
// offer linked to an existing loan: exactly the shape mapOffer flags
// as `isSaleVehicle`, derived live the same way. Production persists
// the flag onto the loan at LoanInitiated (migration 0029); the fork
// stub re-derives per request. A deleted/zeroed originating offer
// reads as not-a-sale — acceptable at fork scale (an accepted sale
// offer persists; only cancelled offers zero out, and those never
// initiated a loan).
async function isSaleVehicleLoan(loan) {
  const [o, linkedLoanId] = await Promise.all([
    read('getOffer', [BigInt(loan.offerId)]),
    read('getOfferLinkedLoanId', [BigInt(loan.offerId)]),
  ]);
  if (!o || !o.creator || /^0x0{40}$/i.test(o.creator)) return false;
  return n(o.offerType) === 1 && n(linkedLoanId) !== 0;
}

// Rate Desk (#1129) — the worker's optional server-side market scope
// (lendingAsset / collateralAsset / durationDays query params) applied
// to a mapped-offer array. The desk's indexer-fallback book relies on
// this being SERVER-side (its client does no pair filtering), so the
// stub must honour the params rather than ignore them — an ignored
// filter would hand the desk every pair's rows wearing one market's
// label.
function applyMarketScope(offers, url) {
  const lend = url.searchParams.get('lendingAsset');
  const coll = url.searchParams.get('collateralAsset');
  const days = url.searchParams.get('durationDays');
  return offers.filter(
    (o) =>
      (!lend || o.lendingAsset.toLowerCase() === lend.toLowerCase()) &&
      (!coll || o.collateralAsset.toLowerCase() === coll.toLowerCase()) &&
      (days === null || o.durationDays === Number(days)),
  );
}

// The worker's opt-in /offers/active drops (Codex #1134 round-3 +
// round-5): `excludeExpired=1` (expires_at = 0 OR expires_at > now —
// judged on the FORK's clock, like everything else here),
// `excludeSaleVehicles=1` (is_sale_vehicle = 0) and
// `excludeOffsetVehicles=1` (is_offset_vehicle = 0). Applied to BOTH
// the live and the pinned path, exactly like production applies its
// SQL predicate to whatever rows the table holds.
function applyOfferFlags(offers, url, chainNowSec) {
  const excludeExpired = url.searchParams.get('excludeExpired') === '1';
  const excludeSaleVehicles = url.searchParams.get('excludeSaleVehicles') === '1';
  const excludeOffsetVehicles =
    url.searchParams.get('excludeOffsetVehicles') === '1';
  return offers.filter(
    (o) =>
      (!excludeExpired || !o.expiresAt || o.expiresAt > chainNowSec) &&
      (!excludeSaleVehicles || o.isSaleVehicle !== true) &&
      (!excludeOffsetVehicles || o.isOffsetVehicle !== true),
  );
}

// Pin mode (#1029): a spec can freeze the ACTIVE-OFFERS view and the
// freshness cursor at "now" while anvil keeps advancing — the only
// way this always-live stub can honestly simulate ingest lag, which
// is the state the book's on-chain catch-up merge exists for. Only
// /offers/active and /offers/stats are frozen; every other route
// stays live. workers=1 (playwright.config) makes the global pin
// race-free across specs.
let pinned = null;

async function capturePin() {
  const [ids, chainNow, block] = await Promise.all([
    activeOfferIds(),
    forkNowSec(),
    pub.getBlock({ blockTag: 'latest' }),
  ]);
  const offers = (await Promise.all(ids.map((id) => mapOffer(id, chainNow))))
    .filter((o) => o && o.status === 'active')
    .sort((a, b) => b.offerId - a.offerId);
  return {
    active: { chainId: CHAIN_ID, offers, nextBefore: null },
    stats: {
      indexer: { lastBlock: Number(block.number), updatedAt: Number(block.timestamp) },
    },
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const json = (status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  };

  try {
    // Test-control routes (POST) — see the pin-mode note above.
    if (req.method === 'POST' && parts[0] === '__pin') {
      pinned = await capturePin();
      return json(200, { pinnedBlock: pinned.stats.indexer.lastBlock });
    }
    if (req.method === 'POST' && parts[0] === '__unpin') {
      pinned = null;
      return json(200, { ok: true });
    }

    // The stub serves exactly ONE chain (the fork). An explicit
    // chainId for anything else must be a loud error, not Base
    // Sepolia data wearing the wrong label.
    const chainParam = url.searchParams.get('chainId');
    if (chainParam !== null && Number(chainParam) !== CHAIN_ID) {
      return json(400, { error: `stub serves chainId ${CHAIN_ID} only` });
    }

    // GET /offers/stats?chainId= — freshness piggyback. Report the
    // FORK's latest block/timestamp so evm_increaseTime never reads
    // as a stalled cursor (pin mode: the captured cursor instead).
    if (parts[0] === 'offers' && parts[1] === 'stats') {
      if (pinned) return json(200, pinned.stats);
      const block = await pub.getBlock({ blockTag: 'latest' });
      return json(200, {
        indexer: { lastBlock: Number(block.number), updatedAt: Number(block.timestamp) },
      });
    }

    // GET /offers/active?chainId=&limit= — the full book in one page
    // (`limit` deliberately ignored: nextBefore null promises
    // completeness, see activeOfferIds). Pin mode serves the frozen
    // snapshot. The optional market params (Rate Desk #1129 —
    // lendingAsset / collateralAsset / durationDays) scope the page
    // exactly like the worker's server-side filter; the pinned
    // snapshot gets the same scope applied so pin mode stays honest
    // for a market-scoped consumer too.
    if (parts[0] === 'offers' && parts[1] === 'active') {
      if (pinned) {
        return json(200, {
          ...pinned.active,
          offers: applyOfferFlags(
            applyMarketScope(pinned.active.offers, url),
            url,
            await forkNowSec(),
          ),
        });
      }
      const [ids, chainNow] = await Promise.all([activeOfferIds(), forkNowSec()]);
      const offers = (await Promise.all(ids.map((id) => mapOffer(id, chainNow))))
        .filter((o) => o && o.status === 'active')
        // Production serves ORDER BY offer_id DESC; the contract's
        // swap-and-pop active list is unordered — restore the shape.
        .sort((a, b) => b.offerId - a.offerId);
      return json(200, {
        chainId: CHAIN_ID,
        offers: applyOfferFlags(applyMarketScope(offers, url), url, chainNow),
        nextBefore: null,
      });
    }

    // GET /offers/markets?chainId= — Rate Desk market discovery
    // (#1129). Mirrors the worker's SQL aggregation: every DISTINCT
    // (lendingAsset, collateralAsset, durationDays) triple with live
    // ERC-20/ERC-20 offers, per-side counts + best headline rates,
    // most-active first. Not frozen by pin mode (production pins only
    // the active feed + freshness cursor). NB the desk's tape route
    // (/loans/recent) is deliberately still NOT stubbed: nothing in
    // the suite asserts on the tape, so the app's honest "couldn't
    // load recent fills" state stands in — the phase-2 chart/History
    // routes below cover the cross-status reads the specs DO assert.
    if (parts[0] === 'offers' && parts[1] === 'markets') {
      const [ids, chainNow] = await Promise.all([activeOfferIds(), forkNowSec()]);
      const rows = (await Promise.all(ids.map((id) => mapOffer(id, chainNow)))).filter(
        (o) =>
          o &&
          o.status === 'active' &&
          o.assetType === 0 &&
          o.collateralAssetType === 0 &&
          // Production excludes BOTH vehicle kinds unconditionally
          // (is_sale_vehicle = 0 AND is_offset_vehicle = 0): sale /
          // offset bookkeeping rows must never advertise a market
          // (Codex #1134 round-5 P2 — an offset-only "market" would
          // be auto-selected and then render an empty book).
          o.isSaleVehicle !== true &&
          o.isOffsetVehicle !== true,
      );
      const byKey = new Map();
      for (const o of rows) {
        const key = `${o.lendingAsset.toLowerCase()}:${o.collateralAsset.toLowerCase()}:${o.durationDays}`;
        let m = byKey.get(key);
        if (!m) {
          m = {
            lendingAsset: o.lendingAsset,
            collateralAsset: o.collateralAsset,
            durationDays: o.durationDays,
            lenderOffers: 0,
            borrowerOffers: 0,
            bestAskBps: null,
            bestBidBps: null,
          };
          byKey.set(key, m);
        }
        if (o.offerType === 0) {
          m.lenderOffers += 1;
          m.bestAskBps =
            m.bestAskBps === null
              ? o.interestRateBps
              : Math.min(m.bestAskBps, o.interestRateBps);
        } else {
          m.borrowerOffers += 1;
          m.bestBidBps =
            m.bestBidBps === null
              ? o.interestRateBpsMax
              : Math.max(m.bestBidBps, o.interestRateBpsMax);
        }
      }
      const markets = [...byKey.values()].sort(
        (a, b) =>
          b.lenderOffers + b.borrowerOffers - (a.lenderOffers + a.borrowerOffers),
      );
      return json(200, { chainId: CHAIN_ID, markets });
    }

    // GET /offers/by-creator/:addr — exhaustive walk (see userOfferIds).
    if (parts[0] === 'offers' && parts[1] === 'by-creator' && parts[2]) {
      const creator = parts[2].toLowerCase();
      const [ids, chainNow] = await Promise.all([userOfferIds(creator), forkNowSec()]);
      const offers = (
        await Promise.all([...ids].map((id) => mapOffer(id, chainNow)))
      ).filter(Boolean);
      return json(200, { chainId: CHAIN_ID, creator, offers, nextBefore: null });
    }

    // GET /offers/by-current-holder/:addr — active offers whose
    // position NFT the wallet currently holds.
    if (parts[0] === 'offers' && parts[1] === 'by-current-holder' && parts[2]) {
      const holder = parts[2].toLowerCase();
      const [ids, chainNow] = await Promise.all([activeOfferIds(), forkNowSec()]);
      const offers = [];
      for (const id of ids) {
        const o = await mapOffer(id, chainNow);
        if (!o || o.status !== 'active') continue;
        // ownerOf REVERTING is the semantic "NFT burned / nobody
        // holds it" answer; any other failure (ABI/RPC) must 500.
        let owner = null;
        try {
          owner = await read('ownerOf', [BigInt(o.positionTokenId)]);
        } catch (e) {
          if (!isRevertError(e)) throw e;
        }
        if (owner && owner.toLowerCase() === holder) offers.push(o);
      }
      offers.sort((a, b) => b.offerId - a.offerId);
      return json(200, { chainId: CHAIN_ID, offers, nextBefore: null });
    }

    // GET /offers/:id?chainId=
    if (parts[0] === 'offers' && parts[1] && /^\d+$/.test(parts[1])) {
      const offer = await mapOffer(Number(parts[1]), await forkNowSec());
      return offer ? json(200, offer) : json(404, { error: 'not found' });
    }

    // GET /loans/by-lender/:addr | /loans/by-borrower/:addr. Side is
    // decided by WHICH position NFT the wallet holds (held tokenId ==
    // loan.lenderTokenId → lender side; == borrowerTokenId → borrower
    // side), matching production's current-owner columns — the
    // immutable lender/borrower fields would hide a transferred or
    // bought position from its new holder.
    if (
      parts[0] === 'loans' &&
      (parts[1] === 'by-lender' || parts[1] === 'by-borrower') &&
      parts[2]
    ) {
      const side = parts[1] === 'by-lender' ? 'lender' : 'borrower';
      const addr = parts[2].toLowerCase();
      const held = await userPositionLoans(addr);
      const loans = (
        await Promise.all(
          held.map(async ({ loanId, tokenId }) => {
            const l = await mapLoan(loanId);
            if (!l) return null;
            const sideTokenId =
              side === 'lender' ? l.lenderTokenId : l.borrowerTokenId;
            return String(tokenId) === sideTokenId ? l : null;
          }),
        )
      ).filter(Boolean);
      return json(200, { chainId: CHAIN_ID, side, address: addr, loans, nextBefore: null });
    }

    // GET /loans/rate-candles?chainId=&lendingAsset=&collateralAsset=
    //   &durationDays=&interval=&range= — Rate Desk phase 2 (#1130).
    // Mirrors the worker's handleLoansRateCandles (loanRoutes.ts): all
    // three market params REQUIRED (a candle series is per-market by
    // definition), interval/range default 1h/30d and 400 outside the
    // enums; the 400 mirroring is deliberately loose — the desk only
    // ever sends valid params. Fill scope matches production exactly:
    // cross-status loans for the market, ERC-20 both legs, sale
    // vehicles excluded (see isSaleVehicleLoan). The range lower bound
    // is judged on the FORK's clock — evm_increaseTime moves fills far
    // from wall time, and a wall-clock bound would drop every
    // time-travelled fill from a "30d" window.
    if (parts[0] === 'loans' && parts[1] === 'rate-candles') {
      const lend = url.searchParams.get('lendingAsset');
      const coll = url.searchParams.get('collateralAsset');
      const daysRaw = url.searchParams.get('durationDays');
      const days = daysRaw === null ? null : Number(daysRaw);
      if (
        (lend !== null && !/^0x[0-9a-f]{40}$/i.test(lend)) ||
        (coll !== null && !/^0x[0-9a-f]{40}$/i.test(coll)) ||
        (days !== null && (!Number.isInteger(days) || days < 1 || days > 4385))
      ) {
        return json(400, { error: 'bad-market-filter' });
      }
      if (lend === null || coll === null || days === null) {
        return json(400, { error: 'market-filter-required' });
      }
      // Own-property lookups only, mirroring the worker (Codex #1139
      // round-1 P3): a raw `interval=toString` must 400, never resolve
      // an inherited Object.prototype member.
      const intervalRaw = url.searchParams.get('interval') ?? '1h';
      const intervalSec = Object.hasOwn(CANDLE_INTERVALS, intervalRaw)
        ? CANDLE_INTERVALS[intervalRaw]
        : undefined;
      if (intervalSec === undefined) return json(400, { error: 'bad-interval' });
      const rangeRaw = url.searchParams.get('range') ?? '30d';
      const rangeDays = Object.hasOwn(CANDLE_RANGES, rangeRaw)
        ? CANDLE_RANGES[rangeRaw]
        : undefined;
      if (rangeDays === undefined) return json(400, { error: 'bad-range' });

      const [ids, chainNow] = await Promise.all([allLoanIds(), forkNowSec()]);
      const loans = (await Promise.all(ids.map((id) => mapLoan(Number(id))))).filter(
        (l) =>
          l &&
          l.lendingAsset.toLowerCase() === lend.toLowerCase() &&
          l.collateralAsset.toLowerCase() === coll.toLowerCase() &&
          l.durationDays === days &&
          l.assetType === 0 &&
          l.collateralAssetType === 0 &&
          (rangeDays === null || l.startAt >= chainNow - rangeDays * 86400),
      );
      // Sale-vehicle probe only for rows that already match the market
      // — two extra reads per surviving loan, not per loan on the fork.
      const saleFlags = await Promise.all(loans.map((l) => isSaleVehicleLoan(l)));
      const fills = loans
        .filter((_, i) => !saleFlags[i])
        .map((l) => ({
          loanId: l.loanId,
          startAt: l.startAt,
          rateBps: l.interestRateBps,
          principal: BigInt(l.principal || '0'),
        }));
      return json(200, { chainId: CHAIN_ID, buckets: foldRateCandles(fills, intervalSec) });
    }

    // GET /loans/by-participant?chainId=&wallet=&limit=&before= — Rate
    // Desk phase 2 (#1130), the History tab's persisted-participation
    // view: every loan the wallet ever participated in, ALL statuses,
    // roles[] aggregated. Production reads the append-only
    // `loan_participants` table (seeded at LoanInitiated, appended on
    // every position-NFT transfer, never deleted). SIMPLIFICATION: the
    // fork tier's data has no position-NFT-transfer history to replay,
    // so a loan's CURRENT parties ARE its participants — the chain's
    // own userLoanIds index (both sides at init, append-only, all
    // statuses) is exactly that projection, roles derive from which
    // side(s) the wallet occupies on the loan struct, and the loan's
    // startAt stands in for the worker's MAX(from_at) participation
    // time (participation began at init — there are no transfers).
    //
    // Mirrors the worker's round-3 shape (Codex #1139): desk scoping
    // (ERC-20 both legs, sale vehicles excluded — the participants
    // SOURCE stays append-everything, the desk ROUTE scopes), ordering
    // by newest participation with loan-id tiebreak, and the composite
    // `before=<participatedAt>_<loanId>` cursor with `nextBefore` in
    // the same encoding.
    //
    // NO mirror of the worker's round-4 stub-shape guard (placeholder
    // '0x' assets / duration_days = 0 from the D1 fallback-B insert):
    // this stub hydrates every row from live getLoanDetails chain
    // reads, so a loan here always carries real asset addresses and a
    // real term — the stub-row window the worker guards against cannot
    // occur on the fork tier.
    if (parts[0] === 'loans' && parts[1] === 'by-participant') {
      const walletRaw = url.searchParams.get('wallet');
      if (!walletRaw) return json(400, { error: 'wallet-required' });
      const wallet = walletRaw.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
        return json(400, { error: 'bad-address' });
      }
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const beforeRaw = url.searchParams.get('before');
      const beforeMatch =
        beforeRaw === null ? null : /^(\d+)_(\d+)$/.exec(beforeRaw);
      const before = beforeMatch
        ? { at: Number(beforeMatch[1]), loanId: Number(beforeMatch[2]) }
        : null;

      const ids = await userAllLoanIds(wallet);
      const mapped = (await Promise.all(ids.map((id) => mapLoan(id)))).filter(
        (l) => l && l.assetType === 0 && l.collateralAssetType === 0,
      );
      // Sale-vehicle probe only for rows that already passed the cheap
      // ERC-20 scope check — same idiom as the rate-candles route above.
      const saleFlags = await Promise.all(mapped.map((l) => isSaleVehicleLoan(l)));
      const rows = mapped
        .filter((_, i) => !saleFlags[i])
        .map((l) => ({ l, at: l.startAt }))
        .filter(
          ({ l, at }) =>
            before === null ||
            at < before.at ||
            (at === before.at && l.loanId < before.loanId),
        )
        .sort((a, b) => b.at - a.at || b.l.loanId - a.l.loanId);
      const page = rows.slice(0, limit);
      const loans = page.map(({ l, at }) => {
        const roles = [];
        if (l.borrower.toLowerCase() === wallet) roles.push('borrower');
        if (l.lender.toLowerCase() === wallet) roles.push('lender');
        // Sorted, like the worker's deterministic wire shape.
        return { ...l, participatedAt: at, roles: roles.sort() };
      });
      const nextBefore =
        page.length === limit && page.length > 0
          ? `${page[page.length - 1].at}_${page[page.length - 1].l.loanId}`
          : null;
      return json(200, { chainId: CHAIN_ID, wallet, loans, nextBefore });
    }

    // GET /loans/:id?chainId=
    if (parts[0] === 'loans' && parts[1] && /^\d+$/.test(parts[1])) {
      const loan = await mapLoan(Number(parts[1]));
      return loan ? json(200, loan) : json(404, { error: 'not found' });
    }

    // GET /activity — the Home feed degrades honestly on empty.
    if (parts[0] === 'activity') {
      return json(200, { chainId: CHAIN_ID, events: [], nextBefore: null });
    }

    return json(404, { error: 'no such route in the e2e indexer stub' });
  } catch (e) {
    // Server-side log only — even a localhost test stub shouldn't echo
    // exception internals in a response body (CodeQL js/stack-trace-exposure).
    console.error('[indexer-stub]', e);
    return json(500, { error: 'internal stub error' });
  }
}

http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`[indexer-stub] serving fork-hydrated indexer on :${PORT}`);
});
