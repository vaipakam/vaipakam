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
  /** Still inside the term or its grace period. The chain said so. */
  | 'not-yet'
  /** The L2 sequencer is down or inside its 1h recovery window.
   *  `triggerDefault` reverts `SequencerUnhealthy` before it routes
   *  anything, so nothing is offered — and see `decideForcedClose` for
   *  why this must be judged BEFORE liquidity. */
  | 'blocked-sequencer'
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
  /** ERC-20 loan or NFT rental. NFT rentals never take the swap path.
   *  `undefined` = unread. */
  assetType: 'erc20' | 'rental' | undefined;
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

  // BEFORE liquidity — see the doc comment above.
  if (input.sequencerHealthy === false) return 'blocked-sequencer';
  if (input.sequencerHealthy === undefined) return 'unknown';

  // The chain's answer, never a local recomputation.
  if (input.defaultable === undefined) return 'unknown';
  if (!input.defaultable) return 'not-yet';

  // A live swap-to-repay intent commit is deliberately NOT a blocker
  // here. `triggerDefault` opens by calling
  // `forceCancelIntentIfPastDefaultOrRevert`, which force-cancels the
  // commit and proceeds once the loan is past `endTime + grace` — and
  // we only reach this line when `defaultable` is true, which is that
  // same condition. Pre-grace commits keep their window, but a
  // pre-grace loan already returned `not-yet` above. The borrower's
  // pending intent being cancelled is a consequence worth DISCLOSING in
  // the copy; it is not a reason to withhold the action.

  // Which execution path the contract will take. NFT rentals never
  // swap, so they need no liquidity read at all.
  if (input.assetType === undefined) return 'unknown';
  if (input.assetType === 'rental') return 'ready-in-kind';

  if (input.collateralIlliquid === undefined) return 'unknown';
  if (input.collateralIlliquid) return 'ready-in-kind';

  // Liquid collateral: a genuine >110% LTV collapse also skips the
  // swap and hands over the collateral in kind.
  if (input.ltvCollapsed === undefined) return 'unknown';
  if (input.ltvCollapsed) return 'ready-in-kind';

  // Liquid, not collapsed → the contract demands a real try-list.
  return 'ready-needs-route';
}

/** Whether this readiness can be submitted from the app as-is.
 *
 *  Only `ready-in-kind` qualifies. `ready-needs-route` is genuinely
 *  eligible on-chain — a keeper can close it this second — but the app
 *  cannot build the `AdapterCall[]` the contract requires, so offering
 *  a submit button for it would be offering a revert. The card still
 *  SHOWS that state; it just does not pretend to act on it. */
export function canSubmitFromApp(readiness: ForcedCloseReadiness): boolean {
  return readiness === 'ready-in-kind';
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
