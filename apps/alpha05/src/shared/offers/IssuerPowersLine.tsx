/**
 * #3433 — the issuer-power line under an asset: what the keeper's checker
 * found, what it could not tell, what it looked for and did not find, and
 * when, at which block. Nothing is shown until the index holds a run for the
 * asset, or when it cannot be read (the rankings line already says the index
 * is down). Never a claim that the asset is safe.
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

export function useIssuerPowers(chain: SupportedChain, asset: Hex) {
  const world = useWorldRail();
  const configured = world.indexer.origin !== null;
  const q = useQuery({
    queryKey: worldKey(chain.chainId, 'issuerPowers', asset.toLowerCase()),
    queryFn: () => readIssuerPowers(world.indexer, chain.chainId, asset),
    enabled: configured,
    staleTime: ISSUER_STALE_MS,
    retry: 1,
  });
  return q.data?.kind === 'checked' ? q.data.run : null;
}

export function IssuerPowersLine({ chain, asset, collection = false }: { chain: SupportedChain; asset: Hex; collection?: boolean }) {
  const run = useIssuerPowers(chain, asset);
  if (run === null) return null;
  return <IssuerRunView run={run} collection={collection} />;
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
