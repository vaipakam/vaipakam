/**
 * #3538 — where an open loan stands on the way to settlement in kind.
 *
 * A terminal forced sale (a health-factor liquidation or a time-based
 * default) whose listed swap routes all fail no longer moves the loan into
 * the in-kind fallback at once: the failed sale is undone and recorded, and
 * only a failed sale made once an earlier failure is old enough opens the
 * fallback. `ForcedSalePreviewFacet.getFallbackGate` reports that record.
 * This module reads it and says what the loan page shows: nothing while no
 * failure is recorded, otherwise that a sale did not complete and when
 * settlement in kind can open. The time is the chain's own figure, never
 * worked out here.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { isFunctionDoesNotExistRevert } from '../contracts/preflights';

export interface FallbackGate {
  /** Failed sales in the current record (0 = none, or a stale record). */
  failedSales: bigint;
  /** The first failure of the current record (0 if none). */
  firstFailAt: bigint;
  /** The earliest time a failed sale opens the fallback; 0 when no failure
   *  is recorded. */
  fallbackOpensAt: bigint;
}

/**
 * Read the gate. Null on a Diamond that does not route `getFallbackGate`:
 * it predates the gate and has no record to show. Any other failure throws,
 * so the page can say nothing rather than claim no sale has failed.
 */
export async function readFallbackGate(
  client: PublicClient,
  diamond: `0x${string}`,
  loanId: bigint,
): Promise<FallbackGate | null> {
  try {
    const [failedSales, firstFailAt, fallbackOpensAt] = (await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getFallbackGate',
      args: [loanId],
    })) as readonly [bigint, bigint, bigint];
    return { failedSales, firstFailAt, fallbackOpensAt };
  } catch (e) {
    if (isFunctionDoesNotExistRevert(e)) return null;
    throw e;
  }
}

export type FallbackGateNotice =
  | { kind: 'none' }
  /** A sale failed; settlement in kind can open at `opensAt` (seconds). */
  | { kind: 'opensAt'; opensAt: number }
  /** A sale failed and the span has run: the next failed sale opens it. */
  | { kind: 'openNow' };

/** What the loan page says, judged against the chain's time. */
export function fallbackGateNotice(gate: FallbackGate | null, chainNow: bigint): FallbackGateNotice {
  if (!gate || gate.failedSales === 0n || gate.fallbackOpensAt === 0n) return { kind: 'none' };
  if (chainNow >= gate.fallbackOpensAt) return { kind: 'openNow' };
  return { kind: 'opensAt', opensAt: Number(gate.fallbackOpensAt) };
}
