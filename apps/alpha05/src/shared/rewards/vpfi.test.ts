import { describe, expect, it } from 'vitest';
import { emptiesTier } from './vpfiFacts';
import { vpfiFigures, withdrawClosed } from './vpfiBalances';
import { vpfiDepositNotes, vpfiWithdrawNotes } from './vpfiNotes';

type Hex = `0x${string}`;
const VAULT: Hex = '0x1111111111111111111111111111111111111111';
const copy = { text: (k: string) => k } as unknown as Parameters<typeof vpfiDepositNotes>[1];

describe('vpfiFigures', () => {
  it('holds what is counted but not free, and names what sits uncounted', () => {
    expect(vpfiFigures({ counted: 10n, sitting: 12n, free: 7n })).toEqual({ held: 3n, uncounted: 2n });
    expect(vpfiFigures({ counted: 10n, sitting: 9n, free: 10n })).toEqual({ held: 0n, uncounted: 0n });
    expect(vpfiFigures({ counted: null, sitting: 9n, free: 1n })).toEqual({ held: null, uncounted: null });
  });
});

describe('withdrawClosed', () => {
  it('says why nothing can be withdrawn, and nothing when something is free', () => {
    expect(withdrawClosed({ vault: null, counted: 0n, free: 0n })).toBe('no-vault');
    expect(withdrawClosed({ vault: VAULT, counted: 0n, free: 0n })).toBe('none');
    expect(withdrawClosed({ vault: VAULT, counted: 5n, free: 0n })).toBe('all-held');
    expect(withdrawClosed({ vault: VAULT, counted: 5n, free: null })).toBe('unread');
    expect(withdrawClosed({ vault: VAULT, counted: 5n, free: 1n })).toBeNull();
  });
});

describe('the receipt notes', () => {
  it('a deposit counts toward the tier and states the consent as read', () => {
    expect(vpfiDepositNotes({ tracked: 0n, consent: true, home: true }, copy)).toEqual(['rewardsVault.depositTier', 'rewardsVault.consentOn']);
    expect(vpfiDepositNotes({ tracked: 0n, consent: false, home: true }, copy)).toContain('rewardsVault.consentOff');
    expect(vpfiDepositNotes({ tracked: 0n, consent: null, home: true }, copy)).toContain('rewardsVault.consentUnread');
  });
  it('a withdrawal says when it empties the counted VPFI, or that it could not tell', () => {
    expect(emptiesTier({ tracked: 4n, consent: true, home: true }, 4n)).toBe(true);
    expect(emptiesTier({ tracked: 4n, consent: true, home: true }, 3n)).toBe(false);
    expect(emptiesTier({ tracked: 0n, consent: true, home: true }, 3n)).toBe(false);
    expect(vpfiWithdrawNotes({ tracked: 4n, consent: true, home: true }, 4n, 'wallet', copy)).toEqual([
      'rewardsVault.withdrawTier',
      'rewardsVault.withdrawEmpties',
      'rewardsVault.consentStays',
    ]);
    expect(vpfiWithdrawNotes({ tracked: 9n, consent: true, home: true }, 4n, 'wallet', copy)).not.toContain('rewardsVault.withdrawEmpties');
    expect(vpfiWithdrawNotes({ tracked: null, consent: true, home: true }, 4n, 'wallet', copy)).toContain('rewardsVault.withdrawTrackedUnread');
  });
  it('a queued withdrawal puts each tier effect on its release, and an unread route names neither', () => {
    expect(vpfiWithdrawNotes({ tracked: 4n, consent: true, home: true }, 4n, 'queued', copy)).toEqual([
      'rewardsVault.withdrawQueuedTier',
      'rewardsVault.withdrawQueuedEmpties',
      'rewardsVault.consentStays',
    ]);
    expect(vpfiWithdrawNotes({ tracked: 9n, consent: true, home: true }, 4n, 'queued', copy)).toEqual(['rewardsVault.withdrawQueuedTier', 'rewardsVault.consentStays']);
    expect(vpfiWithdrawNotes({ tracked: 4n, consent: true, home: true }, 4n, 'unknown', copy)).toEqual(['rewardsVault.withdrawRouteUnread', 'rewardsVault.consentStays']);
  });
  it('away from VPFI’s home network a move changes no tier, and an unread home says so', () => {
    expect(vpfiDepositNotes({ tracked: 0n, consent: true, home: false }, copy)).toEqual(['rewardsVault.depositAway']);
    expect(vpfiWithdrawNotes({ tracked: 4n, consent: true, home: false }, 4n, 'wallet', copy)).toEqual(['rewardsVault.withdrawAway', 'rewardsVault.consentStays']);
    expect(vpfiDepositNotes({ tracked: 0n, consent: true, home: null }, copy)).toEqual(['rewardsVault.homeUnread', 'rewardsVault.consentOn']);
    expect(vpfiWithdrawNotes({ tracked: 4n, consent: true, home: null }, 4n, 'wallet', copy)).toEqual(['rewardsVault.homeUnread', 'rewardsVault.consentStays']);
  });
});
