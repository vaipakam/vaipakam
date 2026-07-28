/**
 * The checks themselves — pure functions over one tick's reads.
 *
 * Two tiers, and the split is deliberate (see
 * `docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md` §M7 and the
 * #1439 review that settled it):
 *
 * - **CRITICAL** — accounting identities that CANNOT legitimately break.
 *   Each one is a relation the contracts maintain by construction, so a
 *   violation is a bug, a spoofed report, or storage corruption. These
 *   page.
 *
 * - **ADVISORY** — operational signals that are *necessary but not
 *   sufficient* evidence of a problem. A quiet chain with no claims,
 *   forfeits or expiries due satisfies the stuck-settlement condition
 *   perfectly legitimately, so it ships labelled and non-paging until
 *   #1442 settles the settlement-EXPECTED qualifier. Shipping it as a
 *   pager would train the operator to ignore it.
 *
 * Nothing here does I/O, so every branch is reachable from a unit test
 * with a hand-built observation.
 */

import type { CoverageGap } from './chains';

/** Base's per-chain books for one chain, read from the canonical Diamond. */
export interface BaseChainBooks {
  chainId: number;
  /** Highest cumulative Base has accepted from the chain (monotonic). */
  reported: bigint;
  /** Cumulative Base has INSTRUCTED the chain to fund locally. */
  consumed: bigint;
  /** What mesh funding may draw against, per `mirrorAvailRecycled`. */
  avail: bigint;
  /** Σ accepted per-day credits — the attribution clamp baseline. */
  attributed: bigint;
  /** Claims + releases together. */
  retired: bigint;
  /** The release-only subset (tokens stayed in the chain's bucket). */
  released: bigint;
  /** Reservations Base booked and the chain has not yet retired. */
  outstanding: bigint;
}

/** A chain's OWN ledger, read from that chain's Diamond. */
export interface LocalLedger {
  chainId: number;
  /** Base-funded remit backing sitting in this chain's bucket. */
  custodyRelocated: bigint;
  /** Live recycle-bucket balance (includes relocated custody). */
  bucket: bigint;
  /** What this chain's day-close report ships (excludes relocation). */
  reportedCumulative: bigint;
  localRetired: bigint;
  localReleased: bigint;
  /** This chain's own reservation ledger — `outstandingCommitRecycled`.
   *  On a mirror these are the commits Base instructed it to fund; on the
   *  canonical chain, Base's own commits plus the top-ups it funds for
   *  mirrors. */
  outstandingRecycled: bigint;
  outstandingFresh: bigint;
  armedFromDay: bigint;
  paidOutRecycled: bigint;
}

export interface MeshObservation {
  canonicalChainId: number;
  /** One entry per chain in `getExpectedSourceChainIds()`, plus the
   *  canonical chain itself (whose books must be inert — see
   *  `base-self-inert`). */
  books: readonly BaseChainBooks[];
  /** Own-ledger reads, keyed by chain id. Missing for chains this tick
   *  could not reach — those appear in `gaps`. */
  locals: ReadonlyMap<number, LocalLedger>;
  gaps: readonly CoverageGap[];
}

export type Severity = 'critical' | 'advisory';

export interface Finding {
  /** Stable identity for dedup — `code:chainId`. */
  key: string;
  code: string;
  severity: Severity;
  chainId: number;
  title: string;
  detail: string;
}

const WEI = 1_000_000_000_000_000_000n;

/** Render VPFI wei as a readable decimal (6 dp, no rounding surprises). */
export function fmt(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WEI;
  const frac = (abs % WEI) / 1_000_000_000_000n; // → 6 dp
  const body = `${whole.toString()}.${frac.toString().padStart(6, '0')}`;
  return `${neg ? '-' : ''}${body} VPFI`;
}

/** Saturating subtraction — mirrors the contracts' floored arithmetic. */
export function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/**
 * Re-derive `LibVpfiRecycle.mirrorAvailRecycled` off-chain.
 *
 * Both subtractions floor at zero exactly as the library does, so this is
 * a faithful model rather than an idealised one — an off-by-a-floor here
 * would make `availability-formula` fire on healthy state.
 */
export function expectedAvail(b: BaseChainBooks): bigint {
  return satSub(b.reported, satSub(b.consumed, b.released));
}

/**
 * CRITICAL tier — every relation that cannot legitimately break.
 *
 * @param obs           One tick's reads.
 * @param bucketToleranceWei Slack for the bucket-coverage check; see the
 *                      check's own comment for why an exact comparison
 *                      would produce false positives.
 */
export function checkHardInvariants(
  obs: MeshObservation,
  bucketToleranceWei: bigint,
): Finding[] {
  const out: Finding[] = [];
  const add = (
    code: string,
    chainId: number,
    title: string,
    detail: string,
  ): void => {
    out.push({
      key: `${code}:${chainId}`,
      code,
      severity: 'critical',
      chainId,
      title,
      detail,
    });
  };

  for (const b of obs.books) {
    const isCanonical = b.chainId === obs.canonicalChainId;

    // ── Commit identity ──────────────────────────────────────────────
    // `chainOutstandingRecycledCommit[c] == chainConsumedRecycled[c] −
    // chainRetiredRecycledCommit[c]` holds at EVERY instant, in-flight
    // broadcasts included (LibVaipakam.sol storage notes; B3 design
    // record §2.2 — the "applied" term cancels). Two independent writers
    // maintain it: `LibMeshFunding` increments both sides together at
    // finalization, `recordChainCommitRetirement` moves the retirement
    // delta from one to the other. A mismatch means one of those writers
    // ran without the other — the reservation ledger and the instruction
    // cumulative have diverged and every downstream availability figure
    // is now wrong.
    if (b.outstanding + b.retired !== b.consumed) {
      add(
        'commit-identity',
        b.chainId,
        'Per-chain commit identity broken',
        `outstanding + retired != consumed\n` +
          `  outstanding = ${fmt(b.outstanding)}\n` +
          `  retired     = ${fmt(b.retired)}\n` +
          `  sum         = ${fmt(b.outstanding + b.retired)}\n` +
          `  consumed    = ${fmt(b.consumed)}\n` +
          `  difference  = ${fmt(b.outstanding + b.retired - b.consumed)}`,
      );
    }

    // ── Clamp chain ──────────────────────────────────────────────────
    // `recordChainCommitRetirement` clamps `retired <= consumed` and then
    // `released <= retired`. The second clamp chained onto the first is
    // what forces `released <= consumed`, hence `avail <= reported` — the
    // bound the B2-d5 custody exclusion rests on. Either clamp reading as
    // violated means Base believed a mirror's magnitude instead of
    // clamping it.
    if (b.retired > b.consumed) {
      add(
        'clamp-chain',
        b.chainId,
        'Retirement exceeds instructions',
        `retired > consumed — Base accepted a retirement magnitude it never instructed\n` +
          `  retired  = ${fmt(b.retired)}\n` +
          `  consumed = ${fmt(b.consumed)}`,
      );
    }
    if (b.released > b.retired) {
      add(
        'clamp-chain',
        b.chainId,
        'Release exceeds retirement',
        `released > retired — the release-only subset is larger than the set it is a subset of\n` +
          `  released = ${fmt(b.released)}\n` +
          `  retired  = ${fmt(b.retired)}`,
      );
    }

    // ── Attribution ceiling ──────────────────────────────────────────
    // Σ of accepted per-day credits can never exceed the cumulative it is
    // attributed from; exceeding it would feed `Ā` absorption the
    // availability ledger does not back, and Base would fund reward
    // budget against absorption that never happened.
    if (b.attributed > b.reported) {
      add(
        'attribution-ceiling',
        b.chainId,
        'Day-credit attribution exceeds reported cumulative',
        `attributed > reported — the Ā feed is being credited beyond what the chain reported absorbing\n` +
          `  attributed = ${fmt(b.attributed)}\n` +
          `  reported   = ${fmt(b.reported)}`,
      );
    }

    // ── Availability formula ─────────────────────────────────────────
    // The view and the funding pass share one helper precisely so the
    // operator figure and the figure Base funds from cannot drift. This
    // re-derives it from the same three inputs: a mismatch means the
    // deployed `mirrorAvailRecycled` is not the function this Worker (and
    // the plan, and the specs) assume.
    const wantAvail = expectedAvail(b);
    if (b.avail !== wantAvail) {
      add(
        'availability-formula',
        b.chainId,
        'Availability does not match its definition',
        `avail != reported - max(0, consumed - released)\n` +
          `  reported = ${fmt(b.reported)}\n` +
          `  consumed = ${fmt(b.consumed)}\n` +
          `  released = ${fmt(b.released)}\n` +
          `  expected = ${fmt(wantAvail)}\n` +
          `  on-chain = ${fmt(b.avail)}`,
      );
    }

    // ── Base self-inertness ──────────────────────────────────────────
    // Base is never a "local" funder in the commit split: its own slice
    // is drawn from the same bucket the global ledger governs, so
    // `LibMeshFunding` books nothing per-chain for the canonical id and
    // `mirrorAvailRecycled`'s clamps pin every copy to zero. A non-zero
    // figure here means Base double-booked itself — corrupting the global
    // reservation AND netting its own bucket twice.
    if (isCanonical) {
      const nonZero: string[] = [];
      if (b.consumed !== 0n) nonZero.push(`consumed = ${fmt(b.consumed)}`);
      if (b.retired !== 0n) nonZero.push(`retired = ${fmt(b.retired)}`);
      if (b.released !== 0n) nonZero.push(`released = ${fmt(b.released)}`);
      if (b.outstanding !== 0n)
        nonZero.push(`outstanding = ${fmt(b.outstanding)}`);
      if (nonZero.length > 0) {
        add(
          'base-self-inert',
          b.chainId,
          'Canonical chain has per-chain commit books',
          `Base never instructs itself, so every per-chain commit figure under its own chain id must stay zero:\n  ${nonZero.join('\n  ')}`,
        );
      }
    }

    const local = obs.locals.get(b.chainId);
    if (!local) continue;

    // ── Base never ahead of the chain's own ledger ───────────────────
    // Base accepts CLAMPED, LAGGING copies of these cumulatives — it can
    // legitimately sit below the chain's own figures while a report is in
    // flight. Sitting ABOVE them is impossible without a spoofed or
    // replayed report, or a clamp that failed to bind. This is also what
    // makes the B2-d5 custody exclusion observable: the chain's own
    // `reportedCumulative` nets relocated custody out, so Base reading
    // higher would mean it had folded its own already-remitted top-up
    // back in as that chain's local absorption.
    if (b.reported > local.reportedCumulative) {
      add(
        'base-ahead-of-chain',
        b.chainId,
        'Base holds a higher reported cumulative than the chain itself',
        `Base's accepted cumulative exceeds the chain's own reported figure\n` +
          `  base  = ${fmt(b.reported)}\n` +
          `  chain = ${fmt(local.reportedCumulative)}\n` +
          `  excess = ${fmt(b.reported - local.reportedCumulative)}\n` +
          `  (chain's relocated custody = ${fmt(local.custodyRelocated)}, which its report excludes by design)`,
      );
    }
    if (b.retired > local.localRetired) {
      add(
        'base-ahead-of-chain',
        b.chainId,
        'Base holds a higher retirement cumulative than the chain itself',
        `base retired = ${fmt(b.retired)} > chain retired = ${fmt(local.localRetired)}`,
      );
    }
    if (b.released > local.localReleased) {
      add(
        'base-ahead-of-chain',
        b.chainId,
        'Base holds a higher release cumulative than the chain itself',
        `base released = ${fmt(b.released)} > chain released = ${fmt(local.localReleased)}`,
      );
    }
  }

  // ── Bucket coverage ────────────────────────────────────────────────
  // A chain's live recycle bucket must back the commitments reserved
  // against it. Reservation is UNCLAMPED on arrival
  // (`reserveMirrorCommit` adds whatever Base instructed), bounded only
  // by Base's MODEL of that chain's availability — so this is the check
  // that catches the model over-stating the bucket, which is the exact
  // failure the B2-d5 custody exclusion exists to prevent.
  //
  // Tolerance, not equality: `LibVpfiRecycle.consume` deliberately floors
  // the bucket at zero rather than reverting, because bounded cap-trim
  // dust can make a day's consumption exceed its recorded commitment by
  // wei-scale amounts. An exact `bucket >= outstanding` would therefore
  // fire on healthy dust. Real shortfalls are VPFI-scale.
  for (const local of obs.locals.values()) {
    if (local.bucket + bucketToleranceWei < local.outstandingRecycled) {
      out.push({
        key: `bucket-coverage:${local.chainId}`,
        code: 'bucket-coverage',
        severity: 'critical',
        chainId: local.chainId,
        title: 'Recycle bucket does not cover its own reservations',
        detail:
          `bucket + tolerance < outstanding reservations — commitments are reserved against tokens that are not there\n` +
          `  bucket       = ${fmt(local.bucket)}\n` +
          `  outstanding  = ${fmt(local.outstandingRecycled)}\n` +
          `  shortfall    = ${fmt(local.outstandingRecycled - local.bucket)}\n` +
          `  tolerance    = ${fmt(bucketToleranceWei)}\n` +
          `  (of which relocated custody = ${fmt(local.custodyRelocated)})`,
      });
    }
  }

  return out;
}

// ─── Windowed advisory signals ────────────────────────────────────────

/** Per-chain, per-signal streak state persisted between ticks. */
export interface StreakState {
  /** The value whose STAYING THE SAME is what the signal is about. */
  marker: string;
  /** Consecutive observations the condition has held with that marker. */
  streak: number;
}

export interface StreakOutcome {
  next: StreakState | null;
  fire: boolean;
}

/**
 * Advance one streak.
 *
 * Semantics that matter:
 * - Condition false → the streak is CLEARED, not decremented. These
 *   signals are about an uninterrupted run.
 * - Condition true but the marker MOVED → the streak restarts at 1.
 *   Progress happened, so whatever run was building is over.
 * - Fires on the tick the streak REACHES the window, and on every tick
 *   after; suppressing repeats is the dedup layer's job, not this
 *   function's, so that a still-stuck chain re-alerts after the repeat
 *   interval rather than going quiet forever.
 *
 * @param prev   Stored state, or `null` on the first observation.
 * @param holds  Whether the condition is true this tick.
 * @param marker Value whose stasis defines the run.
 * @param window Observations required before the signal fires.
 */
export function advanceStreak(
  prev: StreakState | null,
  holds: boolean,
  marker: string,
  window: number,
): StreakOutcome {
  if (!holds) return { next: null, fire: false };
  const streak = prev && prev.marker === marker ? prev.streak + 1 : 1;
  return { next: { marker, streak }, fire: streak >= window };
}

/**
 * Stuck-settlement condition — ADVISORY.
 *
 * `outstanding > 0` while retirement stays FLAT across the window.
 *
 * Three things this deliberately is not, each of which an earlier draft
 * got wrong (Codex #1439 r6–r8):
 *
 * - Not `consumed - released`. A healthy mirror that pays claims and
 *   simply has no forfeits or expiries keeps that positive with
 *   `released` flat forever, so an alert keyed on it fires continuously
 *   on normal paid settlement. Retirement is what distinguishes settling
 *   from stuck; releases quantify how much capacity settlement gave back.
 * - Not "outstanding is GROWING". Growth stops on its own once Base
 *   exhausts the chain's reported capacity and has nothing left to
 *   instruct — a growth-keyed alert would clear precisely when the
 *   condition became permanent.
 * - Not sufficient. A chain with no claims, forfeits or expiries falling
 *   due in the window satisfies both halves legitimately; commitments
 *   stay reserved until a user or horizon event retires them. The
 *   settlement-EXPECTED qualifier that would make this pageable is open
 *   design work on #1442.
 *
 * Retirement is read from the CHAIN'S OWN ledger when reachable, because
 * that moves the instant the chain retires anything — independent of
 * whether its report reached Base. Falling back to Base's copy would
 * conflate stuck settlement with a stalled report pipeline, which is the
 * separate `report-lag` signal below.
 */
export function stuckSettlementCondition(
  books: BaseChainBooks,
  local: LocalLedger | undefined,
): { holds: boolean; marker: string; source: 'chain' | 'base' } {
  const source = local ? 'chain' : 'base';
  const retired = local ? local.localRetired : books.retired;
  return {
    holds: books.outstanding > 0n,
    marker: retired.toString(),
    source,
  };
}

/**
 * Report-lag condition — ADVISORY.
 *
 * Base's accepted cumulative sits BELOW the chain's own and has not moved
 * across the window. Trailing alone is normal (reports are periodic);
 * trailing while frozen means the report path stalled, which is what the
 * B2-d2 zeroed-chain manual-budget path exists to reconcile.
 *
 * The marker is Base's figure alone, deliberately. Keying it on both
 * sides would reset the streak every time the chain absorbed more —
 * masking exactly the case this is for, where the chain keeps working and
 * Base never hears about it.
 */
export function reportLagCondition(
  books: BaseChainBooks,
  local: LocalLedger | undefined,
): { holds: boolean; marker: string } {
  if (!local) return { holds: false, marker: '' };
  return {
    holds: books.reported < local.reportedCumulative,
    marker: books.reported.toString(),
  };
}
