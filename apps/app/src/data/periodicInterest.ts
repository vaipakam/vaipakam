/**
 * A periodic-interest loan's current period, read as ONE aggregate and
 * turned into what the loan page can say about it (#2524).
 *
 * Pure: no wagmi, no query, no chain, so the plan, the mapper and the view
 * are tested without any of them. `usePeriodicInterest.ts` runs the plan.
 *
 * ## What the contract already decides, and this module does not
 *
 * `previewPeriodicSettle(loanId)` is the contract's own preview of
 * `settlePeriodicInterest`, built from the same helpers the settlement
 * runs: the period's deadline, the end of its grace, the interest the
 * period expects, what has been paid toward it, the shortfall, and whether
 * a settlement would clear the "not due yet" guard now. Every one of those
 * is taken as given. Nothing here re-derives a deadline, a grace length or
 * an amount, so the card cannot disagree with the call it describes.
 *
 * Two facts the preview does not carry are read beside it, because each
 * decides whether a due period can actually be settled: the deployment's
 * periodic-interest switch (`getPeriodicInterestEnabled`, off ⇒ the
 * settlement reverts) and the protocol pause (`paused`, the settlement is
 * `whenNotPaused`). Either one unread is stated as unread, never assumed,
 * and both are stated in every phase: the warning that a short period may
 * be settled by a sale holds only while settlement runs.
 *
 * ## Why the block and its time come from inside the aggregate
 *
 * The card says which phase the period is in — before its deadline, in
 * grace, or due — and that is a comparison against CHAIN time. The
 * device clock may be minutes off, and a period that reads "in grace" on
 * the device while the chain already lets anyone sell collateral is the
 * one error this card must not make. `Multicall3.getCurrentBlockTimestamp`
 * in the same aggregate is the time of the very execution that produced
 * the preview, and `getBlockNumber` names it, the way the forced-close
 * card dates its readiness (#2098).
 */
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { MULTICALL3_BLOCK_NUMBER_ABI, type MulticallSlot } from './forcedCloseReads';

/** `Multicall3.getCurrentBlockTimestamp()`, on the deployed contract. */
export const MULTICALL3_TIMESTAMP_ABI = [
  {
    type: 'function',
    name: 'getCurrentBlockTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'timestamp', type: 'uint256' }],
  },
] as const;

export type PeriodicReadKey = 'block' | 'time' | 'preview' | 'enabled' | 'paused';

/** One call in the aggregate, keyed so the mapper reads slots back by key. */
export interface PeriodicReadEntry {
  key: PeriodicReadKey;
  contract: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  };
}

export function periodicReadPlan(input: {
  diamond: `0x${string}`;
  multicall3: `0x${string}`;
  loanId: bigint;
}): PeriodicReadEntry[] {
  const d = { address: input.diamond, abi: DIAMOND_ABI_VIEM } as const;
  const m = input.multicall3;
  return [
    {
      key: 'block',
      contract: { address: m, abi: MULTICALL3_BLOCK_NUMBER_ABI, functionName: 'getBlockNumber' },
    },
    {
      key: 'time',
      contract: {
        address: m,
        abi: MULTICALL3_TIMESTAMP_ABI,
        functionName: 'getCurrentBlockTimestamp',
      },
    },
    { key: 'preview', contract: { ...d, functionName: 'previewPeriodicSettle', args: [input.loanId] } },
    { key: 'enabled', contract: { ...d, functionName: 'getPeriodicInterestEnabled' } },
    { key: 'paused', contract: { ...d, functionName: 'paused' } },
  ];
}

/** The contract's preview of the current period, unchanged. */
export interface PeriodicPreview {
  /** `LibVaipakam.PeriodicInterestCadence` (0 = none). */
  cadence: number;
  /** The period's payment deadline (unix seconds). */
  periodEndAt: number;
  /** The end of the period's grace: from here a settlement may run. */
  graceEndsAt: number;
  /** Interest the full period expects at the loan's CURRENT principal. */
  expected: bigint;
  /** Interest paid toward this period so far. */
  paid: bigint;
  /** What is still owed for the period (never negative). */
  shortfall: bigint;
  /** A settlement would clear the contract's "not due" guard now. */
  canSettleNow: boolean;
}

export interface PeriodicFacts {
  /** `block.number` of the execution that produced every other field. */
  block: bigint;
  /** `block.timestamp` of the same execution. */
  chainTime: number;
  preview: PeriodicPreview;
  /** The deployment's periodic-interest switch; `undefined` = unread. */
  enabled: boolean | undefined;
  /** The protocol pause; `undefined` = unread. */
  paused: boolean | undefined;
}

/**
 * The aggregate read back. `undefined` when the block, its time or the
 * preview itself did not answer: a phase the app cannot date, or a period
 * it cannot describe, is not stated. A slot count that does not match the
 * plan is a programming error and is thrown.
 */
export function periodicFacts(
  plan: readonly PeriodicReadEntry[],
  slots: readonly MulticallSlot[],
): PeriodicFacts | undefined {
  if (slots.length !== plan.length) {
    throw new Error(
      `periodic-interest aggregate returned ${slots.length} slot(s) for a plan of ${plan.length}`,
    );
  }
  const ok = new Map<PeriodicReadKey, unknown>();
  plan.forEach((entry, i) => {
    if (slots[i].status === 'success') ok.set(entry.key, slots[i].result);
  });
  const block = ok.get('block');
  const time = ok.get('time');
  const raw = ok.get('preview');
  if (typeof block !== 'bigint' || typeof time !== 'bigint') return undefined;
  const preview = previewOf(raw);
  if (preview === undefined) return undefined;
  const flag = (key: PeriodicReadKey): boolean | undefined => {
    const v = ok.get(key);
    return typeof v === 'boolean' ? v : undefined;
  };
  return {
    block,
    chainTime: Number(time),
    preview,
    enabled: flag('enabled'),
    paused: flag('paused'),
  };
}

/** `previewPeriodicSettle`'s seven outputs, or `undefined` for any other
 *  shape — a tuple from a different ABI is not evidence of anything. */
function previewOf(raw: unknown): PeriodicPreview | undefined {
  if (!Array.isArray(raw) || raw.length !== 7) return undefined;
  const [cadence, periodEndAt, graceEndsAt, expected, paid, shortfall, canSettleNow] = raw;
  const isBig = (v: unknown): v is bigint => typeof v === 'bigint';
  const cad = typeof cadence === 'number' ? cadence : isBig(cadence) ? Number(cadence) : undefined;
  if (
    cad === undefined ||
    !isBig(periodEndAt) ||
    !isBig(graceEndsAt) ||
    !isBig(expected) ||
    !isBig(paid) ||
    !isBig(shortfall) ||
    typeof canSettleNow !== 'boolean'
  ) {
    return undefined;
  }
  return {
    cadence: cad,
    periodEndAt: Number(periodEndAt),
    graceEndsAt: Number(graceEndsAt),
    expected,
    paid,
    shortfall,
    canSettleNow,
  };
}

/**
 * Where the current period stands, at the chain time it was read.
 *
 * - `open`  — before the period's deadline.
 * - `grace` — past the deadline, before the grace ends: still payable, not
 *   yet settleable.
 * - `due`   — the grace is over and the contract would let a settlement
 *   run (`canSettleNow`).
 */
export type PeriodicPhase = 'open' | 'grace' | 'due';

/**
 * What can happen to a DUE period, and who can make it happen.
 *
 * - `record` — the period is fully paid. Settling only records it and
 *   starts the next period; it moves no funds, so this page offers it.
 * - `sale`   — something is still owed. Settling sells enough collateral to
 *   cover it, through a swap route the caller supplies; this page cannot
 *   build that route, so it says who can.
 * - `off` / `paused` / `unknown` — settlement itself is not available
 *   (see `PeriodicSettlement`).
 */
export type PeriodicSettleRoute = 'record' | 'sale' | Exclude<PeriodicSettlement, 'live'>;

/**
 * Whether ANY period of this loan could be settled right now, whatever
 * phase the current one is in (Codex #3030 r1). Stated in every phase, not
 * only once a period is due: the page's warning that a short period may be
 * settled by a collateral sale is true only while settlement runs.
 *
 * - `live`    — the switch is on and the protocol is not paused.
 * - `off`     — the deployment's periodic-interest switch is off, so no
 *   period can be settled at all.
 * - `paused`  — the protocol is paused; settlement waits for the unpause.
 * - `unknown` — the switch or the pause did not answer.
 */
export type PeriodicSettlement = 'live' | 'off' | 'paused' | 'unknown';

export type PeriodicView =
  /** The loan has no interest schedule: nothing to show. */
  | { kind: 'none' }
  /** The preview says the period is past its grace yet not settleable,
   *  which the contract answers only for a loan that is no longer active.
   *  The page's own status will catch up; this card says nothing. */
  | { kind: 'inactive' }
  | {
      kind: 'period';
      cadence: number;
      phase: PeriodicPhase;
      periodEndAt: number;
      graceEndsAt: number;
      expected: bigint;
      paid: bigint;
      shortfall: bigint;
      /** Whether settlement runs at all right now, in every phase. */
      settlement: PeriodicSettlement;
      /** Present only when `phase === 'due'`. */
      route: PeriodicSettleRoute | undefined;
      block: bigint;
      chainTime: number;
    };

export function periodicView(facts: PeriodicFacts): PeriodicView {
  const p = facts.preview;
  if (p.cadence === 0) return { kind: 'none' };
  const phase: PeriodicPhase | undefined = p.canSettleNow
    ? 'due'
    : facts.chainTime < p.periodEndAt
      ? 'open'
      : facts.chainTime < p.graceEndsAt
        ? 'grace'
        : undefined;
  if (phase === undefined) return { kind: 'inactive' };
  const settlement = settlementOf(facts);
  return {
    kind: 'period',
    cadence: p.cadence,
    phase,
    periodEndAt: p.periodEndAt,
    graceEndsAt: p.graceEndsAt,
    expected: p.expected,
    paid: p.paid,
    shortfall: p.shortfall,
    settlement,
    route: phase === 'due' ? settleRoute(settlement, p.shortfall) : undefined,
    block: facts.block,
    chainTime: facts.chainTime,
  };
}

/** Whether settlement runs. The switch is asked first: while it is off
 *  nothing settles, paused or not. */
function settlementOf(facts: PeriodicFacts): PeriodicSettlement {
  if (facts.enabled === false) return 'off';
  if (facts.enabled === undefined || facts.paused === undefined) return 'unknown';
  if (facts.paused) return 'paused';
  return 'live';
}

/** The route for a due period: the settlement's own state while it does
 *  not run, otherwise recording or a sale by what is still owed. */
function settleRoute(settlement: PeriodicSettlement, shortfall: bigint): PeriodicSettleRoute {
  if (settlement !== 'live') return settlement;
  return shortfall === 0n ? 'record' : 'sale';
}
