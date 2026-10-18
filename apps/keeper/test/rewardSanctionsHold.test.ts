/**
 * #2450 — the sanctions-hold observer.
 *
 * The pass's judgement is two pure functions (who is a candidate; what to do
 * for each classification) and two D1 reads over the indexer's
 * `activity_events`. Each threshold is pinned by a STRADDLE — one second
 * either side — so a cell cannot pass on a comparison that is off by one or
 * the wrong way round. The D1 reads run against the real migration DDL, so the
 * JSON extraction and the ordering are the engine's, not a fake's. The ops
 * alert is pinned on what it records: a delivery that failed must not count
 * as sent, or the next tick would stay silent about a live condition.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECISION_DELIVER,
  DECISION_CONFIRMED,
  DECISION_HOLD,
  OBSERVE_AFTER_SEC,
  PASS_CADENCE_SEC,
  candidateOwners,
  nextScreenCursor,
  writeBudgetFor,
  planSanctionsHold,
  SCREEN_MAX_PER_TICK,
  SCREEN_MIN_PER_TICK,
  screenSliceSize,
  raiseAlerts,
  type OwnerSanctionsStatus,
} from '../src/rewardSanctionsHold';
import {
  countLoanParties,
  getOpsAlert,
  listLoanPartiesAfter,
  listOpenSanctionsChains,
  listOpenStagingOwners,
  listOpenStagingRecordKeysForUser,
} from '../src/db';
import { sendOpsAlert } from '../src/opsAlert';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';
// The ops-alert table is keeper-private (#2450): those cells run on the
// keeper's own schema, beside a shared database that has no keeper tables.
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { KeeperD1 } from '../src/env';

const MIGRATIONS_DIR = new URL('../../indexer/migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 421614;
const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;
const C = '0x00000000000000000000000000000000000000cc' as const;
const NOW = 1_800_000_000;
const DAY = 86_400;

function held(over: Partial<OwnerSanctionsStatus> = {}): OwnerSanctionsStatus {
  const lastSeenAt = NOW - 3600;
  return {
    owner: A,
    decision: DECISION_HOLD,
    flaggedAt: NOW - DAY,
    lastSeenAt,
    forfeitableAt: NOW - DAY + 3 * DAY,
    observeBy: lastSeenAt + DAY,
    stored: false,
    ...over,
  };
}

describe('candidateOwners', () => {
  it('unions the open chains and the open-staging owners, once each, lowercased', () => {
    expect(candidateOwners([A, B], ['0x00000000000000000000000000000000000000AA'])).toEqual([A, B]);
    expect(candidateOwners([], [B]), 'a held claimant with no chain').toEqual([B]);
    expect(candidateOwners([], [])).toEqual([]);
  });
});

describe('planSanctionsHold — urgency order, never address order (#2497 r4)', () => {
  it('lists the oldest observation first, so a capped tick rotates through every held owner', () => {
    const own = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as OwnerSanctionsStatus['owner'];
    // 200 held owners, all due; a LATER address carries an OLDER observation, so
    // address order and urgency order disagree everywhere.
    const statuses = Array.from({ length: 200 }, (_, i) =>
      held({ owner: own(i + 1), lastSeenAt: NOW - 7 * 3600 - i, observeBy: NOW + DAY }),
    );
    const plan = planSanctionsHold(statuses, NOW);
    expect(plan.observe).toHaveLength(200);
    expect(plan.observe[0], 'the stalest owner, the last address, first').toBe(own(200));
    expect(plan.observe.at(-1), 'the freshest, the first address, last').toBe(own(1));
    // A never-observed owner outranks every observed one.
    const fresh = planSanctionsHold([...statuses, held({ owner: own(999), lastSeenAt: 0, flaggedAt: 0, observeBy: 0 })], NOW);
    expect(fresh.observe[0]).toBe(own(999));
  });
});

describe('planSanctionsHold — a clean result is committed, not only acted on (#2497 r7)', () => {
  it('lists a Deliver owner the contract still stores a chain or marker for, and no other', () => {
    const p = planSanctionsHold(
      [
        held({ owner: A, decision: DECISION_DELIVER, stored: true }),
        held({ owner: B, decision: DECISION_DELIVER, stored: false }),
      ],
      NOW,
    );
    expect(p.commitClean).toEqual([A]);
    expect(p.resolveOnly.sort()).toEqual([A, B].sort());
  });

  it('never commits clean for a held or confirmed owner', () => {
    const p = planSanctionsHold([held({ owner: A, stored: true }), held({ owner: B, decision: DECISION_CONFIRMED, stored: true })], NOW);
    expect(p.commitClean).toEqual([]);
  });
});

describe('planSanctionsHold — every due observation, Held AND Confirmed, in one urgency-ordered list (#2497 r9)', () => {
  it('lists a due Confirmed owner alongside due Held ones, most stale first, so phase 1 serves them all before any backlog', () => {
    const p = planSanctionsHold(
      [
        held({ owner: A, decision: DECISION_CONFIRMED, lastSeenAt: NOW - OBSERVE_AFTER_SEC - 10 }),
        held({ owner: B, lastSeenAt: NOW - OBSERVE_AFTER_SEC - 20 }),
        held({ owner: C, decision: DECISION_CONFIRMED, lastSeenAt: NOW - 60 }), // not due
      ],
      NOW,
    );
    expect(p.dueObservations).toEqual([
      { owner: B, confirmed: false },
      { owner: A, confirmed: true },
    ]);
    expect(p.settle.sort(), 'both Confirmed still get their backlog in phase 3').toEqual([A, C].sort());
  });
});

describe('writeBudgetFor — sized by the six-hour bound, capped and stated (#2497 r7)', () => {
  it('adds one observation per held owner per bound on top of the floor', () => {
    expect(writeBudgetFor(0)).toEqual({ writes: 25, overCapacity: false });
    expect(writeBudgetFor(150), '150 held over 6 ticks: 25 more').toEqual({ writes: 50, overCapacity: false });
    expect(writeBudgetFor(151).writes, 'rounds up, so nobody waits a seventh tick').toBe(51);
  });

  it('caps at the ceiling and says the cap binds (straddle)', () => {
    expect(writeBudgetFor(570), 'exactly the ceiling').toEqual({ writes: 120, overCapacity: false });
    expect(writeBudgetFor(571), 'one owner past it').toEqual({ writes: 120, overCapacity: true });
  });

  it('counts the clean commits as demand too, so they cannot crowd out observations (#2497 r8)', () => {
    // The finding's case: 100 clean commits + 60 held owners.
    expect(writeBudgetFor(60, 100)).toEqual({ writes: 120, overCapacity: true });
    expect(writeBudgetFor(60, 10), 'fits').toEqual({ writes: 45, overCapacity: false });
  });

  it('the planner carries the held count and the budget', () => {
    const p = planSanctionsHold([held({ owner: A }), held({ owner: B, decision: DECISION_DELIVER })], NOW);
    expect(p.heldCount).toBe(1);
    expect(p.writes).toBe(26);
  });
});

describe('planSanctionsHold', () => {
  it('observes a held owner once its latest observation is OBSERVE_AFTER_SEC old (straddle)', () => {
    const at = (age: number) => planSanctionsHold([held({ lastSeenAt: NOW - age, observeBy: NOW - age + DAY })], NOW);
    expect(at(OBSERVE_AFTER_SEC - 1).observe, 'one second early').toEqual([]);
    expect(at(OBSERVE_AFTER_SEC).observe, 'at the bound').toEqual([A]);
  });

  it('observes a held owner with no observation, and reports it held without a chain', () => {
    const p = planSanctionsHold([held({ flaggedAt: 0, lastSeenAt: 0, forfeitableAt: 0, observeBy: 0 })], NOW);
    expect(p.observe).toEqual([A]);
    expect(p.heldWithoutChain.map((s) => s.owner)).toEqual([A]);
    expect(p.deadlineAtRisk).toEqual([]);
    expect(p.overdue).toEqual([]);
  });

  it('flags the observation deadline within ONE cadence (straddle)', () => {
    const at = (left: number) => planSanctionsHold([held({ lastSeenAt: NOW - DAY + left, observeBy: NOW + left })], NOW);
    expect(at(PASS_CADENCE_SEC).deadlineAtRisk.map((s) => s.owner), 'exactly one cadence left').toEqual([A]);
    expect(at(PASS_CADENCE_SEC + 1).deadlineAtRisk, 'one second more').toEqual([]);
  });

  it('reports a hold overdue only past confirmation plus the contract-derived gap (straddle)', () => {
    // gap = observeBy - lastSeenAt = DAY, read from the contract's own pair.
    const at = (past: number) =>
      planSanctionsHold([held({ forfeitableAt: NOW - DAY - past, lastSeenAt: NOW - 60, observeBy: NOW - 60 + DAY })], NOW);
    expect(at(0).overdue, 'exactly confirmation + gap').toEqual([]);
    expect(at(1).overdue.map((s) => s.owner), 'one second past').toEqual([A]);
  });

  it('routes Confirmed to the settlement and Deliver to the resolution pages only', () => {
    const p = planSanctionsHold(
      [held({ owner: A, decision: DECISION_CONFIRMED }), held({ owner: B, decision: DECISION_DELIVER })],
      NOW,
    );
    expect(p.settle).toEqual([A]);
    expect(p.resolveOnly).toEqual([B]);
    expect(p.observe).toEqual([]);
    expect(p.overdue).toEqual([]);
  });

  it('a Confirmed owner is due an observation on the same rule as a hold (straddle)', () => {
    // A confirmed owner whose settlement makes no progress still needs its
    // chain kept alive, or the window stops counting the days it earns next.
    const at = (age: number) =>
      planSanctionsHold(
        [held({ decision: DECISION_CONFIRMED, lastSeenAt: NOW - age, observeBy: NOW - age + DAY })],
        NOW,
      );
    expect(at(OBSERVE_AFTER_SEC - 1).settleObserveDue, 'one second early').toEqual([]);
    expect(at(OBSERVE_AFTER_SEC).settleObserveDue, 'at the bound').toEqual([A]);
    expect(at(OBSERVE_AFTER_SEC).settle, 'still routed to the settlement').toEqual([A]);
    expect(at(OBSERVE_AFTER_SEC).observe, 'not a hold observation').toEqual([]);
  });
});


describe('the D1 reads, on the real schema', () => {
  let h: SqliteD1;
  function seed(kind: string, block: number, args: Record<string, unknown>, at = NOW) {
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(CHAIN, block, `0x${block.toString(16).padStart(64, '0')}`, kind, JSON.stringify(args), at);
  }

  it("lists a wallet while its LATEST evidence starts a chain, however many events follow (Codex #2489 r1)", async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    const C = '0x00000000000000000000000000000000000000cc';
    seed('RewardSanctionsEvidenceRecorded', 5, { who: '0x00000000000000000000000000000000000000AA' }, NOW - 400 * DAY);
    // 6,000 newer events for other wallets: more than the old 5,000-row window,
    // which dropped A here while its chain still stood.
    const ins = h.db.prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
       VALUES (?, ?, 0, ?, 'RewardSanctionsEvidenceRecorded', ?, ?)`,
    );
    for (let i = 0; i < 6000; i++) {
      ins.run(CHAIN, 100 + i, `0x${(100 + i).toString(16).padStart(64, '0')}`, JSON.stringify({ who: `0x${(i + 0x1000).toString(16).padStart(40, '0')}` }), NOW);
    }
    const open = await listOpenSanctionsChains(h.d1 as D1Database, CHAIN, 0);
    expect(open.includes(A), 'the old chain is still open').toBe(true);
    expect(open.length).toBe(6001);
    // B: started, then cleared — closed. C: cleared, then started again — open.
    seed('RewardSanctionsEvidenceRecorded', 7000, { who: B });
    seed('RewardSanctionsEvidenceCleared', 7001, { who: B });
    seed('RewardSanctionsEvidenceCleared', 7002, { who: C });
    seed('RewardSanctionsEvidenceRecorded', 7003, { who: C });
    const again = await listOpenSanctionsChains(h.d1 as D1Database, CHAIN, 0);
    expect(again.includes(B), 'a cleared chain is closed').toBe(false);
    expect(again.includes(C), 'a later start reopens').toBe(true);
    expect(await listOpenSanctionsChains(h.d1 as D1Database, CHAIN + 1, 0), 'another chain').toEqual([]);
  });

  it("lists one user's OPEN staging-record keys, case-insensitively, oldest first — a closed one never", async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    const k1 = `0x${'1'.repeat(64)}`;
    const k2 = `0x${'2'.repeat(64)}`;
    const k3 = `0x${'3'.repeat(64)}`;
    seed('StagingRecordOpened', 3, { key: k1, user: '0x00000000000000000000000000000000000000AA' }, NOW - 400 * DAY);
    seed('StagingRecordOpened', 4, { key: k2, user: A });
    seed('StagingRecordOpened', 5, { key: k3, user: A });
    seed('StagingRecordClosed', 6, { key: k3, paid: true });
    seed('StagingRecordOpened', 7, { key: `0x${'4'.repeat(64)}`, user: B });
    expect(await listOpenStagingRecordKeysForUser(h.d1 as D1Database, CHAIN, A, 0)).toEqual([k1, k2]);
    // Reopened after its close: open again (positions, not presence, decide).
    seed('StagingRecordOpened', 8, { key: k3, user: A });
    expect(await listOpenStagingRecordKeysForUser(h.d1 as D1Database, CHAIN, A, 0)).toEqual([k1, k2, k3]);
  });

  it('lists the owners of open records AND open domains, however old; a closed one drops (straddle on the close)', async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    const C = '0x00000000000000000000000000000000000000cc';
    const D = '0x00000000000000000000000000000000000000dd';
    const k = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    seed('StagingRecordOpened', 3, { key: k(1), user: '0x00000000000000000000000000000000000000AA' }, NOW - 400 * DAY); // old, open
    seed('StagingRecordOpened', 9, { key: k(2), user: B }, NOW - 100);
    seed('StagingRecordClosed', 10, { key: k(2), paid: false }); // B's only record closed
    seed('StagingDomainOpened', 11, { domainKey: k(3), user: C, side: 0, firstDay: 1, lastDay: 9, chunks: 1 }, NOW - 400 * DAY);
    seed('StagingDomainOpened', 12, { domainKey: k(4), user: D, side: 0, firstDay: 1, lastDay: 9, chunks: 1 });
    seed('StagingDomainCleared', 13, { domainKey: k(4), paid: true });
    seed('RewardSanctionsEvidenceRecorded', 14, { who: D }); // not staging work
    expect(await listOpenStagingOwners(h.d1 as D1Database, CHAIN, 0)).toEqual([A, C]);
    // B's record reopened AFTER its close: B is back.
    seed('StagingRecordOpened', 15, { key: k(2), user: B });
    expect(await listOpenStagingOwners(h.d1 as D1Database, CHAIN, 0)).toEqual([A, B, C]);
    expect(await listOpenStagingOwners(h.d1 as D1Database, CHAIN + 1, 0), 'another chain').toEqual([]);
  });
});

describe('raiseAlerts', () => {
  it('clears only an alert that is actually open: a quiet candidate costs no write', async () => {
    const h = createKeeperD1();
    const key = `sanctions-hold-overdue:${CHAIN}:${A}`;
    const otherChain = `sanctions-hold-overdue:${CHAIN + 1}:${A}`;
    for (const k of [key, otherChain]) {
      h.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at) VALUES (?, ?, ?)`).run(k, NOW, NOW);
    }
    const prepared: string[] = [];
    const d1 = h.d1 as unknown as { prepare: (sql: string) => unknown };
    const real = d1.prepare.bind(d1);
    d1.prepare = (sql: string) => {
      prepared.push(sql);
      return real(sql);
    };
    const quiet = {
      observe: [], dueObservations: [], settleObserveDue: [], settle: [], resolveOnly: [], commitClean: [],
      writes: 25, overCapacity: false, heldCount: 2,
      deadlineAtRisk: [], overdue: [], heldWithoutChain: [],
    };
    await raiseAlerts({ DB: createSharedD1().d1, KEEPER_DB: h.d1 } as unknown as Env, CHAIN, [held({ owner: A }), held({ owner: B })], quiet, NOW);
    expect(prepared.filter((s) => s.startsWith('DELETE')), 'one clear: the alert that was open').toHaveLength(1);
    const left = h.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[];
    expect(left.map((r) => r.alert_key), "another chain's alert is not this pass's to clear").toEqual([otherChain]);
  });

  it("states the screen's daily bound when a cycle overruns a day (#2497 r12)", async () => {
    const h = createKeeperD1();
    const env = { DB: createSharedD1().d1, KEEPER_DB: h.d1 } as unknown as Env;
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    const quiet = {
      observe: [], dueObservations: [], settleObserveDue: [], settle: [], resolveOnly: [], commitClean: [],
      writes: 25, overCapacity: false, heldCount: 0,
      deadlineAtRisk: [], overdue: [], heldWithoutChain: [],
    };
    try {
      await raiseAlerts(env, CHAIN, [], quiet, NOW, { total: 30_000, ticks: 30 });
      expect(warned.some((w) => /30000 loan parties take 30 hourly ticks to screen, more than a day/.test(w))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('raises the capacity alert while the write ceiling binds, and clears it after (#2497 r7)', async () => {
    const h = createKeeperD1();
    const env = { DB: createSharedD1().d1, KEEPER_DB: h.d1 } as unknown as Env;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = (over: boolean) => ({
      observe: [], dueObservations: [], settleObserveDue: [], settle: [], resolveOnly: [], commitClean: [],
      writes: 120, overCapacity: over, heldCount: 700,
      deadlineAtRisk: [], overdue: [], heldWithoutChain: [],
    });
    const warned: string[] = [];
    warn.mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    try {
      await raiseAlerts(env, CHAIN, [], plan(true), NOW);
      expect(warned.some((w) => /700 held owners need more than 120 transactions a tick/.test(w)), 'stated, not silent').toBe(true);
      // An unconfigured ops channel records nothing; seed the open alert to see it clear.
      h.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at) VALUES (?, ?, ?)`).run(`sanctions-capacity:${CHAIN}:all`, NOW, NOW);
      await raiseAlerts(env, CHAIN, [], plan(false), NOW);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM keeper_ops_alert').get()).toEqual({ n: 0 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('raiseAlerts — alerts clear only on a fresh clean read, never on absence (#2497 r1)', () => {
  const quiet = {
    observe: [], dueObservations: [], settleObserveDue: [], settle: [], resolveOnly: [],
    deadlineAtRisk: [], overdue: [], heldWithoutChain: [],
  };
  it('keeps the alert of an owner it did not read, and clears one it read as clean', async () => {
    const h = createKeeperD1();
    const C = '0x00000000000000000000000000000000000000cc';
    const keys = [
      `sanctions-hold-overdue:${CHAIN}:${A}`, // A: read this tick, still overdue — stands
      `sanctions-hold-no-chain:${CHAIN}:${B}`, // B: NOT read this tick (a slice moved on, or its read failed) — stands
      `sanctions-observe-deadline:${CHAIN}:${C}`, // C: read this tick and clean — cleared
      `sanctions-hold-overdue:${CHAIN + 1}:${C}`, // another chain: not this pass's
    ];
    for (const k of keys) {
      h.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at) VALUES (?, ?, ?)`).run(k, NOW, NOW);
    }
    const env = { DB: createSharedD1().d1, KEEPER_DB: h.d1 } as unknown as Env;
    const plan = { ...quiet, overdue: [held({ owner: A })] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    try {
      await raiseAlerts(env, CHAIN, [held({ owner: A }), held({ owner: C })], plan, NOW);
    } finally {
      vi.unstubAllGlobals();
    }
    const left = (h.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[]).map(
      (r) => r.alert_key,
    );
    expect(left).toContain(keys[0]);
    expect(left, 'not read this tick is not evidence: the alert stands').toContain(keys[1]);
    expect(left, 'read freshly and clean: cleared').not.toContain(keys[2]);
    expect(left).toContain(keys[3]);
  });
});

describe('the loan-party screen (Codex #2489 r2)', () => {
  it('sizes a tick to cover every party within a day, inside its bounds (straddle)', () => {
    expect(screenSliceSize(0)).toBe(SCREEN_MIN_PER_TICK);
    expect(screenSliceSize(24 * SCREEN_MIN_PER_TICK), 'a day at the floor').toBe(SCREEN_MIN_PER_TICK);
    expect(screenSliceSize(24 * SCREEN_MIN_PER_TICK + 1), 'one more party lifts it').toBe(SCREEN_MIN_PER_TICK + 1);
    expect(screenSliceSize(24 * SCREEN_MAX_PER_TICK), 'a day at the ceiling').toBe(SCREEN_MAX_PER_TICK);
    expect(screenSliceSize(24 * SCREEN_MAX_PER_TICK + 1000), 'capped past it').toBe(SCREEN_MAX_PER_TICK);
  });

  it('resumes past the last party read, never past a failed read, and starts over at the end', () => {
    const s = ['0x01', '0x02', '0x03'];
    expect(nextScreenCursor('0x00', s, [true, true, true], false)).toBe('0x03');
    expect(nextScreenCursor('0x00', s, [true, false, true], false), 'stops before the failure').toBe('0x01');
    expect(nextScreenCursor('0x00', s, [false, true, true], false), 'no progress past it').toBe('0x00');
    expect(nextScreenCursor('0x00', s, [true, true, true], true), 'the last page: start over').toBe('');
    // #2497 r2 — an EXACTLY full last page (2,400 parties at 100 a tick) resets
    // on that tick, not one empty page later.
    expect(nextScreenCursor('0x00', s, [true, true, true], true), 'full and terminal: reset now').toBe('');
    expect(nextScreenCursor('0x00', s, [true, false, true], true), 'a failure on the last page still holds the cursor').toBe('0x01');
  });

  it('watches what the screen finds, and forgets an owner only on a fresh Deliver with nothing stored (#2497 r11)', async () => {
    const { listSanctionsWatch, watchSanctionsOwners, unwatchSanctionsOwners } = await import('../src/db');
    const k = createKeeperD1().d1 as KeeperD1;
    await watchSanctionsOwners(k, CHAIN, '0xAB', [A, B]);
    await watchSanctionsOwners(k, CHAIN, '0xab', [A]); // idempotent
    await watchSanctionsOwners(k, CHAIN, '0xcd', [A]); // another Diamond
    expect(await listSanctionsWatch(k, CHAIN, '0xab')).toEqual([A, B]);
    await unwatchSanctionsOwners(k, CHAIN, '0xab', [A]);
    expect(await listSanctionsWatch(k, CHAIN, '0xab')).toEqual([B]);
    expect(await listSanctionsWatch(k, CHAIN, '0xcd'), 'namespaced by Diamond').toEqual([A]);
  });

  it('reads every original and current lender and borrower once, in address order, from the cursor', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ins = h.db.prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, lender, borrower, lender_current_owner, borrower_current_owner,
         principal, collateral_amount, start_block, start_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, '0', '0', 1, 1, 1)`,
    );
    const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
    ins.run(CHAIN, 1, w(3), w(1), w(3), w(9)); // borrower position sold to 9
    ins.run(CHAIN, 2, w(1), w(2).toUpperCase().replace('0X', '0x'), w(1), w(2));
    ins.run(CHAIN + 1, 3, w(7), w(8), w(7), w(8));
    expect(await countLoanParties(h.d1 as D1Database, CHAIN)).toBe(4);
    expect(await listLoanPartiesAfter(h.d1 as D1Database, CHAIN, '', 10)).toEqual([w(1), w(2), w(3), w(9)]);
    expect(await listLoanPartiesAfter(h.d1 as D1Database, CHAIN, w(2), 2), 'after the cursor, bounded').toEqual([w(3), w(9)]);
  });

  it('also reads every INTERMEDIATE holder a position ever had (#2497 r5)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, lender, borrower, lender_current_owner, borrower_current_owner,
           principal, collateral_amount, start_block, start_at, updated_at)
         VALUES (?, 1, 0, ?, ?, ?, ?, '0', '0', 1, 1, 1)`,
      )
      .run(CHAIN, w(1), w(2), w(5), w(2)); // lender position: 1 -> 4 -> 5
    const part = h.db.prepare(`INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at) VALUES (?, 1, ?, ?, ?)`);
    part.run(CHAIN, w(1), 'lender', 1);
    part.run(CHAIN, w(4), 'lender', 2); // neither the original nor the current lender
    part.run(CHAIN, w(5), 'lender', 3);
    part.run(CHAIN + 1, w(6), 'lender', 1); // another chain
    expect(await listLoanPartiesAfter(h.d1 as D1Database, CHAIN, '', 10)).toEqual([w(1), w(2), w(4), w(5)]);
    expect(await countLoanParties(h.d1 as D1Database, CHAIN)).toBe(4);
  });
});

describe('sendOpsAlert', () => {
  afterEach(() => vi.unstubAllGlobals());
  function env(h: SqliteD1, over: Partial<Env> = {}): Env {
    return {
      DB: createSharedD1().d1,
      KEEPER_DB: h.d1,
      TG_OPS_BOT_TOKEN: 'tok-secret',
      TG_OPS_CHAT_ID: '-100',
      ...over,
    } as unknown as Env;
  }

  it('reports unconfigured and records nothing when the ops channel is unset', async () => {
    const h = createKeeperD1();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await sendOpsAlert(env(h, { TG_OPS_BOT_TOKEN: undefined }), 'k', 'x', 60, NOW)).toBe('unconfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getOpsAlert(h.d1 as KeeperD1, 'k')).toBeNull();
  });

  it('records a delivered alert and suppresses a repeat inside the interval (straddle)', async () => {
    const h = createKeeperD1();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW)).toBe('sent');
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW + 599), 'inside the interval').toBe('suppressed');
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW + 600), 'at the interval').toBe('sent');
    expect(await getOpsAlert(h.d1 as KeeperD1, 'k')).toEqual({ firstSeenAt: NOW, lastSentAt: NOW + 600 });
  });

  it('a failed post is NOT recorded, so the next tick tries again — and never logs the token', async () => {
    const h = createKeeperD1();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad tok-secret', { status: 500 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW)).toBe('failed');
    expect(await getOpsAlert(h.d1 as KeeperD1, 'k')).toBeNull();
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).not.toContain('tok-secret');
    expect(logged).toContain('<TG_OPS_BOT_TOKEN>');
    err.mockRestore();
  });
});
