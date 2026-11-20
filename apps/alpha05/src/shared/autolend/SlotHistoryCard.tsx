import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import type { IntentSummary } from '../offers/intents';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatBps, formatUtcDate } from '../ui/format';
import { readSlotHistory, type LentShare, type SlotRates } from './slotHistory';

const SHARE_REASON: Record<Extract<LentShare, { available: false }>['reason'], CopyKey> = {
  'no-record-at-period-start': 'slotHistory.shareNoRecord',
  'unreadable-record': 'slotHistory.shareUnreadable',
  'record-too-long': 'slotHistory.shareTooLong',
};

function ShareLine({ share }: { share: LentShare }) {
  const { text, format } = useCopy();
  const period = { from: formatUtcDate(share.periodStart), to: formatUtcDate(share.periodEnd) };
  if (!share.available) return <p className="tier-b" data-testid="slot-history-share" data-available="false">{format('slotHistory.shareUnavailable', { ...period, reason: text(SHARE_REASON[share.reason]) })}</p>;
  if (share.shareBps === null) return <p className="tier-b" data-testid="slot-history-share" data-available="true">{format('slotHistory.shareNothingBehind', period)}</p>;
  return (
    <p className="tier-b" data-testid="slot-history-share" data-available="true">
      {format('slotHistory.share', { ...period, share: formatBps(BigInt(share.shareBps)) })}
    </p>
  );
}

function RatesLines({ rates }: { rates: SlotRates }) {
  const { text, format } = useCopy();
  const c = rates.comparison;
  const x = rates.excluded;
  const left = x.selfLoans + x.belowMinimumFill + x.partiesUnknown;
  return (
    <div data-testid="slot-history-rates" data-enough={String(c.enough)}>
      {c.enough ? (
        <>
          <p className="tier-b">
            {format('slotHistory.range', { low: formatBps(c.lowestBps), high: formatBps(c.highestBps), loans: String(c.loanCount), borrowers: String(c.borrowerCount) })}
          </p>
          <p className="tier-b">{format('slotHistory.half', { rate: formatBps(c.halfAmountBps) })}</p>
        </>
      ) : (
        <p className="tier-b">{format('slotHistory.notEnough', { loans: String(rates.minLoans), borrowers: String(rates.minBorrowers) })}</p>
      )}
      <p className="tier-b">{format('slotHistory.yourMinimum', { rate: formatBps(rates.slotMinimumBps) })}</p>
      {left > 0 && <p className="tier-b">{format('slotHistory.leftOut', { count: String(left) })}</p>}
      {rates.truncated && <p className="tier-b">{text('slotHistory.truncated')}</p>}
    </div>
  );
}

/**
 * On an Auto-lend, its record from the index: how much of the period its
 * capital was out on loans, and the rates comparable loans were agreed at
 * beside its own minimum. Labelled as past loans, never a forecast, and it
 * never suggests a rate. Every missing figure says why it is missing.
 */
export function SlotHistoryCard({ intent, chain }: { intent: IntentSummary; chain: SupportedChain }) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const ref = { chainId: chain.chainId, owner: intent.owner, lendingAsset: intent.lendingAsset, collateralAsset: intent.collateralAsset, slot: intent.slot };
  const read = useQuery({
    queryKey: worldKey(chain.chainId, 'slotHistory', intent.owner.toLowerCase(), intent.lendingAsset.toLowerCase(), intent.collateralAsset.toLowerCase(), intent.slot),
    queryFn: () => readSlotHistory(world.indexer, ref),
    enabled: world.indexer.origin !== null,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  let body;
  if (world.indexer.origin === null) body = <p className="tier-b">{text('slotHistory.noIndex')}</p>;
  else if (read.status === 'error') {
    const reason = read.error instanceof IndexerUnavailable ? read.error.message : (read.error as Error).message;
    body = <p className="tier-b">{format('slotHistory.failed', { reason })}</p>;
  } else if (read.data === undefined) body = <p className="tier-b">{text('slotHistory.reading')}</p>;
  else if (read.data.kind === 'not-indexed') body = <p className="tier-b">{text('slotHistory.notIndexed')}</p>;
  else
    body = (
      <>
        <ShareLine share={read.data.history.lentShare} />
        <RatesLines rates={read.data.history.rates} />
      </>
    );
  return (
    <div className="autolend-history" data-testid="slot-history">
      <p className="tier-a">{text('slotHistory.title')}</p>
      {body}
    </div>
  );
}
