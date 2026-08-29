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
}

const pins = new Map<string, AcceptancePin>();

/** Identifies one wallet on one chain. Acceptance is recorded per
 *  wallet and per network, so both belong in the key. */
export function acceptanceScope(chainId: number, address: string | undefined): string {
  return `${chainId}:${address?.toLowerCase() ?? ''}`;
}

/** Record this scope's acceptance of `version` unconditionally. Kept
 *  as the pin's primitive and for its own unit surface; every
 *  PRODUCTION path — the acting tab's own receipt included — adopts
 *  through `adoptOrderedPin` instead, because once acceptances can
 *  arrive from other tabs, even a locally mined receipt is not
 *  necessarily the newest fact this tab holds (#2004 round 2 P1: a
 *  slow RPC can deliver the local v3 receipt AFTER another tab's v4
 *  broadcast has been applied here). */
export function pinAcceptance(
  scope: string,
  version: number,
  hash: string,
  now: number,
): void {
  pins.set(scope, { version, hash, at: now });
}

/**
 * Adopt a pin — from the broadcast OR from a locally settled receipt —
 * WITHOUT letting a stale one regress a newer one (#2004 review round
 * 1 P2, extended to the local path in round 2 P1). Delivery is not
 * globally ordered across senders, and a local `write` promise can
 * resolve after a newer remote acceptance was applied here. One pin
 * per scope means an unconditional `set` would REPLACE the v4 pin
 * with v3; the cache guard keeps the v4 verdict, but the next lagging
 * `false` read at v4 would find only a v3 pin — uncorrectable, prompt
 * re-armed, second payment back on the table. So a pin is adopted
 * only when it is strictly newer: a higher version, or the same
 * version with a later timestamp (a genuine later acceptance of the
 * same version — the chain permits one — whose longer window is
 * anchored to a real receipt).
 *
 * Returns whether the pin was adopted, so callers can gate everything
 * that must not outrun ordering — the cache write, the broadcast — on
 * the same decision.
 *
 * An EXPIRED incumbent is discarded before the comparison (#2004 round
 * 3 P2). Without that, ordering rejects on the corpse of a pin: after
 * a reorg rolls the canonical version back, a dead higher-version pin
 * would refuse every newly mined acceptance of the restored version —
 * for ever, since nothing else deletes a pin whose version no longer
 * matches reads — leaving the fresh receipt unpinned and unbroadcast
 * while lagging reads keep offering another paid acceptance. Past the
 * bound a pin has no authority left to reject with.
 */
export function adoptOrderedPin(
  scope: string,
  version: number,
  hash: string,
  at: number,
  now: number,
): boolean {
  let existing = pins.get(scope);
  if (existing && now - existing.at > ACCEPTANCE_PIN_TTL_MS) {
    pins.delete(scope);
    existing = undefined;
  }
  if (
    existing &&
    (existing.version > version || (existing.version === version && existing.at >= at))
  ) {
    return false;
  }
  pins.set(scope, { version, hash, at });
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

/** Test seam only — the app never forgets a pin, it lets it expire. */
export function __clearAcceptancePins(): void {
  pins.clear();
}
