/**
 * #3681 — the standing-instructions pass: the collateral top-up, the due
 * repayment and the interest payment, run against a fake Diamond that applies
 * the contract's own admission rules and skip rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ABI,
  FLOOR_ITEM,
  HOLDS_ITEM,
  SKIP_HOLD_SEC,
  STEP_SENDS,
  describeReport,
  encodeHolds,
  landedOutcome,
  liveHolds,
  loanVerdict,
  lowReserveNotices,
  LOW_WARN_SEC,
  type NoticeOutcome,
  publishArmedSteps,
  resetPublishedSteps,
  STATUS_PUBLISH_SEC,
  runStandingInstructions,
  standingInstructionsOnce,
  type ReserveView,
  type Step,
} from '../src/standingInstructions';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { Env } from '../src/env';
import type { AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { parseAddressedAlert } from '@vaipakam/lib/telegramAlerts/message';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const OWNER: Address = '0x00000000000000000000000000000000000000a1';
const OTHER: Address = '0x00000000000000000000000000000000000000b2';
const NOW = 10_000_000n;
const HOUR = 3_600n;
const E18 = 10n ** 18n;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

/** A loan as the fake keeps it: the state the view and the executors read. */
interface FakeLoan {
  active: boolean;
  holder: Address;
  owner: Address;
  trigger: bigint;
  target: bigint;
  lastTopUpAt: bigint;
  payInterest: boolean;
  repayAtDue: boolean;
  lead: bigint;
  hf: bigint;
  priceKnown: boolean;
  collateral: bigint;
  collateralReserve: bigint;
  paymentReserve: bigint;
  periodEnd: bigint;
  interestShortfall: bigint;
  repayDue: bigint;
  maturity: bigint;
  graceEnd: bigint;
  /** A skip the view predicts (a live sale, a pause, a locked account), by code. */
  viewSkip: number;
  /** A skip the view cannot predict (not yet consolidated), by code. */
  hiddenSkip: number;
}

const loan = (over: Partial<FakeLoan> = {}): FakeLoan => ({
  active: true,
  holder: OWNER,
  owner: OWNER,
  trigger: 0n,
  target: 0n,
  lastTopUpAt: 0n,
  payInterest: false,
  repayAtDue: false,
  lead: 0n,
  hf: 2n * E18,
  priceKnown: true,
  collateral: 1_000n,
  collateralReserve: 0n,
  paymentReserve: 0n,
  periodEnd: NOW + 10n * HOUR,
  interestShortfall: 0n,
  repayDue: 5_000n,
  maturity: NOW + 30n * 24n * HOUR,
  graceEnd: NOW + 31n * 24n * HOUR,
  viewSkip: 0,
  hiddenSkip: 0,
  ...over,
});

const topUpAmount = (l: FakeLoan) => {
  if (l.hf === 0n || l.target <= l.hf) return 0n;
  const want = (l.collateral * (l.target - l.hf) + l.hf - 1n) / l.hf;
  return want < l.collateralReserve ? want : l.collateralReserve;
};

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  interval = HOUR;
  loans = new Map<bigint, FakeLoan>();
  sent: { fn: string; id: bigint }[] = [];
  simulated: { fn: string; id: bigint }[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];

  view(id: bigint, holder: Address): ReserveView {
    const l = this.loans.get(id) ?? loan({ active: false, owner: zeroAddress });
    const mine = holder === l.owner && holder !== zeroAddress;
    const v: ReserveView = {
      paymentAsset: OTHER,
      paymentReserve: mine ? l.paymentReserve : 0n,
      collateralAsset: OTHER,
      collateralReserve: mine ? l.collateralReserve : 0n,
      instructions: {
        owner: l.owner,
        topUpTriggerHf: l.trigger,
        topUpTargetHf: l.target,
        lastTopUpAt: l.lastTopUpAt,
        payInterest: l.payInterest,
        repayAtDue: l.repayAtDue,
        repayLeadSeconds: Number(l.lead),
      },
      ownerHoldsPosition: false,
      topUpNow: 0n,
      priceKnown: false,
      interestShortfall: 0n,
      interestNow: 0n,
      repayDue: 0n,
      repayShortBy: 0n,
      topUpSkipNow: 0,
      paymentSkipNow: 0,
      consolidationPending: false,
    };
    if (!l.active) return v;
    v.ownerHoldsPosition = l.owner !== zeroAddress && l.holder === l.owner;
    v.priceKnown = l.priceKnown;
    if (l.priceKnown && l.trigger !== 0n && l.hf < l.trigger) v.topUpNow = mine ? topUpAmount(l) : 0n;
    v.interestShortfall = l.interestShortfall;
    if (this.now >= l.periodEnd) v.interestNow = l.interestShortfall < v.paymentReserve ? l.interestShortfall : v.paymentReserve;
    v.repayDue = l.repayDue;
    v.repayShortBy = l.repayDue > v.paymentReserve ? l.repayDue - v.paymentReserve : 0n;
    if (mine) {
      v.topUpSkipNow = l.viewSkip;
      v.paymentSkipNow = l.viewSkip;
      v.consolidationPending = l.hiddenSkip === 8;
    }
    return v;
  }

  readContract = async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'paused':
        return this.paused;
      case 'getStandingInstructionConfig':
        return { triggerMinHf: 0n, triggerMaxHf: 0n, targetMaxHf: 0n, minMarginHf: 0n, topUpIntervalSeconds: Number(this.interval) };
      case 'getLoanReserve':
        return this.view(a[0], a[1]);
      case 'getLoanDeadlines': {
        const l = this.loans.get(a[0])!;
        return [l.maturity, 0n, l.maturity, l.graceEnd];
      }
      case 'decimals':
        return 6;
      case 'symbol':
        return 'USDC';
      case 'previewPeriodicSettle':
        return { periodEndAt: this.loans.get(a[0])!.periodEnd };
      case 'getLoanDetails':
        return { status: this.loans.get(a[0])?.active === false ? 1 : 0 };
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts, blockNumber }: { contracts: { functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract({ ...c, blockNumber }) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  private skip(id: bigint, instruction: number, reason: number, missing = 0n) {
    this.lastLogs = [logOf('StandingInstructionSkipped', { loanId: id, instruction, reason, missing, caller: KEEPER })];
  }

  /** The contract's order of checks and skips. */
  private admit(fn: string, id: bigint): () => void {
    const l = this.loans.get(id)!;
    if (fn === 'runCollateralTopUp') {
      if (l.trigger === 0n) throw revert('StandingInstructionNotSet', [id, 1]);
      if (!l.active) throw revert('LoanNotActive');
      if (l.lastTopUpAt !== 0n && this.now < l.lastTopUpAt + this.interval) throw revert('TopUpTooSoon', [id, l.lastTopUpAt + this.interval]);
      const skip = l.holder !== l.owner ? 1 : (l.viewSkip || l.hiddenSkip) || (l.collateralReserve === 0n ? 2 : !l.priceKnown ? 5 : 0);
      if (skip !== 0) return () => this.skip(id, 1, skip);
      if (l.hf >= l.trigger) throw revert('LoanHealthAboveTrigger', [id, l.hf, l.trigger]);
      return () => {
        const amount = topUpAmount(l);
        l.collateralReserve -= amount;
        l.collateral += amount;
        l.lastTopUpAt = this.now;
        const before = l.hf;
        l.hf = l.target;
        this.lastLogs = [logOf('CollateralTopUpRun', { loanId: id, holder: l.owner, amount, hfBefore: before, hfAfter: l.hf, reserveLeft: l.collateralReserve, caller: KEEPER })];
      };
    }
    if (fn === 'runInterestPayment') {
      if (!l.payInterest) throw revert('StandingInstructionNotSet', [id, 2]);
      if (!l.active) throw revert('LoanNotActive');
      if (this.now < l.periodEnd) throw revert('StandingInstructionNotDue', [id, 2, l.periodEnd]);
      if (l.interestShortfall === 0n) throw revert('NothingOwed', [id]);
      const skip = l.holder !== l.owner ? 1 : (l.viewSkip || l.hiddenSkip) || (l.paymentReserve === 0n ? 2 : 0);
      if (skip !== 0) return () => this.skip(id, 2, skip);
      return () => {
        const amount = l.interestShortfall < l.paymentReserve ? l.interestShortfall : l.paymentReserve;
        l.paymentReserve -= amount;
        const shortfall = l.interestShortfall;
        l.interestShortfall -= amount;
        this.lastLogs = [logOf('InterestPaidFromReserve', { loanId: id, holder: l.owner, amount, shortfall, periodClosed: l.interestShortfall === 0n, reserveLeft: l.paymentReserve, caller: KEEPER })];
      };
    }
    if (fn === 'runDueRepayment') {
      if (!l.repayAtDue) throw revert('StandingInstructionNotSet', [id, 3]);
      if (!l.active) throw revert('LoanNotActive');
      const from = l.maturity > l.lead ? l.maturity - l.lead : 0n;
      if (this.now < from) throw revert('StandingInstructionNotDue', [id, 3, from]);
      if (this.now > l.graceEnd) throw revert('StandingInstructionWindowClosed', [id, 3]);
      let skip = l.holder !== l.owner ? 1 : l.viewSkip || l.hiddenSkip;
      if (skip === 0 && l.paymentReserve === 0n) skip = 2;
      if (skip === 0 && l.paymentReserve < l.repayDue) return () => this.skip(id, 3, 3, l.repayDue - l.paymentReserve);
      if (skip !== 0) return () => this.skip(id, 3, skip);
      return () => {
        l.paymentReserve -= l.repayDue;
        l.active = false;
        this.lastLogs = [logOf('DueRepaymentRun', { loanId: id, holder: l.owner, amount: l.repayDue, reserveLeft: l.paymentReserve, caller: KEEPER })];
      };
    }
    throw new Error(`unexpected call ${fn}`);
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.simulated.push({ fn: functionName, id: args[0] as bigint });
    this.admit(functionName, args[0] as bigint);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;
  getBlockNumber = async () => 120n;
  getBlock = async ({ blockTag }: { blockTag?: string } = {}) =>
    blockTag === 'finalized' ? { number: 100n, timestamp: this.now } : { number: 120n, timestamp: this.now };
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.lastLogs, blockNumber: 121n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: DIAMOND,
      chainId: CHAIN,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          this.admit(functionName, args[0] as bigint)();
          this.sent.push({ fn: functionName, id: args[0] as bigint });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

class FakeLedger implements EventLedger {
  rows: LedgerRow[] = [];

  add(loanId: bigint, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'StandingInstructionsSet', args: { loanId: loanId.toString(), owner: OWNER }, blockAt: n, block: n, log: 0, tx: '0x' });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    expect(kinds).toEqual(['StandingInstructionsSet']);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

const ALL: ReadonlySet<Step> = new Set(['topUp', 'repay', 'interest']);

describe('loanVerdict', () => {
  const d = new FakeDiamond();
  const verdict = (l: FakeLoan, now = NOW) => {
    d.loans.set(1n, l);
    d.now = now;
    return loanVerdict(d.view(1n, l.owner), { maturity: l.maturity, graceEnd: l.graceEnd }, now, HOUR);
  };

  it('sends a top-up only under the trigger, with a reserve, a price and the interval passed', () => {
    const under = { trigger: 13n * E18 / 10n, target: 16n * E18 / 10n, hf: 12n * E18 / 10n, collateralReserve: 500n };
    expect(verdict(loan(under)).send).toEqual(['topUp']);
    expect(verdict(loan({ ...under, hf: 14n * E18 / 10n })).send, 'above the trigger').toEqual([]);
    expect(verdict(loan({ ...under, collateralReserve: 0n })).held.map((h) => h.why)).toEqual(['the collateral reserve is empty']);
    expect(verdict(loan({ ...under, priceKnown: false })).held.map((h) => h.why)).toEqual(['the collateral price is missing or distrusted']);
    const soon = verdict(loan({ ...under, lastTopUpAt: NOW - HOUR + 1n }));
    expect(soon.send).toEqual([]);
    expect(soon.held[0].why).toMatch(/within the interval/);
    expect(verdict(loan({ ...under, lastTopUpAt: NOW - HOUR })).send, 'the interval exactly passed').toEqual(['topUp']);
  });

  it('pays interest only from the period end, and says when the reserve is empty', () => {
    const owed = { payInterest: true, interestShortfall: 40n, paymentReserve: 100n };
    expect(verdict(loan(owed)).send, 'before the period end').toEqual([]);
    expect(verdict(loan({ ...owed, periodEnd: NOW })).send).toEqual(['interest']);
    expect(verdict(loan({ ...owed, periodEnd: NOW, paymentReserve: 0n })).held.map((h) => h.why)).toEqual(['the payment reserve is empty']);
    expect(verdict(loan({ ...owed, periodEnd: NOW, interestShortfall: 0n })).send, 'nothing owed').toEqual([]);
  });

  it('repays only inside the window and only when the reserve covers it, and then takes the loan alone', () => {
    const plan = { repayAtDue: true, lead: 2n * HOUR, paymentReserve: 5_000n, maturity: NOW + 2n * HOUR, payInterest: true, interestShortfall: 10n, periodEnd: NOW };
    const due = verdict(loan(plan));
    expect(due.send, 'the repayment closes the loan, so nothing else').toEqual(['repay']);
    expect(verdict(loan({ ...plan, maturity: NOW + 2n * HOUR + 1n })).send, 'a second before the lead window').toEqual(['interest']);
    expect(verdict(loan({ ...plan, maturity: NOW - 2n * HOUR, graceEnd: NOW - 1n })).send, 'grace has ended').toEqual(['interest']);
    const short = verdict(loan({ ...plan, paymentReserve: 4_000n }));
    expect(short.send).toEqual(['interest']);
    expect(short.held.map((h) => h.why)).toEqual(['the payment reserve is 1000 short of the 5000 due']);
    const noDeadlines = loanVerdict(d.view(1n, OWNER), null, NOW, HOUR);
    expect(noDeadlines.held.map((h) => h.why)).toContain("the loan's deadlines were not read");
  });

  it('runs nothing for a position no longer held by the wallet that set it, and nothing without instructions', () => {
    const moved = verdict(loan({ holder: OTHER, payInterest: true, interestShortfall: 10n, paymentReserve: 10n, periodEnd: NOW }));
    expect(moved.send).toEqual([]);
    expect(moved.held).toHaveLength(1);
    expect(verdict(loan()).held, 'no instruction set').toEqual([]);
  });
});

describe('lowReserveNotices', () => {
  const d = new FakeDiamond();
  const notices = (l: FakeLoan, periodEnd: bigint | null) => {
    d.loans.set(1n, l);
    return lowReserveNotices(1n, d.view(1n, l.owner), { maturity: l.maturity, graceEnd: l.graceEnd }, NOW, periodEnd);
  };
  it('warns of an interest period the reserve will not cover only from three days before it ends', () => {
    const l = loan({ payInterest: true, interestShortfall: 100n, paymentReserve: 40n });
    expect(notices(l, NOW + BigInt(LOW_WARN_SEC) + 1n)).toEqual([]);
    expect(notices(l, NOW + BigInt(LOW_WARN_SEC))).toMatchObject([{ instruction: 'interest', missing: { amount: 60n }, dueAt: NOW + BigInt(LOW_WARN_SEC) }]);
    expect(notices(loan({ payInterest: true, interestShortfall: 100n }), null), 'an empty reserve, period end unread').toMatchObject([{ instruction: 'interest', missing: null, dueAt: null }]);
    expect(notices(loan({ ...l, holder: OTHER }), NOW), 'not for a moved position').toEqual([]);
  });
});

describe('receipt outcomes and holds', () => {
  it('reads a run, or the contract\'s skip, from the Diamond\'s own events for this loan and instruction', () => {
    const ran = logOf('CollateralTopUpRun', { loanId: 1n, holder: OWNER, amount: 7n, hfBefore: 1n, hfAfter: 2n, reserveLeft: 0n, caller: KEEPER });
    expect(landedOutcome(DIAMOND, 'topUp', 1n, [ran])).toEqual({ ran: { step: 'topUp', loanId: 1n, amount: 7n } });
    expect(landedOutcome(DIAMOND, 'topUp', 2n, [ran]), 'another loan').toEqual({ ran: { step: 'topUp', loanId: 2n, amount: null } });
    const skip = logOf('StandingInstructionSkipped', { loanId: 1n, instruction: 3, reason: 3, missing: 250n, caller: KEEPER });
    expect(landedOutcome(DIAMOND, 'repay', 1n, [skip])).toEqual({ skip: { step: 'repay', loanId: 1n, reason: 'the reserve is short of the full repayment (250 missing)' } });
    expect('ran' in landedOutcome(DIAMOND, 'interest', 1n, [skip]), "another instruction's skip").toBe(true);
    expect('ran' in landedOutcome(DIAMOND, 'repay', 1n, [{ ...skip, address: KEEPER }]), 'not the Diamond').toBe(true);
  });

  it('keeps only live holds, and reads a damaged record as none', () => {
    const raw = encodeHolds(new Map([['topUp:1', NOW + 5n], ['repay:2', NOW]]));
    expect([...liveHolds(raw, NOW)]).toEqual([['topUp:1', NOW + 5n]]);
    expect(liveHolds('{not json', NOW).size).toBe(0);
    expect(liveHolds(undefined, NOW).size).toBe(0);
  });
});

describe('publishArmedSteps', () => {
  function fakeDb(fail = false) {
    const batches: unknown[][][] = [];
    return {
      batches,
      prepare(sql: string) {
        expect(sql).toMatch(/INSERT INTO keeper_step_status/);
        return { bind: (...v: unknown[]) => v };
      },
      async batch(stmts: unknown[][]) {
        if (fail) throw new Error('D1 down');
        batches.push(stmts);
        return [];
      },
    } as unknown as D1Database & { batches: unknown[][][] };
  }
  const chains = [{ id: 84532, diamond: '0x63816B149266C9dBFB7683dfd02D851915238049' }];
  beforeEach(() => resetPublishedSteps());

  it('publishes every step of every chain, armed or not, then only when due or changed', async () => {
    const db = fakeDb();
    await publishArmedSteps(db, chains, new Set(['topUp']), 1_000);
    expect(db.batches).toEqual([
      [
        [84532, '0x63816b149266c9dbfb7683dfd02d851915238049', 'standingInstructions', 'topUp', 1, 1_000],
        [84532, '0x63816b149266c9dbfb7683dfd02d851915238049', 'standingInstructions', 'repay', 0, 1_000],
        [84532, '0x63816b149266c9dbfb7683dfd02d851915238049', 'standingInstructions', 'interest', 0, 1_000],
      ],
    ]);
    await publishArmedSteps(db, chains, new Set(['topUp']), 1_000 + STATUS_PUBLISH_SEC - 1);
    expect(db.batches, 'not yet due').toHaveLength(1);
    await publishArmedSteps(db, chains, new Set(['topUp', 'repay']), 1_001);
    expect(db.batches, 'the armed set changed').toHaveLength(2);
    await publishArmedSteps(db, chains, new Set(['topUp', 'repay']), 1_001 + STATUS_PUBLISH_SEC);
    expect(db.batches, 'due again').toHaveLength(3);
  });

  it('never stops the pass when the write fails, and tries again next run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishArmedSteps(fakeDb(true), chains, new Set(), 1_000);
    const db = fakeDb();
    await publishArmedSteps(db, chains, new Set(), 1_001);
    expect(db.batches).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe('runStandingInstructions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing while no instruction is armed, and says which flags are unset', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    // Any chain read would throw: there is no RPC and no database here.
    const env = { KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`, DB: null } as unknown as Env;
    await runStandingInstructions(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toEqual([
      '[keeper] standingInstructions start',
      '[keeper] standingInstructions collateral top-up: off: STANDING_TOPUP_ENABLED unset',
      '[keeper] standingInstructions due repayment: off: STANDING_REPAY_ENABLED unset',
      '[keeper] standingInstructions interest payment: off: STANDING_INTEREST_ENABLED unset',
      '[keeper] standingInstructions: no instruction step is armed, so nothing runs',
    ]);
  });
});

describe('a run', () => {
  let d: FakeDiamond;
  let ledger: FakeLedger;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    d = new FakeDiamond();
    ledger = new FakeLedger();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { armed?: ReadonlySet<Step>; visit?: number; notify?: (a: AddressedAlert) => Promise<NoticeOutcome> } = {}) =>
    standingInstructionsOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      visit: opts.visit ?? 0,
      armed: opts.armed ?? ALL,
      notify: opts.notify,
    });
  const sent = () => d.sent.map((s) => `${s.fn}(${s.id})`);
  const add = (id: bigint, l: FakeLoan) => {
    d.loans.set(id, l);
    ledger.add(id);
  };
  const underTrigger = { trigger: 13n * E18 / 10n, target: 16n * E18 / 10n, hf: 12n * E18 / 10n, collateralReserve: 500n };

  it('runs each due instruction and reports what moved from the receipt, top-ups first', async () => {
    add(1n, loan({ payInterest: true, interestShortfall: 40n, paymentReserve: 100n, periodEnd: NOW }));
    add(2n, loan(underTrigger));
    add(3n, loan({ repayAtDue: true, paymentReserve: 5_000n, maturity: NOW }));
    add(4n, loan({ payInterest: true, interestShortfall: 40n, paymentReserve: 100n })); // period not over
    const r = await run();
    expect(sent()).toEqual(['runCollateralTopUp(2)', 'runDueRepayment(3)', 'runInterestPayment(1)']);
    expect(d.simulated.map((s) => s.id), 'nothing else is even simulated').toEqual([2n, 3n, 1n]);
    expect(r.named).toBe(4);
    expect(r.due).toBe(3);
    expect(r.ran).toEqual([
      { step: 'topUp', loanId: 2n, amount: 334n },
      { step: 'repay', loanId: 3n, amount: 5_000n },
      { step: 'interest', loanId: 1n, amount: 40n },
    ]);
    expect(describeReport(r)).toContain('ran=topUp:2(334),repay:3(5000),interest:1(40)');
  });

  it('runs only the armed instructions', async () => {
    add(1n, loan({ payInterest: true, interestShortfall: 40n, paymentReserve: 100n, periodEnd: NOW }));
    add(2n, loan(underTrigger));
    await run({ armed: new Set(['topUp']) });
    expect(sent()).toEqual(['runCollateralTopUp(2)']);
  });

  it('pays no gas for a skip the view shows, and states why', async () => {
    add(1n, loan({ repayAtDue: true, paymentReserve: 4_000n, maturity: NOW }));
    add(2n, loan({ ...underTrigger, holder: OTHER }));
    const r = await run();
    expect(d.simulated).toEqual([]);
    expect(r.held).toEqual([
      'repay loan 1: the payment reserve is 1000 short of the 5000 due',
      'topUp loan 2: the position is not held by the wallet that set it, or the loan is not active',
    ]);
  });

  it('reads a skip the view cannot see from the receipt, and holds that instruction before trying again', async () => {
    add(1n, loan({ ...underTrigger, hiddenSkip: 8 }));
    const first = await run();
    expect(sent()).toEqual(['runCollateralTopUp(1)']);
    expect(first.ran).toEqual([]);
    expect(first.skips).toEqual([{ step: 'topUp', loanId: 1n, reason: "the collateral has not yet moved to the new holder's vault" }]);
    expect(describeReport(first)).toContain("skipped-by-contract=topUp:1(the collateral has not yet moved to the new holder's vault)");
    const until = NOW + BigInt(SKIP_HOLD_SEC);
    expect((await cursors.get([HOLDS_ITEM])).get(HOLDS_ITEM)).toBe(encodeHolds(new Map([['topUp:1', until]])));

    const second = await run({ visit: 1 });
    expect(sent(), 'held: not sent again').toEqual(['runCollateralTopUp(1)']);
    expect(second.held).toEqual([`topUp loan 1: skipped by the contract on an earlier run; tried again from ${until}`]);

    d.now = until;
    d.loans.get(1n)!.hiddenSkip = 0;
    const third = await run({ visit: 2 });
    expect(sent()).toEqual(['runCollateralTopUp(1)', 'runCollateralTopUp(1)']);
    expect(third.ran).toHaveLength(1);
    expect((await cursors.get([HOLDS_ITEM])).get(HOLDS_ITEM), 'the lapsed hold is dropped').toBe('{}');
  });

  it('holds, without sending, a due call the view says the contract would skip', async () => {
    add(1n, loan({ ...underTrigger, viewSkip: 4 }));
    add(2n, loan({ payInterest: true, paymentReserve: 100n, interestShortfall: 50n, periodEnd: NOW, viewSkip: 7 }));
    const r = await run();
    expect(sent()).toEqual([]);
    expect(d.simulated).toEqual([]);
    expect(r.held).toEqual([
      'topUp loan 1: the contract would skip it: a sale, offset, refinance or intent is live on the loan',
      "interest loan 2: the contract would skip it: the borrower's account is locked",
    ]);
    d.loans.get(1n)!.viewSkip = 0;
    await run({ visit: 1 });
    expect(sent(), 'no receipt hold: sent once the view clears').toEqual(['runCollateralTopUp(1)']);
  });

  it('sends nothing while the platform is paused', async () => {
    add(1n, loan(underTrigger));
    d.paused = true;
    const r = await run();
    expect(d.simulated).toEqual([]);
    expect(r.held).toEqual(['every instruction: the platform is paused']);
  });

  it('names a refusal of the loan at the current block, and leaves it for a later run', async () => {
    add(1n, loan({ ...underTrigger, lastTopUpAt: NOW - HOUR }));
    d.interval = HOUR; // the view's interval passes; the contract's changes before the call
    d.simulateContract = async ({ functionName, args }) => {
      d.simulated.push({ fn: functionName, id: args[0] as bigint });
      throw revert('TopUpTooSoon', [args[0], NOW + 1n]);
    };
    const r = await run();
    expect(sent()).toEqual([]);
    expect(r.declined).toEqual(['topUp loan 1: a top-up ran within the interval']);
    expect(r.refused.size, 'an expected wait is not a refusal').toBe(0);
  });

  it("keeps each step to its share of the run's sends", async () => {
    for (let i = 1n; i <= 6n; i += 1n) add(i, loan(underTrigger));
    const r = await run();
    expect(d.sent).toHaveLength(STEP_SENDS.topUp);
    expect(r.deferred).toBe(6 - STEP_SENDS.topUp);
  });

  it('moves the floor past loans whose instructions were cleared or which closed, at the finalized block', async () => {
    add(1n, loan({ owner: zeroAddress })); // cleared
    add(2n, loan({ repayAtDue: true, paymentReserve: 5_000n, maturity: NOW })); // repaid this run
    add(3n, loan(underTrigger)); // still live
    ledger.rows.forEach((row) => (row.block = 50)); // every row finalized
    ledger.rows.forEach((row, i) => (row.log = i));
    await run();
    expect(sent()).toEqual(['runCollateralTopUp(3)', 'runDueRepayment(2)']);
    const floor = (await cursors.get([FLOOR_ITEM])).get(FLOOR_ITEM);
    expect(floor, 'past the cleared loan and the repaid one, stopped at the live one').toBe(encodePos({ block: 50, log: 1 }));
  });

  it('lets a loan closed by other means leave the rotation, and runs nothing for it', async () => {
    add(1n, loan({ ...underTrigger, active: false })); // repaid by hand
    add(2n, loan({ ...underTrigger, holder: OTHER })); // position moved: still live
    ledger.rows.forEach((row) => (row.block = 50));
    ledger.rows.forEach((row, i) => (row.log = i));
    const r = await run();
    expect(d.simulated).toEqual([]);
    expect(r.held, 'the closed loan is not reported as held').toEqual([
      'topUp loan 2: the position is not held by the wallet that set it, or the loan is not active',
    ]);
    expect((await cursors.get([FLOOR_ITEM])).get(FLOOR_ITEM)).toBe(encodePos({ block: 50, log: 0 }));
  });

  describe('borrower alerts', () => {
    const inbox: AddressedAlert[] = [];
    const notify = async (a: AddressedAlert): Promise<NoticeOutcome> => {
      // Every alert must pass the agent's own parser.
      expect(parseAddressedAlert(JSON.parse(JSON.stringify(a)))).not.toBeNull();
      inbox.push(a);
      return 'sent';
    };
    beforeEach(() => inbox.splice(0));

    it('tells the owner a top-up ran, with amounts in the token and the health factors', async () => {
      add(1n, loan(underTrigger));
      const r = await run({ notify });
      expect(inbox).toEqual([
        {
          chainId: CHAIN,
          wallet: OWNER,
          alert: { kind: 'standingTopUp', loanId: 1, amount: expect.stringMatching(/^0\.000334 USDC/), hfBefore: 1.2, hfAfter: 1.6, reserveLeft: expect.stringMatching(/^0\.000166 USDC/) },
        },
      ]);
      expect(r.alerted).toEqual(['topUp:1']);
    });

    it('tells the owner of a skip once a day, and of a short repayment reserve from three days before the window', async () => {
      add(1n, loan({ ...underTrigger, viewSkip: 7 }));
      add(2n, loan({ repayAtDue: true, paymentReserve: 4_000n, maturity: NOW + BigInt(LOW_WARN_SEC) }));
      await run({ notify });
      expect(inbox.map((a) => a.alert)).toEqual([
        { kind: 'standingSkipped', loanId: 1, instruction: 'topUp', reason: 'accountLocked', missing: null },
        { kind: 'standingReserveLow', loanId: 2, instruction: 'repay', missing: expect.stringMatching(/^0\.001 USDC/), dueAt: Number(NOW + BigInt(LOW_WARN_SEC)) },
      ]);
      d.now = NOW + 31n * 60n; // past the skip hold, inside the day
      await run({ notify, visit: 1 });
      expect(inbox, 'both throttled for the day').toHaveLength(2);
      d.now = NOW + 24n * HOUR;
      await run({ notify, visit: 2 });
      expect(inbox.map((a) => a.alert.kind)).toEqual(['standingSkipped', 'standingReserveLow', 'standingSkipped', 'standingReserveLow']);
    });

    it('sends again next run what no channel took', async () => {
      add(1n, loan({ trigger: 13n * E18 / 10n, target: 16n * E18 / 10n }));
      const r = await run({ notify: async () => 'retry' });
      expect(r.alerted).toEqual([]);
      await run({ notify, visit: 1 });
      expect(inbox.map((a) => a.alert)).toEqual([{ kind: 'standingReserveLow', loanId: 1, instruction: 'topUp', missing: null, dueAt: null }]);
    });

    it('sends none while alerts are off', async () => {
      add(1n, loan(underTrigger));
      const r = await run();
      expect(r.alerted).toBeNull();
      expect(describeReport(r)).not.toContain('alerted=');
    });
  });

  it('refuses an RPC that serves another chain', async () => {
    add(1n, loan(underTrigger));
    d.chainServed = 1;
    const r = await run();
    expect(r.skipped).toMatch(/serves chain 1/);
    expect(d.simulated).toEqual([]);
  });
});
