import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCopy } from '../../shared/copy/useCopy';
import { loanLink } from '../../shared/loans/loanLink';

/**
 * #3769 — the borrower-position holder's card on a running ERC-20 loan: the
 * loan's link, bound to its network, for whoever will repay it, and the two
 * existing steps that pass the borrowed funds on (Withdraw, then send). The
 * card moves nothing and routes around no account policy.
 */
export function LoanLinkCard({ loanId, chainId }: { loanId: bigint; chainId: number }) {
  const { text } = useCopy();
  const url = loanLink(window.location.origin, loanId, chainId);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  };
  return (
    <section className="home-section position-share" aria-labelledby="position-share" data-testid="loan-link-card">
      <h2 id="position-share">{text('position.shareTitle')}</h2>
      <p className="tier-a">{text('position.shareLead')}</p>
      <div className="position-action-row">
        <input type="text" readOnly value={url} aria-label={text('position.shareTitle')} data-testid="loan-link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={copy} data-testid="loan-link-copy">
          {copied === 'yes' ? text('position.shareCopied') : text('position.shareCopy')}
        </button>
      </div>
      {copied === 'failed' && <p className="tier-a">{text('position.shareCopyFailed')}</p>}
      <p className="tier-a">{text('position.shareFunds')}</p>
      <p className="tier-b">
        <Link to="/vault">{text('position.shareFundsLink')}</Link>
      </p>
    </section>
  );
}
