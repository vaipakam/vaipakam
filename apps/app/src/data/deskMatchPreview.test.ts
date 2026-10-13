import { describe, expect, it } from 'vitest';
import { readMatchPreviewLive } from './desk';

/**
 * #2459 r2 — the desk's match preview names the CONNECTED matcher: the contract
 * checks the capacity of the account it is given, so the read must pass the
 * wallet that would call `matchOffers`, never rely on the call's sender.
 */
describe('readMatchPreviewLive', () => {
  it('passes the matcher as the preview\'s third argument', async () => {
    let seen: readonly unknown[] = [];
    const client = {
      readContract: async (req: { args: readonly unknown[] }) => {
        seen = req.args;
        return { errorCode: 0, matchAmount: 1n, matchRateBps: 500n, reqCollateral: 2n, lenderRemainingPostMatch: 0n };
      },
    } as never;
    const matcher = '0x00000000000000000000000000000000000000aa' as const;
    const r = await readMatchPreviewLive(client, '0x00000000000000000000000000000000000000d1', { lenderOfferId: 7, borrowerOfferId: 9 }, matcher);
    expect(r?.errorCode).toBe(0);
    expect(seen).toEqual([7n, 9n, matcher]);
  });
});
