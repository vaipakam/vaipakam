import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Address } from 'viem';
import { useTokenMeta } from '../../lib/tokenMeta';
import { shortenAddr } from '../../lib/format';
import {
  useLenderIntentsByOwner,
  type OwnerLenderIntentSummary,
} from '../../hooks/useLenderIntentsByOwner';
import { TokenAmount } from './TokenAmount';
import { Pager } from './Pager';
import { CardInfo } from '../CardInfo';

const PAGE_SIZE = 10;

/** The (lendingAsset, collateralAsset) pair a "Manage" click hands back
 *  to the parent so it can deep-link the auto-lend card to that intent. */
export interface ManageIntentPair {
  lendingAsset: string;
  collateralAsset: string;
}

interface Props {
  /** Connected lender whose standing intents to list (null = no wallet). */
  owner: Address | null;
  /**
   * "Manage" deep-link. The list is read-only on purpose — every write
   * (pause / resume / fund / edit) runs through the one audited auto-lend
   * card, which enforces the ordered enable sequence (consent → keeper
   * delegation → registration → fund). This just selects the row's pair
   * into that card.
   */
  onManage: (pair: ManageIntentPair) => void;
  /**
   * Bumped by the parent after the auto-lend card mutates an intent
   * (pause / resume / fund / withdraw). Folded into the read's cache key so
   * the list refetches the freshly-changed Active/Paused/Funded values
   * instead of serving its 30s cache.
   */
  refreshSignal?: number;
}

/**
 * #755 — lists every standing lender-intent the connected wallet owns
 * across pairs, so a lender who runs more than one auto-lend intent can
 * see and reach all of them in one place. The single auto-lend card only
 * ever shows the pair currently picked in its asset selectors; this card
 * is the multi-intent overview that card can't be.
 *
 * Read-only by design (see {Props.onManage}); backed by the per-owner
 * enumeration `LenderIntentFacet.getLenderIntentsByOwner`, which — unlike
 * the owner-agnostic, funded-active-only global keeper feed — also returns
 * PAUSED intents (cancelled but still holding reserved capital), the ones
 * a lender most needs a way back to.
 *
 * Self-hides when the wallet has no intents at all (and isn't loading /
 * erroring), so it never adds clutter for users who don't auto-lend.
 */
export function MyLenderIntentsCard({
  owner,
  onManage,
  refreshSignal = 0,
}: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { rows, total, loading, error, reload } = useLenderIntentsByOwner(
    owner,
    page * PAGE_SIZE,
    PAGE_SIZE,
    refreshSignal,
  );

  // Keep `page` in range, via React's render-time "adjust state on prop
  // change" pattern (no effect → no set-state-in-effect). On an owner switch
  // snap to page 0; otherwise clamp when `total` shrank below the current
  // window (e.g. an intent was torn down while on a later page) — without
  // this the out-of-range offset returns rows=[] with total>0, hiding the
  // owner's real intents behind the empty-state with no Pager to escape.
  const [trackedOwner, setTrackedOwner] = useState(owner);
  if (owner !== trackedOwner) {
    setTrackedOwner(owner);
    if (page !== 0) setPage(0);
  } else {
    const lastPage = total > 0n ? Math.ceil(Number(total) / PAGE_SIZE) - 1 : 0;
    if (page > lastPage) setPage(lastPage);
  }

  // Nothing to manage and not mid-flight → render nothing.
  if (!owner) return null;
  if (!loading && !error && total === 0n) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div
        className="card-title"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t('myLenderIntents.title')}
          <CardInfo id="dashboard.my-lender-intents" />
        </span>
        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          {t('myLenderIntents.subtitle', { count: Number(total) })}
        </span>
      </div>

      {error ? (
        <div className="empty-state" style={{ marginTop: 8 }}>
          {t('myLenderIntents.loadError')}{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void reload();
            }}
          >
            {t('myLenderIntents.retry')}
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 8 }}>
          {t('myLenderIntents.loading')}
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 8 }}>
          {t('myLenderIntents.empty')}
        </div>
      ) : (
        <>
          <div className="loans-table-wrap">
            <table className="loans-table">
              <thead>
                <tr>
                  <th>{t('myLenderIntents.colPair')}</th>
                  <th>{t('myLenderIntents.colStatus')}</th>
                  <th>{t('myLenderIntents.colFunded')}</th>
                  <th>{t('myLenderIntents.colOnLoan')}</th>
                  <th>{t('myLenderIntents.colMaxExposure')}</th>
                  <th>{t('myLenderIntents.colMinRate')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <IntentRow
                    key={`${row.intent.lendingAsset}:${row.intent.collateralAsset}`}
                    row={row}
                    onManage={onManage}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            total={Number(total)}
            pageSize={PAGE_SIZE}
            page={page}
            onPageChange={setPage}
            unit={t('myLenderIntents.unit')}
          />
        </>
      )}
    </div>
  );
}

/** One intent row. A dedicated child so each row's two `useTokenMeta`
 *  symbol lookups stay hook-rule-clean (no hooks in a `.map`). */
function IntentRow({
  row,
  onManage,
}: {
  row: OwnerLenderIntentSummary;
  onManage: (pair: ManageIntentPair) => void;
}) {
  const { t } = useTranslation();
  const { intent, active } = row;
  const lendMeta = useTokenMeta(intent.lendingAsset);
  const collMeta = useTokenMeta(intent.collateralAsset);
  const lendSym = lendMeta?.symbol || shortenAddr(intent.lendingAsset);
  const collSym = collMeta?.symbol || shortenAddr(intent.collateralAsset);

  return (
    <tr style={active ? undefined : { opacity: 0.7 }}>
      <td>
        {lendSym} <span style={{ opacity: 0.6 }}>→</span> {collSym}
      </td>
      <td>
        <span className={`status-badge${active ? ' active' : ''}`}>
          {active
            ? t('myLenderIntents.statusActive')
            : t('myLenderIntents.statusPaused')}
        </span>
      </td>
      <td>
        <TokenAmount
          amount={intent.availableCapital}
          address={intent.lendingAsset}
          withSymbol
          compact
        />
      </td>
      <td>
        <TokenAmount
          amount={intent.livePrincipal}
          address={intent.lendingAsset}
          withSymbol
          compact
        />
      </td>
      <td>
        <TokenAmount
          amount={intent.maxExposure}
          address={intent.lendingAsset}
          compact
        />
      </td>
      <td>{(Number(intent.minRateBps) / 100).toFixed(2)}%</td>
      <td>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            onManage({
              lendingAsset: intent.lendingAsset,
              collateralAsset: intent.collateralAsset,
            })
          }
        >
          {t('myLenderIntents.manage')}
        </button>
      </td>
    </tr>
  );
}
