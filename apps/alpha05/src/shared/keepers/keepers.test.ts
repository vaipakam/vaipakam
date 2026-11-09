import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS, KEEPER_ACTIONS, actionsIn, changeCall, changeLanded, changeMoved, changeRefusal, widens, type KeeperSettings } from './keepers';
import { keeperName, keeperReceipt } from './keeperReceipt';

type Hex = `0x${string}`;
const k1 = '0x00000000000000000000000000000000000000B1' as Hex;
const k2 = '0x00000000000000000000000000000000000000b2' as Hex;
const settings = (over: Partial<KeeperSettings> = {}): KeeperSettings => ({ access: true, keepers: [{ keeper: k1, actions: 0x01 | 0x20 }], blockNumber: 1n, ...over });
const copy = { text: (k: string) => k, format: (k: string, v: Record<string, string>) => `${k}:${Object.values(v).join(',')}` };

describe('the keeper actions', () => {
  it('match the protocol bits, without the retired one', () => {
    expect(ALL_ACTIONS).toBe(0x1ef);
    expect(KEEPER_ACTIONS.some((a) => a.bit === 0x10)).toBe(false);
    expect(actionsIn(0x21).map((a) => a.bit)).toEqual([0x01, 0x20]);
  });
});

describe('a keeper change', () => {
  it('sends the one call that makes it', () => {
    expect(changeCall({ kind: 'access', on: true })).toEqual({ functionName: 'setKeeperAccess', args: [true] });
    expect(changeCall({ kind: 'approve', keeper: k2, actions: 3 })).toEqual({ functionName: 'approveKeeper', args: [k2, 3] });
    expect(changeCall({ kind: 'actions', keeper: k1, actions: 1 })).toEqual({ functionName: 'setKeeperActions', args: [k1, 1] });
    expect(changeCall({ kind: 'revoke', keeper: k1 })).toEqual({ functionName: 'revokeKeeper', args: [k1] });
  });
  it('widens only when it gives a keeper more', () => {
    const s = settings();
    expect(widens({ kind: 'access', on: true }, s)).toBe(true);
    expect(widens({ kind: 'access', on: false }, s)).toBe(false);
    expect(widens({ kind: 'approve', keeper: k2, actions: 1 }, s)).toBe(true);
    expect(widens({ kind: 'actions', keeper: k1, actions: 0x01 }, s)).toBe(false);
    expect(widens({ kind: 'actions', keeper: k1, actions: 0x01 | 0x40 }, s)).toBe(true);
    expect(widens({ kind: 'revoke', keeper: k1 }, s)).toBe(false);
  });
  it('is refused before it is offered where the protocol would refuse it', () => {
    const s = settings();
    expect(changeRefusal({ kind: 'access', on: true }, s)).toBe('keepers.already');
    expect(changeRefusal({ kind: 'approve', keeper: k2, actions: 0 }, s)).toBe('keepers.pickAction');
    expect(changeRefusal({ kind: 'approve', keeper: k2, actions: 0x10 }, s)).toBe('keepers.pickAction');
    expect(changeRefusal({ kind: 'approve', keeper: k1.toLowerCase() as Hex, actions: 1 }, s)).toBe('keepers.alreadyApproved');
    const full = settings({ keepers: [1, 2, 3, 4, 5].map((i) => ({ keeper: `0x${String(i).padStart(40, '0')}` as Hex, actions: 1 })) });
    expect(changeRefusal({ kind: 'approve', keeper: k2, actions: 1 }, full)).toBe('keepers.full');
    expect(changeRefusal({ kind: 'actions', keeper: k2, actions: 1 }, s)).toBe('keepers.notApproved');
    expect(changeRefusal({ kind: 'actions', keeper: k1, actions: 0x21 }, s)).toBe('keepers.already');
    expect(changeRefusal({ kind: 'revoke', keeper: k2 }, s)).toBe('keepers.notApproved');
    expect(changeRefusal({ kind: 'approve', keeper: k2, actions: 0x100 }, s)).toBeNull();
  });
  it('reads as moved when what its receipt states moved, and as landed when it reads back', () => {
    const a = settings();
    expect(changeMoved({ kind: 'revoke', keeper: k1 }, a, settings({ access: false }))).toBe(true);
    expect(changeMoved({ kind: 'actions', keeper: k1, actions: 1 }, a, settings({ keepers: [{ keeper: k1, actions: 1 }] }))).toBe(true);
    expect(changeMoved({ kind: 'access', on: false }, a, settings({ keepers: [] }))).toBe(false);
    expect(changeLanded({ kind: 'approve', keeper: k2, actions: 3 }, settings({ keepers: [{ keeper: k2, actions: 3 }] }))).toBe(true);
    expect(changeLanded({ kind: 'revoke', keeper: k1 }, a)).toBe(false);
    expect(changeLanded({ kind: 'access', on: true }, a)).toBe(true);
  });
});

describe('the receipt', () => {
  it("names this app's keeper and states before and after", () => {
    expect(keeperName(k1, k1.toLowerCase(), 'Base Sepolia', copy)).toMatch(/^keepers.networkKeeper:Base Sepolia/);
    const r = keeperReceipt({ kind: 'actions', keeper: k1, actions: 0x01 }, settings(), copy, { chain: 'Base Sepolia', network: null, readAt: 0 });
    expect(r.title).toBe('keepers.titleActions');
    expect(r.rows.map((row) => row.label)).toEqual(['keepers.rowKeeper', 'keepers.rowBefore', 'keepers.rowAfter', 'keepers.rowWhere', 'risk.rowMoves']);
  });
  it('says a grant waits on access when access is off', () => {
    const r = keeperReceipt({ kind: 'approve', keeper: k2, actions: 1 }, settings({ access: false }), copy, { chain: 'X', network: null, readAt: 0 });
    expect(r.consequences).toContain('keepers.accessOffNote');
    expect(r.consequences).not.toContain('keepers.accountWideNote');
  });
  it('says when a grant adds an action no loan has to name the keeper for', () => {
    const adds = keeperReceipt({ kind: 'actions', keeper: k1, actions: 0x21 | 0x100 }, settings(), copy, { chain: 'X', network: null, readAt: 0 });
    expect(adds.consequences).toContain('keepers.accountWideNote');
    const keeps = keeperReceipt({ kind: 'actions', keeper: k1, actions: 0x100 }, settings({ keepers: [{ keeper: k1, actions: 0x121 }] }), copy, { chain: 'X', network: null, readAt: 0 });
    expect(keeps.consequences).not.toContain('keepers.accountWideNote');
  });
});
