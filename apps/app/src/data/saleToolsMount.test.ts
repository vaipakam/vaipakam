/** The sale tools' render gates and the chooser's reading of them
 *  (#1841, Codex #3024 r2, r4, r5): one derivation, so the rows and the
 *  tools they jump to cannot disagree. */
import { describe, expect, it } from 'vitest';
import {
  saleToolsAvailability,
  saleToolsMount,
  type SaleToolsMountInput,
} from './saleToolsMount';

const ok = { ready: true, failed: false };
const pending = { ready: false, failed: false };
const failed = { ready: false, failed: true };

const base: SaleToolsMountInput = {
  shown: true,
  saleAttemptable: true,
  principal: ok,
  sanctionsReady: true,
  loanLive: ok,
  salePending: false,
  matured: false,
  feeEnt: ok,
};

const advanced = (o: Partial<SaleToolsMountInput> = {}, sellerWindowReadable?: boolean) =>
  saleToolsAvailability({ ...base, ...o, isAdvanced: true, sellerWindowReadable });
const basic = (o: Partial<SaleToolsMountInput> = {}, sellerWindowReadable?: boolean) =>
  saleToolsAvailability({ ...base, ...o, isAdvanced: false, sellerWindowReadable });

describe('saleToolsMount', () => {
  it('mounts both tools only when every gate is met', () => {
    expect(saleToolsMount(base)).toEqual({ kind: 'tools' });
  });

  it.each([
    ['not shown', { shown: false }, { kind: 'absent' }],
    ['not attemptable', { saleAttemptable: false }, { kind: 'absent' }],
    ['no principal metadata', { principal: failed }, { kind: 'absent' }],
    ['loan read outstanding', { loanLive: pending, matured: undefined }, { kind: 'reading', failed: false }],
    ['loan read failed', { loanLive: failed, matured: undefined }, { kind: 'reading', failed: true }],
    ['sanctions unread', { sanctionsReady: false }, { kind: 'reading', failed: false }],
    ['a listing stands', { salePending: true }, { kind: 'listing' }],
    ['matured', { matured: true }, { kind: 'matured' }],
    ['fee plan outstanding', { feeEnt: pending }, { kind: 'disclosure', failed: false }],
    ['fee plan failed', { feeEnt: failed }, { kind: 'disclosure', failed: true }],
  ] as const)('%s', (_label, over, want) => {
    expect(saleToolsMount({ ...base, ...over })).toEqual(want);
  });

  it('checks the gates in the block’s order', () => {
    // A listing outranks maturity and the fee plan; the loan read
    // outranks the listing.
    expect(saleToolsMount({ ...base, salePending: true, matured: true, feeEnt: failed })).toEqual({
      kind: 'listing',
    });
    expect(saleToolsMount({ ...base, loanLive: pending, salePending: true })).toEqual({
      kind: 'reading',
      failed: false,
    });
  });
});

describe('saleToolsAvailability', () => {
  it('opens the rows exactly when the tools are on the page', () => {
    expect(advanced()).toBe('ready');
  });

  it('waits, never opens, while a tool render gate still holds (r2, r4, r5)', () => {
    expect(advanced({ saleAttemptable: false })).toBe('checking');
    expect(advanced({ salePending: true })).toBe('checking');
    // r5: the chain clock reached the loan's end before the verdict
    // refreshed. The block removes both anchors at once, so the rows wait.
    expect(advanced({ matured: true })).toBe('checking');
  });

  it('says failed where no wait ends', () => {
    expect(advanced({ principal: failed })).toBe('failed');
    expect(advanced({ loanLive: failed, matured: undefined })).toBe('failed');
    expect(advanced({ feeEnt: failed })).toBe('failed');
    // The block mounts but neither form can price a sale (r19).
    expect(advanced({}, false)).toBe('failed');
  });

  it('does not wait in Basic on the loan read that only Advanced runs', () => {
    expect(basic({ loanLive: pending, matured: undefined })).toBe('ready');
    expect(basic({ loanLive: failed, matured: undefined })).toBe('ready');
    // Every gate outside the loan read still applies in Basic.
    expect(basic({ salePending: true })).toBe('checking');
    expect(basic({ saleAttemptable: false })).toBe('checking');
    expect(basic({ feeEnt: failed })).toBe('failed');
    expect(basic({ sanctionsReady: false })).toBe('checking');
  });
});
