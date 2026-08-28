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

/** True only for the verdicts that may render the gated app. */
export function opensGate(verdict: TosGateVerdict): boolean {
  return verdict === 'pass' || verdict === 'pass-unconnected';
}
