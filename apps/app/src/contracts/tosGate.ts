/**
 * The Terms-of-Service gate's decision, as a pure function (#1961).
 *
 * Extracted from the component on purpose. This gate IS the enforcement
 * — the contracts expose the in-force version and record acceptance but
 * gate nothing themselves, so there is no per-action backstop behind a
 * wrong answer here. What must be right is the DECISION, not the
 * markup, and a decision in a component is only testable through a DOM
 * harness this app deliberately does not have.
 *
 * The rule in one line: `pass` requires a SUCCESSFUL read that said yes.
 * Every other state — no read yet, a failed read, a read that said no —
 * holds the gate closed. "No terms are in force" and "we have not
 * managed to ask" are different answers, and only the first may open
 * the app; conflating them is the #822 defect that shipped in the
 * retired implementation and had to be fixed after review.
 */
export type TosGateVerdict =
  /** No wallet connected — nothing to gate; the pages handle it. */
  | 'pass-unconnected'
  /** Read succeeded and said accepted, or that no ToS is in force. */
  | 'pass'
  /** A read is in flight and no successful result is held: hold closed. */
  | 'checking'
  /** The read failed: hold closed, offer a retry. */
  | 'unavailable'
  /** Read succeeded and said this wallet has not accepted: prompt. */
  | 'prompt';

export interface TosGateInput {
  /** Whether a wallet is connected at all. */
  connected: boolean;
  /** Has an on-chain read completed SUCCESSFULLY? */
  readOk: boolean;
  /** Is a read in flight with no successful result held? */
  loading: boolean;
  /** The successful read's answer. Meaningless unless `readOk`. */
  accepted: boolean;
}

export function tosGateVerdict({
  connected,
  readOk,
  loading,
  accepted,
}: TosGateInput): TosGateVerdict {
  if (!connected) return 'pass-unconnected';
  // Order matters: `loading` is checked before `readOk` so a background
  // refetch that has not yet settled cannot be reported as a fresh
  // verdict, and `readOk` is checked before `accepted` so a stale or
  // absent `accepted` can never be read as consent.
  if (loading) return 'checking';
  if (!readOk) return 'unavailable';
  return accepted ? 'pass' : 'prompt';
}

/**
 * How old a successful verdict may be before the gate stops trusting it.
 *
 * Codex review round 1 P1: `isPending` is false while TanStack refetches
 * a query that already holds data, so a cached `accepted: true` kept the
 * app open for the whole of every background refresh — including one
 * that was about to discover a new version.
 *
 * The prescribed remedy was to close while fetching. I did not do that,
 * and the reason is concrete rather than a preference: this gate wraps
 * the routed `<Outlet />`, so closing UNMOUNTS the page. With the poll
 * this round also adds, every routed surface would be torn down and
 * rebuilt on a fixed interval, destroying any half-filled borrow or
 * lend form along with it. That is a worse defect than the one being
 * fixed, and it would be hit by every user rather than by the narrow
 * race.
 *
 * What actually creates the risk is AGE, not fetching: a verdict is
 * dangerous once it is old, whether or not a refresh happens to be in
 * flight. So the gate bounds the age instead. Below the bound the app
 * stays mounted through refreshes; past it — which means the poll has
 * been failing — the gate closes and asks again. The window is
 * therefore bounded by a stated number rather than by the hope that a
 * refetch is running.
 */
export const MAX_VERDICT_AGE_MS = 180_000;

/**
 * True when a successful verdict is too old to keep the gate open.
 *
 * `dataUpdatedAt` of 0 means no successful read has ever landed, which
 * `readOk` already covers; treat it as stale so a caller that reaches
 * here first cannot open on it.
 */
export function isVerdictStale(
  dataUpdatedAt: number,
  now: number,
  maxAgeMs: number = MAX_VERDICT_AGE_MS,
): boolean {
  if (!dataUpdatedAt) return true;
  return now - dataUpdatedAt > maxAgeMs;
}

/** True only for the verdicts that may render the gated app. */
export function opensGate(verdict: TosGateVerdict): boolean {
  return verdict === 'pass' || verdict === 'pass-unconnected';
}

/**
 * The cache key the Terms verdict lives under.
 *
 * Defined here, in the module that imports nothing app-side, so the
 * write gate can read the verdict out of the query cache without
 * importing `useTosAcceptance` — which imports `useDiamondWrite`, so a
 * direct dependency would be a cycle. Two consumers, one key: the
 * alternative is a second key spelling, which is how a cache write and
 * a cache read come to miss each other silently.
 */
export function tosQueryKey(chainId: number, address: string | undefined) {
  return ['tosAcceptance', chainId, address?.toLowerCase() ?? null] as const;
}

/** What the Terms query stores. */
export interface TosVerdictData {
  accepted: boolean;
  version: number;
  hash: `0x${string}`;
  /** True when this verdict's `accepted` rests on the acceptance PIN
   *  rather than on a node's own answer — a pin-corrected read, or the
   *  verdict a receipt/broadcast wrote directly (#2004 round 9 P2). A
   *  reorg can orphan the acceptance behind such a verdict, so at the
   *  pin's expiry it is aged past the verdict bound rather than left
   *  to coast; a verdict a node genuinely confirmed carries no flag
   *  and is never aged. Cleared naturally: the first read a node
   *  answers `true` on its own stores an unflagged verdict. */
  pinBacked?: boolean;
}
