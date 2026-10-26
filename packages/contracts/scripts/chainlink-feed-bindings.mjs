#!/usr/bin/env node
/**
 * #2880 — DRAFTS a chain's reviewed Chainlink feed bindings
 * (`contracts/deployments/<slug>/feed-bindings.json`). Offline in the sense
 * that matters: it signs nothing and sends nothing. The file it writes reaches
 * a chain only after it merges by pull-request review and the feed service
 * proposes it to that chain's `VaipakamFeedRegistry` (design:
 * docs/DesignsAndPlans/FeedRegistryDesign.md §5).
 *
 * WHY A BINDING NEEDS SOURCES. The registry proves on chain what a chain can
 * prove: the token answers `decimals()`, the feed answers the declared
 * decimals and pair name, and its latest answer is positive and within its
 * heartbeat. It cannot prove which token a pair name means — "USDC / USD" says
 * nothing about which of two USDC contracts on a chain it prices. That is what
 * this tool drafts, and it drafts a binding only where three independent
 * sources name the same token address.
 *
 * WHAT IT DOES:
 *   1. Reads Chainlink's published directory for the chain (fetched, or a
 *      saved copy with `--directory`), and records its SHA-256 and date. Keeps
 *      reference price feeds quoted in USD or ETH, standard proxies only (no
 *      SVR variants), in the low or medium category, with no shutdown date.
 *      Everything else is listed under `skipped` with its reason; a high, new
 *      or custom feed enters only as a hand-written `manual` entry.
 *   2. For each kept feed, collects the token addresses each source gives for
 *      the feed's base symbol on this chain: CoinGecko (its coin list with
 *      per-platform contracts), CoinMarketCap (`/v2/cryptocurrency/info`), and
 *      the chain's official token list(s).
 *   3. Drafts a binding only when exactly one address is named by all three.
 *      Any other outcome (a source naming none, the three disagreeing, two
 *      addresses named by all three) is written to `review` with every
 *      source's answer, and nothing is drafted for it. A feed for which no
 *      source names any token on the chain (SOL / USD on an L2, say) is
 *      `skipped` instead: there is nothing to review.
 *   4. Reads every drafted binding on chain through `--rpc` (a public RPC per
 *      chain by default) the way the registry will check it: the feed's
 *      `description()` (which becomes the binding's `pair`), its
 *      `decimals()` against the directory, its latest answer against the
 *      heartbeat, and the token's `decimals()` against the token list. A
 *      binding that fails a read moves to `review`, so the file carries no
 *      binding the registry would refuse.
 *
 * MANUAL ENTRIES. The owner may add entries by hand under `manual`, each with
 * a `source` stating where the address came from (an issuer's page, say). A
 * rerun keeps them verbatim and drafts nothing for a (token, quote) a manual
 * entry already covers.
 *
 * KEYS. COINGECKO_API_KEY (a CoinGecko Demo key) and COINMARKETCAP_API_KEY are
 * read from the environment, or from `--env-file` (only those two names are
 * read from it). They are sent as request headers, never in a URL, and no
 * message this tool prints contains them.
 *
 * Usage (from the repository root):
 *   node packages/contracts/scripts/chainlink-feed-bindings.mjs \
 *     --chain base --env-file contracts/.env [--rpc <url>] \
 *     [--directory <saved.json> | --save-directory <path>] [--date YYYYMMDD] \
 *     [--out <path>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, isAddress, parseAbi } from 'viem';
import { isEntryPoint } from './entry-point.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The registry's quote denominations, as `VaipakamFeedRegistry.USD()` / `.ETH()`. */
export const QUOTES = Object.freeze({
  USD: '0x0000000000000000000000000000000000000348',
  ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
});

const DIRECTORY = 'https://reference-data-directory.vercel.app';
const SUPERCHAIN_LIST = 'https://static.optimism.io/optimism.tokenlist.json';

/**
 * The Phase-1 mainnets (TokenomicsTechSpec §10). `slug` is the deployments
 * directory (`Deployments.slugForChainId`). `cmcPlatforms` are the platform
 * names CoinMarketCap files this chain's contracts under; a run reports every
 * platform name it saw for the symbols it asked about, so a renamed platform
 * shows up as missing CoinMarketCap answers rather than silently.
 */
export const CHAINS = Object.freeze({
  ethereum: {
    chainId: 1,
    directory: `${DIRECTORY}/feeds-mainnet.json`,
    coingeckoPlatform: 'ethereum',
    cmcPlatforms: ['Ethereum'],
    tokenLists: [SUPERCHAIN_LIST],
    rpc: 'https://ethereum-rpc.publicnode.com',
  },
  base: {
    chainId: 8453,
    directory: `${DIRECTORY}/feeds-ethereum-mainnet-base-1.json`,
    coingeckoPlatform: 'base',
    cmcPlatforms: ['Base'],
    tokenLists: [SUPERCHAIN_LIST],
    rpc: 'https://mainnet.base.org',
  },
  optimism: {
    chainId: 10,
    directory: `${DIRECTORY}/feeds-ethereum-mainnet-optimism-1.json`,
    coingeckoPlatform: 'optimistic-ethereum',
    cmcPlatforms: ['Optimism'],
    tokenLists: [SUPERCHAIN_LIST],
    rpc: 'https://mainnet.optimism.io',
  },
  arbitrum: {
    chainId: 42161,
    directory: `${DIRECTORY}/feeds-ethereum-mainnet-arbitrum-1.json`,
    coingeckoPlatform: 'arbitrum-one',
    cmcPlatforms: ['Arbitrum'],
    tokenLists: [
      'https://tokenlist.arbitrum.io/ArbTokenLists/arbed_arb_whitelist_era.json',
      'https://tokenlist.arbitrum.io/ArbTokenLists/arbed_uniswap_labs.json',
    ],
    rpc: 'https://arb1.arbitrum.io/rpc',
  },
  polygon: {
    chainId: 137,
    directory: `${DIRECTORY}/feeds-matic-mainnet.json`,
    coingeckoPlatform: 'polygon-pos',
    cmcPlatforms: ['Polygon'],
    tokenLists: ['https://api-polygon-tokens.polygon.technology/tokenlists/default.tokenlist.json'],
    rpc: 'https://polygon-rpc.com',
  },
});

const SOURCES = ['coingecko', 'coinmarketcap', 'tokenList'];
const CATEGORIES = new Set(['low', 'medium']);
const MANUAL_CATEGORIES = new Set(['low', 'medium', 'high', 'new', 'custom']);

// ---------------------------------------------------------------- arguments

const FLAGS = new Set(['chain', 'env-file', 'rpc', 'directory', 'save-directory', 'date', 'out']);

/** Parses `--flag value` pairs; refuses an unknown flag or a missing value. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith('--') || !FLAGS.has(flag.slice(2))) throw new Error(`unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  if (!out.chain) throw new Error(`--chain is required (one of ${Object.keys(CHAINS).join(', ')})`);
  if (!CHAINS[out.chain]) throw new Error(`unknown --chain ${out.chain} (one of ${Object.keys(CHAINS).join(', ')})`);
  if (out.date !== undefined && !/^\d{8}$/.test(out.date)) throw new Error('--date must be YYYYMMDD');
  if (out.directory && out['save-directory']) throw new Error('--save-directory applies only to a fetched directory');
  return out;
}

/**
 * Reads ONLY the two API key names from a dotenv-style file. Every other line
 * is ignored, so nothing else in that file is read into this process.
 */
export function readKeys(text) {
  const keys = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(COINGECKO_API_KEY|COINMARKETCAP_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) keys[m[1]] = v;
  }
  return keys;
}

// ---------------------------------------------------------------- step 1

/**
 * Splits the directory into the feeds this tool may draft and the rest, each
 * of the rest with its reason. Pure.
 */
export function selectFeeds(directory) {
  const kept = [];
  const skipped = [];
  const skip = (f, reason) => skipped.push({ pair: f.name, directoryPath: f.path, reason });
  for (const f of directory) {
    const docs = f.docs ?? {};
    if (docs.productType !== 'Price' || docs.productSubType !== 'Reference') {
      skip(f, `not a reference price feed (${docs.productType ?? 'no type'}${docs.productSubType ? ` / ${docs.productSubType}` : ''})`);
    } else if (/(^|-)svr(-|$)/.test(f.path ?? '') || f.svrDisplayLabel) {
      skip(f, 'an SVR variant; the standard proxy is used');
    } else if (docs.assetClass !== 'Crypto') {
      skip(f, `a ${docs.assetClass ?? 'non-crypto'} reference rate, not a token`);
    } else if (docs.quoteAsset !== 'USD' && docs.quoteAsset !== 'ETH') {
      skip(f, `quoted in ${docs.quoteAsset ?? 'nothing'}; the registry takes USD and ETH`);
    } else if (!CATEGORIES.has(f.feedCategory)) {
      skip(f, `category ${f.feedCategory || 'unset'}; enters only as a manual entry`);
    } else if (docs.shutdownDate) {
      skip(f, `shutdown date ${docs.shutdownDate}`);
    } else if (docs.hidden) {
      skip(f, 'hidden in the directory');
    } else if (String(docs.baseAsset).toUpperCase() === 'ETH') {
      skip(f, "ETH: WETH is priced by the Diamond's own ETH feed, not the registry");
    } else if (!isAddress(f.proxyAddress ?? '')) {
      skip(f, 'no proxy address');
    } else {
      kept.push({
        pair: f.name,
        directoryPath: f.path,
        base: String(docs.baseAsset),
        quote: docs.quoteAsset,
        feed: getAddress(f.proxyAddress),
        feedDecimals: f.decimals,
        heartbeat: f.heartbeat,
        category: f.feedCategory,
      });
    }
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------- step 2

const lower = (s) => String(s).toLowerCase();

/** symbol (lower case) → Set of lower-case addresses, from CoinGecko's coin list. */
export function coingeckoIndex(coins, platform) {
  const idx = new Map();
  for (const c of coins) {
    const a = c.platforms?.[platform];
    if (!a || !isAddress(a)) continue;
    const s = lower(c.symbol);
    if (!idx.has(s)) idx.set(s, new Set());
    idx.get(s).add(lower(a));
  }
  return idx;
}

/**
 * symbol (lower case) → Set of lower-case addresses, from CoinMarketCap's
 * `/v2/cryptocurrency/info` answers (`data` maps a symbol to its coins).
 * Also returns every platform name seen, for the run report.
 */
export function coinmarketcapIndex(responses, platformNames) {
  const want = new Set(platformNames.map(lower));
  const idx = new Map();
  const seen = new Set();
  for (const r of responses) {
    for (const [sym, coins] of Object.entries(r.data ?? {})) {
      for (const coin of Array.isArray(coins) ? coins : [coins]) {
        for (const ca of coin.contract_address ?? []) {
          const name = ca.platform?.name;
          if (name) seen.add(name);
          if (!want.has(lower(name)) || !isAddress(ca.contract_address ?? '')) continue;
          const s = lower(coin.symbol ?? sym);
          if (!idx.has(s)) idx.set(s, new Set());
          idx.get(s).add(lower(ca.contract_address));
        }
      }
    }
  }
  return { idx, platformsSeen: [...seen].sort() };
}

/** symbol (lower case) → Map(lower-case address → decimals), from token lists. */
export function tokenListIndex(lists, chainId) {
  const idx = new Map();
  for (const l of lists) {
    for (const t of l.tokens ?? []) {
      if (t.chainId !== chainId || !isAddress(t.address ?? '')) continue;
      const s = lower(t.symbol);
      if (!idx.has(s)) idx.set(s, new Map());
      idx.get(s).set(lower(t.address), t.decimals);
    }
  }
  return idx;
}

// ---------------------------------------------------------------- step 3

const sorted = (set) => [...set].map((a) => getAddress(a)).sort();

/**
 * Resolves each kept feed to a token: a binding when exactly one address is
 * named by all three sources, a review item otherwise, and a skip when no
 * source names any token for the symbol on this chain. Pure.
 */
export function resolveBindings(kept, { coingecko, coinmarketcap, tokenList }, manual = []) {
  const covered = new Set(manual.map((m) => `${lower(m.token)}|${m.quote}`));
  const drafts = [];
  const review = [];
  const skipped = [];
  for (const f of kept) {
    const s = lower(f.base);
    const answers = {
      coingecko: coingecko.get(s) ?? new Set(),
      coinmarketcap: coinmarketcap.get(s) ?? new Set(),
      tokenList: new Set((tokenList.get(s) ?? new Map()).keys()),
    };
    const candidates = Object.fromEntries(SOURCES.map((k) => [k, sorted(answers[k])]));
    if (SOURCES.every((k) => answers[k].size === 0)) {
      skipped.push({ pair: f.pair, directoryPath: f.directoryPath, reason: `no source names a ${f.base} token on this chain` });
      continue;
    }
    const all = [...answers.coingecko].filter((a) => answers.coinmarketcap.has(a) && answers.tokenList.has(a));
    if (all.length !== 1) {
      const missing = SOURCES.filter((k) => answers[k].size === 0);
      const reason =
        all.length > 1
          ? `${all.length} addresses are named by all three sources`
          : missing.length > 0
            ? `no address from ${missing.join(' and ')}`
            : 'the sources name different addresses';
      review.push({ pair: f.pair, directoryPath: f.directoryPath, feed: f.feed, quote: f.quote, reason, candidates });
      continue;
    }
    const token = all[0];
    if (covered.has(`${token}|${f.quote}`)) {
      skipped.push({ pair: f.pair, directoryPath: f.directoryPath, reason: 'a manual entry covers this token and quote' });
      continue;
    }
    const others = {};
    for (const k of SOURCES) {
      const extra = candidates[k].filter((a) => lower(a) !== token);
      if (extra.length) others[k] = extra;
    }
    drafts.push({
      token: getAddress(token),
      symbol: f.base,
      tokenDecimals: tokenList.get(s).get(token),
      quote: f.quote,
      quoteAddress: QUOTES[f.quote],
      feed: f.feed,
      feedDecimals: f.feedDecimals,
      pair: f.pair,
      heartbeat: f.heartbeat,
      category: f.category,
      directoryPath: f.directoryPath,
      agreedBy: [...SOURCES],
      ...(Object.keys(others).length ? { otherCandidates: others } : {}),
    });
  }
  // Two feeds may resolve to one (token, quote): the registry holds one, so
  // neither is drafted and both go to review.
  const byKey = new Map();
  for (const d of drafts) {
    const k = `${d.token}|${d.quote}`;
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  const bindings = [];
  for (const group of byKey.values()) {
    if (group.length === 1) {
      bindings.push(group[0]);
      continue;
    }
    for (const d of group) {
      review.push({
        pair: d.pair,
        directoryPath: d.directoryPath,
        feed: d.feed,
        quote: d.quote,
        reason: `${group.length} feeds resolve to ${d.symbol} / ${d.quote} (${group.map((g) => g.directoryPath).join(', ')})`,
        candidates: { token: [d.token] },
      });
    }
  }
  return { bindings, review, skipped };
}

// ---------------------------------------------------------------- step 4

/**
 * Applies the on-chain reads to the drafted bindings: a binding whose reads
 * fail or disagree moves to review; the rest take the feed's own
 * `description()` as `pair`. `reads` maps a binding to its read results (or
 * an `error`). Pure.
 */
export function applyChainReads(bindings, reads, nowSec) {
  const kept = [];
  const review = [];
  for (const b of bindings) {
    const r = reads.get(b) ?? { error: 'not read' };
    const problems = [];
    if (r.error) problems.push(`on-chain read failed: ${r.error}`);
    else {
      if (r.feedDecimals !== b.feedDecimals) problems.push(`feed decimals ${r.feedDecimals}, directory says ${b.feedDecimals}`);
      if (!r.description.endsWith(` / ${b.quote}`)) problems.push(`feed description "${r.description}" is not quoted in ${b.quote}`);
      if (!(r.answer > 0n)) problems.push('feed answer is not positive');
      if (nowSec - r.updatedAt > BigInt(b.heartbeat)) problems.push(`feed answer is older than its ${b.heartbeat}s heartbeat`);
      if (b.tokenDecimals !== undefined && r.tokenDecimals !== b.tokenDecimals) {
        problems.push(`token decimals ${r.tokenDecimals}, token list says ${b.tokenDecimals}`);
      }
    }
    if (problems.length) {
      review.push({ pair: b.pair, directoryPath: b.directoryPath, feed: b.feed, quote: b.quote, reason: problems.join('; '), candidates: { token: [b.token] } });
      continue;
    }
    const out = { ...b, pair: r.description, tokenDecimals: r.tokenDecimals };
    if (r.description !== b.pair) out.directoryName = b.pair;
    kept.push(out);
  }
  return { kept, review };
}

const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);

async function readChain(client, bindings) {
  const reads = new Map();
  for (const b of bindings) {
    try {
      const [description, feedDecimals, round, tokenDecimals] = await Promise.all([
        client.readContract({ address: b.feed, abi: FEED_ABI, functionName: 'description' }),
        client.readContract({ address: b.feed, abi: FEED_ABI, functionName: 'decimals' }),
        client.readContract({ address: b.feed, abi: FEED_ABI, functionName: 'latestRoundData' }),
        client.readContract({ address: b.token, abi: FEED_ABI, functionName: 'decimals' }),
      ]);
      reads.set(b, { description, feedDecimals, answer: round[1], updatedAt: round[3], tokenDecimals });
    } catch (err) {
      reads.set(b, { error: (err?.shortMessage ?? 'read reverted').slice(0, 200) });
    }
  }
  return reads;
}

// ---------------------------------------------------------------- manual

/** Validates the hand-written entries an existing file carries. */
export function checkManual(manual) {
  if (!Array.isArray(manual)) throw new Error('manual must be an array');
  for (const [i, m] of manual.entries()) {
    const where = `manual[${i}]`;
    if (!isAddress(m.token ?? '') || !isAddress(m.feed ?? '')) throw new Error(`${where}: token and feed must be addresses`);
    if (!QUOTES[m.quote]) throw new Error(`${where}: quote must be USD or ETH`);
    if (!MANUAL_CATEGORIES.has(m.category)) throw new Error(`${where}: category must be one of ${[...MANUAL_CATEGORIES].join(', ')}`);
    if (typeof m.pair !== 'string' || !m.pair.endsWith(` / ${m.quote}`)) throw new Error(`${where}: pair must end with " / ${m.quote}"`);
    if (typeof m.source !== 'string' || m.source.trim() === '') throw new Error(`${where}: source must say where the token address came from`);
  }
  return manual;
}

// ---------------------------------------------------------------- I/O

async function fetchBytes(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new Error(`could not fetch ${new URL(url).origin}${new URL(url).pathname}: ${err?.cause?.code ?? err?.name ?? 'network error'}`);
  }
  // The path is named, never the headers (they carry the keys) or the query.
  if (!res.ok) throw new Error(`${new URL(url).origin}${new URL(url).pathname} answered HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const todayUtc = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function main(argv) {
  const args = parseArgs(argv);
  const chain = CHAINS[args.chain];
  const keys = { ...(args['env-file'] ? readKeys(readFileSync(args['env-file'], 'utf8')) : {}) };
  for (const k of ['COINGECKO_API_KEY', 'COINMARKETCAP_API_KEY']) keys[k] ??= process.env[k];
  const missing = ['COINGECKO_API_KEY', 'COINMARKETCAP_API_KEY'].filter((k) => !keys[k]);
  if (missing.length) throw new Error(`missing ${missing.join(' and ')} (environment or --env-file)`);

  const out = resolve(args.out ?? join(REPO, 'contracts', 'deployments', args.chain, 'feed-bindings.json'));
  const existing = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  const manual = checkManual(existing.manual ?? []);

  // 1. Directory.
  const dirBytes = args.directory ? readFileSync(args.directory) : await fetchBytes(chain.directory);
  if (args['save-directory']) writeFileSync(args['save-directory'], dirBytes);
  const directory = JSON.parse(dirBytes.toString('utf8'));
  if (!Array.isArray(directory) || directory.length === 0) throw new Error('the directory file lists no feeds');
  const { kept, skipped: skipped1 } = selectFeeds(directory);

  // 2. Sources.
  const coins = JSON.parse(
    (await fetchBytes('https://api.coingecko.com/api/v3/coins/list?include_platform=true', {
      'x-cg-demo-api-key': keys.COINGECKO_API_KEY,
    })).toString('utf8'),
  );
  if (!Array.isArray(coins) || coins.length === 0) throw new Error('CoinGecko returned no coin list');
  const symbols = [...new Set(kept.map((f) => f.base.toUpperCase()))].sort();
  const cmcResponses = [];
  for (let i = 0; i < symbols.length; i += 50) {
    const q = encodeURIComponent(symbols.slice(i, i + 50).join(','));
    cmcResponses.push(
      JSON.parse(
        (await fetchBytes(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?symbol=${q}&skip_invalid=true`, {
          'X-CMC_PRO_API_KEY': keys.COINMARKETCAP_API_KEY,
          Accept: 'application/json',
        })).toString('utf8'),
      ),
    );
  }
  const lists = [];
  const listMeta = [];
  for (const url of chain.tokenLists) {
    const bytes = await fetchBytes(url);
    const l = JSON.parse(bytes.toString('utf8'));
    lists.push(l);
    const v = l.version ?? {};
    listMeta.push({ url, name: l.name, version: `${v.major}.${v.minor}.${v.patch}`, sha256: sha256(bytes) });
  }
  const cmc = coinmarketcapIndex(cmcResponses, chain.cmcPlatforms);

  // 3. Resolve.
  const resolved = resolveBindings(
    kept,
    { coingecko: coingeckoIndex(coins, chain.coingeckoPlatform), coinmarketcap: cmc.idx, tokenList: tokenListIndex(lists, chain.chainId) },
    manual,
  );

  // 4. On-chain reads.
  const client = createPublicClient({ transport: http(args.rpc ?? chain.rpc) });
  const chainId = await client.getChainId();
  if (chainId !== chain.chainId) throw new Error(`--rpc serves chain ${chainId}, not ${args.chain} (${chain.chainId})`);
  const block = await client.getBlock({ blockTag: 'latest' });
  const reads = await readChain(client, resolved.bindings);
  const checked = applyChainReads(resolved.bindings, reads, block.timestamp);

  const byPair = (a, b) => a.pair.localeCompare(b.pair) || a.directoryPath.localeCompare(b.directoryPath);
  const file = {
    schema: 1,
    chain: { slug: args.chain, chainId: chain.chainId },
    directory: { url: chain.directory, sha256: sha256(dirBytes), date: Number(args.date ?? todayUtc()) },
    sources: {
      coingecko: { platform: chain.coingeckoPlatform },
      coinmarketcap: { platforms: chain.cmcPlatforms },
      tokenLists: listMeta,
    },
    checkedAtBlock: Number(block.number),
    bindings: checked.kept.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.quote.localeCompare(b.quote)),
    manual,
    review: [...resolved.review, ...checked.review].sort(byPair),
    skipped: [...skipped1, ...resolved.skipped].sort(byPair),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

  console.log(`${args.chain}: ${file.bindings.length} drafted, ${manual.length} manual, ${file.review.length} to review, ${file.skipped.length} skipped`);
  console.log(`directory sha256 ${file.directory.sha256}, date ${file.directory.date}`);
  const near = cmc.platformsSeen.filter((n) => chain.cmcPlatforms.some((p) => lower(n).includes(lower(p))));
  console.log(`CoinMarketCap platform names matching this chain: ${near.join(', ') || '(none)'}`);
  console.log(`wrote ${out}`);
}

if (isEntryPoint(import.meta)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`chainlink-feed-bindings: ${err.message}`);
    process.exit(1);
  });
}
