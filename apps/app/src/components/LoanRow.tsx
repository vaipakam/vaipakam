/** One position in a list: role, plain state, amounts, link to detail.
 *  Rentals (NFT principal) read as rentals, never as debt. */
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { formatBpsAsPercent, formatTokenAmount, shortAddress } from '../lib/format';
import { loanStateView, loanStateLabel, withGraceVerdict } from '../lib/loanState';
import { useLoanPastGrace } from '../data/pastGrace';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import type { PositionLoan } from '../data/hooks';
import { initiatedPrincipal } from '../lib/positionAmounts';
import type { ClaimableLoan } from '../data/claimables';
import { useClaimPayoutText } from '../data/useClaimPayout';
import { healthView, useLoanRisk } from '../data/risk';

export function LoanRow({
  loan,
  claim,
}: {
  loan: PositionLoan;
  /** UX-024 — the chain-confirmed unclaimed payout on this side (from
   *  useMyClaimables), so a defaulted/repaid row with money on the table
   *  says so. UX3-004/UX3-014 — the row states WHAT is waiting and offers
   *  the Claim action, as the Claims page does, instead of a bare chip. */
  claim?: ClaimableLoan;
}) {
  const payout = useClaimPayoutText(claim);
  const isRental = loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(isRental ? undefined : loan.lendingAsset);
  const timeView = loanStateView(loan);
  // #2463 follow-up — an open row asks the chain whether grace has ended;
  // only its `true` turns the time-based badge into "Past grace". Asked
  // for every open loan, not only past-due ones by this device's clock,
  // because the chain's clock is the one the contract uses.
  const pastGrace = useLoanPastGrace(loan.loanId, loan.status === 'active');
  // A failed refresh keeps TanStack's last `data`; that is a STALE verdict
  // (governance may have lengthened grace meanwhile), so an errored read
  // counts as unread rather than as the last answer.
  const verdict = pastGrace.isError ? undefined : pastGrace.data;
  const view = withGraceVerdict(timeView, verdict);
  // Any open row whose grace answer is not in hand may already be past
  // grace — the device clock can run behind the chain's, so "On track" or
  // "Due soon" is no safer than "Past due" here. Say the answer is pending
  // or unavailable instead of letting the time label read as the whole
  // lifecycle state (#2475 r6).
  const graceUnread =
    loan.status === 'active' && view.labelKey !== 'pastGrace' && verdict === undefined
      ? pastGrace.isError
        ? { note: copy.loanRow.graceUnknown, title: copy.loanRow.graceUnknownTitle }
        : { note: copy.loanRow.graceChecking, title: copy.loanRow.graceCheckingTitle }
      : null;
  const pastGraceTitle =
    view.labelKey !== 'pastGrace'
      ? undefined
      : loan.role === 'lender'
        ? copy.loanRow.pastGraceLender
        : isRental
          ? copy.loanRow.pastGraceRenter
          : copy.loanRow.pastGraceBorrower;
  // UX-003 — the time-based badge alone can show a reassuring green on
  // a loan hovering at the liquidation line. For active priced loans,
  // let a WORSE health state override the badge (never a better one —
  // "past due" stays past due even at a healthy HF).
  const watchHealth = loan.status === 'active' && !isRental;
  const risk = useLoanRisk(watchHealth ? loan.loanId : undefined, watchHealth);
  const health = risk.data?.priced ? healthView(risk.data) : null;
  const badgeRank = { ok: 0, neutral: 0, warn: 1, danger: 2 } as const;
  const healthOverrides =
    health !== null &&
    health.badge !== 'ok' &&
    badgeRank[health.badge] > badgeRank[view.badge];
  // While the health read is loading or errored, a green time badge
  // would re-assert exactly the false-safe state this override exists
  // to remove — go neutral until health is actually known (Codex
  // #1166 r1). Worse-than-ok time badges keep their own urgency.
  const healthUnknown = watchHealth && risk.data === undefined;

  // #2453 — what was lent or borrowed, not the live outstanding principal.
  const initPrincipal = initiatedPrincipal(loan);
  const symbol = principalMeta.data?.symbol ?? '';
  const amount =
    initPrincipal === null
      ? null
      : principalMeta.data
        ? formatTokenAmount(initPrincipal, principalMeta.data.decimals)
        : '…';

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">
          {isRental
            ? `${loan.role === 'borrower' ? copy.loanRow.youRent : copy.loanRow.youRentOut} NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`
            : loan.role === 'borrower'
              ? amount === null
                ? copy.positions.rowBorrowedAmountUnknown
                : copy.positions.rowBorrowed(`${amount} ${symbol}`)
              : amount === null
                ? copy.positions.rowLentAmountUnknown
                : copy.positions.rowLent(`${amount} ${symbol}`)}
        </span>
        <br />
        <span className="row-sub">
          {isRental
            ? copy.positions.rowRental(loan.loanId)
            : copy.positions.rowLoan(loan.loanId, formatBpsAsPercent(loan.interestRateBps))}
        </span>
        {pastGraceTitle ? (
          <>
            <br />
            {/* Visible, not only the badge's `title`: a touch screen has no
                hover and keyboard focus lands on the row's link. */}
            <span className="row-sub" data-testid="loan-row-past-grace">
              {pastGraceTitle}
            </span>
          </>
        ) : null}
        {payout ? (
          <>
            <br />
            <span className="row-sub row-payout">{copy.positions.readyToClaim(payout.what)}</span>
            {/* #2373 r6 — the reason a provisional payout may change. */}
            {payout.provisional && payout.note ? (
              <span className="row-sub claim-payout-note">{payout.note}</span>
            ) : null}
          </>
        ) : null}
      </span>
      {healthOverrides && health ? (
        <span
          className={`badge badge-${health.badge}`}
          title={copy.risk.healthTitle(health.ratio)}
        >
          {health.label}
        </span>
      ) : healthUnknown && view.badge === 'ok' ? (
        <span className="badge badge-neutral" title={copy.risk.listCheckingTitle}>
          {loanStateLabel(view, copy.loanState)} · {copy.risk.listChecking}
        </span>
      ) : (
        <span
          className={`badge badge-${view.badge}`}
          title={pastGraceTitle ?? graceUnread?.title}
          data-testid="loan-row-state"
          data-state-key={view.labelKey}
        >
          {loanStateLabel(view, copy.loanState)}
          {graceUnread ? ` · ${graceUnread.note}` : null}
        </span>
      )}
      {claim ? <span className="btn btn-primary btn-sm">{copy.claims.claim}</span> : null}
    </Link>
  );
}
