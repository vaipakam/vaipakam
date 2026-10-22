// apps/keeper/src/rewardDayClose/index.ts
//
// #2612 — the reward day-close pass: the three permissionless calls the
// cross-chain interaction-reward cycle needs every UTC day. A reward day's
// interest reaches the global denominator only when each chain REPORTS it and
// Base FINALIZES it, and a mirror can price its users' claims only once Base
// BROADCASTS the finalized pair back. Before this pass nothing on a live
// chain made any of them.
//
// The modules, each one concern:
//   constants   what is called, and the numbers the pass works by
//   fact        a read's result: known with its value, or unknown with why
//   reads       every chain read, each returning a fact
//   peers       other chains, read only once their Diamond names itself them
//   plan        the pure rules: window, finalization, broadcast, receipts
//   store       everything kept between runs (ledger, records, cursor)
//   clock       reward-clock alignment, the precondition of every close and
//               every finalization
//   sender      simulate-then-send within the run's budget
//   feeCeiling  the most one send pays as its CCIP fee, per chain (#2627)
//   close       step 1: close each day (both roles)
//   mirror      a mirror's reads of Base, and when its closes are safe
//   wire        whether the report channel to Base would accept a report,
//               read link by link on both ends
//   base        Base's finalization
//   broadcast   Base's broadcast of each finalized day
//   findings    what a run established: the one input to its alerts
//   alerts      every ops alert, raised, cleared and held by one judgement
//   notices     the zeroed-day notice
//   run         the run, and when a day is worked through
//
// Gated by KEEPER_ENABLED + REWARD_DAY_CLOSE_ENABLED. Ships disarmed.

export {
  BACKLOG_PER_RUN,
  BROADCAST_LATE_AFTER_SEC,
  BROADCAST_RESEND_AFTER_SEC,
  GRACE_WARNING_SEC,
  LOOKBACK_DAYS,
  MAX_SENDS_PER_RUN,
  PASS_ALERT_WINDOW_MS,
  PASS_CADENCE_SEC,
  READ_CHUNK,
  ROLE_CANONICAL,
  ROLE_MIRROR,
  graceWarningSec,
} from './constants';
export type { DayCloseDeps, PeerReader } from './deps';
export { broadcastsLeft, dayWindow, planBroadcast, planFinalize, reportSentVia } from './plan';
export type { BroadcastPlan, DestinationState, FinalizeDecision, FinalizeInput, SendMark } from './plan';
export { dayCloseOnce, runRewardDayClose } from './run';
