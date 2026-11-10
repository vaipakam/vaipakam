/**
 * RW-08, RW-09, RW-10 — the fee-discount tier as the protocol applies it,
 * why it is what it is, and the table of tiers it applies them from.
 *
 * The tier is never worked out here. The effective tier and its discount
 * are the protocol's own answer (`getEffectiveDiscount`): zero while the
 * wallet's fee-discount consent is off, already held down by the holding
 * rules, and already capped at the uniform ceiling on any discount. Beside
 * it, the protocol's own explanation (`explainTier`, #3459): on VPFI's home
 * network, the tier the counted VPFI alone would give, each holding rule's
 * figure and which rule, if any, holds the tier below it; away from the
 * home network, only the copy sent from there (the rules are worked out
 * there). The explanation answers whatever the consent, so with the consent
 * off it also says what would apply with it on. The rules' settings
 * (`getTwaConfig`) are read at the same block.
 *
 * The table is this network's own settings, read at one block: the four
 * VPFI thresholds, the discount each tier gives, and the two list fees.
 * Each fee with its discount is computed from those live figures, exactly
 * (no rounding), with the cap applied.
 */
import type { Abi, PublicClient } from 'viem';
import { ConfigFacetABI, VPFIDiscountAccumulatorFacetABI } from '@vaipakam/contracts/abis';
import { VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { answerOrNull } from '../reads/answer';
import { readVpfiHome } from './vpfiFacts';

type Hex = `0x${string}`;

const CONFIG = ConfigFacetABI as Abi;
const ACCUMULATOR = VPFIDiscountAccumulatorFacetABI as Abi;

/** The ceiling on any party's fee discount, in basis points (the
 *  protocol's uniform 50% cap). */
export const MAX_DISCOUNT_BPS = 5_000n;

/** Which holding rule keeps the tier below the tier the counted VPFI alone
 *  would give, in the protocol's own order (its `TierLimit`). */
export type TierLimit = 'none' | 'no-holding' | 'too-young' | 'average' | 'lookback-dip' | 'mirror';
const LIMITS: readonly TierLimit[] = ['none', 'no-holding', 'too-young', 'average', 'lookback-dip', 'mirror'];

/** The protocol's explanation of the wallet's tier (`explainTier`). On a
 *  network other than VPFI's home only `effective` and `heldBy` ('mirror')
 *  carry meaning. */
export interface TierExplanation {
  canonical: boolean;
  /** VPFI counted toward the tier now, and the tier it alone reaches. */
  counted: bigint;
  countedTier: number;
  /** When the current holding began (0: no current holding), and when its
   *  minimum holding period ends. */
  holdingSince: number;
  minHoldingEnds: number;
  /** The weighted average over the window, and its tier. */
  average: bigint;
  averageTier: number;
  /** The lowest tier over the look-back. */
  lookbackTier: number;
  /** The tier and capped discount that apply with the consent on. */
  effective: { tier: number; bps: bigint };
  /** The rule holding it down, or 'none'; null for a value this app does
   *  not know (then no rule is named). */
  heldBy: TierLimit | null;
}

/** The holding rules' settings on this network (`getTwaConfig`). */
export interface TierRules {
  minHoldingDays: number;
  windowDays: number;
  recentDays: number;
  recentWeight: number;
  lookbackCapDays: number;
}

/** The wallet's tier on this network, read at one block; null fields were
 *  not read. */
export interface TierCard {
  consent: boolean | null;
  home: boolean | null;
  /** The tier and discount the protocol applies to a fee now. */
  effective: { tier: number; bps: bigint } | null;
  explain: TierExplanation | null;
  rules: TierRules | null;
  blockNumber: bigint;
}

type RawExplanation = {
  canonical: boolean;
  countedBalance: bigint;
  balanceTier: number;
  stakeStartSec: number;
  minHoldingEndsSec: number;
  twa: bigint;
  rawTier: number;
  lookbackTier: number;
  effTier: number;
  effBps: number;
  heldBy: number;
};

export function explanationOf(r: RawExplanation): TierExplanation {
  return {
    canonical: r.canonical,
    counted: r.countedBalance,
    countedTier: Number(r.balanceTier),
    holdingSince: Number(r.stakeStartSec),
    minHoldingEnds: Number(r.minHoldingEndsSec),
    average: r.twa,
    averageTier: Number(r.rawTier),
    lookbackTier: Number(r.lookbackTier),
    effective: { tier: Number(r.effTier), bps: BigInt(r.effBps) },
    heldBy: LIMITS[Number(r.heldBy)] ?? null,
  };
}

export async function readTierCard(c: PublicClient, diamond: Hex, account: Hex): Promise<TierCard> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const [consent, home, eff, explain, rules] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getVPFIDiscountConsent', args: [account], ...at }) as Promise<boolean>),
    readVpfiHome(c, diamond, blockNumber),
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getEffectiveDiscount', args: [account], ...at }) as Promise<readonly [number, number]>),
    answerOrNull(c.readContract({ address: diamond, abi: ACCUMULATOR, functionName: 'explainTier', args: [account], ...at }) as Promise<RawExplanation>),
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getTwaConfig', ...at }) as Promise<{ minStakedDays: number; windowDays: number; recentDays: number; recentWeight: number; lookbackCapDays: number }>),
  ]);
  return {
    consent,
    home,
    effective: eff === null ? null : { tier: Number(eff[0]), bps: BigInt(eff[1]) },
    explain: explain === null ? null : explanationOf(explain),
    rules:
      rules === null
        ? null
        : {
            minHoldingDays: Number(rules.minStakedDays),
            windowDays: Number(rules.windowDays),
            recentDays: Number(rules.recentDays),
            recentWeight: Number(rules.recentWeight),
            lookbackCapDays: Number(rules.lookbackCapDays),
          },
    blockNumber,
  };
}

/** The rule holding a tier down, with the figures its sentence names. */
export type HeldBy =
  | { by: 'no-holding' }
  | { by: 'too-young'; since: number; ends: number }
  | { by: 'average'; averageTier: number }
  | { by: 'lookback-dip'; lookbackTier: number }
  | { by: 'unnamed' };

/** What the tier card says, in order of what decides it. */
export type TierState =
  | { kind: 'unread' }
  | { kind: 'consent-off'; would: { tier: number; bps: bigint } | null }
  | { kind: 'copy'; tier: number; bps: bigint }
  | { kind: 'held-down'; tier: number; bps: bigint; counted: number; held: HeldBy }
  | { kind: 'applies'; tier: number; bps: bigint; explained: boolean };

function heldBy(e: TierExplanation): HeldBy {
  switch (e.heldBy) {
    case 'no-holding':
      return { by: 'no-holding' };
    case 'too-young':
      return { by: 'too-young', since: e.holdingSince, ends: e.minHoldingEnds };
    case 'average':
      return { by: 'average', averageTier: e.averageTier };
    case 'lookback-dip':
      return { by: 'lookback-dip', lookbackTier: e.lookbackTier };
    default:
      return { by: 'unnamed' };
  }
}

export function tierState(card: Pick<TierCard, 'consent' | 'home' | 'effective' | 'explain'>): TierState {
  const e = card.explain;
  if (card.consent === false) return { kind: 'consent-off', would: e !== null && e.effective.tier > 0 ? e.effective : null };
  if (card.consent === null || card.home === null || card.effective === null) return { kind: 'unread' };
  const { tier, bps } = card.effective;
  if (!card.home) return { kind: 'copy', tier, bps };
  // The explanation is the protocol's own: it names a rule exactly when the
  // tier it resolves is below the counted VPFI's. It is only used when it
  // resolves the same tier the fee path applies.
  if (e === null || !e.canonical || e.effective.tier !== tier) return { kind: 'applies', tier, bps, explained: false };
  if (e.countedTier > tier) return { kind: 'held-down', tier, bps, counted: e.countedTier, held: heldBy(e) };
  return { kind: 'applies', tier, bps, explained: true };
}

/** This network's tier settings and list fees, read at one block. */
export interface TierTable {
  /** Tiers 1..4: each one's VPFI figure (token units; tiers 1 to 3 start AT
   *  it, tier 4 starts ABOVE it) and the discount it gives, in basis points
   *  before the cap. Kept as objects, not arrays of figures: React's
   *  development build serialises a prop's array of plain values to JSON,
   *  which a bigint breaks. */
  tiers: readonly { threshold: bigint; bps: bigint }[];
  /** The loan initiation fee, in basis points of the principal. */
  lifBps: bigint;
  /** The fee on interest a lender earns, in basis points of that interest. */
  yieldFeeBps: bigint;
  blockNumber: bigint;
}

export async function readTierTable(c: PublicClient, diamond: Hex): Promise<TierTable> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const read = <T>(functionName: string) => c.readContract({ address: diamond, abi: CONFIG, functionName, ...at }) as Promise<T>;
  const [t, b, fees] = await Promise.all([
    read<readonly [bigint, bigint, bigint, bigint]>('getVpfiTierThresholds'),
    read<readonly [bigint, bigint, bigint, bigint]>('getVpfiTierDiscountBps'),
    read<readonly [bigint, bigint]>('getFeesConfig'),
  ]);
  return { tiers: [0, 1, 2, 3].map((i) => ({ threshold: t[i]!, bps: b[i]! })), yieldFeeBps: fees[0], lifBps: fees[1], blockNumber };
}

/** The discount a tier's setting gives once the cap applies. */
export function cappedBps(bps: bigint): bigint {
  return bps > MAX_DISCOUNT_BPS ? MAX_DISCOUNT_BPS : bps;
}

/** A basis-point figure as an exact percent ("0.152"), with no rounding. */
export function percentOf(bpsTimes10k: bigint, scale = 10_000n): string {
  // bpsTimes10k / scale basis points = bpsTimes10k / (scale * 100) percent.
  const denom = scale * 100n;
  const whole = bpsTimes10k / denom;
  let rest = bpsTimes10k % denom;
  if (rest === 0n) return whole.toString();
  let digits = '';
  while (rest !== 0n && digits.length < 12) {
    rest *= 10n;
    digits += (rest / denom).toString();
    rest %= denom;
  }
  return `${whole}.${digits}`;
}

/** A list fee with a discount applied, as an exact percent. */
export function discountedFee(listBps: bigint, discountBps: bigint): string {
  return percentOf(listBps * (10_000n - cappedBps(discountBps)));
}

/** A discount in basis points as a percent. */
export function discountPercent(bps: bigint): string {
  return percentOf(bps, 1n);
}

/** One row of the table: the VPFI band, the discount and the two fees. */
export interface TierRow {
  tier: number;
  /** Lower bound; `fromAbove` when the band starts above it. */
  from: bigint;
  fromAbove: boolean;
  /** Upper bound, below which (or at which, `toIncluded`) the band ends;
   *  null for the top tier. */
  to: bigint | null;
  toIncluded: boolean;
  discount: string;
  capped: boolean;
  lif: string;
  yieldFee: string;
}

/** The table's rows, from tier 0 (no discount) to tier 4, with the
 *  protocol's own boundaries: tiers 1 to 3 start at their threshold, tier 4
 *  starts above its own, so tier 3 includes the tier-4 figure. */
export function tierRows(t: Pick<TierTable, 'tiers' | 'lifBps' | 'yieldFeeBps'>): TierRow[] {
  const [t1, t2, t3, t4] = t.tiers.map((x) => x.threshold) as [bigint, bigint, bigint, bigint];
  const bands: { from: bigint; fromAbove: boolean; to: bigint | null; toIncluded: boolean }[] = [
    { from: 0n, fromAbove: false, to: t1, toIncluded: false },
    { from: t1, fromAbove: false, to: t2, toIncluded: false },
    { from: t2, fromAbove: false, to: t3, toIncluded: false },
    { from: t3, fromAbove: false, to: t4, toIncluded: true },
    { from: t4, fromAbove: true, to: null, toIncluded: false },
  ];
  return bands.map((band, tier) => {
    const bps = tier === 0 ? 0n : t.tiers[tier - 1]!.bps;
    return {
      tier,
      ...band,
      discount: discountPercent(cappedBps(bps)),
      capped: bps > MAX_DISCOUNT_BPS,
      lif: discountedFee(t.lifBps, bps),
      yieldFee: discountedFee(t.yieldFeeBps, bps),
    };
  });
}
