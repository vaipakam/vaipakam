/**
 * #3443 offer-age rule for the e2e tier. An offer can be filled only once
 * its terms have stood the Diamond's minimum age (`getMinTermsAgeSec`, 5 s
 * by default).
 *
 * On a live chain a taker simply arrives later, because blocks keep coming.
 * The suite's Anvil is IDLE between transactions, so its latest block
 * keeps the posting block's timestamp, and every simulation the app or a
 * helper runs (`eth_call` / `eth_estimateGas` read that block) sees the
 * terms as fresh for as long as nothing else is mined. A spec that posts
 * and then fills therefore advances the chain by exactly the shortfall
 * first, and never otherwise.
 *
 * Kept in its own module so both `flows.ts` (the UI accept paths) and
 * `desk.ts` (direct writes) can use it: `desk.ts` already imports
 * `flows.ts`, so the helper cannot live in either without a cycle.
 */
import { DIAMOND, DIAMOND_ABI_VIEM, pub } from './chain';
import { increaseTime } from './anvil';

/** Advance the chain until every listed offer's terms are old enough to
 *  fill. A Diamond without the rule, or terms that carry no age
 *  (`termsSetAt == 0`, a signed offer turned on-chain at its fill), need
 *  no wait. */
export async function waitOutTermsAge(...offerIds: bigint[]): Promise<void> {
  let minAge = 0n;
  try {
    minAge = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getMinTermsAgeSec',
    })) as bigint;
  } catch {
    return; // a Diamond without the rule needs no wait
  }
  let readyAt = 0n;
  for (const id of offerIds) {
    const { termsSetAt } = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOffer',
      args: [id],
    })) as { termsSetAt?: bigint | number };
    if (termsSetAt && BigInt(termsSetAt) + minAge > readyAt) readyAt = BigInt(termsSetAt) + minAge;
  }
  // The fill lands in a later block, but the app SIMULATES it against the
  // latest one first, so the latest block itself must reach readyAt.
  // `increaseTime` mines a block; Anvil stamps it from its clock offset,
  // which can trail a block already bumped ahead, so re-read and repeat
  // until the latest block is there.
  for (let i = 0; i < 5; i++) {
    const { timestamp: now } = await pub.getBlock({ blockTag: 'latest' });
    if (readyAt <= now) return;
    await increaseTime(Number(readyAt - now));
  }
  throw new Error(`waitOutTermsAge: chain did not reach terms-ready time ${readyAt}`);
}
