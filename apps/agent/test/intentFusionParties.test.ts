import { describe, it, expect } from 'vitest';
import { makerConfirmedBeforePost, orderPartiesError } from '../src/intentFusionPost';

// #1566 S3e -- a swap-to-repay order's maker is the borrower's vault, a
// buyback order's the diamond; every order pays the diamond.
const DIAMOND = '0xd89f000000000000000000000000000000000001';
const VAULT = '0x00000000000000000000000000000000000000aa';
const STRANGER = '0x00000000000000000000000000000000000000bb';

describe('orderPartiesError', () => {
  it('admits a swap-to-repay order made by a vault and paying the diamond', () => {
    expect(orderPartiesError('swap_to_repay', { maker: VAULT, receiver: DIAMOND }, DIAMOND)).toBeNull();
  });

  it('compares addresses case-insensitively', () => {
    expect(
      orderPartiesError('swap_to_repay', { maker: VAULT, receiver: DIAMOND.toUpperCase().replace('0X', '0x') }, DIAMOND),
    ).toBeNull();
  });

  it('refuses any order that does not pay the diamond', () => {
    expect(orderPartiesError('swap_to_repay', { maker: VAULT, receiver: STRANGER }, DIAMOND)).toBe(
      'maker-receiver-not-diamond',
    );
    expect(orderPartiesError('buyback', { maker: DIAMOND, receiver: STRANGER }, DIAMOND)).toBe(
      'maker-receiver-not-diamond',
    );
  });

  it('binds a buyback order to the diamond as maker', () => {
    expect(orderPartiesError('buyback', { maker: DIAMOND, receiver: DIAMOND }, DIAMOND)).toBeNull();
    expect(orderPartiesError('buyback', { maker: VAULT, receiver: DIAMOND }, DIAMOND)).toBe(
      'maker-receiver-not-diamond',
    );
  });
});

describe('makerConfirmedBeforePost', () => {
  it('forwards a swap-to-repay order only after the on-chain preflight matched', () => {
    expect(makerConfirmedBeforePost('swap_to_repay', 'ok')).toBe(true);
    expect(makerConfirmedBeforePost('swap_to_repay', 'degraded')).toBe(false);
    expect(makerConfirmedBeforePost('swap_to_repay', 'skipped')).toBe(false);
  });

  it('forwards a buyback order whose maker the offline check already bound', () => {
    expect(makerConfirmedBeforePost('buyback', 'ok')).toBe(true);
    expect(makerConfirmedBeforePost('buyback', 'degraded')).toBe(true);
    expect(makerConfirmedBeforePost('buyback', 'skipped')).toBe(true);
  });
});
