/**
 * The short-lived record that a Terms acceptance was mined here
 * (#1961, review rounds 10–11).
 *
 * `useTosAcceptance` waits for the acceptance receipt, so by the time
 * it returns the acceptance is a fact. The reads that follow can still
 * be behind it — a public RPC serving the parent block answers "not
 * accepted" — and until round 10 that answer put the prompt back in
 * front of a wallet that had just paid, and refused its next write.
 *
 * So a read reporting `false` at the exact wallet, chain and version
 * whose receipt was waited for is treated as behind the chain rather
 * than informative about it. Its own module because the two properties
 * that keep that sound are worth testing directly, and both were found
 * by review rather than by me:
 *
 *   - It is BOUNDED (round 11 P1). The correction is for lag, which is
 *     seconds. Unbounded, it also outlives a REORG that orphans the
 *     acceptance: canonical reads then say `false` at the same version
 *     and were rewritten to `true` for as long as the tab stayed open,
 *     holding both gates open on an acceptance that no longer exists.
 *     The repository's own receipt helper notes that a state recheck is
 *     what covers reorgs, and an unbounded override is exactly the
 *     absence of one.
 *   - It outlives a COMPONENT (round 11 P2). Held in a ref, the pin
 *     died whenever `LegalGate` unmounted its owner — which it does the
 *     moment the address disappears — while the cached verdict and the
 *     scheduled re-read both survived. A wallet that briefly
 *     disconnected came back to an empty pin, took the lagging `false`
 *     uncorrected, and was offered a second useless acceptance.
 *
 * Narrowed by MATCHING, never by revocation: an entry carries its own
 * scope and version, so another wallet, another chain or a bumped
 * version simply never matches it. There is no clearing path that can
 * be forgotten, which is the same reasoning that replaced this hook's
 * old sequence counter with a scoped query key.
 *
 * Sound at the contract, not merely by convention: `LegalFacet`
 * records acceptance and offers no way to clear it, and `setCurrentTos`
 * refuses a version that does not strictly increase. So at a matching
 * version, `false` can only mean the node answering is behind — or
 * that the receipt was orphaned, which is what the bound is for.
 *
 * Per-TAB by itself; shared across tabs by broadcast (#2001). The
 * acting tab publishes `{chainId, diamond, address, version, hash, at}`
 * on the receipt-sync rail after pinning locally — the Diamond and the
 * content hash are load-bearing, not incidental (see the frame's field
 * docs in `tosAcceptanceSync.ts`) — and every receiving tab stores the
 * SAME `at` — see `tosAcceptanceSync.ts` for why the TTL must not
 * restart on delivery.
 */

/**
 * How long a mined acceptance may override a `false` read.
 *
 * Far longer than a lagging node needs, far shorter than a user sits on
 * one page. Past it the chain's answer wins, which is the right default
 * for a control the chain does not enforce for itself.
 */
export const ACCEPTANCE_PIN_TTL_MS = 90_000;

/**
 * How far in the future an anchor may sit before it is rejected
 * (#2004 round 4 P1 for frames; round 16 P1 extended it to the pin
 * module itself, because the trusted receipt path bypassed the
 * receiver's check). Tabs on one machine share a clock, so real skew
 * is milliseconds; the allowance exists for coarse clock corrections
 * mid-write, not for trust. Beyond it a future-dated `at` gives the
 * age checks a negative duration — the pin never expires until wall
 * time catches up plus the whole TTL, correcting canonical `false`
 * reads far past the stated bound if the acceptance was orphaned.
 */
export const MAX_FUTURE_SKEW_MS = 5_000;

interface AcceptancePin {
  version: number;
  /** Content hash of the accepted text (#2004 round 4 P1). The version
   *  counter is monotonic only WITHIN one branch: a reorg can replace a
   *  governance update with another at the same number but different
   *  text, and `LegalFacet.hasAcceptedCurrentTerms` compares version
   *  AND hash for exactly that reason. A pin that matched on the
   *  number alone would correct a `false` that is telling the truth
   *  about different terms. */
  hash: string;
  at: number;
  /** The block the acceptance MINED in — the receipt's block on the
   *  acting tab, carried verbatim in the broadcast frame everywhere
   *  else (#2004 round 14). Frame-vs-frame ordering runs on this
   *  rather than on `at` or on version: wall stamps cannot survive a
   *  clock correction, and the version counter orders only within one
   *  branch — a restored lower version after a rollback is NEWER than
   *  the orphaned higher one, which version ordering gets exactly
   *  backwards. Height is a HEURISTIC, not ancestry (round 15): a
   *  reorg to a shorter replacement chain can put newer canonical
   *  evidence BELOW a dead pin's height, and no client-side marker
   *  can prove descent — which is why the locally mined receipt does
   *  not use this ordering at all (`adoptReceiptPin`), and why every
   *  refusal is bounded by the TTL and backed by authoritative
   *  reads. */
  block: number;
  /** The acceptance transaction's index within its block (round 15
   *  P2). Two acceptances in one block — the same wallet acting from
   *  two tabs — are nonce-ordered on chain, and their indices record
   *  that order exactly; wall stamps do not, and can invert under a
   *  clock correction. `at` remains only as the final tiebreak for a
   *  re-broadcast of the SAME transaction. */
  txIndex: number;
  /** This tab's MONOTONIC deadline for the pin, stamped at adoption
   *  (round 26 P1): the monotonic clock reading past which the pin is
   *  dead, however the wall clock reads. Expiry is EITHER bound —
   *  wall-expired OR elapsed-expired — because each clock lies in a
   *  case the other does not: the wall clock rolls backward under a
   *  correction (extending a wall-only window by the whole
   *  correction, papering over an orphaned acceptance far past the
   *  stated bound), while the monotonic clock stalls through a system
   *  sleep (extending an elapsed-only window by the whole nap, which
   *  the wall bound catches). Per-tab by nature — frames carry `at`,
   *  and each receiver stamps its own deadline from the REMAINING
   *  window at delivery, so the cross-tab simultaneous-expiry
   *  property is preserved up to delivery skew. */
  monoDeadline: number;
  /** Adoption sequence number (round 33 P2): which `storePin` call
   *  created this entry, sampled by the heartbeat at every beat.
   *  Poisoning condemns only pins that EXISTED ACROSS the suspect
   *  interval — one adopted after the last beat never spanned the
   *  discontinuity the beat detected, and blanket-poisoning it aged a
   *  freshly aligned acceptance's verdict for a fault that predates
   *  it. Clock-free by construction, like the beat budget. */
  adoptedSeq: number;
  /** Heartbeats observed while this pin has been alive (round 29 P1).
   *  Beats fire only while the page is AWAKE, so the count is a
   *  clock-free lower bound on real elapsed time — the one measure
   *  that survives even an equal sleep-plus-correction, where the
   *  wall and monotonic deltas agree at zero and both expiry bounds
   *  plus the disagreement check are blinded together. A pin whose
   *  beat budget exceeds the TTL has provably outlived its window in
   *  awake time alone, whatever the clocks claim.
   *
   *  DOCUMENTED RESIDUAL (round 30, examined and accepted): the
   *  budget bounds awake time, not the blinded suspension itself, so
   *  a pin created just before such a sleep can still spend its full
   *  budget after resume. This is where in-page detection ENDS, not
   *  an oversight: the web platform has no reliable event for system
   *  sleep (Page Lifecycle freeze/resume is background-tab freezing;
   *  `visibilitychange` fires identically for a two-second tab
   *  switch and a blinded two-hour sleep, and the two are
   *  indistinguishable at resume PRECISELY because the scenario is
   *  defined by the clocks agreeing) — and poisoning on every
   *  return-to-visible would destroy the feature's primary flow, the
   *  hidden tab that received the acceptance frame and is switched
   *  to moments later. The scenario needs a wall correction matching
   *  the sleep within the 5s allowance — outside deliberate clock
   *  manipulation a negligible coincidence, and this gate is
   *  client-side enforcement whose threat model is accidents, not an
   *  operator of the machine, who could bypass it in devtools.
   *  Exposure even then is bounded below one TTL of awake time by
   *  this budget, and every read served by a current node replaces
   *  the verdict outright throughout. */
  beats: number;
}

const pins = new Map<string, AcceptancePin>();
let adoptionCounter = 0;

/**
 * Event-driven clock witness (#2004 round 41 P1). The round-34 check
 * proves the LOCAL receipt's anchor crossed no discontinuity — it
 * holds both of the acting tab's stamps. A REMOTE frame's anchor is
 * the sender's claim about the past, and the receiver's heartbeat
 * cannot vet it: a frame whose delivery was delayed across a
 * backward wall correction arrives claiming a young age (the
 * correction subtracted from it), is adopted AFTER the fault — so
 * the round-33 `adoptedSeq` sparing exempts it from delta poisoning
 * — and when it is the receiver's first pin, the heartbeat was not
 * even running when the fault happened. So the receiver validates
 * the CLAIMED INTERVAL at adoption instead: every observation point
 * (each `adoptOrderedPin`, each `acceptanceIsPinned` — the Terms
 * poll calls it — and each heartbeat beat) compares the wall clock's
 * step since the previous observation against the monotonic step,
 * and a wall step more than the skew allowance BEHIND the monotonic
 * one records a fault. A frame whose claimed age reaches back past
 * the latest fault is refused — its window spans an interval the
 * receiver knows its wall clock misrepresents — and the refusal
 * lands on the ordinary read-hint path. Only BACKWARD discontinuities
 * are recorded, deliberately: a forward jump (and a resume from
 * sleep, where the wall ran while the monotonic clock stalled) makes
 * frames look OLDER, which the expiry checks already fail closed on.
 * The latest fault alone suffices: a claimed interval reaching any
 * older fault necessarily reaches the newer one first. Residual,
 * stated plainly: a tab whose very first clock observation postdates
 * the fault has no witness spanning it and cannot detect it — the
 * TTL, the verdict-write guards and the expiry aging bound that
 * exposure exactly as they bound every other unmeasurable interval.
 */
let witnessWall = 0;
let witnessMono = 0;
let lastFaultMono: number | null = null;

function observeClockWitness(now: number): void {
  const mono = monoNow();
  if (witnessWall !== 0 && now - witnessWall - (mono - witnessMono) < -MAX_FUTURE_SKEW_MS) {
    lastFaultMono = mono;
  }
  witnessWall = now;
  witnessMono = mono;
}

/** True when a claimed age reaches back across the latest recorded
 *  backward wall discontinuity — the interval is unmeasurable and a
 *  pin must not be built on it. */
function claimedAgeSpansFault(claimedMs: number): boolean {
  return lastFaultMono !== null && claimedMs > monoNow() - lastFaultMono;
}

/**
 * Record a clock observation from OUTSIDE the pin machinery (#2004
 * round 42 P1). The Terms poll was assumed to feed the witness
 * through `acceptanceIsPinned` — but the queryFn consults the pin
 * only behind `!accepted`, so a wallet whose polls keep answering
 * `accepted: true` never touched it, and the witness sat completely
 * uninitialized through any discontinuity. A delayed frame then made
 * `adoptOrderedPin` the FIRST observation, with no earlier witness
 * to convict its claimed age against. The poll now records an
 * observation on every COMPLETED snapshot, whatever it answered —
 * a clock sample is about the clocks, not the verdict.
 */
export function observeAcceptanceClock(now: number): void {
  observeClockWitness(now);
}

const defaultMonoNow = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();
let monoNow: () => number = defaultMonoNow;

/** Test seam for the monotonic clock — production never touches it. */
export function __setMonoNowForTests(fn: (() => number) | null): void {
  monoNow = fn ?? defaultMonoNow;
}

/** The module's monotonic clock, exported for the ONE caller that
 *  needs to measure an interval against it (round 34 P1): the accept
 *  path stamps its submission on this clock as well as the wall, so
 *  that at settlement it can tell whether the anchor CROSSED a
 *  discontinuity — the two elapsed measures disagreeing — before any
 *  pin is adopted on it. Same seam as everything else here. */
export function monotonicNow(): number {
  return monoNow();
}

/** Dead by EITHER clock — see `monoDeadline` for why both. */
function pinExpired(pin: AcceptancePin, now: number): boolean {
  return now - pin.at > ACCEPTANCE_PIN_TTL_MS || monoNow() > pin.monoDeadline;
}

/**
 * The two expiry clocks can be blinded TOGETHER (round 27 P1): on
 * platforms where the monotonic clock stalls through a system sleep,
 * a wall correction applied DURING that sleep leaves neither bound
 * having observed the suspension — the wall window gained the
 * correction, the elapsed window gained the nap. No clock readable
 * from inside the page can measure that interval, so the fail-closed
 * answer is detection rather than measurement: while any pin lives, a
 * heartbeat watches for the wall clock REGRESSING between beats (the
 * signature both blinding scenarios share), and on detecting one it
 * poisons every pin's monotonic deadline. Poisoned — not deleted:
 * death through `pinExpired` lets the expiry timers observe
 * `expired` and AGE the pin-backed verdicts they guard, where a bare
 * deletion would read as `superseded` and leave those verdicts
 * coasting (round 20's orphan, deliberately avoided). The heartbeat
 * runs only while pins exist — at most a handful of beats per
 * 90-second window — and a correction smaller than the shared skew
 * allowance is tolerated as ordinary adjustment.
 */
const CLOCK_REGRESSION_CHECK_MS = 10_000;
let lastBeatWall = 0;
let lastBeatMono = 0;
let lastBeatAdoption = 0;
let beatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Listeners the heartbeat WAKES when it poisons pins (#2004 round 29
 * P1). Poisoning alone only changes deadlines; the pin-backed
 * VERDICTS those pins were vouching for stay fresh in the query
 * cache until each expiry timer's next wake — up to a whole recheck
 * cadence during which both gates keep trusting a verdict this
 * module has already ruled untrustworthy. Each scheduled expiry
 * revalidation registers its check here and removes it on its own
 * terminal paths, so a poison event runs every live check at once:
 * the checks observe `expired`, age their verdicts, and trigger the
 * authoritative reads immediately.
 */
const poisonListeners = new Set<() => void>();

export function onPinsPoisoned(listener: () => void): () => void {
  poisonListeners.add(listener);
  return () => {
    poisonListeners.delete(listener);
  };
}

function stopClockWatch(): void {
  if (beatTimer !== null) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}

function ensureClockWatch(): void {
  if (beatTimer !== null) return;
  lastBeatWall = Date.now();
  lastBeatMono = monoNow();
  lastBeatAdoption = adoptionCounter;
  beatTimer = setInterval(() => {
    const wall = Date.now();
    const mono = monoNow();
    // Beats are clock observations too (round 41 P1) — they keep the
    // witness fresh while pins live, so a fault the delta check
    // below detects is also on record for later adoptions.
    observeClockWitness(wall);
    // The AWAKE-TIME budget (round 29 P1): each beat represents about
    // one check interval of awake time, and real elapsed time is
    // never less than awake time — so a pin that has been observed
    // by more beats than fit in its TTL is dead however the clocks
    // read. This is the bound that survives an equal
    // sleep-plus-correction, which blinds the wall bound, the
    // monotonic bound, AND the delta check below all at once. It can
    // only ever SHORTEN a window (late beats under-count awake time,
    // never over-count), which is the safe direction.
    let poisoned = false;
    for (const pin of pins.values()) {
      pin.beats += 1;
      if (pin.beats * CLOCK_REGRESSION_CHECK_MS > ACCEPTANCE_PIN_TTL_MS) {
        pin.monoDeadline = Number.NEGATIVE_INFINITY;
        poisoned = true;
      }
    }
    // The signature of a compromised interval is the two clocks
    // DISAGREEING about how long it lasted (round 28 P1 — a plain
    // regression check missed a correction applied during a sleep,
    // where the wall clock can still show NET FORWARD movement while
    // real elapsed time exceeded it). Awake, both clocks advance in
    // lockstep — a late-firing beat inflates both deltas equally, so
    // their difference is jitter-immune — while a sleep stalls the
    // monotonic side and a correction moves only the wall side, each
    // pulling the deltas apart. Past the skew allowance the true
    // elapsed time is unknowable, and unknowable means fail closed.
    if (Math.abs(wall - lastBeatWall - (mono - lastBeatMono)) > MAX_FUTURE_SKEW_MS) {
      for (const pin of pins.values()) {
        // Only pins that SPANNED the suspect interval are condemned
        // (round 33 P2): one adopted since the last beat is anchored
        // on the post-discontinuity clocks and never crossed the
        // fault the deltas detected.
        if (pin.adoptedSeq <= lastBeatAdoption) {
          pin.monoDeadline = Number.NEGATIVE_INFINITY;
          poisoned = true;
        }
      }
    }
    if (poisoned) {
      // Wake every scheduled expiry check NOW (round 29 P1) — the
      // verdicts resting on the poisoned pins must stop being served
      // at the moment of the ruling, not at the next cadence.
      for (const listener of [...poisonListeners]) listener();
    }
    lastBeatWall = wall;
    lastBeatMono = mono;
    lastBeatAdoption = adoptionCounter;
    if (pins.size === 0) stopClockWatch();
  }, CLOCK_REGRESSION_CHECK_MS);
}

function storePin(
  scope: string,
  version: number,
  hash: string,
  at: number,
  block: number,
  txIndex: number,
  now: number,
): void {
  pins.set(scope, {
    version,
    hash,
    at,
    block,
    txIndex,
    // The monotonic deadline mirrors the WALL window remaining at
    // adoption, so the two bounds start aligned and only ever diverge
    // when one of the clocks misbehaves.
    monoDeadline: monoNow() + Math.max(0, at + ACCEPTANCE_PIN_TTL_MS - now),
    beats: 0,
    adoptedSeq: ++adoptionCounter,
  });
  ensureClockWatch();
}

/**
 * Resolve a SAME-TERMS candidate against a live incumbent by keeping
 * ONE evidence WHOLE — the later-anchored one (round 28 P1, replacing
 * round 27's field-wise merge). Identical terms protect identically,
 * so the window (round 25) picks the survivor; what round 28 forbade
 * is stitching FIELDS from different receipts together, because with
 * same-terms acceptances possible on COMPETING FORKS, a pairing of
 * one fork's height with the other's renewed window is evidence no
 * receipt supplied — and it then outranks a canonical differing frame
 * from between the heights, holding both gates open under possibly
 * obsolete terms for the synthesized window. The asymmetry decides
 * which flaw to keep: selecting whole evidence can LOSE an ordering
 * stand the discarded receipt genuinely had (round 27's mid-height
 * rival then beats the pin), but that failure is fail-closed — the
 * rival's adoption retires the pin, ages its verdict, and reads
 * decide — while the synthesized pairing fails OPEN. A legal gate
 * takes the closed failure.
 */
function keepLaterSameTermsEvidence(
  scope: string,
  existing: AcceptancePin,
  at: number,
  block: number,
  txIndex: number,
  now: number,
): void {
  if (existing.at >= at) {
    ensureClockWatch();
    return;
  }
  storePin(scope, existing.version, existing.hash, at, block, txIndex, now);
}

/** Identifies one wallet on one chain. Acceptance is recorded per
 *  wallet and per network, so both belong in the key. */
export function acceptanceScope(chainId: number, address: string | undefined): string {
  return `${chainId}:${address?.toLowerCase() ?? ''}`;
}

/** Record this scope's acceptance of `version` unconditionally. Kept
 *  as the pin's primitive and for its own unit surface; production
 *  paths never call it. Remote frames adopt through `adoptOrderedPin`
 *  (delivery is not globally ordered, so a straggler must be
 *  refusable), and the acting tab's own receipt through
 *  `adoptReceiptPin` (trusted, but refusable on its own expiry) —
 *  the split is deliberate, see each function for which review
 *  rounds forced it. */
export function pinAcceptance(
  scope: string,
  version: number,
  hash: string,
  block: number,
  txIndex: number,
  now: number,
): void {
  storePin(scope, version, hash, now, block, txIndex, now);
}

/**
 * Adopt a REMOTE frame's pin WITHOUT letting a stale one regress a
 * newer one (#2004 review round 1 P2). Delivery is not globally
 * ordered across senders. One pin per scope means an unconditional
 * `set` would REPLACE the newer pin with the older; the cache guard
 * keeps the newer verdict, but the next lagging `false` read at that
 * version would find only the old pin — uncorrectable, prompt
 * re-armed, second payment back on the table.
 *
 * Ordering is by the acceptance's chain position — (mined block,
 * transaction index), with `at` only as the duplicate tiebreak
 * (#2004 rounds 14 and 15). The markers this used to order by are
 * each wrong in a case the others are not:
 *
 *   - VERSION ordering is monotonic only within one branch. After a
 *     rollback restores a lower version, the orphaned higher-version
 *     pin outranked every newly mined acceptance of the restored one
 *     (round 13 P2's bug) — the round-13 fix special-cased the local
 *     receipt, but a remote frame for the restored version hit the
 *     same wall.
 *   - WALL-STAMP ordering does not survive a clock correction: a
 *     receipt submitted after a backward shift carries a smaller `at`
 *     than an incumbent stamped before it, and the genuinely newer
 *     evidence lost (round 14 P2).
 *
 * Within a branch, (block, txIndex) is exactly acceptance order.
 * Across branches it is a heuristic — round 15 P2: a reorg to a
 * shorter replacement chain can mine newer canonical evidence BELOW a
 * dead pin's height, and this ordering will refuse it. That residual
 * is deliberate and bounded: a frame is hearsay about history, the
 * refusal still runs the authoritative reads (the receiver's rule),
 * and the wrong incumbent cannot outlive its TTL. The locally mined
 * receipt — the one piece of evidence that is NOT hearsay — does not
 * take this ordering at all; see `adoptReceiptPin`.
 *
 * Returns whether the pin was adopted, so callers can gate everything
 * that must not outrun ordering — the cache write, the broadcast — on
 * the same decision.
 *
 * An EXPIRED incumbent is discarded before the comparison (#2004 round
 * 3 P2). Without that, ordering rejects on the corpse of a pin: a dead
 * higher-block pin would refuse every newly mined acceptance for ever,
 * since nothing else deletes a pin whose version no longer matches
 * reads — leaving the fresh receipt unpinned and unbroadcast while
 * lagging reads keep offering another paid acceptance. Past the bound
 * a pin has no authority left to reject with.
 *
 * An expired CANDIDATE is refused outright (round 15 P2): a pin
 * carries the acting tab's `at`, and a delivery — or a suspended
 * continuation — arriving past that window must apply nothing, the
 * same rule the receiver applies to expired frames. Adopting it would
 * store a pin already dead on arrival while telling the caller to
 * write and broadcast on its authority. A candidate dated in the
 * FUTURE beyond the skew allowance is refused for the mirrored
 * reason (round 16 P1): its negative age passes every expiry check
 * until wall time catches up, an unbounded override from one bad
 * timestamp.
 */
export function adoptOrderedPin(
  scope: string,
  version: number,
  hash: string,
  at: number,
  block: number,
  txIndex: number,
  now: number,
): boolean {
  observeClockWitness(now);
  if (now - at > ACCEPTANCE_PIN_TTL_MS || at > now + MAX_FUTURE_SKEW_MS) return false;
  // Round 41 P1: a claimed age reaching back across a backward wall
  // discontinuity is unmeasurable — the correction was subtracted
  // from it, so the anchor can be arbitrarily older than it appears
  // and the pin would outlive its real window. Refused like any
  // other untrustworthy anchor; the caller's read-hint path carries
  // the case. See `observeClockWitness`.
  if (claimedAgeSpansFault(now - at)) return false;
  let existing = pins.get(scope);
  if (existing && pinExpired(existing, now)) {
    pins.delete(scope);
    existing = undefined;
  }
  if (existing && existing.version === version && existing.hash === hash) {
    // SAME terms — a duplicate re-broadcast, or a genuine second
    // acceptance of identical text. The later-anchored EVIDENCE is
    // kept whole (rounds 25, 27 and 28 — see
    // `keepLaterSameTermsEvidence` for why whole, not merged).
    keepLaterSameTermsEvidence(scope, existing, at, block, txIndex, now);
    return true;
  } else if (existing && existing.block === block && existing.txIndex === txIndex) {
    // Two DIFFERENT transactions claiming one chain position can
    // only be fork rivals (round 19 P2), and frames carry no branch
    // identity to order them — a wall-stamp tiebreak here handed
    // the win to whichever clock said so, which a backward
    // correction inverts. Unordered means NEITHER holds authority:
    // the incumbent is retired, the candidate refused, and the
    // caller's refusal path schedules the authoritative reads that
    // alone can say which fork won. No pin corrects either
    // version's reads until a real acceptance re-establishes one.
    pins.delete(scope);
    return false;
  } else if (
    existing &&
    (existing.block > block || (existing.block === block && existing.txIndex > txIndex))
  ) {
    return false;
  }
  storePin(scope, version, hash, at, block, txIndex, now);
  return true;
}

/**
 * Trusted adoption for the tab's OWN just-settled receipt (#2004
 * round 13 P2, retired in round 14, restored in round 15 P2 — this
 * time with no comparison at all, which is what makes it stable).
 *
 * A receipt this tab watched settle moments ago is the newest
 * canonical fact it holds: `acceptTerms` reverts unless its version
 * and hash are current, so the settling node vouched for them at the
 * chain head it serves. Any incumbent pin is at best ninety-second-old
 * hearsay. The attempts to ORDER receipt against incumbent each fell
 * to a case the chosen marker could not see — version ordering to a
 * rollback (round 13), wall stamps to a clock correction (round 14),
 * height to a shorter replacement chain (round 15) — because no
 * client-side marker proves ancestry. So the receipt does not order;
 * it supersedes. The refusals left are the anchor's own bounds
 * (rounds 15 P2 and 16 P1): a continuation resuming from a
 * suspension longer than the TTL carries an anchor already outside
 * the safety window, and one resuming across a backward clock
 * correction can carry an anchor in the FUTURE, whose negative age
 * would never expire until wall time caught up. Either way nothing
 * is applied — the caller's authoritative reads take the case,
 * exactly like an expired frame. These refusals are deliberate, not
 * a gap: review rounds 16–22 tried to rebuild a trustworthy anchor
 * for the long-pending case from RPC block samples, and retired the
 * idea — ancestry is not provable from unpinned samples, and a
 * receipt older than the TTL needs no lag correction anyway (every
 * node lagging by less than the TTL already serves it). The
 * caller's fresh-read conflict guard still runs FIRST, so a receipt
 * this tab has already read past never reaches here.
 */
export function adoptReceiptPin(
  scope: string,
  version: number,
  hash: string,
  at: number,
  block: number,
  txIndex: number,
  now: number,
): boolean {
  if (now - at > ACCEPTANCE_PIN_TTL_MS || at > now + MAX_FUTURE_SKEW_MS) return false;
  const existing = pins.get(scope);
  // A LIVE incumbent for the SAME terms resolves by whole-evidence
  // selection, exactly as on the frame path (rounds 25/27/28 — see
  // `keepLaterSameTermsEvidence`): the later-anchored evidence
  // stands whole, and the receipt is fully believed either way.
  if (
    existing &&
    existing.version === version &&
    existing.hash === hash &&
    !pinExpired(existing, now)
  ) {
    keepLaterSameTermsEvidence(scope, existing, at, block, txIndex, now);
    return true;
  }
  storePin(scope, version, hash, at, block, txIndex, now);
  return true;
}

/**
 * True when a `false` read at this version is known to be behind the
 * chain rather than informative about it.
 *
 * An expired pin is deleted rather than merely ignored, so a long
 * session cannot accumulate them.
 */
export function acceptanceIsPinned(
  scope: string,
  version: number,
  hash: string,
  now: number,
): boolean {
  // Every consult is a clock observation (round 41 P1): the Terms
  // poll calls this each cycle, so the witness stays fresh from boot
  // even while no pin exists — which is what lets an adoption after
  // a discontinuity know the fault happened at all.
  observeClockWitness(now);
  const pin = pins.get(scope);
  if (!pin) return false;
  // Expiry is checked BEFORE the match (#2004 round 3 P2): checked
  // after, a dead pin at a version reads no longer report was never
  // deleted, and its corpse outranked fresh acceptances in
  // `adoptOrderedPin`'s ordering. Dead by EITHER clock (round 26 P1).
  if (pinExpired(pin, now)) {
    pins.delete(scope);
    return false;
  }
  // Version AND hash, mirroring the contract's own acceptance
  // comparison — see the pin's `hash` field for the reorg case this
  // closes (#2004 round 4 P1).
  return pin.version === version && pin.hash === hash;
}

/**
 * Retire a live pin that an authoritative read has SUPERSEDED (#2004
 * round 17 P1). The adoption guards stop a stale pin ARRIVING; this
 * stops one SURVIVING: with a v3 pin live when governance installs
 * v4, a node-confirmed v4 read correctly re-prompts but used to leave
 * the v3 pin in the map — and a later refetch through an RPC still
 * serving v3 then matched it, converting that node's truthful `false`
 * into a fresh `accepted: true` under terms no longer in force.
 *
 * Retirement is deliberately ONE-DIRECTIONAL: only a read at a HIGHER
 * version (governance strictly increases within a branch, so the
 * pin's version is provably behind) or at the SAME version under a
 * different hash (the reorged-text case — the fresh read is the
 * better witness to which text stands) retires the pin. A read at a
 * LOWER version than the pin is a lagging node — retiring on it
 * would destroy the exact correction the pin exists to make. The
 * rollback residual that leaves (an orphaned higher-version pin
 * surviving lower-version canonical reads) only ever corrects reads
 * AT the orphaned version, and stays bounded by the TTL and the
 * scheduled reads, as everywhere else in this module.
 */
export function retireSupersededPin(scope: string, version: number, hash: string): void {
  const pin = pins.get(scope);
  if (!pin) return;
  if (version > pin.version || (version === pin.version && hash !== pin.hash)) {
    pins.delete(scope);
  }
}

/**
 * How long an acceptance offer is HELD after unverifiable evidence
 * that an acceptance happened arrives (#2004 round 37 P1). An
 * out-of-window frame, a read hint, an unanchorable local receipt —
 * each says "someone accepted; go read" without supporting a pin, and
 * the reads they schedule take seconds to land. In that window a
 * cached `accepted: false` served by a lagging RPC keeps another
 * tab's Accept button enabled, offering exactly the redundant paid
 * re-acceptance this module exists to prevent — the pin used to close
 * that window, and an unpinnable acceptance has nothing else to close
 * it with. The hold is NON-TRUSTING: it opens no gate and writes no
 * verdict, it only withholds the OFFER of a second payment while the
 * scheduled reads reconcile. Bounded deliberately: held forever, a
 * stray or malicious same-origin broadcast could disable acceptance
 * outright, and past the bound the chain-follower posture applies as
 * everywhere else — the reads have had their chance, and a `false`
 * still standing is the chain's answer to act on. Covers the
 * immediate read, the 4-second delayed read, and ordinary RPC
 * latency on both.
 *
 * The deadline is MONOTONIC, not wall-clock (round 38 P2): a wall
 * deadline is moved by exactly the clock corrections this module
 * spends half its code defending against — a backward correction
 * strands the disabled button until wall time catches up, and a
 * forward one releases the hold before the delayed read has fired,
 * reopening the redundant-payment window the hold exists to close.
 * The monotonic clock measures the elapsed 15 seconds regardless; it
 * stalls only through a system sleep, during which nobody is
 * clicking, and on resume at most the remainder of one hold is left.
 */
export const ACCEPTANCE_RECONCILIATION_HOLD_MS = 15_000;

/**
 * The most a SEQUENCE of re-armed holds may keep the offer withheld
 * (#2004 round 40 P2). Every arm used to replace the deadline with a
 * fresh window, so a peer tab publishing frames faster than the
 * window — stale, buggy, or hostile — kept the Accept action disabled
 * indefinitely: an untrusted cross-tab hint turned into a persistent
 * denial of the only recovery action. A sequence's cap is anchored at
 * its FIRST arm; arms within the sequence extend the hold only up to
 * that cap, and — the part that makes the cap real — a NEW sequence
 * is granted only after the scope has been HOLD-FREE for a full
 * window, measured from `until` (round 41 P2 — measuring quiet from
 * the last ARM handed sequence identity to the sender's timing, and
 * a peer arming on exactly the window's period got a fresh cap every
 * arm with the button never observably enabled). So a lone burst
 * behaves exactly as before, a genuine flurry (an acceptance plus
 * its re-broadcasts) gets at most three windows, and whatever the
 * arrival pattern, between any two hold sequences the user gets one
 * full window of enabled button — chatter can degrade availability,
 * never abolish it. The reads have had three windows per sequence;
 * a `false` still standing is the chain's answer the user may act on
 * — and the redundant-payment protection this hold provides is, like
 * the rest of this module, a guard against accidents, not against an
 * operator of the same origin, who could bypass it in devtools.
 */
export const ACCEPTANCE_RECONCILIATION_HOLD_CAP_MS = 45_000;

interface ReconciliationHold {
  /** Monotonic deadline the offer is withheld until. */
  until: number;
  /** The sequence's hard ceiling — first arm plus the cap. */
  cap: number;
}

const reconciliationHolds = new Map<string, ReconciliationHold>();

/** Listeners notified when a hold is ARMED (round 38 P2). The map
 *  write alone is invisible to React — with a cached `false` verdict
 *  already in place, the invalidation that accompanies a hold changes
 *  only query properties the hook does not track, so nothing
 *  re-renders and the button stays enabled for the very window the
 *  hold is meant to cover. The mounted hook subscribes here and turns
 *  the event into state; release needs no event, because the
 *  subscriber arms its own timer for the hold's remaining life. */
const holdListeners = new Set<() => void>();

export function onAcceptanceHoldsChanged(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => {
    holdListeners.delete(listener);
  };
}

/** Arm (or re-arm) the scope's reconciliation hold. Called by every
 *  read-hint path — the paths that know an acceptance happened but
 *  cannot pin it. Bounded per SEQUENCE, not per arm — see
 *  `ACCEPTANCE_RECONCILIATION_HOLD_CAP_MS` (round 40 P2). */
export function holdAcceptanceForReconciliation(scope: string): void {
  const now = monoNow();
  const existing = reconciliationHolds.get(scope);
  // The same unresolved sequence continues until the scope has been
  // HOLD-FREE for a full window — quiet measured from `until`, the
  // moment the button actually re-enabled, and from nothing else
  // (round 41 P2). The previous rule measured quiet from the last
  // ARM, which the sender controls: a peer arming on exactly the
  // window's period (or a hair over) made every arm a "fresh"
  // sequence with a fresh cap, while the hook's release timer wakes
  // just after each deadline — so the button was never observably
  // enabled at all. `until` is the one stamp a capped sequence's
  // arms cannot move, so whatever the arrival pattern, a new cap is
  // only ever granted after the user has had one full window of
  // enabled button. Under continuous chatter the worst case is now a
  // 45-second hold, a guaranteed 15-second enabled window, repeat —
  // never an unbroken denial — and a click during any hold still
  // resolves through the accept path's bounded wait-out.
  const sameSequence =
    existing !== undefined && now < existing.until + ACCEPTANCE_RECONCILIATION_HOLD_MS;
  const cap = sameSequence ? existing.cap : now + ACCEPTANCE_RECONCILIATION_HOLD_CAP_MS;
  reconciliationHolds.set(scope, {
    until: Math.min(now + ACCEPTANCE_RECONCILIATION_HOLD_MS, cap),
    cap,
  });
  for (const listener of [...holdListeners]) listener();
}

/** True while the scope's acceptance offer should be withheld.
 *  Deliberately NON-MUTATING: entries are overwritten on re-arm and
 *  the map holds at most one entry per wallet/chain actually used. */
export function acceptanceReconciling(scope: string): boolean {
  return acceptanceReconciliationRemainingMs(scope) > 0;
}

/** The hold's remaining life in elapsed milliseconds — 0 when none.
 *  What the hook's release timer and the accept path's wait-out loop
 *  sleep against, so both track the SAME monotonic deadline the
 *  predicate reads. */
export function acceptanceReconciliationRemainingMs(scope: string): number {
  const hold = reconciliationHolds.get(scope);
  return hold === undefined ? 0 : Math.max(0, hold.until - monoNow());
}

/**
 * Retire whatever pin the scope holds when it DIFFERS from a
 * just-settled LOCAL receipt's terms (#2004 round 36 P1). The
 * receipt-supersedes doctrine (`adoptReceiptPin`) normally replaces a
 * differing incumbent as a side effect of storing the receipt's own
 * pin — but an UNANCHORABLE receipt (anchor expired, future-dated, or
 * inconsistent across a clock discontinuity) stores nothing, and the
 * incumbent hearsay then survived a settlement this tab watched
 * disprove it: in a rollback where the local receipt settles for the
 * restored terms, the orphaned terms' pin kept correcting reads until
 * its own TTL. The receipt's authority to supersede does not depend
 * on its anchor — only the pin it may INSTALL does — so the caller
 * retires the differing incumbent explicitly and installs nothing.
 *
 * DIRECTIONLESS on purpose, unlike `retireSupersededPin`: that
 * function is driven by an ordinary READ, which a lagging node makes
 * untrustworthy in the lower-version direction; this one is driven by
 * a receipt this tab watched settle, which supersedes without
 * comparison (round 15 — every marker tried for ordering the two fell
 * to a case it could not see). A SAME-terms incumbent is kept: it
 * corroborates the receipt and carries its own valid anchor and
 * expiry machinery, which deleting would orphan.
 *
 * The caller must age any pin-backed verdict resting on the retired
 * pin in the same breath: deletion reads as `superseded` to that
 * verdict's expiry timer — silence — so nothing else will.
 */
export function retireDifferingPin(scope: string, version: number, hash: string): void {
  const pin = pins.get(scope);
  if (!pin) return;
  if (pin.version !== version || pin.hash !== hash) {
    pins.delete(scope);
  }
}

/** What the expiry timer sees when it looks at its own pin. */
export type PinExpiryObservation =
  | { state: 'live'; remainingMs: number }
  | { state: 'expired' }
  | { state: 'superseded' };

/**
 * The expiry revalidation timer's view of its exact pin (scope,
 * version AND hash), in three states the timer treats differently
 * (#2004 rounds 11, 17 and 18):
 *
 *   - `live` — the pin has life left on BOTH clocks, with the
 *     tighter remainder: the timer re-arms rather than skipping once
 *     and never returning (round 11 P2), and since round 26 P1 a
 *     backward wall correction no longer extends the window — the
 *     monotonic deadline stamped at adoption keeps counting real
 *     elapsed time, so an orphaned acceptance dies on schedule
 *     however the wall clock reads.
 *   - `expired` — this exact pin was observed past its TTL and is
 *     RETIRED here, not merely reported (round 18 P1): returned
 *     un-deleted, a later backward clock correction made
 *     `acceptanceIsPinned` see the corpse as young again and
 *     resurrect the correction — with the timer already terminated,
 *     so nothing was left to age what it manufactured. Observation
 *     of death is the retirement.
 *   - `superseded` — the scope holds no pin, or a DIFFERENT one: a
 *     newer acceptance or a superseding read replaced this timer's
 *     pin, and the replacement's own machinery owns freshness now.
 *     The distinction from `expired` matters (round 18 P2): the old
 *     timer must go silent rather than refetch, because its refetch
 *     can hit a node still serving the PREVIOUS version — which the
 *     replacement pin, matching only its own version, cannot correct
 *     — regressing the cache to an obsolete refusal.
 */
export function observePinExpiry(
  scope: string,
  version: number,
  hash: string,
  now: number,
): PinExpiryObservation {
  const pin = pins.get(scope);
  if (!pin || pin.version !== version || pin.hash !== hash) return { state: 'superseded' };
  if (pinExpired(pin, now)) {
    pins.delete(scope);
    return { state: 'expired' };
  }
  // Remaining life is the TIGHTER of the two bounds (round 26 P1): a
  // rolled-back wall clock reports a large wall remainder, but the
  // monotonic deadline keeps counting real elapsed time, so the
  // re-arm sleeps toward whichever bound lands first rather than
  // extending the window by the size of the correction.
  const wallRemaining = ACCEPTANCE_PIN_TTL_MS - (now - pin.at);
  const monoRemaining = pin.monoDeadline - monoNow();
  return { state: 'live', remainingMs: Math.max(0, Math.min(wallRemaining, monoRemaining)) };
}

/** Test seam only — the app never forgets a pin, it lets it expire. */
export function __clearAcceptancePins(): void {
  pins.clear();
  reconciliationHolds.clear();
  holdListeners.clear();
  witnessWall = 0;
  witnessMono = 0;
  lastFaultMono = null;
  stopClockWatch();
  lastBeatWall = 0;
  lastBeatMono = 0;
  lastBeatAdoption = 0;
  adoptionCounter = 0;
  // Scheduled revalidations from a finished test would otherwise stay
  // subscribed and answer a later test's poison event first — deleting
  // the shared-scope pin before that test's own check can observe it.
  poisonListeners.clear();
}
