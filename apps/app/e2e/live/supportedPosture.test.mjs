/**
 * #2422 r13 — the supported loan posture: every Loan field is declared
 * (supported value + reason) or classified (why it does not affect the
 * model), and the fields the model reads are among the declared ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { between, blockFrom, statementFrom } from './sourceBlock.mjs';
import { NOT_AFFECTING, postureMisses, SUPPORTED } from './supportedPosture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'));
const LOAN_FIELDS = ABI.find((e) => e.name === 'getLoanDetails').outputs[0].components.map((c) => c.name);
const listed = new Set([...Object.keys(SUPPORTED), ...Object.keys(NOT_AFFECTING)]);
/** Loan fields accessed as `<x>.<field>` anywhere in `text`. */
const loanFieldsIn = (text) => LOAN_FIELDS.filter((f) => new RegExp(`\\.${f}\\b`).test(text));

// Loan 22 as it stood before the refinance (getLoanDetails, 2026-10-05).
const LOAN22 = {
  status: 0,
  assetType: 0,
  collateralAssetType: 0,
  useFullTermInterest: true,
  periodicInterestCadence: 0,
  interestSettled: 0n,
  interestPaidSinceLastPeriod: 0n,
  // Stamped with the start time at origination, for every loan.
  lastPeriodicInterestSettledAt: 1_790_964_520n,
  collateralLiquidity: 1,
  riskAndTermsConsentFromBoth: true,
  principal: 5_000_000_000_000_000n,
  interestRateBps: 1000n,
  startTime: 1_790_964_520n,
  durationDays: 29n,
  interestAccrualStart: 1_790_964_520n,
  interestRemainingDays: 29,
  treasuryFeeBpsAtInit: 200,
};

describe('supportedPosture — the declaration is complete', () => {
  it('every Loan field in the compiled ABI is declared or classified — exactly once', () => {
    expect(LOAN_FIELDS.length).toBeGreaterThan(40);
    expect(LOAN_FIELDS.filter((f) => !listed.has(f)), 'declare it in SUPPORTED or classify it in NOT_AFFECTING').toEqual([]);
    expect(Object.keys(SUPPORTED).filter((f) => Object.hasOwn(NOT_AFFECTING, f))).toEqual([]);
    expect([...listed].filter((f) => !LOAN_FIELDS.includes(f)), 'a listed name that is not a Loan field').toEqual([]);
  });

  it('every Loan field the builders, the settlement model or the driver read is listed', () => {
    for (const f of ['refinanceExpected.mjs', 'refinanceOutcome.mjs', 'live-refinance.mjs']) {
      const read = loanFieldsIn(src(f));
      expect(read.length, f).toBeGreaterThan(0);
      expect(read.filter((x) => !listed.has(x)), f).toEqual([]);
    }
  });

  it('every Loan field the payoff mirror reads has a SUPPORTED range — none is merely classified', () => {
    const s = src('refinanceExpected.mjs');
    const mirror = [
      statementFrom(s, 'const loanEndOf'),
      blockFrom(s, 'export function lateFeeAt(l, ts) {'),
      blockFrom(s, 'export function refinancePayoffAt(l, asOf) {'),
      between(s, 'export function borrowerReserve(', 'export function defaultGraceSeconds('),
    ].join('\n');
    const read = [...mirror.matchAll(/\bl(?:oan)?\.(\w+)/g)].map((m) => m[1]).filter((f) => LOAN_FIELDS.includes(f));
    expect(read.length).toBeGreaterThan(4);
    expect([...new Set(read)].filter((f) => !Object.hasOwn(SUPPORTED, f))).toEqual([]);
  });
});

describe('supportedPosture — preflight evaluation', () => {
  it('loan 22 is inside the supported posture', () => {
    expect(postureMisses(LOAN22)).toEqual([]);
  });

  it('a pro-rata loan is BLOCKED by name (r13 finding 1)', () => {
    const m = postureMisses({ ...LOAN22, useFullTermInterest: false });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ field: 'useFullTermInterest', value: 'false', want: 'true (full-term interest)' });
    expect(m[0].why).toMatch(/pro-rata loan/);
  });

  it('settled interest, a periodic history, a rental or a liquid collateral are each outside it', () => {
    expect(postureMisses({ ...LOAN22, interestSettled: 1n }).map((x) => x.field)).toEqual(['interestSettled']);
    expect(postureMisses({ ...LOAN22, periodicInterestCadence: 1 }).map((x) => x.field)).toEqual(['periodicInterestCadence']);
    expect(postureMisses({ ...LOAN22, assetType: 1 }).map((x) => x.field)).toEqual(['assetType']);
    expect(postureMisses({ ...LOAN22, collateralLiquidity: 0 }).map((x) => x.field)).toEqual(['collateralLiquidity']);
  });

  it('the clock: a re-anchored loan is supported; a remaining term past the loan is not', () => {
    expect(postureMisses({ ...LOAN22, interestAccrualStart: LOAN22.startTime + 86_400n * 10n, interestRemainingDays: 10 })).toEqual([]);
    expect(postureMisses({ ...LOAN22, interestRemainingDays: 30 }).map((x) => x.field)).toEqual(['interestRemainingDays']);
    // A legacy loan (no stamped clock) falls back to durationDays: supported.
    expect(postureMisses({ ...LOAN22, interestAccrualStart: 0n, interestRemainingDays: 0 })).toEqual([]);
  });

  it('a field missing from the read is outside the posture, never assumed', () => {
    const { useFullTermInterest: _drop, ...partial } = LOAN22;
    expect(postureMisses(partial)).toEqual([expect.objectContaining({ field: 'useFullTermInterest', value: 'missing' })]);
  });
});
