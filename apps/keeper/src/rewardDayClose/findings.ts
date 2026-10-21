// apps/keeper/src/rewardDayClose/findings.ts
//
// What one run established about its chain, as facts: the single input to
// the run's alerts and to its rule for when a day is worked through. Each
// step produces its part; nothing here is computed from anything but reads
// and the run's own calls.

import type { Address } from 'viem';
import type { ClockFacts } from './clock';
import type { Fact, PerDay } from './fact';
import type { BroadcastPlan, Topology } from './plan';
import type { DispatchRecord } from './store';

/** Base, near the end of grace, on a day an expected chain is still missing. */
export interface Wait {
  missing: number[];
  unknown: number[];
  graceEndsAt: number | null;
  /** When each missing chain sent its report, read on that chain. */
  sent: Map<number, Fact<number>>;
}

/** What Base's run established. */
export interface BaseFindings {
  expected: Fact<number[]>;
  destinations: Fact<number[]>;
  /** Null unless both lists were read. */
  topology: Topology | null;
  /** Why this run finalizes no day (null = none). */
  finalizeHold: string | null;
  /** Why this run broadcasts no finalized day (null = none). */
  broadcastHold: string | null;
  /** Open days this run judged for finalization (readiness, grace and
   *  reports all read). */
  judged: Set<number>;
  /** Of `judged`, the days near the end of grace with a chain missing. */
  waiting: Map<number, Wait>;
  /** Window days finalized, as read or by this run. */
  finalized: Set<number>;
  /** Finalized days whose broadcast this run judged, with its plan. */
  broadcast: Map<number, BroadcastPlan>;
  /** Window days whose zeroed-chain notice exists and is delivered. */
  noticed: Set<number>;
}

/** What a mirror's run established. */
export interface MirrorFindings {
  baseChainId: number;
  /** This keeper serves Base. */
  baseServed: boolean;
  /** Base's expected-source list leaves this chain out. */
  notExpectedOnBase: Fact<boolean> | 'unserved';
  /** The messenger this run checked, and the faults on the report channel
   *  from it to Base (empty = every link reads as wired; wire.ts). */
  messenger: Address;
  wire: Fact<string[]>;
  /** Why this run closes no day (null = none). */
  closeHold: string | null;
  /** Per window day: Base's outcome for this chain is final and learned (the
   *  day is finalized, a counted report being able to be left out before
   *  then, and whether Base holds this chain's report is read). */
  outcome: PerDay<boolean>;
  /** Per window day: Base finalized it without this chain's report (known
   *  false before finalization; unknown for a finalized day whose report
   *  landed, since Base does not expose whether it was counted in). */
  excluded: PerDay<boolean>;
  /** Window days closed here whose report left through a messenger other than
   *  the one checked. */
  dispatched: Map<number, DispatchRecord>;
}

export interface RunFindings {
  chainId: number;
  canonical: boolean;
  window: readonly number[];
  /** `step:day` → why, for calls refused this run. */
  refused: ReadonlyMap<string, string>;
  /** `step:day` → what could not be read, for steps a failed read kept from
   *  being tried this run. */
  unread: ReadonlyMap<string, string>;
  /** Why the run stopped sending, when that is a fault that can repeat run
   *  after run (null = it did not, or stopped only at its budget or deadline). */
  stall: string | null;
  /** Other chains read as unreadable this run (not attested), with why. */
  unattested: ReadonlyMap<number, string>;
  /** `step:day` work that is done (as read, or landed this run). */
  done: (stepDay: string) => boolean;
  /** Reward-clock alignment (null = not judged this run). */
  clock: ClockFacts | null;
  base: BaseFindings | null;
  mirror: MirrorFindings | null;
}
