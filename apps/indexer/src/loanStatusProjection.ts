/**
 * The chain's `LoanStatus` enum → the row status the indexer stores.
 *
 * ONE definition, imported by both the event scanner (`chainIndexer.ts`) and
 * the reconciliation pass (`loanReconcile.ts`). It lived in the scanner with
 * a copy in the reconciler, pinned by a test that read `chainIndexer.ts` as
 * TEXT and compared the two — which #2190 round 3 was right to reject: two
 * production definitions make every future enum change depend on someone
 * remembering the second one, and a test that parses another module's source
 * is coupled to its formatting rather than its behaviour. The stated reason
 * for the copy was that importing would pull the whole scan module; that is
 * a module-boundary problem, and this file is the boundary.
 *
 * Append-only enum, so the slots are stable: Active=0, Repaid=1,
 * Defaulted=2, Settled=3, FallbackPending=4, InternalMatched=5.
 *
 * TWO DELIBERATE OMISSIONS, and they are the whole safety property:
 *
 *  - `Active(0)` and `FallbackPending(4)` are absent because neither is
 *    terminal. A partial match leaves the loan `Active`; a partial rescue
 *    leaves it `FallbackPending`. Both must produce a numbers-only refresh
 *    and never a status overwrite — and for the repair pass, both mean a
 *    node that is simply behind writes nothing at all.
 *  - an unknown future member falls through to `undefined`, so neither
 *    consumer ever writes a guessed status.
 */
export const LOAN_STATUS_TO_INDEXER_TERMINAL: Record<number, string> = {
  1: 'repaid',
  2: 'defaulted',
  3: 'settled',
  5: 'internal_matched',
};
