import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { partialRepayVerdict } from '../../shared/eligibility/partialRepay';
import { repayVerdict } from '../../shared/eligibility/repay';
import { unknownVerdict } from '../../shared/eligibility/types';
import { isLiveStatus } from '../../shared/positions/model';
import type { LoanView, Role } from '../../shared/positions/loanView';
import type { TokenMetaMap } from '../../shared/reads/tokens';
import { PartialRepay, partialKey } from '../../shared/repay/PartialRepay';
import { RepayLoan, repayKey } from '../../shared/repay/RepayLoan';
import { holdsFlow, useStoredValue, useTxEntry } from '../../shared/tx/txStore';
import { useNow } from '../../shared/ui/useNow';

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
 * ended, is said once). The two flows never run at once.
 */

/** Refusals that close paying part but not repaying in full: the only ones
 *  the page states for it, since every other is already said above. */
const PARTIAL_ONLY = new Set(['PartialRepayNotAllowed', 'RefinanceRequestLive', 'OffsetLive']);
export function LoanActions({ loanId, view: v, role, own, chain, meta }: LoanActionsProps) {
  const copy = useCopy();
  const { text } = copy;
  const key = repayKey(loanId);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const pKey = partialKey(loanId);
  const pEntry = useTxEntry(pKey);
  const [pOpen, setPOpen] = useStoredValue<boolean>(`${pKey}:open`);
  const nowMs = useNow();
  const live = isLiveStatus(v.loan.status);
  const inRepay = open === true || holdsFlow(entry.phase);
  const inPartial = !inRepay && (pOpen === true || holdsFlow(pEntry.phase));
  if (!live && !inRepay && !inPartial) return null;

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
  const borrower = role?.borrower === true;
  const partialCode = partial.refusals[0]?.code;
  const partialNote =
    !borrower || partial.state === 'open' ? null : partial.state === 'unknown' ? (
      <p className="tier-a" data-testid="partial-refusal">
        {text('partial.unknown')}
      </p>
    ) : partialCode !== undefined && PARTIAL_ONLY.has(partialCode) ? (
      <p className="tier-b" data-testid="partial-refusal" data-code={partialCode}>
        {partial.refusals[0]?.reason}
      </p>
    ) : null;

  return (
    <section className="home-section position-actions" aria-labelledby="position-actions">
      <h2 id="position-actions">{text('position.actionsTitle')}</h2>
      {inRepay ? (
        <RepayLoan loanId={loanId} chain={chain} own={own} meta={meta} onClose={() => setOpen(null)} />
      ) : inPartial ? (
        <PartialRepay loanId={loanId} chain={chain} own={own} meta={meta} asset={l.principalAsset} principal={l.principal} onClose={() => setPOpen(null)} />
      ) : (
        <>
          {((!lenderOnly && verdict.state === 'open') || (borrower && partial.state === 'open')) && (
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
            </div>
          )}
          {!lenderOnly && verdict.state !== 'open' && (
            <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-testid="repay-refusal" data-code={verdict.refusals[0]?.code}>
              {verdict.state === 'unknown' ? text('repay.unknown') : verdict.refusals[0]?.reason}
            </p>
          )}
          {partialNote}
        </>
      )}
      <p className="tier-b" data-testid="position-actions-later">
        {text('position.actionsMoreLater')}
      </p>
    </section>
  );
}
