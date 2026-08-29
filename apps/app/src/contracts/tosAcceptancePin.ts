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
}

const pins = new Map<string, AcceptancePin>();

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
  pins.set(scope, { version, hash, at: now, block, txIndex });
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
  if (now - at > ACCEPTANCE_PIN_TTL_MS || at > now + MAX_FUTURE_SKEW_MS) return false;
  let existing = pins.get(scope);
  if (existing && now - existing.at > ACCEPTANCE_PIN_TTL_MS) {
    pins.delete(scope);
    existing = undefined;
  }
  if (
    existing &&
    (existing.block > block ||
      (existing.block === block && existing.txIndex > txIndex) ||
      (existing.block === block && existing.txIndex === txIndex && existing.at >= at))
  ) {
    return false;
  }
  pins.set(scope, { version, hash, at, block, txIndex });
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
 * exactly like an expired frame. (The caller narrows both windows
 * first: it clamps a future submission stamp to its own clock and
 * re-anchors a long-pending receipt at its mined block's timestamp,
 * so these guards are the backstop, not the common path.) The
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
  pins.set(scope, { version, hash, at, block, txIndex });
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
  const pin = pins.get(scope);
  if (!pin) return false;
  // Expiry is checked BEFORE the match (#2004 round 3 P2): checked
  // after, a dead pin at a version reads no longer report was never
  // deleted, and its corpse outranked fresh acceptances in
  // `adoptOrderedPin`'s ordering.
  if (now - pin.at > ACCEPTANCE_PIN_TTL_MS) {
    pins.delete(scope);
    return false;
  }
  // Version AND hash, mirroring the contract's own acceptance
  // comparison — see the pin's `hash` field for the reorg case this
  // closes (#2004 round 4 P1).
  return pin.version === version && pin.hash === hash;
}

/**
 * Wall-clock milliseconds this exact pin (scope, version AND hash) has
 * left, or null when no matching live pin exists. Read-only — deletion
 * of expired pins stays with `acceptanceIsPinned`. Exists for the
 * expiry revalidation timer (#2004 round 11 P2): a MONOTONIC timeout
 * can fire while a backward-shifted wall clock still considers the pin
 * live, and the timer must know how long to re-arm for rather than
 * skipping once and never returning.
 */
export function pinRemainingMs(
  scope: string,
  version: number,
  hash: string,
  now: number,
): number | null {
  const pin = pins.get(scope);
  if (!pin || pin.version !== version || pin.hash !== hash) return null;
  const remaining = ACCEPTANCE_PIN_TTL_MS - (now - pin.at);
  return remaining > 0 ? remaining : null;
}

/** Test seam only — the app never forgets a pin, it lets it expire. */
export function __clearAcceptancePins(): void {
  pins.clear();
}
