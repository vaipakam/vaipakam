// apps/keeper/src/rewardDayClose/sender.ts
//
// The day-close pass's sender: the keeper's shared simulate-then-send
// ({@link StepSender}, `../stepSender.ts`) under this pass's ABI and budget
// ({@link MAX_SENDS_PER_RUN} per chain), with the refusals that are races
// here, the paused refusal, and the frontier wait the close step reports in
// its own words. Its fee ceiling (#2627) is the deps' `feeCeiling`.

import { StepSender } from '../stepSender';
import { ABI, FRONTIER_SHORT, MAX_SENDS_PER_RUN, PAUSED_REFUSAL, RACES, RECEIPT_TIMEOUT_MS } from './constants';
import type { DayCloseDeps } from './deps';

export type { CallResult } from '../stepSender';

export class Sender extends StepSender {
  constructor(deps: DayCloseDeps) {
    super(
      {
        pass: 'rewardDayClose',
        abi: ABI,
        maxSends: MAX_SENDS_PER_RUN,
        receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
        races: RACES,
        pausedRefusal: PAUSED_REFUSAL,
        unrecorded: new Set([FRONTIER_SHORT]),
        describe: (day) => `day ${day}`,
        spends: 'the gas and CCIP fee',
      },
      deps,
    );
  }
}
