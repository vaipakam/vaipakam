import type { CopyKey } from '../copy/useCopy';
import { useCopy } from '../copy/useCopy';
import { bpsPercent } from '../offers/priceGuard';
import { assetName, tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { OwnStamp } from '../ui/OwnStamp';
import { autoLendState, readMyAutoLend, shareLentByAsset, sortMyAutoLend, type MyAutoLend, type AutoLendState } from './myAutoLend';
import { AutoLendManage, useManageOpen, useOpenManages, type OpenManage } from './AutoLendManage';
import { manageOffers, type ManageKind } from './manage';
import { AutoLendChange, useChangeOpen } from './AutoLendChange';
import { InstantSlotCard } from './InstantSlotCard';
import { CalmCheckCard } from './CalmCheckCard';
import { SlotHistoryCard } from './SlotHistoryCard';
import { WhyIntentPanel } from './WhyIntentPanel';
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
  const who = `${own?.chainId ?? ''}:${own?.account ?? ''}`;
  const opened = useOpenManages();
  if (read.state === 'reading' && read.data === null) return <p className="tier-b">{text('autoLend.sectionReading')}</p>;
  if (read.data === null) {
    return read.state === 'failed' ? <p className="tier-a">{format('autoLend.sectionFailed', { reason: read.error ?? '' })}</p> : null;
  }
  const { rows, total, at, posture } = read.data;
  const anyLending = rows.some((r) => autoLendState(r, at) === 'active');
  // A stop that takes back every coin tears the Auto-lend down, and the
  // protocol drops it from the wallet's list. Its open step (the finish
  // card, or a tracker still waiting) stays on screen until it is closed,
  // from the record kept with the panel, not with the list.
  const keyOf = (r: { lending: Hex; collateral: Hex; slot: number }) => `${r.lending.toLowerCase()}-${r.collateral.toLowerCase()}-${r.slot}`;
  const live = new Set(rows.map((r) => keyOf({ lending: r.intent.lendingAsset, collateral: r.intent.collateralAsset, slot: r.intent.slot })));
  const gone = opened.filter((o) => o.who === who && !live.has(keyOf(o)));
  const held = chain !== null && own !== null ? gone.map((o) => <HeldManage key={keyOf(o)} row={o} chain={chain} own={own} meta={meta ?? null} onDone={read.refetch} />) : [];
  if (rows.length === 0) return held.length === 0 ? null : <section className="positions-section autolend-section">{held}</section>;
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
      <ShareLentBlock rows={rows} at={at} total={total} amt={amt} meta={meta ?? null} />
      <ul className="card-list">
        {sortMyAutoLend(rows, at).map((r) => {
          const i = r.intent;
          const state = autoLendState(r, at);
          return (
            <li key={`${i.lendingAsset}-${i.collateralAsset}-${i.slot}`} className="card autolend-card" data-testid="autolend-card" data-state={state}>
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
              {chain !== null && <SlotHistoryCard intent={i} chain={chain} />}
              {chain !== null && own !== null && state === 'active' && <CalmCheckCard intent={i} chain={chain} own={own} meta={meta ?? null} />}
              {chain !== null && own !== null && state === 'active' && i.availableCapital > 0n && <WhyIntentPanel intent={i} chain={chain} own={own} />}
              {chain !== null && own !== null && <InstantSlotCard intent={i} active={state === 'active'} chain={chain} own={own} meta={meta ?? null} />}
              {chain !== null && own !== null && <ManageRow row={r} state={state} chain={chain} own={own} meta={meta ?? null} onDone={read.refetch} />}
            </li>
          );
        })}
      </ul>
      {held}
      {BigInt(rows.length) < total && <p className="tier-b">{format('autoLend.sectionMore', { shown: String(rows.length), total: total.toString() })}</p>}
    </section>
  );
}

/** The open step of an Auto-lend that has left the wallet's list (stopped
 *  with nothing set aside): its panel, until closed, then nothing. */
function HeldManage({ row, chain, own, meta, onDone }: { row: OpenManage; chain: SupportedChain; own: OwnStateClient; meta: TokenMetaMap | null; onDone: () => void }) {
  const { text, format } = useCopy();
  const { kind, open } = useManageOpen(row.lending, row.collateral, row.slot);
  if (kind === null) return null;
  return (
    <div className="card autolend-card" data-testid="autolend-card" data-state="gone">
      <h3>{format('autoLend.cardTitle', { lend: assetName(row.lending, meta), coll: assetName(row.collateral, meta) })}</h3>
      <p className="tier-b">{text('autoLend.cardGoneNote')}</p>
      <AutoLendManage
        kind={kind}
        lending={row.lending}
        collateral={row.collateral}
        slot={row.slot}
        unlent={row.unlent}
        chain={chain}
        own={own}
        meta={meta}
        onClose={() => {
          open(null);
          onDone();
        }}
      />
    </div>
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
  const { kind, open } = useManageOpen(i.lendingAsset, i.collateralAsset, i.slot, { who: `${own.chainId}:${own.account}`, unlent: i.availableCapital });
  const offers = manageOffers(row.active, state === 'ended', i.availableCapital);
  const [changing, setChanging] = useChangeOpen(i.lendingAsset, i.collateralAsset, i.slot);
  if (changing && kind === null)
    return (
      <AutoLendChange
        intent={i}
        restart={state === 'stopped'}
        chain={chain}
        own={own}
        meta={meta}
        onClose={() => {
          setChanging(false);
          onDone();
        }}
      />
    );
  if (kind !== null)
    return (
      <AutoLendManage
        kind={kind}
        lending={i.lendingAsset}
        collateral={i.collateralAsset}
        slot={i.slot}
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
  return (
    <p className="actions" data-testid="autolend-manage">
      {offers.map((k) => (
        <button key={k} type="button" className={k === 'stop' ? 'btn' : 'btn btn-primary'} onClick={() => open(k)} data-testid={`autolend-${k}`}>
          {text(MANAGE_BUTTON[k])}
        </button>
      ))}
      <button type="button" className="btn" onClick={() => setChanging(true)} data-testid="autolend-change">
        {text(state === 'stopped' ? 'autoLend.cStartLabel' : 'autoLend.cChangeLabel')}
      </button>
    </p>
  );
}

/** #3664 — per lending asset, how much of the money behind Auto-lend is out
 *  on loans and how much is waiting, with the waiting money a stopped or
 *  ended setting will not lend named on its own. */
function ShareLentBlock({ rows, at, total, amt, meta }: { rows: readonly MyAutoLend[]; at: bigint; total: bigint; amt: (v: bigint, a: Hex) => string; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const shares = shareLentByAsset(rows, at);
  if (shares.length === 0) return null;
  return (
    <div className="autolend-share" data-testid="autolend-share">
      <h3>{text('autoLend.shareTitle')}</h3>
      <ul className="autolend-share-list">
        {shares.map((s) => (
          <li key={s.lendingAsset} data-testid="autolend-share-row" data-asset={s.lendingAsset.toLowerCase()} data-share-bps={s.shareBps ?? ''}>
            <p>
              {format('autoLend.shareRow', {
                asset: assetName(s.lendingAsset, meta),
                share: s.shareBps === null ? '0%' : bpsPercent(s.shareBps),
                lent: amt(s.lent, s.lendingAsset),
                waiting: amt(s.waiting, s.lendingAsset),
              })}
            </p>
            {s.idle > 0n && (
              <p className="tier-a" data-testid="autolend-share-idle">
                {format('autoLend.shareIdle', { amount: amt(s.idle, s.lendingAsset) })}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="tier-a" data-testid="autolend-share-scope">
        {text('autoLend.shareScope')}
      </p>
      {BigInt(rows.length) < total && <p className="tier-b">{format('autoLend.sharePartial', { shown: String(rows.length), total: total.toString() })}</p>}
      <p className="tier-a">{text('autoLend.shareNote')}</p>
    </div>
  );
}
