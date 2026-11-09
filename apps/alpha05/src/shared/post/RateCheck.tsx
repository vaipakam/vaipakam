import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { Notice } from '../ui/Notice';
import { WhyLink } from '../help/WhyLink';
import { formatBps } from '../ui/format';
import { useNow } from '../ui/useNow';
import { RATE_WINDOW_DAYS, medianBps, rateVerdict, readRecentRates } from './rateCheck';

type Hex = `0x${string}`;

/** Which way a far rate cuts: a lender under the market or a borrower over
 *  it is taken first; the other way the offer may sit untaken. */
function farKey(lender: boolean, above: boolean): CopyKey {
  if (lender) return above ? 'rateCheck.farIdleAbove' : 'rateCheck.farTakenBelow';
  return above ? 'rateCheck.farTakenAbove' : 'rateCheck.farIdleBelow';
}

/**
 * The rate warning under an offer's rate (#3357, RB-RATE-CHECK): the rate
 * typed so far beside the middle rate of recent loans on the same pair and
 * term. A rate more than five points away is a warning; a near one is a
 * note; no recent loans, NFT collateral or a failed read each say so, so a
 * missing comparison never reads as a clean one. It never blocks posting.
 */
export function RateCheck({
  lender,
  chain,
  lending,
  collateral,
  erc20Collateral,
  durationDays,
  rateBps,
}: {
  lender: boolean;
  chain: SupportedChain;
  lending: Hex;
  collateral: Hex;
  erc20Collateral: boolean;
  durationDays: bigint | null;
  rateBps: bigint | null;
}) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const nowSec = Math.floor(useNow() / 1000 / 3600) * 3600; // an hourly window edge keeps the query key stable
  const enabled = erc20Collateral && durationDays !== null && world.indexer.origin !== null;
  const recent = useQuery({
    queryKey: worldKey(chain.chainId, 'recentRates', lending.toLowerCase(), collateral.toLowerCase(), String(durationDays), nowSec),
    queryFn: () => readRecentRates(world.indexer, chain.chainId, lending, collateral, durationDays!, nowSec),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  if (!erc20Collateral)
    return (
      <p className="tier-b" data-testid="rate-check">
        {text('rateCheck.nft')}
      </p>
    );
  if (durationDays === null) return null;
  if (world.indexer.origin === null || recent.status === 'error') {
    const e = recent.error;
    const reason = e instanceof IndexerUnavailable ? e.message : world.indexer.origin === null ? text('rateCheck.noIndex') : ((e as Error | null)?.message ?? '');
    return (
      <p className="tier-b" data-testid="rate-check">
        {format('rateCheck.failed', { reason })}
      </p>
    );
  }
  if (recent.data === undefined)
    return (
      <p className="tier-b" data-testid="rate-check">
        {text('rateCheck.reading')}
      </p>
    );
  const days = String(RATE_WINDOW_DAYS);
  const capped = recent.data.capped ? ` ${format('rateCheck.capped', { count: String(recent.data.rates.length) })}` : '';
  const u = recent.data.unplaced;
  const unplaced = u.count === 0 ? '' : ` ${format(u.capped ? 'rateCheck.unplacedCapped' : 'rateCheck.unplaced', { count: String(u.count) })}`;
  const why = <WhyLink summaryKey="rateCheck.whySummary" detailKey="rateCheck.why" />;
  const median = medianBps(recent.data.rates);
  const v = rateBps === null ? null : rateVerdict(rateBps, recent.data.rates);
  if (median === null || v === null || v.kind !== 'far') {
    return (
      <div data-testid="rate-check">
        <p className="tier-b">
          {median === null ? format('rateCheck.none', { days }) : format('rateCheck.near', { median: formatBps(median), count: String(recent.data.rates.length), days }) + capped}
          {unplaced}
        </p>
        {why}
      </div>
    );
  }
  return (
    <div data-testid="rate-check" data-verdict="far">
      <Notice tone="warn" tier="A">
        {format(farKey(lender, v.above), { rate: formatBps(rateBps!), median: formatBps(v.median), count: String(v.count), days })}
        {capped}
        {unplaced}
      </Notice>
      {why}
    </div>
  );
}
