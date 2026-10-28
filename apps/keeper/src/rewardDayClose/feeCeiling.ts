// apps/keeper/src/rewardDayClose/feeCeiling.ts
//
// #2627 — the day-close pass's fee ceiling: the shared rule (`../feeCeiling`)
// read from its own variable, `REWARD_DAY_CLOSE_MAX_FEE_WEI`. Every paid send
// of this pass (a mirror's `closeDay`, Base's `broadcastGlobal` and
// `broadcastGlobalTo`) carries the fee its messenger quoted in the same run,
// and none pays above this.

import { feeCeiling as sharedFeeCeiling } from '../feeCeiling';
import type { SendFeeCeiling } from '../stepSender';

export { DEFAULT_MAX_FEE_WEI } from '../feeCeiling';
export const MAX_FEE_VAR = 'REWARD_DAY_CLOSE_MAX_FEE_WEI';

/** The ceiling for one chain and where it came from, or why it is unknown. */
export type FeeCeiling = SendFeeCeiling;

/** The fee ceiling `raw` (the variable's value) sets for `chainId`. */
export function feeCeiling(raw: string | undefined, chainId: number): FeeCeiling {
  return sharedFeeCeiling(raw, chainId, MAX_FEE_VAR);
}
