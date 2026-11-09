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
import { discoverSoldLoans, mineGross, mineNet, readPaused, readSellerRow, rowFeeBps, sellerRowShown, sellerVerdict, splitFinal, splitPart, type SellerRow } from './sellerClaim';
import type { SellerClaimReview } from './sellerClaimReview';
import type { FrozenState } from '../sanctions/posture';
import { SELLER_CLAIM_KEY_PREFIX, SellerClaim, sellerClaimKey, sellerWords, useSellerClaimHeld } from './SellerClaim';

/** How often the index is asked again for the wallet's sold loans. */
const DISCOVERY_POLL_MS = 60_000;

/**
 * Claims › Interest from positions you sold (LN-52): each loan whose lender
 * position this wallet sold while interest it earned was still unpaid. The
 * index names the loans (any step of a seller claim filed under this
 * wallet); each is then read from the chain as the withdrawal reads it, and
 * only the chain decides what is owed, what waits in the vault and whether
 * it pays now. A loan can also be looked up by its number, which reads the
 * chain alone, so a seller can reach their money when the index does not
 * answer. A withdrawal in progress stays on screen until its finish card is
 * closed, whatever the latest list says.
 */
export function SellerClaims({ own, chain, frozen }: { own: OwnStateClient; chain: SupportedChain; frozen?: FrozenState }) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const wallet = own.account;
  const diamond = chain.diamondAddress;
  const configured = world.indexer.origin !== null;
  const discovery = useQuery({
    queryKey: worldKey(chain.chainId, 'sellerLoans', wallet.toLowerCase()),
    queryFn: () => discoverSoldLoans(world.indexer, chain.chainId, wallet),
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
    ['seller', diamond, ids.join(',')],
    async (c) => {
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const [paused, list] = await Promise.all([readPaused(c, diamond, block), Promise.all(ids.map((id) => readSellerRow(c, diamond, id, wallet, block)))]);
      return { paused, list };
    },
    { enabled: ids.length > 0 },
  );
  const list = rows.data?.list ?? [];
  const shown = list.filter((r) => sellerRowShown(r, wallet));
  const drawn = new Set(shown.map((r) => r.loanId.toString()));
  const held = useHeldSellerFlows(reviewIdentity(own)).filter((h) => !drawn.has(h.loanId.toString()));
  const assets = list.flatMap((r) => [...(r.loan ? [r.loan.principalAsset] : []), ...(r.claimAsset ? [r.claimAsset] : [])]);
  const meta = useTokenMeta(assets).data;
  // A failed poll keeps the last list (TanStack holds the data), so a
  // failure is said whether or not a list is cached, and nothing is said
  // empty until discovery answers again.
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
    <section className="home-section" aria-labelledby="claims-seller">
      <h2 id="claims-seller">{text('sellerClaim.sectionTitle')}</h2>
      {ids.length > 0 && <OwnStamp reads={[rows]} />}
      {configured && discovery.data === undefined && discovery.status !== 'error' && <p className="tier-b">{text('sellerClaim.reading')}</p>}
      {discoveryFailed && (
        <p className="tier-a" data-testid="seller-failed">
          {format(configured && discoveryCached ? 'sellerClaim.discoveryStale' : 'sellerClaim.discoveryFailed', { reason: discoveryReason })}
        </p>
      )}
      {discovery.data?.complete === false && <p className="tier-a">{text('sellerClaim.discoveryIncomplete')}</p>}
      {rows.state === 'failed' && rows.data === null && <p className="tier-a">{format('sellerClaim.rowsFailed', { reason: rows.error ?? '' })}</p>}
      {shown.length + held.length > 0 && (
        <ul className="rows" data-testid="seller-rows">
          {shown.map((r) => (
            <SellerRowCard key={r.loanId.toString()} row={r} paused={rows.data?.paused ?? null} frozen={frozen} readAt={rows.readAt ?? 0} own={own} chain={chain} meta={meta} />
          ))}
          {held.map((h) => (
            <HeldSellerCard key={h.loanId.toString()} loanId={h.loanId} own={own} chain={chain} meta={meta} />
          ))}
        </ul>
      )}
      {settled && shown.length === 0 && held.length === 0 && lookup === null && (
        <p className="tier-b home-empty" data-testid="seller-empty">
          {text('sellerClaim.empty')}
        </p>
      )}
      <div className="queue-lookup">
        <FormField
          label={text('sellerClaim.lookupLabel')}
          hint={text('sellerClaim.lookupHint')}
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
              data-testid="seller-lookup"
            />
          )}
        </FormField>
        {lookupRow !== null && !sellerRowShown(lookupRow, wallet) && (
          <p className="tier-b" data-testid="seller-lookup-nothing">
            {format('sellerClaim.lookupNothing', { id: lookupRow.loanId.toString() })}
          </p>
        )}
      </div>
      <WhyLink summaryKey="sellerClaim.whySummary" detailKey="sellerClaim.why" />
    </section>
  );
}

/** One loan a past seller is owed interest on: what is owed, what waits in
 *  the vault, what an ended loan's split pays, and the withdrawal when the
 *  rule opens it. An open withdrawal stays drawn whatever the latest read. */
function SellerRowCard({
  row,
  paused,
  frozen,
  readAt,
  own,
  chain,
  meta,
}: {
  row: SellerRow;
  paused: boolean | null;
  frozen: FrozenState | undefined;
  readAt: number;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const wallet = own.account;
  const flow = useSellerClaimHeld(row.loanId);
  const id = row.loanId.toString();
  const words = sellerWords(meta, format);
  const panel = flow.held ? <SellerClaim loanId={row.loanId} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} /> : null;
  const head = (
    <p className="row-head">
      <Link to={`/positions/${id}`}>{format('sellerClaim.loanHead', { id })}</Link>
    </p>
  );
  if (row.loan === null || row.claims === null || row.held === null) {
    return (
      <li className="card" data-seller-row={id}>
        {head}
        <p className="tier-a">{text('sellerClaim.rowUnread')}</p>
        {panel}
      </li>
    );
  }
  const loan = row.loan;
  const mine = mineGross(row, wallet) ?? 0n;
  const owed = mineNet(row, wallet) ?? 0n;
  const fee = rowFeeBps(row)!;
  const final = splitFinal(Number(loan.status));
  const part = splitPart(row, wallet);
  const verdict = sellerVerdict(row, wallet, paused, copy, readAt, frozen);
  return (
    <li className="card" data-seller-row={id}>
      {head}
      <dl className="facts">
        {mine > 0n && (
          <>
            <dt className="tier-b">{format('sellerClaim.rowOwed', { pct: (fee.bps / 100).toString() })}</dt>
            <dd>{words.amount(loan.principalAsset, owed, false)}</dd>
          </>
        )}
        {row.held
          .filter((h) => h.amount > 0n)
          .map((h) => (
            <FactPair key={h.asset} label={text('sellerClaim.rowHeld')} value={words.amount(h.asset, h.amount, false)} />
          ))}
        {part?.kind === 'exact' && (
          <>
            <FactPair label={text('sellerClaim.rowSplit')} value={words.amount(loan.principalAsset, part.amount, false)} />
            {part.unpaid > 0n && <FactPair label={text('sellerClaim.rowUnpaid')} value={words.amount(loan.principalAsset, part.unpaid, false)} />}
          </>
        )}
        {part?.kind === 'inKind' && <FactPair label={text('sellerClaim.rowSplit')} value={text('sellerClaim.splitInKind')} />}
        {part?.kind === 'unknown' && <FactPair label={text('sellerClaim.rowSplit')} value={text('receipt.unknown')} />}
      </dl>
      {mine > 0n && <p className="tier-b">{text(final ? 'sellerClaim.endedNote' : 'sellerClaim.runningNote')}</p>}
      {panel ?? (
        <>
          {verdict.state === 'open' && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => flow.setOpen(true)} data-testid={`seller-withdraw-${id}`}>
                {text('sellerClaim.action')}
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

function FactPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="tier-b">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** The seller withdrawals the store holds for this wallet, from the review
 *  each stored: read from the store alone, so a withdrawal outlives the row
 *  that started it (a row the withdrawal emptied, a lookup since cleared, a
 *  list the index could not give). */
function useHeldSellerFlows(identity: string | null): { loanId: bigint }[] {
  const store = useTxStore();
  const entries = useTxEntries();
  if (identity === null) return [];
  return entries.flatMap(([key]) => {
    if (!key.startsWith(SELLER_CLAIM_KEY_PREFIX)) return [];
    const review = store.value<SellerClaimReview>(`${key}:review`);
    if (!review || review.identity !== identity || sellerClaimKey(review.loanId) !== key) return [];
    return [{ loanId: review.loanId }];
  });
}

/** A loan the list no longer shows, drawn while its withdrawal is held so the
 *  progress and the finish card stay reachable until the reader closes them. */
function HeldSellerCard({ loanId, own, chain, meta }: { loanId: bigint; own: OwnStateClient; chain: SupportedChain; meta: TokenMetaMap | null }) {
  const { format } = useCopy();
  const flow = useSellerClaimHeld(loanId);
  if (!flow.held) return null;
  return (
    <li className="card" data-seller-row={loanId.toString()}>
      <p className="row-head">{format('sellerClaim.loanHead', { id: loanId.toString() })}</p>
      <SellerClaim loanId={loanId} chain={chain} own={own} meta={meta} onClose={() => flow.setOpen(null)} />
    </li>
  );
}
