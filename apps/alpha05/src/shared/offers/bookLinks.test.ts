import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { OFFER_TYPE_LENDER } from '../positions/model';
import { listedInBook, readBookLinks } from './bookLinks';

const DIAMOND = '0x7777777777777777777777777777777777777777' as const;
const BORROWER_TYPE = OFFER_TYPE_LENDER === 0 ? 1 : 0;

/** A client answering each read from `answers[fn][id]`; a missing answer throws. */
function client(answers: Record<string, Record<string, bigint>>) {
  const asked: string[] = [];
  const c = {
    readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
      asked.push(`${functionName}:${args[0]}`);
      const v = answers[functionName]?.[args[0].toString()];
      if (v === undefined) throw new Error('no answer');
      return v;
    },
  };
  return { c: c as unknown as PublicClient, asked };
}

describe('readBookLinks', () => {
  it('reads both records separately and hides an offer either one names', async () => {
    const { c, asked } = client({
      getOfferLinkedLoanId: { '1': 7n, '2': 0n, '3': 0n, '4': 0n },
      getTakeoverOfferLoan: { '2': 9n, '3': 0n },
    });
    const out = await readBookLinks(c, DIAMOND, [
      { id: 1n, offerType: BORROWER_TYPE },
      { id: 2n, offerType: BORROWER_TYPE },
      { id: 3n, offerType: BORROWER_TYPE },
      { id: 4n, offerType: OFFER_TYPE_LENDER },
    ]);
    expect(Object.fromEntries(out)).toEqual({ '1': 'linked', '2': 'takeover', '3': 'open', '4': 'open' });
    // A lender offer is never a takeover request, so its record is not read.
    expect(asked).not.toContain('getTakeoverOfferLoan:4');
  });

  it('keeps an offer whose records could not be read, stated as unread', async () => {
    const { c } = client({ getOfferLinkedLoanId: { '5': 0n } });
    const out = await readBookLinks(c, DIAMOND, [
      { id: 5n, offerType: BORROWER_TYPE },
      { id: 6n, offerType: OFFER_TYPE_LENDER },
    ]);
    expect(Object.fromEntries(out)).toEqual({ '5': 'unread', '6': 'unread' });
  });

  it('hides only on a record that says so', () => {
    expect([undefined, 'open', 'unread', 'linked', 'takeover'].map((l) => listedInBook(l as never))).toEqual([true, true, true, false, false]);
  });
});
