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
  probeErrorName,
} from './saleListingHold';

describe('classifyTeardownProbe', () => {
  it('a successful simulation means the listing ended and the hold is clearable now', () => {
    expect(classifyTeardownProbe({ ok: true })).toBe('clearable');
  });

  it('NoStaleSaleListing means no listing — nothing held, nothing rendered', () => {
    expect(
      classifyTeardownProbe({ ok: false, errorName: 'NoStaleSaleListing' }),
    ).toBe('none');
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
