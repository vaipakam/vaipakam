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
 * Per-TAB. A second tab holding the same wallet keeps its own pin and
 * its own cache; sharing the acceptance across tabs is #2001.
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
  at: number;
}

const pins = new Map<string, AcceptancePin>();

/** Identifies one wallet on one chain. Acceptance is recorded per
 *  wallet and per network, so both belong in the key. */
export function acceptanceScope(chainId: number, address: string | undefined): string {
  return `${chainId}:${address?.toLowerCase() ?? ''}`;
}

/** Record that this scope's acceptance of `version` has been mined and
 *  its receipt waited for. */
export function pinAcceptance(scope: string, version: number, now: number): void {
  pins.set(scope, { version, at: now });
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
  now: number,
): boolean {
  const pin = pins.get(scope);
  if (!pin || pin.version !== version) return false;
  if (now - pin.at > ACCEPTANCE_PIN_TTL_MS) {
    pins.delete(scope);
    return false;
  }
  return true;
}

/** Test seam only — the app never forgets a pin, it lets it expire. */
export function __clearAcceptancePins(): void {
  pins.clear();
}
