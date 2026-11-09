import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { useTxEntries, useTxStore } from '../tx/txStore';
import { reviewIdentity } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { OwnStamp } from '../ui/OwnStamp';
import { readPaused } from './sellerClaim';
import { discoverReserveLoans, readReserveRow, reserveDrawable, reserveRowShown, reserveVerdict, type ReserveRow } from './reserve';
import type { ReserveReview } from './reserveReview';
import type { FrozenState } from '../sanctions/posture';
import { RESERVE_KEY_PREFIX, ReserveWithdraw, reserveKey, reserveWords, useReserveHeld } from './ReserveWithdraw';

/** How often the index is asked again for the wallet's reserve loans. */
const DISCOVERY_POLL_MS = 60_000;

/**
 * Claims › Extension reserves (LN-62): each loan on which this wallet set
 * aside the loan's principal token for its extensions and has some left.
 * The index names the loans (any step of a reserve filed under this wallet);
 * each is then read from the chain as the withdrawal reads it, and only the
 * chain decides what is reserved, whether an extension can still draw on it
 * and whether it can be taken back now. A loan can also be looked up by its
 * number, which reads the chain alone. A withdrawal in progress stays on
 * screen until its finish card is closed, whatever the latest list says.
 */
export function Reserves({ own, chain, frozen }: { own: OwnStateClient; chain: SupportedChain; frozen?: FrozenState }) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const wallet = own.account;
  const diamond = chain.diamondAddress;
  const configured = world.indexer.origin !== null;
  const discovery = useQuery({
    queryKey: worldKey(chain.chainId, 'reserveLoans', wallet.toLowerCase()),
    queryFn: () => discoverReserveLoans(world.indexer, chain.chainId, wallet),
    enabled: configured,
    refetchInterval: DISCOVERY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: DISCOVERY_POLL_MS / 2,
    retry: 1,
  });
  const [lookupText, setLookupText] = useState('');
  const lookup = /^\d+$/.test(lookupText.trim()) && BigInt(lookupText.trim()) > 0n ? BigInt(lookupText.trim()) : null;

  const found = discovery.data?.loanIds ?? [];
  const ids = [...new Set([...found, ...(lookup !== null ? [lookup] : [])].map((i) => i.toString()))].map((s) => BigInt(s)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rows = useOwnRead(
    ['reserve', diamond, ids.join(',')],
    async (c) => {
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const [paused, list] = await Promise.all([readPaused(c, diamond, block), Promise.all(ids.map((id) => readReserveRow(c, diamond, id, wallet, block)))]);
      return { paused, list };
    },
    { enabled: ids.length > 0 },
  );
  const list = rows.data?.list ?? [];
  const shown = list.filter((r) => reserveRowShown(r));
  const drawn = new Set(shown.map((r) => r.loanId.toString()));
  const held = useHeldReserveFlows(reviewIdentity(own)).filter((h) => !drawn.has(h.loanId.toString()));
  const assets = list.flatMap((r) => (r.funding ? [r.funding.asset] : r.loan ? [r.loan.principalAsset] : []));
  const meta = useTokenMeta(assets).data;
  // A failed poll keeps the last list, so a failure is said whether or not a
  // list is cached, and nothing is said empty until discovery answers again.
  const discoveryFailed = !configured || discovery.status === 'error';
  const discoveryCached = discovery.data !== undefined;
  const failure = discovery.error;
  const discoveryReason = !configured
    ? text('sellerClaim.noIndex')
    : failure instanceof IndexerUnavailable
      ? text(
          failure.why === 'network'
            ? 'sellerClaim.indexNetwork'
            : failure.why === 'shape'
              ? 'sellerClaim.indexShape'
              : failure.why === 'status'
                ? 'sellerClaim.indexStatus'
                : 'sellerClaim.noIndex',
        )
      : ((failure as Error | null)?.message ?? '');
  const lookupRow = lookup !== null ? (list.find((r) => r.loanId === lookup) ?? null) : null;
  const settled = discovery.status === 'success' && discovery.data.complete && (ids.length === 0 || (rows.data !== null && rows.error === null));

  return (
    <section className="home-section" aria-labelledby="claims-reserves">
      <h2 id="claims-reserves">{text('reserve.sectionTitle')}</h2>
      {ids.length > 0 && <OwnStamp reads={[rows]} />}
      {configured && discovery.data === undefined && discovery.status !== 'error' && <p className="tier-b">{text('reserve.reading')}</p>}
      {discoveryFailed && (
        <p className="tier-a" data-testid="reserve-failed">
          {format(configured && discoveryCached ? 'reserve.discoveryStale' : 'reserve.discoveryFailed', { reason: discoveryReason })}
        </p>
      )}
      {discovery.data?.complete === false && <p className="tier-a">{text('reserve.discoveryIncomplete')}</p>}
      {rows.state === 'failed' && rows.data === null && <p className="tier-a">{format('reserve.rowsFailed', { reason: rows.error ?? '' })}</p>}
      {shown.length + held.length > 0 && (
        <ul className="rows" data-testid="reserve-rows">
          {shown.map((r) => (
            <ReserveCard key={r.loanId.toString()} row={r} paused={rows.data?.paused ?? null} frozen={frozen} readAt={rows.readAt ?? 0} own={own} chain={chain} meta={meta} />
          ))}
          {held.map((h) => (
            <HeldReserveCard key={h.loanId.toString()} loanId={h.loanId} own={own} chain={chain} meta={meta} />
          ))}
        </ul>
      )}
      {settled && shown.length === 0 && held.length === 0 && lookup === null && (
        <p className="tier-b home-empty" data-testid="reserve-empty">
          {text('reserve.empty')}
        </p>
      )}
      <div className="queue-lookup">
        <FormField
          label={text('reserve.lookupLabel')}
          hint={text('reserve.lookupHint')}
          error={lookupText.trim() !== '' && lookup === null ? text('sellerClaim.lookupInvalid') : null}
        >
          {(f) => (
            <input
              id={f.id}
              aria-describedby={f.describedBy}
              aria-invalid={f.invalid}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="12"
              value={lookupText}
              onChange={(e) => setLookupText(e.target.value)}
              data-testid="reserve-lookup"
            />
          )}
        </FormField>
        {lookupRow !== null && !reserveRowShown(lookupRow) && (
          <p className="tier-b" data-testid="reserve-lookup-nothing">
            {format('reserve.lookupNothing', { id: lookupRow.loanId.toString() })}
          </p>
        )}
      </div>
      <WhyLink summaryKey="reserve.whySummary" detailKey="reserve.why" />
    </section>
  );
}

/** One loan's reserve: what is reserved, whether an extension can still draw
 *  on it, and the withdrawal when the rule opens it. An open withdrawal stays
 *  drawn whatever the latest read. */
function ReserveCard({
  row,
  paused,
  frozen,
  readAt,
  own,
  chain,
  meta,
}: {
  row: ReserveRow;
  paused: boolean | null;
  frozen: FrozenState | undefined;
  readAt: number;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const flow = useReserveHeld(row.loanId);
  const id = row.loanId.toString();
  const words = reserveWords(meta, format);
  const panel = flow.held ? <ReserveWithdraw loanId={row.loanId} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} /> : null;
  const head = (
    <p className="row-head">
      <Link to={`/positions/${id}`}>{format('sellerClaim.loanHead', { id })}</Link>
    </p>
  );
  if (row.funding === null) {
    return (
      <li className="card" data-reserve-row={id}>
        {head}
        <p className="tier-a">{text('reserve.rowUnread')}</p>
        {panel}
      </li>
    );
  }
  const f = row.funding;
  const drawable = reserveDrawable(row, own.account);
  const verdict = reserveVerdict(row, paused, copy, readAt, frozen);
  return (
    <li className="card" data-reserve-row={id}>
      {head}
      <dl className="facts">
        <dt className="tier-b">{text('reserve.rowReserved')}</dt>
        <dd data-testid={`reserve-amount-${id}`}>{words.amount(f.asset, f.reserved, false)}</dd>
        {drawable === true && f.chargeAtGraceEnd > 0n && (
          <>
            <dt className="tier-b">{text('reserve.rowCharge')}</dt>
            <dd>{words.amount(f.asset, f.chargeAtGraceEnd, false)}</dd>
          </>
        )}
      </dl>
      <p className={drawable === null ? 'tier-a' : 'tier-b'} data-testid={`reserve-draw-${id}`} data-drawable={String(drawable)}>
        {text(drawable === true ? 'reserve.drawable' : drawable === false ? 'reserve.notDrawable' : 'reserve.drawUnread')}
      </p>
      {panel ?? (
        <>
          {verdict.state === 'open' && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => flow.setOpen(true)} data-testid={`reserve-withdraw-${id}`}>
                {text('reserve.action')}
              </button>
            </div>
          )}
          {verdict.state !== 'open' && (
            <p className={verdict.state === 'unknown' ? 'tier-a' : 'tier-b'} data-code={verdict.refusals[0]?.code}>
              {verdict.refusals[0]?.reason}
            </p>
          )}
        </>
      )}
    </li>
  );
}

/** The reserve withdrawals the store holds for this wallet, from the review
 *  each stored, so a withdrawal outlives the row that started it. */
function useHeldReserveFlows(identity: string | null): { loanId: bigint }[] {
  const store = useTxStore();
  const entries = useTxEntries();
  if (identity === null) return [];
  return entries.flatMap(([key]) => {
    if (!key.startsWith(RESERVE_KEY_PREFIX)) return [];
    const review = store.value<ReserveReview>(`${key}:review`);
    if (!review || review.identity !== identity || reserveKey(review.loanId) !== key) return [];
    return [{ loanId: review.loanId }];
  });
}

/** A loan the list no longer shows, drawn while its withdrawal is held so the
 *  progress and the finish card stay reachable until the reader closes them. */
function HeldReserveCard({ loanId, own, chain, meta }: { loanId: bigint; own: OwnStateClient; chain: SupportedChain; meta: TokenMetaMap | null }) {
  const { format } = useCopy();
  const flow = useReserveHeld(loanId);
  if (!flow.held) return null;
  return (
    <li className="card" data-reserve-row={loanId.toString()}>
      <p className="row-head">{format('sellerClaim.loanHead', { id: loanId.toString() })}</p>
      <ReserveWithdraw loanId={loanId} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} />
    </li>
  );
}
