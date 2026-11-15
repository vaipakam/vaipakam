import { Fragment } from 'react';
import { useCopy } from '../copy/useCopy';
import { claimVerdict } from '../eligibility/claim';
import { assetAmount } from '../positions/assetAmount';
import { assetName, useTokenMeta } from '../reads/tokens';
import type { OwnRead } from '../reads/useOwnRead';
import type { FrozenState } from '../sanctions/posture';
import { useNow } from '../ui/useNow';
import { ASSET_ERC20, isFallback } from './loanClaim';
import type { LoanClaimRows } from './loanClaimRows';
import { readyToClaim, type ReadyInput } from './claimWithdraw';

type Hex = `0x${string}`;

/**
 * #3631 — "Ready to claim": what every loan payout this wallet may collect
 * NOW adds up to, per asset, on Claims and on Home. Each payout counts only
 * when its claim rule is open (RB-ELIG, the same verdict its button reads);
 * one that waits or could not be read is counted apart and said so, so the
 * total is never more than the protocol would pay, and never silently less.
 * A claim pays the holder's vault, so the total is never called received.
 */
export function ReadyToClaim({
  claims,
  bookFailed,
  frozen,
  account,
  heading = 'h2',
}: {
  claims: OwnRead<LoanClaimRows>;
  bookFailed: boolean;
  frozen: FrozenState | undefined;
  account: Hex;
  heading?: 'h2' | 'h3';
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const nowMs = useNow();
  const data = claims.data;
  const inputs: ReadyInput[] = (data?.rows ?? []).map((r) => {
    if (r.loan === null || r.claim === null) return { lanes: r.lanes, state: 'unknown' };
    const v = claimVerdict(
      { side: r.side, status: Number(r.loan.status), loanAssetType: Number(r.loan.assetType), paused: data!.paused, holder: r.holder, claim: r.claim, frozen },
      account,
      copy,
      nowMs,
    );
    if (v.state === 'open' && r.side === 'lender' && isFallback(Number(r.loan.status))) return { lanes: r.lanes, state: 'contingent' };
    return { lanes: r.lanes, state: v.state === 'open' ? 'open' : v.state === 'unknown' ? 'unknown' : 'closed' };
  });
  const sum = readyToClaim(inputs);
  const meta = useTokenMeta(sum.totals.map((t) => t.asset)).data;
  const H = heading;

  if (data === null) {
    if (claims.state !== 'failed' && !bookFailed) return null;
    return (
      <section className="home-section ready-to-claim" aria-labelledby="ready-to-claim">
        <H id="ready-to-claim">{text('claimWithdraw.readyTitle')}</H>
        <p className="tier-a" data-testid="ready-to-claim-failed">
          {format('claims.failed', { reason: claims.error ?? '' })}
        </p>
      </section>
    );
  }
  if (data.rows.length === 0 && data.complete) return null;

  return (
    <section className="home-section ready-to-claim" aria-labelledby="ready-to-claim" data-testid="ready-to-claim">
      <H id="ready-to-claim">{text('claimWithdraw.readyTitle')}</H>
      {sum.totals.length === 0 ? (
        <p className="tier-b">{text('claimWithdraw.readyNone')}</p>
      ) : (
        <>
          <dl className="facts" data-testid="ready-to-claim-totals">
            {sum.totals.map((t) => (
              <Fragment key={`${t.asset}:${t.assetType}:${t.tokenId}`}>
                <dt className="tier-b">{assetName(t.asset, meta)}</dt>
                <dd data-asset={t.asset.toLowerCase()}>
                  {t.assetType === ASSET_ERC20
                    ? assetAmount({ asset: t.asset, assetType: t.assetType, amount: t.amount, tokenId: 0n, quantity: 0n }, meta, format)
                    : assetAmount({ asset: t.asset, assetType: t.assetType, amount: 0n, tokenId: t.tokenId, quantity: t.amount }, meta, format)}
                </dd>
              </Fragment>
            ))}
          </dl>
          <p className="tier-b">{sum.ready === 1 ? text('claimWithdraw.readyFromOne') : format('claimWithdraw.readyFrom', { n: String(sum.ready) })}</p>
        </>
      )}
      {sum.contingent > 0 && (
        <p className="tier-a" data-testid="ready-to-claim-contingent">
          {format('claimWithdraw.readyContingent', { n: String(sum.contingent) })}
        </p>
      )}
      {sum.waiting > 0 && <p className="tier-b">{format('claimWithdraw.readyWaiting', { n: String(sum.waiting) })}</p>}
      {sum.unread > 0 && (
        <p className="tier-a" data-testid="ready-to-claim-unread">
          {format('claimWithdraw.readyUnread', { n: String(sum.unread) })}
        </p>
      )}
      {claims.error !== null && (
        <p className="tier-a" data-testid="ready-to-claim-stale">
          {format('claimWithdraw.readyStale', { reason: claims.error })}
        </p>
      )}
      {!data.complete && <p className="tier-a">{text('claimWithdraw.readyIncomplete')}</p>}
      {sum.totals.length > 0 && <p className="tier-b">{text('claimWithdraw.readyNote')}</p>}
    </section>
  );
}
