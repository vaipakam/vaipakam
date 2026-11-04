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
import { useMyExtendReserves, useReserveOutcomes, type ReserveRow } from '../data/autoExtend';
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
    // `data-amount` says whether the amount is in the token's units yet
    // (loading, ready, or unavailable when the token could not be read); the
    // live drive judges the row's amount only once it is ready.
    <li
      className="item-row"
      style={{ alignItems: 'flex-start' }}
      data-amount={meta.data ? 'ready' : meta.isError ? 'unavailable' : 'loading'}
    >
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
          <ReserveWithdraw
            loanId={row.loanId}
            reserved={row.reserved}
            meta={meta.data}
            metaFailed={meta.isError}
            busy={busy}
            setBusy={setBusy}
          />
        </span>
      </span>
    </li>
  );
}

/**
 * Where reserve discovery stands, published for a reader of the page (the
 * live drive), the way the forced-close card publishes its state: `loading`
 * until the list and every row's chain read have answered, `empty` when they
 * answered with nothing, `unavailable` when the list could not be read, and
 * `listed` otherwise. `data-unread` names loans whose row could not be read
 * and `data-truncated` a list cut short, so a reader never takes a row
 * missing for one of those reasons as a reserve that is not there.
 */
function DiscoveryState({ state, unread = [], truncated = false }: { state: 'loading' | 'empty' | 'unavailable' | 'listed'; unread?: readonly number[]; truncated?: boolean }) {
  return (
    <span
      hidden
      data-testid="extend-reserves-state"
      data-state={state}
      data-unread={unread.join(',')}
      data-truncated={truncated ? 'true' : 'false'}
    />
  );
}

/** Renders nothing visible for a wallet with no extension reserve. */
export function ExtendReservesCard() {
  const reserves = useMyExtendReserves();
  const outcomes = useReserveOutcomes();
  const c = copy.autoExtend.claims;
  // A withdrawal this session clears its row, so its outcome is listed here
  // on its own rather than with the row.
  const outcomeList = Object.entries(outcomes).map(([id, text]) => (
    <div key={id} className="banner banner-info" role="status" style={{ marginTop: 12 }}>
      <span className="banner-body">
        <Link to={`/positions/${id}`} style={{ display: 'block' }}>
          {copy.autoExtend.claims.rowTitle(id)}
        </Link>
        {text}
      </span>
    </div>
  ));
  // A failed read (or refresh: the hook drops a cached list behind one, as
  // it may already have been withdrawn or drawn) says it could not check.
  const data = reserves.isError ? null : reserves.data;
  if (data === undefined) return <DiscoveryState state="loading" />;
  const header = (
    <div className="card-title">
      <CalendarClock aria-hidden />
      <h2 style={{ margin: 0 }}>{c.title}</h2>
    </div>
  );
  if (data === null) {
    return (
      <section className="card" style={{ marginBottom: 16 }}>
        <DiscoveryState state="unavailable" />
        {header}
        <p className="muted">{c.unavailable}</p>
        {outcomeList}
      </section>
    );
  }
  const { rows, unread, truncated } = data;
  // A cut-short list with nothing in it has not shown there is nothing.
  if (rows.length === 0 && unread.length === 0 && !truncated && outcomeList.length === 0) {
    return <DiscoveryState state="empty" />;
  }
  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="extend-reserves">
      <DiscoveryState state="listed" unread={unread} truncated={truncated} />
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
      {outcomeList}
    </section>
  );
}

/** Whether the card shows anything: "Nothing to claim" must not sit under a
 *  listed reserve, a cut-short list, or a check that could not be made. */
export function useExtendReservesListed(): boolean {
  const q = useMyExtendReserves();
  const d = q.isError ? null : q.data;
  if (d === undefined) return false;
  if (d === null) return true;
  return d.rows.length > 0 || d.unread.length > 0 || d.truncated;
}
