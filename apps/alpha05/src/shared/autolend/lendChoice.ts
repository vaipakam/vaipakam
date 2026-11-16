/**
 * #3624 — what the Lend page needs before it offers the choice between a
 * one-time offer and Auto-lend: whether Auto-lend can run on this network
 * now (the protocol's gates, the same reading the borrow side's standing
 * lenders use) and whether the wallet already has one on the pair (one pair
 * carries one Auto-lend; setting it again would replace its terms).
 */
import type { PublicClient } from 'viem';
import { readIntentGates } from '../offers/intents';
import { fillPosture, readIntent, type FillPosture } from './autoLend';

type Hex = `0x${string}`;

export interface LendChoiceFacts {
  posture: FillPosture;
  /** The wallet has an active Auto-lend on this pair. */
  has: boolean;
}

export async function readLendChoice(c: PublicClient, diamond: Hex, account: Hex, lending: Hex, collateral: Hex): Promise<LendChoiceFacts> {
  const blockNumber = await c.getBlockNumber();
  const [gates, intent] = await Promise.all([readIntentGates(c, diamond, blockNumber), readIntent(c, diamond, account, lending, collateral, blockNumber)]);
  return { posture: fillPosture(gates), has: intent.active };
}

/** Whether the Auto-lend option may be chosen, and why not. A posture that
 *  could not be read leaves it open: the review reads the gates again and
 *  refuses there with the reason. */
export function autoLendOption(facts: LendChoiceFacts | null): 'open' | 'has' | 'halted' | 'off' {
  if (facts === null) return 'open';
  if (facts.has) return 'has';
  if (facts.posture === 'halted' || facts.posture === 'off') return facts.posture;
  return 'open';
}
