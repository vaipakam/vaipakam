/**
 * #2459 r2 — the match preview checks the capacity of the matcher it is NAMED,
 * so the keeper names itself: the account `matchOffers` would charge. (A
 * preview keyed on the caller read as the zero address from an `eth_call`
 * with no `from`, whose never-seen bucket always reads covered.)
 */
import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { previewMatchRequest } from '../src/matcher';

describe('previewMatchRequest', () => {
  it('names the keeper as the matcher whose capacity the preview checks', () => {
    const account = { address: '0x00000000000000000000000000000000000000aa', type: 'local' };
    const req = previewMatchRequest(
      { diamond: '0x00000000000000000000000000000000000000d1', wallet: { account } } as never,
      1n,
      2n,
    );
    expect(req.functionName).toBe('previewMatch');
    expect(req.args).toEqual([1n, 2n, account.address]);
  });

  it('a keeper with no signing account names nobody (the zero address), never a guess', () => {
    const req = previewMatchRequest(
      { diamond: '0x00000000000000000000000000000000000000d1', wallet: { account: undefined } } as never,
      1n,
      2n,
    );
    expect(req.args[2]).toBe(zeroAddress);
  });
});
