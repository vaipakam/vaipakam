/**
 * The write-level Terms gate (#1961, review round 2 P1).
 *
 * Route exemption is an affordance; this is the enforcement. The cases
 * that matter are the two directions of getting it wrong: refusing a
 * write that would trap a user's money, and permitting one that takes on
 * new exposure from a wallet that refused the Terms.
 */
import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { EXIT_WRITES, isExitWrite } from './tosWriteGate';

const call = (functionName: string, args: readonly unknown[]) => ({
  callData: encodeFunctionData({
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args: args as unknown[],
  }),
});

describe('isExitWrite', () => {
  it('permits the writes that get a user out', () => {
    for (const fn of [
      'acceptTerms',
      'repayLoan',
      'repayPartial',
      'precloseDirect',
      'claimAsBorrower',
      'claimAsLender',
      'withdrawVPFIFromVault',
      'cancelOffer',
      'addCollateral',
    ]) {
      expect(isExitWrite(fn, []), fn).toBe(true);
    }
  });

  it('refuses the writes that take on new exposure', () => {
    // Every one of these is reachable from a route the gate exempts so
    // the user can repay — which is exactly why the route list cannot be
    // the enforcement.
    for (const fn of [
      'createOffer',
      'createOfferWithPermit',
      'acceptOffer',
      'acceptOfferWithPermit',
      'acceptSignedOffer',
      'matchOffers',
      'depositVPFIToVault',
      'depositVPFIToVaultWithPermit',
      'setVPFIDiscountConsent',
      'offsetWithNewOffer',
      'transferObligationViaOffer',
      'createLoanSaleOffer',
      'sellLoanViaBuyOffer',
      'modifyOffer',
    ]) {
      expect(isExitWrite(fn, []), fn).toBe(false);
    }
  });

  it('permits a batch whose every call is an exit', () => {
    // What `ClaimAllCard` actually sends.
    const batch = [
      call('claimAsLender', [1n]),
      call('claimAsBorrower', [2n]),
      call('withdrawVPFIFromVault', [10n]),
    ];
    expect(isExitWrite('multicall', [batch])).toBe(true);
  });

  it('refuses a batch that smuggles a non-exit call', () => {
    // The whole reason `multicall` needs its arguments read: permitting
    // the wrapper on its name alone would permit anything anyone chose
    // to batch behind it.
    const batch = [
      call('claimAsLender', [1n]),
      call('setVPFIDiscountConsent', [true]),
    ];
    expect(isExitWrite('multicall', [batch])).toBe(false);
  });

  it('refuses a batch it cannot read', () => {
    // Unreadable is not harmless. An empty batch, a non-array, a short
    // or absent callData: each is refused rather than assumed.
    expect(isExitWrite('multicall', [[]])).toBe(false);
    expect(isExitWrite('multicall', [undefined])).toBe(false);
    expect(isExitWrite('multicall', [[{ callData: '0x' }]])).toBe(false);
    expect(isExitWrite('multicall', [[{}]])).toBe(false);
    expect(isExitWrite('multicall', [])).toBe(false);
  });

  it('permits withdrawing a keeper\u2019s authority, and only that direction', () => {
    // Review round 4 P1: a user who declines new Terms must still be
    // able to take back a third party's power over their positions.
    // Otherwise the gate protects the delegate, not the user.
    expect(isExitWrite('revokeKeeper', ['0xabc'])).toBe(true);
    expect(isExitWrite('setKeeperAccess', [false])).toBe(true);
    expect(isExitWrite('setLoanKeeperEnabled', [1n, '0xabc', false])).toBe(true);
    // ...but a GRANT is new authority and stays gated.
    expect(isExitWrite('setKeeperAccess', [true])).toBe(false);
    expect(isExitWrite('setLoanKeeperEnabled', [1n, '0xabc', true])).toBe(false);
    expect(isExitWrite('approveKeeper', ['0xabc', 7])).toBe(false);
    expect(isExitWrite('setKeeperActions', ['0xabc', 7])).toBe(false);
  });

  it('refuses a disable-only write whose flag it cannot read', () => {
    // A missing or non-boolean argument is refused rather than assumed
    // to be the harmless direction — the flag's POSITION differs per
    // function, so a wrong index would silently permit a grant.
    expect(isExitWrite('setKeeperAccess', [])).toBe(false);
    expect(isExitWrite('setKeeperAccess', ['false'])).toBe(false);
    expect(isExitWrite('setLoanKeeperEnabled', [1n, '0xabc'])).toBe(false);
  });

  it('keeps acceptTerms on the list', () => {
    // Omitting it would make the gate unpassable — the one defect with
    // no workaround, since the remedy is itself the blocked write.
    expect(EXIT_WRITES.has('acceptTerms')).toBe(true);
  });

  it('names only writes the ABI actually has', () => {
    // A typo here fails open in the worst way: the intended write stops
    // being exempt, and nothing says so.
    const abiNames = new Set(
      (DIAMOND_ABI_VIEM as readonly { type?: string; name?: string }[])
        .filter((i) => i.type === 'function')
        .map((i) => i.name),
    );
    for (const fn of EXIT_WRITES) {
      expect(abiNames.has(fn), fn).toBe(true);
    }
  });
});
