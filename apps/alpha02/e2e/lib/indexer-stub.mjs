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

function offerStatus(o) {
  if (!o.creator || /^0x0{40}$/i.test(o.creator)) return null; // gone
  if (o.accepted) return 'accepted';
  return 'active';
}

async function mapOffer(id) {
  const o = await read('getOffer', [BigInt(id)]).catch(() => null);
  if (!o) return null;
  const status = offerStatus(o);
  if (status === null) return null;
  const nowSec = Math.floor(Date.now() / 1000);
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
  const l = await read('getLoanDetails', [BigInt(id)]).catch(() => null);
  if (!l) return null;
  const Z = /^0x0{40}$/i;
  if (Z.test(l.lender) && Z.test(l.borrower)) return null; // unknown id: zeroed struct
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    chainId: CHAIN_ID,
    loanId: Number(id),
    offerId: n(l.offerId),
    status: LOAN_STATUS[n(l.status)] ?? 'active',
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

async function activeOfferIds(limit = 100) {
  const ids = await read('getActiveOffersPaginated', [0n, BigInt(limit)]).catch(
    () => [],
  );
  return [...ids];
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
    // GET /offers/stats?chainId= — freshness piggyback. Report the
    // FORK's latest block/timestamp so evm_increaseTime never reads
    // as a stalled cursor.
    if (parts[0] === 'offers' && parts[1] === 'stats') {
      const block = await pub.getBlock({ blockTag: 'latest' });
      return json(200, {
        indexer: { lastBlock: Number(block.number), updatedAt: Number(block.timestamp) },
      });
    }

    // GET /offers/active?chainId=&limit=
    if (parts[0] === 'offers' && parts[1] === 'active') {
      const ids = await activeOfferIds(Number(url.searchParams.get('limit') ?? 50));
      const offers = (await Promise.all(ids.map(mapOffer))).filter(
        (o) => o && o.status === 'active',
      );
      return json(200, { chainId: CHAIN_ID, offers, nextBefore: null });
    }

    // GET /offers/by-creator/:addr
    if (parts[0] === 'offers' && parts[1] === 'by-creator' && parts[2]) {
      const creator = parts[2].toLowerCase();
      const [ids] = await read('getUserOffersPaginated', [creator, 0n, 100n]).catch(
        () => [[]],
      );
      const offers = (await Promise.all([...ids].map(mapOffer))).filter(Boolean);
      return json(200, { chainId: CHAIN_ID, creator, offers, nextBefore: null });
    }

    // GET /offers/by-current-holder/:addr — active offers whose
    // position NFT the wallet currently holds.
    if (parts[0] === 'offers' && parts[1] === 'by-current-holder' && parts[2]) {
      const holder = parts[2].toLowerCase();
      const ids = await activeOfferIds(100);
      const offers = [];
      for (const id of ids) {
        const o = await mapOffer(id);
        if (!o || o.status !== 'active') continue;
        const owner = await read('ownerOf', [BigInt(o.positionTokenId)]).catch(
          () => null,
        );
        if (owner && owner.toLowerCase() === holder) offers.push(o);
      }
      return json(200, { chainId: CHAIN_ID, offers, nextBefore: null });
    }

    // GET /offers/:id?chainId=
    if (parts[0] === 'offers' && parts[1] && /^\d+$/.test(parts[1])) {
      const offer = await mapOffer(Number(parts[1]));
      return offer ? json(200, offer) : json(404, { error: 'not found' });
    }

    // GET /loans/by-lender/:addr | /loans/by-borrower/:addr — the
    // chain's position enumeration (lender ids, borrower ids).
    if (
      parts[0] === 'loans' &&
      (parts[1] === 'by-lender' || parts[1] === 'by-borrower') &&
      parts[2]
    ) {
      const side = parts[1] === 'by-lender' ? 'lender' : 'borrower';
      const addr = parts[2].toLowerCase();
      const [lenderIds, borrowerIds] = await read('getUserPositionLoansPaginated', [
        addr,
        0n,
        100n,
      ]).catch(() => [[], []]);
      const ids = side === 'lender' ? [...lenderIds] : [...borrowerIds];
      const loans = (await Promise.all(ids.map(mapLoan))).filter(Boolean);
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
