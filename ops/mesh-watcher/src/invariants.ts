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
import { makeFinding, type Finding } from './finding';

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

/**
 * ROOT-CAUSE FIX #6 — freshness is a TYPE precondition.
 *
 * A stale RPC head makes Base legitimately ahead of a local snapshot, and
 * comparing the two produced a false CRITICAL (#1443 r6). Fixing the one
 * comparison that existed would have left the next cross-chain check to
 * rediscover it, so the guarantee is carried by the type instead: a
 * `LocalLedger` can only be produced by `mesh.ts`'s single validated
 * construction point, which refuses a snapshot older than
 * `STALE_LOCAL_SECONDS`. A cross-chain check that has one in hand knows
 * it is fresh; a check that does not have one cannot compare at all.
 */
declare const FreshSnapshot: unique symbol;
/** The brand key. */
export type FRESH = typeof FreshSnapshot;

/**
 * The ONLY way to obtain a `LocalLedger` — and it performs the check
 * itself rather than trusting the caller to have done it.
 *
 * An earlier version was an unchecked cast whose contract lived in a
 * comment ("call only after checking the age"), which is the same
 * enforcement-by-convention this brand exists to replace: any module
 * could brand a stale snapshot and compile (#1443 r9). Validation now
 * lives inside the constructor, so a caller cannot skip it without
 * noticing — there is no code path from a raw read to a branded value
 * that does not pass through this age check.
 *
 * @returns The branded snapshot, or `null` when it is too old to compare
 *          against another chain.
 */
export function asFreshSnapshot(
  raw: Omit<LocalLedger, FRESH>,
  wallClockSeconds: number,
  maxAgeSeconds: number,
): { fresh: LocalLedger } | { stale: true; ageSeconds: number } {
  const ageSeconds = wallClockSeconds - Number(raw.observedAt);
  if (ageSeconds > maxAgeSeconds) return { stale: true, ageSeconds };
  return { fresh: raw as LocalLedger };
}

/** A chain's OWN ledger, read from that chain's Diamond. */
export interface LocalLedger {
  /** Brand — set only by the validated constructor in `mesh.ts`. */
  readonly [FreshSnapshot]: true;
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
   * #1444 / #1446 — the RAW stored slots, as opposed to every field above
   * that the contract derives.
   *
   * `creditedRaw` is `recycleCreditedCumulative` BEFORE the pre-upgrade floor
   * is applied; `reportedCumulative` above is what that floor produces. The
   * difference is the whole point: a regression in the derivation moves the
   * reported figure and Base's accepted copy of it in lockstep, so comparing
   * those two can never see it, while comparing the derived figure against a
   * re-derivation from these can.
   */
  /**
   * #1444 / #1446 — the RAW stored slots, as opposed to every field above
   * that the contract derives.
   *
   * OPTIONAL, and the optionality is load-bearing (#1448 r2). This view is a
   * NEWER facet selector than the three established reads, so a chain missed
   * during a facet refresh answers the others and reverts this one. Bundling
   * it into the same all-or-nothing read would have let that single failure
   * discard the custody, retirement and governor evidence too, downgrading
   * several working CRITICAL checks into one non-paging coverage gap. It is
   * read separately and absent here when unavailable; the checks that need it
   * say so rather than the whole snapshot disappearing.
   */
  composition?: {
    /**
     * `recycleCreditedCumulative` BEFORE the pre-upgrade floor is applied;
     * `reportedCumulative` above is what that floor produces. The difference
     * is the point: a regression in the derivation moves the reported figure
     * and Base's accepted copy in lockstep, so comparing those two can never
     * see it, while re-deriving from this can.
     */
    creditedRaw: bigint;
    /**
     * Σ VPFI a released remittance took out of the bucket and did not return.
     *
     * The `paidOutRecycled` reversal, NOT the pre-clamp commitment restored:
     * a liability-clamped remit sends only part of its recycled commitment
     * and the residual is retired without moving tokens, so it is still in
     * the bucket. Counting the full figure would count it twice (#1448 r1).
     */
    releasedRemitStranded: bigint;
    /**
     * Whether the chain ITSELF reports acting as the canonical reward chain.
     *
     * Read from the chain rather than inferred, because the role is a MUTABLE
     * admin setting: a Diamond can accrue a stranded total as canonical and
     * later be switched to mirror mode without it being cleared (#1448 r1).
     * It is cross-checked against Base's own view of which chain is canonical
     * — the two are independently mutable, so disagreement is itself a
     * finding (#1448 r2).
     */
    isCanonicalRewardChain: boolean;
  };
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
  /**
   * Every chain the mesh EXPECTS, including ones whose reads failed.
   *
   * Distinct from `books`, which holds only the chains successfully read.
   * Streak pruning keys on this: a chain whose read merely failed is
   * still in the mesh, and deleting its runs on a transient error would
   * let intermittent failures reset a multi-day window forever.
   */
  expectedChainIds: readonly number[];
  /**
   * VALIDATED own-ledger reads, keyed by chain id.
   *
   * Membership is itself the freshness guarantee — a chain that could not
   * be read, or whose head was too old to compare against Base, is absent
   * here and present in `gaps`. **Cross-chain** checks read only this map.
   */
  freshLocals: ReadonlyMap<number, LocalLedger>;
  /**
   * EVERY own-ledger read, fresh or not.
   *
   * Same-chain checks belong here rather than in `freshLocals`: bucket
   * coverage compares two figures read from ONE pinned block, so it is
   * valid however old that block is, and discarding a stale snapshot
   * downgraded a genuine CRITICAL to a silent coverage advisory (#1443
   * r9). Freshness is a precondition for comparing ACROSS chains, not
   * for comparing within one.
   */
  allLocals: ReadonlyMap<number, Omit<LocalLedger, FRESH>>;
  gaps: readonly CoverageGap[];
}

export type { Severity, Finding } from './finding';
export type { StreakState } from './signal';

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
  compositionSlackToleranceWei: bigint = bucketToleranceWei,
): Finding[] {
  const out: Finding[] = [];
  /**
   * @param code    Check family (the tests' assertion surface).
   * @param variant Sub-condition discriminator, so two violations of the
   *                same family on the same chain do not collide on one
   *                dedup key and lose each other's figures.
   */
  /**
   * @param identity The figures whose CHANGING means new information.
   *                 Required by {@link makeFinding} — see `finding.ts`
   *                 for why this is not inferred from `detail`.
   */
  const add = (
    code: string,
    variant: string,
    chainId: number,
    title: string,
    detail: string,
    identity: readonly (string | number | bigint)[],
  ): void => {
    out.push(
      makeFinding({ code, variant, severity: 'critical', chainId, title, detail, identity }),
    );
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
        [b.outstanding, b.retired, b.consumed],
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
        [b.retired, b.consumed],
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
        [b.released, b.retired],
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
        [b.consumed, b.released, b.reported],
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
        [b.attributed, b.reported],
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
        [b.avail, b.reported, b.consumed, b.released],
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
          [b.consumed, b.retired, b.released, b.outstanding],
        );
      }
    }

    const local = obs.freshLocals.get(b.chainId);
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
        [b.reported, local.reportedCumulative],
      );
    }
    if (b.retired > local.localRetired) {
      add(
        'base-ahead-of-chain',
        'retired',
        b.chainId,
        'Base holds a higher retirement cumulative than the chain itself',
        `base retired = ${fmt(b.retired)} > chain retired = ${fmt(local.localRetired)}`,
        [b.retired, local.localRetired],
      );
    }
    if (b.released > local.localReleased) {
      add(
        'base-ahead-of-chain',
        'released',
        b.chainId,
        'Base holds a higher release cumulative than the chain itself',
        `base released = ${fmt(b.released)} > chain released = ${fmt(local.localReleased)}`,
        [b.released, local.localReleased],
      );
    }
  }

  // ── Canonical-role consistency ─────────────────────────────────────
  //
  // #1448 r2 — the mesh has TWO independently mutable statements of which
  // chain is canonical: Base's own configuration (which chain the watcher
  // reads the per-chain books from) and each Diamond's
  // `isCanonicalRewardChain` flag. Nothing on-chain reconciles them.
  //
  // Disagreement is not cosmetic. That flag decides whether `closeDay` writes
  // locally or reports to Base, and it authorises the canonical-only
  // remittance surface — so a mirror carrying it is a split-brain mesh that
  // can close its own days and release remittances, while Base still expects
  // reports from it. It also feeds the coverage allowance above, which is why
  // this is checked BEFORE that allowance is trusted rather than after.
  for (const local of obs.allLocals.values()) {
    if (!local.composition) continue;
    const baseSaysCanonical = local.chainId === obs.canonicalChainId;
    const chainSaysCanonical = local.composition.isCanonicalRewardChain;
    if (baseSaysCanonical === chainSaysCanonical) continue;

    out.push(makeFinding({
      code: 'role-consistency',
      variant: chainSaysCanonical ? 'mirror-claims-canonical' : 'canonical-disclaims',
      identity: [BigInt(local.chainId), chainSaysCanonical ? 1n : 0n],
      severity: 'critical',
      chainId: local.chainId,
      title: chainSaysCanonical
        ? 'A mirror reports itself as the canonical reward chain'
        : 'The canonical chain does not report itself as canonical',
      detail: chainSaysCanonical
        ? `chain ${local.chainId} has isCanonicalRewardChain = true, but the mesh is read against chain ${obs.canonicalChainId} as canonical\n\n` +
          `SPLIT BRAIN. That flag decides whether \`closeDay\` writes locally or reports to Base, and it authorises the canonical-only remittance surface — so this chain can close its own days and release remittances while Base still expects reports from it. Its released-remit allowance is deliberately NOT applied to bucket coverage while this holds.`
        : `chain ${local.chainId} is read as the mesh's canonical chain but reports isCanonicalRewardChain = false\n\n` +
          `Its day-closes will report to Base rather than finalizing locally, and the canonical-only surfaces are unauthorised. Either the flag was cleared in error or this Worker is pointed at the wrong canonical chain.`,
    }));
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
  //
  // #1444 — ONE rule for both chain roles. This shipped as a role-split
  // severity (CRITICAL on mirrors, advisory on Base) because
  // `releaseRemitReservation` → `restoreReleasedRemit` restores the
  // reservation while DELIBERATELY not re-crediting the bucket — the sent
  // tokens are locked in the transport's custody, genuinely outside Diamond
  // custody — so a canonical shortfall was the contract's intended recovery
  // state and paging on it would have alarmed on correct behaviour.
  //
  // Rather than keep a role exception, the contract now RECORDS what that
  // path moved, so the stranded total enters the relation as backing that
  // exists but is in transit. The relation is hard again on every chain, and
  // the exception is gone rather than documented.
  //
  // Two things the allowance deliberately is NOT (both Codex #1448 r1):
  //
  // - Not the pre-clamp commitment restored. A liability-clamped remit sends
  //   only part of its recycled commitment; `consume` debits that part while
  //   `releaseCommitment` retires the residual WITHOUT moving tokens, so the
  //   residual never left the bucket. Counting it would introduce slack a
  //   later real shortfall could hide inside. The stranded figure restores
  //   the relation exactly — the release lowered the bucket by precisely it.
  // - Not applied unless BOTH sources of the canonical role agree. Only the
  //   canonical chain can release, but the role is a MUTABLE admin setting
  //   AND Base's view of which chain is canonical is separately configured,
  //   so the two can disagree (#1448 r2). Requiring both closes a demoted
  //   Diamond inheriting an allowance in mirror mode, AND a mis-flagged
  //   mirror being granted one while Base still treats another chain as
  //   canonical. Disagreement is itself reported — see `role-consistency`.
  for (const local of obs.allLocals.values()) {
    // Absent composition = the newer view could not be read on this chain.
    // Fall back to the PRE-#1444 rule rather than guessing: strict on a
    // mirror (where the relation was always hard), and reported as a gap on
    // the canonical chain, where a release legitimately produces a shortfall
    // and the term that would explain it is exactly what is missing. Paging
    // there without it would alarm on correct behaviour (#1448 r2).
    const isCanonicalHere = local.chainId === obs.canonicalChainId;
    if (!local.composition) {
      if (isCanonicalHere) continue; // reported via the coverage gap below
      const backingRaw = local.bucket;
      if (backingRaw + bucketToleranceWei >= local.outstandingRecycled) continue;
      out.push(makeFinding({
        code: 'bucket-coverage',
        variant: 'shortfall-no-stranded-read',
        identity: [local.bucket, local.outstandingRecycled],
        severity: 'critical',
        chainId: local.chainId,
        title: 'Recycle bucket does not cover its own reservations',
        detail:
          `bucket + tolerance < outstanding reservations on a MIRROR — commitments are reserved against tokens that are not there\n` +
          `  bucket        = ${fmt(local.bucket)}\n` +
          `  outstanding   = ${fmt(local.outstandingRecycled)}\n` +
          `  shortfall     = ${fmt(local.outstandingRecycled - local.bucket)}\n\n` +
          `The released-remit allowance is admitted only for the mesh's configured canonical chain, and this chain is not it — so the strict relation applies regardless of what the unread counter holds.`,
      }));
      continue;
    }
    const allowance =
      isCanonicalHere && local.composition.isCanonicalRewardChain
        ? local.composition.releasedRemitStranded
        : 0n;
    const backing = local.bucket + allowance;
    if (backing + bucketToleranceWei >= local.outstandingRecycled) continue;

    const shortfall = local.outstandingRecycled - backing;
    out.push(makeFinding({
      code: 'bucket-coverage',
      variant: 'shortfall',
      identity: [
        local.bucket,
        allowance,
        local.outstandingRecycled,
        local.custodyRelocated,
      ],
      severity: 'critical',
      chainId: local.chainId,
      title: 'Recycle bucket does not cover its own reservations',
      detail:
        `bucket + released-in-transit + tolerance < outstanding reservations — commitments are reserved against tokens that are not there\n` +
        `  bucket        = ${fmt(local.bucket)}\n` +
        `  stranded      = ${fmt(allowance)}  (VPFI a released remittance took out of the bucket and has not returned)\n` +
        `  backing       = ${fmt(backing)}\n` +
        `  outstanding   = ${fmt(local.outstandingRecycled)}\n` +
        `  shortfall     = ${fmt(shortfall)}\n` +
        `  tolerance     = ${fmt(bucketToleranceWei)}\n` +
        `  (of which relocated custody = ${fmt(local.custodyRelocated)})`,
    }));
  }

  // ── Bucket composition ─────────────────────────────────────────────
  //
  // #1446 — the check that catches a B2-d5 custody EXCLUSION regression in
  // EITHER direction. `reported-derivation` covers the sibling failure (the
  // subtraction dropped from the floor branch); this one covers a counter
  // moving when it should not, and — via the reverse bound below — a counter
  // NOT moving when it should.
  //
  // Every recycled credit lands in the bucket exactly once, so the two
  // lifetime cumulatives can never exceed where the tokens actually went:
  //
  //     creditedRaw + relocated <= bucket + paidOut + releasedRemitStranded
  //
  // `credit` and `creditCustodyRelocated` each add to one term on each
  // side; `consume` moves bucket → paidOut; `releaseCommitment` moves
  // neither; `restoreReleasedRemit` moves paidOut → releasedRemitStranded.
  //
  // Why it is the only check that sees this class: `reportedCumulative`
  // is built by the SAME helper that builds the outbound day-close report,
  // so a regression that stopped excluding relocated custody would inflate
  // this chain's figure and Base's accepted copy of it identically, and
  // `base-ahead-of-chain` would see two equal numbers. This one compares
  // against where the tokens are, not against another copy of the claim.
  //
  // Same tolerance and the same reason: `consume` floors the bucket for
  // bounded cap-trim dust, which can only widen the right-hand side.
  //
  // EXACT — no tolerance, deliberately (#1448 r2). `BUCKET_COVERAGE_TOLERANCE_WEI`
  // exists for the one reachable dust case: `consume` flooring the bucket,
  // which widens the RIGHT side here and so can never produce a positive
  // excess. Sharing that knob would silently accept a custody-exclusion
  // regression up to its value, and would WIDEN this blind spot whenever an
  // operator raised the tolerance for a noisy chain's coverage — a coupling
  // they would have no reason to expect.
  for (const local of obs.allLocals.values()) {
    if (!local.composition) continue; // reported as a coverage gap
    const claimed = local.composition.creditedRaw + local.custodyRelocated;
    const destinations =
      local.bucket +
      local.paidOutRecycled +
      local.composition.releasedRemitStranded;
    // ── REVERSE bound (#1448 r3) ──────────────────────────────────
    //
    // The forward bound alone is defeated by the very regression this
    // check exists for. If a custody arrival credits `recycleBucket` but
    // omits `recycleCustodyRelocatedCumulative`, `claimed` stays flat
    // while `destinations` RISES — so the forward bound gets LOOSER, and
    // `reported-derivation` agrees with the chain because it trusts the
    // same missing slot. Verified: bucket 200→223, creditedRaw 1000,
    // paidOut 800, relocated 0 makes the contract and this Worker both
    // derive a false report of 1023 while the forward bound passes.
    //
    // So the relation is checked BOTH ways: tokens in the bucket that no
    // counter claims are as much a fault as counters claiming tokens that
    // are not there.
    //
    // Its own tolerance, never the coverage knob: `consume`'s bucket floor
    // widens `destinations`, which is exactly this direction, and raising
    // the coverage tolerance for a noisy chain must not silently widen a
    // custody-exclusion blind spot (#1448 r2).
    //
    // ADVISORY rather than CRITICAL when `creditedRaw` is 0: that is an
    // un-seeded Diamond refreshed over live pre-#1222 state, where the
    // whole historical bucket legitimately has no counter behind it. Not
    // silent — the operator is told the relation is unverifiable until the
    // first credit seeds the cumulative.
    if (destinations > claimed + compositionSlackToleranceWei) {
      const unseeded = local.composition.creditedRaw === 0n;
      out.push(makeFinding({
        code: 'bucket-composition',
        variant: unseeded ? 'unverifiable-unseeded' : 'under-credited',
        identity: [
          local.composition.creditedRaw,
          local.custodyRelocated,
          local.bucket,
          local.paidOutRecycled,
          local.composition.releasedRemitStranded,
        ],
        severity: unseeded ? 'advisory' : 'critical',
        chainId: local.chainId,
        title: unseeded
          ? 'Recycled composition cannot be verified — the cumulative is unseeded'
          : 'Bucket holds more than the recycled cumulatives account for',
        detail:
          (unseeded
            ? `creditedRaw is 0, so this chain's bucket has no counter behind it yet — a Diamond refreshed over live pre-#1222 state. The composition relation is UNVERIFIABLE until the first credit seeds the cumulative; reported here so the gap is visible rather than silently passing.\n`
            : `bucket + paidOut + stranded > creditedRaw + relocated — VPFI is in the bucket that no cumulative claims\n`) +
          `  creditedRaw   = ${fmt(local.composition.creditedRaw)}\n` +
          `  relocated     = ${fmt(local.custodyRelocated)}\n` +
          `  claimed       = ${fmt(claimed)}\n` +
          `  bucket        = ${fmt(local.bucket)}\n` +
          `  paidOut       = ${fmt(local.paidOutRecycled)}\n` +
          `  stranded      = ${fmt(local.composition.releasedRemitStranded)}\n` +
          `  destinations  = ${fmt(destinations)}\n` +
          `  unaccounted   = ${fmt(destinations - claimed)}\n` +
          `  tolerance     = ${fmt(compositionSlackToleranceWei)}\n\n` +
          (unseeded
            ? `EXPECTED on a freshly-upgraded chain and it self-heals: the first credit stamps the cumulative through the pre-upgrade floor.`
            : `LIKELIEST CAUSE — an arriving remit credited the bucket WITHOUT advancing the relocated-custody cumulative. That is the mirror image of the over-credit case: it leaves this chain reporting Base's own top-up as its own absorption, and no other check sees it because they all read the same missing slot.\n\nNOTE this does NOT cover an arrival routed through the ordinary credit path instead of the custody-relocation one — that advances both sides and needs a Base-side acked-remittance cross-check.`),
      }));
    }

    if (claimed <= destinations) continue;

    out.push(makeFinding({
      code: 'bucket-composition',
      variant: 'over-credited',
      identity: [
        local.composition.creditedRaw,
        local.custodyRelocated,
        local.bucket,
        local.paidOutRecycled,
        local.composition.releasedRemitStranded,
      ],
      severity: 'critical',
      chainId: local.chainId,
      title: 'Recycled cumulatives claim more credit than the bucket received',
      detail:
        `creditedRaw + relocated > bucket + paidOut + releasedRemitStranded — a counter advanced without tokens landing in the bucket\n` +
        `  creditedRaw   = ${fmt(local.composition.creditedRaw)}\n` +
        `  relocated     = ${fmt(local.custodyRelocated)}\n` +
        `  claimed       = ${fmt(claimed)}\n` +
        `  bucket        = ${fmt(local.bucket)}\n` +
        `  paidOut       = ${fmt(local.paidOutRecycled)}\n` +
        `  stranded      = ${fmt(local.composition.releasedRemitStranded)}\n` +
        `  destinations  = ${fmt(destinations)}\n` +
        `  excess        = ${fmt(claimed - destinations)}\n\n` +
        `LIKELIEST CAUSE — a relocated-custody credit also advancing the absorption cumulative. That would let this chain report Base's own already-spent top-up back as its own local absorption, and Base would re-offer it as this chain's funding.`,
    }));
  }

  // ── Reported-cumulative derivation ─────────────────────────────────
  //
  // #1446, second half — re-derive the PUBLISHED figure from the raw
  // slots and disagree with the chain if it does not match:
  //
  //     reported == max(creditedRaw, bucket + paidOut - relocated)
  //
  // i.e. the stored counter, floored by the pre-upgrade derivation with
  // the relocation netted out. The composition bound above catches a
  // counter advancing wrongly; this catches the DERIVATION dropping the
  // subtraction, which matters on a Diamond refreshed over live pre-#1222
  // state where the floor is the branch that binds.
  //
  // NOTE for maintainers: this formula is a deliberate SECOND
  // implementation of `LibVpfiRecycle.creditedCumulative`. That is the
  // point — an independent restatement is what makes disagreement
  // meaningful — but it means a legitimate change to the library's
  // derivation must be mirrored here in the same change, or this check
  // will alarm on correct behaviour.
  for (const local of obs.allLocals.values()) {
    if (!local.composition) continue; // reported as a coverage gap
    const gross = local.bucket + local.paidOutRecycled;
    const floorTerm =
      gross > local.custodyRelocated ? gross - local.custodyRelocated : 0n;
    const raw = local.composition.creditedRaw;
    const expected = raw >= floorTerm ? raw : floorTerm;
    if (local.reportedCumulative === expected) continue;

    out.push(makeFinding({
      code: 'reported-derivation',
      variant: 'mismatch',
      identity: [local.reportedCumulative, expected],
      severity: 'critical',
      chainId: local.chainId,
      title: 'Reported cumulative does not match its own inputs',
      detail:
        `the chain publishes a lifetime absorption figure this Worker cannot re-derive from the raw slots at the same block\n` +
        `  reported      = ${fmt(local.reportedCumulative)}\n` +
        `  re-derived    = ${fmt(expected)}  = max(creditedRaw, bucket + paidOut - relocated)\n` +
        `  creditedRaw   = ${fmt(local.composition.creditedRaw)}\n` +
        `  bucket        = ${fmt(local.bucket)}\n` +
        `  paidOut       = ${fmt(local.paidOutRecycled)}\n` +
        `  relocated     = ${fmt(local.custodyRelocated)}\n\n` +
        `Either the derivation changed on-chain without this Worker being updated in the same change, or the relocated-custody exclusion has regressed. The figure is what mirrors report to Base and what sizes their funding, so treat a mismatch as load-bearing either way.`,
    }));
  }

  return out;
}

// ─── Windowed advisory signals ────────────────────────────────────────

// Streak state and its transition rules now live in `signal.ts` —
// ROOT-CAUSE FIX #3. Six findings came from each signal re-deriving
// them at its own call site.

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
