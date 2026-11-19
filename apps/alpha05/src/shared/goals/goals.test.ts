import { buildDeleteGoalMessage, buildListGoalsMessage, buildSaveGoalMessage } from '@vaipakam/lib/goals';
import { describe, expect, it } from 'vitest';
import type { MyAutoLend } from '../autolend/myAutoLend';
import { ASSET_ERC20, type LiveLoanRow } from '../positions/model';
import { goalBody, goalFromForm, goalLoans, goalMessage, goalPath, loansProgress, readGoalAnswer, slotProgress, type Goal } from './goals';
import { endOfUtcDay } from './GoalsSection';

const W = '0x00000000000000000000000000000000000000aa' as const;
const S = '0x1234' as const;
const USDC = '0x00000000000000000000000000000000000000Cc' as const;
const DAI = '0x00000000000000000000000000000000000000dd' as const;
const WETH = '0x00000000000000000000000000000000000000ee' as const;

function row(id: bigint, asset: `0x${string}`, principal: bigint, borrowerSide = false, assetType = ASSET_ERC20): LiveLoanRow {
  return { loan: { id, assetType, principalAsset: asset, principal } as unknown as LiveLoanRow['loan'], healthFactor: 0n, borrowerSide };
}

function slot(lendingAsset: `0x${string}`, n: number, waiting: bigint, lent: bigint, active = true): MyAutoLend {
  return { intent: { lendingAsset, collateralAsset: WETH, slot: n, availableCapital: waiting, livePrincipal: lent } as unknown as MyAutoLend['intent'], active };
}

const NOW = 1_800_000_000;
const LATER = NOW + 86_400 * 30;
const rows = [row(1n, USDC, 100n), row(2n, USDC, 50n), row(3n, DAI, 70n), row(4n, USDC, 999n, true)];

function goal(over: Partial<Goal>): Goal {
  return { id: 1, chainId: 84532, createdAt: 1, updatedAt: 1, name: 'House', asset: USDC.toLowerCase(), targetAmount: '120', targetDate: LATER, attachTo: { kind: 'loans', loanIds: [1, 2] }, ...over };
}

describe('goal requests', () => {
  const g = { name: 'House', asset: USDC.toLowerCase(), targetAmount: '120', targetDate: LATER, attachTo: { kind: 'loans' as const, loanIds: [1] } };
  it('signs the shared messages', () => {
    expect(goalMessage({ kind: 'list' }, W, 84532, 5)).toBe(buildListGoalsMessage(W, 84532, 5));
    expect(goalMessage({ kind: 'delete', goalId: 3 }, W, 84532, 5)).toBe(buildDeleteGoalMessage(W, 84532, 3, 5));
    expect(goalMessage({ kind: 'save', goalId: null, goal: g }, W, 84532, 5)).toBe(buildSaveGoalMessage(W, 84532, null, g, 5));
  });
  it('sends each action to its route', () => {
    expect(goalPath({ kind: 'list' })).toBe('/goals/list');
    expect(goalPath({ kind: 'delete', goalId: 3 })).toBe('/goals/delete');
    expect(goalBody({ kind: 'save', goalId: null, goal: g }, W, 1, 2, S)).toEqual({ wallet: W, chain_id: 1, issuedAt: 2, signature: S, goal: g });
    expect(goalBody({ kind: 'save', goalId: 4, goal: g }, W, 1, 2, S)).toMatchObject({ goalId: 4 });
    expect(goalBody({ kind: 'delete', goalId: 3 }, W, 1, 2, S)).toMatchObject({ goalId: 3 });
  });
});

describe('readGoalAnswer', () => {
  it('reads a save, a delete and their refusals', () => {
    const save = { kind: 'save', goalId: null, goal: goal({}) } as const;
    expect(readGoalAnswer(save, 200, { ok: true, id: 9 })).toEqual({ ok: true, kind: 'save', id: 9 });
    expect(readGoalAnswer(save, 200, { ok: true })).toMatchObject({ ok: false, problem: 'other' });
    expect(readGoalAnswer({ kind: 'delete', goalId: 1 }, 200, { ok: true })).toEqual({ ok: true, kind: 'delete' });
    expect(readGoalAnswer(save, 409, { error: 'too-many-goals', limit: 20 })).toEqual({ ok: false, problem: 'too-many-goals', status: 409, limit: 20 });
    expect(readGoalAnswer(save, 429, { error: 'changes-spent' })).toMatchObject({ problem: 'changes-spent', limit: null });
    expect(readGoalAnswer({ kind: 'delete', goalId: 1 }, 404, { error: 'goal-not-found' })).toMatchObject({ problem: 'not-found' });
    expect(readGoalAnswer(save, 401, null)).toMatchObject({ problem: 'refused' });
  });
  it('reads a list strictly', () => {
    const g = goal({});
    expect(readGoalAnswer({ kind: 'list' }, 200, { goals: [g], limits: { maxPerWallet: 20 } })).toEqual({ ok: true, kind: 'list', goals: [g], maxGoals: 20 });
    expect(readGoalAnswer({ kind: 'list' }, 200, { goals: [{ ...g, id: 0 }] })).toMatchObject({ ok: false, problem: 'other' });
  });
});

describe('goalFromForm', () => {
  const base = { name: ' House ', target: 120n, date: LATER };
  it('builds a goal on loans in one token', () => {
    const r = goalFromForm({ ...base, attach: { kind: 'loans', loanIds: [1n, 2n] } }, rows, NOW);
    expect(r).toEqual({ ok: true, goal: { name: 'House', asset: USDC.toLowerCase(), targetAmount: '120', targetDate: LATER, attachTo: { kind: 'loans', loanIds: [1, 2] } } });
  });
  it('refuses mixed tokens, borrower-side loans and empty choices', () => {
    expect(goalFromForm({ ...base, attach: { kind: 'loans', loanIds: [1n, 3n] } }, rows, NOW)).toEqual({ ok: false, problem: 'mixed-tokens' });
    expect(goalFromForm({ ...base, attach: { kind: 'loans', loanIds: [4n] } }, rows, NOW)).toEqual({ ok: false, problem: 'no-loans' });
    expect(goalFromForm({ ...base, attach: { kind: 'slot', slot: null } }, rows, NOW)).toEqual({ ok: false, problem: 'no-slot' });
  });
  it('builds a goal on a slot, in its lending token', () => {
    const r = goalFromForm({ ...base, attach: { kind: 'slot', slot: { lendingAsset: USDC, collateralAsset: WETH, slot: 2 } } }, [], NOW);
    expect(r).toMatchObject({ ok: true, goal: { asset: USDC.toLowerCase(), attachTo: { kind: 'slot', lendingAsset: USDC.toLowerCase(), collateralAsset: WETH, slot: 2 } } });
  });
  it('refuses a missing amount, a missing or past date, and a bad name', () => {
    const attach = { kind: 'loans', loanIds: [1n] } as const;
    expect(goalFromForm({ ...base, target: 0n, attach }, rows, NOW)).toEqual({ ok: false, problem: 'amount' });
    expect(goalFromForm({ ...base, date: null, attach }, rows, NOW)).toEqual({ ok: false, problem: 'date' });
    expect(goalFromForm({ ...base, date: NOW, attach }, rows, NOW)).toEqual({ ok: false, problem: 'past' });
    expect(goalFromForm({ ...base, name: '  ', attach }, rows, NOW)).toEqual({ ok: false, problem: 'name' });
  });
  it('offers only lender-side token loans', () => {
    expect(goalLoans(rows).map((r) => r.loan.id)).toEqual([1n, 2n, 3n]);
  });
});

describe('progress', () => {
  it('counts principal out in the attached loans and says what it could not find', () => {
    const p = loansProgress(goal({ attachTo: { kind: 'loans', loanIds: [1, 2, 8] } }), rows, true);
    expect(p).toEqual({ kind: 'loans', counted: 150n, countedLoans: 2, notFound: 1, complete: true, reached: true });
  });
  it('never calls a goal reached from a partial read', () => {
    expect(loansProgress(goal({}), rows, false)).toMatchObject({ counted: 150n, reached: false, complete: false });
  });
  it('counts a slot as waiting plus lent', () => {
    const g = goal({ attachTo: { kind: 'slot', lendingAsset: USDC.toLowerCase(), collateralAsset: WETH.toLowerCase(), slot: 2 } });
    expect(slotProgress(g, [slot(USDC, 2, 50n, 60n)], true)).toEqual({ kind: 'slot', waiting: 50n, lent: 60n, active: true, reached: false });
    expect(slotProgress(g, [slot(USDC, 3, 500n, 0n)], false)).toEqual({ kind: 'slot-missing', complete: false });
    expect(loansProgress(g, rows, true)).toBeNull();
  });
});

describe('endOfUtcDay', () => {
  it('reads the last second of the chosen UTC day', () => {
    expect(endOfUtcDay('2027-01-02')).toBe(Date.UTC(2027, 0, 2, 23, 59, 59) / 1000);
    expect(endOfUtcDay('')).toBeNull();
  });
});
