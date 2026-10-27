// feed-bindings-bridge.test.mjs — the bridge-provenance rules, on small
// hand-written inputs, and the reads against a stub client. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { QUOTES } from './chainlink-feed-bindings.mjs';
import {
  BRIDGES,
  OP_L2_STANDARD_BRIDGE,
  applyBridgeProofs,
  depositMajority,
  ethereumOriginals,
  readBridgeProofs,
  settleReview,
  wantedProofs,
} from './feed-bindings-bridge.mjs';

const A = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const L1_LINK = A(0x1111);
const LINK = A(0x11);
const FAKE = A(0x5c);
const USDC = A(0xc1);
const USDC_E = A(0xc2);

const kept = (base, quote = 'USD', path = `${base.toLowerCase()}-${quote.toLowerCase()}`) => ({
  pair: `${base} / ${quote}`,
  directoryPath: path,
  base,
  quote,
  feed: A(0xf000 + path.length),
  feedDecimals: 8,
  heartbeat: 86400,
  category: 'low',
});
const proof = (canonical, l1Token = L1_LINK) => ({ method: 'arbitrum-gateway-router', l1Token, canonical, detail: 'test' });

test('Ethereum originals come from settled bindings and manual entries; a symbol bound to two tokens has none', () => {
  const { originals, ambiguous } = ethereumOriginals({
    bindings: [
      { symbol: 'LINK', token: L1_LINK, quote: 'USD' },
      { symbol: 'LINK', token: L1_LINK, quote: 'ETH' },
      { symbol: 'FOO', token: A(1), quote: 'USD' },
      { symbol: 'FOO', token: A(2), quote: 'ETH' },
    ],
    manual: [{ pair: 'CBBTC / USD', token: A(3) }],
    review: [{ pair: 'BAR / USD', candidates: { coingecko: [A(4)] } }],
  });
  assert.equal(originals.get('link'), L1_LINK);
  assert.equal(originals.get('cbbtc'), A(3));
  assert.equal(originals.has('bar'), false, 'a review entry is not settled');
  assert.deepEqual(ambiguous, ['foo']);
});

test('a review entry settles only when the bridge names an address at least two sources name and none contradicts', () => {
  // One source omits it: settles, and the agreeing sources are recorded.
  let d = settleReview({ coingecko: [LINK], coinmarketcap: [], tokenList: [LINK] }, LINK);
  assert.equal(d.settle, true);
  assert.equal(d.token, LINK);
  assert.deepEqual(d.agreedBy, ['coingecko', 'tokenList', 'bridge']);
  // A source naming another token beside the bridged one blocks it: the
  // bridge never decides between two candidates a list offers.
  d = settleReview({ coingecko: [LINK, FAKE], coinmarketcap: [], tokenList: [LINK] }, LINK);
  assert.equal(d.settle, false);
  assert.match(d.why, /coingecko names another token/);
  // Even when every source offers the same two.
  d = settleReview({ coingecko: [LINK, FAKE], coinmarketcap: [LINK, FAKE], tokenList: [LINK, FAKE] }, LINK);
  assert.equal(d.settle, false);
  assert.match(d.why, /coingecko and coinmarketcap and tokenList name another token/);
  // A source naming only another token blocks it.
  d = settleReview({ coingecko: [FAKE], coinmarketcap: [], tokenList: [LINK] }, LINK);
  assert.equal(d.settle, false);
  assert.match(d.why, /coingecko names another token/);
  // One source alone is not enough, even with the bridge.
  d = settleReview({ coingecko: [], coinmarketcap: [], tokenList: [LINK] }, LINK);
  assert.equal(d.settle, false);
  assert.match(d.why, /only tokenList names it/);
  // No bridge answer: nothing to settle with.
  assert.equal(settleReview({ coingecko: [LINK], coinmarketcap: [], tokenList: [LINK] }, null).settle, false);
  // Case does not matter.
  assert.equal(settleReview({ coingecko: [LINK.toLowerCase()], tokenList: [LINK] }, LINK.toLowerCase()).settle, true);
});

test('the OP Stack proof is the candidate holding more than half of the bridge balance, never a plurality', () => {
  const lc = (a) => a.toLowerCase();
  assert.equal(depositMajority(100n, new Map([[lc(USDC_E), 99n], [lc(USDC), 1n]])).canonical, USDC_E);
  assert.match(depositMajority(100n, new Map([[lc(USDC_E), 99n]])).detail, /9900 bps/);
  assert.equal(depositMajority(100n, new Map([[lc(USDC_E), 50n], [lc(USDC), 40n]])).canonical, null, 'exactly half is not a majority');
  assert.equal(depositMajority(0n, new Map([[lc(USDC_E), 0n]])).canonical, null);
});

test('a drafted binding the bridge confirms gains the bridge as a source; one it contradicts goes to review', () => {
  const draft = (symbol, token) => ({
    token,
    symbol,
    quote: 'USD',
    pair: `${symbol} / USD`,
    directoryPath: `${symbol.toLowerCase()}-usd`,
    feed: A(0xf1),
    agreedBy: ['coingecko', 'coinmarketcap', 'tokenList'],
  });
  const out = applyBridgeProofs({
    resolved: { bindings: [draft('LINK', LINK), draft('USDC', USDC), draft('ARB', A(0xab))], review: [] },
    keptByPath: new Map(),
    proofs: new Map([
      ['link', proof(LINK)],
      ['usdc', proof(USDC_E, A(0xc0))],
      ['arb', proof(null, A(0xa0))],
    ]),
    tokenDecimals: () => undefined,
    quotes: QUOTES,
  });
  const link = out.bindings.find((b) => b.symbol === 'LINK');
  assert.deepEqual(link.agreedBy, ['coingecko', 'coinmarketcap', 'tokenList', 'bridge']);
  assert.equal(link.bridgeProof.canonical, LINK);
  // No bridge answer (a natively issued token): the draft stands, with the
  // evidence recorded, and the bridge is not claimed as a source.
  const arb = out.bindings.find((b) => b.symbol === 'ARB');
  assert.deepEqual(arb.agreedBy, ['coingecko', 'coinmarketcap', 'tokenList']);
  assert.equal(arb.bridgeProof.canonical, null);
  // Native vs bridged: two tokens claim the symbol.
  assert.equal(out.bindings.some((b) => b.symbol === 'USDC'), false);
  const usdc = out.review.find((r) => r.pair === 'USDC / USD');
  assert.match(usdc.reason, /two tokens claim the symbol/);
  assert.deepEqual(usdc.candidates, { token: [USDC], bridge: [USDC_E] });
});

test('a settled review entry becomes a full binding from the directory row; other review entries keep their reason', () => {
  const link = kept('LINK');
  const comp = kept('COMP');
  const dup = kept('FOO');
  const out = applyBridgeProofs({
    resolved: {
      bindings: [],
      review: [
        { pair: link.pair, directoryPath: link.directoryPath, feed: link.feed, quote: 'USD', reason: 'no address from coinmarketcap', candidates: { coingecko: [LINK], coinmarketcap: [], tokenList: [LINK] } },
        { pair: comp.pair, directoryPath: comp.directoryPath, feed: comp.feed, quote: 'USD', reason: 'the sources name different addresses', candidates: { coingecko: [FAKE], coinmarketcap: [], tokenList: [A(0xc0)] } },
        { pair: dup.pair, directoryPath: dup.directoryPath, feed: dup.feed, quote: 'USD', reason: '2 feeds resolve to FOO / USD', candidates: { token: [A(0xf0)] } },
      ],
    },
    keptByPath: new Map([link, comp, dup].map((f) => [f.directoryPath, f])),
    proofs: new Map([
      ['link', proof(LINK)],
      ['comp', proof(A(0xc0), A(0xc00))],
      ['foo', proof(A(0xf0), A(0xf00))],
    ]),
    tokenDecimals: (symbol, address) => (symbol === 'LINK' && address === LINK ? 18 : undefined),
    quotes: QUOTES,
  });
  assert.deepEqual(out.settled, ['link-usd']);
  const b = out.bindings[0];
  assert.equal(b.token, LINK);
  assert.equal(b.tokenDecimals, 18);
  assert.equal(b.quoteAddress, QUOTES.USD);
  assert.equal(b.heartbeat, 86400);
  assert.equal(b.settledFrom, 'no address from coinmarketcap');
  assert.deepEqual(b.agreedBy, ['coingecko', 'tokenList', 'bridge']);
  const c = out.review.find((r) => r.pair === 'COMP / USD');
  assert.equal(c.reason, 'the sources name different addresses');
  assert.match(c.bridgeProof.outcome, /coingecko names another token/);
  // A duplicate (token, quote) is not a question of identity: untouched.
  const f = out.review.find((r) => r.pair === 'FOO / USD');
  assert.equal(f.bridgeProof, undefined);
});

test('a manual entry for the settled token and quote suppresses the settlement', () => {
  const link = kept('LINK');
  const out = applyBridgeProofs({
    resolved: {
      bindings: [],
      review: [{ pair: link.pair, directoryPath: link.directoryPath, feed: link.feed, quote: 'USD', reason: 'x', candidates: { coingecko: [LINK], tokenList: [LINK] } }],
    },
    keptByPath: new Map([[link.directoryPath, link]]),
    proofs: new Map([['link', proof(LINK)]]),
    tokenDecimals: () => undefined,
    quotes: QUOTES,
    manualCovered: new Set([`${LINK.toLowerCase()}|USD`]),
  });
  assert.equal(out.bindings.length, 0);
  assert.equal(out.review.length, 0);
  assert.match(out.skipped[0].reason, /manual entry covers/);
});

test('wanted proofs cover only symbols with an Ethereum original, with every candidate the sources gave', () => {
  const link = kept('LINK');
  const wanted = wantedProofs({
    resolved: {
      bindings: [{ symbol: 'LINK', token: LINK, otherCandidates: { coingecko: [FAKE] } }],
      review: [{ directoryPath: link.directoryPath, candidates: { coingecko: [A(0x99)], tokenList: [LINK] } }, { directoryPath: 'nope', candidates: {} }],
    },
    keptByPath: new Map([[link.directoryPath, link]]),
    originals: new Map([['link', L1_LINK]]),
  });
  assert.deepEqual([...wanted.keys()], ['link']);
  assert.equal(wanted.get('link').l1Token, L1_LINK);
  assert.deepEqual([...wanted.get('link').candidates].sort(), [LINK, FAKE, A(0x99)].map((a) => a.toLowerCase()).sort());
});

/** A stub viem client answering multicall from a function of each call. */
const stub = (answer) => ({
  multicall: async ({ contracts }) => contracts.map((c) => answer(c)),
});

test('Arbitrum: the router names the token, and it counts only where a token answers at that address', async () => {
  const l2 = stub((c) => {
    if (c.functionName === 'calculateL2TokenAddress') return { status: 'success', result: c.args[0] === L1_LINK ? LINK : A(0xdead) };
    if (c.functionName === 'decimals') return c.address === LINK ? { status: 'success', result: 18 } : { status: 'failure' };
    throw new Error(c.functionName);
  });
  const wanted = new Map([
    ['link', { l1Token: L1_LINK, candidates: new Set() }],
    ['foo', { l1Token: A(0xf00), candidates: new Set() }],
  ]);
  const { proofs, record } = await readBridgeProofs({ slug: 'arbitrum', l2, l2Block: 5n, wanted });
  assert.equal(proofs.get('link').canonical, LINK);
  assert.equal(proofs.get('foo').canonical, null);
  assert.match(proofs.get('foo').detail, /holds no token/);
  assert.deepEqual(record, { method: 'arbitrum-gateway-router', contract: BRIDGES.arbitrum.contract, checkedAtBlock: 5 });
});

test('OP Stack: reads the L1 ledger, and refuses a contract that is not the standard bridge', async () => {
  const lc = (a) => a.toLowerCase();
  const wanted = new Map([['usdc', { l1Token: A(0xc0), candidates: new Set([lc(USDC), lc(USDC_E)]) }]]);
  const l1 = stub((c) => {
    if (c.functionName === 'OTHER_BRIDGE') return { status: 'success', result: OP_L2_STANDARD_BRIDGE };
    if (c.functionName === 'balanceOf') return { status: 'success', result: 1000n };
    if (c.functionName === 'deposits') return { status: 'success', result: lc(c.args[1]) === lc(USDC_E) ? 996n : 4n };
    throw new Error(c.functionName);
  });
  const { proofs, record } = await readBridgeProofs({ slug: 'base', l1, l1Block: 9n, wanted });
  assert.equal(proofs.get('usdc').canonical, USDC_E);
  assert.deepEqual(record, { method: 'op-standard-bridge-deposits', l1Bridge: BRIDGES.base.l1Bridge, l1CheckedAtBlock: 9 });

  const wrong = stub((c) => (c.functionName === 'OTHER_BRIDGE' ? { status: 'success', result: A(1) } : { status: 'failure' }));
  await assert.rejects(readBridgeProofs({ slug: 'base', l1: wrong, l1Block: 9n, wanted }), /not an OP Stack L1 standard bridge/);
});

test('Ethereum has no bridge proof', async () => {
  await assert.rejects(readBridgeProofs({ slug: 'ethereum', wanted: new Map() }), /no canonical bridge/);
});
