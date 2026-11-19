/**
 * #3435 — the "Unrecognised items" list: what reached the wallet's vault
 * outside the protocol, kept apart from the wallet's own assets and closed
 * by default. Each item is the token's contract address, its kind, the
 * protocol's uncounted figure, and what the token calls itself as plain
 * text, never a link, an image or rich text. The list says how far the
 * index has checked, or that it is still checking.
 *
 * The Vault page shows it with a link per item to Recover, and Recover shows
 * the same list to pick from; neither suggests adopting (the read and the
 * rules are `unrecognised.ts`).
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { worldKey } from '../reads/identityKey';
import { useOwnRead } from '../reads/useOwnRead';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatExact } from '../ui/format';
import { Notice } from '../ui/Notice';
import { arrivalKey, checkUnrecognised, readArrivals, type ArrivalsRead, type UnrecognisedItem } from './unrecognised';

type Hex = `0x${string}`;

/** How often the list is asked again while the index is still checking. */
const CHECKING_POLL_MS = 20_000;
/** How long after a "too many asks" answer the list is asked again. */
const BUSY_POLL_MS = 30_000;

/** The index's arrivals for the wallet's vault, and the chain's check of them. */
export function useUnrecognised(chain: SupportedChain, account: Hex) {
  const world = useWorldRail();
  const configured = world.indexer.origin !== null;
  const arrivals = useQuery<ArrivalsRead>({
    queryKey: worldKey(chain.chainId, 'vaultArrivals', account.toLowerCase()),
    queryFn: () => readArrivals(world.indexer, chain.chainId, account),
    enabled: configured,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.kind === 'busy') return BUSY_POLL_MS;
      return d?.kind === 'scan' && !d.scan.complete ? CHECKING_POLL_MS : false;
    },
    retry: 1,
  });
  const scan = arrivals.data?.kind === 'scan' ? arrivals.data.scan : null;
  const keys = scan ? scan.arrivals.map(arrivalKey) : [];
  const sig = scan ? `${scan.vault}:${scan.scannedToBlock}:${keys.length}:${keys[0] ?? ''}:${keys[keys.length - 1] ?? ''}` : '';
  const check = useOwnRead(['vault', 'unrecognised', chain.diamondAddress, sig], (c) => checkUnrecognised(c, chain.diamondAddress as Hex, account, scan!), {
    enabled: scan !== null,
  });
  return { configured, arrivals, scan, check };
}

export function UnrecognisedItems({
  chain,
  account,
  open = false,
  action,
  testId = 'unrecognised',
}: {
  chain: SupportedChain;
  account: Hex;
  /** Shown open (Recover's picker); the Vault page keeps it closed. */
  open?: boolean;
  /** What each item offers: a link on the Vault page, a pick on Recover. */
  action: (item: UnrecognisedItem) => ReactNode;
  testId?: string;
}) {
  const { text, format } = useCopy();
  const { configured, arrivals, scan, check } = useUnrecognised(chain, account);
  const items = check.data?.items ?? [];
  const checking = scan !== null && !scan.complete;

  let body: ReactNode;
  if (!configured) body = <p className="tier-a">{text('unrecognised.noIndex')}</p>;
  else if (arrivals.data?.kind === 'noVault') body = <p className="tier-b">{text('unrecognised.none')}</p>;
  else if (arrivals.data?.kind === 'busy') body = <p className="tier-b">{text('unrecognised.busy')}</p>;
  else if (arrivals.status === 'error' && arrivals.data === undefined) {
    const e = arrivals.error;
    const reason = e instanceof IndexerUnavailable || e instanceof Error ? e.message : String(e);
    body = (
      <Notice tone="warn" tier="A">
        {format('unrecognised.failed', { reason })}
      </Notice>
    );
  } else if (scan === null || (check.data === null && check.state !== 'failed')) body = <p className="tier-b">{text('vault.reading')}</p>;
  else if (check.data === null)
    body = (
      <Notice tone="warn" tier="A">
        {format('unrecognised.checkFailed', { reason: check.error ?? '' })}
      </Notice>
    );
  else if (check.data.vaultMismatch)
    body = (
      <Notice tone="warn" tier="A">
        {text('unrecognised.vaultMismatch')}
      </Notice>
    );
  else
    body = (
      <>
        <p className="tier-a">{text('unrecognised.lead')}</p>
        {items.length > 0 && (
          <Notice tone="warn" tier="A">
            {text('unrecognised.warning')}
          </Notice>
        )}
        {items.length === 0 && <p className="tier-b">{text(checking ? 'unrecognised.noneYet' : 'unrecognised.none')}</p>}
        {items.length > 0 && (
          <ul className="rows" data-testid={`${testId}-rows`}>
            {items.map((i) => (
              <ItemCard key={arrivalKey(i)} item={i} action={action(i)} />
            ))}
          </ul>
        )}
        {check.data.unread.length > 0 && <p className="tier-a">{format('unrecognised.unread', { count: String(check.data.unread.length) })}</p>}
        {scan.pruned && <p className="tier-a">{text('unrecognised.pruned')}</p>}
        {scan.pagesCut && <p className="tier-a">{format('unrecognised.pagesCut', { count: String(scan.arrivals.length) })}</p>}
      </>
    );

  const progress =
    scan === null ? null : checking ? (
      <p className="tier-a" data-testid={`${testId}-checking`}>
        {format('unrecognised.checking', { scanned: String(Math.max(scan.scannedToBlock, scan.scannedFromBlock - 1)), head: String(scan.headBlock) })}
      </p>
    ) : (
      <p className="tier-b" data-testid={`${testId}-checked`}>
        {format('unrecognised.checked', { block: String(scan.scannedToBlock) })}
      </p>
    );
  const count = String(items.length);
  return (
    <section className="home-section" aria-labelledby={`${testId}-title`} data-testid={testId} data-count={check.data ? count : undefined}>
      <h2 id={`${testId}-title`}>{text('unrecognised.title')}</h2>
      {items.length > 0 ? (
        <details open={open} data-testid={`${testId}-details`}>
          <summary>{format(checking ? 'unrecognised.summaryChecking' : 'unrecognised.summary', { count })}</summary>
          {body}
        </details>
      ) : (
        body
      )}
      {progress}
    </section>
  );
}

/** One item: what it is and what it says of itself, as plain text. */
function ItemCard({ item, action }: { item: UnrecognisedItem; action: ReactNode }) {
  const { text, format } = useCopy();
  const said = [item.symbol, item.name].filter((s): s is string => s !== null && s !== '');
  const figure =
    item.kind === 'erc20'
      ? format('unrecognised.amount', {
          amount: item.decimals === null ? format('unrecognised.baseUnits', { amount: item.untracked.toString() }) : formatExact(item.untracked, item.decimals),
        })
      : item.kind === 'erc1155'
        ? format('unrecognised.nftCopies', { count: item.untracked.toString(), id: (item.tokenId ?? 0n).toString() })
        : format('unrecognised.nftToken', { id: (item.tokenId ?? 0n).toString() });
  return (
    <li className="card" data-unrecognised={arrivalKey(item)}>
      <p className="row-head">{text(`unrecognised.kind_${item.kind}`)}</p>
      <p className="vault-asset-address">
        <code>{item.asset}</code>
      </p>
      <p className="tier-b" data-testid="unrecognised-says">
        {said.length > 0 ? `${text('unrecognised.calls')}: ${said.join(' · ')}` : text('unrecognised.noName')}
      </p>
      <p data-testid="unrecognised-figure">{figure}</p>
      <p className="tier-b">{format('unrecognised.firstSeen', { block: String(item.firstBlock) })}</p>
      {action}
    </li>
  );
}

