import { describe, expect, it } from 'vitest';
import { approvalRefOf } from './positionApprovalNotice';
import type { IndexedNotification } from './indexer';

const ADDR = '0x00000000000000000000000000000000000000Cd';
const row = (kind: string, data: Record<string, unknown> | null): IndexedNotification => ({
  id: 1,
  kind,
  loanId: null,
  offerId: null,
  eventKind: null,
  data,
  createdAt: 1,
  blockNumber: 1,
  logIndex: 0,
});

describe('approvalRefOf (#3721)', () => {
  it('names the token and the whole address for a per-token grant', () => {
    expect(approvalRefOf(row('position_approved', { tokenId: '12', approved: ADDR }))).toBe(
      `Position token #12 · approved to ${ADDR}`,
    );
  });

  it('names the operator for a grant over every token', () => {
    expect(approvalRefOf(row('position_approved_all', { operator: ADDR }))).toBe(`Every position token · opened to ${ADDR}`);
  });

  it('says nothing it cannot read, and nothing for another kind', () => {
    expect(approvalRefOf(row('position_approved', { tokenId: 'x', approved: ADDR }))).toBeNull();
    expect(approvalRefOf(row('position_approved', { tokenId: '1', approved: 'nope' }))).toBeNull();
    expect(approvalRefOf(row('position_approved_all', null))).toBeNull();
    expect(approvalRefOf(row('loan_repaid', { tokenId: '1', approved: ADDR }))).toBeNull();
  });
});
