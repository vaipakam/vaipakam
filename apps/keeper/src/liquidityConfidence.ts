/**
 * apps/keeper — depth-tiered-LTV liquidity-confidence relay (§4.4 step 5
 * of docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md, §4.1.b
 * item 2).
 *
 * A cron sibling to the autonomous liquidator / matcher. The on-chain
 * `getLiquidityTier` view is a deliberately-conservative pre-screen
 * (Uni-V3-clone family only, single-hop, in-tick approximation); this
 * pass keeps a *liquidity-confidence* counter per (chain, collateral
 * asset) backed by D1, periodically asks the 0x / 1inch aggregators
 * (which route across every spot DEX + multi-hop) what a liquidator
 * would actually net for a sell of each tier size, and:
 *
 *   - PROMOTES the on-chain `keeperTier(asset)` one step at a time only
 *     after the aggregator-confirmed tier has stayed above the current
 *     tier for `LIQ_CONFIDENCE_MIN_CHECKS` consecutive ticks spanning
 *     ≥ `LIQ_CONFIDENCE_MIN_WINDOW_DAYS` days;
 *   - DEMOTES immediately (no window) if the aggregator-confirmed tier
 *     drops below the current `keeperTier` — fail-safe direction;
 *   - never raises `keeperTier` above the on-chain ceiling (the init
 *     gate consults `effectiveTier = min(getLiquidityTier, keeperTier)`,
 *     so a compromised KEEPER_ROLE key can only lower a tier);
 *   - additionally requires, for a *Tier-3* promotion, the
 *     "battle-tested elsewhere" advisory — the asset is listed as
 *     collateral with meaningful TVL on ≥ 1 of {Aave v3, Compound v3,
 *     Morpho-curated} on this chain (an off-chain heuristic, NOT a
 *     parameter source; while unwired the relay caps at Tier 2).
 *
 * Gating:
 *   - Submits `setKeeperTier` only when `KEEPER_ENABLED == 'true'` AND
 *     `KEEPER_PRIVATE_KEY` set (`isKeeperEnabled`) — third consumer of
 *     the single signing key, like the liquidator and the matcher — AND
 *     only when `depthTieredLtvEnabled` is on for the chain (no point
 *     burning gas while the feature is dormant). The confidence counter
 *     in D1 is updated *always* (when the keeper EOA is configured for
 *     reads), so when governance flips the switch the high-confidence
 *     assets catch up in a couple of ticks rather than cold-starting.
 *
 * The aggregator quotes reuse `orchestrateServerQuotes` (the same 0x /
 * 1inch machinery the liquidator packs `triggerLiquidation` with) — we
 * only read `ranked[0].expectedOutput` (the best buy amount); the
 * adapter calldata it also builds is discarded here.
 */

import {
  createPublicClient,
  http,
  erc20Abi,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import {
  ConfigFacetABI,
  OracleFacetABI,
  MetricsFacetABI,
  LoanFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled } from './keeper';
import { orchestrateServerQuotes } from './serverQuotes';
import {
  getLiquidityConfidence,
  upsertLiquidityConfidence,
  type LiquidityConfidenceRow,
} from './db';

/** ConfigFacet hosts `getDepthTierConfigBundle` / `getPaaAssets` /
 *  `getKeeperTier` / `setKeeperTier`; OracleFacet `getAssetPrice`;
 *  MetricsFacet `getActiveLoansCount` / `getActiveLoansPaginated`;
 *  LoanFacet `getLoanDetails`. Merge so viem resolves every selector. */
const RELAY_ABI: Abi = [
  ...(ConfigFacetABI as Abi),
  ...(OracleFacetABI as Abi),
  ...(MetricsFacetABI as Abi),
  ...(LoanFacetABI as Abi),
];

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;
/** Hard cap on distinct collateral assets re-evaluated per tick — a
 *  busy book shouldn't burn the whole aggregator-quote budget. */
const MAX_ASSETS_PER_TICK = 24;
/** Hard cap on `setKeeperTier` submissions per tick. */
const MAX_SUBMITS_PER_TICK = 8;

/** `LibVaipakam.AssetType.ERC20` / `LoanStatus.Active`. */
const ASSET_TYPE_ERC20 = 0;
const LOAN_STATUS_ACTIVE = 0;
/** `LibVaipakam.MAX_LIQUIDITY_TIER`. */
const MAX_TIER = 3;
const BPS = 10_000n;

interface RelayKnobs {
  /** consecutive eligible-to-promote ticks required before a step up */
  minChecks: number;
  /** wall-clock span those ticks must cover, in seconds */
  minWindowSec: number;
  /** when false, `getDepthTierConfigBundle` says the feature is off ⇒
   *  track confidence in D1 but don't submit `setKeeperTier` */
  submitGloballyEnabled: boolean;
}

function parsePosIntEnv(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Read the on-chain depth-tier config + the per-process knobs.
 * Returns `null` if the bundle can't be read (facet not cut on this
 * chain yet, RPC error, …) — the relay then skips the chain.
 */
async function loadConfig(
  client: PublicClient,
  diamond: Address,
  env: Env,
): Promise<
  | {
      slippageBps: bigint;
      sizesPad: readonly [bigint, bigint, bigint, bigint]; // floor, t1, t2, t3
      knobs: RelayKnobs;
    }
  | null
> {
  let bundle: readonly unknown[];
  try {
    bundle = (await client.readContract({
      address: diamond,
      abi: RELAY_ABI,
      functionName: 'getDepthTierConfigBundle',
    })) as readonly unknown[];
  } catch {
    return null;
  }
  // (depthTieredLtvEnabled[0], liquiditySlippageBps[1], twapWindowSec[2],
  //  twapConsistencyBps[3], floorSizePad[4], tier1SizePad[5],
  //  tier2SizePad[6], tier3SizePad[7], tier1MaxInitLtvBps[8], …)
  const depthTieredLtvEnabled = Boolean(bundle[0]);
  const slippageBps = BigInt(bundle[1] as bigint);
  const floorSizePad = BigInt(bundle[4] as bigint);
  const tier1SizePad = BigInt(bundle[5] as bigint);
  const tier2SizePad = BigInt(bundle[6] as bigint);
  const tier3SizePad = BigInt(bundle[7] as bigint);
  if (slippageBps === 0n || floorSizePad === 0n) return null; // sanity
  return {
    slippageBps,
    sizesPad: [floorSizePad, tier1SizePad, tier2SizePad, tier3SizePad],
    knobs: {
      minChecks: parsePosIntEnv(env.LIQ_CONFIDENCE_MIN_CHECKS, 5),
      minWindowSec:
        parsePosIntEnv(env.LIQ_CONFIDENCE_MIN_WINDOW_DAYS, 3) * 86_400,
      submitGloballyEnabled: depthTieredLtvEnabled,
    },
  };
}

/** Distinct ERC-20 collateral assets across all Active loans on this
 *  chain (deduped, lowercased, capped at MAX_ASSETS_PER_TICK). */
async function activeCollateralAssets(
  client: PublicClient,
  diamond: Address,
): Promise<Address[]> {
  let total: bigint;
  try {
    total = (await client.readContract({
      address: diamond,
      abi: RELAY_ABI,
      functionName: 'getActiveLoansCount',
    })) as bigint;
  } catch {
    return [];
  }
  if (total === 0n) return [];

  const ids: bigint[] = [];
  for (let off = 0n; off < total; off += SCAN_PAGE) {
    let page: readonly bigint[];
    try {
      page = (await client.readContract({
        address: diamond,
        abi: RELAY_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [off, SCAN_PAGE],
      })) as readonly bigint[];
    } catch {
      break;
    }
    if (page.length === 0) break;
    ids.push(...page);
  }

  const seen = new Set<string>();
  const out: Address[] = [];
  for (const id of ids) {
    if (out.length >= MAX_ASSETS_PER_TICK) break;
    let loan: { collateralAsset: Address; collateralAssetType: number; status: number };
    try {
      loan = (await client.readContract({
        address: diamond,
        abi: RELAY_ABI,
        functionName: 'getLoanDetails',
        args: [id],
      })) as typeof loan;
    } catch {
      continue;
    }
    if (loan.status !== LOAN_STATUS_ACTIVE) continue;
    if (loan.collateralAssetType !== ASSET_TYPE_ERC20) continue;
    const key = loan.collateralAsset.toLowerCase();
    if (key === '0x0000000000000000000000000000000000000000') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loan.collateralAsset);
  }
  return out;
}

/** Best-effort `(price, feedDecimals)` from the diamond's `getAssetPrice`
 *  (reverts on stale/missing feed → returns null). */
async function getAssetPadPrice(
  client: PublicClient,
  diamond: Address,
  asset: Address,
): Promise<{ price: bigint; feedDec: number } | null> {
  try {
    const r = (await client.readContract({
      address: diamond,
      abi: RELAY_ABI,
      functionName: 'getAssetPrice',
      args: [asset],
    })) as readonly [bigint, number];
    if (r[0] === 0n) return null;
    return { price: BigInt(r[0]), feedDec: Number(r[1]) };
  } catch {
    return null;
  }
}

/** Best-effort ERC-20 decimals — falls back to 18. */
async function tokenDecimals(
  client: PublicClient,
  token: Address,
): Promise<number> {
  try {
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    })) as number;
    return Number.isFinite(d) && d >= 0 && d <= 36 ? Number(d) : 18;
  } catch {
    return 18;
  }
}

/** PAD value (× 1e6) of `amount` base units of a token priced at
 *  `(padPrice, feedDec)` with `tokenDec` decimals — mirrors the
 *  on-chain `mulDiv(amount, padPrice·1e6, 10**(feedDec+tokenDec))`. */
function padValueScaled(
  amount: bigint,
  padPrice: bigint,
  feedDec: number,
  tokenDec: number,
): bigint {
  const denom = 10n ** BigInt(feedDec + tokenDec);
  return (amount * padPrice * 1_000_000n) / denom;
}

/** asset base units worth `sizePad` (PAD × 1e6) — inverse of
 *  {padValueScaled}: `sizePad·10**(feedDec+tokenDec) / (padPrice·1e6)`. */
function baseUnitsForSizePad(
  sizePad: bigint,
  padPrice: bigint,
  feedDec: number,
  tokenDec: number,
): bigint {
  const num = sizePad * 10n ** BigInt(feedDec + tokenDec);
  return num / (padPrice * 1_000_000n);
}

/**
 * The aggregator-confirmed tier (0..3) for `asset` on `chain` — the
 * highest tier whose simulated-sell size clears `slippageBps`, best
 * route over the on-chain PAA list, minimum Tier 1 if the floor clears.
 * `0` if even the floor doesn't clear (or pricing is unavailable).
 * `null` if every aggregator quote failed (don't touch the counter).
 */
async function aggregatorConfirmedTier(
  env: Env,
  client: PublicClient,
  chain: ChainConfig,
  diamond: Address,
  taker: Address,
  asset: Address,
  slippageBps: bigint,
  sizesPad: readonly [bigint, bigint, bigint, bigint],
): Promise<number | null> {
  const assetPrice = await getAssetPadPrice(client, diamond, asset);
  if (!assetPrice) return 0; // not Liquid per the oracle ⇒ untierable

  // PAA quote tokens (resolved on-chain — falls back to [WETH]).
  let paa: readonly Address[];
  try {
    paa = (await client.readContract({
      address: diamond,
      abi: RELAY_ABI,
      functionName: 'getPaaAssets',
    })) as readonly Address[];
  } catch {
    return null;
  }
  const assetDec = await tokenDecimals(client, asset);

  // best[i] = lowest slippage-bps seen at sizesPad[i] across PAA routes.
  const best: bigint[] = [-1n, -1n, -1n, -1n]; // -1 = no successful quote yet
  let anyQuoteSucceeded = false;

  for (const quote of paa) {
    if (quote.toLowerCase() === asset.toLowerCase()) continue;
    const qPrice = await getAssetPadPrice(client, diamond, quote);
    if (!qPrice) continue;
    const qDec = await tokenDecimals(client, quote);

    for (let i = 0; i < 4; i++) {
      const sizePad = sizesPad[i];
      if (sizePad === 0n) continue;
      const sellAmount = baseUnitsForSizePad(
        sizePad,
        assetPrice.price,
        assetPrice.feedDec,
        assetDec,
      );
      if (sellAmount === 0n) continue;
      let res;
      try {
        res = await orchestrateServerQuotes(env, client, {
          chainId: chain.id,
          sellToken: asset,
          buyToken: quote,
          sellAmount,
          taker,
          slippageBps: Number(slippageBps),
        });
      } catch {
        continue;
      }
      if (res.ranked.length === 0) continue;
      anyQuoteSucceeded = true;
      const buyAmount = res.ranked[0].expectedOutput;
      // realized vs oracle, in PAD terms — both legs share the same
      // PAD denomination so decimals cancel cleanly.
      const sellValuePad = padValueScaled(
        sellAmount,
        assetPrice.price,
        assetPrice.feedDec,
        assetDec,
      );
      const buyValuePad = padValueScaled(
        buyAmount,
        qPrice.price,
        qPrice.feedDec,
        qDec,
      );
      if (sellValuePad === 0n) continue;
      const slip =
        buyValuePad >= sellValuePad
          ? 0n
          : ((sellValuePad - buyValuePad) * BPS) / sellValuePad;
      if (best[i] === -1n || slip < best[i]) best[i] = slip;
    }
  }

  if (!anyQuoteSucceeded) return null;
  // Floor must clear.
  if (best[0] === -1n || best[0] > slippageBps) return 0;
  if (best[3] !== -1n && best[3] <= slippageBps) return 3;
  if (best[2] !== -1n && best[2] <= slippageBps) return 2;
  return 1; // cleared the floor ⇒ at least Tier 1
}

/**
 * Tier-3 "battle-tested elsewhere" advisory — a **2-of-3 ensemble** of
 * independent off-chain signals. The relay promotes an asset to Tier 3
 * only when at least two of the three pass; one source down (or one
 * wrong answer) can never single-handedly gate Tier 3, and a pure-
 * popularity token without any DeFi-collateral footprint fails because
 * the DeFi-listing signal alone can't carry it. Fails closed on every
 * fetch error / unsupported chain / missing field.
 *
 *   ① DeFi-collateral listing + TVL — DeFiLlama `/pools` filtered to
 *      {Aave v3, Compound v3, Morpho-blue} on this chain, TVL ≥
 *      `LIQ_TIER3_MIN_TVL_USD` (default $10M). Reads their *listing
 *      decision*, NOT their LTV numbers (those stay theirs). Operator-
 *      disable-able via `LIQ_TIER3_DISABLE_DEFI_LISTING=1` for
 *      operators who want zero competitor-data dependence — when
 *      disabled the ensemble becomes 2-of-2 (both CG signals must
 *      pass), stricter not looser, safe.
 *      ─ Note: `morpho-aave-v3` was dropped from the slug set because
 *         it's a thin Aave-v3 mirror on Morpho — counting it separately
 *         double-counts the same underlying listing decision.
 *
 *   ② Circulating market cap — CoinGecko `/coins/{platform}/contract/
 *      {address}` (free public endpoint, no auth). Reads
 *      `market_data.market_cap.usd` (curated circulating, not
 *      `totalSupply()×price` — excludes locked / treasury). Threshold
 *      `LIQ_TIER3_MIN_MCAP_USD` (default $1B).
 *
 *   ③ Trading volume — 24h aggregate from the same CoinGecko response
 *      (`market_data.total_volume.usd`). 24h is noisier than a 30d
 *      average but it's one call instead of two, with a tighter
 *      threshold `LIQ_TIER3_MIN_VOL_USD` (default $50M/day) to
 *      compensate. Surfaces "the asset is actually traded broadly",
 *      not just held.
 *
 * Why an ensemble vs a single source: CoinGecko / CMC measure *general
 * market presence* (popularity, liquidity), not *collateral
 * suitability* — a high-mcap volatile token (SHIB-like) can pass ②③
 * while no serious lender lists it as collateral. The DeFi-listing
 * signal carries information ②③ miss. Conversely, ② and ③ filter out
 * stable-but-thinly-traded edge cases (e.g. an obscure stablecoin
 * listed on one Morpho market). 2-of-3 catches the broad collateral-
 * suitable mid-cap-and-up set without admitting either failure mode.
 */

// ─── Signal ① state — DeFi-listing via DeFiLlama ────────────────────

interface LlamaPool {
  project: string;
  chain: string;
  tvlUsd?: number;
  underlyingTokens?: string[]; // lowercased 0x addresses
}

/** Shared 1h TTL for both off-chain advisory caches — listing /
 *  market-cap / volume decisions move on days, not minutes. */
const ADVISORY_TTL_MS = 60 * 60 * 1000;
let llamaPoolsCache: { pools: LlamaPool[]; fetchedAt: number } | null = null;

/** DeFiLlama uses display chain names; map every keeper-supported
 *  mainnet here. Testnets / unmapped chains ⇒ signal ① returns false
 *  (the ensemble still has ②+③ to fall back on). Verify additions
 *  against the canonical list at https://api.llama.fi/chains. */
const LLAMA_CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BSC',
  1101: 'Polygon zkEVM',
  8453: 'Base',
  42161: 'Arbitrum',
};

/** Lending-protocol slugs the advisory accepts as "battle-tested
 *  collateral elsewhere". `morpho-aave-v3` deliberately omitted: it's
 *  a thin Aave-v3 mirror on Morpho ⇒ double-counts the same listing
 *  decision against `aave-v3`. */
const TIER3_BATTLETESTED_PROJECTS: ReadonlySet<string> = new Set([
  'aave-v3',
  'compound-v3',
  'morpho-blue',
]);

async function fetchLlamaPoolsCached(): Promise<LlamaPool[]> {
  const now = Date.now();
  if (llamaPoolsCache && now - llamaPoolsCache.fetchedAt < ADVISORY_TTL_MS) {
    return llamaPoolsCache.pools;
  }
  const res = await fetch('https://yields.llama.fi/pools');
  if (!res.ok) throw new Error(`llama ${res.status}`);
  const body = (await res.json()) as { data?: LlamaPool[] };
  const pools = body.data ?? [];
  llamaPoolsCache = { pools, fetchedAt: now };
  return pools;
}

async function signalDefiListing(env: Env, chainId: number, asset: Address): Promise<boolean> {
  const disabled = env.LIQ_TIER3_DISABLE_DEFI_LISTING === 'true' || env.LIQ_TIER3_DISABLE_DEFI_LISTING === '1';
  if (disabled) return false;
  const chainName = LLAMA_CHAIN_NAMES[chainId];
  if (!chainName) return false;
  const minTvl = parsePosIntEnv(env.LIQ_TIER3_MIN_TVL_USD, 10_000_000);
  let pools: LlamaPool[];
  try {
    pools = await fetchLlamaPoolsCached();
  } catch (err) {
    console.log(`[keeper] tier3 ① DeFiLlama fetch failed: ${String(err).slice(0, 200)}`);
    return false;
  }
  const target = asset.toLowerCase();
  for (const p of pools) {
    if (!TIER3_BATTLETESTED_PROJECTS.has(p.project)) continue;
    if (p.chain !== chainName) continue;
    if ((p.tvlUsd ?? 0) < minTvl) continue;
    if (!p.underlyingTokens) continue;
    for (const t of p.underlyingTokens) {
      if (typeof t === 'string' && t.toLowerCase() === target) return true;
    }
  }
  return false;
}

// ─── Signals ②③ state — CoinGecko market cap + 24h volume ───────────

/** Chain id → CoinGecko `asset_platforms` id. Free public endpoint
 *  accepts the chain's slug as a path segment. Testnets / unmapped
 *  chains ⇒ signals ②③ both return false. */
const COINGECKO_PLATFORMS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  1101: 'polygon-zkevm',
  8453: 'base',
  42161: 'arbitrum-one',
};

interface CoinGeckoMarketEntry {
  marketCapUsd: number;
  totalVolume24hUsd: number;
  fetchedAt: number;
}

/** Per-(chain,asset) cache for CoinGecko reads — one HTTP call per
 *  asset per chain per `ADVISORY_TTL_MS`. With ~20-30 active collateral
 *  assets across all chains and CoinGecko's free public rate limit of
 *  ~10-50 calls/min, well within budget. */
const coinGeckoCache: Map<string, CoinGeckoMarketEntry | null> = new Map();

async function fetchCoinGeckoMarketCached(
  chainId: number,
  asset: Address,
): Promise<CoinGeckoMarketEntry | null> {
  const platform = COINGECKO_PLATFORMS[chainId];
  if (!platform) return null;
  const key = `${chainId}:${asset.toLowerCase()}`;
  const cached = coinGeckoCache.get(key);
  if (cached !== undefined && Date.now() - (cached?.fetchedAt ?? 0) < ADVISORY_TTL_MS) {
    return cached;
  }
  const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${asset.toLowerCase()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log(`[keeper] tier3 ②③ CoinGecko fetch failed: ${String(err).slice(0, 200)}`);
    coinGeckoCache.set(key, null);
    return null;
  }
  // 404 = the token isn't listed on CoinGecko for this chain — cache
  // the negative result so we don't retry every tick. 429 / 5xx = back
  // off (cache the null for the TTL too; a real fix is API key in env).
  if (!res.ok) {
    coinGeckoCache.set(key, null);
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    coinGeckoCache.set(key, null);
    return null;
  }
  const md = (body as { market_data?: { market_cap?: { usd?: number }; total_volume?: { usd?: number } } })
    ?.market_data;
  const mc = md?.market_cap?.usd;
  const v = md?.total_volume?.usd;
  if (typeof mc !== 'number' || typeof v !== 'number') {
    coinGeckoCache.set(key, null);
    return null;
  }
  const entry: CoinGeckoMarketEntry = {
    marketCapUsd: mc,
    totalVolume24hUsd: v,
    fetchedAt: Date.now(),
  };
  coinGeckoCache.set(key, entry);
  return entry;
}

async function battleTestedElsewhere(
  env: Env,
  chainId: number,
  asset: Address,
): Promise<boolean> {
  // Signal ① — DeFi-collateral listing + TVL (disable-able).
  const signal1 = await signalDefiListing(env, chainId, asset);
  // Signals ②③ — single CoinGecko fetch carries both readings.
  const cg = await fetchCoinGeckoMarketCached(chainId, asset);
  const minMcap = parsePosIntEnv(env.LIQ_TIER3_MIN_MCAP_USD, 1_000_000_000); // $1B default
  const minVol = parsePosIntEnv(env.LIQ_TIER3_MIN_VOL_USD, 50_000_000); // $50M default
  const signal2 = cg !== null && cg.marketCapUsd >= minMcap;
  const signal3 = cg !== null && cg.totalVolume24hUsd >= minVol;
  // 2-of-3 majority. With signal ① operator-disabled the ensemble
  // collapses to 2-of-2 (both CG signals required) — stricter, safe.
  const passCount = (signal1 ? 1 : 0) + (signal2 ? 1 : 0) + (signal3 ? 1 : 0);
  return passCount >= 2;
}

/** Apply the promote/demote state machine to one D1 row + return the
 *  on-chain `keeperTier` target (1..3) or `null` for "no change". */
function nextKeeperTier(
  prev: LiquidityConfidenceRow,
  aggTier: number,
  currentOnChainTier: number,
  nowSec: number,
  knobs: RelayKnobs,
): { target: number | null; row: LiquidityConfidenceRow } {
  // Demotion: aggregator can't confirm the current tier ⇒ drop now to
  // max(1, aggTier). (aggTier 0 ⇒ alarming, but `setKeeperTier` requires
  // 1..3; floor at 1 — the on-chain ceiling is still its own check.)
  if (aggTier < currentOnChainTier) {
    const target = Math.max(1, aggTier);
    return {
      target: target === currentOnChainTier ? null : target,
      row: {
        ...prev,
        agg_tier: aggTier,
        on_chain_tier: target,
        healthy_streak: 0,
        first_eligible_ts: null,
        last_check_ts: nowSec,
      },
    };
  }
  // Eligible-to-promote: aggregator confirms strictly above the current
  // tier (and below the ceiling cap MAX_TIER). Count consecutive ticks.
  if (aggTier > currentOnChainTier && currentOnChainTier < MAX_TIER) {
    const streak = prev.healthy_streak + 1;
    const firstEligible = prev.first_eligible_ts ?? nowSec;
    const windowOk = nowSec - firstEligible >= knobs.minWindowSec;
    if (streak >= knobs.minChecks && windowOk) {
      const target = currentOnChainTier + 1;
      return {
        target,
        row: {
          ...prev,
          agg_tier: aggTier,
          on_chain_tier: target,
          healthy_streak: 0,
          first_eligible_ts: null,
          last_check_ts: nowSec,
        },
      };
    }
    return {
      target: null,
      row: {
        ...prev,
        agg_tier: aggTier,
        on_chain_tier: currentOnChainTier,
        healthy_streak: streak,
        first_eligible_ts: firstEligible,
        last_check_ts: nowSec,
      },
    };
  }
  // Steady (aggTier == currentOnChainTier, or already at the cap) — no
  // change; reset the eligible-streak.
  return {
    target: null,
    row: {
      ...prev,
      agg_tier: aggTier,
      on_chain_tier: currentOnChainTier,
      healthy_streak: 0,
      first_eligible_ts: null,
      last_check_ts: nowSec,
    },
  };
}

async function runRelayForChain(
  env: Env,
  chain: ChainConfig,
  client: PublicClient,
): Promise<void> {
  const diamond = chain.diamond as Address;
  const cfg = await loadConfig(client, diamond, env);
  if (!cfg) return; // facet not cut / RPC error / degenerate config

  // The keeper EOA: used as the quote `taker` (read-only here) and the
  // `setKeeperTier` signer. Reads work even without the key (taker
  // falls back to the diamond); writes need `isKeeperEnabled`.
  const ctx = buildKeeperContext(env, chain, client);
  const canSubmit = isKeeperEnabled(env) && ctx !== null && cfg.knobs.submitGloballyEnabled;
  const taker = (ctx?.wallet.account?.address ?? diamond) as Address;

  const assets = await activeCollateralAssets(client, diamond);
  if (assets.length === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);
  let submits = 0;

  for (const asset of assets) {
    const key = asset.toLowerCase();
    let currentOnChainTier: number;
    try {
      currentOnChainTier = Number(
        (await client.readContract({
          address: diamond,
          abi: RELAY_ABI,
          functionName: 'getKeeperTier',
          args: [asset],
        })) as number | bigint,
      );
    } catch {
      continue;
    }
    if (currentOnChainTier < 1 || currentOnChainTier > MAX_TIER) currentOnChainTier = 1;

    let aggTier = await aggregatorConfirmedTier(
      env,
      client,
      chain,
      diamond,
      taker,
      asset,
      cfg.slippageBps,
      cfg.sizesPad,
    );
    if (aggTier === null) continue; // every quote failed — leave the counter alone
    // Cap the *aggregator-confirmed* tier at 2 unless the Tier-3
    // "battle-tested elsewhere" advisory passes.
    if (aggTier === MAX_TIER) {
      const battle = await battleTestedElsewhere(env, chain.id, asset);
      if (!battle) aggTier = 2;
    }

    const prevRow =
      (await getLiquidityConfidence(env.DB, chain.id, key)) ?? {
        chain_id: chain.id,
        asset: key,
        agg_tier: aggTier,
        on_chain_tier: currentOnChainTier,
        healthy_streak: 0,
        first_eligible_ts: null,
        last_check_ts: 0,
      };
    const { target, row } = nextKeeperTier(
      prevRow,
      aggTier,
      currentOnChainTier,
      nowSec,
      cfg.knobs,
    );
    // Always persist the updated counter (even when not submitting).
    await upsertLiquidityConfidence(env.DB, row);

    if (target === null) {
      console.log(
        `[keeper] liq-confidence chain=${chain.name} asset=${key} agg=${aggTier} onchain=${currentOnChainTier} streak=${row.healthy_streak} (no change)`,
      );
      continue;
    }
    if (!canSubmit) {
      console.log(
        `[keeper] liq-confidence chain=${chain.name} asset=${key} would set keeperTier ${currentOnChainTier}→${target} (skipped: submit disabled)`,
      );
      continue;
    }
    if (submits >= MAX_SUBMITS_PER_TICK) {
      console.log(`[keeper] liq-confidence chain=${chain.name} submit cap reached`);
      break;
    }
    try {
      const account = ctx!.wallet.account!;
      const hash = await ctx!.wallet.writeContract({
        address: diamond,
        abi: RELAY_ABI,
        functionName: 'setKeeperTier',
        args: [asset, target],
        account,
        chain: ctx!.wallet.chain,
      });
      submits += 1;
      console.log(
        `[keeper] liq-confidence chain=${chain.name} asset=${key} setKeeperTier ${currentOnChainTier}→${target} tx=${hash}`,
      );
    } catch (err) {
      console.error(
        `[keeper] liq-confidence chain=${chain.name} asset=${key} setKeeperTier failed: ${String(err).slice(0, 250)}`,
      );
    }
  }
}

export async function runLiquidityConfidence(env: Env): Promise<void> {
  for (const chain of getChainConfigs(env)) {
    try {
      const client = createPublicClient({ transport: http(chain.rpc) });
      await runRelayForChain(env, chain, client);
    } catch (err) {
      console.error(
        `[keeper] runLiquidityConfidence chain=${chain.name} failed: ${String(err).slice(0, 250)}`,
      );
    }
  }
}
