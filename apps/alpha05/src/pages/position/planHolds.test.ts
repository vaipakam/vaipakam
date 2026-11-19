import { describe, expect, it } from 'vitest';
import { planHolds, type Plan } from './GetCash';

const list: Plan = { route: 'list', rateBps: 900n, days: 7, minNet: 1000n, maxHeld: 50n };
const sale: Plan = { route: 'sale', offerId: 3n, rateBps: 900n, net: 1000n, maxHeld: 50n };
const handover: Plan = { route: 'handover', owner: '0x00000000000000000000000000000000000000aa', slot: 1, receives: 1000n };

describe('planHolds', () => {
  it('keeps a reviewed listing when the floor only rises and no more is swept', () => {
    expect(planHolds(list, { ...list, minNet: 1001n })).toBe(true);
    expect(planHolds(list, { ...list, minNet: 999n })).toBe(false);
    expect(planHolds(list, { ...list, maxHeld: 51n })).toBe(false);
    expect(planHolds(list, { ...list, days: 8 })).toBe(false);
  });
  it('keeps a reviewed sale only into the same offer, for at least the reviewed net', () => {
    expect(planHolds(sale, { ...sale, net: 1005n, maxHeld: 40n })).toBe(true);
    expect(planHolds(sale, { ...sale, net: 990n })).toBe(false);
    expect(planHolds(sale, { ...sale, offerId: 4n })).toBe(false);
    expect(planHolds(sale, list)).toBe(false);
  });
  it('keeps a handover only to the same slot, for at least the reviewed amount', () => {
    expect(planHolds(handover, { ...handover, owner: '0x00000000000000000000000000000000000000AA' })).toBe(true);
    expect(planHolds(handover, { ...handover, slot: 2 })).toBe(false);
    expect(planHolds(handover, { ...handover, receives: 999n })).toBe(false);
  });
});
