/**
 * #2814 — the Claims page's card for extension reserves: money a wallet set
 * aside in its vault for a loan's automatic extensions. It is the depositor's
 * own and withdrawable at any time, so it is listed here for every loan it
 * sits on, with what (if anything) can still draw it.
 */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Address } from 'viem';
import { copy } from '../content/copy';
import { useTokenMeta } from '../contracts/erc20';
import { formatTokenAmount } from '../lib/format';
import { useMyExtendReserves, type ReserveRow } from '../data/autoExtend';
import { ReserveWithdraw } from './AutoExtendCard';

function ReserveItem({ row }: { row: ReserveRow }) {
  const meta = useTokenMeta(row.asset as Address);
  const [busy, setBusy] = useState(false);
  const r = copy.autoExtend.reserve;
  const amount = meta.data
    ? `${formatTokenAmount(row.reserved, meta.data.decimals)} ${meta.data.symbol}`
    : meta.isError
      ? copy.claims.row.amountUnreadableInline
      : copy.claims.row.amountLoadingInline;
  return (
    <li className="item-row" style={{ alignItems: 'flex-start' }}>
      <span className="row-main">
        <Link to={`/positions/${row.loanId}`} className="row-title">
          {copy.autoExtend.claims.rowTitle(String(row.loanId))}
        </Link>
        <span className="row-sub" style={{ display: 'block' }}>
          {r.leftover(amount)}
        </span>
        <span className="row-sub" style={{ display: 'block' }}>
          {row.use === 'kept' ? r.kept : row.use === 'ended' ? r.ended : r.notHolder}
        </span>
        <span style={{ display: 'block', marginTop: 8 }}>
          <ReserveWithdraw loanId={row.loanId} busy={busy} setBusy={setBusy} />
        </span>
      </span>
    </li>
  );
}

/** Renders nothing for a wallet with no extension reserve. */
export function ExtendReservesCard() {
  const reserves = useMyExtendReserves();
  const c = copy.autoExtend.claims;
  if (reserves.isLoading || reserves.data === undefined) return null;
  const header = (
    <div className="card-title">
      <CalendarClock aria-hidden />
      <h2 style={{ margin: 0 }}>{c.title}</h2>
    </div>
  );
  if (reserves.data === null) {
    return (
      <section className="card" style={{ marginBottom: 16 }}>
        {header}
        <p className="muted">{c.unavailable}</p>
      </section>
    );
  }
  const { rows, unread, truncated } = reserves.data;
  // A cut-short list with nothing in it has not shown there is nothing.
  if (rows.length === 0 && unread.length === 0 && !truncated) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="extend-reserves">
      {header}
      <p className="muted">{c.lede}</p>
      <ul className="row-list" style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((row) => (
          <ReserveItem key={row.loanId} row={row} />
        ))}
      </ul>
      {unread.map((id) => (
        <p key={id} className="muted">
          {c.unread(String(id))}
        </p>
      ))}
      {truncated ? <p className="muted">{c.truncated}</p> : null}
    </section>
  );
}

/** Whether the card shows anything: "Nothing to claim" must not sit under a
 *  listed reserve, a cut-short list, or a check that could not be made. */
export function useExtendReservesListed(): boolean {
  const d = useMyExtendReserves().data;
  if (d === undefined) return false;
  if (d === null) return true;
  return d.rows.length > 0 || d.unread.length > 0 || d.truncated;
}
