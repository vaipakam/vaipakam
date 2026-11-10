/**
 * #3446 — a token's trust tier beside the pair picker, and the token search
 * that lists ranked tokens by name or symbol with their full address
 * (RB-ASSET-TRUST). The rule is `trust.ts`; this file only reads and says.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { useAssetStandard } from '../nft/useStandard';
import { useChainRead } from '../reads/chainRead';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import {
  classifyAsset,
  listAge,
  oldestList,
  rankTier,
  readAssetRankings,
  readPriced,
  searchRanked,
  type AssetRankings,
  type RankTier,
  type RankingSource,
} from './trust';

type Hex = `0x${string}`;

/** The lists change once a day; an hour's cache matches the route's. */
const RANKINGS_STALE_MS = 60 * 60_000;

/** One network's rankings, read from the index when this build has one. */
export function useAssetRankings(chain: SupportedChain) {
  const world = useWorldRail();
  const configured = world.indexer.origin !== null;
  const q = useQuery({
    queryKey: worldKey(chain.chainId, 'assetRankings'),
    queryFn: () => readAssetRankings(world.indexer, chain.chainId),
    enabled: configured,
    staleTime: RANKINGS_STALE_MS,
    retry: 1,
  });
  return {
    rankings: q.data ?? null,
    failed: !configured || q.status === 'error',
    error: configured ? q.error : null,
    reading: configured && q.data === undefined && q.status !== 'error',
  };
}

const TIER_KEY: Record<RankTier, CopyKey> = {
  blueChip: 'trust.tierBlueChip',
  top100: 'trust.tierTop100',
  top200: 'trust.tierTop200',
  top300: 'trust.tierTop300',
  top500: 'trust.tierTop500',
};

/** Which of the two lists, by its place, never by the provider's name. */
const LIST_KEY: Record<RankingSource, CopyKey> = { cg: 'trust.listOne', cp: 'trust.listTwo' };

/** The date a statement rests on, and a later failed refresh when there is one. */
function AgeLine({ rankings, source }: { rankings: AssetRankings; source: RankingSource | null }) {
  const { format, text } = useCopy();
  const s = source ?? oldestList(rankings)?.source ?? null;
  const age = s ? listAge(rankings, s) : null;
  if (!age || !s) return null;
  if (age.failedAt !== null)
    return (
      <Notice tone="warn" tier="A">
        {format('trust.refreshFailed', { list: text(LIST_KEY[s]), date: formatUtc(age.asOf), failed: formatUtc(age.failedAt) })}
      </Notice>
    );
  return <p className="tier-b">{format('trust.asOf', { list: text(LIST_KEY[s]), date: formatUtc(age.asOf) })}</p>;
}

/** The trust line for a chosen ERC-20 (an NFT collection has none yet). */
export function AssetTrustLine({ asset, chain, meta, testToken }: { asset: Hex; chain: SupportedChain; meta: TokenMetaMap | null; testToken: boolean }) {
  const std = useAssetStandard(asset);
  if (std.data !== 'erc20') return null;
  return <TrustFor asset={asset} chain={chain} meta={meta} testToken={testToken} />;
}

function TrustFor({ asset, chain, meta, testToken }: { asset: Hex; chain: SupportedChain; meta: TokenMetaMap | null; testToken: boolean }) {
  const { text, format } = useCopy();
  const { rankings, failed, error, reading } = useAssetRankings(chain);
  const priced = useChainRead(['priced', chain.diamondAddress, asset.toLowerCase()], (c) => readPriced(c, chain.diamondAddress, asset));
  const tokenName = useChainRead(['tokenName', asset.toLowerCase()], (c) => c.readContract({ address: asset, abi: erc20Abi, functionName: 'name' }), {
    immutable: true,
  });
  const name = assetName(asset, meta);
  const why = (summaryKey: CopyKey, vars: Record<string, string>) => <WhyLink summaryKey={summaryKey} detailKey="trust.why" vars={vars} />;
  const wrap = (kind: string, body: ReactNode) => (
    <div className="asset-trust" data-testid="asset-trust" data-trust={kind}>
      {body}
    </div>
  );

  if (testToken) return wrap('test', why('trust.test', { asset: name }));
  if (failed || rankings === null) {
    if (reading) return wrap('reading', <p className="tier-b">{text('trust.reading')}</p>);
    const reason = error instanceof IndexerUnavailable ? error.message : error ? (error as Error).message : text('trust.noIndex');
    return wrap(
      'failed',
      <Notice tone="warn" tier="A">
        {format('trust.failed', { asset: name, reason })}
      </Notice>,
    );
  }
  const symbol = meta?.[asset.toLowerCase()]?.symbol ?? null;
  const t = classifyAsset({
    address: asset,
    rankings,
    testnet: chain.testnet,
    testToken,
    priced: priced.state === 'ready' ? priced.data : null,
    symbol,
    name: tokenName.state === 'ready' ? (tokenName.data as string) : null,
  });
  switch (t.kind) {
    case 'test':
      return wrap('test', why('trust.test', { asset: name }));
    case 'testNetwork':
      return wrap('testNetwork', why('trust.testNetwork', { chain: chain.name }));
    case 'noList':
      return wrap(
        'noList',
        <Notice tone="warn" tier="A">
          {format('trust.noList', { asset: name, chain: chain.name })}
        </Notice>,
      );
    case 'ranked':
      return wrap(
        t.tier,
        <>
          <p>
            <span className="badge trust-badge" data-tier={t.tier}>
              {text(TIER_KEY[t.tier])}
            </span>
          </p>
          {why(t.tier === 'blueChip' ? 'trust.blueChip' : 'trust.ranked', {
            asset: name,
            rank: String(t.best.rank),
            chain: chain.name,
            tier: text(TIER_KEY[t.tier]),
          })}
          {t.tier !== 'blueChip' && t.best.rank <= 20 && priced.state === 'failed' && <p className="tier-b">{text('trust.pricedUnread')}</p>}
          <AgeLine rankings={rankings} source={t.best.source} />
        </>,
      );
    case 'unverified':
      return wrap(
        'unverified',
        <>
          <Notice tone="danger" tier="A">
            {format('trust.unverified', { symbol: t.best.symbol, chain: chain.name, address: asset, other: t.other.address })}
          </Notice>
          <AgeLine rankings={rankings} source={t.best.source} />
        </>,
      );
    case 'copy':
      return wrap(
        'copy',
        <>
          <Notice tone="danger" tier="A">
            {format('trust.copy', { asset: name, ranked: `${t.of.symbol} (${t.of.name})`, rank: String(t.of.rank), address: t.of.address })}
          </Notice>
          <AgeLine rankings={rankings} source={t.of.source} />
        </>,
      );
    case 'unranked':
      return wrap(
        'unranked',
        <>
          <Notice tone="warn" tier="A">
            {format('trust.unranked', { asset: name, chain: chain.name })}
          </Notice>
          <AgeLine rankings={rankings} source={null} />
        </>,
      );
  }
}

/** Ranked tokens matching what the reader typed, best rank first, each with
 *  its full address; a suggested token matching by symbol follows with its
 *  own label. Picking one fills the address; nothing is trusted by name. */
export function TokenSearch({
  query,
  chain,
  suggested,
  meta,
  onPick,
}: {
  query: string;
  chain: SupportedChain;
  suggested: readonly { address: Hex; test: boolean }[];
  meta: TokenMetaMap | null;
  onPick: (address: string) => void;
}) {
  const { text, format } = useCopy();
  const { rankings, failed, reading } = useAssetRankings(chain);
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  const hits = rankings ? searchRanked(rankings, q) : [];
  const ranked = new Set(hits.map((h) => h.address));
  const local = suggested.filter((s) => !ranked.has(s.address.toLowerCase()) && (meta?.[s.address.toLowerCase()]?.symbol ?? '').toLowerCase().includes(q));
  return (
    <div className="token-search" data-testid="token-search">
      {reading && <p className="tier-b">{text('trust.reading')}</p>}
      {failed && <p className="tier-b">{text('trust.searchUnavailable')}</p>}
      {hits.length + local.length > 0 && (
        <ul className="token-hits">
          {hits.map((h) => (
            <li key={h.address}>
              <button type="button" className="token-hit" data-testid="token-hit" onClick={() => onPick(h.address)}>
                <span className="token-hit-name">
                  {h.best.symbol} · {h.best.name}{' '}
                  <span className="badge">{format('trust.hitTier', { tier: text(TIER_KEY[rankTier(h.best.rank, null)]), rank: String(h.best.rank) })}</span>
                </span>
                <span className="token-hit-address">{h.address}</span>
              </button>
            </li>
          ))}
          {local.map((s) => (
            <li key={s.address}>
              <button type="button" className="token-hit" data-testid="token-hit" onClick={() => onPick(s.address)}>
                <span className="token-hit-name">
                  {assetName(s.address, meta)} <span className="badge">{text(s.test ? 'borrow.testBadge' : 'trust.hitUnranked')}</span>
                </span>
                <span className="token-hit-address">{s.address}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!reading && !failed && hits.length + local.length === 0 && <p className="tier-b">{format('trust.noHits', { chain: chain.name })}</p>}
    </div>
  );
}
