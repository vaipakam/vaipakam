/**
 * Which Diamond writes stay available to a wallet that has not accepted
 * the in-force Terms (#1961, review round 2 P1).
 *
 * WHY THIS EXISTS RATHER THAN MORE ROUTE EXEMPTIONS. Round 1 established
 * that the exit must never be gated, and I implemented that by exempting
 * whole routes. Round 2 found the hole in it: `/vpfi` also carries
 * `depositVPFIToVault*` and `setVPFIDiscountConsent`, and
 * `/positions/:loanId` carries `RefinanceFlow`, whose `createOffer`
 * originates a replacement loan. Exempting a route exempts every action
 * on it, so a wallet that had refused the Terms could take on new
 * exposure by navigating straight there.
 *
 * The fix is not a finer route list. A route is a place; the thing that
 * needs permitting is an ACTION, and the app makes 37 distinct Diamond
 * writes through one function. Classifying the writes is a closed,
 * enumerable problem with a single chokepoint; classifying every control
 * on every route is neither, and would have to be redone each time a
 * page gained a card.
 *
 * So the route exemption stays as an AFFORDANCE — a held user can still
 * reach the page that lets them repay — and this list is the
 * ENFORCEMENT. The two answer different questions and both are needed:
 * without the route exemption a held user cannot reach the repay button;
 * without this list, reaching the page hands them everything else on it.
 */
import { decodeFunctionData, toFunctionSelector, type AbiFunction } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/**
 * Writes that must work whatever the Terms say.
 *
 * The test is not "is this harmless" but "does refusing it trap the
 * user, or their money". Everything here either reduces the user's
 * exposure, returns their own assets, or is the way out of the gate
 * itself. Anything that opens a NEW position, or changes terms in a way
 * that only matters if you keep trading, is absent on purpose.
 */
export const EXIT_WRITES: ReadonlySet<string> = new Set([
  // The gate's own escape hatch. Omitting this would make the gate
  // unpassable, which is the one bug that cannot be worked around.
  'acceptTerms',
  // Repayment.
  'repayLoan',
  'repayPartial',
  'precloseDirect',
  // The ATOMIC handoffs (review round 11 P1). Both end the caller's own
  // position in one transaction against a commitment somebody else has
  // already made: `sellLoanViaBuyOffer` pays a lender out into a
  // standing buy offer, `transferObligationViaOffer` moves a borrower's
  // obligation to a replacement who has already offered to take it.
  //
  // I had these in the REFUSED list, and wrote a test asserting it —
  // the classification error and its own guard, shipped together. The
  // line that actually matters is not "does this touch an offer" but
  // "does the caller end up with more or less". These leave the caller
  // with nothing, which is what an exit is. Refusing them told a lender
  // who declined new Terms that their only instant exit was closed,
  // while the slow route through a listing stayed open — protecting
  // nobody and costing them the spread.
  //
  // The listing routes are deliberately NOT here: `createLoanSaleOffer`
  // and `offsetWithNewOffer` publish a standing commitment of the
  // caller's own, which is new business even though it is aimed at an
  // exit. Direct and atomic is the line.
  'sellLoanViaBuyOffer',
  'transferObligationViaOffer',
  // Claims — the user's own settled funds.
  'claimAsBorrower',
  'claimAsLender',
  'claimInteractionRewards',
  'withdrawVPFIFromVault',
  // Batched claims. Permitted only when every inner call is itself an
  // exit — see `isExitWrite`.
  'multicall',
  // Withdrawing an offer reduces exposure; refusing it would pin a user
  // to a standing commitment they are no longer allowed to manage.
  'cancelOffer',
  'cancelSignedOffer',
  'teardownStaleSaleListing',
  // Topping up collateral is defensive, not new business. Refusing it
  // while a position drifts toward liquidation would use a paperwork
  // rule to cost somebody their collateral — the sharpest version of
  // the trap this whole list exists to avoid.
  'addCollateral',
  // Withdrawing a THIRD PARTY's authority over your positions (review
  // round 4 P1). A user who declines new Terms and cannot revoke a
  // keeper is left with somebody else still able to act for them, and
  // no way to stop it — the gate would be protecting the delegate
  // rather than the user. `revokeKeeper` is unconditional; the two
  // below are permitted only in their DISABLING direction, handled in
  // `isExitWrite`, so grants and enables stay gated.
  'revokeKeeper',
  'setKeeperAccess',
  'setLoanKeeperEnabled',
  // Withdrawing the fee-deduction authority, and the cache clear it
  // needs (review round 7 P1). `setVPFIDiscountConsent` authorises
  // AUTOMATIC deductions of vaulted VPFI for fees; the contract treats
  // disabling it as security-motivated. Refusing the revocation would
  // leave open positions consuming the user's funds under a permission
  // they are no longer allowed to withdraw — the keeper case again,
  // with the user's own balance in place of a delegate.
  //
  // `pokeMyTier` is on the list because the revocation is incomplete
  // without it: it clears the mirror caches the flag leaves behind. An
  // exit that only half-completes is not an exit.
  'setVPFIDiscountConsent',
  'pokeMyTier',
]);

/**
 * Writes permitted only when their argument turns something OFF.
 *
 * The boolean's position differs per function, so it is named rather
 * than assumed: `setKeeperAccess(bool enabled)` carries it first,
 * `setLoanKeeperEnabled(uint256 loanId, address keeper, bool enabled)`
 * third. Guessing an index here would either gate a revocation or
 * permit a grant, and the second is the one that matters.
 */
const DISABLE_ONLY: Readonly<Record<string, number>> = {
  setKeeperAccess: 0,
  setLoanKeeperEnabled: 2,
  setVPFIDiscountConsent: 0,
};

/** Selectors of the exit writes, for inspecting batched calls. */
const EXIT_SELECTORS: ReadonlySet<string> = new Set(
  (DIAMOND_ABI_VIEM as readonly unknown[])
    .filter(
      (item): item is AbiFunction =>
        typeof item === 'object' &&
        item !== null &&
        (item as AbiFunction).type === 'function' &&
        EXIT_WRITES.has((item as AbiFunction).name) &&
        // `multicall` is the wrapper, never an inner call.
        (item as AbiFunction).name !== 'multicall',
    )
    .map((item) => toFunctionSelector(item)),
);

/** A batched call as `MulticallFacet` takes it. */
interface BatchedCall {
  callData?: `0x${string}`;
}

/**
 * True when this write may proceed without accepted Terms.
 *
 * `multicall` is the only shape needing its arguments: it is on the list
 * because batched CLAIMS go through it, and permitting the wrapper
 * unconditionally would permit anything anyone chose to batch. Every
 * inner call must be an exit in its own right, and a batch that cannot
 * be read is refused rather than assumed harmless.
 */
export function isExitWrite(functionName: string, args: readonly unknown[]): boolean {
  if (!EXIT_WRITES.has(functionName)) return false;

  // Disable-only writes: permitted when switching OFF, gated when
  // switching on. A missing or non-boolean argument is refused rather
  // than assumed to be the harmless direction.
  const flagAt = DISABLE_ONLY[functionName];
  if (flagAt !== undefined) return args[flagAt] === false;

  if (functionName !== 'multicall') return true;

  const calls = args[0];
  if (!Array.isArray(calls) || calls.length === 0) return false;
  return calls.every((call) => {
    const data = (call as BatchedCall)?.callData;
    if (typeof data !== 'string' || data.length < 10) return false;
    if (!EXIT_SELECTORS.has(data.slice(0, 10).toLowerCase())) return false;
    // Review round 7 P2: a selector is not an argument. A disable-only
    // write batched with `enabled: true` carries an ALLOWLISTED
    // selector while doing the opposite of the thing that earned it a
    // place on the list, and `MulticallFacet` delegatecalls it either
    // way. So the inner call is decoded and its flag read, exactly as a
    // direct submission's would be.
    try {
      const inner = decodeFunctionData({ abi: DIAMOND_ABI_VIEM, data });
      return isExitWrite(inner.functionName, (inner.args ?? []) as readonly unknown[]);
    } catch {
      // Undecodable is not harmless — refuse it.
      return false;
    }
  });
}
