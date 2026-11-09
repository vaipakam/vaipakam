// The stand-in for the two Workers alpha05 reads (plain .mjs: global setup
// spawns it with the stock `node`, no TS loader in the child):
//
//  - the indexer's `GET /health/ingest`, hydrated from the local chain on
//    every request (its cursor is the chain's head, scanned "now"), so the
//    freshness stamp reads a real block and a real age, and the posture
//    control lets a spec put the index into `stale` (cursor half an hour
//    behind), `down` (503), `other-diamond` (an index describing a
//    protocol contract this build does not bind to) or `schema-pending`
//    (the indexer's schema gate has stopped its scans) — the states
//    RB-RAILS says the stamp must tell apart;
//  - the indexer's push rail, `GET /ws/chain/:chainId`: refused with 503,
//    the indexer's own answer while push is off, so the stamp's "push
//    unavailable, polling" line is exercised rather than mocked;
//  - the read-only RPC proxy's `POST /rpc/:chainId`, forwarded to Anvil
//    verbatim (alpha05 refuses a per-chain RPC URL, so this is the ONLY
//    way the dev server's reads reach the fixture chain);
//  - the indexer's `GET /activity?actor=…&kind=…`, for the seller-claim and
//    extension-reserve kinds only: read from the chain's own logs of those
//    events, filed under the seller or the reserve's depositor as the
//    indexer files them (topic 2 of each: the loan is topic 1), so Claims
//    discovers a sold position or a reserve the way it does against the
//    real Worker. Refused with 503 while the posture is `down`, as the whole
//    index is;
//  - the indexer's `GET /offers/active?chainId&limit&before`, the offer
//    book: every offer the chain's `OfferCreated` logs name, read back from
//    the Diamond and filed `active` while the protocol reports it open or
//    lazily expired (as the indexer files it, expiry being lazy on-chain),
//    newest first, paged by id. Also refused while the posture is `down`;
//  - the indexer's `GET /loans/recent?chainId&limit&lendingAsset&
//    collateralAsset&durationDays&excludeSaleVehicles`, the recent loans the
//    rate warning compares against: every loan the chain's `LoanInitiated`
//    logs name, read back from the Diamond, filtered to the scope asked for
//    and echoing that scope as the indexer does. The agreed rate is the
//    loan's stored rate (the fixture never refinances a loan it reads here).
//    Refused while the posture is `down`;
//  - the indexer's `GET /notifications/:address?chainId&limit&before`, the
//    wallet's inbox: a `loan_matched` row for both parties of every
//    `LoanInitiated` and a `loan_repaid` row for both parties of every
//    `LoanRepaid`, from the chain's logs (filed under the loan's parties, as
//    the indexer files them under the position holders when no position has
//    moved), with ids in chain order, plus any rows a spec adds through
//    `POST /__stub/notifications` (kinds the fixture cannot reach by itself,
//    such as health bands, reward deadlines, an unknown kind or an
//    unreadable row), stamped after every chain row. Newest first, paged by
//    the indexer's `block:log:id` cursor, with the `newerThan` count of rows
//    written after an id; refused while the posture is `down`.
//  - the alert service (the agent Worker, which alpha05 is pointed at here
//    too): `GET /push/status`, `POST /link/telegram`, `POST /telegram/test`,
//    `POST /unlink/telegram` and `PUT /thresholds`, answering as the agent
//    does (codes, refusals and statuses), with each signed request accepted
//    once. It does NOT verify signatures: it records every request
//    (`GET /__stub/agent`), and the spec checks each signature against the
//    shared message builders, which is the stronger claim. A spec drives
//    the bot handshake, the push posture and one forced answer through
//    `POST /__stub/agent`.
//
// Everything a world read would need beyond these lands with the route
// that reads it, hydrated from the chain the same way.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeEventLog, http as viemHttp, toEventSelector } from 'viem';

const CHAIN_ID = 84532;
const ANVIL_URL = process.env.ALPHA05_E2E_ANVIL_URL ?? 'http://127.0.0.1:8546';
const PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
const STALE_SECONDS = 30 * 60 + 5;
const OTHER_DIAMOND = '0x00000000000000000000000000000000000000ff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The e2e bundle global setup writes after deploying the fixture (never the
// committed one, whose 84532 entry is the live testnet).
const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '.state', 'deployments.json'), 'utf8'))[String(CHAIN_ID)];

// The activity events the stand-in serves, from the combined Diamond ABI
// (the seller's recorded event is a library's, so it is in no single
// facet's file). Each carries the loan as topic 1 and its actor as topic 2.
const DIAMOND_ABI = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', '..', '..', 'packages', 'contracts', 'src', 'diamondAbi.json'), 'utf8'));
const SELLER_KINDS = ['SellerInterestClaimRecorded', 'SellerInterestPaid', 'SellerInterestClaimClosed', 'SellerInterestWithdrawn'];
const RESERVE_KINDS = ['ExtendReserveFunded', 'ExtendReserveWithdrawn', 'ExtendChargeDrawn'];
const ACTIVITY_KINDS = [...SELLER_KINDS, ...RESERVE_KINDS];
const ACTIVITY_TOPICS = new Map(
  ACTIVITY_KINDS.map((name) => {
    const item = DIAMOND_ABI.find((e) => e.type === 'event' && e.name === name);
    if (!item) throw new Error(`the Diamond ABI has no ${name} event`);
    return [toEventSelector(item), name];
  }),
);

const LOAN_INITIATED = toEventSelector(DIAMOND_ABI.find((e) => e.type === 'event' && e.name === 'LoanInitiated'));
const LOAN_REPAID = toEventSelector(DIAMOND_ABI.find((e) => e.type === 'event' && e.name === 'LoanRepaid'));
const OFFER_CREATED = toEventSelector(DIAMOND_ABI.find((e) => e.type === 'event' && e.name === 'OfferCreated'));
const chain = createPublicClient({ transport: viemHttp(ANVIL_URL) });

/** One offer in the indexer's `/offers/active` row shape (amounts as text). */
async function offerRow(id) {
  const read = (functionName) => chain.readContract({ address: DEPLOYMENT.diamond, abi: DIAMOND_ABI, functionName, args: [id] });
  const [o, state, linked] = await Promise.all([read('getOffer'), read('getOfferState'), read('getOfferLinkedLoanId')]);
  // 0 = open, 4 = expired: the indexer keeps a lapsed offer `active`.
  if (Number(state) !== 0 && Number(state) !== 4) return null;
  const lender = Number(o.offerType) === 0;
  return {
    chainId: CHAIN_ID,
    offerId: Number(id),
    status: 'active',
    creator: o.creator.toLowerCase(),
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset.toLowerCase(),
    collateralAsset: o.collateralAsset.toLowerCase(),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    tokenId: o.tokenId.toString(),
    collateralTokenId: o.collateralTokenId.toString(),
    quantity: o.quantity.toString(),
    collateralQuantity: o.collateralQuantity.toString(),
    amount: o.amount.toString(),
    amountMax: o.amountMax.toString(),
    amountFilled: o.amountFilled.toString(),
    interestRateBps: Number(o.interestRateBps),
    interestRateBpsMax: Number(o.interestRateBpsMax),
    collateralAmount: o.collateralAmount.toString(),
    collateralAmountMax: (o.collateralAmountMax === 0n ? o.collateralAmount : o.collateralAmountMax).toString(),
    collateralAmountFilled: o.collateralAmountFilled.toString(),
    durationDays: Number(o.durationDays),
    prepayAsset: o.prepayAsset.toLowerCase(),
    expiresAt: Number(o.expiresAt),
    isSaleVehicle: linked !== 0n && !lender,
    isOffsetVehicle: linked !== 0n && lender,
    refinanceTargetLoanId: Number(o.refinanceTargetLoanId),
    positionFlow: linked !== 0n || o.refinanceTargetLoanId !== 0n ? { movedSinceOpened: null } : null,
  };
}

/** `/offers/active`: the open offers, newest first, `limit` per page. */
async function activeOffers(url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  const before = url.searchParams.get('before');
  const logs = await anvil('eth_getLogs', [{ address: DEPLOYMENT.diamond, fromBlock: '0x0', toBlock: 'latest', topics: [OFFER_CREATED] }]);
  const ids = [...new Set(logs.map((l) => BigInt(l.topics[1])))].filter((id) => before === null || id < BigInt(before)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const offers = [];
  for (const id of ids) {
    if (offers.length === limit) break;
    const row = await offerRow(id);
    if (row !== null) offers.push(row);
  }
  return { chainId: CHAIN_ID, offers, nextBefore: offers.length === limit ? offers[offers.length - 1].offerId : null };
}

/** `/loans/recent` in the indexer's scoped shape: newest first, filtered to
 *  the pair and term asked for, the scope echoed back. */
async function recentLoans(url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  const lending = url.searchParams.get('lendingAsset')?.toLowerCase() ?? null;
  const collateral = url.searchParams.get('collateralAsset')?.toLowerCase() ?? null;
  const days = url.searchParams.get('durationDays');
  const durationDays = days === null ? null : Number(days);
  const excludeSaleVehicles = url.searchParams.get('excludeSaleVehicles') === '1';
  const logs = await anvil('eth_getLogs', [{ address: DEPLOYMENT.diamond, fromBlock: '0x0', toBlock: 'latest', topics: [LOAN_INITIATED] }]);
  const ids = [...new Set(logs.map((l) => BigInt(l.topics[1])))].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const loans = [];
  for (const id of ids) {
    if (loans.length === limit) break;
    const l = await chain.readContract({ address: DEPLOYMENT.diamond, abi: DIAMOND_ABI, functionName: 'getLoanDetails', args: [id] });
    if (lending !== null && l.principalAsset.toLowerCase() !== lending) continue;
    if (collateral !== null && l.collateralAsset.toLowerCase() !== collateral) continue;
    if (durationDays !== null && Number(l.durationDays) !== durationDays) continue;
    // A lender-sale vehicle is a borrower offer linked to a loan: the loan it
    // opens is bookkeeping, not a fresh rate.
    const linked = await chain.readContract({ address: DEPLOYMENT.diamond, abi: DIAMOND_ABI, functionName: 'getOfferLinkedLoanId', args: [l.offerId] });
    const offer = await chain.readContract({ address: DEPLOYMENT.diamond, abi: DIAMOND_ABI, functionName: 'getOffer', args: [l.offerId] });
    const isSaleVehicle = linked !== 0n && Number(offer.offerType) !== 0;
    if (excludeSaleVehicles && isSaleVehicle) continue;
    loans.push({
      chainId: CHAIN_ID,
      loanId: Number(id),
      offerId: Number(l.offerId),
      lendingAsset: l.principalAsset.toLowerCase(),
      collateralAsset: l.collateralAsset.toLowerCase(),
      durationDays: Number(l.durationDays),
      interestRateBps: Number(l.interestRateBps),
      initRateBps: Number(l.interestRateBps),
      startAt: Number(l.startTime),
      isSaleVehicle,
    });
  }
  return {
    chainId: CHAIN_ID,
    loans,
    nextBefore: loans.length === limit ? loans[loans.length - 1].loanId : null,
    scope: { lendingAsset: lending, collateralAsset: collateral, durationDays, placement: 'e2e stand-in', excludeSaleVehicles },
    // Every fixture loan's terms are the chain's own, so none is unplaced
    // unless a spec sets the count (`/__stub/unplaced`) to drive the
    // disclosure.
    unplaced,
  };
}

/** Inbox rows a spec added (`/__stub/notifications`), each for one wallet. */
let addedNotifications = [];

/** `/notifications/:address`: the wallet's inbox rows, newest first, one
 *  page at a time on the indexer's (block, log, id) cursor. */
async function notifications(url, address) {
  const addr = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { status: 400, body: { error: 'bad-address' } };
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  const logs = await anvil('eth_getLogs', [{ address: DEPLOYMENT.diamond, fromBlock: '0x0', toBlock: 'latest', topics: [[LOAN_INITIATED, LOAN_REPAID]] }]);
  const times = new Map();
  const rows = [];
  for (const l of logs) {
    const block = Number(l.blockNumber);
    if (!times.has(block)) times.set(block, Number((await anvil('eth_getBlockByNumber', [l.blockNumber, false])).timestamp));
    const loanId = BigInt(l.topics[1]);
    let kind;
    let parties;
    if (l.topics[0] === LOAN_INITIATED) {
      const { args } = decodeEventLog({ abi: DIAMOND_ABI, data: l.data, topics: l.topics });
      kind = 'loan_matched';
      parties = [args.lender, args.borrower];
    } else {
      const loan = await chain.readContract({ address: DEPLOYMENT.diamond, abi: DIAMOND_ABI, functionName: 'getLoanDetails', args: [loanId] });
      kind = 'loan_repaid';
      parties = [loan.lender, loan.borrower];
    }
    const logIndex = Number(l.logIndex);
    parties.forEach((p, side) => {
      if (p.toLowerCase() !== addr) return;
      rows.push({
        id: block * 10_000 + logIndex * 2 + side,
        kind,
        loanId: Number(loanId),
        offerId: null,
        eventKind: kind === 'loan_matched' ? 'LoanInitiated' : 'LoanRepaid',
        data: null,
        createdAt: times.get(block),
        blockNumber: block,
        logIndex,
      });
    });
  }
  for (const n of addedNotifications) if (n.recipient === addr) rows.push(n.row);
  rows.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex || b.id - a.id);
  const before = url.searchParams.get('before');
  let page = rows;
  if (before) {
    const [blk, li, id] = before.split(':').map(Number);
    page = rows.filter((r) => r.blockNumber < blk || (r.blockNumber === blk && (r.logIndex < li || (r.logIndex === li && r.id < id))));
  }
  page = page.slice(0, limit);
  const last = page.length === limit ? page[page.length - 1] : null;
  const body = { chainId: CHAIN_ID, address: addr, notifications: page, nextBefore: last ? `${last.blockNumber}:${last.logIndex}:${last.id}` : null };
  // `newerThan=<id>`: how many of the wallet's rows have a larger id, and its
  // newest id, as the indexer counts them (every row, whatever its block).
  const newer = url.searchParams.get('newerThan');
  if (newer !== null) {
    if (!/^\d{1,15}$/.test(newer)) return { status: 400, body: { error: 'bad-newer-than' } };
    const id = Number(newer);
    body.newerThan = { id, count: rows.filter((r) => r.id > id).length, capped: false, newestId: rows.reduce((m, r) => Math.max(m, r.id), 0) };
  }
  return { status: 200, body };
}

/** The `/loans/recent` disclosure of loans whose terms the index has not
 *  confirmed; set by a spec through `/__stub/unplaced`. */
let unplaced = { count: 0, capped: false };

/** @type {'live' | 'stale' | 'down' | 'other-diamond' | 'schema-pending'} */
let posture = 'live';

async function anvil(method, params = []) {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function ingestHealth() {
  const head = Number(await anvil('eth_blockNumber'));
  const now = Math.floor(Date.now() / 1000);
  const scannedAt = posture === 'stale' ? now - STALE_SECONDS : now;
  return {
    checkedAt: now,
    schema: posture === 'schema-pending' ? { state: 'pending', missing: ['9999_e2e_stand_in.sql'] } : { state: 'current' },
    chains: [
      {
        chainId: CHAIN_ID,
        deployment: {
          diamond: posture === 'other-diamond' ? OTHER_DIAMOND : DEPLOYMENT.diamond,
          deployBlock: DEPLOYMENT.deployBlock ?? 0,
          adoptedAt: now - 3600,
          resetPending: false,
          adoptedBlind: false,
        },
        lastBlock: head,
        scannedAt,
        ageSeconds: now - scannedAt,
      },
    ],
    configured: { chains: [CHAIN_ID], basis: 'e2e stand-in: the fixture chain' },
    lifecycle: null,
  };
}

/** `/activity` for the served kinds: every such event filed under `actor`,
 *  newest first, in one page (a test chain never needs a second). */
async function actorActivity(url) {
  const actor = (url.searchParams.get('actor') ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(actor)) return { status: 400, body: { error: 'actor must be an address' } };
  const kinds = (url.searchParams.get('kind') ?? '').split(',').filter(Boolean);
  if (kinds.length === 0 || kinds.some((k) => !ACTIVITY_KINDS.includes(k))) return { status: 400, body: { error: 'the stand-in serves the seller and reserve kinds only' } };
  const topics = [...ACTIVITY_TOPICS].filter(([, name]) => kinds.includes(name)).map(([t]) => t);
  const logs = await anvil('eth_getLogs', [{ address: DEPLOYMENT.diamond, fromBlock: '0x0', toBlock: 'latest', topics: [topics, null, `0x${actor.slice(2).padStart(64, '0')}`] }]);
  const events = logs
    .map((l) => ({
      chainId: CHAIN_ID,
      kind: ACTIVITY_TOPICS.get(l.topics[0]),
      actor,
      loanId: Number(BigInt(l.topics[1])),
      blockNumber: Number(l.blockNumber),
      logIndex: Number(l.logIndex),
      txHash: l.transactionHash,
    }))
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return { status: 200, body: { chainId: CHAIN_ID, events, nextBefore: null } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The alert service's routes, by method. */
const AGENT_ROUTES = { '/link/telegram': 'POST', '/telegram/test': 'POST', '/unlink/telegram': 'POST', '/thresholds': 'PUT' };

function freshAgent() {
  return {
    push: 'available',
    requests: [],
    used: new Set(),
    codes: new Map(),
    linked: new Set(),
    lastTest: new Map(),
    thresholds: new Map(),
    next: new Map(),
    slow: new Map(),
  };
}
/** The alert service's state: every request, the issued codes, the linked
 *  wallets, the stored settings and the push posture. */
let agent = freshAgent();

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/') {
      json(res, 200, {
        service: 'alpha05 e2e stand-in',
        routes: [
          '/health/ingest',
          '/activity (seller and reserve kinds)',
          '/offers/active',
          '/loans/recent',
          '/notifications/:address',
          '/ws/chain/:chainId (503)',
          '/rpc/:chainId',
          '/__stub/index-posture',
          '/__stub/unplaced',
          '/__stub/notifications',
          '/push/status, /link/telegram, /telegram/test, /unlink/telegram, /thresholds',
          '/__stub/agent',
        ],
      });
      return;
    }
    if (url.pathname === '/__stub/index-posture' && req.method === 'POST') {
      const { posture: next } = JSON.parse(await readBody(req));
      if (!['live', 'stale', 'down', 'other-diamond', 'schema-pending'].includes(next)) {
        json(res, 400, { error: `unknown posture ${String(next)}` });
        return;
      }
      posture = next;
      json(res, 200, { posture });
      return;
    }
    if (url.pathname === '/__stub/unplaced' && req.method === 'POST') {
      const next = JSON.parse(await readBody(req));
      if (!Number.isSafeInteger(next.count) || next.count < 0 || typeof next.capped !== 'boolean') {
        json(res, 400, { error: 'unplaced needs { count, capped }' });
        return;
      }
      unplaced = { count: next.count, capped: next.capped };
      json(res, 200, { unplaced });
      return;
    }
    if (url.pathname === '/__stub/notifications' && req.method === 'POST') {
      // { recipient, rows: [partial row] } adds rows stamped after every chain
      // row; { reset: true } removes every added row.
      const body = JSON.parse(await readBody(req));
      if (body.reset === true) {
        addedNotifications = [];
        json(res, 200, { added: 0 });
        return;
      }
      if (typeof body.recipient !== 'string' || !Array.isArray(body.rows)) {
        json(res, 400, { error: 'notifications needs { recipient, rows } or { reset: true }' });
        return;
      }
      const head = Number(await anvil('eth_blockNumber'));
      const now = Math.floor(Date.now() / 1000);
      // Added rows take ids above every chain row's (block × 10,000 + …) and
      // within the 15 digits the route accepts for `newerThan`, as the
      // index's own ids are: written after, so numbered after.
      for (const r of body.rows) {
        const seq = addedNotifications.length + 1;
        addedNotifications.push({
          recipient: body.recipient.toLowerCase(),
          row: { id: 900_000_000_000_000 + seq, offerId: null, eventKind: null, data: null, createdAt: now, blockNumber: head, logIndex: 1_000_000 + seq, ...r },
        });
      }
      json(res, 200, { added: addedNotifications.length });
      return;
    }
    if (url.pathname === '/__stub/agent') {
      if (req.method === 'GET') {
        json(res, 200, { requests: agent.requests, thresholds: Object.fromEntries(agent.thresholds), linked: [...agent.linked] });
        return;
      }
      // { reset }, { push: 'available' | 'agent-only' | 'unavailable' | 'down' },
      // { handshake: wallet } (the bot received that wallet's latest code),
      // { next: { path, status, body } } (the next request to that path gets it).
      // { slow: { path, ms } } (the next request to that path is answered ms later).
      const body = JSON.parse(await readBody(req));
      if (body.reset === true) agent = freshAgent();
      if (body.push !== undefined) {
        if (!['available', 'agent-only', 'unavailable', 'down'].includes(body.push)) {
          json(res, 400, { error: `unknown push posture ${String(body.push)}` });
          return;
        }
        agent.push = body.push;
      }
      if (typeof body.handshake === 'string') {
        const w = body.handshake.toLowerCase();
        if (![...agent.codes.values()].includes(w)) {
          json(res, 409, { error: 'no code was issued for that wallet' });
          return;
        }
        agent.linked.add(w);
      }
      if (body.next !== undefined) agent.next.set(body.next.path, { status: body.next.status, body: body.next.body });
      if (body.slow !== undefined) agent.slow.set(body.slow.path, body.slow.ms);
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/push/status' && req.method === 'GET') {
      if (agent.push === 'down') {
        json(res, 503, { error: 'e2e stand-in: alert service down' });
        return;
      }
      const channel = '0x00000000000000000000000000000000000e2e01';
      json(
        res,
        200,
        agent.push === 'unavailable'
          ? { available: false, reason: 'signer-unset', rail: 'agent', scope: 'service', billedChainIds: [] }
          : { available: true, channel, scope: agent.push === 'agent-only' ? 'agent' : 'service', billedChainIds: [] },
      );
      return;
    }
    if (AGENT_ROUTES[url.pathname] === req.method) {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'invalid-json' });
        return;
      }
      agent.requests.push({ path: url.pathname, body });
      const slowMs = agent.slow.get(url.pathname);
      if (slowMs !== undefined) {
        agent.slow.delete(url.pathname);
        // Bounded: a test slows one answer by seconds, never more.
        await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(slowMs) || 0, 0), 30_000)));
      }
      const forced = agent.next.get(url.pathname);
      if (forced) {
        agent.next.delete(url.pathname);
        json(res, forced.status, forced.body);
        return;
      }
      if (
        typeof body.wallet !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(body.wallet) ||
        typeof body.signature !== 'string' ||
        !Number.isSafeInteger(body.issuedAt) ||
        body.chain_id !== CHAIN_ID
      ) {
        json(res, 400, { error: 'invalid-payload' });
        return;
      }
      // The agent's one-time ledger is keyed on the signed message; the
      // signature stands in for it here (one message, one signature).
      if (agent.used.has(body.signature)) {
        json(res, 409, { error: 'request-already-used', reason: 'this signed request was already used — sign again' });
        return;
      }
      agent.used.add(body.signature);
      const w = body.wallet.toLowerCase();
      if (url.pathname === '/link/telegram') {
        const code = `E2E${String(agent.codes.size + 1).padStart(5, '0')}`;
        agent.codes.set(code, w);
        json(res, 200, { ok: true, code, bot_url: `https://t.me/vaipakam_e2e_bot?start=${code}` });
        return;
      }
      if (url.pathname === '/telegram/test') {
        if (!agent.linked.has(w)) {
          json(res, 404, { error: 'not-linked' });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        if ((agent.lastTest.get(w) ?? 0) > now - 60) {
          json(res, 429, { error: 'rate-limited' });
          return;
        }
        agent.lastTest.set(w, now);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/unlink/telegram') {
        agent.linked.delete(w);
        json(res, 200, { ok: true, scope: 'wallet' });
        return;
      }
      // PUT /thresholds
      if (body.push_channel === 'subscribed' && agent.push !== 'available' && agent.push !== 'agent-only') {
        const stored = agent.thresholds.get(w)?.push_channel === 'subscribed';
        if (!stored) {
          json(res, 409, { error: 'push-unavailable', push: 'unavailable' });
          return;
        }
      }
      const prev = agent.thresholds.get(w) ?? {};
      const next = { ...prev };
      for (const k of ['warn_hf', 'alert_hf', 'critical_hf', 'notify_maturity_approaching']) if (body[k] !== undefined) next[k] = body[k];
      if (body.push_channel === 'subscribed') next.push_channel = 'subscribed';
      agent.thresholds.set(w, next);
      const push = body.push_channel !== 'subscribed' ? 'not-requested' : agent.push === 'available' || agent.push === 'agent-only' ? 'stored' : 'kept';
      json(res, 200, { ok: true, push });
      return;
    }
    if (url.pathname === '/health/ingest') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      json(res, 200, await ingestHealth());
      return;
    }
    if (url.pathname === '/activity' && req.method === 'GET') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      const out = await actorActivity(url);
      json(res, out.status, out.body);
      return;
    }
    if (url.pathname === '/offers/active' && req.method === 'GET') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      json(res, 200, await activeOffers(url));
      return;
    }
    if (url.pathname === '/loans/recent' && req.method === 'GET') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      json(res, 200, await recentLoans(url));
      return;
    }
    const inbox = url.pathname.match(/^\/notifications\/([^/]+)$/);
    if (inbox && req.method === 'GET') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      const r = await notifications(url, inbox[1]);
      json(res, r.status, r.body);
      return;
    }
    const rpc = url.pathname.match(/^\/rpc\/(\d+)$/);
    if (rpc && req.method === 'POST') {
      // The proxy serves the chains it is bound to; every other id is a 404,
      // as the real Worker answers, so a read for another chain fails loudly
      // here instead of landing on Anvil's single chain.
      if (Number(rpc[1]) !== CHAIN_ID) {
        json(res, 404, { error: `chain ${rpc[1]} is not served` });
        return;
      }
      const body = await readBody(req);
      const upstream = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }
    json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  } catch (e) {
    // The cause goes to the e2e log (stderr is inherited by the Playwright
    // run); the page gets a fixed text, never the error's own.
    console.error('[e2e] stand-in request failed:', req.method, url.pathname, e);
    json(res, 500, { error: 'stand-in request failed; see the e2e log' });
  }
});

// The push rail: an upgrade request is refused the way the indexer refuses
// one while push is off. The app's rail then reports unavailable and keeps
// polling, which is the degradable-by-construction behaviour under test.
//
// The upgrade hands over a RAW socket, which has no error listener of its
// own: a browser that resets it (the page navigates, the context closes)
// would raise an unhandled 'error' and kill this process, and every later
// spec would then meet a refused connection instead of its posture. A reset
// of a refused socket is expected, so it is swallowed here; the body length
// is computed, so the declared length can never disagree with it.
const PUSH_OFF = JSON.stringify({ error: 'e2e stand-in: push rail is off' });
server.on('upgrade', (req, socket) => {
  socket.on('error', () => {});
  socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n' + `Content-Length: ${Buffer.byteLength(PUSH_OFF)}\r\n\r\n${PUSH_OFF}`);
});

// A client that drops an ordinary request mid-way is not this process's
// failure either: close that socket and keep serving.
server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] stand-in Worker on http://127.0.0.1:${PORT} (indexer health + push refusal, proxy route → ${ANVIL_URL})`);
});
