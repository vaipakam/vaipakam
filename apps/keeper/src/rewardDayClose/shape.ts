// apps/keeper/src/rewardDayClose/shape.ts
//
// Whether a reward messenger carries the day report (#2621), read from its own
// code. A mirror's report must be one Base's reward messenger takes: Base
// refuses a report of another size on delivery, after the fee is paid here and
// the day is stamped sent for good (wire.ts holds the close on that link).
// Every served chain runs the one report shape since the all-waves fresh
// deploy, which retired the B4 report of the pre-#2790 deploys (#2866); a
// messenger without its quote predates it and can send no report Base takes.
//
// The shape is read from the messenger's dispatcher: a contract answers a
// selector only if its code holds it as a dispatch constant, so its code
// says which quote, and so which report, it has. A call to find out would
// confuse a function that reverts unnamed with one that is absent, and a
// selector found nowhere in the code is absent. The reward messenger is a
// UUPS proxy, so the code read is its implementation's, at the EIP-1967 slot,
// read this run (an upgrade in place changes it).

import { getAddress, toFunctionSelector, type AbiFunction, type Address, type Hex, type PublicClient } from 'viem';
import { PastRunDeadline } from '../batchRead';
import { MESSENGER_ABI } from './constants';
import { shortErr } from './errors';
import { known, unknown, type Fact } from './fact';

const REPORT_QUOTE: Hex = (() => {
  const f = MESSENGER_ABI.find((x): x is AbiFunction => x.type === 'function' && x.name === 'quoteSendChainReport');
  if (f === undefined) throw new Error('no quoteSendChainReport in the ABI');
  return toFunctionSelector(f);
})();

/** EIP-1967's implementation slot: `keccak256('eip1967.proxy.implementation') - 1`. */
const IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Whether `code` holds `selector` as a dispatch constant: a PUSH of its
 *  bytes, leading zero bytes dropped as the compiler drops them. */
export function hostsSelector(code: Hex, selector: Hex): boolean {
  let s = selector.slice(2).toLowerCase();
  while (s.startsWith('00') && s.length > 2) s = s.slice(2);
  const push = (0x5f + s.length / 2).toString(16);
  return code.toLowerCase().includes(push + s);
}

/** Whether the messenger at `address` carries the day report (its
 *  implementation's code, when it is a proxy): false when there is no code
 *  there, or no day-report quote in it. */
export async function carriesDayReport(client: PublicClient, address: Address, label: string): Promise<Fact<boolean>> {
  let code: Hex | undefined;
  try {
    const slot = await client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT });
    const impl = slot === undefined || BigInt(slot) === 0n ? address : getAddress(`0x${slot.slice(-40)}`);
    code = await client.getCode({ address: impl });
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    console.error(`[keeper] rewardDayClose ${label} unread: ${shortErr(err)}`);
    return unknown(shortErr(err));
  }
  return known(code !== undefined && code !== '0x' && hostsSelector(code, REPORT_QUOTE));
}
