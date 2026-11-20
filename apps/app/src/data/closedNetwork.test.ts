import { describe, expect, it } from 'vitest';
import { heldSlots } from './closedNetwork';

const A = `0x${'aa'.repeat(20)}` as const;
const B = `0x${'bb'.repeat(20)}` as const;

describe('slots a Closed network still holds capital in (#3858)', () => {
  it('keeps a slot with capital, active or cancelled, and drops an empty one', () => {
    const rows = [
      { intent: { lendingAsset: A, collateralAsset: B, slot: 0, availableCapital: 5n }, active: true },
      { intent: { lendingAsset: A, collateralAsset: B, slot: 1, availableCapital: 0n }, active: true },
      { intent: { lendingAsset: B, collateralAsset: A, slot: 2, availableCapital: 9n }, active: false },
    ];
    expect(heldSlots(rows)).toEqual([
      { lendingAsset: A, collateralAsset: B, slot: 0, available: 5n },
      { lendingAsset: B, collateralAsset: A, slot: 2, available: 9n },
    ]);
  });
});
