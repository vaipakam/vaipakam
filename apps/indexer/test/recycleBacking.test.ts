/**
 * The retained-reserve derivation (#1525 / #1349 M5).
 *
 * `platformRetained = bucket − outstandingRecycled − keeperBudget`, floored
 * at zero — ratified in TokenomicsTechSpec and plan §M5. Both the keeper
 * term and the floor were arrived at by review rather than by design, so
 * both are pinned here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
} from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';

import type { Env } from '../src/env';
import {
  type BackingSnapshot,
  captureBackingSnapshot,
  CUSTODY_MIGRATION,
  FUNCTION_DOES_NOT_EXIST_SELECTOR,
  handleRecyclingSeries,
  isAbiShapeMismatch,
  isMissingSelectorRevert,
  retainedFrom,
  snapshotMaxAgeMs,
  storedCustodyFrom,
  storedPayloadIsComplete,
} from '../src/recycleRoutes';
import { createChainClient } from '../src/subrequestBudget';
import { createSqliteD1 } from './helpers/sqliteD1';

// The capture's ONLY network seam. Everything else — the settled-head
// resolver, the D1 upsert, the read route — runs for real against the
// migrated schema, so these cases exercise the SQL and the wire shape, not
// a stub of them.
vi.mock('../src/subrequestBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/subrequestBudget')>()),
  createChainClient: vi.fn(),
}));

const T = (n: bigint) => n * 10n ** 18n;

describe('retainedFrom', () => {
  it('nets BOTH the outstanding commitments and the keeper budget', () => {
    // The keeper term is why the two-term derivation from `getRecycleBucket`
    // alone is wrong: once the register runs, each day's margin is earmarked
    // into `recycleKeeperBudget` from INSIDE the bucket, so the bucket does
    // not move and a reserve computed without it overstates.
    expect(retainedFrom(T(100n), T(30n), T(20n))).toBe(T(50n));
  });

  it('overstates by exactly the keeper budget if that term is dropped', () => {
    // Stated as its own case because the wrong answer is plausible: it is
    // the right shape, the right magnitude, and only ever too generous.
    const withKeeper = retainedFrom(T(100n), T(30n), T(20n));
    const withoutKeeper = retainedFrom(T(100n), T(30n), 0n);
    expect(withoutKeeper - withKeeper).toBe(T(20n));
  });

  it('floors at zero rather than reporting a negative reserve', () => {
    // The subtraction genuinely goes negative in the breached state #1460
    // describes. A negative reserve on a public page reads as a display
    // bug rather than as the shortfall it is; the balance published beside
    // it is what makes that state visible instead.
    expect(retainedFrom(T(10n), T(30n), T(5n))).toBe(0n);
  });

  it('returns zero exactly at the boundary, not a rounding artefact', () => {
    expect(retainedFrom(T(50n), T(30n), T(20n))).toBe(0n);
  });

  it('is exact at wei scale — no float path', () => {
    expect(retainedFrom(10n ** 30n + 3n, 1n, 1n)).toBe(10n ** 30n + 1n);
  });
});

describe('storedPayloadIsComplete', () => {
  const good = {
    vpfiBalance: '100', bucket: '40', unearmarked: '60',
    outstandingRecycled: '10', paidOutRecycled: '2', keeperBudget: '5',
    platformRetained: '25', releasedRemitStranded: '0',
  };

  it('accepts a complete payload', () => {
    expect(storedPayloadIsComplete(good)).toBe(true);
  });

  it('accepts a PRE-#1930 payload with no recovery-reserve keys', () => {
    // Every row written before #1930 lacks these two keys. They are a
    // valid capture of everything they claimed to hold, and rejecting them
    // would blank the public backing figures until the next capture — an
    // outage caused by adding a field. This is the case that says the new
    // fields went in as optional rather than required.
    expect(storedPayloadIsComplete(good)).toBe(true);
  });

  it('accepts them when present and well-formed', () => {
    expect(
      storedPayloadIsComplete({
        ...good,
        strandedRecoveryReserved: '7',
        recoveryPositionReserved: '0',
      }),
    ).toBe(true);
  });

  it('rejects a row carrying exactly ONE of the two recovery keys', () => {
    // Not a shape this repository emits: both are written in the same object
    // literal from the same read, so one-of-two is corruption or a hand
    // repair. Accepting it would publish a partial subtrahend set through
    // the same success path as a complete one — appearing to reconcile and
    // being wrong, which is worse than visibly not reconciling.
    expect(
      storedPayloadIsComplete({ ...good, strandedRecoveryReserved: '7' }),
    ).toBe(false);
    expect(
      storedPayloadIsComplete({ ...good, recoveryPositionReserved: '7' }),
    ).toBe(false);
  });

  it('rejects a present-but-malformed recovery-reserve value', () => {
    // Optional means absent-or-valid, never absent-or-anything. A
    // truncated or non-numeric figure published as a backing subtrahend is
    // worse than a missing one, because it reconciles to a wrong total
    // instead of visibly not reconciling.
    expect(
      storedPayloadIsComplete({ ...good, strandedRecoveryReserved: '' }),
    ).toBe(false);
    expect(
      storedPayloadIsComplete({ ...good, recoveryPositionReserved: 'NaN' }),
    ).toBe(false);
    expect(
      storedPayloadIsComplete({ ...good, recoveryPositionReserved: 12 }),
    ).toBe(false);
  });

  it('rejects syntactically valid but empty JSON', () => {
    // `{}` parses fine and would previously have been spread into the
    // response with `unavailableReason: null`, so any consumer honouring
    // the all-or-nothing contract would publish an empty block believing
    // it complete. The frontend gate protects the dashboard and nothing
    // else; the contract has to hold where it is stated.
    expect(storedPayloadIsComplete({})).toBe(false);
    expect(storedPayloadIsComplete(null)).toBe(false);
    expect(storedPayloadIsComplete('nope')).toBe(false);
  });

  it('rejects a payload missing ANY single member', () => {
    for (const k of Object.keys(good)) {
      const partial: Record<string, string> = { ...good };
      delete partial[k];
      expect(storedPayloadIsComplete(partial), `missing ${k}`).toBe(false);
    }
  });

  it('rejects wrong types and non-decimal strings', () => {
    expect(storedPayloadIsComplete({ ...good, bucket: 40 })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '4,0' })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '' })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '-1' })).toBe(false);
  });
});

describe('snapshotMaxAgeMs', () => {
  const MIN = 30 * 60_000;

  it('never drops below the floor', () => {
    expect(snapshotMaxAgeMs(1, 1, 1, 1)).toBe(MIN);
  });

  it('uses the STORED rotation when the current set is transiently smaller', () => {
    // A Secrets Store blip shrinks the readable chain set. Computing from
    // it alone would expire a healthy snapshot during an unrelated
    // failure.
    const stored = snapshotMaxAgeMs(11, 5, 1, 5);
    expect(stored).toBe(11 * 5 * 2 * 60_000);
  });

  it('uses the CURRENT rotation when config change makes the next refresh slower', () => {
    // Switching legacy(1min) -> DO(5min), or adding chains, leaves old
    // rows carrying the shorter cadence until their turn comes round —
    // and their expiry would fire before that turn arrives.
    const current = snapshotMaxAgeMs(7, 1, 7, 5);
    expect(current).toBe(7 * 5 * 2 * 60_000);
    // The stored-only answer would have been well short of the real
    // 35-minute rotation.
    expect(7 * 1 * 2 * 60_000).toBeLessThan(7 * 5 * 60_000);
  });

  it('takes the larger of the two, not the newer', () => {
    // Neither input is authoritative on its own: the row knows what
    // produced it, the environment knows what will refresh it next.
    expect(snapshotMaxAgeMs(11, 5, 3, 1)).toBe(snapshotMaxAgeMs(3, 1, 11, 5));
  });
});

describe('isAbiShapeMismatch', () => {
  // A stale-lens Diamond and a flaky RPC used to produce the same log line,
  // and they need opposite operator responses — refresh the facet, versus
  // wait. These cases pin which is which (#1930 follow-up).
  it('recognises the Diamond\'s missing-selector revert', () => {
    // The case this predicate was WRITTEN for and did not cover (Codex
    // #2031 r4). A view absent from the current cut never reaches a
    // decoder: `VaipakamDiamond.fallback` reverts `FunctionDoesNotExist()`
    // when no facet owns the selector, and viem surfaces that as an
    // ordinary contract revert — so every decode-error name missed it and
    // the operator got the generic "waiting will fix it" log for the one
    // condition where waiting will not.
    expect(
      isAbiShapeMismatch({
        name: 'ContractFunctionExecutionError',
        cause: {
          name: 'ContractFunctionRevertedError',
          data: FUNCTION_DOES_NOT_EXIST_SELECTOR,
        },
      }),
    ).toBe(true);
    // Decoded form, for when the consulted ABI happens to carry the error:
    // viem then puts the DECODED result on `data` and keeps the payload on
    // `raw`. The exact payload is what decides; a name with no payload is
    // not evidence (#1566 slice 4 — same rule as the census predicate).
    expect(
      isAbiShapeMismatch({
        data: { errorName: 'FunctionDoesNotExist', args: [] },
        raw: FUNCTION_DOES_NOT_EXIST_SELECTOR,
      }),
    ).toBe(true);
    expect(isAbiShapeMismatch({ errorName: 'FunctionDoesNotExist' })).toBe(false);
    // Case-insensitive on the hex, since providers differ.
    expect(
      isAbiShapeMismatch({ data: FUNCTION_DOES_NOT_EXIST_SELECTOR.toUpperCase().replace('0X', '0x') }),
    ).toBe(true);
  });

  it('does NOT read an arbitrary revert as ABI drift', () => {
    // The other half of the rule, and the reason the match is on the exact
    // four bytes rather than on "a revert happened": a revert from a LIVE
    // facet is a different condition with a different remedy, and calling
    // it drift would send an operator to redeploy a healthy facet.
    expect(
      isAbiShapeMismatch({
        name: 'ContractFunctionExecutionError',
        cause: { name: 'ContractFunctionRevertedError', data: '0xdeadbeef' },
      }),
    ).toBe(false);
    expect(
      isAbiShapeMismatch({ errorName: 'InteractionRewardBackingShort' }),
    ).toBe(false);
  });

  it('recognises the REAL error a stale six-output lens throws', () => {
    // Built by actually decoding rather than by naming an error I assumed.
    // This predicate has now failed twice on the exact scenario it was
    // written for — first `FunctionDoesNotExist`, then this — both times
    // because the error name came from reasoning instead of from a throw.
    // A pre-#1434 lens returns SIX words; against eight outputs viem walks
    // off the cursor and throws PositionOutOfBoundsError, which is not a
    // size error: 192 bytes passes the up-front length check and only fails
    // when the reader reaches word seven.
    const eight = Array.from({ length: 8 }, (_, i) => ({
      name: `o${i}`,
      type: 'uint256' as const,
    }));
    const sixWords = `0x${'11'.padStart(64, '0').repeat(6)}` as const;
    let thrown: unknown;
    try {
      decodeAbiParameters(eight, sixWords);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isAbiShapeMismatch(thrown)).toBe(true);
  });

  it('recognises viem decode errors, including wrapped ones', () => {
    expect(isAbiShapeMismatch({ name: 'AbiDecodingDataSizeTooSmallError' })).toBe(true);
    expect(isAbiShapeMismatch({ name: 'AbiDecodingZeroDataError' })).toBe(true);
    expect(
      isAbiShapeMismatch({
        name: 'ContractFunctionExecutionError',
        cause: { name: 'AbiDecodingDataSizeTooSmallError' },
      }),
    ).toBe(true);
  });

  it('does NOT claim an ordinary RPC failure is a stale facet', () => {
    // The costly direction: a false "your facet is behind" sends an operator
    // to redeploy over what was really a bad endpoint.
    expect(isAbiShapeMismatch({ name: 'HttpRequestError' })).toBe(false);
    expect(isAbiShapeMismatch(new Error('timeout'))).toBe(false);
    expect(isAbiShapeMismatch(undefined)).toBe(false);
    expect(isAbiShapeMismatch(null)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const loop: Record<string, unknown> = { name: 'Weird' };
    loop.cause = loop;
    expect(isAbiShapeMismatch(loop)).toBe(false);
  });
});

describe('isMissingSelectorRevert', () => {
  // The capture falls back to the legacy lens on THIS condition alone, so it
  // must not inherit the shape predicate's decode-error names.
  it('matches the real viem error for a selector no facet owns', () => {
    expect(isMissingSelectorRevert(missingSelectorError())).toBe(true);
  });

  it('does NOT match a decode failure or an arbitrary revert', () => {
    expect(isMissingSelectorRevert({ name: 'PositionOutOfBoundsError' })).toBe(false);
    expect(isMissingSelectorRevert({ name: 'AbiDecodingDataSizeTooSmallError' })).toBe(false);
    expect(
      isMissingSelectorRevert({ cause: { name: 'ContractFunctionRevertedError', data: '0xdeadbeef' } }),
    ).toBe(false);
  });

  it('does NOT match the selector followed by extra data — the payload must be exact', () => {
    // FunctionDoesNotExist() takes no arguments, so its revert data is the
    // bare selector. A longer payload that merely STARTS with it is another
    // contract talking; viem still reports `signature: '0xa9ad62f8'` for it,
    // which is why the signature alone must not decide (same rule as the
    // census's isFunctionDoesNotExistRevert, #2088 r2).
    const padded = `${FUNCTION_DOES_NOT_EXIST_SELECTOR}${'00'.repeat(32)}`;
    const err = missingSelectorError(padded);
    expect((err.cause as { signature?: string }).signature).toBe(FUNCTION_DOES_NOT_EXIST_SELECTOR);
    expect(isMissingSelectorRevert(err)).toBe(false);
    expect(isMissingSelectorRevert({ data: padded })).toBe(false);
  });

  it('does NOT accept a name or signature without the exact payload', () => {
    expect(isMissingSelectorRevert({ errorName: 'FunctionDoesNotExist' })).toBe(false);
    expect(isMissingSelectorRevert({ signature: FUNCTION_DOES_NOT_EXIST_SELECTOR })).toBe(false);
    expect(
      isMissingSelectorRevert({ errorName: 'FunctionDoesNotExist', data: '0xa9ad62f800' }),
    ).toBe(false);
  });

  it('matches the bare payload on an RPC-layer error deeper in the chain', () => {
    expect(
      isMissingSelectorRevert({ name: 'Outer', cause: { data: '0xA9AD62F8' } }),
    ).toBe(true);
  });
});

describe('storedCustodyFrom', () => {
  it('reads the all-NULL row (pre-0056, or the legacy fallback) as unknown', () => {
    expect(storedCustodyFrom({})).toEqual({
      custodyActivated: null,
      holderBalanceKnown: null,
      holderBalance: null,
      holderAttributed: null,
    });
  });

  it('reads both shapes the writer produces', () => {
    expect(
      storedCustodyFrom({
        custody_activated: 1,
        holder_balance_known: 1,
        holder_balance: '10',
        holder_attributed: '9',
      }),
    ).toEqual({
      custodyActivated: true,
      holderBalanceKnown: true,
      holderBalance: '10',
      holderAttributed: '9',
    });
    expect(
      storedCustodyFrom({
        custody_activated: 0,
        holder_balance_known: 0,
        holder_balance: null,
        holder_attributed: '0',
      }),
    ).toEqual({
      custodyActivated: false,
      holderBalanceKnown: false,
      holderBalance: null,
      holderAttributed: '0',
    });
  });

  it('degrades a shape the writer never produces to UNKNOWN, never to a partial quad', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const row of [
      // A flag that is not a flag.
      { custody_activated: 2, holder_balance_known: 1, holder_balance: '1', holder_attributed: '1' },
      // Known, with no figure.
      { custody_activated: 1, holder_balance_known: 1, holder_balance: null, holder_attributed: '1' },
      // Unknown, WITH a figure — the placeholder the writer refuses to store.
      { custody_activated: 1, holder_balance_known: 0, holder_balance: '0', holder_attributed: '1' },
      // A partial quad.
      { custody_activated: 0 },
      // A non-decimal amount.
      { custody_activated: 0, holder_balance_known: 0, holder_balance: null, holder_attributed: '0x1' },
    ]) {
      expect(storedCustodyFrom(row), JSON.stringify(row)).toEqual({
        custodyActivated: null,
        holderBalanceKnown: null,
        holderBalance: null,
        holderAttributed: null,
      });
    }
    warn.mockRestore();
  });
});

// ─── Capture → store → serve, against the real migrated schema ──────────

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migrationsUpTo = (exclusivePrefix?: string) =>
  MIGRATION_FILES.filter((f) => !exclusivePrefix || f < exclusivePrefix).map((f) =>
    readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'),
  );

/**
 * The migration that adds the four custody columns, by the name the route
 * publishes in `pendingMigration` and its warnings. Derived from the route's
 * own constant, and asserted to exist in `harness`, so a renumbering that
 * misses either the file or the constant fails here instead of leaving the
 * rollout-window case excluding the wrong set (it has been renumbered once
 * already, when main took the number it was first given).
 */
const CUSTODY_MIGRATION_FILE = `${CUSTODY_MIGRATION}.sql`;
const CUSTODY_MIGRATION_PREFIX = CUSTODY_MIGRATION_FILE.slice(0, 4);

const CHAIN = 84532;
const DIAMOND = getDeployment(CHAIN)!.diamond;
const SAFE_BLOCK = 1_000n;

type V2Figures = {
  vpfiBalance: bigint;
  bucket: bigint;
  stranded: bigint;
  recovery: bigint;
  activated: boolean;
  known: boolean;
  holderBalance: bigint;
  holderAttributed: bigint;
};

const BASE: V2Figures = {
  vpfiBalance: 112n,
  bucket: 100n,
  stranded: 7n,
  recovery: 5n,
  activated: false,
  known: false,
  holderBalance: 0n,
  holderAttributed: 0n,
};

/** The real error viem raises when the Diamond's fallback reverts
 *  `FunctionDoesNotExist()` for a selector no facet owns. */
function missingSelectorError(data: string = FUNCTION_DOES_NOT_EXIST_SELECTOR) {
  const abi = [
    { type: 'function', name: 'getRecycleBackingSnapshotV2', inputs: [], outputs: [], stateMutability: 'view' },
  ] as const;
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi,
      data: data as `0x${string}`,
      functionName: 'getRecycleBackingSnapshotV2',
    }),
    {
      abi,
      functionName: 'getRecycleBackingSnapshotV2',
      args: [],
      contractAddress: DIAMOND as `0x${string}`,
    },
  );
}

/**
 * A chain client answering at one settled block. `v2` is either the twelve
 * figures or the error the V2 read rejects with; the legacy lens answers
 * with the same first eight, so a fallback is distinguishable only by the
 * custody columns it leaves empty — which is the property under test.
 */
function fakeClient(v2: V2Figures | Error, block = SAFE_BLOCK) {
  const calls: string[] = [];
  const f = v2 instanceof Error ? BASE : v2;
  const legacy8 = [f.vpfiBalance, f.bucket, 60n, 10n, 2n, 5n, f.stranded, f.recovery] as const;
  const client = {
    getChainId: async () => CHAIN,
    getBlock: async () => ({ number: block, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => block + 64n,
    readContract: async (args: { functionName: string; blockNumber: bigint }) => {
      calls.push(`${args.functionName}@${args.blockNumber}`);
      switch (args.functionName) {
        case 'getRecycleBackingSnapshotV2':
          if (v2 instanceof Error) throw v2;
          return [...legacy8, v2.activated, v2.known, v2.holderBalance, v2.holderAttributed];
        case 'getRecycleBackingSnapshot':
          return legacy8;
        case 'getRecycleCompositionPosition':
          return [0n, 3n, false, false];
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
  };
  return { client, calls };
}

function harness(opts: { preCustodyColumns?: boolean } = {}) {
  // Fails loudly if the custody migration was renamed without updating
  // CUSTODY_MIGRATION — otherwise the rollout case would silently run
  // against the full schema and prove nothing about the fallback.
  expect(MIGRATION_FILES).toContain(CUSTODY_MIGRATION_FILE);
  const h = createSqliteD1(
    migrationsUpTo(opts.preCustodyColumns ? CUSTODY_MIGRATION_PREFIX : undefined),
  );
  const env = {
    DB: h.d1,
    RPC_BASE_SEPOLIA: 'https://rpc.invalid',
    doIngestEnabled: false,
  } as unknown as Env;
  return { h, env };
}

async function capture(env: Env, v2: V2Figures | Error, block = SAFE_BLOCK) {
  const fake = fakeClient(v2, block);
  vi.mocked(createChainClient).mockReturnValue(fake.client as never);
  await captureBackingSnapshot(env, CHAIN, 1);
  return fake.calls;
}

async function served(env: Env): Promise<BackingSnapshot> {
  const res = await handleRecyclingSeries(
    new Request(`https://indexer.test/metrics/recycling?chainId=${CHAIN}`),
    env,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { backing: BackingSnapshot }).backing;
}

function storedCustody(h: ReturnType<typeof harness>['h']) {
  return h.db
    .prepare(
      `SELECT custody_activated, holder_balance_known, holder_balance,
              holder_attributed, block_number
         FROM recycle_backing_snapshot WHERE chain_id = ?`,
    )
    .get(CHAIN);
}

describe('backing capture + serve — custody state and the shared verdict', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ACTIVATED, holder covers its rows: backed on the holder relation', async () => {
    const { env } = harness();
    // Bucket far above the Diamond's balance — the pre-activation relation
    // would call this healthy chain short.
    const calls = await capture(env, {
      ...BASE,
      vpfiBalance: 7n,
      bucket: 1_000n,
      stranded: 7n,
      recovery: 300n,
      activated: true,
      known: true,
      holderBalance: 1_300n,
      holderAttributed: 1_300n,
    });
    // V2 was enough; the legacy lens was not consulted. Both reads at the
    // SAME settled block.
    expect(calls).toEqual(
      expect.arrayContaining([
        `getRecycleBackingSnapshotV2@${SAFE_BLOCK}`,
        `getRecycleCompositionPosition@${SAFE_BLOCK}`,
      ]),
    );
    expect(calls.some((c) => c.startsWith('getRecycleBackingSnapshot@'))).toBe(false);

    const b = await served(env);
    expect(b.unavailableReason).toBeNull();
    expect(b).toMatchObject({
      vpfiBalance: '7',
      bucket: '1000',
      strandedRecoveryReserved: '7',
      recoveryPositionReserved: '300',
      custodyActivated: true,
      holderBalanceKnown: true,
      holderBalance: '1300',
      holderAttributed: '1300',
      blockNumber: SAFE_BLOCK.toString(),
    });
    expect(b.backed).toEqual({
      determinable: true,
      relation: 'holder',
      ok: true,
      diamondShortfall: null,
      holderShortfall: null,
      reason: null,
    });
  });

  it('ACTIVATED, holder short: quantifies the holder shortfall', async () => {
    const { env } = harness();
    await capture(env, {
      ...BASE,
      vpfiBalance: 7n,
      stranded: 7n,
      activated: true,
      known: true,
      holderBalance: 1_299n,
      holderAttributed: 1_300n,
    });
    expect((await served(env)).backed).toEqual({
      determinable: true,
      relation: 'holder',
      ok: false,
      diamondShortfall: null,
      holderShortfall: '1',
      reason: null,
    });
  });

  it('ACTIVATED, Diamond-side reservation spent: quantifies the Diamond shortfall', async () => {
    const { env } = harness();
    await capture(env, {
      ...BASE,
      vpfiBalance: 6n,
      stranded: 7n,
      activated: true,
      known: true,
      holderBalance: 50n,
      holderAttributed: 50n,
    });
    expect((await served(env)).backed).toMatchObject({
      relation: 'holder',
      ok: false,
      diamondShortfall: '1',
      holderShortfall: null,
    });
  });

  it('ACTIVATED, holder unreadable: stores NULL (not the placeholder) and withholds the verdict', async () => {
    const { h, env } = harness();
    await capture(env, {
      ...BASE,
      activated: true,
      known: false,
      holderBalance: 0n, // the view's placeholder
      holderAttributed: 40n,
    });
    expect(storedCustody(h)).toMatchObject({
      custody_activated: 1,
      holder_balance_known: 0,
      holder_balance: null,
      holder_attributed: '40',
    });
    const b = await served(env);
    expect(b.holderBalanceKnown).toBe(false);
    expect(b.holderBalance).toBeNull();
    expect(b.backed).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'holder-balance-unknown',
    });
  });

  it('ACTIVATED, holder unreadable and Diamond reservation spent: still NOT determinable', async () => {
    const { env } = harness();
    await capture(env, {
      ...BASE,
      vpfiBalance: 6n,
      stranded: 7n,
      activated: true,
      known: false,
      holderBalance: 0n, // the view's placeholder
      holderAttributed: 40n,
    });
    const b = await served(env);
    expect(b.holderBalance).toBeNull();
    // The readable Diamond leg fails, but the relation needs BOTH legs
    // read (API contract + TokenomicsTechSpec): a one-leg shortfall is not
    // the relation's answer. The operands stay served beside the refusal.
    expect(b.vpfiBalance).toBe('6');
    expect(b.strandedRecoveryReserved).toBe('7');
    expect(b.backed).toEqual({
      determinable: false,
      relation: 'holder',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'holder-balance-unknown',
    });
  });

  it('NOT activated: the Diamond relation, with BOTH recovery subtrahends', async () => {
    const { env } = harness();
    // Exactly bucket + stranded + recovery: backed.
    await capture(env, { ...BASE, vpfiBalance: 112n });
    expect((await served(env)).backed).toEqual({
      determinable: true,
      relation: 'diamond',
      ok: true,
      diamondShortfall: null,
      holderShortfall: null,
      reason: null,
    });
    // One wei below: short by one — the reservations are terms, not a
    // footnote (a bucket-only comparison would still say backed).
    await capture(env, { ...BASE, vpfiBalance: 111n }, SAFE_BLOCK + 1n);
    const b = await served(env);
    expect(b.custodyActivated).toBe(false);
    expect(b.backed).toMatchObject({ relation: 'diamond', ok: false, diamondShortfall: '1' });
  });

  it('a reading lacking a subtrahend is served but not judged (subtrahend-unknown)', async () => {
    const { h, env } = harness();
    // A pre-#1930 payload (no recovery keys) beside a known custody state:
    // the relation is chosen and cannot be evaluated.
    const now = new Date().toISOString();
    h.db
      .prepare(
        `INSERT INTO recycle_backing_snapshot
           (chain_id, payload, diamond, observed_at, block_time, block_number,
            chain_count, tick_minutes, custody_activated, holder_balance_known,
            holder_balance, holder_attributed)
         VALUES (?, ?, ?, ?, ?, '900', 3, 1, 0, 0, NULL, '0')`,
      )
      .run(
        CHAIN,
        JSON.stringify({
          vpfiBalance: '500', bucket: '100', unearmarked: '400',
          outstandingRecycled: '0', paidOutRecycled: '0', keeperBudget: '0',
          platformRetained: '100', releasedRemitStranded: '0',
        }),
        DIAMOND,
        now,
        now,
      );
    const b = await served(env);
    expect(b.unavailableReason).toBeNull();
    expect(b.vpfiBalance).toBe('500');
    expect(b.strandedRecoveryReserved).toBeNull();
    expect(b.backed).toEqual({
      determinable: false,
      relation: 'diamond',
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'subtrahend-unknown',
    });
  });

  it('an OLD row (custody columns NULL) keeps its figures and reports custody-state-unknown', async () => {
    const { h, env } = harness();
    const now = new Date().toISOString();
    // Written the way every pre-0056 capture wrote it.
    h.db
      .prepare(
        `INSERT INTO recycle_backing_snapshot
           (chain_id, payload, diamond, observed_at, block_time, block_number,
            chain_count, tick_minutes)
         VALUES (?, ?, ?, ?, ?, '900', 3, 1)`,
      )
      .run(
        CHAIN,
        JSON.stringify({
          vpfiBalance: '10000', bucket: '100', unearmarked: '9888',
          outstandingRecycled: '0', paidOutRecycled: '0', keeperBudget: '0',
          platformRetained: '100', releasedRemitStranded: '0',
          strandedRecoveryReserved: '7', recoveryPositionReserved: '5',
        }),
        DIAMOND,
        now,
        now,
      );
    const b = await served(env);
    // Not withdrawn for lacking a newer field...
    expect(b.unavailableReason).toBeNull();
    expect(b.vpfiBalance).toBe('10000');
    // ...and not judged by an assumed relation, though the Diamond one
    // would pass comfortably.
    expect(b).toMatchObject({
      custodyActivated: null,
      holderBalanceKnown: null,
      holderBalance: null,
      holderAttributed: null,
    });
    expect(b.backed).toEqual({
      determinable: false,
      relation: null,
      ok: null,
      diamondShortfall: null,
      holderShortfall: null,
      reason: 'custody-state-unknown',
    });
  });

  it('V2 MISSING from the cut: legacy eight at the same block, custody NULL, never assumed inactive', async () => {
    const { h, env } = harness();
    // A prior V2 reading that WAS activated...
    await capture(env, {
      ...BASE,
      activated: true,
      known: true,
      holderBalance: 9n,
      holderAttributed: 9n,
    });
    expect(storedCustody(h)).toMatchObject({ custody_activated: 1 });
    // ...then a newer capture on a Diamond whose cut dropped V2.
    const calls = await capture(env, missingSelectorError(), SAFE_BLOCK + 1n);
    expect(calls).toEqual(
      expect.arrayContaining([
        `getRecycleBackingSnapshotV2@${SAFE_BLOCK + 1n}`,
        `getRecycleBackingSnapshot@${SAFE_BLOCK + 1n}`,
      ]),
    );
    // The newer, unknown reading does not inherit the older custody state.
    expect(storedCustody(h)).toEqual({
      custody_activated: null,
      holder_balance_known: null,
      holder_balance: null,
      holder_attributed: null,
      block_number: (SAFE_BLOCK + 1n).toString(),
    });
    const b = await served(env);
    expect(b.unavailableReason).toBeNull();
    expect(b).toMatchObject({
      vpfiBalance: '112',
      bucket: '100',
      strandedRecoveryReserved: '7',
      recoveryPositionReserved: '5',
      custodyActivated: null,
    });
    expect(b.backed).toMatchObject({
      determinable: false,
      relation: null,
      reason: 'custody-state-unknown',
    });
  });

  it('any OTHER V2 failure fails the capture — no fallback, no row', async () => {
    const { h, env } = harness();
    const revert = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: [],
        data: '0xdeadbeef',
        functionName: 'getRecycleBackingSnapshotV2',
      }),
      {
        abi: [],
        functionName: 'getRecycleBackingSnapshotV2',
        args: [],
        contractAddress: DIAMOND as `0x${string}`,
      },
    );
    for (const err of [revert, new Error('fetch failed')]) {
      const fake = fakeClient(err);
      vi.mocked(createChainClient).mockReturnValue(fake.client as never);
      await expect(captureBackingSnapshot(env, CHAIN, 1)).rejects.toBe(err);
      expect(fake.calls.some((c) => c.startsWith('getRecycleBackingSnapshot@'))).toBe(false);
    }
    expect(storedCustody(h)).toBeUndefined();
    expect((await served(env)).backed).toBeNull();
  });

  it('an unavailable block carries backed: null and the four fields null', async () => {
    const { env } = harness();
    const b = await served(env);
    expect(b.unavailableReason).toBe('not-captured-yet');
    expect(b).toMatchObject({
      custodyActivated: null,
      holderBalanceKnown: null,
      holderBalance: null,
      holderAttributed: null,
      backed: null,
    });
  });

  it('ROLLOUT WINDOW (0056 not applied): captures and serves with custody unknown', async () => {
    const { env } = harness({ preCustodyColumns: true });
    await capture(env, {
      ...BASE,
      activated: true,
      known: true,
      holderBalance: 9n,
      holderAttributed: 9n,
    });
    const b = await served(env);
    // The block stays up — the figures are a true reading — and the verdict
    // is withheld rather than decided on custody the table cannot record.
    expect(b.unavailableReason).toBeNull();
    expect(b.vpfiBalance).toBe('112');
    expect(b.custodyActivated).toBeNull();
    expect(b.backed).toMatchObject({ determinable: false, reason: 'custody-state-unknown' });
    // ...and NOT silently: the response names the missing migration, which is
    // what separates this from an old row's ordinary unknown, and the capture
    // logged it by name. Without both, a skipped `d1 migrations apply` would
    // keep every chain's verdict undetermined with nothing saying why.
    expect(b.pendingMigration).toBe(CUSTODY_MIGRATION);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes(CUSTODY_MIGRATION) && w.includes('capture wrote'))).toBe(true);
  });

  it('a database WITH the custody columns names no pending migration', async () => {
    // The straddle partner of the case above: same capture, migrated schema.
    const { env } = harness();
    await capture(env, {
      ...BASE,
      activated: true,
      known: true,
      holderBalance: 9n,
      holderAttributed: 9n,
    });
    const b = await served(env);
    expect(b.custodyActivated).toBe(true);
    expect(b.pendingMigration).toBeNull();
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes(CUSTODY_MIGRATION))).toBe(false);
  });

  it('an unavailable block on a pre-migration database still names the pending migration', async () => {
    // Nothing captured yet, columns missing: the block is withheld for its own
    // reason, and the database fact rides along rather than waiting for a row.
    const { env } = harness({ preCustodyColumns: true });
    const b = await served(env);
    expect(b.unavailableReason).toBe('not-captured-yet');
    expect(b.pendingMigration).toBe(CUSTODY_MIGRATION);
  });
});
