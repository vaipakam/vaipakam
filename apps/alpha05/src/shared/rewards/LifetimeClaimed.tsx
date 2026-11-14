import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { indexReason } from '../offers/OfferBook';
import { worldKey } from '../reads/identityKey';
import { matchesIdentity, subscribeOwnChanges } from '../reads/signals';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatUtc, formatUtcDate } from '../ui/format';
import { Notice } from '../ui/Notice';
import { readClaimedTotals } from './claimedTotals';

type Hex = `0x${string}`;

/** How often the lifetime totals are re-read while the tab is visible. */
export const LIFETIME_POLL_MS = 60_000;

/**
 * RW-31 — what the wallet has claimed on this network over its lifetime,
 * and the part recorded as delivered to its vault, from the index (the
 * world rail). Counted by the UTC day each claim was paid, whichever
 * destination it chose (RW-26), and stated with the moment the index has
 * recorded every claim up to. An index that cannot answer, or has not
 * recorded the network that far yet, is stated as such, never as zero.
 * A confirmed action of the wallet's own re-reads it at once.
 */
export function LifetimeClaimed({ chainId, chainName, account, amount }: { chainId: number; chainName: string; account: Hex; amount: (a: bigint) => string }) {
  const { text, format } = useCopy();
  const world = useWorldRail();
  const noIndex = world.indexer.origin === null;
  const totals = useQuery({
    queryKey: worldKey(chainId, 'rewardsClaimed', account.toLowerCase()),
    queryFn: () => readClaimedTotals(world.indexer, chainId, account),
    enabled: !noIndex,
    refetchInterval: LIFETIME_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: LIFETIME_POLL_MS / 2,
    retry: 1,
  });
  const { refetch } = totals;
  useEffect(
    () =>
      subscribeOwnChanges((s) => {
        if (matchesIdentity(s, chainId, account)) void refetch();
      }),
    [chainId, account, refetch],
  );

  const t = totals.data;
  let body;
  if (noIndex || (totals.status === 'error' && t === undefined)) {
    body = (
      <Notice tone="warn" tier="A">
        <span data-testid="rewards-lifetime" data-lifetime="failed">
          {format('rewards.lifetimeFailed', { reason: noIndex ? text('offerBook.noIndex') : indexReason(totals.error, text) })}
        </span>
      </Notice>
    );
  } else if (t === undefined) {
    body = <p className="tier-b">{text('rewards.lifetimeReading')}</p>;
  } else if (t.kind === 'pending') {
    body = (
      <Notice tone="warn" tier="A">
        <span data-testid="rewards-lifetime" data-lifetime={t.why}>
          {format(t.why === 'unrecorded' ? 'rewards.lifetimeUnrecorded' : 'rewards.lifetimeReplaying', { chain: chainName })}
        </span>
      </Notice>
    );
  } else {
    body = (
      <>
        <p
          className="tier-b"
          data-testid="rewards-lifetime"
          data-lifetime="recorded"
          data-claimed={t.claimed.toString()}
          data-vault={t.vaultDelivered.toString()}
        >
          {t.claimed === 0n
            ? format('rewards.lifetimeNone', { chain: chainName })
            : format('rewards.lifetime', { chain: chainName, amount: amount(t.claimed), vault: amount(t.vaultDelivered) })}
        </p>
        {t.lastClaimDay !== null && (
          <p className="tier-b">{format('rewards.lifetimeLast', { day: formatUtcDate(Date.parse(`${t.lastClaimDay}T00:00:00Z`) / 1000) })}</p>
        )}
        <p className="tier-b" data-testid="rewards-lifetime-asof">
          {format('rewards.lifetimeAsOf', { when: formatUtc(Math.floor(t.recordedBefore / 1000)) })}
        </p>
        {/* A figure kept from an earlier answer after a failed refresh is
            stated as such. */}
        {totals.status === 'error' && <p className="tier-b">{format('rewards.lifetimeKept', { reason: indexReason(totals.error, text) })}</p>}
      </>
    );
  }
  return (
    <>
      <h3>{text('rewards.lifetimeTitle')}</h3>
      {body}
      <WhyLink summaryKey="rewards.lifetimeHow" detailKey="rewards.lifetimeWhy" />
    </>
  );
}
