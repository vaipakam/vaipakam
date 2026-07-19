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
import { usePublicClient } from 'wagmi';
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
import { WindowedRowList } from '../lib/visibleWindow';
import { assertRowActionStillValid } from '../contracts/preflights';
import type { IndexedOffer } from '../data/indexer';

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const isRental = offer.assetType !== AssetType.ERC20;
  const meta = useTokenMeta(isRental ? undefined : offer.lendingAsset);
  const { onSupportedChain, address, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
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
    ? `${copy.positions.offerRow.yourNftListing} · ${shortAddress(offer.lendingAsset)} #${offer.tokenId}`
    : `${isLending ? copy.positions.offerRow.yourLendingOffer : copy.positions.offerRow.yourBorrowRequest} · ${amount} ${meta.data?.symbol ?? ''}`;

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      // RPC read-diet PR A (§4.1.2) — blocking click-time preflight:
      // this list row refreshes at push latency, so simulate the exact
      // cancel before the wallet prompt (revert → inline reason,
      // transport trouble → fail open, the chain still enforces).
      if (publicClient && address) {
        await assertRowActionStillValid({
          publicClient,
          diamond: readChain.diamondAddress,
          account: address,
          functionName: 'cancelOffer',
          args: [BigInt(offer.offerId)],
        });
      }
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
    ? copy.positions.offerRow.youNft(shortAddress(offer.lendingAsset), offer.tokenId)
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
          <span className="badge badge-neutral">{copy.positions.offerRow.held}</span>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!onSupportedChain || busy}
            onClick={() => setConfirming((c) => !c)}
          >
            {copy.positions.offerRow.cancel}
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
              youReceive: copy.positions.offerRow.receiptUnlocked(lockedStr),
              youLock: copy.positions.offerRow.receiptNothing,
              youMayOwe: copy.positions.offerRow.receiptNothing,
              youCanLose: copy.positions.offerRow.receiptLose,
              fees: copy.positions.offerRow.receiptFees,
              whenThisEnds: copy.positions.offerRow.receiptEnds,
            }}
          />
          <div className="cluster" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              {copy.positions.offerRow.keep}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void cancel()}
            >
              {busy
                ? copy.positions.offerRow.cancelling
                : copy.positions.offerRow.confirmCancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Positions() {
  const { isConnected, address, readChain } = useActiveChain();
  // #1247 — window identity: a wallet/chain switch on this mounted
  // page must collapse every expanded window (Codex #1265 r1).
  const listKey = `${readChain.chainId}|${address?.toLowerCase() ?? ''}`;
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
        <EmptyState icon={LoaderCircle} title={copy.positions.loading} />
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
              <h2>{copy.positions.openOffers}</h2>
              {/* #1247 PAG-001 — windowed: the data caps allow up to
                  500–2000 rows; render (and each row's token-meta
                  reads) must scale with what the user asks to see. */}
              <WindowedRowList
                rows={offers.data.rows}
                resetKey={listKey}
                render={(o) => <OfferRow key={o.offerId} offer={o} />}
              />
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
                // #1247 PAG-001 — live/ended groups are windowed; the
                // attention group stays unwindowed on purpose (it is
                // the actionable set, naturally small, and a hidden
                // claim row would be a hidden payout).
                const group = (
                  title: string,
                  list: typeof rows,
                  claimWaiting: boolean,
                  windowed: boolean,
                ) =>
                  list.length > 0 ? (
                    // key + group-scoped resetKey (Codex #1265 r3):
                    // when a whole group empties (all Active loans
                    // end), React would otherwise reuse this unkeyed
                    // sibling's window instance for the SHIFTED group
                    // — same listKey, no reset, previous expanded
                    // count inherited.
                    <section key={title} style={{ marginBottom: 24 }}>
                      <h2>{title}</h2>
                      {windowed ? (
                        <WindowedRowList
                          rows={list}
                          resetKey={`${listKey}|${title}`}
                          render={(loan) => (
                            <LoanRow
                              key={keyOf(loan)}
                              loan={loan}
                              claimWaiting={claimWaiting}
                            />
                          )}
                        />
                      ) : (
                        <div className="row-list">
                          {list.map((loan) => (
                            <LoanRow
                              key={keyOf(loan)}
                              loan={loan}
                              claimWaiting={claimWaiting}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  ) : null;
                return (
                  <>
                    {group(copy.positions.groupAttention, attention, true, false)}
                    {group(copy.positions.groupActive, live, false, true)}
                    {group(copy.positions.groupEnded, ended, false, true)}
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
                    {copy.positions.getStarted}
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
