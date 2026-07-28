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
  /**
   * Timestamp of the block this snapshot was read at.
   *
   * Load-bearing for the cross-chain checks: a mirror RPC serving a stale
   * head makes Base legitimately AHEAD of the figures read here, which
   * `base-ahead-of-chain` would report as ledger corruption (Codex #1443
   * r6). An unacceptably stale snapshot is treated as unreadable instead.
   */
  observedAt: bigint;
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
  /**
   * Stable identity for dedup. Distinct VIOLATIONS get distinct keys even
   * when they share a `code`: several checks can fire more than once per
   * chain in a tick (both clamp halves; all three cross-chain
   * comparisons), and keying them all on `code:chainId` made the delivery
   * map keep only the last one — so an earlier violation's figures were
   * never sent, and the shared key's fingerprint oscillated between them
   * (Codex #1443 r1).
   */
  key: string;
  /** Check family, for grouping and for the tests' assertion surface. */
  code: string;
  severity: Severity;
  chainId: number;
  title: string;
  detail: string;
  /**
   * Content used for the repeat-suppression fingerprint, when it must
   * differ from `detail`.
   *
   * Windowed advisories carry an observation count in their detail that
   * increments every tick. Fingerprinting the detail therefore made every
   * tick look like new information and bypassed the quiet window entirely,
   * reposting four times an hour instead of every six (Codex #1443 r1).
   * Those findings set this to the figures alone.
   */
  fingerprintSource?: string;
}

const WEI = 1_000_000_000_000_000_000n;

/**
 * Render VPFI wei as a readable decimal, **without ever discarding
 * evidence**.
 *
 * Six decimal places is the readable form, but these are EXACT invariants:
 * `commit-identity` and friends can fail by a single wei, and a formatter
 * that only truncated would page the operator while displaying identical
 * operands and a difference of `0.000000` — deleting the one piece of
 * information needed to diagnose it (Codex #1443 r1). So whenever
 * truncation would drop a non-zero digit, the exact wei figure is appended
 * rather than lost.
 */
export function fmt(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WEI;
  const remainder = abs % WEI;
  const frac = remainder / 1_000_000_000_000n; // → 6 dp
  const sign = neg ? '-' : '';
  const body = `${sign}${whole.toString()}.${frac.toString().padStart(6, '0')} VPFI`;
  // Digits below the sixth decimal that the readable form cannot show.
  const dropped = remainder % 1_000_000_000_000n;
  return dropped === 0n ? body : `${body} (exactly ${sign}${abs.toString()} wei)`;
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
  /**
   * @param code    Check family (the tests' assertion surface).
   * @param variant Sub-condition discriminator, so two violations of the
   *                same family on the same chain do not collide on one
   *                dedup key and lose each other's figures.
   */
  const add = (
    code: string,
    variant: string,
    chainId: number,
    title: string,
    detail: string,
  ): void => {
    out.push({
      key: `${code}/${variant}:${chainId}`,
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
        'sum',
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
        'retired-vs-consumed',
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
        'released-vs-retired',
        b.chainId,
        'Release exceeds retirement',
        `released > retired — the release-only subset is larger than the set it is a subset of\n` +
          `  released = ${fmt(b.released)}\n` +
          `  retired  = ${fmt(b.retired)}`,
      );
    }

    // ── Consumed cap (governor §7 #6) ────────────────────────────────
    // `consumed − released ≤ reported` per chain: Base can never instruct
    // a chain to fund more than it reported absorbing, net of what it
    // released un-spent. The funding pass enforces it by construction
    // (`_mirrorAvailable` bounds every instruction), and
    // `MeshLedger.invariant.t.sol` asserts it on-chain.
    //
    // Checked SEPARATELY rather than inferred from the availability
    // formula, because that formula SATURATES: if this bound broke,
    // `expectedAvail` would floor to zero, the on-chain `avail` would
    // also be zero, and `availability-formula` would agree — while the
    // commit identity and both clamps stayed green too. Over-instruction
    // would have been completely invisible (Codex #1443 r4).
    //
    // SUBTRACTION form, mirroring `MeshLedger.invariant.t.sol` exactly.
    // The contracts need that form because a chain's reported cumulative
    // is deliberately unbounded and `reported + released` overflows
    // uint256 on a near-max report. JS bigint does not overflow, so here
    // the reason is fidelity rather than arithmetic safety: a watcher
    // that checks a subtly different bound than the on-chain invariant
    // will eventually disagree with it, and the disagreement will be
    // read as a ledger fault rather than as a watcher bug.
    if (satSub(b.consumed, b.released) > b.reported) {
      add(
        'consumed-cap',
        'vs-reported',
        b.chainId,
        'Instructions exceed what the chain reported absorbing',
        `consumed - released > reported — Base has instructed this chain to fund more than it ever reported having\n` +
          `  consumed = ${fmt(b.consumed)}\n` +
          `  released = ${fmt(b.released)}\n` +
          `  net      = ${fmt(satSub(b.consumed, b.released))}\n` +
          `  reported = ${fmt(b.reported)}\n` +
          `  excess   = ${fmt(satSub(b.consumed, b.released) - b.reported)}`,
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
        'vs-reported',
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
        'definition',
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
          'nonzero-books',
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
        'reported',
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
        'retired',
        b.chainId,
        'Base holds a higher retirement cumulative than the chain itself',
        `base retired = ${fmt(b.retired)} > chain retired = ${fmt(local.localRetired)}`,
      );
    }
    if (b.released > local.localReleased) {
      add(
        'base-ahead-of-chain',
        'released',
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
    if (local.bucket + bucketToleranceWei >= local.outstandingRecycled) continue;

    // Severity splits by chain role, and the split is load-bearing.
    //
    // On a MIRROR the relation is hard: `reserveMirrorCommit` raises the
    // reservation, `consume` and `releaseCommitment` lower it, and nothing
    // else touches either side — so a shortfall beyond rounding dust means
    // the reservation is backed by tokens that are not there.
    //
    // On the CANONICAL chain there is a legitimate path to a shortfall
    // (Codex #1443 r1, verified against `releaseRemitReservation` +
    // `LibVpfiRecycle.restoreReleasedRemit`): releasing a verifiably-dead
    // remittance restores `outstandingCommitRecycled` in full while
    // DELIBERATELY not re-crediting `recycleBucket`, because those tokens
    // are locked in the CCIP pool — genuinely outside Diamond custody.
    // That is the contract's intended conservative recovery state, so
    // paging on it would be a false alarm on correct behaviour. Reported
    // as advisory with the likely cause named instead.
    const isCanonical = local.chainId === obs.canonicalChainId;
    const shortfall = local.outstandingRecycled - local.bucket;
    const figures =
      `  bucket       = ${fmt(local.bucket)}\n` +
      `  outstanding  = ${fmt(local.outstandingRecycled)}\n` +
      `  shortfall    = ${fmt(shortfall)}\n` +
      `  tolerance    = ${fmt(bucketToleranceWei)}\n` +
      `  (of which relocated custody = ${fmt(local.custodyRelocated)})`;

    out.push({
      key: `bucket-coverage:${local.chainId}`,
      code: 'bucket-coverage',
      severity: isCanonical ? 'advisory' : 'critical',
      chainId: local.chainId,
      title: isCanonical
        ? 'Canonical bucket below its reservations — check for a released remit'
        : 'Recycle bucket does not cover its own reservations',
      detail: isCanonical
        ? `bucket + tolerance < outstanding reservations on the CANONICAL chain\n` +
          figures +
          `\n\nEXPECTED CAUSE — releasing a permanently-failed remittance restores the reservation but not the bucket, by design: those tokens sit locked in the CCIP pool, outside Diamond custody. Reconcile against the released reservations (status 3) before treating this as a fault.\n\nA release RAISES the deficit by its recycled total; it does not make the deficit EQUAL that total. Pre-release bucket headroom absorbs part of it and later credits absorb more, so the released totals BOUND and EXPLAIN this shortfall rather than matching it. Suspect a fault only if the shortfall EXCEEDS the released totals.`
        : `bucket + tolerance < outstanding reservations — commitments are reserved against tokens that are not there\n` +
          figures,
    });
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
): {
  holds: boolean;
  marker: string;
  source: 'chain' | 'base';
  /** Which window this observation should be judged against. */
  windowKind: 'local' | 'report-cycle';
} {
  // BOTH halves from the SAME ledger. Mixing them — Base's outstanding
  // against the chain's own retirement — produced a guaranteed false
  // positive: a mirror that retires everything between day-closes zeroes
  // its local reservation immediately while Base's copy stays positive
  // until the next report lands, so the run would build and fire on a
  // chain with nothing left outstanding at all (Codex #1443 r4).
  if (local) {
    return {
      holds: local.outstandingRecycled > 0n,
      // Source kind is IN the marker: a chain that was unreachable for a
      // while accumulates a Base-fallback run judged on the long window,
      // and if its local retirement happened to equal Base's last
      // reported figure the run would carry over and fire immediately on
      // the short window at the first healthy read (Codex #1443 r5).
      // Changing source therefore restarts the run by construction.
      marker: `chain:${local.localRetired}`,
      source: 'chain',
      // Both figures are chain-local and move the instant it settles, so
      // the short window is meaningful here.
      windowKind: 'local',
    };
  }

  // Fallback: both figures come from Base and therefore move only when a
  // report lands, so judging them on the short window would fire once per
  // report cycle on a healthy chain — the same mistake the report-lag
  // window made. Judged on the report-cycle window instead.
  return {
    holds: books.outstanding > 0n,
    marker: `base:${books.retired}`,
    source: 'base',
    windowKind: 'report-cycle',
  };
}

/**
 * The three Base/chain cumulative pairs a day-close report carries, each
 * flagged with whether Base is behind on it.
 *
 * Exported so the alert can render what ACTUALLY lags. Printing the
 * absorption pair alone showed `behind by = 0` whenever retirement or
 * release was the trigger (Codex #1443 r2) — the same evidence-deletion
 * failure the wei-exact formatter fixes elsewhere.
 */
export function lagPairs(
  books: BaseChainBooks,
  local: LocalLedger,
): { label: string; base: bigint; chain: bigint; behind: boolean }[] {
  return [
    { label: 'absorption', base: books.reported, chain: local.reportedCumulative },
    { label: 'retired', base: books.retired, chain: local.localRetired },
    { label: 'released', base: books.released, chain: local.localReleased },
  ].map((p) => ({ ...p, behind: p.base < p.chain }));
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
export function reportLagConditions(
  books: BaseChainBooks,
  local: LocalLedger | undefined,
): { label: string; holds: boolean; marker: string }[] {
  // ONE RUN PER CUMULATIVE, not one run for all three (Codex #1443 r5).
  // A single combined marker made partial ingestion failures
  // undetectable: if retirement ingestion is broken while ordinary daily
  // reports keep advancing absorption, the combined marker changes every
  // report and resets the run long before the window elapses — so a
  // permanently-stuck `retired` never fires, and `commit-identity` stays
  // green too because Base's retirement and outstanding both simply sit
  // still. Tracking each independently is what keeps that case visible.
  //
  // Each run's marker is BASE's side of that one field, so the chain
  // absorbing or settling more cannot reset a run that is about Base
  // failing to hear about it.
  if (!local) {
    return lagLabels.map((label) => ({ label, holds: false, marker: '' }));
  }
  return lagPairs(books, local).map((p) => ({
    label: p.label,
    holds: p.behind,
    marker: p.base.toString(),
  }));
}

/** Stable label set, so a streak row keeps its identity across ticks. */
export const lagLabels = ['absorption', 'retired', 'released'] as const;
