/**
 * Pure mapping from the on-chain switches to the automatic-matching posture
 * the refinance surfaces disclose (#2349 / #2355). Kept out of `protocol.ts`
 * so it can be unit-tested without a wagmi / React Query harness.
 *
 * Two independent governance switches decide whether a posted refinance
 * request can be filled by automation (a lender's direct accept needs
 * neither):
 *  - `autoRefinance` (`cfgAutoRefinanceEnabled`) gates EVERY automated
 *    route — the order matcher and a delegated keeper;
 *  - `partialFill` (the matcher master flag, `getMasterFlags()[2]`) gates
 *    the order matcher itself: `matchOffers` and `matchIntent` revert
 *    while it is off, whatever the refinance switch says.
 *
 * Every read state maps to a STATED posture — there is no "show nothing"
 * value (#2355 r5). Silence would read as "automation may fill this",
 * which the app can only claim once both switches are read and on.
 */
export type AutoRefinancePosture = 'on' | 'matcherOff' | 'off' | 'unknown';

export interface AutoMatchSwitches {
  autoRefinance: boolean;
  partialFill: boolean;
}

/**
 * `isError` must reflect the LATEST fetch. React Query keeps a stale `data`
 * across a failed refetch, so the error is checked first: a cached answer
 * is never presented as current after a failed re-read, because a switch
 * may have flipped during the outage (#2355 r4). No answer yet — still
 * loading, retrying, or no client to read with — is `unknown` too (r5).
 */
export function autoRefinancePostureFrom(read: {
  data: AutoMatchSwitches | undefined;
  isError: boolean;
}): AutoRefinancePosture {
  if (read.isError || read.data === undefined) return 'unknown';
  if (!read.data.autoRefinance) return 'off';
  if (!read.data.partialFill) return 'matcherOff';
  return 'on';
}
