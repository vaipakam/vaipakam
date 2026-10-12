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
  DECISION_FORFEIT,
  DECISION_HOLD,
  OBSERVE_AFTER_SEC,
  PASS_CADENCE_SEC,
  candidateOwners,
  planSanctionsHold,
  type OwnerSanctionsStatus,
} from '../src/rewardSanctionsHold';
import {
  getOpsAlert,
  listSanctionsEvidenceEvents,
  listStagingRecordKeysForUser,
  type SanctionsEvidenceRow,
} from '../src/db';
import { sendOpsAlert } from '../src/opsAlert';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

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

  it('routes Forfeit to the sweep and Deliver to the resolution pages only', () => {
    const p = planSanctionsHold(
      [held({ owner: A, decision: DECISION_FORFEIT }), held({ owner: B, decision: DECISION_DELIVER })],
      NOW,
    );
    expect(p.forfeit).toEqual([A]);
    expect(p.resolveOnly).toEqual([B]);
    expect(p.observe).toEqual([]);
    expect(p.overdue).toEqual([]);
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
});

describe('sendOpsAlert', () => {
  afterEach(() => vi.unstubAllGlobals());
  function env(h: SqliteD1, over: Partial<Env> = {}): Env {
    return { DB: h.d1, TG_OPS_BOT_TOKEN: 'tok-secret', TG_OPS_CHAT_ID: '-100', ...over } as unknown as Env;
  }

  it('reports unconfigured and records nothing when the ops channel is unset', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await sendOpsAlert(env(h, { TG_OPS_BOT_TOKEN: undefined }), 'k', 'x', 60, NOW)).toBe('unconfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getOpsAlert(h.d1 as D1Database, 'k')).toBeNull();
  });

  it('records a delivered alert and suppresses a repeat inside the interval (straddle)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW)).toBe('sent');
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW + 599), 'inside the interval').toBe('suppressed');
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW + 600), 'at the interval').toBe('sent');
    expect(await getOpsAlert(h.d1 as D1Database, 'k')).toEqual({ firstSeenAt: NOW, lastSentAt: NOW + 600 });
  });

  it('a failed post is NOT recorded, so the next tick tries again — and never logs the token', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad tok-secret', { status: 500 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendOpsAlert(env(h), 'k', 'x', 600, NOW)).toBe('failed');
    expect(await getOpsAlert(h.d1 as D1Database, 'k')).toBeNull();
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).not.toContain('tok-secret');
    expect(logged).toContain('<TG_OPS_BOT_TOKEN>');
    err.mockRestore();
  });
});
