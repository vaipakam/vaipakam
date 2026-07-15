/**
 * #1247 (PAG-001…008) — the shared list-window pattern, extracted from
 * the Activity feed's proven shape: render `rows.slice(0, visible)`
 * with a "Show more" button growing the window by a page. Every
 * chain/indexer-fed list uses this so DOM size (and any per-row reads
 * mounted by row components) scales with what the user asked to see,
 * not with the data layer's 500–2000-row caps.
 *
 * The window RESETS when `resetKey` changes, SYNCHRONOUSLY (React's
 * adjust-state-during-render pattern): a post-commit effect would let
 * the changed list mount one full render at the previous expanded
 * count — hundreds of rows and their reads, exactly what the helper
 * exists to prevent (Codex #1265 r1). `resetKey` is REQUIRED and must
 * carry the list's identity (chain, wallet, filters as applicable) so
 * a wallet/chain switch on a mounted page collapses the window too.
 * Data-layer bounds stay where they are — this is the UI half of the
 * two-layer rule the audit doc records
 * (docs/FindingsAndFixes/Findings20260715-Alpha02PaginationAudit.md).
 */
import { useState } from 'react';
import { copy } from '../content/copy';

export const LIST_WINDOW_PAGE = 25;

export function useVisibleWindow<T>(
  rows: readonly T[],
  resetKey: unknown,
  page: number = LIST_WINDOW_PAGE,
) {
  const [visible, setVisible] = useState(page);
  const [prevKey, setPrevKey] = useState<unknown>(resetKey);
  if (!Object.is(prevKey, resetKey)) {
    // Render-phase reset: React discards this pass and re-renders
    // with the collapsed window before anything mounts.
    setPrevKey(resetKey);
    setVisible(page);
  }
  const hiddenCount = Math.max(0, rows.length - visible);
  return {
    shown: rows.slice(0, visible) as T[],
    hasMore: hiddenCount > 0,
    hiddenCount,
    /** What ONE click reveals — the button must not promise the whole
     *  remainder (Codex #1265 r1). */
    nextCount: Math.min(page, hiddenCount),
    loadMore: () => setVisible((v) => v + page),
  };
}

/** A `.row-list` that owns its window: renders the first page of
 *  `rows` and grows by a page per click. Self-contained so call sites
 *  inside conditional branches / plain helper functions don't need a
 *  hook of their own. */
export function WindowedRowList<T>({
  rows,
  render,
  resetKey,
}: {
  rows: readonly T[];
  render: (row: T) => React.ReactNode;
  /** REQUIRED list identity — chain, wallet, filters as applicable. */
  resetKey: unknown;
}) {
  const { shown, hasMore, hiddenCount, nextCount, loadMore } =
    useVisibleWindow(rows, resetKey);
  return (
    <>
      <div className="row-list">{shown.map(render)}</div>
      <ShowMoreButton
        hasMore={hasMore}
        hiddenCount={hiddenCount}
        nextCount={nextCount}
        onClick={loadMore}
      />
    </>
  );
}

/** The matching "Show N more" affordance — one look everywhere. The
 *  label states what the CLICK reveals; the total still hidden rides
 *  along when it's larger. */
export function ShowMoreButton({
  hasMore,
  hiddenCount,
  nextCount,
  onClick,
}: {
  hasMore: boolean;
  hiddenCount: number;
  nextCount: number;
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
      {copy.lists.showMore(nextCount, hiddenCount)}
    </button>
  );
}
