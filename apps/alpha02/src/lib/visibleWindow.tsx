/**
 * #1247 (PAG-001…008) — the shared list-window pattern, extracted from
 * the Activity feed's proven shape: render `rows.slice(0, visible)`
 * with a "Show more" button growing the window by a page. Every
 * chain/indexer-fed list uses this so DOM size (and any per-row reads
 * mounted by row components) scales with what the user asked to see,
 * not with the data layer's 500–2000-row caps.
 *
 * The hook RESETS the window when `resetKey` changes (a filter/sort/
 * chain switch must not keep a deep window open over a different
 * list). Data-layer bounds stay where they are — this is the UI half
 * of the two-layer rule the audit doc records
 * (docs/FindingsAndFixes/Findings20260715-Alpha02PaginationAudit.md).
 */
import { useEffect, useState } from 'react';
import { copy } from '../content/copy';

export const LIST_WINDOW_PAGE = 25;

export function useVisibleWindow<T>(
  rows: readonly T[],
  resetKey: unknown = null,
  page: number = LIST_WINDOW_PAGE,
) {
  const [visible, setVisible] = useState(page);
  useEffect(() => {
    setVisible(page);
  }, [resetKey, page]);
  return {
    shown: rows.slice(0, visible) as T[],
    hasMore: rows.length > visible,
    hiddenCount: Math.max(0, rows.length - visible),
    loadMore: () => setVisible((v) => v + page),
  };
}

/** A `.row-list` that owns its window: renders the first page of
 *  `rows` and grows by a page per click. Self-contained so call sites
 *  inside conditional branches / plain helper functions don't need a
 *  hook of their own. `resetKey` collapses the window when the list's
 *  identity changes (filter, sort, chain). */
export function WindowedRowList<T>({
  rows,
  render,
  resetKey = null,
}: {
  rows: readonly T[];
  render: (row: T) => React.ReactNode;
  resetKey?: unknown;
}) {
  const { shown, hasMore, hiddenCount, loadMore } = useVisibleWindow(
    rows,
    resetKey,
  );
  return (
    <>
      <div className="row-list">{shown.map(render)}</div>
      <ShowMoreButton
        hasMore={hasMore}
        hiddenCount={hiddenCount}
        onClick={loadMore}
      />
    </>
  );
}

/** The matching "Show N more" affordance — one look everywhere. */
export function ShowMoreButton({
  hasMore,
  hiddenCount,
  onClick,
}: {
  hasMore: boolean;
  hiddenCount: number;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <button
      type="button"
      className="btn btn-secondary"
      style={{ marginTop: 12 }}
      onClick={onClick}
    >
      {copy.lists.showMore(hiddenCount)}
    </button>
  );
}
