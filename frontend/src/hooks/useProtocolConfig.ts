import { useCallback, useEffect, useState } from 'react';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 60_000;
const BASIS_POINTS = 10_000;

/**
 * Effective (override OR library default) value of every admin-tunable
 * protocol knob. Mirrors the tuple returned by
 * `ConfigFacet.getProtocolConfigBundle` — see
 * {@link contracts/src/facets/ConfigFacet.sol:259}.
 *
 * All BPS fields are integers where `10_000 == 100%`. `apr*Pct` /
 * `*FeePct` are pre-computed decimal fractions (0..1) for convenient
 * use in UI math (e.g. `amount * treasuryFeePct`).
 */
export interface ProtocolConfig {
  /** Treasury's cut of lender interest (default 1%). */
  treasuryFeeBps: number;
  treasuryFeePct: number;
  /** Fee deducted from ERC-20 principal at loan initiation (default 0.1%). */
  loanInitiationFeeBps: number;
  loanInitiationFeePct: number;
  /** Treasury cut on successful DEX liquidation (default 2%). */
  liquidationHandlingFeeBps: number;
  liquidationHandlingFeePct: number;
  /** Ceiling on 0x slippage before falling back to snapshot settlement (default 6%). */
  maxLiquidationSlippageBps: number;
  maxLiquidationSlippagePct: number;
  /** Cap on dynamic liquidator incentive (default 3%). */
  maxLiquidatorIncentiveBps: number;
  maxLiquidatorIncentivePct: number;
  /** LTV above which the loan drops to snapshot settlement (default 110%). */
  volatilityLtvThresholdBps: number;
  volatilityLtvThresholdPct: number;
  /** Safety buffer on NFT rental prepayment (default 5%). */
  rentalBufferBps: number;
  rentalBufferPct: number;
  /** Annualized staking reward on escrow-held VPFI (default 5%). */
  vpfiStakingAprBps: number;
  vpfiStakingAprPct: number;
  /** VPFI tier thresholds (token wei, 18-dec): T1 entry, T2 entry, T3 entry, T4 cutoff. */
  tierThresholds: [bigint, bigint, bigint, bigint];
  /** Per-tier discount BPS: index 0 = T1, index 3 = T4. */
  tierDiscountBps: [number, number, number, number];
  /** Per-tier discount as a decimal fraction, same index as {@link tierDiscountBps}. */
  tierDiscountPct: [number, number, number, number];
  fetchedAt: number;
}

interface CacheEntry {
  data: ProtocolConfig;
  at: number;
  key: string;
}

let cached: CacheEntry | null = null;

type BundleTuple = [
  bigint, // treasuryFeeBps
  bigint, // loanInitiationFeeBps
  bigint, // liquidationHandlingFeeBps
  bigint, // maxLiquidationSlippageBps
  bigint, // maxLiquidatorIncentiveBps
  bigint, // volatilityLtvThresholdBps
  bigint, // rentalBufferBps
  bigint, // vpfiStakingAprBps
  [bigint, bigint, bigint, bigint], // tierThresholds
  [bigint, bigint, bigint, bigint], // tierDiscountBps
];

function bpsToPct(bps: bigint | number): number {
  return Number(bps) / BASIS_POINTS;
}

/**
 * Read-only view of the protocol's admin-configurable parameter surface.
 * Resolves every knob to its **effective** value — when admin hasn't
 * overridden a field, the on-chain getter falls back to the library
 * default, so the UI never has to duplicate default values.
 *
 * Cached module-scope (keyed by chainId + diamond address) for
 * {@link STALE_MS} so every fee hint / tier row on a page shares one RPC
 * roundtrip.
 */
export function useProtocolConfig() {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}`;

  const [config, setConfig] = useState<ProtocolConfig | null>(() =>
    cached && cached.key === cacheKey ? cached.data : null,
  );
  const [loading, setLoading] = useState(!(cached && cached.key === cacheKey));
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setConfig(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'config',
      flow: 'useProtocolConfig',
      step: 'getProtocolConfigBundle',
    });
    try {
      const d = diamond as unknown as {
        getProtocolConfigBundle: () => Promise<BundleTuple>;
      };
      const tuple = await d.getProtocolConfigBundle();
      const [
        treasuryFeeBps,
        loanInitiationFeeBps,
        liquidationHandlingFeeBps,
        maxLiquidationSlippageBps,
        maxLiquidatorIncentiveBps,
        volatilityLtvThresholdBps,
        rentalBufferBps,
        vpfiStakingAprBps,
        tierThresholds,
        tierDiscountBps,
      ] = tuple;

      const next: ProtocolConfig = {
        treasuryFeeBps: Number(treasuryFeeBps),
        treasuryFeePct: bpsToPct(treasuryFeeBps),
        loanInitiationFeeBps: Number(loanInitiationFeeBps),
        loanInitiationFeePct: bpsToPct(loanInitiationFeeBps),
        liquidationHandlingFeeBps: Number(liquidationHandlingFeeBps),
        liquidationHandlingFeePct: bpsToPct(liquidationHandlingFeeBps),
        maxLiquidationSlippageBps: Number(maxLiquidationSlippageBps),
        maxLiquidationSlippagePct: bpsToPct(maxLiquidationSlippageBps),
        maxLiquidatorIncentiveBps: Number(maxLiquidatorIncentiveBps),
        maxLiquidatorIncentivePct: bpsToPct(maxLiquidatorIncentiveBps),
        volatilityLtvThresholdBps: Number(volatilityLtvThresholdBps),
        volatilityLtvThresholdPct: bpsToPct(volatilityLtvThresholdBps),
        rentalBufferBps: Number(rentalBufferBps),
        rentalBufferPct: bpsToPct(rentalBufferBps),
        vpfiStakingAprBps: Number(vpfiStakingAprBps),
        vpfiStakingAprPct: bpsToPct(vpfiStakingAprBps),
        tierThresholds: [
          tierThresholds[0],
          tierThresholds[1],
          tierThresholds[2],
          tierThresholds[3],
        ],
        tierDiscountBps: [
          Number(tierDiscountBps[0]),
          Number(tierDiscountBps[1]),
          Number(tierDiscountBps[2]),
          Number(tierDiscountBps[3]),
        ],
        tierDiscountPct: [
          bpsToPct(tierDiscountBps[0]),
          bpsToPct(tierDiscountBps[1]),
          bpsToPct(tierDiscountBps[2]),
          bpsToPct(tierDiscountBps[3]),
        ],
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now(), key: cacheKey };
      setConfig(next);
      step.success({
        note:
          `treasury=${next.treasuryFeeBps}bps, ` +
          `stakingApr=${next.vpfiStakingAprBps}bps, ` +
          `tiers=[${next.tierDiscountBps.join(',')}]`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  return { config, loading, error, reload };
}
