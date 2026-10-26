// apps/keeper/src/rewardDayClose/shape.ts
//
// Which day-report shape a reward messenger carries, read from its own code.
// A mirror's report must be one Base's reward messenger takes: Base refuses a
// report of another size on delivery, after the fee is paid here and the day
// is stamped sent for good (wire.ts holds the close on that link).
//
// Two shapes are in service:
//   - the one report shape (#2621), which every fresh deploy carries and the
//     contracts' source is now limited to;
//   - the B4 report, carried by the messengers and Diamonds deployed before
//     #2790, which the live testnets still run until the all-waves fresh
//     deploy. Such a messenger also takes every older shape, so on those
//     chains the shape that goes out is the Diamond's reporter facet's
//     (`diamondSendsB4`). B4 is the one older shape Base applies after it has
//     finalized a day.
// Everything B4 here, with `B4_QUOTE_ABI` and its selectors in constants.ts,
// is deleted once no served chain runs a pre-#2790 messenger (#2866).
//
// The shape is read from the messenger's dispatcher: a contract answers a
// selector only if its code holds it as a dispatch constant, so its code
// says which quote, and so which report, it has. A call to find out would
// confuse a function that reverts unnamed with one that is absent, and a
// selector found nowhere in the code is absent.

import { toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex, type PublicClient } from 'viem';
import { PastRunDeadline } from '../batchRead';
import { B4_QUOTE_ABI, B4_REPORTER_SELECTOR, CLOSE_DAY_SELECTOR, LOUPE_ABI, MESSENGER_ABI } from './constants';
import type { ChainRun } from './deps';
import { shortErr } from './errors';
import { known, unknown, type Fact } from './fact';
import { readOne } from './reads';

/** The one report shape (#2621), or the B4 report of a pre-#2790 deploy. */
export type ReportShape = 'one' | 'b4';

const quoteOf = (abi: Abi): Hex => {
  const f = abi.find((x): x is AbiFunction => x.type === 'function' && x.name === 'quoteSendChainReport');
  if (f === undefined) throw new Error('no quoteSendChainReport in the ABI');
  return toFunctionSelector(f);
};
const ONE_QUOTE = quoteOf(MESSENGER_ABI);
const B4_QUOTE = quoteOf(B4_QUOTE_ABI as Abi);

/** Whether `code` holds `selector` as a dispatch constant: a PUSH of its
 *  bytes, leading zero bytes dropped as the compiler drops them. */
export function hostsSelector(code: Hex, selector: Hex): boolean {
  let s = selector.slice(2).toLowerCase();
  while (s.startsWith('00') && s.length > 2) s = s.slice(2);
  const push = (0x5f + s.length / 2).toString(16);
  return code.toLowerCase().includes(push + s);
}

/** The report shape the messenger at `address` carries, or null when it
 *  carries neither (no code there, or no day-report quote). */
export async function messengerShape(client: PublicClient, address: Address, label: string): Promise<Fact<ReportShape | null>> {
  let code: Hex | undefined;
  try {
    code = await client.getCode({ address });
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${label} unread: ${shortErr(err)}`);
    return unknown(shortErr(err));
  }
  if (code === undefined || code === '0x') return known(null);
  if (hostsSelector(code, ONE_QUOTE)) return known('one');
  return known(hostsSelector(code, B4_QUOTE) ? 'b4' : null);
}

export const shapeName = (s: ReportShape): string => (s === 'one' ? 'the one report shape (#2621)' : 'the B4 report (deployed before #2790)');

/** Whether this Diamond's `closeDay` sends the B4 report, asked only of a
 *  chain whose messenger carries B4: such a messenger takes every older shape
 *  too, while the shape that goes out is the reporter facet's. Read from the
 *  Diamond's own routing: `closeDay` is hosted by a facet that also hosts
 *  `getInterestFrontiers`, which the reporter gained in the change (#2459)
 *  that gave it the B4 send. */
export async function diamondSendsB4(c: ChainRun): Promise<Fact<boolean>> {
  const host = (sel: Hex, what: string) => readOne<Address>(c.deps.client, c.diamond, LOUPE_ABI, 'facetAddress', [sel], `${c.where}: the facet routed for ${what}`);
  const close = await host(CLOSE_DAY_SELECTOR, 'closeDay');
  if (!close.known) return unknown(`the facet this Diamond routes closeDay to (${close.why})`);
  const frontiers = await host(B4_REPORTER_SELECTOR, 'getInterestFrontiers');
  if (!frontiers.known) return unknown(`the facet this Diamond routes getInterestFrontiers to (${frontiers.why})`);
  return known(BigInt(close.value) !== 0n && close.value.toLowerCase() === frontiers.value.toLowerCase());
}
