/**
 * RW-08, RW-09, RW-10 — the fee-discount tier as the protocol applies it,
 * and the table of tiers it applies them from.
 *
 * The tier is never worked out here. The effective tier and its discount
 * are the protocol's own answer (`getEffectiveDiscount`): zero while the
 * wallet's fee-discount consent is off, already held down by the holding
 * rules, and already capped at the uniform ceiling on any discount. On
 * VPFI's home network the tier the counted VPFI alone would give
 * (`getTrackedVPFIDiscountTier`) is read beside it, only to say when the
 * holding rules hold the effective tier below it. Away from the home
 * network the effective tier is the copy sent from there, and the counted
 * VPFI here sets nothing, so that comparison is not made.
 *
 * The table is this network's own settings, read at one block: the four
 * VPFI thresholds, the discount each tier gives, and the two list fees.
 * Each fee with its discount is computed from those live figures, exactly
 * (no rounding), with the cap applied.
 */
import type { Abi, PublicClient } from 'viem';
import { ConfigFacetABI } from '@vaipakam/contracts/abis';
import { VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { answerOrNull } from '../reads/answer';
import { readVpfiHome } from './vpfiFacts';

type Hex = `0x${string}`;

const CONFIG = ConfigFacetABI as Abi;

/** The ceiling on any party's fee discount, in basis points (the
 *  protocol's uniform 50% cap). */
export const MAX_DISCOUNT_BPS = 5_000n;

/** The wallet's tier on this network, read at one block; null fields were
 *  not read. */
export interface TierCard {
  consent: boolean | null;
  home: boolean | null;
  /** The tier and discount the protocol applies to a fee now. */
  effective: { tier: number; bps: bigint } | null;
  /** The tier the counted VPFI alone would give; read on the home network
   *  only (null elsewhere, or unread). */
  counted: number | null;
  blockNumber: bigint;
}

export async function readTierCard(c: PublicClient, diamond: Hex, account: Hex): Promise<TierCard> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const [consent, home, eff] = await Promise.all([
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getVPFIDiscountConsent', args: [account], ...at }) as Promise<boolean>),
    readVpfiHome(c, diamond, blockNumber),
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getEffectiveDiscount', args: [account], ...at }) as Promise<readonly [number, number]>),
  ]);
  const raw =
    home === true
      ? await answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getTrackedVPFIDiscountTier', args: [account], ...at }) as Promise<readonly [number, bigint, bigint]>)
      : null;
  return {
    consent,
    home,
    effective: eff === null ? null : { tier: Number(eff[0]), bps: BigInt(eff[1]) },
    counted: raw === null ? null : Number(raw[0]),
    blockNumber,
  };
}

/** What the tier card says, in order of what decides it. */
export type TierState =
  | { kind: 'unread' }
  | { kind: 'consent-off' }
  | { kind: 'copy'; tier: number; bps: bigint }
  | { kind: 'held-down'; tier: number; bps: bigint; counted: number }
  | { kind: 'applies'; tier: number; bps: bigint };

export function tierState(card: Pick<TierCard, 'consent' | 'home' | 'effective' | 'counted'>): TierState {
  if (card.consent === false) return { kind: 'consent-off' };
  if (card.consent === null || card.home === null || card.effective === null) return { kind: 'unread' };
  const { tier, bps } = card.effective;
  if (!card.home) return { kind: 'copy', tier, bps };
  if (card.counted !== null && card.counted > tier) return { kind: 'held-down', tier, bps, counted: card.counted };
  return { kind: 'applies', tier, bps };
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
