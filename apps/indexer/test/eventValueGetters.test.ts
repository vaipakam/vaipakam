/**
 * The end-of-block read of the values the count-only settings events stand
 * for (#3921, Codex #4016 r4): a getter answers its value, a chain refusal
 * is recorded as not answered, and a node failure throws so the block is
 * retried.
 */
import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, HttpRequestError, type PublicClient } from 'viem';
import { readEventValueGetters } from '../src/configSnapshot';
import { VALUE_NOT_CARRIED_GETTER_NAMES } from '../src/stateHistory';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;

function client(answer: (name: string) => { status: string; result?: unknown; error?: unknown }) {
  return {
    multicall: async (args: { contracts: { functionName: string }[]; blockNumber: bigint }) => {
      expect(args.blockNumber).toBe(77n);
      return args.contracts.map((c) => answer(c.functionName));
    },
  } as unknown as PublicClient;
}

describe('readEventValueGetters', () => {
  it('reads every getter once, at the block, and records a refusal as not answered', async () => {
    const out = await readEventValueGetters({
      client: client((name) =>
        name === 'getPaaAssets'
          ? {
              status: 'failure',
              error: new ContractFunctionRevertedError({ abi: [], functionName: name, message: 'FunctionDoesNotExist()' }),
            }
          : { status: 'success', result: [name] },
      ),
      diamond: DIAMOND,
      blockNumber: 77n,
    });
    expect(Object.keys(out).sort()).toEqual([...VALUE_NOT_CARRIED_GETTER_NAMES].sort());
    expect(out.getSwapAdapters).toEqual({ value: ['getSwapAdapters'] });
    expect('notAnswered' in out.getPaaAssets!).toBe(true);
  });

  it('throws when the node, not the chain, failed a getter', async () => {
    await expect(
      readEventValueGetters({
        client: client(() => ({ status: 'failure', error: new HttpRequestError({ url: 'https://node.invalid' }) })),
        diamond: DIAMOND,
        blockNumber: 77n,
      }),
    ).rejects.toThrow(/failed at the node/);
  });
});
