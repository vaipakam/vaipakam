import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { repayVerdict } from '../../shared/eligibility/repay';
import { unknownVerdict } from '../../shared/eligibility/types';
import { isLiveStatus } from '../../shared/positions/model';
import type { LoanView, Role } from '../../shared/positions/loanView';
import type { TokenMetaMap } from '../../shared/reads/tokens';
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
 * left out for a reader who holds only the lender side.
 */
export function LoanActions({ loanId, view: v, role, own, chain, meta }: LoanActionsProps) {
  const copy = useCopy();
  const { text } = copy;
  const key = repayKey(loanId);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const nowMs = useNow();
  const live = isLiveStatus(v.loan.status);
  const inFlow = open === true || holdsFlow(entry.phase);
  if (!live && !inFlow) return null;

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

  return (
    <section className="home-section position-actions" aria-labelledby="position-actions">
      <h2 id="position-actions">{text('position.actionsTitle')}</h2>
      {inFlow ? (
        <RepayLoan loanId={loanId} chain={chain} own={own} meta={meta} onClose={() => setOpen(null)} />
      ) : lenderOnly ? null : verdict.state === 'open' ? (
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} data-testid="repay-open">
          {text('repay.action')}
        </button>
      ) : (
        <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-testid="repay-refusal" data-code={verdict.refusals[0]?.code}>
          {verdict.state === 'unknown' ? text('repay.unknown') : verdict.refusals[0]?.reason}
        </p>
      )}
      <p className="tier-b" data-testid="position-actions-later">
        {text('position.actionsMoreLater')}
      </p>
    </section>
  );
}
