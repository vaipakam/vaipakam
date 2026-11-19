// apps/keeper/src/fallbackGate.ts
//
// #3538 — the keeper's ONE reading of a loan's fallback gate, shared by the
// two passes that send a terminal forced sale: the HF liquidator
// (`triggerLiquidation`) and the grace-default pass (`triggerDefault`).
//
// The contract rule (`LibFallbackGate`): a terminal forced sale whose listed
// routes all fail moves the loan into the in-kind fallback only when an
// earlier failed sale of the same loan is at least ten minutes old. Before
// that the sale is undone, the failure is recorded, and the call emits
// `ForcedSaleFallbackDeferred` while moving nothing. So a dead market now
// takes two failed sales ten minutes apart, and the keeper's part is:
//
//   1. A deferred ending is SENT while the loan's record holds fewer than
//      {@link DEFERRED_SENDS} failures: the first starts the ten minutes, the
//      second is the same sale tried again with a fresh quote, in case the
//      first failed on a quote rather than on the market.
//   2. Past that, a deferred ending is NOT sent: it would only pay gas to
//      record a failure the contract already holds. The loan waits for
//      `fallbackOpensAt`, and the line says when that is.
//   3. From `fallbackOpensAt`, the sale that fails opens the fallback. The
//      grace-default pass, which otherwise refuses an ending it can see
//      falling back, sends it then, but only when the gate is readable and
//      records an earlier failure, so the loan has had its market attempts
//      over time. A Diamond without the gate (a read that refuses) keeps the
//      old refusal: there one failed transaction falls back at once.
//
// A sale that WORKS is sent whatever the record says: the gate only ever
// holds back a sale known to fail.

import { type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { previewForcedSaleEnding } from '@vaipakam/lib/routeBuilder';
import { ForcedSalePreviewFacetABI } from '@vaipakam/contracts/abis';

const ABI = ForcedSalePreviewFacetABI as Abi;

/** Deferred (failing) sales the keeper sends for one loan's record: the one
 *  that starts the span and one retry with a fresh quote. */
export const DEFERRED_SENDS = 2;

/** `ForcedSalePreviewFacet.getFallbackGate`, as the keeper reads it. */
export interface FallbackGate {
  /** Failed sales in the loan's current record (0: none, or stale). */
  failedSales: number;
  /** When a failing sale may open the fallback, unix seconds (0: no record). */
  opensAt: number;
}

/** The loan's gate at `blockNumber`, or null when the Diamond does not
 *  answer it (it predates #3538) or the read fails. Null never permits a
 *  fallback send. */
export async function readFallbackGate(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<FallbackGate | null> {
  try {
    const [failed, , opensAt] = (await client.readContract({
      address: diamond,
      abi: ABI,
      functionName: 'getFallbackGate',
      args: [loanId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    })) as readonly [bigint, bigint, bigint];
    return { failedSales: Number(failed), opensAt: Number(opensAt) };
  } catch {
    return null;
  }
}

/** Null when a DEFERRED ending (every route failing, fallback not open) may
 *  be sent; otherwise why not. Pure. */
export function deferredSendRefusal(gate: FallbackGate | null): string | null {
  if (gate === null) return 'preview=deferred (the fallback gate did not read, so the record is unknown)';
  if (gate.failedSales < DEFERRED_SENDS) return null;
  return `preview=deferred (${gate.failedSales} failed sales recorded; the fallback opens at ${gate.opensAt}, when a failing sale is sent again)`;
}

/** Null when a FALLBACK ending may be sent: the gate reads and records an
 *  earlier failed sale, so the contract opened the fallback only after the
 *  span. Otherwise why not. Pure. */
export function fallbackSendRefusal(gate: FallbackGate | null): string | null {
  if (gate === null) return 'the Diamond reports no fallback gate, so a failing sale falls back at once';
  if (gate.failedSales === 0 || gate.opensAt === 0) return 'no earlier failed sale is recorded';
  return null;
}

/**
 * The HF liquidator's check before it sends `triggerLiquidation` (`data`):
 * null to send, or why not. Below {@link DEFERRED_SENDS} recorded failures
 * the call is sent unread (a deferred ending is still wanted). Past them the
 * call is previewed, and only an ending that would again be deferred is held
 * back; a working sale, a fallback (the span has passed) or an ending the
 * node cannot show is sent, as before #3538. An unreadable gate holds
 * nothing back.
 */
export async function liquidationDeferredRefusal(deps: {
  client: Pick<PublicClient, 'readContract' | 'simulateCalls'>;
  diamond: Address;
  account: Address;
  loanId: bigint;
  data: Hex;
}): Promise<string | null> {
  const gate = await readFallbackGate(deps.client, deps.diamond, deps.loanId);
  if (gate === null || gate.failedSales < DEFERRED_SENDS) return null;
  const detail = await previewForcedSaleEnding(deps);
  return detail.deferred ? deferredSendRefusal(gate) : null;
}
