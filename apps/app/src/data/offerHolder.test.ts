/**
 * #3744 — the offer holder rules and the live confirmation of held lines.
 */
import { describe, expect, it } from 'vitest';
import {
  canRaiseOfferEscrow,
  isOfferHolder,
  isOwnOffer,
  offerHeldByOther,
  offerHolder,
} from './offerHolder';
import { confirmHeldLines } from './offerHeldRefunds';

const CREATOR = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';

const offer = (holder: string | null | undefined, positionTokenId = '7') => ({
  creator: CREATOR,
  positionTokenId,
  holder,
});

describe('offerHolder', () => {
  it('reads an offer with no position token as its creator\'s', () => {
    expect(offerHolder(offer(undefined, '0'))).toBe(CREATOR);
  });
  it('is unknown, never the creator, when no record names the holder', () => {
    expect(offerHolder(offer(undefined))).toBeNull();
    expect(isOfferHolder(offer(null), CREATOR)).toBeNull();
  });
  it('follows the token to a new holder', () => {
    const o = offer(BUYER.toUpperCase().replace('0X', '0x'));
    expect(isOfferHolder(o, BUYER)).toBe(true);
    expect(isOfferHolder(o, CREATOR)).toBe(false);
    expect(offerHeldByOther(o)).toBe(true);
  });
  it('treats a retired token as held by nobody', () => {
    expect(isOfferHolder(offer(ZERO), CREATOR)).toBe(false);
    expect(offerHeldByOther(offer(ZERO))).toBe(false);
  });
  it('lets only the creator still holding the token raise the escrow', () => {
    expect(canRaiseOfferEscrow(offer(CREATOR), CREATOR)).toBe(true);
    expect(canRaiseOfferEscrow(offer(BUYER), BUYER)).toBe(false);
    expect(canRaiseOfferEscrow(offer(BUYER), CREATOR)).toBe(false);
    expect(canRaiseOfferEscrow(offer(null), CREATOR)).toBe(false);
  });
  it('counts both the creator and the holder as the offer\'s own side', () => {
    expect(isOwnOffer(offer(BUYER), CREATOR)).toBe(true);
    expect(isOwnOffer(offer(BUYER), BUYER)).toBe(true);
    expect(isOwnOffer(offer(CREATOR), BUYER)).toBe(false);
  });
});

describe('confirmHeldLines', () => {
  const line = (positionToken: string) => ({
    positionToken,
    asset: '0x3333333333333333333333333333333333333333',
    tokenId: '0',
    indexedRemaining: '100',
    offerIds: [1],
    assetKind: 0,
  });
  it('keeps the live amount, never the indexed one', () => {
    const out = confirmHeldLines([line('1')], [{ amount: 40n, holder: BUYER }], BUYER);
    expect(out).toHaveLength(1);
    expect(out[0].liveAmount).toBe(40n);
  });
  it('drops a line held for someone else or already collected', () => {
    const out = confirmHeldLines(
      [line('1'), line('2')],
      [
        { amount: 40n, holder: CREATOR },
        { amount: 0n, holder: BUYER },
      ],
      BUYER,
    );
    expect(out).toHaveLength(0);
  });
  it('keeps a line whose live read failed as unconfirmed', () => {
    const out = confirmHeldLines([line('1')], [null], BUYER);
    expect(out[0].liveAmount).toBeNull();
  });
});
