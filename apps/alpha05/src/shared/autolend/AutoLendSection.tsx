import type { CopyKey } from '../copy/useCopy';
import { useCopy } from '../copy/useCopy';
import { bpsPercent } from '../offers/priceGuard';
import { assetName, tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { OwnStamp } from '../ui/OwnStamp';
import { autoLendState, readMyAutoLend, sortMyAutoLend, type MyAutoLend, type AutoLendState } from './myAutoLend';
import { AutoLendManage, useManageOpen } from './AutoLendManage';
import { manageOffers, type ManageKind } from './manage';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import type { TokenMetaMap } from '../reads/tokens';

type Hex = `0x${string}`;

const POSTURE_TEXT = {
  halted: 'autoLend.postureHalted',
  off: 'autoLend.postureOff',
  'service-paused': 'autoLend.postureServicePaused',
  unknown: 'autoLend.postureUnknown',
} as const;

/**
 * #3624 — the wallet's Auto-lend on Positions: one card per pair, with where
 * it stands (lending, ended by its date, stopped), the money waiting to be
 * lent, the money lent now, and every limit. Shown only when the wallet has
 * one. It signs nothing yet: adding money, taking it back, changing limits
 * and stopping come in the next update, and the card says so.
 */
export function AutoLendSection() {
  const { text, format } = useCopy();
  const own = useOwnStateClient();
  const chain = own ? getSupportedChain(own.chainId) : null;
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const read = useOwnRead(['autolend', 'mine'], (c) => readMyAutoLend(c, diamond, own!.account), { enabled: chain !== null });
  const assets = (read.data?.rows ?? []).flatMap((r) => [r.intent.lendingAsset, r.intent.collateralAsset]);
  const meta = useTokenMeta(assets).data;
  if (read.state === 'reading' && read.data === null) return <p className="tier-b">{text('autoLend.sectionReading')}</p>;
  if (read.data === null) {
    return read.state === 'failed' ? <p className="tier-a">{format('autoLend.sectionFailed', { reason: read.error ?? '' })}</p> : null;
  }
  const { rows, total, at, posture } = read.data;
  const anyLending = rows.some((r) => autoLendState(r, at) === 'active');
  if (rows.length === 0) return null;
  const amt = (v: bigint, a: Hex) => tokenAmount(v, a, meta, format);
  return (
    <section className="positions-section autolend-section" aria-labelledby="autolend-section-title" data-testid="autolend-section">
      <h2 id="autolend-section-title">{text('autoLend.sectionTitle')}</h2>
      <p className="tier-b">{text('autoLend.sectionLead')}</p>
      <OwnStamp reads={[read]} />
      {read.error !== null && (
        <p className="tier-a" data-testid="autolend-stale">
          {format('autoLend.sectionStale', { reason: read.error })}
        </p>
      )}
      {anyLending && posture !== 'on' && (
        <p className="tier-a" data-testid="autolend-posture" data-posture={posture}>
          {text(POSTURE_TEXT[posture])}
        </p>
      )}
      <ul className="card-list">
        {sortMyAutoLend(rows, at).map((r) => {
          const i = r.intent;
          const state = autoLendState(r, at);
          return (
            <li key={`${i.lendingAsset}-${i.collateralAsset}`} className="card autolend-card" data-testid="autolend-card" data-state={state}>
              <h3>{format('autoLend.cardTitle', { lend: assetName(i.lendingAsset, meta), coll: assetName(i.collateralAsset, meta) })}</h3>
              <p className="tier-a">{text(state === 'active' ? 'autoLend.stateActive' : state === 'ended' ? 'autoLend.stateEnded' : 'autoLend.stateStopped')}</p>
              <p>{format('autoLend.cardUnlent', { amount: amt(i.availableCapital, i.lendingAsset) })}</p>
              <p>{format('autoLend.cardLent', { amount: amt(i.livePrincipal, i.lendingAsset) })}</p>
              {i.livePrincipal > 0n && <p className="tier-b">{text('autoLend.cardLentWhy')}</p>}
              <p className="tier-b">{format('autoLend.cardCap', { amount: amt(i.maxExposure, i.lendingAsset) })}</p>
              <p className="tier-b">
                {format('autoLend.cardTerms', { rate: bpsPercent(Number(i.minRateBps)), ltv: bpsPercent(Number(i.maxInitLtvBps)), days: String(i.maxDurationDays) })}
              </p>
              <p className="tier-b">{format('autoLend.cardMinFill', { amount: amt(i.minFillAmount, i.lendingAsset) })}</p>
              <p className="tier-b">
                {i.lendUntil === 0n ? text('autoLend.cardNoUntil') : format('autoLend.cardUntil', { date: new Date(Number(i.lendUntil) * 1000).toLocaleString() })}
              </p>
              {i.acceptsProRata && <p className="tier-b">{text('autoLend.cardProRata')}</p>}
              {state === 'ended' && <p className="tier-a">{text('autoLend.cardEndedNote')}</p>}
              {state === 'stopped' && <p className="tier-a">{text('autoLend.cardStoppedNote')}</p>}
              {chain !== null && own !== null && <ManageRow row={r} state={state} chain={chain} own={own} meta={meta ?? null} onDone={read.refetch} />}
              <p className="tier-b">{text('autoLend.cardChangeSoon')}</p>
            </li>
          );
        })}
      </ul>
      {BigInt(rows.length) < total && <p className="tier-b">{format('autoLend.sectionMore', { shown: String(rows.length), total: total.toString() })}</p>}
    </section>
  );
}

const MANAGE_BUTTON: Record<ManageKind, CopyKey> = { add: 'autoLend.mAddLabel', takeBack: 'autoLend.mTakeBackLabel', stop: 'autoLend.mStopLabel' };

/** One card's management: the steps that fit where it stands, and the open
 *  step's panel, kept open while its transaction is in flight. */
function ManageRow({
  row,
  state,
  chain,
  own,
  meta,
  onDone,
}: {
  row: MyAutoLend;
  state: AutoLendState;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onDone: () => void;
}) {
  const { text } = useCopy();
  const i = row.intent;
  const { kind, open } = useManageOpen(i.lendingAsset, i.collateralAsset);
  const offers = manageOffers(row.active, state === 'ended', i.availableCapital);
  if (kind !== null)
    return (
      <AutoLendManage
        kind={kind}
        lending={i.lendingAsset}
        collateral={i.collateralAsset}
        unlent={i.availableCapital}
        chain={chain}
        own={own}
        meta={meta}
        onClose={() => {
          open(null);
          onDone();
        }}
      />
    );
  if (offers.length === 0) return null;
  return (
    <p className="actions" data-testid="autolend-manage">
      {offers.map((k) => (
        <button key={k} type="button" className={k === 'stop' ? 'btn' : 'btn btn-primary'} onClick={() => open(k)} data-testid={`autolend-${k}`}>
          {text(MANAGE_BUTTON[k])}
        </button>
      ))}
    </p>
  );
}
