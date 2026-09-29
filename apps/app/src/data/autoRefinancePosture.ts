/**
 * Pure mapping from the on-chain reads to the automatic-matching posture
 * the refinance surfaces disclose (#2349 / #2355). Kept out of `protocol.ts`
 * so it can be unit-tested without a wagmi / React Query harness.
 *
 * What the banner may claim is exactly what these reads establish, and no
 * more (#2355 r6):
 *  - `paused` (`AdminFacet.paused()`, manual or an active auto-pause
 *    window) — every refinance completion is `whenNotPaused`, so while it
 *    is set neither a lender nor the matcher can complete the request;
 *  - `autoRefinance` (`cfgAutoRefinanceEnabled`) and `partialFill` (the
 *    matcher master flag, `getMasterFlags()[2]`) — the order matcher can
 *    fill a refinance request only while BOTH are on (`matchOffers` /
 *    `matchIntent` revert while `partialFill` is off; admission refuses
 *    tagged pairs while `autoRefinance` is off).
 * The banner never promises that a lender's direct accept will SUCCEED —
 * other things (a per-asset pause, an overdue period, a short allowance)
 * can stop it, and none of them is read here. It says only that these
 * switches do not stop it. Keepers are not mentioned: the keeper route
 * (`refinanceLoan`) needs an already-accepted offer, so it cannot fill a
 * live request.
 *
 * Every read state maps to a STATED posture — there is no "show nothing"
 * value (#2355 r5).
 */
export type AutoRefinancePosture = 'on' | 'off' | 'paused' | 'unknown';

export interface AutoMatchSwitches {
  paused: boolean;
  autoRefinance: boolean;
  partialFill: boolean;
}

/**
 * One rule: a posture is stated as KNOWN only while the latest read
 * attempt succeeded. React Query keeps a stale `data` both across a failed
 * refetch (`isError`, #2355 r4) and across a refetch it has PAUSED because
 * the browser is offline (`isPaused` — the default `networkMode`, where
 * `isError` stays false, r7). Either way no current read exists and a
 * switch may have flipped meanwhile, so the cached answer is not presented
 * as current. No answer yet — still loading, retrying, or no client to read
 * with — is `unknown` too (r5). A pause outranks the matcher switches:
 * while paused nothing completes.
 */
export function autoRefinancePostureFrom(read: {
  data: AutoMatchSwitches | undefined;
  isError: boolean;
  isPaused: boolean;
}): AutoRefinancePosture {
  if (read.isError || read.isPaused || read.data === undefined) return 'unknown';
  if (read.data.paused) return 'paused';
  if (!read.data.autoRefinance || !read.data.partialFill) return 'off';
  return 'on';
}
