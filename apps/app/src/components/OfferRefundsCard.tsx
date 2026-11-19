/**
 * #3744 — offer amounts held for the wallet's offer positions.
 *
 * An offer's escrow follows its position token. When a fill, match or
 * expired cleanup someone else triggered could not pay the token's holder
 * right then, the amount stays in the offer creator's vault, held for the
 * token, until its holder collects it. Collecting moves it into the holder's
 * own vault as free balance; Withdraw takes it to a wallet from there.
 *
 * Every line here is confirmed live (`useOfferHeldRefunds`): the amount is
 * the contract's, not the indexer's. A line whose live read failed says so
 * and offers no step. The card renders nothing when there is nothing held,
 * and says when it could not check.
 */
import { useState } from 'react';
import { usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { assertRowActionStillValid } from '../contracts/preflights';
import { useTokenMeta } from '../contracts/erc20';
import { captureTxError } from '../lib/errors';
import { formatTokenAmountExact, shortAddress } from '../lib/format';
import { useOfferHeldRefunds, type HeldRefundLine } from '../data/offerHeldRefunds';

const text = copy.positions.heldRefunds;

function RefundLine({ line }: { line: HeldRefundLine }) {
  const { address, onSupportedChain, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const isErc20 = line.assetKind === 0;
  const meta = useTokenMeta(isErc20 ? line.asset : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const what =
    line.liveAmount === null
      ? text.unconfirmed
      : isErc20
        ? meta.data
          ? `${formatTokenAmountExact(line.liveAmount, meta.data.decimals)} ${meta.data.symbol}`
          : '…'
        : text.nftAmount(shortAddress(line.asset), line.tokenId, line.liveAmount.toString());

  async function collect() {
    if (line.assetKind === null) return;
    setBusy(true);
    setError(null);
    const args = [
      BigInt(line.positionToken),
      line.assetKind,
      line.asset as `0x${string}`,
      BigInt(line.tokenId),
    ] as const;
    try {
      if (publicClient && address) {
        await assertRowActionStillValid({
          publicClient,
          diamond: readChain.diamondAddress,
          account: address,
          functionName: 'collectOfferRefund',
          args,
        });
      }
      await write('collectOfferRefund', args);
      void queryClient.invalidateQueries({ queryKey: ['offerHeldRefunds'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">{what}</span>
        <br />
        <span className="row-sub">
          {text.lineSub(line.positionToken)}
          {line.assetKind === null && line.liveAmount !== null ? (
            <>
              <br />
              {text.kindUnknown}
            </>
          ) : null}
          {error ? (
            <>
              <br />
              <span style={{ color: 'var(--danger)' }}>{error}</span>
            </>
          ) : null}
        </span>
      </span>
      {line.liveAmount !== null && line.assetKind !== null ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!onSupportedChain || busy}
          onClick={() => void collect()}
        >
          {busy ? text.collecting : text.collect}
        </button>
      ) : null}
    </div>
  );
}

export function OfferRefundsCard() {
  const held = useOfferHeldRefunds();
  if (held.isError || held.data === null) {
    return (
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {text.unavailable}
      </p>
    );
  }
  if (held.data === undefined || held.data.lines.length === 0) return null;
  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <h2>{text.title}</h2>
      <p className="muted">{text.lede}</p>
      {held.data.lines.map((line) => (
        <RefundLine key={`${line.positionToken}|${line.asset}|${line.tokenId}`} line={line} />
      ))}
      {held.data.truncated ? <p className="muted">{text.truncated}</p> : null}
    </section>
  );
}
