/**
 * #3858 — the closed-network view.
 *
 * Shown in place of every screen that opens a position when the read
 * chain's deployment record says the network is Closed. It lists what the
 * wallet still holds there, read from the network itself (see
 * `data/closedNetwork.ts`), and offers only the ways out, which stay
 * available with no end date: withdrawing from the vault, claiming,
 * cancelling an offer and taking capital out of an Auto-lend slot.
 *
 * Copy states facts only. It names no date, does not say a balance is at
 * risk, and does not point the user to another network or product
 * (NetworkWindDownDesign section 10).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { DoorClosed, LoaderCircle } from 'lucide-react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { assertRowActionStillValid } from '../contracts/preflights';
import { useTokenMeta } from '../contracts/erc20';
import { CLOSED_SLOT_PAGE, useClosedNetworkHoldings, type HeldSlot } from '../data/closedNetwork';
import { formatTokenAmount } from '../lib/format';
import { captureTxError } from '../lib/errors';
import { EmptyState, UnavailableState } from './EmptyState';

/** One exit write with a preflight, a busy state and an inline error. */
function useExit(functionName: string, args: readonly unknown[]) {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (publicClient && address) {
        await assertRowActionStillValid({
          publicClient,
          diamond: readChain.diamondAddress,
          account: address,
          functionName,
          args,
        });
      }
      await write(functionName, args);
      void queryClient.invalidateQueries({ queryKey: ['closedNetworkHoldings'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error };
}

function OfferRow({ offerId }: { offerId: bigint }) {
  const exit = useExit('cancelOffer', [offerId]);
  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">{copy.closedNetwork.offerRow(offerId.toString())}</span>
        {exit.error ? (
          <>
            <br />
            <span className="row-sub" role="alert">{exit.error}</span>
          </>
        ) : null}
      </span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={exit.busy} onClick={() => void exit.run()}>
        {copy.closedNetwork.cancelOffer}
      </button>
    </div>
  );
}

function SlotRow({ slot }: { slot: HeldSlot }) {
  const { address } = useActiveChain();
  const meta = useTokenMeta(slot.lendingAsset);
  const exit = useExit('withdrawLenderIntentCapital', [
    address,
    slot.lendingAsset,
    slot.collateralAsset,
    slot.slot,
    slot.available,
  ]);
  const amount = meta.data ? formatTokenAmount(slot.available, meta.data.decimals) : '…';
  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {copy.closedNetwork.slotRow(amount, meta.data?.symbol ?? '', String(slot.slot + 1))}
        </span>
        {exit.error ? (
          <>
            <br />
            <span className="row-sub" role="alert">{exit.error}</span>
          </>
        ) : null}
      </span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={exit.busy} onClick={() => void exit.run()}>
        {copy.closedNetwork.takeCapitalOut}
      </button>
    </div>
  );
}

export function ClosedNetworkView() {
  const { isConnected, readChain } = useActiveChain();
  const { setOpen } = useModal();
  const holdings = useClosedNetworkHoldings();

  return (
    <div data-closed-network-view="">
      <h1 className="page-title">{copy.closedNetwork.title(readChain.name)}</h1>
      <p className="page-lede">{copy.closedNetwork.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={DoorClosed}
          title={copy.closedNetwork.connectPrompt}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : (
        <div className="stack">
          <section className="card">
            <h2 className="card-title">{copy.closedNetwork.vaultTitle}</h2>
            <p className="muted">{copy.closedNetwork.vaultBody}</p>
            <Link to="/vault" className="btn btn-primary">
              {copy.closedNetwork.openVault}
            </Link>
          </section>

          <section className="card">
            <h2 className="card-title">{copy.closedNetwork.claimsTitle}</h2>
            <p className="muted">{copy.closedNetwork.claimsBody}</p>
            <Link to="/claims" className="btn btn-secondary">
              {copy.closedNetwork.openClaims}
            </Link>
          </section>

          {holdings.isLoading ? (
            <EmptyState icon={LoaderCircle} title={copy.chrome.loading} />
          ) : holdings.isError || !holdings.data ? (
            <UnavailableState body={copy.closedNetwork.unavailable} onRetry={() => void holdings.refetch()} />
          ) : (
            <>
              <section className="card">
                <h2 className="card-title">{copy.closedNetwork.offersTitle}</h2>
                {holdings.data.offerIds.length === 0 ? (
                  <p className="muted">{copy.closedNetwork.offersNone}</p>
                ) : (
                  holdings.data.offerIds.map((id) => <OfferRow key={id.toString()} offerId={id} />)
                )}
              </section>

              <section className="card">
                <h2 className="card-title">{copy.closedNetwork.slotsTitle}</h2>
                {holdings.data.slots.length === 0 ? (
                  <p className="muted">{copy.closedNetwork.slotsNone}</p>
                ) : (
                  holdings.data.slots.map((s) => (
                    <SlotRow key={`${s.lendingAsset}-${s.collateralAsset}-${s.slot}`} slot={s} />
                  ))
                )}
                {holdings.data.slotTotal > CLOSED_SLOT_PAGE ? (
                  <p className="muted" role="status">
                    {copy.closedNetwork.slotsMore(String(CLOSED_SLOT_PAGE), String(holdings.data.slotTotal))}
                  </p>
                ) : null}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
