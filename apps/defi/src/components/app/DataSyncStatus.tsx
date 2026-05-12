/**
 * Compact "is the data on this page fresh?" indicator, sat next to a
 * page's Rescan button. Replaced the old "Last refreshed N ago" label —
 * which told you *when you last pulled*, not whether what you're seeing
 * is actually current (you can pull a 5-minute-stale indexer in 0.2 s).
 *
 * Reads the freshest block any data source on this page has reached
 * (`DataFreshnessContext.maxFrontier`) and the chain's safe head
 * (`WatermarkContext`):
 *   - gap ≤ CAUGHT_UP_GAP_BLOCKS  → "✓ Synced"  (green)
 *   - gap >  CAUGHT_UP_GAP_BLOCKS → "~N blocks behind"  (amber)
 * Renders nothing on local dev (block height is meaningless against an
 * instant-mining Anvil) or before either number is known.
 *
 * The top-bar `IndexerStatusBadge` is the detailed version (3-state
 * colour + popover with the block-space numbers); this is the
 * at-a-glance one right next to the action you'd take about it. The
 * threshold mirrors the badge's `CAUGHT_UP_GAP_BLOCKS`.
 */
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDataFreshness } from '../../context/DataFreshnessContext';
import { useWatermarkContext } from '../../context/WatermarkContext';
import { useReadChain } from '../../contracts/useDiamond';
import './DataSyncStatus.css';

const CAUGHT_UP_GAP_BLOCKS = 100;

export function DataSyncStatus() {
  const { t } = useTranslation();
  const chain = useReadChain();
  const { maxFrontier } = useDataFreshness();
  const { snapshot } = useWatermarkContext();

  const isLocalDev = chain.chainId === 31337 || chain.chainId === 1337;
  const safeHead =
    snapshot && snapshot.safeBlock > 0n ? Number(snapshot.safeBlock) : null;
  if (isLocalDev || maxFrontier === null || safeHead === null) return null;

  const gap = Math.max(0, safeHead - maxFrontier);
  const synced = gap <= CAUGHT_UP_GAP_BLOCKS;

  return (
    <span
      className={`data-sync-status ${synced ? 'data-sync-status--ok' : 'data-sync-status--behind'}`}
      title={
        synced
          ? t('common.syncedTooltip', {
              defaultValue: 'On-screen data is current with the chain.',
            })
          : t('common.blocksBehindTooltip', {
              defaultValue:
                'On-screen data trails the chain by about {{n}} blocks — it catches up automatically; Refresh to pull now.',
              n: gap.toLocaleString(),
            })
      }
    >
      {synced ? (
        <>
          <Check size={12} aria-hidden="true" />
          {t('common.synced', { defaultValue: 'Synced' })}
        </>
      ) : (
        t('common.blocksBehind', {
          defaultValue: '~{{n}} blocks behind',
          n: gap.toLocaleString(),
        })
      )}
    </span>
  );
}
