/** Types for `rewardOwnerNotifications.mjs`, imported by the indexer and the app's e2e indexer stub. */

export type RewardOwnerNotifKind = 'reward_final_notice' | 'reward_expired';

export declare const REWARD_OWNER_NOTIF_MAP: Readonly<{
  RewardEntryExpiryArmed: 'reward_final_notice';
  RewardEntryExpiryBegun: 'reward_expired';
}>;

/** The minimal source-log shape the planner reads. */
export interface RewardOwnerSourceLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
}

/** One owner-addressed inbox row (the indexer's `notifications` table shape). */
export interface RewardOwnerNotifRow {
  chainId: number;
  recipient: string;
  kind: RewardOwnerNotifKind;
  loanId: null;
  eventKind: string;
  blockNumber: number;
  logIndex: number;
  createdAt: number;
  dedupKey: string;
  dataJson: string;
}

export declare function planOwnerNotifications(
  chainId: number,
  logs: readonly RewardOwnerSourceLog[],
  blockTimestamps: ReadonlyMap<bigint, number>,
  nowSec: number,
): RewardOwnerNotifRow[];
