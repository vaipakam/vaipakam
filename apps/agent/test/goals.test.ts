/**
 * #3771 — goals: the shared shape and messages, the store on SQLite as the
 * state object runs it, and the signed routes.
 */
import { describe, expect, it } from 'vitest';
import { buildSaveGoalMessage, goalNameOk, parseGoalInput, type GoalInput } from '@vaipakam/lib/goals';
import { TelegramStateStore } from '../src/telegramState/store';
import { GoalStore, type GoalLimits } from '../src/telegramState/goals';
import { goalLimitsOf, handleGoalRoute, type GoalRouteDeps } from '../src/goalRoutes';
import type { AlertAuthorisation } from '../src/linkAuth';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const OTHER = '0x00000000000000000000000000000000000000ee';
const ASSET = '0x00000000000000000000000000000000000000Aa';
const dep = { chainId: 84532, diamond: '0x00000000000000000000000000000000000000a1' };
const LIMITS: GoalLimits = { maxPerWallet: 2, maxChangesPerDay: 4 };

const goal = (over: Partial<GoalInput> = {}): GoalInput => ({
  name: 'House deposit',
  asset: ASSET.toLowerCase(),
  targetAmount: '5000000000',
  targetDate: 1_900_000_000,
  attachTo: { kind: 'loans', loanIds: [3, 9] },
  ...over,
});

function goals() {
  const h = sqliteDo();
  new TelegramStateStore(h.sql, h.tx);
  return { ...h, store: new GoalStore(h.sql, h.tx) };
}

describe('goal shape and messages', () => {
  it('accepts one plain line as a name, and nothing that could add a line', () => {
    expect(goalNameOk('Holiday 2027')).toBe(true);
    for (const bad of ['', ' padded', 'two\nlines', 'a b', 'x'.repeat(61), 42]) expect(goalNameOk(bad)).toBe(false);
  });

  it('checks every field and settles the values that are signed and stored', () => {
    const ok = parseGoalInput({ ...goal(), asset: ASSET, attachTo: { kind: 'loans', loanIds: [9, 3, 9] } });
    expect(ok).toEqual({ ok: true, goal: goal() });
    expect(parseGoalInput({ ...goal(), targetAmount: '0' }).ok).toBe(false);
    expect(parseGoalInput({ ...goal(), targetAmount: '1.5' }).ok).toBe(false);
    expect(parseGoalInput({ ...goal(), attachTo: { kind: 'loans', loanIds: [] } }).ok).toBe(false);
    expect(parseGoalInput({ ...goal(), attachTo: { kind: 'slot', slotId: 4 } })).toMatchObject({ ok: true });
  });

  it('names every saved value in the signed message', () => {
    const m = buildSaveGoalMessage(W, 84532, null, goal(), 1);
    expect(m).toContain('Goal: new');
    expect(m).toContain('Name: House deposit');
    expect(m).toContain(`Target: 5000000000 (smallest unit) of ${ASSET.toLowerCase()}`);
    expect(m).toContain('By (unix): 1900000000');
    expect(m).toContain('Attached to: loans 3, 9');
    expect(m).toContain('it locks nothing and changes nothing on chain');
    expect(buildSaveGoalMessage(W, 84532, 5, goal(), 1)).toContain('Goal: id 5');
  });
});

describe('goal store', () => {
  it('saves, changes, lists and deletes a wallet’s own goals only', () => {
    const { store } = goals();
    const a = store.save(dep, W, null, goal(), 10, LIMITS);
    expect(a).toEqual({ kind: 'saved', id: 1 });
    expect(store.save(dep, OTHER, 1, goal(), 10, LIMITS)).toEqual({ kind: 'not-found' });
    expect(store.save(dep, W, 1, goal({ name: 'Car' }), 20, LIMITS)).toEqual({ kind: 'saved', id: 1 });
    const list = store.list(W, [dep]);
    expect(list).toEqual([
      { ...goal({ name: 'Car' }), id: 1, chainId: 84532, createdAt: 10, updatedAt: 20 },
    ]);
    expect(store.list(OTHER, [dep])).toEqual([]);
    expect(store.delete(dep, OTHER, 1, 30, LIMITS)).toBe('not-found');
    expect(store.delete(dep, W, 1, 30, LIMITS)).toBe('deleted');
    expect(store.list(W, [dep])).toEqual([]);
  });

  it('keeps the goal and change limits', () => {
    const { store } = goals();
    store.save(dep, W, null, goal(), 10, LIMITS);
    store.save(dep, W, null, goal(), 10, LIMITS);
    expect(store.save(dep, W, null, goal(), 10, LIMITS)).toEqual({ kind: 'too-many-goals' });
    store.save(dep, W, 1, goal(), 10, LIMITS);
    store.save(dep, W, 1, goal(), 10, LIMITS);
    expect(store.save(dep, W, 1, goal(), 10, LIMITS)).toEqual({ kind: 'changes-spent' });
    expect(store.delete(dep, W, 1, 10 + 86_400, LIMITS)).toBe('deleted');
  });

  it('does not list a goal saved against a retired Diamond', () => {
    const { store } = goals();
    store.save(dep, W, null, goal(), 10, LIMITS);
    expect(store.list(W, [{ chainId: 84532, diamond: '0x00000000000000000000000000000000000000b2' }])).toEqual([]);
  });
});

function routeDeps(over: Partial<GoalRouteDeps> = {}): GoalRouteDeps & { authorised: AlertAuthorisation[] } {
  const { store } = goals();
  const authorised: AlertAuthorisation[] = [];
  return {
    authorised,
    state: {
      saveGoal: (d, w, id, g, now, l) => store.save(d, w, id, g, now, l),
      deleteGoal: (d, w, id, now, l) => store.delete(d, w, id, now, l),
      listGoals: (w, deps) => store.list(w, deps),
    },
    authorise: async (_req, auth) => {
      authorised.push(auth);
      return { ok: true, via: 'ecdsa' };
    },
    deployments: () => [dep],
    limits: LIMITS,
    now: () => 100,
    ...over,
  };
}

const body = (extra: Record<string, unknown> = {}) => ({
  wallet: W,
  chain_id: 84532,
  issuedAt: 100,
  signature: '0x' + '11'.repeat(65),
  ...extra,
});

describe('goal routes', () => {
  it('signs over the checked values and stores exactly those', async () => {
    const d = routeDeps();
    const res = await handleGoalRoute('/goals/save', body({ goal: { ...goal(), asset: ASSET } }), d);
    expect(res).toEqual({ status: 200, body: { ok: true, id: 1 } });
    expect(d.authorised[0]).toEqual({ action: 'save-goal', goalId: null, goal: goal() });
    const list = await handleGoalRoute('/goals/list', body(), d);
    expect((list.body.goals as unknown[]).length).toBe(1);
    expect(d.authorised[1]).toBe('list-goals');
    expect(await handleGoalRoute('/goals/delete', body({ goalId: 1 }), d)).toEqual({ status: 200, body: { ok: true } });
    expect(d.authorised[2]).toEqual({ action: 'delete-goal', goalId: 1 });
  });

  it('refuses a bad goal before asking for the signature, and a failed signature', async () => {
    const d = routeDeps();
    const res = await handleGoalRoute('/goals/save', body({ goal: { ...goal(), name: 'a\nb' } }), d);
    expect(res.status).toBe(400);
    expect(d.authorised).toEqual([]);
    const bad = routeDeps({ authorise: async () => ({ ok: false, status: 409, reason: 'used' }) });
    expect((await handleGoalRoute('/goals/list', body(), bad)).body.error).toBe('request-already-used');
    expect((await handleGoalRoute('/goals/save', body({ goal: goal(), chain_id: 1 }), d)).body.error).toBe('chain-not-served');
  });

  it('reads the limits from configuration', () => {
    expect(goalLimitsOf({})).toEqual({ maxPerWallet: 20, maxChangesPerDay: 50 });
    expect(goalLimitsOf({ GOALS_MAX_PER_WALLET: '5' })).toEqual({ maxPerWallet: 5, maxChangesPerDay: 50 });
  });
});
