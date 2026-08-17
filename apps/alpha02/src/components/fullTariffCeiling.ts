/**
 * The acceptance-side ceiling decision, extracted so BOTH branches can be
 * asserted (#1704 follow-up).
 *
 * It lived inline in `FullTariffOptIn`. The fork arm exercises only one half:
 * arm 2a of `24-full-tariff.spec.ts` asserts the downgrade box is UNTICKED
 * before testing the block — deliberately, so the block cannot pass vacuously
 * — which means the ticked branch is never driven anywhere.
 *
 * That untested branch is exactly the behaviour #1700 got WRONG and corrected
 * in review round 3: blocking an acceptance the user had explicitly authorized
 * to proceed, contradicting the promise its own checkbox makes. A correction
 * with no test is what regresses quietly, and this one would regress straight
 * back into the original bug — hence a tier that can assert both directions.
 */

/** Has the live quote passed the ceiling the acceptor authorized?
 *
 *  Gated on Full being OTHERWISE available (#1700 r1): a cached successful
 *  quote can outlive a liquidity verdict turning illiquid or the kill switch
 *  going off, and the ceiling notice must not mask a real blocker by promising
 *  that raising the ceiling would let the user continue. */
export function isCeilingOvertaken(args: {
  full: boolean;
  featureEnabled: boolean;
  fullBlocked: boolean;
  quoted: bigint | undefined;
  ceiling: bigint | undefined;
}): boolean {
  return (
    args.full &&
    args.featureEnabled &&
    !args.fullBlocked &&
    args.quoted !== undefined &&
    args.ceiling !== undefined &&
    args.ceiling > 0n &&
    args.quoted > args.ceiling
  );
}

/** Should an overtaken ceiling HOLD signing?
 *
 *  Only when the acceptor did NOT permit a downgrade (#1700 r3). With it
 *  permitted, `resolveAndCharge` opens the loan without Full instead of
 *  reverting, and `downgradeHelpAllow` promises precisely that — so refusing
 *  would break a promise the user relied on and reject an acceptance the
 *  contract completes happily. The NOTICE still fires either way; only the
 *  block is conditional. */
export function shouldBlockOnCeiling(args: {
  ceilingOvertaken: boolean;
  allowDowngrade: boolean;
}): boolean {
  return args.ceilingOvertaken && !args.allowDowngrade;
}
