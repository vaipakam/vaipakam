import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { LoanClaim, useLoanClaimHeld } from '../../shared/claims/LoanClaim';
import { sideShown, type ClaimSide } from '../../shared/claims/loanClaim';
import { useCopy } from '../../shared/copy/useCopy';
import { claimVerdict } from '../../shared/eligibility/claim';
import type { LoanView } from '../../shared/positions/loanView';
import type { TokenMetaMap } from '../../shared/reads/tokens';
import { useNow } from '../../shared/ui/useNow';
import type { FrozenState } from '../../shared/sanctions/posture';

interface LoanClaimsProps {
  loanId: bigint;
  view: LoanView;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  /** The reader's standing with the sanctions screen (RB-FROZEN). */
  frozen?: FrozenState;
}

/**
 * The loan page's payouts (LN-48, LN-49; RB-CLAIM): once a loan has ended,
 * the holder of each position collects what the protocol recorded for that
 * side, through the same claim flow the Claims page opens. Each side is
 * decided by its own claim rule (RB-ELIG), read against that side's holder,
 * never the reader's overall role: a side already collected burns its
 * position token, and the other side's holder must still be able to collect.
 *
 * A side is shown to the wallet that holds it, also while it waits on a loan
 * in fallback (the borrower's payout then waits for the lender's claim or a
 * cure). Its closed reason is stated (a pause, a loan in fallback, nothing
 * left), and one whose inputs could not
 * be read says that and is not offered. A claim in flight keeps its panel on
 * screen until the reader closes the finish card.
 */
export function LoanClaims({ loanId, view: v, own, chain, meta, frozen }: LoanClaimsProps) {
  const { text } = useCopy();
  const lender = useLoanClaimHeld(loanId, 'lender');
  const borrower = useLoanClaimHeld(loanId, 'borrower');
  const flows: Record<ClaimSide, ReturnType<typeof useLoanClaimHeld>> = { lender, borrower };
  const active: ClaimSide | null = lender.held ? 'lender' : borrower.held ? 'borrower' : null;

  const sides = (['lender', 'borrower'] as const).filter((s) => {
    const holder = v.holders[s];
    return sideShown(s, Number(v.loan.status)) && holder !== null && holder.toLowerCase() === own.account.toLowerCase();
  });
  if (active === null && sides.length === 0) return null;

  return (
    <section className="home-section position-actions" aria-labelledby="position-claims">
      <h2 id="position-claims">{text('loanClaim.sectionTitle')}</h2>
      {active !== null ? (
        <LoanClaim loanId={loanId} side={active} chain={chain} own={own} meta={meta} onClose={() => flows[active].setOpen(null)} />
      ) : (
        sides.map((s) => <SideRow key={s} side={s} view={v} own={own} frozen={frozen} onOpen={() => flows[s].setOpen(true)} />)
      )}
    </section>
  );
}

/** One side's action, or the reason it is closed. */
function SideRow({ side, view: v, own, frozen, onOpen }: { side: ClaimSide; view: LoanView; own: OwnStateClient; frozen: FrozenState | undefined; onOpen: () => void }) {
  const copy = useCopy();
  const { text } = copy;
  const nowMs = useNow();
  const verdict = claimVerdict(
    { side, status: Number(v.loan.status), loanAssetType: Number(v.loan.assetType), paused: v.paused, holder: v.holders[side], claim: v.claims[side], frozen },
    own.account,
    copy,
    nowMs,
  );
  if (verdict.state === 'open')
    return (
      <div className="position-action-row">
        <button type="button" className="btn btn-primary" onClick={onOpen} data-testid={`loan-claim-open-${side}`}>
          {text(side === 'lender' ? 'loanClaim.actionLender' : 'loanClaim.actionBorrower')}
        </button>
      </div>
    );
  return (
    <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-testid={`loan-claim-refusal-${side}`} data-code={verdict.refusals[0]?.code}>
      {verdict.state === 'unknown' ? text('loanClaim.unknown') : verdict.refusals[0]?.reason}
    </p>
  );
}
