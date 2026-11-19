/**
 * The price-moving pause on an Auto-lend slot. Every slot starts with it
 * on: a fill from the slot waits while the collateral price has moved fast
 * against the lending asset since the last two hourly price checks, and
 * while the pair lacks those checks or a price. The owner may switch it off
 * for one slot. The protocol answers where a fill stands with one read,
 * `intentCalmStatus`, the same answer the fill itself takes, so the card
 * never guesses why a slot is not lending.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { OfferPriceGuardFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

export const CALM = OfferPriceGuardFacetABI as Abi;

/**
 * Where a fill from the slot stands against the pause now:
 *   off            the owner switched the pause off for this slot;
 *   clear          the price is steady, fills may go ahead;
 *   no-checkpoint  the pair lacks one of the last two hourly price checks;
 *   moving         the price moved fast, fills wait until it steadies;
 *   unpriced       a price for the pair cannot be read now.
 */
export type CalmStatus = 'off' | 'clear' | 'no-checkpoint' | 'moving' | 'unpriced';

/** The protocol's status number (`LibOfferPriceGuard.Status`) as a status.
 *  The offer-only members (NoOffer, Moved) never answer for a slot; they and
 *  any unknown number read as null, so the card states it could not tell. */
export function calmStatusOf(n: number): CalmStatus | null {
  switch (n) {
    case 0:
      return 'off';
    case 2:
      return 'clear';
    case 4:
      return 'no-checkpoint';
    case 5:
      return 'moving';
    case 6:
      return 'unpriced';
    default:
      return null;
  }
}

/** Whether fills from the slot are waiting on the pause now. */
export function calmPaused(s: CalmStatus): boolean {
  return s === 'no-checkpoint' || s === 'moving' || s === 'unpriced';
}

export async function readCalmStatus(c: PublicClient, diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, slot: number, blockNumber?: bigint): Promise<CalmStatus | null> {
  const n = (await c.readContract({
    address: diamond,
    abi: CALM,
    functionName: 'intentCalmStatus',
    args: [owner, lending, collateral, slot],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as number;
  return calmStatusOf(Number(n));
}

/** The one call that switches the pause on or off for one slot. */
export function calmCheckCall(lending: Hex, collateral: Hex, slot: number, on: boolean) {
  return { abi: CALM, functionName: 'setIntentCalmCheck' as const, args: [lending, collateral, slot, on] as const };
}

/** The setting the transaction recorded for this slot, from its own log;
 *  null when it recorded none. */
export function calmLogs(logs: readonly Log[], diamond: Hex, owner: Hex, lending: Hex, collateral: Hex, slot: number): boolean | null {
  const same = (a: unknown, b: Hex) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const mine = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase()) as Log[];
  const events = parseEventLogs({ abi: CALM, logs: mine, strict: false }) as unknown as { eventName: string; args: Record<string, unknown> }[];
  let out: boolean | null = null;
  for (const e of events) {
    const a = e.args;
    if (e.eventName === 'IntentCalmCheckSet' && same(a.owner, owner) && same(a.lendingAsset, lending) && same(a.collateralAsset, collateral) && Number(a.slot) === slot)
      out = a.on === true;
  }
  return out;
}
