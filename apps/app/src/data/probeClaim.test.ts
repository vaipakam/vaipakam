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
import { isMemoizableProbe, probeClaim } from './claimables';
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

describe('probeClaim — the asset held proceeds are paid in (#2373 r5)', () => {
  const lender = { ...borrowerLoan, role: 'lender', lendingAsset: USDC } as unknown as PositionLoan;
  const withHeld = [WETH, 0n, false, 0n, 0n, 0n, 9n, false];

  it('is the lending asset for an ERC-20 loan', async () => {
    const r = await probeClaim(client({ ownerOf: ME, getClaimable: withHeld }), DIAMOND, ME, lender);
    expect(r.kind === 'claimable' && r.loan.claim.heldAsset).toBe(USDC);
  });

  it('is the prepay asset for a rental, read from the loan', async () => {
    const r = await probeClaim(
      client({ ownerOf: ME, getClaimable: withHeld, getLoanDetails: { prepayAsset: WETH } }),
      DIAMOND,
      ME,
      { ...lender, assetType: 1 } as PositionLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.heldAsset).toBe(WETH);
  });

  it('is unknown, not guessed, when a rental read fails', async () => {
    const r = await probeClaim(
      client({
        ownerOf: ME,
        getClaimable: withHeld,
        getLoanDetails: () => {
          throw new Error('fetch failed');
        },
      }),
      DIAMOND,
      ME,
      { ...lender, assetType: 1 } as PositionLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.heldAsset).toBeNull();
  });

  it('is null when nothing is held', async () => {
    const r = await probeClaim(
      client({ ownerOf: ME, getClaimable: [USDC, 10n, false, 0n, 0n, 0n, 0n, false] }),
      DIAMOND,
      ME,
      lender,
    );
    expect(r.kind === 'claimable' && r.loan.claim.heldAsset).toBeNull();
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

describe('probeClaim — what the loan owed at default (#2374)', () => {
  const lenderLoan = { ...borrowerLoan, role: 'lender', lendingAsset: USDC } as unknown as PositionLoan;
  const lenderReads = { ownerOf: ME, getClaimable: [USDC, 10n, false, 0n, 0n, 0n, 0n, false] };

  it('carries the recorded figure on a defaulted lender claim', async () => {
    const r = await probeClaim(
      client({ ...lenderReads, getOwedAtDefault: [1000n, 30n, 20n, 1_700_000_000n, true] }),
      DIAMOND,
      ME,
      lenderLoan,
    );
    expect(r.kind === 'claimable' && r.loan.claim.owedAtDefault).toEqual({
      kind: 'recorded',
      principal: 1000n,
      interest: 30n,
      lateFee: 20n,
      viaFallback: true,
    });
    expect(isMemoizableProbe(r)).toBe(true);
  });

  it('reads no record as none, whether unwritten or from a deployment without the view', async () => {
    for (const read of [[0n, 0n, 0n, 0n, false], () => { throw revert(); }]) {
      const r = await probeClaim(client({ ...lenderReads, getOwedAtDefault: read }), DIAMOND, ME, lenderLoan);
      expect(r.kind === 'claimable' && r.loan.claim.owedAtDefault).toEqual({ kind: 'none' });
    }
  });

  it('keeps the claim when only that read fails, says so, and does not memoize it', async () => {
    const r = await probeClaim(
      client({ ...lenderReads, getOwedAtDefault: () => { throw new Error('fetch failed'); } }),
      DIAMOND,
      ME,
      lenderLoan,
    );
    expect(r.kind).toBe('claimable');
    expect(r.kind === 'claimable' && r.loan.claim.owedAtDefault).toEqual({ kind: 'unreadable' });
    expect(isMemoizableProbe(r)).toBe(false);
  });

  it('does not read it outside a defaulted lender claim', async () => {
    // The fake client throws on any unexpected read, which would surface as
    // `unreadable` here rather than `none`.
    for (const loan of [{ ...lenderLoan, status: 'repaid' }, { ...lenderLoan, status: 'fallback_pending' }]) {
      const r = await probeClaim(client(lenderReads), DIAMOND, ME, loan as PositionLoan);
      expect(r.kind === 'claimable' && r.loan.claim.owedAtDefault).toEqual({ kind: 'none' });
    }
  });

  it('never memoizes an unconfirmed probe', () => {
    expect(isMemoizableProbe({ kind: 'unconfirmed' })).toBe(false);
    expect(isMemoizableProbe({ kind: 'none' })).toBe(true);
  });
});
