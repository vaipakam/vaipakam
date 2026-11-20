/**
 * #3433 — the issuer-power line under an asset: what the keeper's checker
 * found, what it could not tell, what it looked for and did not find, and
 * when, at which block. Nothing is shown while the index answers that it
 * holds no run for the asset. When the index cannot be read, a token's
 * rankings line already says so; an NFT collection has no such line, so this
 * one says the checks could not be read. Never a claim that the asset is safe.
 */
import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { worldKey } from '../reads/identityKey';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { isKnownCheck, readIssuerPowers, summarise, type IssuerRun } from './issuerPowers';

type Hex = `0x${string}`;

/** The checker writes once a day at most; an hour keeps a page fresh enough. */
const ISSUER_STALE_MS = 60 * 60 * 1000;

/** What the index said about an asset's issuer powers: a stored run, an
 *  affirmative "no run yet", or no answer (unreadable or no index). */
export type IssuerPowersRead = { kind: 'checked'; run: IssuerRun } | { kind: 'none' } | { kind: 'unread' } | { kind: 'reading' };

export function useIssuerPowers(chain: SupportedChain, asset: Hex): IssuerPowersRead {
  const world = useWorldRail();
  const configured = world.indexer.origin !== null;
  const q = useQuery({
    queryKey: worldKey(chain.chainId, 'issuerPowers', asset.toLowerCase()),
    queryFn: () => readIssuerPowers(world.indexer, chain.chainId, asset),
    enabled: configured,
    staleTime: ISSUER_STALE_MS,
    retry: 1,
  });
  if (q.data?.kind === 'checked') return { kind: 'checked', run: q.data.run };
  if (q.data !== undefined) return { kind: 'none' };
  if (!configured || q.isError) return { kind: 'unread' };
  return { kind: 'reading' };
}

export function IssuerPowersLine({ chain, asset, collection = false }: { chain: SupportedChain; asset: Hex; collection?: boolean }) {
  const { text } = useCopy();
  const read = useIssuerPowers(chain, asset);
  if (read.kind === 'checked') return <IssuerRunView run={read.run} collection={collection} />;
  if (read.kind === 'unread' && collection)
    return (
      <p className="tier-a" data-testid="issuer-check-unread">
        {text('trust.issuerUnread')}
      </p>
    );
  return null;
}

export function IssuerRunView({ run, collection }: { run: IssuerRun; collection: boolean }) {
  const { text, format } = useCopy();
  const s = summarise(run);
  const evidence = new Map(run.checks.map((c) => [c.check, c.evidence]));
  const label = (id: string) => {
    const base = isKnownCheck(id) ? text(`trust.check_${id}` as CopyKey) : format('trust.checkUnrecognised', { id });
    // A test transfer's own record says how it went; it is shown as given.
    const ev = id === 'conduit_transfer' ? evidence.get(id) : null;
    return ev ? `${base} (${ev})` : base;
  };
  const list = (ids: string[]) => ids.map(label).join('; ');
  const what = text(collection ? 'trust.issuerCollection' : 'trust.issuerToken');
  return (
    <div className="issuer-check" data-testid="issuer-check" data-found={s.found.join(',')} data-complete={String(run.complete)}>
      {s.canMoveOrFreeze ? (
        <Notice tone="warn" tier="A">
          {format('trust.issuerCan', { what, found: list(s.found) })}
        </Notice>
      ) : (
        s.found.length > 0 && (
          <Notice tone="warn" tier="A">
            {format('trust.issuerFound', { found: list(s.found) })}
          </Notice>
        )
      )}
      {s.unknown.length > 0 && <p className="tier-a">{format('trust.issuerUnknown', { unknown: list(s.unknown) })}</p>}
      {s.notFound.length > 0 && <p className="tier-b">{format('trust.issuerNotFound', { notFound: list(s.notFound) })}</p>}
      {!run.complete && <p className="tier-b">{run.detail ? format('trust.issuerIncomplete', { detail: run.detail }) : text('trust.issuerIncompleteBare')}</p>}
      <p className="tier-b">
        {format('trust.issuerAsOf', { date: formatUtc(run.checkedAt), block: String(run.blockNumber) })} {text('trust.issuerScope')}
      </p>
    </div>
  );
}
