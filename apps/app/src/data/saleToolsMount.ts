/**
 * What the lender's Advanced sale tools render, and therefore whether the
 * exit chooser's sale rows have anything to jump to (#1841, Codex #3024
 * r2, r4, r5).
 *
 * The chooser's rows and the tool block below them must answer one
 * question one way: a row that opens while the block renders nothing
 * offers a jump to an anchor that is not on the page. The block's render
 * gates were restated beside the chooser one at a time — the status gate,
 * then the listing gate, then maturity — and each restatement left the
 * next one out. This is the single derivation both read: the block renders
 * by switching on `saleToolsMount`, and the chooser's `saleTools` is
 * `saleToolsAvailability` over the same answer, so a new render gate
 * cannot reach one without the other.
 *
 * Pure: the page passes in what its reads say, and the case table in
 * `saleToolsMount.test.ts` pins the order.
 */
import type { SaleToolsState } from './lenderExitRows';

/** One read's state as these gates consume it. `ready` means it answered
 *  and its latest fetch did not fail: TanStack keeps the last success
 *  through a failed refetch, and a cached answer behind a failure is not
 *  a basis for either surface (Codex r16, r19, r20). */
export interface GateRead {
  ready: boolean;
  failed: boolean;
}

export interface SaleToolsMountInput {
  /** The block's own visibility gates that the chooser handles by other
   *  means: the viewer holds the lender position, has not sold it in this
   *  visit, the loan is not a rental, and the wallet is not flagged. */
  shown: boolean;
  /** `saleAttemptable`: the loan is open enough for a sale to be tried. */
  saleAttemptable: boolean;
  /** The principal's token metadata. */
  principal: GateRead;
  /** The sanctions screen has answered. */
  sanctionsReady: boolean;
  /** The Advanced loan read (`loanLive`). */
  loanLive: GateRead;
  /** A live sale listing stands (`salePending`): the pending card owns
   *  the lender's exit, and the block renders nothing. */
  salePending: boolean;
  /** The chain-anchored clock has reached the loan's end. Read only once
   *  `loanLive` is ready; `undefined` before that. */
  matured: boolean | undefined;
  /** The fee-entitlement read: the Full-plan disclosure both forms wait
   *  for. */
  feeEnt: GateRead;
}

export type SaleToolsMount =
  /** The block is not on the page. */
  | { kind: 'absent' }
  /** The block's stand-in card: a read it needs is outstanding or failed. */
  | { kind: 'reading'; failed: boolean }
  /** A listing stands; the pending card below speaks instead. */
  | { kind: 'listing' }
  /** The loan has reached its end; no sale tool renders. */
  | { kind: 'matured' }
  /** The fee-plan disclosure is outstanding or failed; the forms wait. */
  | { kind: 'disclosure'; failed: boolean }
  /** Both forms are mounted, with their anchors. */
  | { kind: 'tools' };

/** What the Advanced block renders, gate by gate in the order it checks
 *  them. */
export function saleToolsMount(i: SaleToolsMountInput): SaleToolsMount {
  if (!i.shown || !i.saleAttemptable || !i.principal.ready) return { kind: 'absent' };
  if (!i.loanLive.ready || !i.sanctionsReady) {
    return { kind: 'reading', failed: i.loanLive.failed };
  }
  if (i.salePending) return { kind: 'listing' };
  if (i.matured !== false) return { kind: 'matured' };
  if (!i.feeEnt.ready) return { kind: 'disclosure', failed: i.feeEnt.failed };
  return { kind: 'tools' };
}

/**
 * The chooser's `saleTools`: are the tools its sale rows jump to on the
 * page, still coming, or not coming?
 *
 * In Advanced it is the block's own answer. In Basic the block is not on
 * the page and its loan read is not running (the query is disabled there),
 * so demanding that read would pin both rows shut behind a read that never
 * runs, the permanent dead end this card has met before. In Basic the
 * loan-read gates (the read itself and maturity) are therefore taken as
 * met and become knowable on the switch, where the block states them
 * itself; every other gate applies in both modes.
 *
 * `sellerWindowReadable === false` is a prerequisite of the tools'
 * CONTENT rather than of the block (Codex r19): the block mounts, but
 * neither form can price a sale, so the rows say the sale cannot start.
 */
export function saleToolsAvailability(
  i: SaleToolsMountInput & { isAdvanced: boolean; sellerWindowReadable: boolean | undefined },
): SaleToolsState {
  const m = saleToolsMount(
    i.isAdvanced
      ? i
      : { ...i, loanLive: { ready: true, failed: false }, matured: false },
  );
  switch (m.kind) {
    case 'absent':
      // Principal metadata exhausting its retries is a failure no wait
      // ends (Codex r8); every other absent gate is a wait on a read.
      return i.shown && i.saleAttemptable && i.principal.failed ? 'failed' : 'checking';
    case 'reading':
    case 'disclosure':
      return m.failed ? 'failed' : 'checking';
    case 'listing':
    case 'matured':
      // Each clears on the next poll of its own read, or the verdict
      // refuses the route on its next refresh: a wait, not a failure.
      return 'checking';
    case 'tools':
      return i.sellerWindowReadable === false ? 'failed' : 'ready';
  }
}
