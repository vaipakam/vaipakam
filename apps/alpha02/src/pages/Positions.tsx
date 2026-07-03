/**
 * My positions — the manage entry point. Answers "what do I have and
 * what needs my attention" with one row per loan; each row leads to
 * the detail page that carries the primary action. Open offers can be
 * cancelled from here (journeys B2/L2's cancellation branch —
 * releases the locked side).
 */
import { useState } from 'react';
import { ListChecks, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useMyLoans, useMyOffers } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { LoanRow } from '../components/LoanRow';
import { ReviewReceipt } from '../components/ReviewReceipt';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { submitErrorText } from '../lib/errors';
import type { IndexedOffer } from '../data/indexer';

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const isRental = offer.assetType !== AssetType.ERC20;
  const meta = useTokenMeta(isRental ? undefined : offer.lendingAsset);
  const { onSupportedChain, address } = useActiveChain();
  // cancelOffer authorizes only the CREATOR until the offer expires —
  // a wallet merely holding a transferred offer NFT gets no cancel
  // button (it would revert NotCreatorOrNotExpired).
  const isCreator =
    Boolean(address) && offer.creator.toLowerCase() === address!.toLowerCase();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = meta.data
    ? formatTokenAmount(offer.amountMax, meta.data.decimals)
    : '…';
  const isLending = offer.offerType === 0;
  const title = isRental
    ? `Your NFT listing · ${shortAddress(offer.lendingAsset)} #${offer.tokenId}`
    : `${isLending ? 'Your lending offer' : 'Your borrow request'} · ${amount} ${meta.data?.symbol ?? ''}`;

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(offer.offerId)]);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(submitErrorText(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const lockedStr = isRental
    ? `Your NFT ${shortAddress(offer.lendingAsset)} #${offer.tokenId}`
    : `${amount} ${meta.data?.symbol ?? ''}`;

  return (
    <div>
      <div className="item-row">
        <span className="row-main">
          <span className="row-title">{title}</span>
          <br />
          <span className="row-sub">
            Offer #{offer.offerId} · waiting for the other side to accept
            {error ? (
              <>
                <br />
                <span style={{ color: 'var(--danger)' }}>{error}</span>
              </>
            ) : null}
          </span>
        </span>
        {!isCreator ? (
          <span className="badge badge-neutral">Held — managed by its creator</span>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!onSupportedChain || busy}
            onClick={() => setConfirming((c) => !c)}
          >
            Cancel offer
          </button>
        )}
      </div>
      {isCreator && confirming ? (
        // Cancelling is a write like any other — it gets the same
        // six-row receipt before the wallet prompt (unlocks the
        // committed side and burns the offer's position NFT).
        <div className="card" style={{ marginTop: 8 }}>
          <ReviewReceipt
            data={{
              youReceive: `${lockedStr} back — unlocked from this offer immediately.`,
              youLock: 'Nothing.',
              youMayOwe: 'Nothing.',
              youCanLose: 'Nothing — cancelling an open offer has no penalty.',
              fees: 'None (network gas only).',
              whenThisEnds:
                'Immediately — the offer leaves the book and can’t be accepted anymore. Post a new offer any time.',
            }}
          />
          <div className="cluster" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Keep the offer
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy ? 'Cancelling…' : 'Confirm — cancel & unlock my assets'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Positions() {
  const { isConnected } = useActiveChain();
  const { setOpen } = useModal();
  const loans = useMyLoans();
  const offers = useMyOffers();

  return (
    <div>
      <h1 className="page-title">{copy.positions.title}</h1>
      <p className="page-lede">{copy.positions.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={ListChecks}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : loans.isLoading || offers.isLoading ? (
        <EmptyState icon={LoaderCircle} title="Loading your positions…" />
      ) : loans.data == null || offers.data == null ? (
        // EITHER source failing means the page can't honestly claim
        // "you have nothing" — a user's funds may be locked in exactly
        // the rows we couldn't load (audit F-20260702-001 class).
        <UnavailableState body={copy.positions.unavailable} />
      ) : (
        <>
          {offers.data.length > 0 ? (
            <section style={{ marginBottom: 24 }}>
              <h2>Open offers</h2>
              <div className="row-list">
                {offers.data.map((o) => (
                  <OfferRow key={o.offerId} offer={o} />
                ))}
              </div>
            </section>
          ) : null}

          {loans.data.length > 0 ? (
            <section>
              <h2>Loans</h2>
              <div className="row-list">
                {loans.data.map((loan) => (
                  <LoanRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
                ))}
              </div>
            </section>
          ) : null}

          {loans.data.length === 0 && offers.data.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title={copy.positions.emptyTitle}
              body={copy.positions.emptyBody}
              action={
                <Link to="/" className="btn btn-primary">
                  Get started
                </Link>
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}
