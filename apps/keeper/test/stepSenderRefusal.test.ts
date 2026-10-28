/**
 * #2961 — the step sender keeps the contract's refusal of the last call, by
 * its decoded name and arguments, so a step can act on what the refusal
 * carries (such as when a wait ends), and clears it on the next call.
 */
import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Abi } from 'viem';
import { ABI } from '../src/rewardDeliveryConflict';
import { StepSender } from '../src/stepSender';
import type { KeeperContext } from '../src/keeper';

const KEEPER = '0x00000000000000000000000000000000000000ee';

function sender(simulate: () => Promise<{ result: unknown }>) {
  const client = { simulateContract: simulate, getTransactionCount: async () => 3 };
  const ctx = { client, diamond: '0x00000000000000000000000000000000000000d1', chainId: 1, wallet: { account: { address: KEEPER } } } as unknown as KeeperContext;
  return new StepSender(
    { pass: 'test', abi: ABI, maxSends: 4, receiptTimeoutMs: 1000, races: new Set(), pausedRefusal: 'EnforcedPause', unrecorded: new Set(['DayDeliverySkipTooEarly']), describe: String, spends: 'the gas' },
    { context: () => ctx, sendDeadline: Number.POSITIVE_INFINITY },
  );
}

describe('StepSender.refusal', () => {
  it('carries the decoded name and arguments of a refused simulation, and clears on the next call', async () => {
    let refuse = true;
    const s = sender(async () => {
      if (!refuse) return { result: 0n };
      throw new ContractFunctionRevertedError({
        abi: ABI as Abi,
        data: encodeErrorResult({ abi: ABI, errorName: 'DayDeliverySkipTooEarly', args: [12n, 1_800_086_400n] } as never),
        functionName: 'skipConflictedDay',
      });
    });
    expect(await s.call('skip', '12', 'skipConflictedDay', [12n])).toBe('DayDeliverySkipTooEarly');
    expect(s.refusal).toEqual({ name: 'DayDeliverySkipTooEarly', args: [12n, 1_800_086_400n] });
    expect(s.refused.size, 'an unrecorded refusal is not a fault').toBe(0);
    refuse = false;
    expect(await s.call('recycle', '12', 'recycleSkippedDayValue', [12n], 0n, (x) => x !== 0n)).toBe('idle');
    expect(s.refusal).toBeNull();
  });
});
