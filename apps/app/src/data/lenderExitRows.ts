/**
 * Row decisions for the lender's Layer-1 exit chooser
 * (LenderEarlyWithdrawalUXDesign, Layer 1), extracted as a PURE
 * function so the branching is testable without a DOM.
 *
 * Same shape as `computeHoldGate` in `saleListingHold.ts` and for the
 * same reason: the interesting part of this card is not its markup, it
 * is which sentence a lender is shown and in what precedence. That
 * deserves a test matrix, and app has no component-render harness.
 *
 * Two invariants live here rather than in the component, because they
 * are the ones that would silently mislead if they regressed:
 *
 *   1. The wait row is CADENCE-AWARE and tri-state. On a loan with a
 *      periodic schedule the lender is paid DURING the term; a single
 *      end-of-term sentence misstates when they get paid, which is the
 *      exact fact the row exists to convey. Unknown renders a checking
 *      line rather than defaulting to either shape.
 *   2. Whether a sale route is OPEN is the contract's answer, never
 *      this module's (#1841). Each sale row reads the route's refusals
 *      from `SaleExitVerdictFacet.saleExitVerdict` and states one of
 *      them (`statedRefusal`): the one the entry would revert with,
 *      unless the loan is past due, which the spec puts first. This module
 *      used to rebuild that answer from the page's own reads (status,
 *      maturity, the listing lock, the listing window, the collateral
 *      kind) and every rebuilt rule drifted from the entry it copied.
 *      What stays here is only what the contract does not know: the
 *      wait row, this app's own gates on its tools, and the wording.
 */
import { copy } from '../content/copy';
import { formatDateTime } from '../lib/format';
import type { SaleExitVerdict, SaleRefusal } from './saleExitVerdict';

/** Whether a standing lending offer matches this position.
 *
 *  A union, not `boolean | undefined`: `'checking'` (a read is in
 *  flight) and `'unknown'` (we deliberately have not read) are
 *  different promises to the reader. Collapsing them would render
 *  "checking…" forever in the case where nothing is being checked. */
export type InstantSellCandidates = 'checking' | 'some' | 'none' | 'unknown';
/* `'unknown'` is what the page passes in BOTH modes today, and the
 * reason differs by mode — which matters, because only one of the two
 * is a deliberate trade.
 *
 * In Basic the candidate list is genuinely not fetched: it is a full
 * active-offers page walk, and running it for every lender who merely
 * opens a position is a poor trade for a row that has a tool behind it.
 *
 * In Advanced the list IS fetched — `EarlyExitFlow` mounts, walks the
 * offers and derives the compatible set — and the chooser still says
 * `'unknown'`, so with zero matches the row stays jumpable while the
 * tool below already knows it is empty (Codex r12 P2). That is
 * information discarded rather than not gathered. It costs a wasted
 * scroll to a surface that explains itself, not a dead end — the
 * anchor exists and says `earlyExit.none` — which is why it is tracked
 * rather than patched: the honest fix shares the tool's derivation
 * instead of copying it, and a second copy of the facet's admission
 * rules is the exact defect class this card was built to remove.
 * Tracked in #1849. */

/** Whether the sale TOOLS themselves can render.
 *
 *  Both sale surfaces are held behind the fee-entitlement read: a
 *  Full-stamped position carries its fee mode to the buyer, and that
 *  disclosure is part of the sale set, so until the read settles the
 *  page renders a stand-in card in place of BOTH tools and their jump
 *  anchors go with it. A row that stayed available then rendered a
 *  jump button whose target did not exist, and `jump()`
 *  optional-chains a missing element — so the click did nothing, with
 *  nothing said (Codex r3 P2).
 *
 *  Availability follows the tools rather than the anchors being
 *  patched onto the stand-in card, because the honest statement is
 *  about the OPTION, not the scroll: while the disclosure is unread
 *  the sale cannot be started, and a lender is better told that than
 *  scrolled to a card that says the same thing in smaller type. */
export type SaleToolsState =
  | 'ready'
  | 'checking'
  /** A prerequisite read FAILED — deliberately not saying which.
   *
   *  This was two states (`failed-terms` / `failed-meta`) and became
   *  one, which is the opposite direction to every other fix on this
   *  card and needs its reason recorded. Naming the failed read
   *  misfired TWICE: r8 routed a token-metadata failure into the fee
   *  sentence, r9 fixed that by splitting, and r10 found a third
   *  prerequisite (`loanLive`) landing in the fee sentence again. The
   *  bug was never which name — it was that a NAME EXISTS to get
   *  wrong, and each new prerequisite is another chance to get it
   *  wrong silently.
   *
   *  Nothing is lost by dropping it. All three failures are transient
   *  read failures with ONE remedy, and the lender cannot act
   *  differently on any of them; the specific read is a diagnostic
   *  fact, and this is an awareness card, not a diagnostic. Attributing
   *  a cause bought precision the reader could not use, at the price of
   *  a misstatement they could be misled by. */
  | 'failed';

/** Whether the pending card below will offer a cancel, and if not, why.
 *
 *  Three-valued rather than a boolean (Codex r8 P2), because the two
 *  ways it can be absent want different sentences. A missing offer
 *  record means the listing was made elsewhere and this device cannot
 *  act on it — "cancel it where you listed it" is the right advice. An
 *  unverified holder means the card's isolated `ownerOf` read failed,
 *  which says nothing about where the listing was made and may resolve
 *  on the next attempt — telling that lender to go to another device
 *  would be a fabricated cause, and my own r7 fix introduced exactly
 *  that by folding the holder failure into the elsewhere wording. */
export type SaleCancelState = 'yes' | 'no-elsewhere' | 'no-unverified';

export type LenderExitJumpTarget = 'early-exit-card' | 'loan-sale-card';

export interface LenderExitRow {
  key: 'wait' | 'sell-now' | 'list';
  title: string;
  desc: string;
  cost?: string;
  /** A SECOND cost line, shown on the same terms as `cost`.
   *
   *  Separate from `cost` because it applies only to SOME positions
   *  (today: a Full-stamped fee entitlement) while the base cost
   *  sentence is identical for every one. Folding it in would mean two
   *  near-identical long strings per row in every locale, drifting
   *  apart on the next edit to either. */
  costExtra?: string;
  /** Structural facts true even when the row IS available. */
  note?: string;
  /** Keep `cost` visible even though `unavailable` is set.
   *
   *  The r2 rule — cost is noise on an option that cannot be taken —
   *  is right in general and WRONG for a live listing (Codex r5 P1). A
   *  listed position is not an option declined; it is a sale already in
   *  flight, which a buyer can complete at any moment. The held-balance
   *  transfer and the reward forfeiture are then PENDING CONSEQUENCES
   *  rather than hypothetical prices, and `LoanSalePendingCard` reports
   *  the settlement pull and funding status but neither loss — so
   *  hiding the line removes the only place they are stated. */
  costStillApplies?: boolean;
  /** Present ⇒ the row is not takeable and this says why. */
  unavailable?: string;
  /** Absent on the wait row — there is nothing to jump to. */
  target?: LenderExitJumpTarget;
}

export interface LenderExitInput {
  /** 0 = no periodic schedule; `undefined` = the read has not answered.
   *  Pair with `cadenceReadFailed` to tell a failure from a wait. */
  periodicInterestCadence: number | undefined;
  /** Whether the cadence read FAILED, as opposed to being in flight
   *  (Codex r7 P2). Both arrive as `undefined` cadence, and rendering
   *  the checking line for a persistent failure promises an answer
   *  that is not coming. */
  cadenceReadFailed: boolean;
  /** Whether the loan permits partial repayment. Affects the WAIT row's
   *  timing claim, not any sale row: `repayPartial` pays the lender
   *  that share of principal plus its accrued interest immediately,
   *  while the loan stays active — so "you claim at the end" is false
   *  for these loans even with no periodic schedule (Codex r4 P2). */
  allowsPartialRepay: boolean;
  /** Whether the LENDER side of this loan's fee entitlement is stamped
   *  Full.
   *
   *  `FeeEntitlement` is keyed by loanId, NOT by holder, and no sale
   *  path clears it — `repriceFeeEntitlementOnExtension` is the only
   *  writer and it fires on extension, not sale. So the stamp travels
   *  with the position: the buyer inherits the yield-fee bump for the
   *  remaining term without paying any `C*`, and the seller, who paid
   *  it in VPFI at origination, keeps only the part already settled
   *  (Codex r12 P2). */
  lenderFeeModeFull: boolean;
  /** The contract's verdict on both sale routes for the connected
   *  wallet (#1841). See `SaleExitVerdict`. */
  verdict: SaleExitVerdict;
  /** Has the verdict read stopped? A refetch in flight can change a
   *  known answer, so the readiness attribute waits for it. */
  verdictSettled: boolean;
  /** Whether the pending card below will actually render a cancel.
   *
   *  Wording only: when the verdict says a listing already stands, the
   *  row names the cancel as the way out, and must not name one this
   *  device cannot perform. It gates on `state.offerId &&
   *  state.isHolder` — two conditions, and the holder half fails
   *  independently (Codex r5 P2, r7 P2). */
  saleCancel: SaleCancelState;
  /** A listing may STILL BE STANDING, so its costs are pending
   *  consequences rather than hypothetical prices (Codex r20 P2).
   *
   *  Read from the listing card's own query rather than from the
   *  verdict, on purpose: this must fail OPEN — a previously confirmed
   *  listing does not stop being live because the next poll errored,
   *  and a buyer can still complete it — while the verdict fails
   *  CLOSED. One read cannot answer both. Costs only; no row's
   *  availability depends on it. */
  listingMayStand: boolean;
  /** This deployment does not publish the listing tool (an app setting,
   *  not a contract refusal). LISTING row only. */
  listingSupportedOnChain: boolean;
  /** Operator kill switch (`VITE_DISABLED_FLOWS`). Scoped to the
   *  LISTING row: `LoanSaleFlow` refuses and shows the incident
   *  banner, while the direct sale carries no kill switch at all — so
   *  gating both rows would invent a blocker on the instant exit
   *  (Codex r3 P2). */
  listingFlowDisabled: boolean;
  /** See `SaleToolsState` — applies to BOTH sale rows. */
  saleTools: SaleToolsState;
  /** Has the fee-entitlement read that gates both sale tools stopped?
   *  `saleTools` is derived from retained data and `isError`, both of
   *  which survive a background refetch, so a settled answer waits for
   *  it (Codex #1858 r11). */
  saleToolsSettled: boolean;
  instantSellCandidates: InstantSellCandidates;
}

/** The sentence for one refusal of one route.
 *
 *  Keyed on the custom error the ENTRY raises, which is what the verdict
 *  returns, so there is no second schema to keep in step with the
 *  contract. An error this build does not name still produces a refusal
 *  sentence carrying the error's name: the route is closed either way,
 *  and saying "open" because the words are missing would be the one
 *  wrong answer. */
function refusalText(
  r: SaleRefusal,
  route: 'direct' | 'listing',
  input: LenderExitInput,
  directOpen: boolean,
): string {
  const o = copy.lenderExit.options;
  const f = o.refusal;
  const base = (() => {
    switch (r.error) {
      case 'EnforcedPause':
        return f.paused;
      case 'SanctionedAddress':
        return f.screened;
      case 'LoanNotActive':
        return f.loanNotActive;
      case 'NotNFTOwner':
      case 'KeeperAccessRequired':
        return f.notHolder;
      case 'InvalidSaleOffer':
        return f.rental;
      case 'SaleOfferCollateralMustBeERC20':
        return o.listUnavailableNft;
      case 'SaleOfferAlreadyExists':
        // The cancel is the way out, so the sentence names it only when
        // this device can perform it.
        return route === 'listing'
          ? input.saleCancel === 'yes'
            ? o.listAlreadyListed
            : input.saleCancel === 'no-elsewhere'
              ? o.listAlreadyListedNoCancel
              : o.listAlreadyListedCancelUnverified
          : input.saleCancel === 'yes'
            ? o.sellNowAlreadyListed
            : input.saleCancel === 'no-elsewhere'
              ? o.sellNowAlreadyListedNoCancel
              : o.sellNowAlreadyListedCancelUnverified;
      case 'OffsetActiveOnLoan':
        return o.listUnavailableOffsetPending;
      case 'SaleLoanPastMaturity':
        return copy.lenderExit.pastDue;
      case 'SaleListingWindowInvalid':
        // "Selling into a standing offer still works" only when the
        // direct route is in fact open (Codex r22 P2): both rows read
        // the one verdict, so they cannot contradict each other.
        return directOpen ? o.listUnavailableTooClose : o.listUnavailableTooCloseOnly;
      case 'SaleRelistCooldownActive':
        return f.relistCooldown;
      case 'SalePositionNotConsolidatable':
        return f.heldVpfi;
      case 'OfferDurationExceedsCap':
        return f.durationCap(String(r.args[1] ?? ''));
      case 'AssetPaused':
        return f.assetPaused;
      case 'VaultUpgradeRequired':
        return f.vaultUpgrade;
      case 'SaleLegUnpriceable':
        return f.admissionUnpriceable;
      case 'SaleAdmissionCodeUnknown':
        return f.admissionUnknown;
      case 'SalePositionBelowSolvencyFloor':
      case 'SaleLtvAboveAdmissionCap':
      case 'SaleInheritsWeakerRiskTerms':
      case 'SaleInheritsWorseFeeTerms':
        return f.admissionBlocked;
      default:
        return f.unrecognised(r.error ?? f.unnamedError);
    }
  })();
  // The contract's own "earliest" — by time alone or by a step anyone may
  // take. It is a lower bound (a teardown may run later than it could),
  // which is what the sentence says; no time is invented when the
  // contract names none.
  return r.reopensAt === null
    ? base
    : `${base} ${f.reopensEarliest(formatDateTime(r.reopensAt))}`;
}

/** Which of a route's refusals the row states.
 *
 *  The contract decides THAT a route is closed (any refusal closes it)
 *  and lists every reason in the order the entry meets them. Which one
 *  the row SAYS is presentation, and the spec ranks one reason above the
 *  entry's order: once the loan has reached its due date, every exit
 *  says so rather than naming a narrower obstacle, because no new sale
 *  can be created past it whatever else clears (ProjectDetailsREADME,
 *  the lender-options paragraph). The entry meets an existing listing
 *  before maturity, so the first refusal alone would tell a past-due
 *  lender to cancel a listing that could not be replaced. Otherwise the
 *  first refusal — the one the entry would revert with. */
function statedRefusal(refusals: SaleRefusal[]): SaleRefusal {
  return refusals.find((r) => r.error === 'SaleLoanPastMaturity') ?? refusals[0];
}

/** The sentence for a verdict that has not produced refusals to read. */
function verdictPendingText(v: SaleExitVerdict): string | undefined {
  const f = copy.lenderExit.options.refusal;
  switch (v.kind) {
    case 'checking':
      return f.verdictChecking;
    case 'failed':
      return f.verdictFailed;
    case 'unserved':
      return f.verdictUnserved;
    default:
      return undefined;
  }
}

/** The tools' own state, shared by both sale rows. */
function toolsText(input: LenderExitInput): string | undefined {
  const o = copy.lenderExit.options;
  if (input.saleTools === 'ready') return undefined;
  return input.saleTools === 'failed' ? o.saleToolsFailed : o.saleToolsChecking;
}

export function buildLenderExitRows(input: LenderExitInput): LenderExitRow[] {
  const o = copy.lenderExit.options;

  // Cadence first: a periodic schedule already says the lender is paid
  // during the term, which subsumes the partial-repay case. Only a
  // NO-cadence loan needs the partial variant to avoid claiming that
  // nothing reaches the lender before maturity.
  const waitDesc =
    input.periodicInterestCadence === undefined
      ? input.cadenceReadFailed
        ? o.waitDescUnknown
        : o.waitDescChecking
      : input.periodicInterestCadence !== 0
        ? o.waitDescPeriodic
        : input.allowsPartialRepay
          ? o.waitDescAtClosePartial
          : o.waitDescAtClose;

  const v = input.verdict;
  const directOpen = v.kind === 'known' && v.direct.length === 0;

  // Precedence on each row: the contract's refusal (see `statedRefusal`),
  // then this app's own gates on its tools. The
  // contract's reason leads because it is about the position and holds
  // whatever this app does; the app's gates only say the tool here
  // cannot be used for it.
  const sellNowUnavailable =
    verdictPendingText(v) ??
    (v.kind === 'known' && v.direct.length > 0
      ? refusalText(statedRefusal(v.direct), 'direct', input, directOpen)
      : undefined) ??
    toolsText(input) ??
    (input.instantSellCandidates === 'checking'
      ? copy.lenderExit.checking
      : input.instantSellCandidates === 'none'
        ? o.sellNowNoOffers
        : // 'some' and 'unknown' both leave the row available: one
          // because we looked and found candidates, the other because
          // we have not looked and must not pretend to have. The
          // difference is visible in the tool, not here.
          undefined);

  const listUnavailable =
    verdictPendingText(v) ??
    (v.kind === 'known' && v.listing.length > 0
      ? refusalText(statedRefusal(v.listing), 'listing', input, directOpen)
      : undefined) ??
    (!input.listingSupportedOnChain
      ? o.listUnavailableNetwork
      : input.listingFlowDisabled
        ? o.listUnavailableFlowDisabled
        : undefined) ??
    toolsText(input);

  return [
    {
      key: 'wait',
      title: o.wait,
      desc: waitDesc,
      // The SAME `listingMayStand` input the two sale rows use for
      // `costStillApplies` (Codex r24 P2): the card must not say "a
      // buyer can still complete this" and "waiting costs nothing" about
      // one live listing on the same screen.
      //
      // Not marked `unavailable`: waiting is not refused, it is simply
      // no longer what inaction selects.
      cost: input.listingMayStand ? o.waitCostListed : o.waitCost,
    },
    {
      key: 'sell-now',
      title: o.sellNow,
      desc: o.sellNowDesc,
      cost: o.sellNowCost,
      costExtra: input.lenderFeeModeFull ? o.costFullTariff : undefined,
      // While a listing stands, the buyer completing it incurs these
      // same losses, and this row's cost line carries the disclosure.
      costStillApplies: input.listingMayStand,
      unavailable: sellNowUnavailable,
      target: 'early-exit-card',
    },
    {
      key: 'list',
      title: o.list,
      desc: o.listDesc,
      cost: o.listCost,
      costExtra: input.lenderFeeModeFull ? o.costFullTariff : undefined,
      note: o.listStructural,
      // A live listing is a sale in flight, not a declined option.
      costStillApplies: input.listingMayStand,
      unavailable: listUnavailable,
      target: 'loan-sale-card',
    },
  ];
}

/** Whether the Basic-mode "switch to Advanced" action should render.
 *
 *  The wait row has no tool behind it, so a lender whose sale rows are
 *  all unavailable has nothing to switch TO — offering the switch would
 *  promise tools that would not appear. */
export function hasJumpableRow(rows: LenderExitRow[]): boolean {
  return rows.some((r) => r.target !== undefined && r.unavailable === undefined);
}

/** Whether the chooser's answer about JUMPABILITY has settled yet.
 *
 *  Exposed for one reason: from outside the card, the absence of the
 *  "switch to Advanced" control is ambiguous. It is missing both while
 *  a prerequisite read is in flight AND when no row is genuinely
 *  jumpable, and those are the two cases a live review most needs to
 *  tell apart (#1855).
 *
 *  `'failed'` is reported distinctly rather than folded into `'ready'`:
 *  the rows have settled, so a reader is not left waiting, but a
 *  consumer asserting "the switch should be here" must not treat a
 *  failed prerequisite as a clean negative answer.
 *
 *  The cadence read is excluded: it changes the WAIT row's wording and
 *  nothing else, so waiting on it would block readiness on an answer
 *  that cannot move a jump.
 */
export type ChooserReadiness = 'ready' | 'pending' | 'failed';

export function chooserReadiness(input: LenderExitInput): ChooserReadiness {
  // A refetch in flight can change a known verdict, so nothing is
  // published as settled until the read has stopped.
  if (!input.verdictSettled) return 'pending';
  const v = input.verdict;
  if (v.kind === 'checking') return 'pending';
  if (v.kind === 'failed') return 'failed';
  // A deployment without the verdict, or a verdict that refuses both
  // routes, decides jumpability as no whatever the tools' reads say.
  if (v.kind === 'unserved') return 'ready';
  if (v.direct.length > 0 && v.listing.length > 0) return 'ready';
  if (!input.saleToolsSettled) return 'pending';
  if (input.saleTools === 'failed') return 'failed';
  if (input.saleTools === 'checking') return 'pending';
  if (input.instantSellCandidates === 'checking') return 'pending';
  return 'ready';
}
