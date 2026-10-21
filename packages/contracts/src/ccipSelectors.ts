/**
 * The CCIP chain selector of each EVM chain the deploy scripts configure.
 *
 * A `CcipMessenger` resolves a destination chain id to its selector
 * (`chainSelectorOf`) and a message's source selector back to a chain id
 * (`chainIdOf`). A wrong binding in either map routes a send to another lane,
 * or attributes an inbound message to another chain, while every peer and
 * channel check still passes (GovernanceRunbook, "both selector mappings, in
 * both directions"). So a reader that must know a lane is wired checks both
 * maps against these values.
 *
 * The deploy scripts' copy is `Deployments.ccipSelectorForChainId`
 * (`contracts/script/lib/Deployments.sol`), which configures every lane;
 * `scripts/ccip-selectors.test.mjs` pins this file to it, entry for entry.
 */

import table from './ccipSelectors.json';

const SELECTORS: ReadonlyMap<number, bigint> = new Map(
  Object.entries(table.selectors).map(([chainId, e]) => [Number(chainId), BigInt(e.selector)]),
);

/** The CCIP chain selector of `chainId`, or undefined when no deploy script
 *  configures that chain. */
export function ccipSelectorOf(chainId: number): bigint | undefined {
  return SELECTORS.get(chainId);
}
