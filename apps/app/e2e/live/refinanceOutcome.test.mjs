/**
 * #2422 r8 — the refinance outcome helpers, pinned against the REAL accept
 * that refinanced loan 22 into loan 23 on Base Sepolia (tx
 * 0x6651828509c9bcfd01746270a79f8602cc303a06aa1ef853b71ad24c29b0888c, block
 * 47711162). Every input below is a view value read at block 47711161 and
 * every expected output is the delta or log the chain recorded — the model
 * reproduces each to the wei.
 */
import { describe, expect, it } from 'vitest';

import {
  expectedPrincipalTransfers,
  expectedSettlement,
  lienMismatches,
  scanForReplacement,
  transferMismatches,
} from './refinanceOutcome.mjs';

const BORROWER = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const LENDER = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
const LENDER_VAULT = '0x7bb370BA877c7f430CB3CD6f2E25e3eE788148F1';
const TREASURY = '0xca3E735C593088D2f5ea5AEAa553a6bDaa6E7413';
const OLD_LENDER_VAULT = '0xf0724B8448a30AA90cB4EfCFc93af63090B6d030';
const TCOL = '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037';

const LOAN22_AT_P = {
  repayDue: 5_039_726_027_397_260n, // calculateRepaymentAmount(22) @ 47711161
  oldPrincipal: 5_000_000_000_000_000n,
  treasuryFeeBpsAtInit: 200,
  newPrincipal: 5_000_000_000_000_000n,
  lifBps: 20n, // getProtocolConfigBundle()[1] @ 47711161
  matcherBps: 100n, // getProtocolConfigBundle()[12] @ 47711161
};
const PARTIES = {
  borrower: BORROWER,
  lender: LENDER,
  lenderVault: LENDER_VAULT,
  treasury: TREASURY,
  oldLenderVault: OLD_LENDER_VAULT,
  newPrincipal: LOAN22_AT_P.newPrincipal,
};
// The principal-token (WETH) Transfer logs of the real accept receipt, in
// emission order.
const REAL_TRANSFERS = [
  { from: LENDER, to: LENDER_VAULT, value: 5_000_000_000_000_000n },
  { from: LENDER_VAULT, to: TREASURY, value: 9_900_000_000_000n },
  { from: LENDER_VAULT, to: LENDER, value: 100_000_000_000n },
  { from: LENDER_VAULT, to: BORROWER, value: 4_990_000_000_000_000n },
  { from: BORROWER, to: TREASURY, value: 794_520_547_945n },
  { from: BORROWER, to: OLD_LENDER_VAULT, value: 5_038_931_506_849_315n },
];

describe('refinanceOutcome — settlement from the contract views', () => {
  it('reproduces the real loan-22 accept to the wei', () => {
    const s = expectedSettlement(LOAN22_AT_P);
    // The old lender's claim went 0 → 5038931506849315 and their vault rose
    // by the same; the borrower's wallet fell 49726027397260; the accepting
    // lender's wallet fell 4999900000000000 (principal less the matcher cut);
    // the treasury rose 10694520547945.
    expect(s.interestPortion).toBe(39_726_027_397_260n);
    expect(s.treasuryShare).toBe(794_520_547_945n);
    expect(s.lenderDue).toBe(5_038_931_506_849_315n);
    expect(s.oldLenderVaultDelta).toBe(5_038_931_506_849_315n);
    expect(s.lif).toBe(10_000_000_000_000n);
    expect(s.matcherCut).toBe(100_000_000_000n);
    expect(s.borrowerWalletDelta).toBe(-49_726_027_397_260n);
    expect(s.lenderWalletDelta).toBe(-4_999_900_000_000_000n);
    expect(s.treasuryDelta).toBe(10_694_520_547_945n);
  });

  it('falls back to the legacy 100 bps for an unstamped loan', () => {
    const s = expectedSettlement({ ...LOAN22_AT_P, treasuryFeeBpsAtInit: 0 });
    expect(s.feeBps).toBe(100n);
    expect(s.treasuryShare).toBe(397_260_273_972n);
  });

  it('refuses a payoff view below the principal (not an Active loan’s payoff)', () => {
    expect(() => expectedSettlement({ ...LOAN22_AT_P, repayDue: 0n })).toThrow(/below the principal/);
  });

  it('expects exactly the real receipt’s principal-token transfers', () => {
    const want = expectedPrincipalTransfers(expectedSettlement(LOAN22_AT_P), PARTIES);
    expect(transferMismatches(want, REAL_TRANSFERS)).toEqual([]);
    // Order is not the claim; the multiset is.
    expect(transferMismatches(want, [...REAL_TRANSFERS].reverse())).toEqual([]);
  });

  it('refuses a missing, an extra, or a mis-sized transfer', () => {
    const want = expectedPrincipalTransfers(expectedSettlement(LOAN22_AT_P), PARTIES);
    expect(transferMismatches(want, REAL_TRANSFERS.filter((t) => t.to !== OLD_LENDER_VAULT))).toEqual([
      `missing transfer ${BORROWER.toLowerCase()}→${OLD_LENDER_VAULT.toLowerCase()}:5038931506849315`,
    ]);
    const extra = [...REAL_TRANSFERS, { from: BORROWER, to: '0x000000000000000000000000000000000000dEaD', value: 1n }];
    expect(transferMismatches(want, extra)).toHaveLength(1);
    expect(transferMismatches(want, extra)[0]).toMatch(/^unexpected transfer/);
    // A payoff one wei short to the old lender is two mismatches: the
    // expected leg missing and the actual one unexpected.
    const short = REAL_TRANSFERS.map((t) => (t.to === OLD_LENDER_VAULT ? { ...t, value: t.value - 1n } : t));
    expect(transferMismatches(want, short)).toHaveLength(2);
    // A matcher cut paid to someone other than the accepting lender.
    const elsewhere = REAL_TRANSFERS.map((t) => (t.to === LENDER ? { ...t, to: BORROWER } : t));
    expect(transferMismatches(want, elsewhere)).toHaveLength(2);
  });

  it('omits zero-value legs the contract skips', () => {
    const s = expectedSettlement({ ...LOAN22_AT_P, matcherBps: 0n });
    const want = expectedPrincipalTransfers(s, PARTIES);
    expect(want.some((t) => t.to === LENDER)).toBe(false);
    expect(want).toHaveLength(5);
  });
});

describe('refinanceOutcome — the collateral lien carries over', () => {
  const live = { user: BORROWER, asset: TCOL, tokenId: 0n, amount: 100n * 10n ** 18n, assetType: 0, released: false };
  const expected = { user: BORROWER, asset: TCOL, assetType: 0, tokenId: 0n, amount: 100n * 10n ** 18n };
  // getLoanCollateralLien(22) @ 47711161, (22) @ 47711162, (23) @ 47711162.
  const REAL = {
    oldBefore: live,
    oldAfter: { ...live, amount: 0n, released: true },
    newAfter: { ...live },
    expected,
  };

  it('accepts the real loan-22 → loan-23 liens', () => {
    expect(lienMismatches(REAL)).toEqual([]);
  });

  it('refuses an old lien left live or unzeroed', () => {
    expect(lienMismatches({ ...REAL, oldAfter: { ...REAL.oldAfter, released: false } })).toEqual([
      'old loan lien at the accept: released false, expected true',
    ]);
    expect(lienMismatches({ ...REAL, oldAfter: { ...REAL.oldAfter, amount: 1n } })).toEqual([
      'old loan lien at the accept: amount 1, expected 0',
    ]);
  });

  it('refuses a replacement lien that differs in any field, or is not live', () => {
    for (const [field, value] of [
      ['user', LENDER],
      ['asset', BORROWER],
      ['assetType', 1],
      ['tokenId', 1n],
      ['amount', 99n * 10n ** 18n],
      ['released', true],
    ]) {
      const r = lienMismatches({ ...REAL, newAfter: { ...REAL.newAfter, [field]: value } });
      expect(r, field).toHaveLength(1);
      expect(r[0], field).toMatch(new RegExp(`^replacement lien at the accept: ${field} `));
    }
  });

  it('refuses an old lien that was not live before the accept', () => {
    expect(lienMismatches({ ...REAL, oldBefore: { ...live, released: true } })[0]).toMatch(/^old loan lien before the accept: released true/);
  });
});

describe('refinanceOutcome — the replacement scan states its limit', () => {
  /** A chain whose loans 23.. are `ids`, then empty. */
  const chain = (loans) => async (id) => loans.find((l) => l.id === id) ?? { id: 0n, offerId: 0n };

  it('finds the replacement and stops at the empty id', async () => {
    const readLoan = chain([{ id: 23n, offerId: 45n }, { id: 24n, offerId: 46n }]);
    expect(await scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).toEqual({ id: 23n, offerId: 45n });
  });

  it('"none" only when the empty id is reached', async () => {
    const readLoan = chain([{ id: 23n, offerId: 9n }]);
    expect(await scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).toBeNull();
  });

  it('exhausting the cap is UNKNOWN (throws), never "none"', async () => {
    // Every id is occupied: the cap runs out before any empty id.
    const readLoan = async (id) => ({ id, offerId: 1n });
    await expect(scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 5 })).rejects.toThrow(
      /read 5 loan ids \(#23–#27\) without reaching an empty id/,
    );
    // Even with a match found, an exhausted cap cannot rule out a second.
    const withMatch = async (id) => ({ id, offerId: id === 24n ? 45n : 1n });
    await expect(scanForReplacement({ readLoan: withMatch, startId: 23n, requestId: 45n, cap: 5 })).rejects.toThrow(/one was found at #24/);
  });

  it('two loans carrying the request is an error', async () => {
    const readLoan = chain([{ id: 23n, offerId: 45n }, { id: 24n, offerId: 45n }]);
    await expect(scanForReplacement({ readLoan, startId: 23n, requestId: 45n, cap: 10 })).rejects.toThrow(/two loans/);
  });
});
