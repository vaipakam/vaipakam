/**
 * #642 — pure helpers for the keeper's in-tick partial-liquidation re-size /
 * cap-clamp retry loop. Kept side-effect-free (no RPC, no env) so the sizing
 * math is unit-testable in isolation (pairs with #222).
 *
 * Context: `RiskFacet.triggerPartialLiquidation(loanId, fractionBps, calls)`
 * reverts when the requested slice is mis-sized:
 *   - `PartialOverLiquidates`   — the slice would push HF past the on-chain
 *     over-liquidation ceiling. A SMALLER slice can still restore HF, so the
 *     keeper reduces the fraction, re-quotes, and retries in-tick.
 *   - `InvalidPartialFraction`  — the slice exceeds the governance close-factor
 *     cap (`maxPartialLiquidationCloseFactorBps`). The keeper reads the live cap
 *     and CLAMPS to it rather than escalating straight to full.
 */

/** Basis-point denominator (100% == 10_000 BPS). */
export const BPS = 10_000n;

/**
 * Smallest slice worth attempting. Below this a partial barely moves HF and just
 * burns gas/quotes, so the keeper stops re-sizing and lets the loan escalate to
 * full (or recompute next tick). 5% of the loan.
 */
export const MIN_PARTIAL_FRACTION_BPS = 500n;

/**
 * Reduce an over-sized partial fraction for the next retry. A `PartialOverLiquidates`
 * revert means the on-chain ceiling is tighter than the keeper's estimate; shrink
 * by 25% each attempt so a bounded handful of retries converges under it without
 * collapsing to a dust slice. Never returns below 1 BPS for a positive input.
 */
export function reducePartialFractionBps(currentBps: bigint): bigint {
  if (currentBps <= 0n) return 0n;
  const reduced = (currentBps * 3n) / 4n;
  return reduced > 0n ? reduced : 1n;
}

/**
 * Clamp a requested fraction to the on-chain close-factor cap. Returns the
 * smaller of the two; if the cap is already ≥ the request, the request is
 * returned unchanged (the cap isn't the binding constraint).
 */
export function clampPartialFractionBps(currentBps: bigint, capBps: bigint): bigint {
  return currentBps > capBps ? capBps : currentBps;
}

/**
 * Collateral sell-amount for a given fraction of the loan's collateral — the
 * `sellAmount` the keeper re-quotes the swap route for when it changes the slice.
 */
export function sellAmountForFractionBps(
  collateralAmount: bigint,
  fractionBps: bigint,
): bigint {
  return (collateralAmount * fractionBps) / BPS;
}

/**
 * Normalize a close-factor cap read off-chain into a usable BPS value. A `0`
 * sentinel (or anything out of the 1..10_000 range / a failed read) means "no
 * cap" → full 10_000.
 */
export function normalizeCloseFactorCapBps(raw: bigint): bigint {
  return raw > 0n && raw <= BPS ? raw : BPS;
}

/**
 * The size at which a partial stops being partial. The sizer treats a computed
 * fraction at or above it as "use full liquidation", and the re-size search
 * never grows a slice to it: past it the partial is mostly closing the loan,
 * and the full liquidation closes cleanly and refunds the borrower's surplus.
 */
export const MAX_PARTIAL_FRACTION_BPS = 7_500n;

/** What the partial-liquidation attempt ended in. */
export type PartialAttemptOutcome<Q> =
  | { kind: 'submitted'; hash: `0x${string}`; fractionBps: bigint; attempt: number; quotes: Q }
  /** No partial size can pass the on-chain guards for this loan now: go on to
   *  split/full. */
  | { kind: 'escalate' }
  /** Leave the loan for the next tick, which recomputes from fresh state. */
  | { kind: 'skip' };

export interface PartialAttemptDeps<Q> {
  /** Send `triggerPartialLiquidation` at this size; throws the revert. */
  submit(fractionBps: bigint, quotes: Q): Promise<`0x${string}`>;
  /** A fresh route for a new size, or null when no route answers. */
  reQuote(fractionBps: bigint): Promise<Q | null>;
  /** The live close-factor cap, normalized ({@link normalizeCloseFactorCapBps}). */
  readCloseFactorCapBps(): Promise<bigint>;
  /** True for an error that must end the whole run (the send deadline), which
   *  is rethrown rather than classified. */
  isFatal(err: unknown): boolean;
  log(line: string): void;
}

/**
 * #395 / #642 / #2733 — submit a partial liquidation, and when the on-chain
 * sizing guards refuse the slice, SEARCH for one they accept before giving up.
 *
 * A partial must land the loan's health factor in a band: at least 1.0
 * (`PartialMustRestoreHF` / `PartialMustImproveHF` below it) and at most the
 * governance ceiling (`PartialOverLiquidates` above it), within the close-factor
 * cap (`InvalidPartialFraction`). Each refusal says which side of the band the
 * slice fell, so the search keeps a bracket — the largest size known too small
 * and the smallest known too big — and sends only sizes strictly inside it:
 *
 *   · too big, nothing known too small → shrink 25%;
 *   · too small, nothing known too big → grow by a third;
 *   · both sides known                 → the midpoint;
 *   · over the cap                     → clamp to the cap, which also becomes
 *     the upper limit for any growth.
 *
 * It escalates to split/full only when the bracket closes with no whole bps
 * size left in it, or the next size would leave `[MIN_PARTIAL_FRACTION_BPS,
 * MAX_PARTIAL_FRACTION_BPS)` (or pass the cap): then no partial can pass and a
 * full liquidation is the lender's way out. A refusal that says a partial is
 * the wrong tool (`InternalMatchOnlyBand`, `PartialLeavesDust`,
 * `PartialFullyClosedUseFull`, `PartialAfterMaturity`) escalates at once. Any
 * other refusal (a route failure, unknown) and a re-quote that finds no route
 * skip the loan to the next tick.
 *
 * There is no attempt count. The old bound (three submissions) could compute a
 * smaller size and escalate without sending it: 7,400 → 5,550 → 4,162 refused
 * under a 4,000 ceiling, and 3,121 was never tried (#2733) — a full liquidation
 * of a borrower a partial would have restored. And a size that overshot the
 * band from above, or a first estimate below it, was skipped and recomputed
 * identically next tick, so such a loan was never liquidated at all. The search
 * ends because every size it sends lies strictly inside an integer interval that
 * every refusal narrows.
 */
export async function runPartialAttempts<Q extends { calls: readonly unknown[] }>(
  initialFractionBps: bigint,
  initialQuotes: Q | null,
  deps: PartialAttemptDeps<Q>,
): Promise<PartialAttemptOutcome<Q>> {
  let fractionBps = initialFractionBps;
  let quotes = initialQuotes;
  /** Largest size refused as too small to restore HF. */
  let tooSmall: bigint | null = null;
  /** Smallest size refused as too big (over the ceiling or the cap). */
  let tooBig: bigint | null = null;
  /** Sizes must stay below this: the partial band's end, or the live cap + 1. */
  let limit = MAX_PARTIAL_FRACTION_BPS;

  /** The next size strictly inside the bracket, or null when none is left. */
  const nextSize = (): bigint | null => {
    let next: bigint;
    if (tooSmall !== null && tooBig !== null) next = (tooSmall + tooBig) / 2n;
    else if (tooBig !== null) next = reducePartialFractionBps(tooBig);
    else next = tooSmall! + (tooSmall! + 2n) / 3n; // grow by a third, at least 1 bps
    if (next < MIN_PARTIAL_FRACTION_BPS || next >= limit) return null;
    if (tooSmall !== null && next <= tooSmall) return null;
    if (tooBig !== null && next >= tooBig) return null;
    return next;
  };
  const bracket = () => `too small ${tooSmall ?? '-'}bps, too big ${tooBig ?? '-'}bps, limit ${limit}bps`;

  for (let attempt = 0; ; attempt++) {
    if (!quotes || quotes.calls.length === 0) return { kind: 'skip' };
    try {
      const hash = await deps.submit(fractionBps, quotes);
      return { kind: 'submitted', hash, fractionBps, attempt, quotes };
    } catch (err) {
      if (deps.isFatal(err)) throw err;
      const msg = String(err);

      if (
        msg.includes('InternalMatchOnlyBand') ||
        msg.includes('PartialLeavesDust') ||
        msg.includes('PartialFullyClosedUseFull') ||
        msg.includes('PartialAfterMaturity')
      ) {
        deps.log(`partial-reverted-escalation (${msg.slice(0, 140)}) — falling back to split/full liquidation`);
        return { kind: 'escalate' };
      }

      let refusal: string;
      let next: bigint | null;
      if (msg.includes('InvalidPartialFraction')) {
        const capBps = await deps.readCloseFactorCapBps();
        refusal = `over the close-factor cap ${capBps}bps`;
        // The cap bounds every later size. A clamp that does not lower this
        // one means the cap is not what refused it: nothing to clamp to.
        if (capBps + 1n < limit) limit = capBps + 1n;
        tooBig = tooBig === null || fractionBps < tooBig ? fractionBps : tooBig;
        const clamped = clampPartialFractionBps(fractionBps, capBps);
        next = clamped < fractionBps && (tooSmall === null || clamped > tooSmall) && clamped >= MIN_PARTIAL_FRACTION_BPS
          ? clamped
          : null;
      } else if (msg.includes('PartialOverLiquidates')) {
        refusal = 'over the health-factor ceiling';
        tooBig = tooBig === null || fractionBps < tooBig ? fractionBps : tooBig;
        next = nextSize();
      } else if (msg.includes('PartialMustRestoreHF') || msg.includes('PartialMustImproveHF')) {
        refusal = 'too small to restore HF';
        tooSmall = tooSmall === null || fractionBps > tooSmall ? fractionBps : tooSmall;
        next = nextSize();
      } else {
        deps.log(`partial-reverted-resize (${msg.slice(0, 140)}) — skipping; recompute slice next tick`);
        return { kind: 'skip' };
      }

      if (next === null) {
        deps.log(
          `partial refused at ${fractionBps}bps (${refusal}) and no partial size is left to try (${bracket()}) — escalating to split/full`,
        );
        return { kind: 'escalate' };
      }
      deps.log(`partial refused at ${fractionBps}bps (${refusal}) — retrying at ${next}bps (${bracket()})`);
      fractionBps = next;
      quotes = await deps.reQuote(fractionBps);
    }
  }
}
