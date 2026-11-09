import { describe, expect, it } from 'vitest';
import { addCollateralVerdict, checkTopUp, type AddCollateralInputs } from './addCollateral';

const copy = { text: (k: string) => k } as never;
const ME = '0x00000000000000000000000000000000000000aa' as const;
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

const base: AddCollateralInputs = { status: 0, assetType: 0, borrowerHolder: ME, borrowerLock: 0, assetPaused: false, collateralLiquid: true };
const verdict = (over: Partial<AddCollateralInputs>) => addCollateralVerdict({ ...base, ...over }, ME, copy, 1);
const code = (over: Partial<AddCollateralInputs>) => verdict(over).refusals[0]?.code;

describe('addCollateralVerdict', () => {
  it('is open to the borrower position holder on a running or fallback loan', () => {
    expect(verdict({}).state).toBe('open');
    expect(verdict({ status: 4 }).state).toBe('open');
  });
  it('holds in the order the protocol checks', () => {
    expect(code({ borrowerLock: 4, borrowerHolder: OTHER })).toBe('IntentPending');
    expect(code({ borrowerHolder: OTHER })).toBe('NotNFTOwner');
    expect(code({ status: 1 })).toBe('LoanNotActive');
    expect(code({ assetType: 1 })).toBe('RentalCollateralNotAllowed');
    expect(code({ assetPaused: true, collateralLiquid: false })).toBe('AssetPaused');
    expect(code({ collateralLiquid: false })).toBe('IlliquidAsset');
  });
  it('is unknown when an input is unread, never open', () => {
    expect(verdict({ borrowerHolder: null }).state).toBe('unknown');
    expect(verdict({ borrowerLock: null }).state).toBe('unknown');
    expect(verdict({ assetPaused: null }).state).toBe('unknown');
    expect(verdict({ collateralLiquid: null }).state).toBe('unknown');
  });
  it('is not held by an offset lock or the pause (not an input)', () => {
    expect(verdict({ borrowerLock: 1 }).state).toBe('open');
  });
});

describe('checkTopUp', () => {
  it('takes more than nothing within the balance', () => {
    expect(checkTopUp(5n, 10n)).toEqual({ ok: true });
    expect(checkTopUp(0n, 10n)).toEqual({ ok: false, why: 'zero' });
    expect(checkTopUp(11n, 10n)).toEqual({ ok: false, why: 'over-balance' });
    expect(checkTopUp(11n, null)).toEqual({ ok: true });
  });
});
