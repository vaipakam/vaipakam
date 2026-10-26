// chainlink-feed-bindings.test.mjs — #2880: the drafting rules, on small
// hand-written inputs. The network and the chain are not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import {
  LIVENESS_GRACE_SEC,
  QUOTES,
  applyChainReads,
  checkManual,
  coingeckoIndex,
  coinmarketcapIndex,
  parseArgs,
  readKeys,
  resolveBindings,
  selectFeeds,
  tokenListIndex,
} from './chainlink-feed-bindings.mjs';

const A = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const USDC = A(0xc1);
const USDC_E = A(0xc2);
const LINK = A(0x11);
const SCAM = A(0x5c);

/** One directory row with the fields the tool reads. */
function feed(name, path, docs = {}, extra = {}) {
  const [base, quote] = name.split(' / ');
  return {
    name,
    path,
    proxyAddress: A(0xf000 + path.length),
    decimals: 8,
    heartbeat: 86400,
    feedCategory: 'low',
    docs: { productType: 'Price', productSubType: 'Reference', assetClass: 'Crypto', baseAsset: base, quoteAsset: quote, ...docs },
    ...extra,
  };
}

test('keeps only standard low/medium USD or ETH reference price feeds, and says why for the rest', () => {
  const { kept, skipped } = selectFeeds([
    feed('USDC / USD', 'usdc-usd'),
    feed('USDC / USD', 'usdc-usd-svr'),
    feed('DOGE / USD', 'doge-usd-shared-svr-2'),
    feed('LINK / ETH', 'link-eth', {}, { feedCategory: 'medium' }),
    feed('FOO / USD', 'foo-usd', {}, { feedCategory: 'high' }),
    feed('BAR / USD', 'bar-usd', {}, { feedCategory: 'new' }),
    feed('OLD / USD', 'old-usd', { shutdownDate: 'Dec 31, 2026' }),
    feed('EUR / USD', 'eur-usd', { assetClass: 'Fiat' }),
    feed('STETH / BTC', 'steth-btc'),
    feed('ETH / USD', 'eth-usd'),
    feed('iBTC PoR', 'ibtc-por', { productType: 'Proof of Reserve' }),
  ]);
  assert.deepEqual(kept.map((f) => f.directoryPath), ['usdc-usd', 'link-eth']);
  const why = Object.fromEntries(skipped.map((s) => [s.directoryPath, s.reason]));
  assert.match(why['usdc-usd-svr'], /SVR/);
  assert.match(why['doge-usd-shared-svr-2'], /SVR/);
  assert.match(why['foo-usd'], /category high; enters only as a manual entry/);
  assert.match(why['bar-usd'], /category new/);
  assert.match(why['old-usd'], /shutdown date/);
  assert.match(why['eur-usd'], /Fiat reference rate/);
  assert.match(why['steth-btc'], /quoted in BTC/);
  assert.match(why['eth-usd'], /Diamond's own ETH feed/);
  assert.match(why['ibtc-por'], /not a reference price feed/);
});

/** Indexes built the way the tool builds them, from source-shaped inputs. */
function sources({ cg = [], cmc = [], list = [] }) {
  return {
    coingecko: coingeckoIndex(cg.map(([symbol, addr]) => ({ id: symbol, symbol, platforms: { base: addr } })), 'base'),
    coinmarketcap: coinmarketcapIndex(
      [{ data: cmc.reduce((data, [symbol, addr]) => {
        const s = symbol.toUpperCase();
        (data[s] ??= []).push({ symbol: s, contract_address: [{ contract_address: addr, platform: { name: 'Base' } }] });
        return data;
      }, {}) }],
      ['Base'],
    ).idx,
    tokenList: tokenListIndex([{ tokens: list.map(([symbol, address, decimals]) => ({ chainId: 8453, symbol, address, decimals })) }], 8453),
  };
}

const kept = (...names) => selectFeeds(names.map((n) => feed(n, n.toLowerCase().replace(' / ', '-')))).kept;

test('drafts a binding only when all three sources name the same single address', () => {
  const r = resolveBindings(
    kept('USDC / USD', 'LINK / USD'),
    sources({
      cg: [['usdc', USDC], ['usdc', SCAM], ['link', LINK]],
      cmc: [['USDC', USDC], ['LINK', LINK]],
      list: [['USDC', USDC, 6]],
    }),
  );
  assert.equal(r.bindings.length, 1);
  const [b] = r.bindings;
  assert.equal(b.token, USDC);
  assert.equal(b.quoteAddress, QUOTES.USD);
  assert.equal(b.tokenDecimals, 6);
  assert.deepEqual(b.agreedBy, ['coingecko', 'coinmarketcap', 'tokenList']);
  // The scam coin CoinGecko also lists under the symbol is shown, not hidden.
  assert.deepEqual(b.otherCandidates, { coingecko: [SCAM] });
  // LINK is missing from the token list: review, with every answer.
  assert.equal(r.review.length, 1);
  assert.match(r.review[0].reason, /no address from tokenList/);
  assert.deepEqual(r.review[0].candidates, { coingecko: [LINK], coinmarketcap: [LINK], tokenList: [] });
});

test('two addresses named by all three is review, not a pick', () => {
  const r = resolveBindings(
    kept('USDC / USD'),
    sources({ cg: [['usdc', USDC], ['usdc', USDC_E]], cmc: [['USDC', USDC], ['USDC', USDC_E]], list: [['USDC', USDC, 6], ['USDC', USDC_E, 6]] }),
  );
  assert.equal(r.bindings.length, 0);
  assert.match(r.review[0].reason, /2 addresses are named by all three/);
});

test('sources that disagree are review', () => {
  const r = resolveBindings(kept('USDC / USD'), sources({ cg: [['usdc', USDC]], cmc: [['USDC', USDC_E]], list: [['USDC', USDC, 6]] }));
  assert.equal(r.bindings.length, 0);
  assert.match(r.review[0].reason, /different addresses/);
});

test('a symbol no source knows on this chain is skipped, not reviewed', () => {
  const r = resolveBindings(kept('SOL / USD'), sources({}));
  assert.equal(r.review.length, 0);
  assert.match(r.skipped[0].reason, /no source names a SOL token/);
});

test('symbols match without regard to case (USDE / USDe)', () => {
  const r = resolveBindings(kept('USDE / USD'), sources({ cg: [['usde', USDC]], cmc: [['USDE', USDC]], list: [['USDe', USDC, 18]] }));
  assert.equal(r.bindings.length, 1);
});

test('two feeds resolving to one token and quote are both sent to review', () => {
  const two = selectFeeds([feed('cbBTC / USD', 'cbbtc-usd'), feed('CBBTC / USD', 'cbbtc-usd-2')]).kept;
  const r = resolveBindings(two, sources({ cg: [['cbbtc', LINK]], cmc: [['CBBTC', LINK]], list: [['cbBTC', LINK, 8]] }));
  assert.equal(r.bindings.length, 0);
  assert.equal(r.review.length, 2);
  assert.match(r.review[0].reason, /2 feeds resolve to/);
});

test('a manual entry for the same token and quote suppresses the draft', () => {
  const manual = checkManual([
    { token: USDC, quote: 'USD', feed: A(0xabc), pair: 'USDC / USD', category: 'low', source: 'https://www.circle.com/multi-chain-usdc/base' },
  ]);
  const r = resolveBindings(kept('USDC / USD'), sources({ cg: [['usdc', USDC]], cmc: [['USDC', USDC]], list: [['USDC', USDC, 6]] }), manual);
  assert.equal(r.bindings.length, 0);
  assert.match(r.skipped[0].reason, /manual entry covers/);
});

test('a manual entry must say where its address came from', () => {
  const ok = { token: USDC, quote: 'USD', feed: A(0xabc), pair: 'USDC / USD', category: 'high', source: 'issuer page' };
  assert.doesNotThrow(() => checkManual([ok]));
  assert.throws(() => checkManual([{ ...ok, source: ' ' }]), /source must say/);
  assert.throws(() => checkManual([{ ...ok, quote: 'BTC' }]), /quote must be USD or ETH/);
  assert.throws(() => checkManual([{ ...ok, pair: 'USDC / ETH' }]), /pair must end/);
  assert.throws(() => checkManual([{ ...ok, category: 'deprecating' }]), /category must be/);
});

test('on-chain reads: the feed description becomes the pair, and any disagreement is review', () => {
  const r = resolveBindings(
    kept('USDC / USD', 'LINK / USD'),
    sources({ cg: [['usdc', USDC], ['link', LINK]], cmc: [['USDC', USDC], ['LINK', LINK]], list: [['USDC', USDC, 6], ['LINK', LINK, 18]] }),
  );
  const [usdc, link] = r.bindings;
  const now = 1_000_000n;
  const reads = new Map([
    [usdc, { description: 'USDC / USD', feedDecimals: 8, answer: 100_000_000n, updatedAt: now - 60n, tokenDecimals: 6 }],
    [link, { description: 'LINK / USD', feedDecimals: 8, answer: 1n, updatedAt: now - 86_400n - LIVENESS_GRACE_SEC - 1n, tokenDecimals: 18 }],
  ]);
  const c = applyChainReads(r.bindings, reads, now);
  assert.deepEqual(c.kept.map((b) => b.symbol), ['USDC']);
  assert.match(c.review[0].reason, /older than its 86400s heartbeat plus the registry's 3600s grace/);

  // A round past its heartbeat but inside the grace is late, not dead.
  const late = new Map([[link, { description: 'LINK / USD', feedDecimals: 8, answer: 1n, updatedAt: now - 86_400n - LIVENESS_GRACE_SEC, tokenDecimals: 18 }]]);
  assert.equal(applyChainReads([link], late, now).kept.length, 1);

  const wrong = new Map([[usdc, { description: 'USD Coin / ETH', feedDecimals: 18, answer: 1n, updatedAt: now, tokenDecimals: 18 }]]);
  const w = applyChainReads([usdc], wrong, now);
  assert.equal(w.kept.length, 0);
  assert.match(w.review[0].reason, /feed decimals 18, directory says 8/);
  assert.match(w.review[0].reason, /not quoted in USD/);
  assert.match(w.review[0].reason, /token decimals 18, token list says 6/);

  const failed = applyChainReads([usdc], new Map([[usdc, { error: 'execution reverted' }]]), now);
  assert.match(failed.review[0].reason, /on-chain read failed: execution reverted/);

  const renamed = applyChainReads([usdc], new Map([[usdc, { description: 'USDC/USD', feedDecimals: 8, answer: 1n, updatedAt: now, tokenDecimals: 6 }]]), now);
  assert.equal(renamed.kept.length, 0, 'a description the registry would refuse as quote-less is review');
});

test('a feed that prices a different symbol than the one resolved is review, not a binding', () => {
  // The directory files the FXS / USD feed under FRAX (FXS's new name), and
  // every source agrees on the token they still call FRAX: the old stablecoin.
  const r = resolveBindings(
    selectFeeds([feed('FXS / USD', 'fxs-usd', { baseAsset: 'FRAX' })]).kept,
    sources({ cg: [['frax', USDC]], cmc: [['FRAX', USDC]], list: [['FRAX', USDC, 18]] }),
  );
  assert.equal(r.bindings.length, 1, 'symbol agreement alone drafts it');
  const now = 10n;
  const c = applyChainReads(r.bindings, new Map([[r.bindings[0], { description: 'FXS / USD', feedDecimals: 8, answer: 1n, updatedAt: now, tokenDecimals: 18 }]]), now);
  assert.equal(c.kept.length, 0);
  assert.match(c.review[0].reason, /feed prices "FXS" but the token was resolved as "FRAX"/);
});

test('a directory name that differs from the feed description is kept as directoryName', () => {
  const r = resolveBindings(kept('TBTC / USD'), sources({ cg: [['tbtc', LINK]], cmc: [['TBTC', LINK]], list: [['tBTC', LINK, 18]] }));
  const now = 10n;
  const c = applyChainReads(r.bindings, new Map([[r.bindings[0], { description: 'tBTC / USD', feedDecimals: 8, answer: 1n, updatedAt: now, tokenDecimals: 18 }]]), now);
  assert.equal(c.kept[0].pair, 'tBTC / USD');
  assert.equal(c.kept[0].directoryName, 'TBTC / USD');
});

test('reads only the two key names from an env file', () => {
  const keys = readKeys(['DEPLOYER_PRIVATE_KEY=0xsecret', 'export COINGECKO_API_KEY="cg-1"', "COINMARKETCAP_API_KEY = 'cmc-2'", 'COINGECKO_API_KEY_OLD=x'].join('\n'));
  assert.deepEqual(keys, { COINGECKO_API_KEY: 'cg-1', COINMARKETCAP_API_KEY: 'cmc-2' });
});

test('arguments: a chain is required, unknown flags and bad dates are refused', () => {
  assert.throws(() => parseArgs([]), /--chain is required/);
  assert.throws(() => parseArgs(['--chain', 'bnb']), /unknown --chain/);
  assert.throws(() => parseArgs(['--chain', 'base', '--key', 'x']), /unknown argument/);
  assert.throws(() => parseArgs(['--chain', 'base', '--date', '2026-10-26']), /YYYYMMDD/);
  assert.throws(() => parseArgs(['--chain', 'base', '--rpc']), /needs a value/);
  assert.deepEqual(parseArgs(['--chain', 'base', '--date', '20261026']), { chain: 'base', date: '20261026' });
});

test("the tool's liveness grace is the registry's", () => {
  const sol = readFileSync(new URL('../../../contracts/src/oracle/VaipakamFeedRegistry.sol', import.meta.url), 'utf8');
  const m = sol.match(/uint256 public constant LIVENESS_GRACE = (\d+) hours;/);
  assert.ok(m, 'LIVENESS_GRACE declaration not found in VaipakamFeedRegistry.sol');
  assert.equal(BigInt(m[1]) * 3600n, LIVENESS_GRACE_SEC);
});
