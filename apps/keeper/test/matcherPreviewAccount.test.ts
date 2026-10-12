/**
 * #1566 PR 1 re-review (A-1) — the match preview's capacity check keys on the
 * caller, so the keeper must read it FROM its own account: an `eth_call` with no
 * `from` reads as the zero address, whose never-seen bucket always reads covered.
 */
import { describe, expect, it } from 'vitest';
import { previewMatchRequest } from '../src/matcher';

describe('previewMatchRequest', () => {
  it('reads from the keeper account, so the capacity check sees the keeper', () => {
    const account = { address: '0x00000000000000000000000000000000000000aa', type: 'local' };
    const req = previewMatchRequest(
      { diamond: '0x00000000000000000000000000000000000000d1', wallet: { account } } as never,
      1n,
      2n,
    );
    expect(req.account).toBe(account);
    expect(req.functionName).toBe('previewMatch');
    expect(req.args).toEqual([1n, 2n]);
  });
});
