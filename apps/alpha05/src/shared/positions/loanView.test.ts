import { describe, expect, it } from 'vitest';
import { roleOf } from './loanView';

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
