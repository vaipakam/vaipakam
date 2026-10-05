/**
 * #2422 r8 — the outcome manifest: a claim prints as VERIFIED only when
 * every check it declares ran and passed; everything else is said for what
 * it is.
 */
import { describe, expect, it } from 'vitest';

import { createManifest } from './outcomeManifest.mjs';

const spec = () => ({
  verifiable: [
    { id: 'closed', claim: 'the old loan is Repaid', checks: { status: 'getLoanDetails(old).status at the accept block' } },
    {
      id: 'settled',
      claim: 'the old lender was paid the payoff',
      checks: { claim: 'getClaimable(old, lender) before and at the accept block', vault: 'balanceOf(old lender vault)' },
    },
  ],
  notVerified: [
    { id: 'indexer', claim: 'the indexer lists the replacement', reason: 'reads no indexer', coveredBy: null },
  ],
});

const statusOf = (m, id) => m.rows().find((r) => r.id === id).status;

describe('outcomeManifest', () => {
  it('a claim is VERIFIED only when every declared check was recorded and passed', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'status 1 @ block 9');
    m.record('settled', 'claim', true, '0 → 5038931506849315');
    // One of settled's two checks never ran.
    expect(statusOf(m, 'closed')).toBe('verified');
    expect(statusOf(m, 'settled')).toBe('not run');
    expect(m.passed()).toBe(false);
    m.record('settled', 'vault', true, '+5038931506849315');
    expect(statusOf(m, 'settled')).toBe('verified');
    expect(m.passed()).toBe(true);
  });

  it('a claim with no record at all is NOT RUN, never verified', () => {
    const m = createManifest(spec());
    expect(m.rows().filter((r) => r.status === 'verified')).toEqual([]);
    expect(statusOf(m, 'closed')).toBe('not run');
    expect(m.passed()).toBe(false);
  });

  it('one failed recording fails the claim, whatever else passed', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'first read');
    m.record('closed', 'status', false, 'second read: 0');
    expect(statusOf(m, 'closed')).toBe('failed');
    expect(m.passed()).toBe(false);
  });

  it('only `true` passes — a truthy non-boolean is a failure', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', 1, 'truthy');
    expect(statusOf(m, 'closed')).toBe('failed');
  });

  it('evidence cannot be filed under an undeclared claim or check, or under a not-verified claim', () => {
    const m = createManifest(spec());
    expect(() => m.record('nope', 'status', true, '')).toThrow(/no claim "nope"/);
    expect(() => m.record('closed', 'nope', true, '')).toThrow(/declares no check "nope"/);
    expect(() => m.record('indexer', 'x', true, '')).toThrow(/declared NOT VERIFIED/);
  });

  it('refuses a claim that declares no checks, a duplicate id, or a not-verified claim without a reason', () => {
    expect(() => createManifest({ verifiable: [{ id: 'a', claim: 'x', checks: {} }] })).toThrow(/declares no checks/);
    expect(() =>
      createManifest({ verifiable: [{ id: 'a', claim: 'x', checks: { k: 'r' } }], notVerified: [{ id: 'a', claim: 'y', reason: 'z' }] }),
    ).toThrow(/declared twice/);
    expect(() => createManifest({ verifiable: [], notVerified: [{ id: 'b', claim: 'y' }] })).toThrow(/needs a reason/);
  });

  it('defer moves a claim to NOT VERIFIED with its reason — and never hides a failure', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'ok');
    m.defer('settled', 'a VPFI yield-fee discount applied; the settlement model does not cover it', 'not covered');
    expect(statusOf(m, 'settled')).toBe('not verified');
    expect(m.passed()).toBe(true);
    const f = createManifest(spec());
    f.record('settled', 'claim', false, 'wrong amount');
    f.defer('settled', 'too late');
    expect(statusOf(f, 'settled')).toBe('failed');
    expect(f.passed()).toBe(false);
    expect(() => f.defer('settled', '')).toThrow(/needs a reason/);
  });

  it('renders both halves: each verified claim with its reads and evidence, each not-verified claim with why and where it is covered', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'status 1 @ block 47711162');
    m.defer('settled', 'model does not cover it', 'contracts/test/RefinanceFacetTest.t.sol');
    const text = m.render().join('\n');
    expect(text).toMatch(/VERIFIED \(1\):\n {2}\[closed\] the old loan is Repaid\n {6}ok {3}status: getLoanDetails\(old\)\.status at the accept block\n {13}status 1 @ block 47711162/);
    expect(text).toMatch(/NOT VERIFIED BY THIS DRIVER \(2\):/);
    expect(text).toMatch(/\[settled\][\s\S]*why not: model does not cover it\n {6}covered by: contracts\/test\/RefinanceFacetTest\.t\.sol/);
    expect(text).toMatch(/\[indexer\][\s\S]*covered by: not covered/);
    expect(text).not.toMatch(/FAILED|NOT RUN/);
  });

  it('renders a NOT RUN claim under its own heading, never under VERIFIED', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'ok');
    const text = m.render().join('\n');
    expect(text).toMatch(/NOT RUN[^\n]*\(1\):\n {2}\[settled\]/);
    expect(text).toMatch(/--   vault: balanceOf/);
  });

  // #2422 r9 — UNDETERMINED: ran after the write, premises did not hold.
  it('UNDETERMINED is its own outcome: not verified, not failed, and the run still passes', () => {
    const m = createManifest(spec());
    m.record('closed', 'status', true, 'ok');
    m.record('settled', 'claim', true, 'claim rose by the lender due');
    m.undetermined('settled', 'vault', 'another transaction in the accept block touched the old lender\u2019s vault');
    expect(statusOf(m, 'settled')).toBe('undetermined');
    expect(m.passed()).toBe(true);
    expect(m.undeterminedCount()).toBe(1);
    const text = m.render().join('\n');
    expect(text).toMatch(/UNDETERMINED \(each check ran after the write[^\n]*\(1\):\n {2}\[settled\]/);
    expect(text).toMatch(/\?\? {3}vault: balanceOf\(old lender vault\)\n {13}UNDETERMINED — another transaction/);
    expect(text).not.toMatch(/^VERIFIED \(\d\):\n {2}\[settled\]/m);
  });

  it('a failure outranks UNDETERMINED, and an undetermined check alone never counts as verified', () => {
    const m = createManifest(spec());
    m.undetermined('settled', 'claim', 'premise did not hold');
    m.record('settled', 'vault', false, 'wrong amount');
    expect(statusOf(m, 'settled')).toBe('failed');
    const n = createManifest(spec());
    n.undetermined('settled', 'claim', 'premise did not hold');
    // `vault` never ran: the claim is NOT RUN, which fails the run.
    expect(statusOf(n, 'settled')).toBe('not run');
    expect(n.passed()).toBe(false);
  });

  it('UNDETERMINED needs a declared check and a reason', () => {
    const m = createManifest(spec());
    expect(() => m.undetermined('settled', 'nope', 'x')).toThrow(/declares no check "nope"/);
    expect(() => m.undetermined('settled', 'vault', '')).toThrow(/needs a reason/);
    expect(() => m.undetermined('indexer', 'x', 'y')).toThrow(/declared NOT VERIFIED/);
  });
});
