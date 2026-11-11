/**
 * LN-14 (#3586, contract side #3562) — the holding discount on the protocol's
 * share of a lender's interest, for one loan, as the protocol states it.
 *
 * Since #3562 that discount is the LOWER of two figures: the lender's discount
 * when they took the lender position (recorded by the protocol at that moment)
 * and their discount when the share is charged. The protocol's view
 * `lenderHoldDiscountView(loanId, lender)` returns both and the one that
 * applies now; nothing here works a tier out. The view covers the holding part
 * only: the share is discounted only while the wallet's fee-discount setting
 * is on, a Full fee tariff paid for the loan adds its own points within the
 * same ceiling, and the deployment's price configuration decides how the
 * discount is delivered. Those three are read at the same block and stated
 * beside it (LN-18).
 *
 * A Diamond that predates the view reverts `FunctionDoesNotExist`: that is
 * reported as 'absent' (not available on this deployment), never as a zero
 * discount. Any other failure is thrown, so the own rail tries its next source
 * and the page says the figure is unknown.
 */
import type { Abi, PublicClient } from 'viem';
import { FeeEntitlementFacetABI, VPFIDiscountAccumulatorFacetABI } from '@vaipakam/contracts/abis';
import { refusalFromError } from '../eligibility/refusal';
import { isContractAnswer } from '../reads/answer';
import { readFeeDiscountConsent, readDeliveryMode, type DeliveryMode } from '../consent/feeDiscount';

type Hex = `0x${string}`;

const ACCUMULATOR = VPFIDiscountAccumulatorFacetABI as Abi;
const ENTITLEMENT = FeeEntitlementFacetABI as Abi;

/** `LibVaipakam.FeeEntitlementMode.Full`. */
const MODE_FULL = 2;

/** The protocol's `LenderHoldView`, as numbers. Discounts are basis points of
 *  the protocol's share, already within the uniform ceiling. */
export interface LenderHoldView {
  /** The holder the entry was recorded for; the zero address when none was. */
  entryHolder: Hex;
  entryTier: number;
  entryBps: number;
  /** When the entry was recorded (unix seconds). */
  enteredAt: number;
  nowTier: number;
  nowBps: number;
  /** What applies to the holding part now: the lower of entry and now when
   *  the entry names the lender, else 0. */
  holdBps: number;
}

/** The view and what stands beside it, read at one block. Each side figure
 *  is null where it could not be read, and the page says so. */
export interface LenderDiscountRead {
  hold: LenderHoldView | 'absent';
  /** The wallet's fee-discount setting. */
  consent: boolean | null;
  /** How the discount is delivered on this deployment. */
  mode: DeliveryMode | null;
  /** Whether the lender side of this loan carries the Full fee tariff. */
  fullTariff: boolean | null;
}

export async function readLenderDiscount(c: PublicClient, diamond: Hex, loanId: bigint, lender: Hex): Promise<LenderDiscountRead> {
  const blockNumber = await c.getBlockNumber();
  const at = { blockNumber };
  const [hold, consent, mode, fullTariff] = await Promise.all([
    readHold(c, diamond, loanId, lender, blockNumber),
    readFeeDiscountConsent(c, diamond, lender, at).catch(() => null),
    readDeliveryMode(c, diamond, at).catch(() => null),
    readLenderFullTariff(c, diamond, loanId, blockNumber).catch(() => null),
  ]);
  return { hold, consent, mode, fullTariff };
}

async function readLenderFullTariff(c: PublicClient, diamond: Hex, loanId: bigint, blockNumber: bigint): Promise<boolean> {
  const e = (await c.readContract({ address: diamond, abi: ENTITLEMENT, functionName: 'getFeeEntitlement', args: [loanId], blockNumber })) as {
    lenderMode: number | bigint;
  };
  return Number(e.lenderMode) === MODE_FULL;
}

async function readHold(c: PublicClient, diamond: Hex, loanId: bigint, lender: Hex, blockNumber: bigint): Promise<LenderHoldView | 'absent'> {
  try {
    const v = (await c.readContract({
      address: diamond,
      abi: ACCUMULATOR,
      functionName: 'lenderHoldDiscountView',
      args: [loanId, lender],
      blockNumber,
    })) as Record<string, unknown>;
    return holdFrom(v);
  } catch (e) {
    if (isContractAnswer(e) && refusalFromError(e).code === 'FunctionDoesNotExist') return 'absent';
    throw e;
  }
}

/** The view's tuple as returned by viem (named fields), as numbers. */
export function holdFrom(v: Record<string, unknown>): LenderHoldView {
  const n = (x: unknown) => Number(x as number | bigint);
  return {
    entryHolder: v.entryHolder as Hex,
    entryTier: n(v.entryTier),
    entryBps: n(v.entryBps),
    enteredAt: n(v.enteredAt),
    nowTier: n(v.nowTier),
    nowBps: n(v.nowBps),
    holdBps: n(v.holdBps),
  };
}

/** What the page states about the holding discount on this loan:
 *  - 'unrecorded': the protocol recorded no entry for this lender (a loan
 *    opened before the record was kept), so no holding discount applies;
 *  - 'capped': the entry figure is below the discount now, so the entry
 *    figure applies and a holding raised since does not lift it;
 *  - 'follows': the discount now is at or below the entry figure, so the
 *    discount now applies and falls if the tier falls. */
export type HoldStanding =
  | { kind: 'unrecorded'; nowTier: number; nowBps: number }
  | { kind: 'capped' | 'follows'; bps: number; entryTier: number; entryBps: number; enteredAt: number; nowTier: number; nowBps: number };

export function holdStanding(v: LenderHoldView, lender: Hex): HoldStanding {
  if (v.entryHolder.toLowerCase() !== lender.toLowerCase()) return { kind: 'unrecorded', nowTier: v.nowTier, nowBps: v.nowBps };
  return {
    kind: v.entryBps < v.nowBps ? 'capped' : 'follows',
    bps: v.holdBps,
    entryTier: v.entryTier,
    entryBps: v.entryBps,
    enteredAt: v.enteredAt,
    nowTier: v.nowTier,
    nowBps: v.nowBps,
  };
}
