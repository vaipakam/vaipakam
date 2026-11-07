import { describe, expect, it } from 'vitest';
import { defaultVerdict, recordedInitFeeBps, roleOf, treasuryShareBps } from './loanView';

const me = '0x00000000000000000000000000000000000000aa' as const;
const other = '0x00000000000000000000000000000000000000bb' as const;

describe('roleOf', () => {
  it('reads the role from the positions held now', () => {
    expect(roleOf({ lender: me, borrower: other }, me)).toEqual({ lender: true, borrower: false });
    expect(roleOf({ lender: other, borrower: me }, me)).toEqual({ lender: false, borrower: true });
    expect(roleOf({ lender: me, borrower: me }, me)).toEqual({ lender: true, borrower: true });
    expect(roleOf({ lender: other, borrower: other }, me)).toEqual({ lender: false, borrower: false });
  });

  it('stays confirming while either holder is unread, even when the other is the reader', () => {
    expect(roleOf({ lender: me, borrower: null }, me)).toBeNull();
    expect(roleOf({ lender: null, borrower: me }, me)).toBeNull();
    expect(roleOf({ lender: null, borrower: other }, me)).toBeNull();
  });
});

describe('treasuryShareBps', () => {
  it('reads a recorded share as it is, and a recorded 0 as the legacy rate settlement charges', () => {
    expect(treasuryShareBps({ treasuryFeeBpsAtInit: 200 })).toEqual({ bps: 200, legacy: false });
    expect(treasuryShareBps({ treasuryFeeBpsAtInit: 0 })).toEqual({ bps: 100, legacy: true });
  });
});

describe('recordedInitFeeBps', () => {
  it('reads a recorded initiation fee rate, and a recorded 0 as not recorded', () => {
    expect(recordedInitFeeBps({ loanInitiationFeeBpsAtInit: 20 })).toBe(20);
    expect(recordedInitFeeBps({ loanInitiationFeeBpsAtInit: 0 })).toBeNull();
  });
});

describe('defaultVerdict', () => {
  const open = { timing: true, paused: false, sequencerHealthy: true, admitted: true };
  it('allows a default only when every readable gate passes', () => {
    expect(defaultVerdict(open)).toEqual({ defaultable: true, refusal: null });
    expect(defaultVerdict({ ...open, timing: false })).toEqual({ defaultable: false, refusal: null });
  });
  it('names the gate that refuses a default the timing allows', () => {
    expect(defaultVerdict({ ...open, paused: true })).toEqual({ defaultable: false, refusal: 'paused' });
    expect(defaultVerdict({ ...open, sequencerHealthy: false })).toEqual({ defaultable: false, refusal: 'sequencer' });
    expect(defaultVerdict({ ...open, admitted: false })).toEqual({ defaultable: false, refusal: 'admission' });
  });
  it('is unknown, never allowed, while a needed gate is unread', () => {
    expect(defaultVerdict({ ...open, timing: null }).defaultable).toBeNull();
    expect(defaultVerdict({ ...open, paused: null }).defaultable).toBeNull();
    expect(defaultVerdict({ ...open, sequencerHealthy: null }).defaultable).toBeNull();
    expect(defaultVerdict({ ...open, admitted: null }).defaultable).toBeNull();
  });
});
