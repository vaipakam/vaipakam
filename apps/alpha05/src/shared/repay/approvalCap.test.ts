import { maxUint256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { approvalRowText, lateConfirmationLines } from './approvalCap';

const A = '0x00000000000000000000000000000000000000aa' as const;
const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v?.prior ? `<${v.prior}` : ''}` } as never;

describe('approvalRowText', () => {
  it('states an approval already exact, a raise, a lowering and a zero step', () => {
    expect(approvalRowText({ allowance: 10n, steps: 0, cap: 10n }, A, null, copy)).toBe('repay.approvalEnough');
    expect(approvalRowText({ allowance: 1n, steps: 1, cap: 10n }, A, null, copy)).toBe('repay.approvalNeeded');
    expect(approvalRowText({ allowance: 50n, steps: 1, cap: 10n }, A, null, copy)).toMatch(/^repay\.approvalLower</);
    expect(approvalRowText({ allowance: 50n, steps: 2, cap: 10n }, A, null, copy)).toBe('repay.approvalZeroFirst');
  });
  it('names an unlimited approval as unlimited when it is lowered', () => {
    expect(approvalRowText({ allowance: maxUint256, steps: 1, cap: 10n }, A, null, copy)).toBe('repay.approvalLower<repay.unlimited');
  });
});

describe('lateConfirmationLines', () => {
  it('says the approval caps the amount, not the time, and adds the same-figure line only when the figure did not grow', () => {
    expect(lateConfirmationLines({ capped: false, time: 't', totalNow: 1n, totalBy: 2n }, copy)).toEqual(['repay.loseLate']);
    expect(lateConfirmationLines({ capped: false, time: 't', totalNow: 2n, totalBy: 2n }, copy)).toEqual(['repay.loseLate', 'repay.loseSame']);
  });
  it('names the grace end alone when the window reaches it', () => {
    expect(lateConfirmationLines({ capped: true, time: 't', totalNow: 2n, totalBy: 2n }, copy)).toEqual(['repay.loseGraceEnds']);
  });
});
