import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import {
  ClaimPreviewUnavailable,
  previewClaimByExecution,
  previewClaimOutcome,
  readClaimWindow,
  readHeldReward,
  windowFields,
} from './rewards';

/**
 * A2-iii — the app reads the exact claimable figure BY EXECUTION: the
 * simulation entry always reverts, and the figure rides in the revert data.
 */
describe('previewClaimByExecution', () => {
  const DIAMOND = '0xdia0000000000000000000000000000000000000' as const;
  const USER = '0x00000000000000000000000000000000000a11ce' as const;

  function revertWith(name: string, args?: readonly unknown[]): () => never {
    return () => {
      const inner = new ContractFunctionRevertedError({
        abi: [{ type: 'error', name, inputs: [] }],
        data: undefined,
        functionName: 'simulateClaimInteractionRewards',
      });
      (inner as unknown as { data: { errorName: string; args?: readonly unknown[] } }).data = {
        errorName: name,
        args,
      };
      const err = new BaseError('reverted');
      (err as unknown as { walk: (fn: unknown) => unknown }).walk = () => inner;
      throw err;
    };
  }

  function client(simulate: () => never | Promise<unknown>) {
    return { simulateContract: async () => simulate() } as never;
  }

  it('decodes the paid figure from the simulation revert', async () => {
    const c = client(revertWith('InteractionRewardsSimulation', [123n, 4n, 9n]));
    await expect(previewClaimByExecution(c, DIAMOND, USER)).resolves.toBe(123n);
  });

  it('a revert that means nothing is owed reads as zero', async () => {
    await expect(
      previewClaimByExecution(client(revertWith('NoInteractionRewardsToClaim')), DIAMOND, USER),
    ).resolves.toBe(0n);
    await expect(
      previewClaimByExecution(client(revertWith('InteractionEmissionsNotStarted')), DIAMOND, USER),
    ).resolves.toBe(0n);
  });

  it('an operational refusal (the pause) is surfaced, never read as nothing owed (#2459 r1)', async () => {
    await expect(
      previewClaimByExecution(client(revertWith('EnforcedPause')), DIAMOND, USER),
    ).rejects.toBeInstanceOf(ClaimPreviewUnavailable);
  });

  it('a non-revert return is reported, never turned into a figure', async () => {
    const c = client(async () => ({}));
    await expect(previewClaimByExecution(c, DIAMOND, USER)).rejects.toThrow(
      /returned without reverting/,
    );
  });

  it('a transport error is surfaced, not swallowed as zero', async () => {
    const c = client(() => {
      throw new Error('rpc down');
    });
    await expect(previewClaimByExecution(c, DIAMOND, USER)).rejects.toThrow('rpc down');
  });
});

/**
 * #2489 r2 — the held balance is read on its OWN, so the Claim Center can
 * offer it exactly when the combined claim's preview is unavailable.
 */
describe('readHeldReward', () => {
  const DIAMOND = '0xdia0000000000000000000000000000000000000' as const;
  const USER = '0x00000000000000000000000000000000000a11ce' as const;
  const client = (read: () => unknown) => ({ readContract: async () => read() }) as never;

  it('returns the wallet held balance', async () => {
    await expect(readHeldReward(client(() => [7n, 9n]), DIAMOND, USER)).resolves.toBe(7n);
  });

  it('a revert (the view absent on this chain) reads as zero', async () => {
    const reverted = () => {
      const inner = new ContractFunctionRevertedError({ abi: [], data: undefined, functionName: 'getSanctionsHeldReward' });
      const err = new BaseError('reverted');
      (err as unknown as { walk: (fn: unknown) => unknown }).walk = () => inner;
      throw err;
    };
    await expect(readHeldReward(client(reverted), DIAMOND, USER)).resolves.toBe(0n);
  });

  it('a transport failure throws — never read as "nothing held"', async () => {
    await expect(readHeldReward(client(() => { throw new Error('fetch failed'); }), DIAMOND, USER)).rejects.toThrow(
      'fetch failed',
    );
  });
});

/**
 * #1787 — a claim reads one part (window) of a large wallet's reward entries.
 * A claim that pays nothing over such a part still RUNS and moves on, which is
 * the only way a later claim reaches the rest, so the card must offer it.
 */
describe('claim window', () => {
  const DIAMOND = '0xdia0000000000000000000000000000000000000' as const;
  const USER = '0x00000000000000000000000000000000000a11ce' as const;

  function simulateRevert(name: string, args?: readonly unknown[]) {
    return {
      simulateContract: async () => {
        const inner = new ContractFunctionRevertedError({ abi: [], data: undefined, functionName: 'simulateClaimInteractionRewards' });
        (inner as unknown as { data: { errorName: string; args?: readonly unknown[] } }).data = { errorName: name, args };
        const err = new BaseError('reverted');
        (err as unknown as { walk: (fn: unknown) => unknown }).walk = () => inner;
        throw err;
      },
    } as never;
  }

  it('keeps whether the claim runs: a zero that runs is not "nothing owed"', async () => {
    await expect(previewClaimOutcome(simulateRevert('InteractionRewardsSimulation', [0n, 0n, 0n]), DIAMOND, USER)).resolves.toEqual({
      paid: 0n,
      runs: true,
    });
    await expect(previewClaimOutcome(simulateRevert('NoInteractionRewardsToClaim'), DIAMOND, USER)).resolves.toEqual({
      paid: 0n,
      runs: false,
    });
  });

  it('reads the window; a revert (a Diamond without it) reads as none; a transport failure throws', async () => {
    const read = (fn: () => unknown) => ({ readContract: async () => fn() }) as never;
    await expect(readClaimWindow(read(() => [128n, 256n, 300n, 0n]), DIAMOND, USER)).resolves.toEqual({
      from: 128n,
      to: 256n,
      total: 300n,
    });
    const reverted = () => {
      const inner = new ContractFunctionRevertedError({ abi: [], data: undefined, functionName: 'getRewardClaimWindow' });
      const err = new BaseError('reverted');
      (err as unknown as { walk: (fn: unknown) => unknown }).walk = () => inner;
      throw err;
    };
    await expect(readClaimWindow(read(reverted), DIAMOND, USER)).resolves.toBeNull();
    await expect(readClaimWindow(read(() => { throw new Error('fetch failed'); }), DIAMOND, USER)).rejects.toThrow('fetch failed');
  });

  it('offers the move-on claim only for a zero that runs over part of the entries', () => {
    const part = { from: 0n, to: 128n, total: 300n };
    const whole = { from: 0n, to: 40n, total: 40n };
    expect(windowFields({ paid: 0n, runs: true }, part)).toEqual({ window: part, movesOnOnly: true });
    expect(windowFields({ paid: 5n, runs: true }, part)).toEqual({ window: part, movesOnOnly: false });
    expect(windowFields({ paid: 0n, runs: false }, part)).toEqual({ window: part, movesOnOnly: false });
    expect(windowFields({ paid: 0n, runs: true }, whole)).toEqual({ movesOnOnly: false });
    expect(windowFields({ paid: 0n, runs: true }, null)).toEqual({ movesOnOnly: false });
  });
});
