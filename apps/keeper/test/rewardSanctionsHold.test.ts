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
  CLEARED_CANDIDATE_SEC,
  DECISION_DELIVER,
  DECISION_CONFIRMED,
  DECISION_HOLD,
  OBSERVE_AFTER_SEC,
  PASS_CADENCE_SEC,
  candidateOwners,
  planSanctionsHold,
  raiseAlerts,
  type OwnerSanctionsStatus,
} from '../src/rewardSanctionsHold';
import {
  getOpsAlert,
  listSanctionsEvidenceEvents,
  listStagingRecordKeysForUser,
  listStagingRecordOwners,
  type SanctionsEvidenceRow,
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
const NOW = 1_800_000_000;
const DAY = 86_400;

function row(who: string, kind: SanctionsEvidenceRow['kind'], block: number, at: number): SanctionsEvidenceRow {
  return { who, kind, block_number: block, log_index: 0, block_at: at };
}

function held(over: Partial<OwnerSanctionsStatus> = {}): OwnerSanctionsStatus {
  const lastSeenAt = NOW - 3600;
  return {
    owner: A,
    decision: DECISION_HOLD,
    flaggedAt: NOW - DAY,
    lastSeenAt,
    forfeitableAt: NOW - DAY + 3 * DAY,
    observeBy: lastSeenAt + DAY,
    ...over,
  };
}

describe('candidateOwners', () => {
  it('takes every wallet whose LATEST evidence starts a chain, in event order', () => {
    const rows = [
      row(A, 'RewardSanctionsEvidenceRecorded', 10, NOW - 9 * DAY),
      row(A, 'RewardSanctionsEvidenceCleared', 11, NOW - 200 * DAY),
      row(A, 'RewardSanctionsEvidenceRecorded', 12, NOW - 200 * DAY), // a later chain: live again
    ];
    expect(candidateOwners(rows, NOW)).toEqual([A]);
  });

  it('keeps a cleared wallet exactly CLEARED_CANDIDATE_SEC, then drops it (straddle)', () => {
    const at = (age: number) => [
      row(B, 'RewardSanctionsEvidenceRecorded', 1, NOW - age - DAY),
      row(B, 'RewardSanctionsEvidenceCleared', 2, NOW - age),
    ];
    expect(candidateOwners(at(CLEARED_CANDIDATE_SEC), NOW), 'at the bound: still owed a resolution').toEqual([B]);
    expect(candidateOwners(at(CLEARED_CANDIDATE_SEC + 1), NOW), 'one second past it').toEqual([]);
  });

  it('a clear AFTER a start drops the live chain to the cleared rule', () => {
    const rows = [
      row(A, 'RewardSanctionsEvidenceRecorded', 1, NOW - 400 * DAY),
      row(A, 'RewardSanctionsEvidenceCleared', 2, NOW - 400 * DAY),
    ];
    expect(candidateOwners(rows, NOW)).toEqual([]);
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

  it('lists sanctions evidence oldest first, lowercased, and nothing else', async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    seed('RewardSanctionsEvidenceCleared', 7, { who: '0x00000000000000000000000000000000000000AA' });
    seed('RewardSanctionsEvidenceRecorded', 5, { who: '0x00000000000000000000000000000000000000AA' });
    seed('StagingRecordOpened', 6, { key: `0x${'1'.repeat(64)}`, user: A });
    const rows = await listSanctionsEvidenceEvents(h.d1 as D1Database, CHAIN);
    expect(rows.map((r) => [r.who, r.kind, r.block_number])).toEqual([
      [A, 'RewardSanctionsEvidenceRecorded', 5],
      [A, 'RewardSanctionsEvidenceCleared', 7],
    ]);
    expect(await listSanctionsEvidenceEvents(h.d1 as D1Database, CHAIN + 1), 'another chain').toEqual([]);
  });

  it("lists one user's staging-record keys, case-insensitively, newest first", async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    const k1 = `0x${'1'.repeat(64)}`;
    const k2 = `0x${'2'.repeat(64)}`;
    seed('StagingRecordOpened', 3, { key: k1, user: '0x00000000000000000000000000000000000000AA' });
    seed('StagingRecordOpened', 4, { key: k2, user: A });
    seed('StagingRecordOpened', 5, { key: `0x${'3'.repeat(64)}`, user: B });
    expect(await listStagingRecordKeysForUser(h.d1 as D1Database, CHAIN, A)).toEqual([k2, k1]);
  });

  it('lists staging-record owners once each, lowercased, newest first, inside the lookback (straddle)', async () => {
    h = createSqliteD1(ALL_MIGRATIONS);
    const C = '0x00000000000000000000000000000000000000cc';
    const k = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    seed('StagingRecordOpened', 3, { key: k(1), user: '0x00000000000000000000000000000000000000AA' }, NOW - 100);
    seed('StagingRecordOpened', 9, { key: k(2), user: B }, NOW - 100); // B newest
    seed('StagingRecordOpened', 4, { key: k(3), user: A }, NOW - 100); // A again
    seed('StagingRecordOpened', 2, { key: k(4), user: C }, NOW - 101); // one second outside
    seed('RewardSanctionsEvidenceRecorded', 8, { who: C }, NOW); // not a staging record
    const since = NOW - 100;
    // B's newest record is newer than A's newest: B first, though A sorts first by address.
    expect(await listStagingRecordOwners(h.d1 as D1Database, CHAIN, since)).toEqual([B, A]);
    expect(await listStagingRecordOwners(h.d1 as D1Database, CHAIN, since - 1), 'one second wider').toEqual([B, A, C]);
    expect(await listStagingRecordOwners(h.d1 as D1Database, CHAIN, since, 1), 'the bound keeps the newest').toEqual([B]);
    expect(await listStagingRecordOwners(h.d1 as D1Database, CHAIN + 1, 0), 'another chain').toEqual([]);
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
      observe: [], settleObserveDue: [], settle: [], resolveOnly: [],
      deadlineAtRisk: [], overdue: [], heldWithoutChain: [],
    };
    await raiseAlerts({ DB: createSharedD1().d1, KEEPER_DB: h.d1 } as unknown as Env, CHAIN, [held({ owner: A }), held({ owner: B })], quiet, NOW);
    expect(prepared.filter((s) => s.startsWith('DELETE')), 'one clear: the alert that was open').toHaveLength(1);
    const left = h.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[];
    expect(left.map((r) => r.alert_key), "another chain's alert is not this pass's to clear").toEqual([otherChain]);
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
