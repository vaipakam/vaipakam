/**
 * apps/keeper — the internal-match liquidation of an under-water loan no
 * venue quotes (#2501).
 *
 * `RiskFacet.triggerLiquidation` asks the internal-match auto-dispatch
 * BEFORE it reads the swap list: when an opposing position matches the
 * loan, the match settles at oracle price, pays the matcher incentive to
 * the caller and returns, so the list is never used. An empty list is
 * therefore enough for that ending. Without a match it is not: the swap
 * branch reverts `NoEnabledSwapRoute`, or the priority window refuses the
 * external path.
 *
 * So when no venue quotes, the liquidator previews
 * `triggerLiquidation(loanId, [])` and sends it only when the preview
 * affirmatively shows the match: the call succeeds and the Diamond emits
 * `InternalMatchExecuted` with this loan as its first leg, which is how the
 * auto-dispatch reports it. A preview the node cannot run, a revert, or a
 * success without that event sends nothing. The match kill-switch
 * (`internalMatchEnabled`) defaults off, and while it is off the preview
 * reverts and this costs one simulation per no-quote loan.
 *
 * The send takes the same hold and submission slot as the close-out
 * (`keeperSend.ts`): an earlier keeper send still unmined holds it, and a
 * broadcast whose answer was lost is reported as unconfirmed, by hash.
 */

import { encodeFunctionData, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { RiskFacetABI } from '@vaipakam/contracts/abis';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { INTERNAL_MATCH_EXECUTED_TOPIC } from '@vaipakam/lib/routeBuilder';
import type { ChainConfig } from './env';
import type { KeeperContext } from './keeper';
import { keeperTxPending, sendInSubmissionSlot } from './keeperSend';

const RISK_ABI: Abi = RiskFacetABI as Abi;

/** What the chain says `triggerLiquidation(loanId, [])` would do now. */
export type MatchPreview =
  /** It succeeds, and the Diamond reports a match with this loan as leg A. */
  | 'match'
  /** It succeeds without that report: not an ending this pass may send. */
  | 'no-match'
  /** It reverts, the node cannot simulate, or it reports no logs. */
  | 'unknown';

/** The empty-list `triggerLiquidation` this pass sends, encoded once. */
function emptyListLiquidation(loanId: bigint): Hex {
  return encodeFunctionData({ abi: RISK_ABI, functionName: 'triggerLiquidation', args: [loanId, []] });
}

/** Simulate the empty-list liquidation at `blockNumber` and read its logs. */
export async function previewMatchLiquidation(deps: {
  client: Pick<PublicClient, 'simulateCalls'>;
  diamond: Address;
  account: Address;
  loanId: bigint;
  blockNumber: bigint;
}): Promise<MatchPreview> {
  const { client, diamond, account, loanId, blockNumber } = deps;
  let results;
  try {
    ({ results } = await client.simulateCalls({
      account,
      calls: [{ to: diamond, data: emptyListLiquidation(loanId) }],
      blockNumber,
    }));
  } catch {
    return 'unknown';
  }
  const result = results[0];
  if (!result || result.status !== 'success') return 'unknown';
  // A node that ran the call without reporting events has not shown the
  // match, which is not the same as having shown there was none.
  if (result.logs === undefined) return 'unknown';
  const loanTopic = `0x${loanId.toString(16).padStart(64, '0')}`;
  const matched = result.logs.some(
    (log) =>
      log.address.toLowerCase() === diamond.toLowerCase() &&
      log.topics[0] === INTERNAL_MATCH_EXECUTED_TOPIC &&
      log.topics[1]?.toLowerCase() === loanTopic,
  );
  return matched ? 'match' : 'no-match';
}

/** What one attempt came to — the log line, and what tests assert. */
export type MatchLiquidationOutcome =
  | { kind: 'submitted'; tx: Hex }
  | { kind: 'unconfirmed'; tx: Hex; reason: string }
  | { kind: 'skipped'; reason: string };

/** Preview, hold, send. Never sends when a step cannot establish its answer. */
export async function attemptMatchLiquidation(
  deps: Pick<KeeperContext, 'wallet' | 'diamond' | 'chainId'> & {
    client: Pick<PublicClient, 'simulateCalls' | 'getBlockNumber' | 'getTransactionCount'>;
  },
  loanId: bigint,
): Promise<MatchLiquidationOutcome> {
  const { client, wallet, diamond } = deps;
  const keeper = wallet.account?.address;
  if (!keeper) return { kind: 'skipped', reason: 'no-keeper-account' };

  // The preview first: while the kill-switch is off, or no opposing
  // position exists, it is the only read this costs.
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const preview = await previewMatchLiquidation({ client, diamond, account: keeper, loanId, blockNumber });
  if (preview !== 'match') return { kind: 'skipped', reason: `preview=${preview}` };

  const pending = await keeperTxPending(client, keeper);
  if (pending !== null) return { kind: 'skipped', reason: pending };

  return sendInSubmissionSlot(wallet, deps.chainId, diamond, emptyListLiquidation(loanId));
}

/**
 * The liquidator's first no-quote step (#2501). Returns true when a
 * transaction was submitted or may have been broadcast; every other
 * outcome is logged with its reason.
 */
export async function tryMatchLiquidation(
  chain: Pick<ChainConfig, 'id' | 'name'>,
  ctx: KeeperContext,
  publicClient: PublicClient,
  loanIdBig: bigint,
): Promise<boolean> {
  const outcome = await attemptMatchLiquidation(
    { client: publicClient, wallet: ctx.wallet, diamond: ctx.diamond, chainId: chain.id },
    loanIdBig,
  ).catch((err: unknown) => ({ kind: 'skipped' as const, reason: `error:${describeFailure(err)}` }));
  if (outcome.kind === 'skipped') {
    console.log(`[keeper] loan=${loanIdBig} chain=${chain.name} internal-match skipped: ${outcome.reason}`);
    return false;
  }
  console.log(
    `[keeper] loan=${loanIdBig} chain=${chain.name} internal-match ${outcome.kind === 'submitted' ? 'submitted' : `send-unconfirmed (${outcome.reason})`} tx=${outcome.tx}`,
  );
  return true;
}
