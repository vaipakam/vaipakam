import { describe, expect, it } from 'vitest';
import { checkTakeBack, takeBackVerdict, type TakeBackInputs } from './takeBack';

const copy = { text: (k: string) => k } as never;
const ME = '0x00000000000000000000000000000000000000aa' as const;
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

const base: TakeBackInputs = { status: 0, assetType: 0, paused: false, borrowerHolder: ME, borrowerLock: 0, refinanceLive: false, collateralLiquid: true, maxWithdrawable: 10n };
const verdict = (over: Partial<TakeBackInputs>) => takeBackVerdict({ ...base, ...over }, ME, copy, 1);
const code = (over: Partial<TakeBackInputs>) => verdict(over).refusals[0]?.code;

describe('takeBackVerdict', () => {
  it('is open to the borrower position holder on a running loan with room above its limits', () => {
    expect(verdict({}).state).toBe('open');
  });
  it('holds in the order the protocol checks', () => {
    expect(code({ paused: true, borrowerLock: 4, refinanceLive: true, borrowerHolder: OTHER })).toBe('EnforcedPause');
    expect(code({ borrowerLock: 4, refinanceLive: true, borrowerHolder: OTHER })).toBe('IntentPending');
    expect(code({ refinanceLive: true, borrowerHolder: OTHER })).toBe('RefinanceRequestOpen');
    expect(code({ borrowerHolder: OTHER, status: 4 })).toBe('NotNFTOwner');
    expect(code({ status: 4 })).toBe('LoanNotActive');
    expect(code({ assetType: 1 })).toBe('RentalCollateralNotAllowed');
    expect(code({ collateralLiquid: false, maxWithdrawable: 0n })).toBe('IlliquidAsset');
    expect(code({ maxWithdrawable: 0n })).toBe('NothingToTakeBack');
  });
  it('is unknown when an input is unread, never open', () => {
    for (const k of ['paused', 'borrowerHolder', 'borrowerLock', 'refinanceLive', 'collateralLiquid', 'maxWithdrawable'] as const)
      expect(verdict({ [k]: null }).state).toBe('unknown');
  });
  it('is not held by an offset lock', () => {
    expect(verdict({ borrowerLock: 1 }).state).toBe('open');
  });
});

describe('checkTakeBack', () => {
  it('takes more than nothing within the protocol limit', () => {
    expect(checkTakeBack(10n, 10n)).toEqual({ ok: true });
    expect(checkTakeBack(0n, 10n)).toEqual({ ok: false, why: 'zero' });
    expect(checkTakeBack(11n, 10n)).toEqual({ ok: false, why: 'over-limit' });
  });
});
