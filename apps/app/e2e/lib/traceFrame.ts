/**
 * Reading a `callTracer` trace of a reverted e2e transaction (no chain
 * access here, so it is unit-tested apart from `chain.ts`).
 */

/** One frame of a `callTracer` trace: the fields this file reads. */
export interface TraceFrame {
  type?: string;
  to?: string;
  input?: string;
  gas?: string;
  gasUsed?: string;
  output?: unknown;
  error?: unknown;
  calls?: TraceFrame[];
}

/**
 * The frame a revert started in. A revert with no data at the top usually
 * began deeper, where a call ran out of gas, hit a bare `revert()` or a
 * token's message-less `require`, and the caller passed the empty result
 * on. The top-level trace hides which, so this walks down: from a failed
 * frame it follows the LAST failed child, the one the parent was executing
 * when it gave up, and returns the deepest such frame. It never names a
 * cause on its own; it says where to look.
 */
export function failingFrame(frame: TraceFrame | undefined): TraceFrame | undefined {
  if (!frame || typeof frame.error !== 'string') return undefined;
  const failed = (frame.calls ?? []).filter((c) => typeof c.error === 'string');
  const last = failed[failed.length - 1];
  return last ? failingFrame(last) ?? frame : frame;
}

