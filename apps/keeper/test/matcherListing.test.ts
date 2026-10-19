/**
 * The matcher reads its offer book page by page, hydrating each page before
 * listing the next (#2572 r9), so a run the read cutoff stops during listing
 * still has offers to match.
 */
import { describe, expect, it } from 'vitest';
import { listActiveOffers } from '../src/matcher';

/** A `getOffer` result whose every field is 0 except its id. */
const rawOffer = (id: bigint) =>
  new Proxy({} as Record<string, unknown>, { get: (_t, k) => (k === 'id' ? id : 0) });

describe('listActiveOffers', () => {
  it('hydrates the pages it listed before the read cutoff stopped it', async () => {
    let pagesRead = 0;
    const client = {
      readContract: async (req: { functionName: string; args?: readonly bigint[] }) => {
        if (req.functionName === 'getActiveOffersCount') return 400n;
        if (req.functionName === 'getActiveOffersPaginated') {
          pagesRead += 1;
          const [offset, limit] = req.args as readonly [bigint, bigint];
          return Array.from({ length: Number(limit) }, (_, i) => offset + BigInt(i) + 1n);
        }
        throw new Error(`unexpected read ${req.functionName}`);
      },
      multicall: async (req: { contracts: { args: readonly [bigint] }[] }) =>
        req.contracts.map((c) => ({ status: 'success', result: rawOffer(c.args[0]) })),
    };
    const ctx = { client, diamond: '0x0000000000000000000000000000000000000001', chainId: 84532 };
    // The cutoff passes as soon as the first page is listed.
    const { offers, listed } = await listActiveOffers(ctx as never, 0, () => pagesRead >= 1);
    expect(pagesRead).toBe(1);
    expect(listed).toBe(200);
    // The listed page is hydrated whole, so the run has its 200 offers to match.
    expect(offers.map((o) => o.id)).toEqual(Array.from({ length: 200 }, (_, i) => BigInt(i + 1)));
  });
});
