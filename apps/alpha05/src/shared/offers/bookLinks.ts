/**
 * Whether an offer the index lists belongs in a book at all, read from the
 * chain (the protocol's own records, never the index's flags alone).
 *
 * Two records keep an offer out of every book, and they are read separately:
 *
 *  - `getOfferLinkedLoanId`: the offer is a vehicle bound to a loan (a loan
 *    sale or an early-close offset), taken only through its own route.
 *  - `getTakeoverOfferLoan`: the request was posted to take over a named
 *    loan's obligation (#3844); only that loan's handover consumes it, so
 *    nobody can accept or match it. Only a borrower request can be one.
 *
 * Either one non-zero hides the offer. An offer whose records could not be
 * read stays listed and is counted as unread: its own page reads it again
 * from the chain before anything is offered, so listing it hides nothing.
 */
import type { Abi, PublicClient } from 'viem';
import { OfferCancelFacetABI, OfferCreateFacetABI } from '@vaipakam/contracts/abis';
import { OFFER_TYPE_LENDER } from '../positions/model';
import { useChainRead } from '../reads/chainRead';
import type { SupportedChain } from '../../chain/chains';

type Hex = `0x${string}`;

const CANCEL = OfferCancelFacetABI as Abi;
const CREATE = OfferCreateFacetABI as Abi;

/** `linked` and `takeover` hide the offer; `open` lists it; `unread` lists
 *  it with the read stated as missing. */
export type BookLink = 'open' | 'linked' | 'takeover' | 'unread';

export interface BookLinkSubject {
  id: bigint;
  offerType: number;
}

async function nonZero(p: Promise<unknown>): Promise<boolean | null> {
  try {
    return (await p) !== 0n;
  } catch {
    return null;
  }
}

/** Each offer's book standing, keyed by its id as a decimal string. */
export async function readBookLinks(c: PublicClient, diamond: Hex, offers: readonly BookLinkSubject[]): Promise<Map<string, BookLink>> {
  const out = new Map<string, BookLink>();
  await Promise.all(
    offers.map(async (o) => {
      const [linked, takeover] = await Promise.all([
        nonZero(c.readContract({ address: diamond, abi: CANCEL, functionName: 'getOfferLinkedLoanId', args: [o.id] })),
        o.offerType === OFFER_TYPE_LENDER
          ? Promise.resolve(false)
          : nonZero(c.readContract({ address: diamond, abi: CREATE, functionName: 'getTakeoverOfferLoan', args: [o.id] })),
      ]);
      out.set(o.id.toString(), linked === true ? 'linked' : takeover === true ? 'takeover' : linked === null || takeover === null ? 'unread' : 'open');
    }),
  );
  return out;
}

/** Whether a book shows the offer: hidden only on a record that says so. */
export function listedInBook(link: BookLink | undefined): boolean {
  return link !== 'linked' && link !== 'takeover';
}

/** The book standing of every offer in `offers`, read on `chain`. While
 *  the read is out its data is undefined and every offer reads as listed:
 *  the index already leaves these offers out, and an offer's own page reads
 *  its records again before anything is offered. */
export function useBookLinks(chain: SupportedChain, offers: readonly BookLinkSubject[]) {
  const ids = [...new Set(offers.map((o) => `${o.id}:${o.offerType === OFFER_TYPE_LENDER ? 'l' : 'b'}`))].sort();
  return useChainRead(['bookLinks', chain.diamondAddress, ...ids], (c) => readBookLinks(c, chain.diamondAddress as Hex, offers), {
    chain,
    enabled: ids.length > 0,
  });
}
