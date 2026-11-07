/**
 * #3242 — the offer book's two bounds, as the protocol states them, for the
 * post form to say before anything is signed:
 * - the value floor: an offer's `amount` (a lending offer's smallest part,
 *   a request's smallest amount) must be worth at least the floor when its
 *   token is liquid and priced now. `getMinOfferAmount` answers in the
 *   token's own units; a token the floor does not bind admits any amount.
 * - the open-offer cap: one wallet may have at most `cap` offers open; an
 *   expired offer counts until it is cancelled (`getOfferBookBounds`).
 * The protocol enforces both at posting; these reads only let the form name
 * a refusal before it happens, and a failed read leaves that to the protocol.
 */
import type { Abi, PublicClient } from 'viem';
import { OfferBookFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const BOOK = OfferBookFacetABI as Abi;

/** The smallest `amount` of `lendingAsset` the floor admits, in base units,
 *  or null when the floor does not bind this token now. */
export async function readMinOfferAmount(client: PublicClient, diamond: Hex, lendingAsset: Hex): Promise<bigint | null> {
  const [binds, amount] = (await client.readContract({ address: diamond, abi: BOOK, functionName: 'getMinOfferAmount', args: [lendingAsset] })) as readonly [boolean, bigint];
  return binds ? amount : null;
}

export interface OpenOffers {
  open: bigint;
  cap: bigint;
}

/** How many offers `wallet` has open, and the most one wallet may have. */
export async function readOpenOffers(client: PublicClient, diamond: Hex, wallet: Hex): Promise<OpenOffers> {
  const [, cap, open] = (await client.readContract({ address: diamond, abi: BOOK, functionName: 'getOfferBookBounds', args: [wallet] })) as readonly [bigint, bigint, bigint];
  return { open, cap };
}

/** Within this many offers of the cap, the form names the count. */
export const NEAR_CAP_MARGIN = 5n;

/** `full` blocks the post (the protocol would refuse it), `near` names the
 *  count, `room` says nothing. Unknown is `room`: the protocol's own
 *  refusal is the backstop. */
export function capStanding(o: OpenOffers | null): 'room' | 'near' | 'full' {
  if (o === null || o.cap === 0n) return 'room';
  if (o.open >= o.cap) return 'full';
  return o.cap - o.open <= NEAR_CAP_MARGIN ? 'near' : 'room';
}

/** Whether `amount` is below the floor's smallest admitted amount; false
 *  when the floor does not bind or is not known. */
export function belowFloor(amount: bigint | null, floor: bigint | null): boolean {
  return amount !== null && floor !== null && amount > 0n && amount < floor;
}
