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
import { useMyLoansFull, useMyOffersFull } from '../data/hooks';
import { useMyClaimables } from '../data/claimables';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { LoanRow } from '../components/LoanRow';
import { ReviewReceipt } from '../components/ReviewReceipt';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { captureTxError } from '../lib/errors';
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
      setError(captureTxError(err));
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
  const loans = useMyLoansFull();
  const offers = useMyOffersFull();
  // UX-024 — chain-confirmed unclaimed payouts (same query the Claim
  // Center runs, shared via the query cache). Rows with one group
  // under "Needs your attention" with an explicit chip. While this is
  // loading/unavailable the list degrades to Active/Ended grouping —
  // it never guesses a claim.
  const claimables = useMyClaimables();
  const claimKeys = new Set(
    (claimables.data ?? []).map((c) => `${c.loanId}-${c.role}`),
  );
  // Current positions come from the CHAIN (authoritative, fresh this
  // block) with the indexer as the redundancy leg. Either source
  // failing means the list is served single-sourced — say so, never
  // render a possibly-degraded list as the whole truth.
  const sourcesDegraded =
    loans.data != null &&
    offers.data != null &&
    (!loans.data.chainOk ||
      !loans.data.indexerOk ||
      !offers.data.chainOk ||
      !offers.data.indexerOk);

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
        // BOTH sources (chain + indexer) failing for a list means the
        // page can't honestly claim "you have nothing" — a user's
        // funds may be locked in exactly the rows we couldn't load
        // (audit F-20260702-001 class).
        <UnavailableState
          body={copy.positions.unavailable}
          onRetry={() => {
            void loans.refetch();
            void offers.refetch();
          }}
        />
      ) : (
        <>
          {sourcesDegraded ? (
            <div className="banner banner-warn" role="alert">
              <span className="banner-body">{copy.positions.sourcesDegraded}</span>
            </div>
          ) : null}

          {offers.data.rows.length > 0 ? (
            <section style={{ marginBottom: 24 }}>
              <h2>Open offers</h2>
              <div className="row-list">
                {offers.data.rows.map((o) => (
                  <OfferRow key={o.offerId} offer={o} />
                ))}
              </div>
            </section>
          ) : null}

          {loans.data.rows.length > 0
            ? (() => {
                // UX-024 — group by what needs the user: confirmed
                // claims first, then live loans, then history.
                const rows = loans.data.rows;
                const keyOf = (l: (typeof rows)[number]) =>
                  `${l.loanId}-${l.role}`;
                const attention = rows.filter((l) => claimKeys.has(keyOf(l)));
                const live = rows.filter(
                  (l) =>
                    !claimKeys.has(keyOf(l)) &&
                    (l.status === 'active' || l.status === 'fallback_pending'),
                );
                const ended = rows.filter(
                  (l) =>
                    !claimKeys.has(keyOf(l)) &&
                    l.status !== 'active' &&
                    l.status !== 'fallback_pending',
                );
                const group = (
                  title: string,
                  list: typeof rows,
                  claimWaiting: boolean,
                ) =>
                  list.length > 0 ? (
                    <section style={{ marginBottom: 24 }}>
                      <h2>{title}</h2>
                      <div className="row-list">
                        {list.map((loan) => (
                          <LoanRow
                            key={keyOf(loan)}
                            loan={loan}
                            claimWaiting={claimWaiting}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null;
                return (
                  <>
                    {group(copy.positions.groupAttention, attention, true)}
                    {group(copy.positions.groupActive, live, false)}
                    {group(copy.positions.groupEnded, ended, false)}
                  </>
                );
              })()
            : null}

          {loans.data.rows.length === 0 && offers.data.rows.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title={copy.positions.emptyTitle}
              body={copy.positions.emptyBody}
              action={
                <div className="stack" style={{ alignItems: 'center', gap: 8 }}>
                  <Link to="/" className="btn btn-primary">
                    Get started
                  </Link>
                  {/* UX-050 (Codex #1171 r1) — a past user with no current
                      positions but historical activity must still find
                      the feed; the link belongs on the EMPTY state too,
                      not only the non-empty branch. */}
                  <Link to="/activity" className="muted">
                    {copy.positions.seeActivity}
                  </Link>
                </div>
              }
            />
          ) : (
            // UX-050 — surface the full activity history for Basic-mode
            // users, who don't get Activity in the nav.
            <p className="muted" style={{ marginTop: 8 }}>
              <Link to="/activity">{copy.positions.seeActivity}</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
