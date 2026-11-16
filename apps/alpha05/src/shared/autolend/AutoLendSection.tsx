import { useCopy } from '../copy/useCopy';
import { bpsPercent } from '../offers/priceGuard';
import { assetName, tokenAmount, useTokenMeta } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { autoLendState, readMyAutoLend, sortMyAutoLend } from './myAutoLend';

type Hex = `0x${string}`;

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
  const { rows, total, at } = read.data;
  if (rows.length === 0) return null;
  const amt = (v: bigint, a: Hex) => tokenAmount(v, a, meta, format);
  return (
    <section className="positions-section autolend-section" aria-labelledby="autolend-section-title" data-testid="autolend-section">
      <h2 id="autolend-section-title">{text('autoLend.sectionTitle')}</h2>
      <p className="tier-b">{text('autoLend.sectionLead')}</p>
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
              <p className="tier-b">{text('autoLend.cardManageSoon')}</p>
            </li>
          );
        })}
      </ul>
      {BigInt(rows.length) < total && <p className="tier-b">{format('autoLend.sectionMore', { shown: String(rows.length), total: total.toString() })}</p>}
    </section>
  );
}
