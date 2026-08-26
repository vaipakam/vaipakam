/**
 * Borrower-side listing-hold probe classifier (#1503 PR-A follow-up).
 *
 * The whole surface hangs off one mapping: teardown-simulation
 * outcome → hold state. These pin the mapping's three meaningful
 * arms AND the fail-closed default — an un-decodable or unexpected
 * outcome must render NOTHING (never a false "held" banner, never a
 * button for a transaction that would revert).
 */
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import {
  classifyTeardownProbe,
  computeHoldGate,
  probeSaleHoldLive,
  probeErrorName,
} from './saleListingHold';
import type {
  HoldQueryState,
  SaleListingHoldState,
} from './saleListingHold';

describe('classifyTeardownProbe', () => {
  it('a successful simulation means the listing ended and the hold is clearable now', () => {
    expect(classifyTeardownProbe({ ok: true })).toBe('clearable');
  });

  it('NoStaleSaleListing with an unlocked lender NFT means no listing', () => {
    expect(
      classifyTeardownProbe({
        ok: false,
        errorName: 'NoStaleSaleListing',
        saleLocked: false,
      }),
    ).toBe('none');
    // Lock unreadable/unknown degrades to `none` — never a false hold.
    expect(
      classifyTeardownProbe({ ok: false, errorName: 'NoStaleSaleListing' }),
    ).toBe('none');
  });

  it('NoStaleSaleListing with a sale-locked lender NFT is an accepted sale — hold continues', () => {
    // The teardown deliberately refuses an accepted-awaiting-completion
    // sale with the SAME error as "no listing"; only the lender NFT's
    // EarlyWithdrawalSale lock distinguishes them (Codex #1511 r3).
    expect(
      classifyTeardownProbe({
        ok: false,
        errorName: 'NoStaleSaleListing',
        saleLocked: true,
      }),
    ).toBe('accepted');
  });

  it('SaleListingLoanStillLive means a live bounded listing holds the options', () => {
    expect(
      classifyTeardownProbe({
        ok: false,
        errorName: 'SaleListingLoanStillLive',
      }),
    ).toBe('live');
  });

  it('fails CLOSED on anything else — unknown reverts render nothing', () => {
    // A pre-refresh Diamond that doesn't route the probe, an RPC
    // hiccup, or a revert the ABI can't decode must all land here.
    expect(classifyTeardownProbe({ ok: false, errorName: null })).toBe(
      'unknown',
    );
    expect(classifyTeardownProbe({ ok: false })).toBe('unknown');
    expect(
      classifyTeardownProbe({ ok: false, errorName: 'ReentrancyGuardReentrantCall' }),
    ).toBe('unknown');
    // The mid-completion (accepted) sale case reverts NoStaleSaleListing
    // on-chain — but if a FUTURE facet renames an error, the default
    // must stay hidden rather than inventing a state.
    expect(
      classifyTeardownProbe({ ok: false, errorName: 'SaleLoanPastMaturity' }),
    ).toBe('unknown');
  });
});

describe('probeErrorName', () => {
  it('extracts the custom-error name from a viem revert chain', () => {
    const revert = new ContractFunctionRevertedError({
      abi: [
        {
          type: 'error',
          name: 'SaleListingLoanStillLive',
          inputs: [],
        },
      ],
      functionName: 'teardownStaleSaleListing',
      data: '0x00000000',
    });
    // Force the decoded shape the classifier consumes — viem derives
    // `data.errorName` from the selector; constructing it directly
    // keeps the test independent of selector hashing.
    Object.assign(revert, {
      data: { errorName: 'SaleListingLoanStillLive', args: [] },
    });
    const wrapped = new BaseError('probe failed', { cause: revert });
    expect(probeErrorName(wrapped)).toBe('SaleListingLoanStillLive');
  });

  it('returns null for non-viem and undecodable failures', () => {
    expect(probeErrorName(new Error('rpc timeout'))).toBeNull();
    expect(probeErrorName(new BaseError('opaque'))).toBeNull();
    expect(probeErrorName(undefined)).toBeNull();
  });
});

/**
 * The fail-closed gate. Two separate P2s have come out of the
 * data/resolving interaction, so the whole cut×probe matrix is pinned
 * here rather than reasoned about case by case.
 *
 * The invariant under test: `data === undefined && !resolving` — a
 * surface that renders nothing AND stays open — is permitted for
 * exactly two reasons, the hook being disabled and the capability
 * answering a definite NO. Every other route to an undefined `data`
 * must pause the settlement surfaces.
 */
describe('computeHoldGate', () => {
  const pending = { isPending: true, isError: false };
  const ok = { isPending: false, isError: false };
  const errored = { isPending: false, isError: true };

  it('disabled: says nothing and pauses nothing', () => {
    expect(
      computeHoldGate({
        enabled: false,
        cut: { ...ok, data: true },
        probe: { ...ok, data: 'live' },
      }),
    ).toEqual({ data: undefined, resolving: false });
  });

  it('capability still pending: pauses, because the question is unanswered', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...pending },
        probe: { ...pending },
      }),
    ).toEqual({ data: undefined, resolving: true });
  });

  it('capability errored with nothing cached: pauses (exhausted retries must not fail open)', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...errored },
        probe: { ...pending },
      }),
    ).toEqual({ data: undefined, resolving: true });
  });

  it('capability answered NO: opens the surfaces — no facet, no hold to speak of', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...ok, data: false },
        probe: { ...pending },
      }),
    ).toEqual({ data: undefined, resolving: false });
  });

  it('a failed RE-ASK of a known NO keeps it open — the answer did not change', () => {
    // The regression this pins: an unconditional isError arm paused
    // every borrower on the pre-refresh deployment (where NO is the
    // normal answer) behind one transient RPC failure, repay included.
    expect(
      computeHoldGate({
        enabled: true,
        cut: { data: false, isPending: false, isError: true },
        probe: { ...pending },
      }),
    ).toEqual({ data: undefined, resolving: false });
  });

  it('a failed REVALIDATION of a known YES masks the data and pauses', () => {
    // Opposite direction: the capability may have rolled back, so the
    // cached probe answer can no longer be trusted — and a masked
    // answer must never leave the surfaces open.
    expect(
      computeHoldGate({
        enabled: true,
        cut: { data: true, isPending: false, isError: true },
        probe: { ...ok, data: 'live' },
      }),
    ).toEqual({ data: undefined, resolving: true });
  });

  it('capable Diamond, probe still pending: pauses', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...ok, data: true },
        probe: { ...pending },
      }),
    ).toEqual({ data: undefined, resolving: true });
  });

  it('capable Diamond, probe errored: masks its stale answer and pauses', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...ok, data: true },
        probe: { data: 'none', isPending: false, isError: true },
      }),
    ).toEqual({ data: undefined, resolving: true });
  });

  it('capable Diamond, undecodable probe outcome: pauses rather than guess', () => {
    expect(
      computeHoldGate({
        enabled: true,
        cut: { ...ok, data: true },
        probe: { ...ok, data: 'unknown' },
      }),
    ).toEqual({ data: 'unknown', resolving: true });
  });

  it('fully answered: reports the state and stops pausing', () => {
    for (const state of ['none', 'live', 'clearable', 'accepted'] as const) {
      expect(
        computeHoldGate({
          enabled: true,
          cut: { ...ok, data: true },
          probe: { ...ok, data: state },
        }),
      ).toEqual({ data: state, resolving: false });
    }
  });

  it('never leaves a surface open on an answer it is not rendering', () => {
    // The invariant itself, swept over every combination.
    const cutStates: HoldQueryState<boolean>[] = [
      { ...pending },
      { ...errored },
      { ...ok, data: true },
      { ...ok, data: false },
      { data: true, isPending: false, isError: true },
      { data: false, isPending: false, isError: true },
    ];
    const probeStates: HoldQueryState<SaleListingHoldState>[] = [
      { ...pending },
      { ...errored },
      { ...ok, data: 'none' as const },
      { ...ok, data: 'live' as const },
      { ...ok, data: 'unknown' as const },
      { data: 'live' as const, isPending: false, isError: true },
    ];
    for (const cut of cutStates) {
      for (const probe of probeStates) {
        const gate = computeHoldGate({ enabled: true, cut, probe });
        if (gate.data === undefined && !gate.resolving) {
          // Only legitimate reason while enabled: a definite NO.
          expect(cut.data).toBe(false);
        }
      }
    }
  });
});

/**
 * The probe's call shape. The lock read comes FIRST and short-circuits
 * the common no-listing case, so these pin both the classification and
 * the number of round-trips — the volume matters because this probe
 * rides the tip-driven invalidation set, and its own rate-limit
 * failures are what push the surface into its errored state.
 */
describe('probeSaleHoldLive', () => {
  const DIAMOND = '0xdia0000000000000000000000000000000000000' as const;

  function fakeClient(opts: {
    lock: number;
    simulate?: () => never;
  }) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        readContract: async () => {
          calls.push('positionLock');
          return BigInt(opts.lock);
        },
        simulateContract: async () => {
          calls.push('simulate');
          if (opts.simulate) opts.simulate();
          return {} as never;
        },
      },
    };
  }

  function revertWith(name: string): () => never {
    return () => {
      const inner = new ContractFunctionRevertedError({
        abi: [
          {
            type: 'error',
            name,
            inputs: [],
          },
        ],
        data: undefined,
        functionName: 'teardownStaleSaleListing',
      });
      // viem builds `data` from the ABI when decoding; set it directly
      // so the walk in probeErrorName finds the name.
      (inner as unknown as { data: { errorName: string } }).data = {
        errorName: name,
      };
      const err = new BaseError('reverted');
      (err as unknown as { walk: (fn: unknown) => unknown }).walk = () => inner;
      throw err;
    };
  }

  it('an unlocked lender position is answered by ONE read, no simulation', async () => {
    const { client, calls } = fakeClient({ lock: 0 });
    await expect(
      probeSaleHoldLive(client as never, DIAMOND, 42, '7', undefined),
    ).resolves.toBe('none');
    expect(calls).toEqual(['positionLock']);
  });

  it('a sale-locked position still simulates, and a live listing reads as live', async () => {
    const { client, calls } = fakeClient({
      lock: 2,
      simulate: revertWith('SaleListingLoanStillLive'),
    });
    await expect(
      probeSaleHoldLive(client as never, DIAMOND, 42, '7', undefined),
    ).resolves.toBe('live');
    expect(calls).toEqual(['positionLock', 'simulate']);
  });

  it('a sale-locked position whose teardown succeeds is clearable', async () => {
    const { client } = fakeClient({ lock: 2 });
    await expect(
      probeSaleHoldLive(client as never, DIAMOND, 42, '7', undefined),
    ).resolves.toBe('clearable');
  });

  it('sale-locked + NoStaleSaleListing is an accepted sale, not "nothing here"', async () => {
    const { client, calls } = fakeClient({
      lock: 2,
      simulate: revertWith('NoStaleSaleListing'),
    });
    await expect(
      probeSaleHoldLive(client as never, DIAMOND, 42, '7', undefined),
    ).resolves.toBe('accepted');
    // The lock reading is reused — the ambiguous arm costs nothing extra.
    expect(calls).toEqual(['positionLock', 'simulate']);
  });

  it('with no token id the lock cannot rule anything out, so it simulates', async () => {
    const { client, calls } = fakeClient({
      lock: 0,
      simulate: revertWith('NoStaleSaleListing'),
    });
    await expect(
      probeSaleHoldLive(client as never, DIAMOND, 42, '', undefined),
    ).resolves.toBe('none');
    expect(calls).toEqual(['simulate']);
  });
});
