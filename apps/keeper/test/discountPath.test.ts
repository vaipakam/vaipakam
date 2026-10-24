/**
 * #2633 — the operator's arming of the flash-loan discount path, one setting
 * naming the chains. An unset, unnamed or unreadable setting arms nothing.
 */
import { describe, expect, it } from 'vitest';
import { discountPathBlocker, discountPathChains, discountPathPosture } from '../src/discountPath';
import { flashLoanRoute } from '../src/flashLoanProviders';

describe('DISCOUNT_PATH_CHAIN_IDS', () => {
  it('arms no chain when unset or empty', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(discountPathChains(raw)).toEqual({ chains: new Set() });
      expect(discountPathBlocker(raw, 8453)).toMatch(/is unset, so no chain is armed/);
    }
  });

  it('arms exactly the chains it names', () => {
    expect(discountPathChains(' 8453, 42161 ')).toEqual({ chains: new Set([8453, 42161]) });
    expect(discountPathBlocker('8453,42161', 8453)).toBeNull();
    expect(discountPathBlocker('8453,42161', 42161)).toBeNull();
    expect(discountPathBlocker('8453', 10)).toBe('DISCOUNT_PATH_CHAIN_IDS does not name chain 10');
  });

  it('arms nothing when any entry is not a chain id, and never echoes it', () => {
    for (const raw of ['8453,true', '8453,', '0x2105', '-1', '0', '08453', '8453 42161', 'true', '1e3', '99999999999999999999']) {
      const read = discountPathChains(raw);
      expect('unread' in read, raw).toBe(true);
      const blocker = discountPathBlocker(raw, 8453);
      expect(blocker, raw).toMatch(/is not a chain id, so no chain is armed$/);
      expect(blocker).not.toContain(raw.split(',').pop()!.trim() || '\u0000');
    }
  });

  it('arms nothing when a chain is named twice', () => {
    expect(discountPathBlocker('8453,8453', 8453)).toBe('DISCOUNT_PATH_CHAIN_IDS names chain 8453 twice, so no chain is armed');
  });

  it('states the whole posture, including chains with no liquidator', () => {
    expect(discountPathPosture(undefined)).toBe('DISCOUNT_PATH_CHAIN_IDS is unset, so no chain is armed');
    expect(discountPathPosture('8453,8453')).toBe('DISCOUNT_PATH_CHAIN_IDS names chain 8453 twice, so no chain is armed');
    expect(discountPathPosture('8453,true')).toBe('DISCOUNT_PATH_CHAIN_IDS entry 2 of 2 is not a chain id, so no chain is armed');
    // No chain configures a FlashLoanLiquidator today, so each one says so;
    // a chain absent from the table says that instead.
    expect(discountPathPosture('42161,8453,999')).toBe(
      'DISCOUNT_PATH_CHAIN_IDS arms chains 999 (this build has no flash-loan entry for the chain, so the path stays off there), ' +
        '8453 (no FlashLoanLiquidator configured, so the path stays off there), ' +
        '42161 (no FlashLoanLiquidator configured, so the path stays off there); ' +
        "whether the keeper serves a chain is the tick's `chains resolved` line",
    );
  });
});

describe('flashLoanRoute — the one static reading the branch and the posture share', () => {
  const liquidator = '0x00000000000000000000000000000000000000aa' as const;
  const pool = '0x00000000000000000000000000000000000000bb' as const;
  const vault = '0x00000000000000000000000000000000000000cc' as const;

  it('needs a liquidator AND a provider, naming the first missing', () => {
    expect(flashLoanRoute(1, {})).toEqual({ missing: 'this build has no flash-loan entry for the chain' });
    expect(flashLoanRoute(1, { 1: { aaveV3Pool: pool } })).toEqual({ missing: 'no FlashLoanLiquidator configured' });
    // The Base Sepolia rehearsal shape: a liquidator added, no provider yet.
    expect(flashLoanRoute(1, { 1: { liquidator } })).toEqual({
      missing: 'no flash-loan provider (Aave V3 pool or Balancer V2 vault) configured',
    });
  });

  it('prefers Aave V3, falls back to Balancer V2', () => {
    expect(flashLoanRoute(1, { 1: { liquidator, aaveV3Pool: pool, balancerV2Vault: vault } })).toEqual({
      route: { liquidator, via: 'aave-v3' },
    });
    expect(flashLoanRoute(1, { 1: { liquidator, balancerV2Vault: vault } })).toEqual({
      route: { liquidator, via: 'balancer-v2' },
    });
  });
});
