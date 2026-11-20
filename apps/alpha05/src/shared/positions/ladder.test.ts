import { describe, expect, it } from 'vitest';
import { lendingLadder } from './ladder';
import { positionKey, type Deadlines, type LiveLoanRow } from './model';

const USDC = '0x00000000000000000000000000000000000000a1' as const;
const DAI = '0x00000000000000000000000000000000000000a2' as const;
const row = (id: bigint, asset: `0x${string}`, principal: bigint, borrowerSide = false, assetType = 0): LiveLoanRow =>
  ({ loan: { id, principalAsset: asset, principal, assetType }, healthFactor: 0n, borrowerSide }) as unknown as LiveLoanRow;
const due = (iso: string): Deadlines => ({ maturity: BigInt(Date.parse(iso) / 1000), graceEnd: 0n, pauseCredit: 0n, periodic: null });

describe('lending ladder (#3770)', () => {
  it('sums lent principal by due month and token, earliest first', () => {
    const rows = [row(1n, USDC, 100n), row(2n, USDC, 50n), row(3n, DAI, 7n), row(4n, USDC, 9n)];
    const dl = {
      [positionKey(rows[0]!)]: due('2026-12-03T00:00:00Z'),
      [positionKey(rows[1]!)]: due('2026-12-30T00:00:00Z'),
      [positionKey(rows[2]!)]: due('2026-12-15T00:00:00Z'),
      [positionKey(rows[3]!)]: due('2027-01-01T00:00:00Z'),
    };
    const l = lendingLadder(rows, dl, true);
    expect(l.rungs).toEqual([
      { month: '2026-12', asset: USDC, principal: 150n, loans: 2 },
      { month: '2026-12', asset: DAI, principal: 7n, loans: 1 },
      { month: '2027-01', asset: USDC, principal: 9n, loans: 1 },
    ]);
  });
  it('leaves out borrowings and rentals, and keeps an unread date apart', () => {
    const rows = [row(1n, USDC, 100n, true), row(2n, USDC, 5n, false, 1), row(3n, USDC, 8n)];
    const l = lendingLadder(rows, { [positionKey(rows[2]!)]: null }, false);
    expect(l.rungs).toEqual([]);
    expect(l.undated).toEqual([{ asset: USDC, principal: 8n, loans: 1 }]);
    expect(l.complete).toBe(false);
  });
});
