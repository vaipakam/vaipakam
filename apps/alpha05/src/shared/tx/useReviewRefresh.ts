import { useEffect, useRef } from 'react';
import { useBlockNumber } from 'wagmi';
import { useVisible } from '../reads/useVisible';

/**
 * RB-RAILS: a review that gates an imminent money decision is read again
 * each block while it is on screen and nothing has been signed. A blocker
 * that clears lifts without reopening the panel; a change to the figures
 * replaces the review and clears the consent given against the old ones.
 *
 * One rule for every flow (taking an offer, posting a request), so that a
 * late answer can never land on the wrong review. A refresh's answer is
 * written only when
 *  - the panel that asked is still mounted,
 *  - the review is still on screen (signing has not started), and
 *  - the stored review is still about the same subject as the one the
 *    refresh started from (the reader has not opened another offer or a
 *    changed request meanwhile).
 * Otherwise it is dropped.
 */
export interface ReviewRefresh<R extends { readAt: number }> {
  chainId: number;
  /** The review is on screen and nothing has been signed. */
  active: boolean;
  review: R | null;
  /** Read the review again for the subject `before` stands for. */
  read: (before: R) => Promise<R>;
  /** Whether two reviews are about the same offer or request. */
  sameSubject: (a: R, b: R) => boolean;
  /** Whether anything the receipt stands on changed between the two reads. */
  changed: (before: R, next: R) => boolean;
  setReview: (next: (current: R | null) => R | null) => void;
  /** Called after a changed review replaced the stored one. */
  onChanged: () => void;
}

/** Whether the component is still mounted, for answers that arrive late. */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export function useReviewRefresh<R extends { readAt: number }>(o: ReviewRefresh<R>): void {
  const visible = useVisible();
  const head = useBlockNumber({ chainId: o.chainId, watch: o.active && visible, query: { enabled: o.active } });
  const mounted = useMounted();
  const activeNow = useRef(o.active);
  useEffect(() => {
    activeNow.current = o.active;
  }, [o.active]);

  const refreshing = useRef(false);
  useEffect(() => {
    if (!o.active || head.data === undefined || refreshing.current || o.review === null) return;
    const before = o.review;
    refreshing.current = true;
    o.read(before)
      .then(
        (next) => {
          if (!mounted.current || !activeNow.current) return;
          const changed = o.changed(before, next);
          let replaced = false;
          o.setReview((current) => {
            if (current === null || !o.sameSubject(current, before)) return current;
            replaced = true;
            // An unchanged read keeps the time the reader last saw new figures.
            return changed ? next : { ...next, readAt: before.readAt };
          });
          if (replaced && changed) o.onChanged();
        },
        // A failed refresh leaves the last review standing; Confirm re-reads.
        () => undefined,
      )
      .finally(() => {
        refreshing.current = false;
      });
    // The block number is the signal; the review read is taken as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head.data, o.active]);
}
