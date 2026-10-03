/**
 * #2373 r2 — `probeClaim`, the one per-loan claim probe behind the Claims
 * page and the loan page. Driven with a fake read client so each lane and
 * each failure shape is pinned.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  type PublicClient,
} from 'viem';
import { probeClaim } from './claimables';
import type { PositionLoan } from './hooks';

const ME = '0x00000000000000000000000000000000000000aa';
const DIAMOND = '0x00000000000000000000000000000000000000dd' as const;
const USDC = '0x00000000000000000000000000000000000000c1';
const ZERO = '0x0000000000000000000000000000000000000000';

const revert = () =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: [], functionName: 'x' }),
    { abi: [], functionName: 'x' },
  );

type Reads = Record<string, unknown | (() => unknown)>;
function client(reads: Reads): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads)) throw new Error(`unexpected read ${functionName}`);
      const r = reads[functionName];
      return typeof r === 'function' ? (r as () => unknown)() : r;
    },
  } as unknown as PublicClient;
}

const borrowerLoan = {
  loanId: 7,
  role: 'borrower',
  status: 'defaulted',
  lenderTokenId: '1',
  borrowerTokenId: '2',
  assetType: 0,
} as unknown as PositionLoan;

// getClaimable with nothing on the ordinary lane.
const emptyClaimable = [ZERO, 0n, false, 0n, 0n, 0n, 0n, false];
// getLoanCollateralLien with no live lien.
const noLien = { asset: ZERO, amount: 0n, released: true };
const WETH = '0x00000000000000000000000000000000000000e1';

describe('probeClaim — the borrower surplus lane', () => {
  it('lists a claim that consists ONLY of a frozen swap-to-repay surplus', async () => {
    const r = await probeClaim(
      client({
        ownerOf: ME,
        getClaimable: emptyClaimable,
        getBorrowerLifRebate: [0n, 0n],
        getBorrowerSurplusClaim: [USDC, 5_000_000n, false],
        getLoanCollateralLien: noLien,
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('claimable');
    expect(r.kind === 'claimable' && r.loan.claim.surplus).toEqual({ asset: USDC, amount: 5_000_000n });
  });

  it('treats an already-claimed surplus as nothing to claim', async () => {
    const r = await probeClaim(
      client({
        ownerOf: ME,
        getClaimable: emptyClaimable,
        getBorrowerLifRebate: [0n, 0n],
        getBorrowerSurplusClaim: [USDC, 5_000_000n, true],
        getLoanCollateralLien: noLien,
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('none');
  });

  it('reads a deployment without the surplus view (a revert) as no surplus lane', async () => {
    const r = await probeClaim(
      client({
        ownerOf: ME,
        getClaimable: emptyClaimable,
        getBorrowerLifRebate: [0n, 0n],
        getBorrowerSurplusClaim: () => {
          throw revert();
        },
        getLoanCollateralLien: noLien,
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('none');
  });

  it('reports a transport failure on the surplus read as unconfirmed, never as none', async () => {
    const r = await probeClaim(
      client({
        ownerOf: ME,
        getClaimable: emptyClaimable,
        getBorrowerLifRebate: [0n, 0n],
        getBorrowerSurplusClaim: () => {
          throw new Error('fetch failed');
        },
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('unconfirmed');
  });

  it('never reads the surplus lane for the lender side', async () => {
    const r = await probeClaim(
      client({ ownerOf: ME, getClaimable: [USDC, 10n, false, 0n, 0n, 0n, 0n, false] }),
      DIAMOND,
      ME,
      { ...borrowerLoan, role: 'lender' } as PositionLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.surplus).toBeNull();
  });
});

describe('probeClaim — the extra liened-collateral lane (#2373 r3)', () => {
  const base = {
    ownerOf: ME,
    // The claim row carries a loan-asset surplus…
    getClaimable: [USDC, 7_000_000n, false, 0n, 0n, 0n, 0n, false],
    getBorrowerLifRebate: [0n, 0n],
    getBorrowerSurplusClaim: [ZERO, 0n, false],
  };

  it('carries a live lien in a different asset as a second payout', async () => {
    const r = await probeClaim(
      client({ ...base, getLoanCollateralLien: { asset: WETH, amount: 3n, released: false } }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.extraCollateral).toEqual({ asset: WETH, amount: 3n });
  });

  it('does not double-count a lien that IS the claim row asset', async () => {
    const r = await probeClaim(
      client({
        ...base,
        getLoanCollateralLien: { asset: USDC.toUpperCase().replace('0X', '0x'), amount: 3n, released: false },
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.extraCollateral).toBeNull();
  });

  it('ignores a released lien', async () => {
    const r = await probeClaim(
      client({ ...base, getLoanCollateralLien: { asset: WETH, amount: 3n, released: true } }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.extraCollateral).toBeNull();
  });

  it('never makes an otherwise-empty claim actionable (the contract does not count it)', async () => {
    const r = await probeClaim(
      client({
        ...base,
        getClaimable: emptyClaimable,
        getLoanCollateralLien: { asset: WETH, amount: 3n, released: false },
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('none');
  });

  it('reports a transport failure on the lien read as unconfirmed', async () => {
    const r = await probeClaim(
      client({
        ...base,
        getLoanCollateralLien: () => {
          throw new Error('fetch failed');
        },
      }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('unconfirmed');
  });
});

describe('probeClaim — ownership', () => {
  it('is nothing to claim when another wallet holds the position NFT', async () => {
    const r = await probeClaim(
      client({ ownerOf: '0x00000000000000000000000000000000000000bb' }),
      DIAMOND,
      ME,
      borrowerLoan,
    );
    expect(r.kind).toBe('none');
  });
});
