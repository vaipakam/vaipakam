import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { AddCollateral, addCollateralKey } from '../../shared/collateral/AddCollateral';
import { TakeBack, takeBackKey } from '../../shared/collateral/TakeBack';
import { addCollateralVerdict } from '../../shared/eligibility/addCollateral';
import { partialRepayVerdict } from '../../shared/eligibility/partialRepay';
import { repayVerdict } from '../../shared/eligibility/repay';
import { takeBackVerdict } from '../../shared/eligibility/takeBack';
import { unknownVerdict } from '../../shared/eligibility/types';
import { isLiveStatus } from '../../shared/positions/model';
import type { LoanView, Role } from '../../shared/positions/loanView';
import type { TokenMetaMap } from '../../shared/reads/tokens';
import { PartialRepay, partialKey } from '../../shared/repay/PartialRepay';
import { RepayLoan, repayKey } from '../../shared/repay/RepayLoan';
import { holdsFlow, useStoredValue, useTxEntry } from '../../shared/tx/txStore';
import { useNow } from '../../shared/ui/useNow';
import { PAGES, currentAppHref } from '../../routes/pageMap';

/** The current app's page for this position: where a rental is closed until this app can (RB-RENT). */
const CURRENT_POSITION = PAGES.find((p) => p.path === '/positions/:id');

interface LoanActionsProps {
  loanId: bigint;
  view: LoanView;
  role: Role | null;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
}

/**
 * The loan page's actions (rulebook §4, RB-ELIG): each one is offered from
 * its eligibility rule, the same rule its review applies again before the
 * wallet opens. A closed action says why in the protocol's terms; one whose
 * inputs could not be read says that and is not offered. A repayment in
 * flight keeps its panel on screen, even once the loan it repaid has ended,
 * until the reader closes the finish card.
 *
 * Repaying in full is open to anyone but the lender (LN-21), so the row is
 * left out for a reader who holds only the lender side. Paying part
 * (LN-22) is the borrower position holder's alone, so it is offered to that
 * holder only; its closed reason is stated only where it differs from the
 * full repayment's (a reason both share, such as the grace period having
 * ended, is said once). Adding collateral (LN-31) is likewise the borrower
 * position holder's alone; its closed reason is stated only where it is its
 * own (the collateral token paused or unpriced). Taking back collateral
 * (LN-32) is the borrower position holder's alone too; its closed reason is
 * stated only where no action above already said it (the protocol pause,
 * nothing above the loan's limits, a refinance request or an unpriced token
 * not already named). The flows never run at once.
 */

/** Refusals that close paying part but not repaying in full: the only ones
 *  the page states for it, since every other is already said above. */
const PARTIAL_ONLY = new Set(['PartialRepayNotAllowed', 'RefinanceRequestLive', 'OffsetLive']);
/** Refusals of a top-up the page states: those no repayment shares. */
const ADD_ONLY = new Set(['AssetPaused', 'IlliquidAsset']);
/** Refusals of a withdrawal the page states, unless an action above already
 *  named the same hold. */
const TAKE_ONLY = new Set(['EnforcedPause', 'NothingToTakeBack', 'RefinanceRequestOpen', 'IlliquidAsset']);
export function LoanActions({ loanId, view: v, role, own, chain, meta }: LoanActionsProps) {
  const copy = useCopy();
  const { text } = copy;
  const key = repayKey(loanId);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const pKey = partialKey(loanId);
  const pEntry = useTxEntry(pKey);
  const [pOpen, setPOpen] = useStoredValue<boolean>(`${pKey}:open`);
  const aKey = addCollateralKey(loanId);
  const aEntry = useTxEntry(aKey);
  const [aOpen, setAOpen] = useStoredValue<boolean>(`${aKey}:open`);
  const tKey = takeBackKey(loanId);
  const tEntry = useTxEntry(tKey);
  const [tOpen, setTOpen] = useStoredValue<boolean>(`${tKey}:open`);
  const nowMs = useNow();
  const live = isLiveStatus(v.loan.status);
  const inRepay = open === true || holdsFlow(entry.phase);
  const inPartial = !inRepay && (pOpen === true || holdsFlow(pEntry.phase));
  const inAdd = !inRepay && !inPartial && (aOpen === true || holdsFlow(aEntry.phase));
  const inTake = !inRepay && !inPartial && !inAdd && (tOpen === true || holdsFlow(tEntry.phase));
  if (!live && !inRepay && !inPartial && !inAdd && !inTake) return null;

  const lenderOnly = role?.lender === true && role.borrower !== true;
  const l = v.loan;
  const verdict =
    v.chainNow === null
      ? unknownVerdict(text('repay.unread'))
      : repayVerdict(
          {
            status: l.status,
            assetType: l.assetType,
            recordedLender: l.lender,
            lenderHolder: v.holders.lender,
            graceEnd: v.deadlines?.graceEnd ?? null,
            chainNow: v.chainNow,
            borrowerLock: v.borrowerLock,
          },
          own.account,
          copy,
          nowMs,
        );
  const partial =
    v.chainNow === null
      ? unknownVerdict(text('partial.unread'))
      : partialRepayVerdict(
          {
            status: l.status,
            assetType: l.assetType,
            allowsPartialRepay: l.allowsPartialRepay,
            borrowerHolder: v.holders.borrower,
            graceEnd: v.deadlines?.graceEnd ?? null,
            chainNow: v.chainNow,
            borrowerLock: v.borrowerLock,
            refinanceLive: v.refinanceLive,
          },
          own.account,
          copy,
          nowMs,
        );
  const add = addCollateralVerdict(
    {
      status: l.status,
      assetType: l.assetType,
      borrowerHolder: v.holders.borrower,
      borrowerLock: v.borrowerLock,
      assetPaused: v.collateralPaused,
      collateralLiquid: v.collateralLiquidNow,
    },
    own.account,
    copy,
    nowMs,
  );
  const take = takeBackVerdict(
    {
      status: l.status,
      assetType: l.assetType,
      paused: v.paused,
      borrowerHolder: v.holders.borrower,
      borrowerLock: v.borrowerLock,
      refinanceLive: v.refinanceLive,
      collateralLiquid: v.collateralLiquidNow,
      maxWithdrawable: v.maxWithdrawable,
    },
    own.account,
    copy,
    nowMs,
  );
  const borrower = role?.borrower === true;
  const erc20 = l.assetType === 0;
  const addCode = add.refusals[0]?.code;
  const partialCode = partial.refusals[0]?.code;
  const takeCode = take.refusals[0]?.code;
  // A hold both actions share is said once, by the action above, in words
  // that name both, so the withdrawal's closed reason is never left unsaid.
  const unpricedBoth = takeCode === 'IlliquidAsset' && addCode === 'IlliquidAsset';
  const refinanceBoth = takeCode === 'RefinanceRequestOpen' && partialCode === 'RefinanceRequestLive';
  const takeSaidAbove = unpricedBoth || refinanceBoth;
  const addNote =
    !borrower || !erc20 || add.state === 'open' ? null : add.state === 'unknown' ? (
      <p className="tier-a" data-testid="add-collateral-refusal">
        {text('addColl.unknown')}
      </p>
    ) : addCode !== undefined && ADD_ONLY.has(addCode) ? (
      <p className="tier-b" data-testid="add-collateral-refusal" data-code={addCode}>
        {unpricedBoth ? text('addColl.illiquidBoth') : add.refusals[0]?.reason}
      </p>
    ) : null;
  const takeNote =
    !borrower || !erc20 || take.state === 'open' ? null : take.state === 'unknown' ? (
      <p className="tier-a" data-testid="take-back-refusal">
        {text('takeBack.unknown')}
      </p>
    ) : takeCode !== undefined && TAKE_ONLY.has(takeCode) && !takeSaidAbove ? (
      <p className="tier-b" data-testid="take-back-refusal" data-code={takeCode}>
        {take.refusals[0]?.reason}
      </p>
    ) : null;
  const partialNote =
    !borrower || partial.state === 'open' ? null : partial.state === 'unknown' ? (
      <p className="tier-a" data-testid="partial-refusal">
        {text('partial.unknown')}
      </p>
    ) : partialCode !== undefined && PARTIAL_ONLY.has(partialCode) ? (
      <p className="tier-b" data-testid="partial-refusal" data-code={partialCode}>
        {refinanceBoth ? text('partial.refinanceLiveBoth') : partial.refusals[0]?.reason}
      </p>
    ) : null;

  return (
    <section className="home-section position-actions" aria-labelledby="position-actions">
      <h2 id="position-actions">{text('position.actionsTitle')}</h2>
      {inRepay ? (
        <RepayLoan loanId={loanId} chain={chain} own={own} meta={meta} onClose={() => setOpen(null)} />
      ) : inPartial ? (
        <PartialRepay loanId={loanId} chain={chain} own={own} meta={meta} asset={l.principalAsset} principal={l.principal} onClose={() => setPOpen(null)} />
      ) : inAdd ? (
        <AddCollateral loanId={loanId} chain={chain} own={own} meta={meta} asset={l.collateralAsset} onClose={() => setAOpen(null)} />
      ) : inTake ? (
        <TakeBack loanId={loanId} chain={chain} own={own} meta={meta} asset={l.collateralAsset} onClose={() => setTOpen(null)} />
      ) : (
        <>
          {((!lenderOnly && verdict.state === 'open') || (borrower && partial.state === 'open') || (borrower && add.state === 'open') || (borrower && take.state === 'open')) && (
            <div className="position-action-row">
              {!lenderOnly && verdict.state === 'open' && (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} data-testid="repay-open">
                  {text('repay.action')}
                </button>
              )}
              {borrower && partial.state === 'open' && (
                <button type="button" className="btn" onClick={() => setPOpen(true)} data-testid="partial-open">
                  {text('partial.action')}
                </button>
              )}
              {borrower && add.state === 'open' && (
                <button type="button" className="btn" onClick={() => setAOpen(true)} data-testid="add-collateral-open">
                  {text('addColl.action')}
                </button>
              )}
              {borrower && take.state === 'open' && (
                <button type="button" className="btn" onClick={() => setTOpen(true)} data-testid="take-back-open">
                  {text('takeBack.action')}
                </button>
              )}
            </div>
          )}
          {!lenderOnly && verdict.state !== 'open' && (
            <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-testid="repay-refusal" data-code={verdict.refusals[0]?.code}>
              {verdict.state === 'unknown' ? text('repay.unknown') : verdict.refusals[0]?.reason}
              {verdict.state !== 'unknown' && verdict.refusals[0]?.code === 'RentalNotHere' && (
                <>
                  {' '}
                  <a href={CURRENT_POSITION ? (currentAppHref(CURRENT_POSITION, { id: loanId.toString() }) ?? undefined) : undefined} target="_blank" rel="noreferrer" data-testid="rental-close-elsewhere">
                    {text('vault.openCurrent')}
                  </a>
                </>
              )}
            </p>
          )}
          {partialNote}
          {addNote}
          {takeNote}
        </>
      )}
      <p className="tier-b" data-testid="position-actions-later">
        {text('position.actionsMoreLater')}
      </p>
    </section>
  );
}
