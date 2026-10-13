/**
 * #2459 r2 / r4 — the match and intent previews check the capacity the route
 * charges for the matcher (solver) and outer initiator they are NAMED, so the
 * keeper names itself for both: it submits from its own transaction. (A preview
 * keyed on the caller, or on the view's originator, read as the zero address
 * from an `eth_call` with no `from`, whose never-seen bucket always reads covered.)
 */
import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { previewIntentRequest, previewMatchRequest } from '../src/matcher';

describe('previewMatchRequest', () => {
  it('names the keeper as the matcher whose capacity the preview checks', () => {
    const account = { address: '0x00000000000000000000000000000000000000aa', type: 'local' };
    const req = previewMatchRequest(
      { diamond: '0x00000000000000000000000000000000000000d1', wallet: { account } } as never,
      1n,
      2n,
    );
    expect(req.functionName).toBe('previewMatch');
    expect(req.args).toEqual([1n, 2n, account.address, account.address]);
  });

  it('a keeper with no signing account names nobody (the zero address), never a guess', () => {
    const req = previewMatchRequest(
      { diamond: '0x00000000000000000000000000000000000000d1', wallet: { account: undefined } } as never,
      1n,
      2n,
    );
    expect(req.args[2]).toBe(zeroAddress);
    expect(req.args[3]).toBe(zeroAddress);
  });
});

describe('previewIntentRequest', () => {
  it('names the keeper as both the solver and the initiator of its own fill', () => {
    const solver = '0x00000000000000000000000000000000000000aa' as const;
    const intent = {
      owner: '0x00000000000000000000000000000000000000b1',
      lendingAsset: '0x00000000000000000000000000000000000000c1',
      collateralAsset: '0x00000000000000000000000000000000000000c2',
    } as const;
    const req = previewIntentRequest('0x00000000000000000000000000000000000000d1', solver, intent, 7n, 9n);
    expect(req.functionName).toBe('previewIntent');
    expect(req.args).toEqual([
      solver,
      solver,
      intent.owner,
      intent.lendingAsset,
      intent.collateralAsset,
      7n,
      9n,
    ]);
  });
});
