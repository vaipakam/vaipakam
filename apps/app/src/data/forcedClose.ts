/**
 * Lender-side forced close-out of a loan that ran past its grace period
 * — the decision half of `DefaultedFacet.triggerDefault`.
 *
 * The contract has always exposed this and the app never has, so a
 * lender whose borrower simply stopped paying had no way to close the
 * position from the product. That is what this module is for.
 *
 * It is pure and chain-free ON PURPOSE. Every fact it needs arrives as
 * an argument, so the ordering rules below can be tested without a
 * node — and the one rule that is genuinely easy to get wrong (the
 * sequencer, see below) is tested rather than reasoned about.
 *
 * ## Three things this module refuses to do
 *
 * **1. It never decides for itself whether the loan is past grace.**
 * `LibVaipakam.gracePeriod` walks `s.graceBuckets`, which is
 * governance-configurable storage; the 1h/1d/3d/1w/2w/30d ladder in the
 * code is only the fallback used when that array is EMPTY. A client
 * that reproduces the ladder is correct until the first deployment
 * configures buckets, and then it is silently wrong in whichever
 * direction the operator tuned. So `defaultable` comes from the chain's
 * own `isLoanDefaultable(loanId)` and is never derived here. Grace
 * seconds are still read separately, but only to DISPLAY a countdown —
 * never to gate the action.
 *
 * **2. It never promises what the lender will receive.** `triggerDefault`
 * has three possible outcomes and picks between them mid-transaction: an
 * internal-match auto-dispatch settles at oracle price, a successful DEX
 * swap ends `Liquidated`, and a failed swap routes to
 * `_fullCollateralTransferFallback` and ends `FallbackPending` — still
 * curable, paid out later at claim. Nothing observable before the
 * transaction distinguishes them, so no state here carries an amount.
 *
 * **3. It never implies the lender is the only one who can do this.**
 * `triggerDefault` is permissionless. A keeper, or any passer-by, may
 * fire first and collect the internal-match bonus. The lender is the
 * beneficiary, not the gatekeeper, and the copy has to say so — a card
 * promising an exclusive right would be describing a different
 * contract.
 *
 * ## One contract gate this module deliberately does not model
 *
 * Between `whenNotPaused` and the grace check, `triggerDefault` carries a
 * tiered KYC gate on the LENDER — `meetsKYCRequirement(loan.lender,
 * valueNumeraire)`, reverting `KYCRequired`. It is absent here on
 * purpose, not by oversight: the retail deploy leaves
 * `kycEnforcementEnabled` false, and while it is false
 * `ProfileFacet.meetsKYCRequirement` short-circuits to true, so the gate
 * cannot fire. Modelling it would mean issuing a read whose answer is
 * fixed, to describe a state no retail lender can reach.
 *
 * It is recorded rather than silently omitted because the ordering
 * comments below claim this resolver mirrors the contract's sequence,
 * and a reader checking that claim would otherwise find a gate missing
 * and not know whether it was deliberate. **On the industrial fork,
 * where KYC enforcement is enabled, this module is incomplete** — a
 * lender failing the tier would be told the position is ready and get a
 * revert. Anyone porting it there has to add that gate between the pause
 * check and the repayment window.
 *
 */

/** What the lender can do about this position right now.
 *
 *  Not a boolean and not `ready | blocked`. Each state below leads to a
 *  DIFFERENT sentence and a different affordance, and collapsing any
 *  two of them produces a card that is confidently wrong about the one
 *  thing it exists to say. */
export type ForcedCloseReadiness =
  /** Past grace, and this loan needs no DEX route to close. Submitting
   *  `triggerDefault(loanId, [])` is valid: the collateral moves in
   *  kind and the lender claims it afterwards. */
  | 'ready-in-kind'
  /** Past grace, but the collateral is liquid ERC-20 below the collapse
   *  threshold, so the contract REQUIRES a non-empty swap try-list.
   *
   *  This is not a softer version of `ready-in-kind` — an empty
   *  `adapterCalls` reverts `NoEnabledSwapRoute(loanId)` rather than
   *  falling back, deliberately, so that a permissionless caller cannot
   *  push an eligible loan into full-collateral disposition with zero
   *  DEX attempts (`LibSwap.swapWithFailover`, #1005 S9). A one-click
   *  button here would burn gas to reach a guaranteed revert. */
  | 'ready-needs-route'
  /** Past grace, liquid non-collapsed collateral — so the swap branch
   *  WOULD demand a try-list — but the protocol has an opposing
   *  position it can settle this one against instead.
   *
   *  `triggerDefault` attempts `attemptInternalMatchAutoDispatch`
   *  BEFORE it reaches the DEX branch and returns on success, so an
   *  empty `adapterCalls` never gets near `NoEnabledSwapRoute` here
   *  (round 31 P2). Treating this as `ready-needs-route` withheld a
   *  close-out the app can execute today. Kept as its own state rather
   *  than folded into `ready-in-kind` because what the lender receives
   *  differs — an internal match settles at oracle price in the LENT
   *  asset, not in collateral — and the copy has to say so. */
  | 'ready-internal-match'
  /** Past grace on an NFT RENTAL. Submittable, and deliberately not
   *  `ready-in-kind` (round 34 P2).
   *
   *  A rental default is a different transaction in what it recovers:
   *  `DefaultedFacet` clears the renter, leaves the lender's NFT where
   *  it already is, and records a claim for the PREPAID RENTAL asset
   *  after fees. Nothing moves out of a borrower's vault, and no
   *  collateral valuation decides the outcome — so the in-kind copy,
   *  which says exactly those two things, was wrong about both. */
  | 'ready-rental'
  /** Still inside the term or its grace period. The chain said so. */
  | 'not-yet'
  /** The L2 sequencer is down or inside its 1h recovery window.
   *  `triggerDefault` reverts `SequencerUnhealthy` before it routes
   *  anything, so nothing is offered — and see `decideForcedClose` for
   *  why this must be judged BEFORE liquidity. */
  | 'blocked-sequencer'
  /** Governance has paused the protocol. `triggerDefault` carries
   *  `whenNotPaused` as its FIRST modifier, so the call reverts before
   *  any of the routing below is reached — no read further down can
   *  make it submittable (round 28 P2). */
  | 'blocked-paused'
  /** Past grace, in-kind route, but the loan was opened without
   *  `riskAndTermsConsentFromBoth`.
   *
   *  The contract's ILLIQUID in-kind branch is guarded on that flag and
   *  falls through to `revert LiquidationFailed()` without it
   *  (`DefaultedFacet.sol` — `liquidity == Illiquid && consent`), so
   *  this position genuinely cannot be closed by anyone until the flag
   *  changes. Distinct from `ready-needs-route`, where the app is the
   *  limitation and a keeper could act; here nobody can (round 28 P2). */
  | 'blocked-no-consent'
  /** A read this decision depends on has not answered, or failed.
   *
   *  Distinct from `not-yet` because they are opposite errors: showing
   *  `not-yet` for an unread loan tells a lender their position is not
   *  yet closable when it may have been closable for weeks, and showing
   *  a ready state would offer a button whose transaction the chain may
   *  refuse. Unknown says neither. */
  | 'unknown'
  /** The loan is not Active — already repaid, defaulted, liquidated or
   *  sitting in fallback. There is nothing to force. The card does not
   *  render at all in this state. */
  | 'not-applicable';

export interface ForcedCloseInput {
  /** `LoanStatus.Active`. Affirmative only — an unread status is not
   *  an active one, so pass `false` while it is unknown and let the
   *  caller's own unknown-handling decide. */
  active: boolean;
  /** The chain's `DefaultedFacet.isLoanDefaultable(loanId)`.
   *
   *  `undefined` while in flight or after a failed read. NEVER compute
   *  this locally from `startTime + durationDays + grace` — see the
   *  module header. */
  defaultable: boolean | undefined;
  /** `OracleFacet.sequencerHealthy()`. `undefined` = unread. */
  sequencerHealthy: boolean | undefined;
  /** The Diamond's `paused()`. `undefined` = unread. */
  paused: boolean | undefined;
  /** ERC-20 loan or NFT rental. NFT rentals never take the swap path.
   *  `undefined` = unread. */
  assetType: 'erc20' | 'rental' | undefined;
  /** The COLLATERAL leg is an ERC-721/1155, on an ERC-20 loan.
   *
   *  A separate axis from `assetType`, which describes the PRINCIPAL
   *  leg — conflating them is what round 28 caught: an ERC-20 loan
   *  secured by an NFT is a supported shape, it is not a rental, and
   *  the liquidity read is an ERC-20 question that was simply never
   *  issued for it. The card then waited on an answer that could never
   *  arrive. NFT collateral has no oracle feed, so `_checkLiquidity`
   *  resolves it Illiquid and `triggerDefault` takes the same in-kind
   *  branch (its explicit ERC-721 / ERC-1155 vault-withdraw legs),
   *  consent gate included. `undefined` = the loan is unread. */
  collateralIsNft: boolean | undefined;
  /** `loan.riskAndTermsConsentFromBoth`, as stored at init.
   *
   *  Read on the in-kind ILLIQUID route only — the LTV-collapse route
   *  into the same branch is not consent-guarded, and rentals never
   *  enter it. `undefined` = unread. */
  consentFromBoth: boolean | undefined;
  /** `MetricsFacet.hasInternalMatchCandidate(loanId).found`.
   *
   *  The SAME view `attemptInternalMatchAutoDispatch` consults, which
   *  is why this is a read rather than a reimplementation: it already
   *  folds in the `internalMatchEnabled` config flag, the subject's
   *  status, and the matchable-collateral filter. Asking the contract's
   *  own question is the only way this stays correct when any of those
   *  move. `undefined` = unread. */
  internalMatchCandidate: boolean | undefined;
  /** Collateral is ILLIQUID per `OracleFacet.checkLiquidity`.
   *
   *  `checkLiquidityOnActiveNetwork` is what `triggerDefault` actually
   *  routes on; the two are documented as functionally identical and
   *  both delegate to `_checkLiquidity`, so reading either predicts the
   *  same branch. `undefined` = unread. */
  collateralIlliquid: boolean | undefined;
  /** `RiskFacet.calculateLTV(loanId) > cfgVolatilityLtvThresholdBps()`
   *  — the >110% value collapse that hands the lender the collateral
   *  in kind with no swap attempt.
   *
   *  Only meaningful for LIQUID collateral: `calculateLTV` reverts
   *  `IlliquidLoanNoRiskMath` on an illiquid loan, which is why the
   *  order below never reaches this field in that case. `undefined` =
   *  unread. */
  ltvCollapsed: boolean | undefined;
}

/**
 * Resolve what this lender can do, from facts only.
 *
 * ## The ordering rule that matters
 *
 * **Sequencer health is judged BEFORE liquidity, and that is load-bearing
 * rather than stylistic.** `OracleFacet._checkLiquidity` opens with
 * `if (!_sequencerHealthy()) return Illiquid;` — so while the sequencer
 * is down, EVERY asset reads illiquid. Judging liquidity first would
 * therefore route a perfectly liquid ERC-20 position to
 * `ready-in-kind` and offer a one-click close, which
 * `triggerDefault` refuses at its own `SequencerUnhealthy` check before
 * it ever looks at collateral. The lender pays gas to be told no, and
 * the card's explanation of what would have happened is wrong as well:
 * it would have described an in-kind transfer for a loan that is
 * destined for a swap once the sequencer recovers.
 *
 * That is the same defect shape as inferring grace locally — a
 * derived answer standing in for the chain's — and it is why both are
 * covered by tests rather than left to reading.
 */
export function decideForcedClose(input: ForcedCloseInput): ForcedCloseReadiness {
  // Nothing to force on a loan that already reached a terminal state.
  // Checked first because every question below is meaningless for one.
  if (!input.active) return 'not-applicable';

  // `whenNotPaused` is `triggerDefault`'s first modifier, so this sits
  // ahead of every other gate — mirroring the contract's own order
  // rather than picking one.
  if (input.paused === true) return 'blocked-paused';
  if (input.paused === undefined) return 'unknown';

  // THE REPAYMENT WINDOW COMES FIRST, and this order was inverted until
  // round 42 P2. `triggerDefault` rejects a pre-grace loan at line 249
  // with `NotDefaultedYet`, BEFORE it reaches the sequencer check at
  // line 260 — so a loan three days into a ninety-day term is refused
  // for being early, whatever the sequencer is doing. Asking the
  // sequencer first told that lender their close-out was merely paused
  // until the sequencer recovered, which reads as "this is available and
  // temporarily unavailable" about a position the borrower has most of
  // the term left to save.
  //
  // The earlier ordering was a deliberate choice too, and it was wrong
  // for a reason worth keeping: it was aimed at the heading claiming
  // "This loan is overdue" during an outage. That is a real problem and
  // it already has its own fix — `overdueEstablished` in the card admits
  // only states downstream of an affirmative `defaultable`. Solving it
  // twice, once by mis-ordering the resolver, bought nothing and cost
  // the truthful answer.
  //
  // The chain's answer, never a local recomputation.
  if (input.defaultable === undefined) return 'unknown';
  if (!input.defaultable) return 'not-yet';

  // BEFORE liquidity — see the doc comment above. Still ahead of every
  // collateral question, because `_checkLiquidity` reads Illiquid for
  // EVERY asset while the sequencer is down, so classifying collateral
  // during an outage misroutes a liquid position into the in-kind arm.
  if (input.sequencerHealthy === false) return 'blocked-sequencer';
  if (input.sequencerHealthy === undefined) return 'unknown';

  // A live swap-to-repay intent commit is deliberately NOT a blocker
  // here. `triggerDefault` opens by calling
  // `forceCancelIntentIfPastDefaultOrRevert`, which force-cancels the
  // commit and proceeds once the loan is past `endTime + grace` — and
  // we only reach this line when `defaultable` is true, which is that
  // same condition. Pre-grace commits keep their window, but a
  // pre-grace loan already returned `not-yet` above. The borrower's
  // pending intent being cancelled is a consequence worth DISCLOSING in
  // the copy; it is not a reason to withhold the action.

  // THE INTERNAL MATCH COMES FIRST, and this ordering is the contract's
  // rather than a preference (round 34 P2).
  //
  // `triggerDefault` calls `attemptInternalMatchAutoDispatch` at line
  // 287 and returns when it dispatches — BEFORE the liquidity read
  // (312), before the ERC-20 branch (319), and before the LTV-collapse
  // calculation (339). And `hasInternalMatchCandidate` does not exclude
  // a collapsed subject. So a collapsed-but-matchable loan settles as a
  // match, in the LENT asset, possibly partially — while the earlier
  // version of this function had already returned `ready-in-kind` and
  // promised the collateral would move as-is.
  //
  // I had this the wrong way round AND pinned it with a test that
  // asserted the wrong answer for an illiquid matchable loan. Both are
  // corrected; the case is now written as the ordering assertion it
  // should always have been.
  //
  // An unread or failed probe is UNKNOWN, exactly like every other
  // unread input here — and round 35 P2 is why that uniformity matters
  // rather than being tidiness.
  //
  // I first let an unresolved probe fall through to the classification
  // below, reasoning that it "keeps every route's own explanation
  // available and never offers a button on an unproven match". The
  // second half was false the moment the reorder above landed: with the
  // probe unresolved and the collateral illiquid or collapsed, the
  // fallthrough reached `ready-in-kind` — SUBMITTABLE, with copy
  // promising the borrower's collateral — while the contract may find a
  // candidate its own lookup can still see and settle in the lent
  // asset, possibly only partly. My test for the unread probe missed it
  // because its base case is liquid and non-collapsed, so it landed on
  // the one non-submittable arm.
  //
  // Going further than the minimal fix on purpose. Blocking only the
  // submittable routes would leave `ready-needs-route` and
  // `blocked-no-consent` reachable, and both make definite claims that
  // an existing candidate falsifies — that the collateral must be sold,
  // and that the close-out is refused for everyone. This module's own
  // rule is that an unread fact yields a state which asserts nothing;
  // a carve-out would be a second rule for one input.
  if (input.internalMatchCandidate === undefined) return 'unknown';
  if (input.internalMatchCandidate) return 'ready-internal-match';

  // Which execution path the contract will take. NFT rentals never
  // swap, so they need no liquidity read at all.
  if (input.assetType === undefined) return 'unknown';
  if (input.assetType === 'rental') return 'ready-rental';

  // NFT collateral on an ERC-20 loan: no feed, so no liquidity read is
  // issued for it and none is needed — the contract resolves it
  // Illiquid and takes the in-kind branch, consent gate and all.
  if (input.collateralIsNft === undefined) return 'unknown';
  if (input.collateralIsNft) return inKindIfConsented(input.consentFromBoth);

  if (input.collateralIlliquid === undefined) return 'unknown';
  if (input.collateralIlliquid) return inKindIfConsented(input.consentFromBoth);

  // Liquid collateral: a genuine >110% LTV collapse also skips the
  // swap and hands over the collateral in kind. Deliberately NOT
  // consent-gated — that arm of the contract's condition stands on the
  // collapse alone, and adding a gate the chain does not have would
  // withhold a close-out that would in fact succeed.
  if (input.ltvCollapsed === undefined) return 'unknown';
  if (input.ltvCollapsed) return 'ready-in-kind';

  return 'ready-needs-route';
}

/**
 * What a close-out lands on if the internal-match candidate is gone by
 * the time the transaction mines.
 *
 * WHY THIS EXISTS (review round 39 P2). `ready-internal-match` is
 * returned BEFORE this module looks at the asset type, the collateral
 * shape or an LTV collapse — correctly, because the contract dispatches
 * a match before reaching any of them. But that means one state hides
 * four different fallbacks, and the card's race sentence promised the
 * one that happens to be commonest: that losing the race merely costs a
 * network fee. It does not. If the collateral is an NFT, is illiquid
 * with consent recorded, or sits past the LTV-collapse threshold, the
 * contract falls through to the in-kind branch and the close-out
 * SUCCEEDS — handing over the borrower's collateral instead of the
 * asset the lender expected to be repaid in. Telling a lender the only
 * downside is a fee, when the transaction can complete and deliver a
 * materially different asset, is exactly the kind of confident-but-wrong
 * claim this card exists to avoid.
 *
 * WHY IT IS DERIVED RATHER THAN RE-STATED. The fallback is, by
 * definition, what this same resolver decides when there is no
 * candidate — so it asks that question instead of re-encoding the
 * contract's ordering a second time. A hand-written copy of the
 * ordering would be correct today and would drift the first time the
 * contract's branch order changes, which is the failure mode the
 * ordering comment above spent three review rounds on.
 *
 * Returns `ready-internal-match` only if the caller passes an input
 * that still resolves to it, which cannot happen through this function.
 */
export function forcedCloseWithoutMatch(
  input: ForcedCloseInput,
): ForcedCloseReadiness {
  return decideForcedClose({ ...input, internalMatchCandidate: false });
}

/** The illiquid in-kind branch, which the contract gates on consent. */
function inKindIfConsented(
  consentFromBoth: boolean | undefined,
): ForcedCloseReadiness {
  if (consentFromBoth === undefined) return 'unknown';
  return consentFromBoth ? 'ready-in-kind' : 'blocked-no-consent';
}

/** Whether this readiness can be submitted from the app as-is.
 *
 *  `ready-in-kind` and `ready-internal-match`. The second is NOT an
 *  in-kind close — the protocol settles against an opposing position
 *  and pays in the lent asset — but it shares the property that
 *  matters here: `triggerDefault(loanId, [])` succeeds, because the
 *  match is dispatched before the swap branch is ever reached.
 *  `ready-needs-route` is genuinely
 *  eligible on-chain — a keeper can close it this second — but the app
 *  cannot build the `AdapterCall[]` the contract requires, so offering
 *  a submit button for it would be offering a revert. The card still
 *  SHOWS that state; it just does not pretend to act on it. */
export function canSubmitFromApp(readiness: ForcedCloseReadiness): boolean {
  return (
    readiness === 'ready-in-kind' ||
    readiness === 'ready-internal-match' ||
    readiness === 'ready-rental'
  );
}

/** Whether the card should render at all.
 *
 *  Everything except `not-applicable`, INCLUDING `unknown` and
 *  `not-yet`. A lender looking at an overdue position needs to see that
 *  this route exists and what it is waiting on; hiding the card until
 *  it happens to be actionable is how the feature stayed invisible in
 *  the first place. */
export function shouldRenderForcedClose(readiness: ForcedCloseReadiness): boolean {
  return readiness !== 'not-applicable';
}
