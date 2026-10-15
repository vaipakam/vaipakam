/**
 * The internal-match liquidation of a loan no venue quotes (#2501).
 *
 * The send is `triggerLiquidation(loanId, [])`, so the tests are about when
 * it may go out: only on a preview that shows the match for THIS loan, and
 * never while an earlier keeper send is unmined. Each refusal asserts that
 * nothing was written.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { RiskFacetABI } from '@vaipakam/contracts/abis';
import { INTERNAL_MATCH_EXECUTED_TOPIC } from '@vaipakam/lib/routeBuilder';
import { attemptMatchLiquidation, tryMatchLiquidation } from '../src/matchLiquidation';
import { resetSubmissionQueues } from '../src/submissionQueue';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const DIAMOND = A(0xd1);
const KEEPER = A(0xee);
const LOAN_ID = 21n;
const topicOf = (id: bigint) => `0x${id.toString(16).padStart(64, '0')}`;
const SIGNED: Hex = '0x02f86b0182';

interface Scene {
  /** What the simulation reports: a match naming `matchLeg` as leg A, a
   *  success with no match, a revert, or a node that cannot simulate. */
  ending?: 'match' | 'none' | 'revert' | 'unsupported' | 'no-logs';
  matchLeg?: bigint;
  /** The match was emitted by a contract other than the Diamond. */
  foreignEmitter?: boolean;
  unmined?: number;
  broadcast?: 'lost';
}

function harness(scene: Scene) {
  resetSubmissionQueues();
  const writes: { functionName: string; args: readonly unknown[] }[] = [];
  const previews: { blockNumber?: bigint; calls: { data: Hex }[] }[] = [];
  const client = {
    getBlockNumber: async () => 100n,
    getTransactionCount: async (args: { blockTag: string }) =>
      args.blockTag === 'pending' ? 7 + (scene.unmined ?? 0) : 7,
    simulateCalls: async (args: { blockNumber?: bigint; calls: { data: Hex }[] }) => {
      previews.push(args);
      const ending = scene.ending ?? 'match';
      if (ending === 'unsupported') throw new Error('eth_simulateV1 unsupported');
      if (ending === 'revert') return { results: [{ status: 'failure', logs: [] }] };
      if (ending === 'no-logs') return { results: [{ status: 'success' }] };
      const logs =
        ending === 'match'
          ? [
              {
                address: scene.foreignEmitter ? A(0xbad) : DIAMOND,
                topics: [INTERNAL_MATCH_EXECUTED_TOPIC, topicOf(scene.matchLeg ?? LOAN_ID), topicOf(99n)],
              },
            ]
          : [];
      return { results: [{ status: 'success', logs }] };
    },
  } as unknown as PublicClient;
  const wallet = {
    account: { address: KEEPER },
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected request ${method}`);
    },
    prepareTransactionRequest: async (args: { data: Hex; to: Address }) => {
      expect(args.to).toBe(DIAMOND);
      writes.push(decodeFunctionData({ abi: RiskFacetABI as Abi, data: args.data }) as never);
      return args;
    },
    signTransaction: async () => SIGNED,
    sendRawTransaction: async () => {
      if (scene.broadcast === 'lost') throw new Error('request timed out');
      return keccak256(SIGNED);
    },
  } as unknown as WalletClient;
  const deps = { client, wallet, diamond: DIAMOND, chainId: 84532 };
  return { deps, writes, previews };
}

describe('attemptMatchLiquidation', () => {
  it('sends an empty-list triggerLiquidation when the preview shows the match', async () => {
    const h = harness({});
    const out = await attemptMatchLiquidation(h.deps, LOAN_ID);
    expect(out).toEqual({ kind: 'submitted', tx: keccak256(SIGNED) });
    expect(h.writes).toEqual([{ functionName: 'triggerLiquidation', args: [LOAN_ID, []] }]);
    // The preview simulated that same call, at a pinned block.
    expect(h.previews).toHaveLength(1);
    expect(h.previews[0].blockNumber).toBe(100n);
    const simulated = decodeFunctionData({ abi: RiskFacetABI as Abi, data: h.previews[0].calls[0].data });
    expect(simulated).toEqual({ functionName: 'triggerLiquidation', args: [LOAN_ID, []] });
  });

  it('sends nothing unless the preview affirmatively shows a match', async () => {
    for (const ending of ['none', 'revert', 'unsupported', 'no-logs'] as const) {
      const h = harness({ ending });
      const out = await attemptMatchLiquidation(h.deps, LOAN_ID);
      expect(out.kind).toBe('skipped');
      expect(h.writes).toHaveLength(0);
    }
  });

  it('reads the preview outcome into the skip reason', async () => {
    expect(await attemptMatchLiquidation(harness({ ending: 'none' }).deps, LOAN_ID)).toEqual({
      kind: 'skipped',
      reason: 'preview=no-match',
    });
    expect(await attemptMatchLiquidation(harness({ ending: 'revert' }).deps, LOAN_ID)).toEqual({
      kind: 'skipped',
      reason: 'preview=unknown',
    });
  });

  it('does not take a match for another loan, or from another contract, as this one', async () => {
    for (const scene of [{ matchLeg: 22n }, { foreignEmitter: true }]) {
      const h = harness(scene);
      expect(await attemptMatchLiquidation(h.deps, LOAN_ID)).toEqual({
        kind: 'skipped',
        reason: 'preview=no-match',
      });
      expect(h.writes).toHaveLength(0);
    }
  });

  it('holds while an earlier keeper send is unmined', async () => {
    const h = harness({ unmined: 1 });
    expect(await attemptMatchLiquidation(h.deps, LOAN_ID)).toEqual({
      kind: 'skipped',
      reason: 'keeper-tx-pending (1 unmined)',
    });
    expect(h.writes).toHaveLength(0);
  });

  it('reports a broadcast whose answer was lost as unconfirmed, with its hash', async () => {
    const h = harness({ broadcast: 'lost' });
    const out = await attemptMatchLiquidation(h.deps, LOAN_ID);
    expect(out.kind).toBe('unconfirmed');
    expect(out.kind !== 'skipped' && out.tx).toBe(keccak256(SIGNED));
  });
});

describe('tryMatchLiquidation', () => {
  const CHAIN = { id: 84532, name: 'base-sepolia' };
  const ctxOf = (h: ReturnType<typeof harness>) =>
    ({ client: h.deps.client, wallet: h.deps.wallet, diamond: DIAMOND, chainId: 84532 }) as never;

  it('is true for a sent or possibly-sent liquidation and false otherwise', async () => {
    const sent = harness({});
    expect(await tryMatchLiquidation(CHAIN, ctxOf(sent), sent.deps.client, LOAN_ID)).toBe(true);
    const lost = harness({ broadcast: 'lost' });
    expect(await tryMatchLiquidation(CHAIN, ctxOf(lost), lost.deps.client, LOAN_ID)).toBe(true);
    const none = harness({ ending: 'none' });
    expect(await tryMatchLiquidation(CHAIN, ctxOf(none), none.deps.client, LOAN_ID)).toBe(false);
    expect(none.writes).toHaveLength(0);
  });
});
