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

/** How often `useTosAcceptance` refreshes the clock it compares
 *  `dataUpdatedAt` against. Exported because anything that BACKDATES a
 *  verdict to force staleness must clear this lag too (#2004 round 10
 *  P2): a timestamp exactly at the bound reads as fresh for up to one
 *  tick to a gate whose `nowMs` has not ticked yet. */
export const VERDICT_CLOCK_TICK_MS = 15_000;

/**
 * How far in the FUTURE a verdict's `dataUpdatedAt` may sit before it
 * stops counting as fresh (#2004 round 19 P2). A backward clock
 * correction after a successful read leaves the stamp ahead of the
 * clock, and a plain age check then reads the entry as fresh until
 * wall time catches up PLUS the whole verdict window — during which
 * it can veto a settling receipt or a cross-tab frame as
 * "authoritative" knowledge. The tolerance is one gate clock tick
 * plus the pin module's skew allowance, because `useTosAcceptance`
 * compares against a `nowMs` that lags the real clock by up to a
 * tick — a verdict written mid-tick legitimately sits "in the
 * future" of that clock, and must not read as stale. The 5s term is
 * the same coarse-correction allowance as the pin module's
 * `MAX_FUTURE_SKEW_MS`, restated here because this module stays
 * import-free on purpose (see `tosQueryKey`).
 */
export const MAX_VERDICT_FUTURE_MS = VERDICT_CLOCK_TICK_MS + 5_000;

/**
 * True when a successful verdict is too old — or too far in the
 * future (round 19 P2) — to keep the gate open.
 *
 * `dataUpdatedAt` of 0 means no successful read has ever landed, which
 * `readOk` already covers; treat it as stale so a caller that reaches
 * here first cannot open on it.
 */
export function isVerdictStale(
  dataUpdatedAt: number,
  now: number,
  maxAgeMs: number = MAX_VERDICT_AGE_MS,
  // The future tolerance is a PARAMETER (round 25 P2) because its
  // default carries a term that exists only for one caller: the
  // gate's render clock lags the real one by up to a tick, so the
  // default must not read a mid-tick write as future-dated. Callers
  // that compare against REAL time (the conflict guards, via
  // `freshVerdict`) pass the bare clock-skew allowance instead — with
  // the render-tick slack, a 6-to-20-second backward correction left
  // a pre-correction entry "authoritative" enough to veto a current
  // frame or receipt.
  maxFutureMs: number = MAX_VERDICT_FUTURE_MS,
): boolean {
  if (!dataUpdatedAt) return true;
  if (dataUpdatedAt > now + maxFutureMs) return true;
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
/** The Terms query's root — the first element of `tosQueryKey`.
 *  Exported for the cross-tab rail's legacy read-hint frame (#2004
 *  round 25 P2), whose receivers match invalidations on this string. */
export const TOS_QUERY_ROOT = 'tosAcceptance';

export function tosQueryKey(chainId: number, address: string | undefined) {
  return [TOS_QUERY_ROOT, chainId, address?.toLowerCase() ?? null] as const;
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
