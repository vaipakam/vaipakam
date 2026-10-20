/**
 * #2516 — the delivery-proof pass's operator alerts. Which refusals count as a
 * failure (never "the work is already done"), and how the two alerts are
 * raised and cleared: a revert alert per delivery, cleared once that delivery
 * finishes or its calls go through, and one "not yet whole" alert per mirror,
 * cleared only by a run that settled every open delivery. Runs on the real
 * keeper-private schema; the ops bot is unconfigured, so a raised alert is the
 * logged "NOT delivered" line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Abi } from 'viem';
import { RewardEpochFacetABI } from '@vaipakam/contracts/abis';
import { ALREADY_DONE, AWAITING_ALERT_SEC, classifyRevert, raiseDeliveryAlerts, type DeliveryAlertInput } from '../src/deliveryProof';
import type { Env } from '../src/env';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';

const ABI = RewardEpochFacetABI as Abi;
const CHAIN = 421614;
const P1 = `0x${'1'.repeat(64)}`;
const P2 = `0x${'2'.repeat(64)}`;
const NOW = 1_800_000_000;

function revert(errorName: string, args: readonly unknown[]): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: ABI,
    data: encodeErrorResult({ abi: ABI, errorName, args } as never),
    functionName: 'proveDeliveryDayChunk',
  });
}

describe('classifyRevert', () => {
  it('reads "already done" as done, by the decoded error name', () => {
    expect(classifyRevert(revert('TransportChunkAlreadyIndexed', [P1, 2n]))).toEqual({ kind: 'done' });
    expect(classifyRevert(revert('TransportBatchFullyIndexed', [P1]))).toEqual({ kind: 'done' });
    expect(classifyRevert(revert('TransportBatchAlreadyAdmitted', [P1]))).toEqual({ kind: 'done' });
    expect(ALREADY_DONE.size).toBe(3);
  });

  it('names any other revert, and never prints a raw message', () => {
    expect(classifyRevert(revert('TransportChunkProofInvalid', [P1, 1n, P2]))).toEqual({ kind: 'failed', reason: 'TransportChunkProofInvalid' });
    const leaky = new Error('request to https://rpc.example/v2/SECRETKEY failed');
    const c = classifyRevert(leaky);
    expect(c.kind).toBe('failed');
    expect(JSON.stringify(c)).not.toContain('SECRETKEY');
  });
});

describe('raiseDeliveryAlerts', () => {
  let keeper: SqliteD1;
  let env: Env;
  let warned: string[];

  beforeEach(() => {
    keeper = createKeeperD1();
    env = { DB: createSharedD1().d1, KEEPER_DB: keeper.d1 } as unknown as Env;
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const input = (over: Partial<DeliveryAlertInput> = {}): DeliveryAlertInput => ({
    failures: new Map(),
    cleared: new Set(),
    awaiting: [],
    awaitingMeasured: true,
    nowSec: NOW,
    deadline: Number.POSITIVE_INFINITY,
    ...over,
  });
  /** An alert as the ops bot would have recorded it. */
  const recorded = (key: string) =>
    keeper.db.prepare('INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)').run(key, 1, 1, CHAIN);
  const keys = () => (keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[]).map((r) => r.alert_key);

  it('names a reverting delivery and why, and clears it once the delivery goes through', async () => {
    await raiseDeliveryAlerts(env, CHAIN, input({ failures: new Map([[P1, 'proveDeliveryDayChunk: TransportChunkProofInvalid']]) }));
    expect(warned.filter((w) => w.includes(`the proof for delivery ${P1} reverts (proveDeliveryDayChunk: TransportChunkProofInvalid)`))).toHaveLength(1);

    recorded(`delivery-revert:${CHAIN}:${P1}`);
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    await raiseDeliveryAlerts(env, CHAIN, input({ cleared: new Set([P1]) }));
    expect(keys(), 'only the delivery this run disproved is cleared').toEqual([`delivery-revert:${CHAIN}:${P2}`]);
  });

  it('says how many deliveries are not whole, oldest first, with when each arrived', async () => {
    const awaiting = [
      { packetHash: P2, arrivedAt: NOW - 3600 },
      { packetHash: P1, arrivedAt: NOW - 7200 },
    ];
    await raiseDeliveryAlerts(env, CHAIN, input({ awaiting }));
    const [line] = warned.filter((w) => w.includes('reward delivery proofs'));
    expect(line).toContain(`2 deliveries are not yet whole more than ${AWAITING_ALERT_SEC / 60} min after arriving`);
    expect(line.indexOf(P1), 'oldest first').toBeLessThan(line.indexOf(P2));
    expect(line).toContain(new Date((NOW - 7200) * 1000).toISOString());
  });

  it('clears the "not whole" alert only on a run that measured every open delivery', async () => {
    recorded(`delivery-awaiting:${CHAIN}:all`);
    await raiseDeliveryAlerts(env, CHAIN, input({ awaitingMeasured: false }));
    expect(keys(), 'a partial run cannot clear it').toEqual([`delivery-awaiting:${CHAIN}:all`]);
    await raiseDeliveryAlerts(env, CHAIN, input());
    expect(keys()).toEqual([]);
  });

  it("never touches another chain's alerts", async () => {
    keeper.db
      .prepare('INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)')
      .run(`delivery-awaiting:84532:all`, 1, 1, 84532);
    await raiseDeliveryAlerts(env, CHAIN, input());
    expect(keys()).toEqual(['delivery-awaiting:84532:all']);
  });

  it('sends nothing past the run deadline', async () => {
    await raiseDeliveryAlerts(env, CHAIN, input({ failures: new Map([[P1, 'x']]), awaiting: [{ packetHash: P1, arrivedAt: 0 }], deadline: 0 }));
    expect(warned).toEqual([]);
  });
});
