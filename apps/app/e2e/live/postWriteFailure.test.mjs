/**
 * #2422 r14 ROOT A — every post-write failure goes through one classifier.
 */
import { describe, expect, it } from 'vitest';

import { runVerdict } from './outcomeManifest.mjs';
import { causeKindOf, classifyPostWriteFailure } from './postWriteFailure.mjs';

class Stop extends Error {}
class RaceStop extends Stop {}

const none = { acceptMined: false, createMined: false, verified: { accept: false, create: false } };
const calm = { configChanges: [], request: { id: 45n, state: 'open' }, postureMisses: [] };
const stop = (why) => ({ kind: 'stop', why });

describe('causeKindOf', () => {
  it('tells a race, a stop, a chain read and anything else apart', () => {
    expect(causeKindOf(new RaceStop('x'), { RaceStop, Stop })).toBe('race');
    expect(causeKindOf(new Stop('x'), { RaceStop, Stop })).toBe('stop');
    expect(causeKindOf(Object.assign(new Error('rpc'), { shortMessage: 'HTTP 429' }), { RaceStop, Stop })).toBe('infrastructure');
    expect(causeKindOf(new TypeError('a bug'), { RaceStop, Stop })).toBe('ui');
  });
});

describe('classifyPostWriteFailure', () => {
  it('a race stays a race', () => {
    expect(classifyPostWriteFailure({ cause: { kind: 'race', why: 'fee moved' }, ours: none, premises: calm })).toMatchObject({ action: 'race', why: 'fee moved' });
  });

  it('(i) the accept MINED though the UI missed it: verify the outcome, and record the UI failure as its own failed check (P1 :2570)', () => {
    const d = classifyPostWriteFailure({
      cause: stop('the lender’s accept did not complete in the UI: timed out'),
      ours: { acceptMined: true, createMined: true, verified: { accept: false, create: true } },
      premises: calm,
    });
    expect(d).toMatchObject({ action: 'verify-accept', recordUiFailure: true });
    // Once the verifier has run, a later failure is judged on the premises.
    expect(
      classifyPostWriteFailure({ cause: stop('x'), ours: { acceptMined: true, createMined: true, verified: { accept: true, create: true } }, premises: calm }).action,
    ).toBe('fail');
  });

  it('(i) the createOffer mined though the page never said "live": verify the request from the receipt', () => {
    const d = classifyPostWriteFailure({ cause: stop('did not go live'), ours: { ...none, createMined: true }, premises: calm });
    expect(d).toMatchObject({ action: 'verify-create', recordUiFailure: true });
  });

  it('(ii) our request filled by someone else → externalFillVerdict: a race with the replacement, a FAIL with none (P2 :2551)', () => {
    const filled = { ...calm, request: { id: 45n, state: 'accepted', replacement: { id: 24n, status: 0, borrowerHolder: '0xb', lenderHolder: '0xo' } } };
    const d = classifyPostWriteFailure({ cause: stop('review never enabled'), ours: { ...none, createMined: true, verified: { accept: false, create: true } }, premises: filled });
    expect(d.action).toBe('race');
    expect(d.why).toMatch(/filled by another party .*replacement loan #24/);
    expect(runVerdict({ rows: [{ id: 'replacement', status: 'not run' }], failure: false, raceStop: d.why }).exit).toBe(3);
    const orphan = { ...calm, request: { id: 45n, state: 'accepted', replacement: null } };
    expect(classifyPostWriteFailure({ cause: stop('x'), ours: { ...none, createMined: true, verified: { accept: false, create: true } }, premises: orphan }).action).toBe('fail');
  });

  it('(ii) a moved premise is a race NAMING what moved — config, sanctions, request state, loan posture (P2 :2541)', () => {
    const ours = { ...none, createMined: true, verified: { accept: false, create: true } };
    const sanctions = classifyPostWriteFailure({ cause: stop('x'), ours, premises: { ...calm, configChanges: ['screenLender: {"state":"clean"} → {"state":"flagged"}'] } });
    expect(sanctions.action).toBe('race');
    expect(sanctions.why).toMatch(/watched config: screenLender/);
    expect(classifyPostWriteFailure({ cause: stop('x'), ours, premises: { ...calm, request: { id: 45n, state: 'cancelled' } } }).why).toMatch(/request #45 is cancelled/);
    expect(classifyPostWriteFailure({ cause: stop('x'), ours, premises: { ...calm, postureMisses: ['status: 1'] } }).why).toMatch(/loan posture: status: 1/);
  });

  it('(ii) premises that cannot be re-read, or a failed chain read, are races — never assumed', () => {
    expect(classifyPostWriteFailure({ cause: stop('x'), ours: none, premises: null }).action).toBe('race');
    expect(classifyPostWriteFailure({ cause: stop('x'), ours: none, premises: { error: 'rpc down' } }).why).toMatch(/could not be re-read \(rpc down\)/);
    expect(classifyPostWriteFailure({ cause: { kind: 'infrastructure', why: 'HTTP 429' }, ours: none, premises: calm }).action).toBe('race');
  });

  it('(ii) only when NOTHING moved is it a product FAIL', () => {
    const d = classifyPostWriteFailure({ cause: stop('the Offer Book row offers no CTA'), ours: { ...none, createMined: true, verified: { accept: false, create: true } }, premises: calm });
    expect(d).toEqual({ action: 'fail', why: 'the Offer Book row offers no CTA', recordUiFailure: false });
    expect(classifyPostWriteFailure({ cause: { kind: 'ui', why: 'TypeError: a bug' }, ours: none, premises: calm }).action).toBe('fail');
  });
});
