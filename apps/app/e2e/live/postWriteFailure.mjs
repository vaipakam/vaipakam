/**
 * ONE POST-WRITE FAILURE CLASSIFIER (#2422 r14, ROOT A).
 *
 * Review rounds 10–14 kept finding one shape: after the first write, a
 * UI-level failure caused by something OUTSIDE the app — the market filling
 * the request, a config change, a screening change, a page that missed a
 * transaction that did mine — reported as a product FAIL. Each was fixed
 * at its own call site and the next round found another. This module is the
 * one function every stop or failure after the first write routes through
 * (the driver's single catch calls it; `liveRefinanceWiring.test.mjs` fails
 * if a post-write stop can bypass that catch), and it decides:
 *
 *   0. RACE — a stop already classified as a race by Rule 1 / Rule 2
 *      (`raceStop`) stays a race.
 *   1. VERIFY — one of OUR transactions mined successfully and its outcome
 *      has not been verified yet (the accept first, else the createOffer):
 *      CONTINUE into the full receipt-based outcome verifier. The UI failure
 *      is recorded separately as its own FAILED check — the page did fail —
 *      but the chain outcome is still established, claim by claim.
 *   2. Otherwise every PREMISE is re-read — the whole watched-config
 *      snapshot (participants' sanctions screening included), the request's
 *      state (`requestStateOf`), the loan's supported posture:
 *        - our request filled by someone else → `externalFillVerdict`;
 *        - the request cancelled or expired → a race;
 *        - any other moved premise → a race, NAMING what moved;
 *        - premises that could not be re-read → a race (never assumed);
 *        - a chain read that failed (infrastructure, not the page) → a race.
 *   3. Only when NOTHING moved is the failure a product FAIL.
 *
 * Pure; `postWriteFailure.test.mjs` pins every branch.
 */
import { externalFillVerdict } from './refinanceOutcome.mjs';

/**
 * What KIND of failure an error is: `race` (already classified), `stop`
 * (the drive's own stop — an assertion, a UI step that did not complete, a
 * refused write), `infrastructure` (a chain read failed: viem's errors carry
 * `shortMessage`), or `ui` (anything else — a Playwright timeout, or a bug,
 * which a re-read of the premises then judges like a stop).
 */
export function causeKindOf(err, { RaceStop, Stop }) {
  if (RaceStop && err instanceof RaceStop) return 'race';
  if (Stop && err instanceof Stop) return 'stop';
  if (err && typeof err === 'object' && typeof err.shortMessage === 'string') return 'infrastructure';
  return 'ui';
}

/**
 * @param {{
 *   cause: { kind: 'race'|'stop'|'infrastructure'|'ui', why: string },
 *   ours: { acceptMined: boolean, createMined: boolean,
 *           verified: { accept: boolean, create: boolean } },
 *   premises: null | { error?: string, configChanges: string[],
 *     request: null | { id: bigint, state: string, replacement?: object|null, scanError?: string|null },
 *     postureMisses: string[] },
 * }} a
 * @returns {{ action: 'race'|'verify-accept'|'verify-create'|'fail', why: string, recordUiFailure: boolean }}
 */
export function classifyPostWriteFailure({ cause, ours, premises }) {
  const ui = cause.kind !== 'race' && cause.kind !== 'infrastructure';
  if (cause.kind === 'race') return { action: 'race', why: cause.why, recordUiFailure: false };
  // 1. Our own transaction mined: verify what it did, from its receipt.
  if (ours.acceptMined && !ours.verified.accept) {
    return { action: 'verify-accept', why: `our accept mined successfully; verifying its outcome from the receipt despite: ${cause.why}`, recordUiFailure: ui };
  }
  if (ours.createMined && !ours.acceptMined && !ours.verified.create) {
    return { action: 'verify-create', why: `our createOffer mined successfully; verifying its outcome from the receipt despite: ${cause.why}`, recordUiFailure: ui };
  }
  // 2. Re-read every premise.
  if (!premises || premises.error) {
    return { action: 'race', why: `the premises could not be re-read (${premises?.error ?? 'unreadable'}), so ${JSON.stringify(cause.why)} cannot be attributed to the product`, recordUiFailure: false };
  }
  const req = premises.request;
  if (req && req.state === 'accepted' && !ours.acceptMined) {
    const fill = externalFillVerdict({ requestId: req.id, replacement: req.replacement ?? null, scanError: req.scanError ?? null });
    return { action: fill.kind === 'fail' ? 'fail' : 'race', why: fill.why, recordUiFailure: false };
  }
  const moved = [];
  if (req && !ours.acceptMined && req.state !== 'open') moved.push(`request #${req.id} is ${req.state}`);
  for (const c of premises.configChanges) moved.push(`watched config: ${c}`);
  for (const m of premises.postureMisses) moved.push(`loan posture: ${m}`);
  if (moved.length) {
    return { action: 'race', why: `${moved.join('; ')} — a premise moved, so ${JSON.stringify(cause.why)} is not a product defect`, recordUiFailure: false };
  }
  if (cause.kind === 'infrastructure') {
    return { action: 'race', why: `a chain read failed (${cause.why}) with every premise unchanged — the outcome could not be established`, recordUiFailure: false };
  }
  // 3. Nothing moved: the product failed.
  return { action: 'fail', why: cause.why, recordUiFailure: false };
}
