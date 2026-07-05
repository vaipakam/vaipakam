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
  // silently dropping the row.
  const [o, stateRaw] = await Promise.all([
    read('getOffer', [BigInt(id)]),
    read('getOfferState', [BigInt(id)]),
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
    // The stub serves exactly ONE chain (the fork). An explicit
    // chainId for anything else must be a loud error, not Base
    // Sepolia data wearing the wrong label.
    const chainParam = url.searchParams.get('chainId');
    if (chainParam !== null && Number(chainParam) !== CHAIN_ID) {
      return json(400, { error: `stub serves chainId ${CHAIN_ID} only` });
    }

    // GET /offers/stats?chainId= — freshness piggyback. Report the
    // FORK's latest block/timestamp so evm_increaseTime never reads
    // as a stalled cursor.
    if (parts[0] === 'offers' && parts[1] === 'stats') {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return json(200, {
        indexer: { lastBlock: Number(block.number), updatedAt: Number(block.timestamp) },
      });
    }

    // GET /offers/active?chainId=&limit= — the full book in one page
    // (`limit` deliberately ignored: nextBefore null promises
    // completeness, see activeOfferIds).
    if (parts[0] === 'offers' && parts[1] === 'active') {
      const [ids, chainNow] = await Promise.all([activeOfferIds(), forkNowSec()]);
      const offers = (await Promise.all(ids.map((id) => mapOffer(id, chainNow))))
        .filter((o) => o && o.status === 'active')
        // Production serves ORDER BY offer_id DESC; the contract's
        // swap-and-pop active list is unordered — restore the shape.
        .sort((a, b) => b.offerId - a.offerId);
      return json(200, { chainId: CHAIN_ID, offers, nextBefore: null });
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
