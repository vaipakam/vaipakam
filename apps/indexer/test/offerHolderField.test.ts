/**
 * #3744 — every offer row the indexer serves names who holds the offer's
 * position token (`holder`), because that holder, not the creator, takes the
 * creator's side of the loan, gets the escrow back and may edit or cancel.
 */
import { describe, expect, it } from 'vitest';
import { offerHolderOf } from '../src/offerRoutes';

const CREATOR = '0x' + 'C0'.repeat(20);
const BUYER = '0x' + 'B0'.repeat(20);

describe('offer holder field (#3744)', () => {
  it('names the recorded holder, lower-cased', () => {
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '7', creator_current_owner: BUYER })).toBe(
      BUYER.toLowerCase(),
    );
  });
  it('reads an offer with no position token as its creator', () => {
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '0', creator_current_owner: null })).toBe(
      CREATOR.toLowerCase(),
    );
  });
  it('says unknown, never the creator, when nothing is recorded', () => {
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '7', creator_current_owner: null })).toBeNull();
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '7', creator_current_owner: '' })).toBeNull();
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '7' })).toBeNull();
  });
  it('keeps the zero address of a retired token', () => {
    const zero = '0x' + '0'.repeat(40);
    expect(offerHolderOf({ creator: CREATOR, position_token_id: '7', creator_current_owner: zero })).toBe(zero);
  });
});
