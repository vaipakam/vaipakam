/**
 * #2422 r3 — the ordered write plan's cursor. A live drive's happy path
 * consumes the plan once in order and can never show a refusal, so every
 * refusal the plan exists for is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { is } from './expectedPayload.mjs';
import { createWritePlan } from './writePlan.mjs';

const approve = (amount) => ({ fn: 'approve', amount });
const plan = () =>
  createWritePlan([
    { id: 'caps', role: 'borrower', kind: 'tx', purpose: 'caps', optional: true, expected: { fn: 'caps' } },
    { id: 'reset', role: 'borrower', kind: 'tx', purpose: 'reset', optional: true, expected: approve(0n) },
    {
      id: 'set',
      role: 'borrower',
      kind: 'tx',
      purpose: 'set',
      optional: true,
      expected: { fn: 'approve', amount: is('> 0', (v) => BigInt(v) > 0n) },
    },
    { id: 'create', role: 'borrower', kind: 'tx', purpose: 'create', expected: { fn: 'create' } },
    { id: 'sign', role: 'lender', kind: 'typed', purpose: 'sign', expected: { msg: 'terms' } },
    { id: 'accept', role: 'lender', kind: 'tx', purpose: 'accept', expected: () => ({ fn: 'accept' }) },
  ]);

const statuses = (p) => p.steps().map((s) => `${s.id}:${s.status}`);

describe('writePlan — one ordered sequence, each step consumed once', () => {
  it('accepts the full expected sequence in order', () => {
    const p = plan();
    for (const [role, kind, a] of [
      ['borrower', 'tx', { fn: 'caps' }],
      ['borrower', 'tx', approve(0n)],
      ['borrower', 'tx', approve(5n)],
      ['borrower', 'tx', { fn: 'create' }],
      ['lender', 'typed', { msg: 'terms' }],
      ['lender', 'tx', { fn: 'accept' }],
    ]) {
      expect(p.offer(role, kind, a).ok).toBe(true);
    }
    expect(p.complete()).toBe(true);
    expect(statuses(p).every((s) => s.endsWith(':consumed'))).toBe(true);
  });

  it('skips declared-optional steps the app omitted, and records them as skipped', () => {
    const p = plan();
    // No caps write and no reset: the app went straight to approve(N).
    expect(p.offer('borrower', 'tx', approve(5n)).ok).toBe(true);
    expect(statuses(p)).toEqual([
      'caps:skipped',
      'reset:skipped',
      'set:consumed',
      'create:pending',
      'sign:pending',
      'accept:pending',
    ]);
    expect(p.offer('borrower', 'tx', { fn: 'create' }).ok).toBe(true);
  });

  it('refuses a duplicate of a consumed step, and latches', () => {
    const p = plan();
    expect(p.offer('borrower', 'tx', { fn: 'create' }).ok).toBe(true);
    const dup = p.offer('borrower', 'tx', { fn: 'create' });
    expect(dup.ok).toBe(false);
    // Latched: even the legitimate next step is now refused.
    expect(p.offer('lender', 'typed', { msg: 'terms' }).ok).toBe(false);
    expect(p.refusal()).toBeTruthy();
  });

  it('refuses an out-of-order request — a required step cannot be skipped', () => {
    const p = plan();
    // The lender's signature before the borrower's createOffer.
    const r = p.offer('lender', 'typed', { msg: 'terms' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/create expects borrower tx/);
    expect(p.complete()).toBe(false);
  });

  it('refuses a duplicate reset (approve 0 twice)', () => {
    const p = plan();
    expect(p.offer('borrower', 'tx', approve(0n)).ok).toBe(true);
    expect(p.offer('borrower', 'tx', approve(0n)).ok).toBe(false);
  });

  it('refuses a step whose expected object cannot be built yet', () => {
    const p = createWritePlan([
      { id: 'accept', role: 'lender', kind: 'tx', purpose: 'accept', expected: () => null },
    ]);
    expect(p.offer('lender', 'tx', { fn: 'accept' }).why).toMatch(/cannot be judged yet/);
  });

  it('refuses anything after the plan is complete', () => {
    const p = createWritePlan([{ id: 'only', role: 'lender', kind: 'tx', purpose: 'x', expected: { fn: 'x' } }]);
    expect(p.offer('lender', 'tx', { fn: 'x' }).ok).toBe(true);
    expect(p.complete()).toBe(true);
    expect(p.offer('lender', 'tx', { fn: 'x' }).why).toMatch(/plan is complete/);
  });

  it('keeps outcome records per step', () => {
    const p = plan();
    const r = p.offer('borrower', 'tx', { fn: 'create' });
    p.record(r.index, { hash: '0xabc' });
    expect(p.steps()[r.index].record).toEqual({ hash: '0xabc' });
  });
});
