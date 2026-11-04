/**
 * #1209 — the Claims page's card for interest a wallet earned on lender
 * positions it sold. Each loan says what is waiting in the seller's vault,
 * what is still owed and when it is paid, and offers the withdrawal only
 * when a simulation says it would pay something now.
 */
import { useState } from 'react';
import { Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import type { Address, PublicClient } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { useTokenMeta } from '../contracts/erc20';
import { formatTokenAmount } from '../lib/format';
import { captureTxError } from '../lib/errors';
import { LoanStatus } from '../lib/types';
import {
  simulateSellerWithdraw,
  useMySellerClaims,
  type SellerClaimRow,
} from '../data/sellerClaims';

/** An amount of `asset` as text, or a stated stand-in while its details
 *  load or when they cannot be read. */
function useAmountText(asset: Address, amount: bigint): string {
  const meta = useTokenMeta(asset);
  if (meta.data) return `${formatTokenAmount(amount, meta.data.decimals)} ${meta.data.symbol}`;
  return meta.isError ? copy.claims.row.amountUnreadableInline : copy.claims.row.amountLoadingInline;
}

/** What the row says is owed and waiting, as one comparable value. */
function heldKey(row: SellerClaimRow): string {
  const held = row.held.map((h) => `${h.asset.toLowerCase()}:${h.amount}`).join('|');
  return `${row.status}/${row.owedGross}/${held}`;
}

function HeldLine({ asset, amount }: { asset: Address; amount: bigint }) {
  return <>{copy.sellerClaims.held(useAmountText(asset, amount))}</>;
}

/** What is still owed, worded for where the loan stands. */
function OwedLine({ row }: { row: SellerClaimRow }) {
  const amount = useAmountText(row.principalAsset, row.owedGross);
  if (row.status === LoanStatus.Active) return <>{copy.sellerClaims.owedOpen(amount)}</>;
  if (row.status === LoanStatus.FallbackPending) return <>{copy.sellerClaims.owedFallback(amount)}</>;
  return <>{copy.sellerClaims.owedEnded(amount)}</>;
}

function SellerClaimItem({ row }: { row: SellerClaimRow }) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const client = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was waiting when this row's withdrawal went through. While the
  // read still shows that same balance it has not caught up, so the button
  // stays hidden; once it moves, a later payment can be withdrawn again.
  const [withdrewFrom, setWithdrewFrom] = useState<string | null>(null);
  const heldNow = heldKey(row);
  const staleAfterWithdraw = withdrewFrom !== null && withdrewFrom === heldNow;
  const showWithdrawn = withdrewFrom !== null && (staleAfterWithdraw || row.withdraw.kind !== 'ready');

  async function withdraw() {
    if (!address || !walletChain || !client) return;
    setBusy(true);
    setError(null);
    try {
      // The card's verdict is a cached read: ask again just before signing.
      const live = await simulateSellerWithdraw(
        { client: client as PublicClient, diamond: walletChain.diamondAddress as Address, seller: address as Address },
        row.loanId,
      );
      if (live.kind === 'nothing-yet') throw new Error(copy.sellerClaims.nothingYet);
      if (live.kind === 'refused') throw new Error(live.reason);
      if (live.kind === 'unknown') throw new Error(copy.sellerClaims.checkFailed);
      await write('claimAsSeller', [BigInt(row.loanId)]);
      setWithdrewFrom(heldNow);
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['sellerClaims'] });
    }
  }

  return (
    <li className="item-row" style={{ alignItems: 'flex-start' }}>
      <span className="row-main">
        <Link to={`/positions/${row.loanId}`} className="row-title">
          {copy.sellerClaims.rowTitle(String(row.loanId))}
        </Link>
        {row.held.map((h) => (
          <span key={h.asset} className="row-sub" style={{ display: 'block' }}>
            <HeldLine asset={h.asset} amount={h.amount} />
          </span>
        ))}
        {row.owedGross > 0n ? (
          <span className="row-sub" style={{ display: 'block' }}>
            <OwedLine row={row} />
          </span>
        ) : null}
        {staleAfterWithdraw ? null : row.withdraw.kind === 'nothing-yet' ? (
          <span className="row-sub" style={{ display: 'block' }}>
            {copy.sellerClaims.nothingYet}
          </span>
        ) : row.withdraw.kind === 'refused' ? (
          <span className="row-sub" style={{ display: 'block' }}>
            {copy.sellerClaims.refused(row.withdraw.reason)}
          </span>
        ) : row.withdraw.kind === 'unknown' ? (
          <span className="row-sub" style={{ display: 'block' }}>
            {copy.sellerClaims.checkFailed}
          </span>
        ) : null}
        {showWithdrawn ? (
          <span className="row-sub" role="status" style={{ display: 'block' }}>
            {copy.sellerClaims.withdrawn}
          </span>
        ) : null}
        {error ? (
          <span className="row-sub" role="alert" style={{ display: 'block', color: 'var(--danger)' }}>
            {error}
          </span>
        ) : null}
      </span>
      {row.withdraw.kind === 'ready' && !staleAfterWithdraw ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !onSupportedChain}
          onClick={() => void withdraw()}
        >
          {busy ? copy.sellerClaims.withdrawing : copy.sellerClaims.withdraw}
        </button>
      ) : null}
    </li>
  );
}

/** Renders nothing for a wallet with no seller claims. */
export function SellerClaimsCard() {
  const claims = useMySellerClaims();
  if (claims.isLoading || claims.data === undefined) return null;
  if (claims.data === null) {
    return (
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">
          <Coins aria-hidden />
          <h2 style={{ margin: 0 }}>{copy.sellerClaims.title}</h2>
        </div>
        <p className="muted">{copy.sellerClaims.unavailable}</p>
      </section>
    );
  }
  const { rows, unread, truncated } = claims.data;
  // A cut-short list with nothing in it has not shown there is nothing: the
  // loans it did not reach may still owe this seller.
  if (rows.length === 0 && unread.length === 0 && !truncated) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="seller-claims">
      <div className="card-title">
        <Coins aria-hidden />
        <h2 style={{ margin: 0 }}>{copy.sellerClaims.title}</h2>
      </div>
      <p className="muted">{copy.sellerClaims.lede}</p>
      <ul className="row-list" style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((row) => (
          <SellerClaimItem key={row.loanId} row={row} />
        ))}
      </ul>
      {unread.map((id) => (
        <p key={id} className="muted">
          {copy.sellerClaims.unread(String(id))}
        </p>
      ))}
      {truncated ? <p className="muted">{copy.sellerClaims.truncated}</p> : null}
    </section>
  );
}

/** Whether the card shows anything. The Claims page's "nothing to claim"
 *  must not sit under a listed claim, a list that was cut short, or a check
 *  that could not be made: none of those shows there is nothing. */
export function useSellerClaimsListed(): boolean {
  const d = useMySellerClaims().data;
  if (d === undefined) return false;
  if (d === null) return true;
  return d.rows.length > 0 || d.unread.length > 0 || d.truncated;
}
