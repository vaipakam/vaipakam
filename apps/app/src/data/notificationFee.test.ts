/**
 * #2723 — what the Alerts card may say and offer about the paid-Push billing
 * consent. Every combination of the service's billing answer, the wallet's
 * on-chain record and the vault's free VPFI is pinned here, so the JSX only
 * renders a decision it did not make.
 */
import { describe, expect, it } from 'vitest';
import {
  paidPushBilledOn,
  paidPushConsentScope,
  paidPushConsentView,
  type NotificationFeeConsent,
} from './notificationFee';
import type { PushBillingState } from './alerts';

const FEE = 5n * 10n ** 17n; // 0.5 VPFI
const BASE_SEPOLIA = 84532;
const billedHere: PushBillingState = { kind: 'known', chainIds: [BASE_SEPOLIA] };
const billedNowhere: PushBillingState = { kind: 'known', chainIds: [] };
const billedElsewhere: PushBillingState = { kind: 'known', chainIds: [421614] };

const consent = (capVpfi: bigint, coversCurrentFee: boolean): NotificationFeeConsent => ({
  feeVpfi: FEE,
  capVpfi,
  coversCurrentFee,
});
const view = (
  billing: PushBillingState | undefined,
  c: NotificationFeeConsent,
  freeVpfi: bigint | undefined = 10n ** 18n,
  stale = false,
) => paidPushConsentView({ billing, chainId: BASE_SEPOLIA, consent: c, freeVpfi, stale });

describe('paidPushConsentScope', () => {
  it('is one wallet on one network, case-insensitive on the address', () => {
    const a = '0xAbC0000000000000000000000000000000000001';
    const b = '0xabc0000000000000000000000000000000000002';
    expect(paidPushConsentScope(BASE_SEPOLIA, a)).toBe(paidPushConsentScope(BASE_SEPOLIA, a.toLowerCase()));
    expect(paidPushConsentScope(BASE_SEPOLIA, a)).not.toBe(paidPushConsentScope(BASE_SEPOLIA, b));
    expect(paidPushConsentScope(BASE_SEPOLIA, a)).not.toBe(paidPushConsentScope(421614, a));
    expect(paidPushConsentScope(BASE_SEPOLIA, a)).not.toBe(paidPushConsentScope(BASE_SEPOLIA, undefined));
  });
});

describe('paidPushBilledOn', () => {
  it('is the service’s answer for THIS network, and unknown when it gave none', () => {
    expect(paidPushBilledOn(billedHere, BASE_SEPOLIA)).toBe('billed');
    expect(paidPushBilledOn(billedElsewhere, BASE_SEPOLIA)).toBe('not-billed');
    expect(paidPushBilledOn(billedNowhere, BASE_SEPOLIA)).toBe('not-billed');
    expect(paidPushBilledOn({ kind: 'unknown' }, BASE_SEPOLIA)).toBe('unknown');
    expect(paidPushBilledOn(undefined, BASE_SEPOLIA)).toBe('unknown');
  });
});

describe('paidPushConsentView', () => {
  it('offers agreeing only where the service bills, and only until the record covers the fee', () => {
    expect(view(billedHere, consent(0n, false)).offerAgree).toBe(true);
    expect(view(billedHere, consent(FEE - 1n, false)).offerAgree).toBe(true);
    expect(view(billedHere, consent(FEE, true)).offerAgree).toBe(false);
    for (const billing of [billedNowhere, billedElsewhere, { kind: 'unknown' } as const, undefined]) {
      expect(view(billing, consent(0n, false)).offerAgree).toBe(false);
      expect(view(billing, consent(FEE - 1n, false)).offerAgree).toBe(false);
    }
  });

  it('holds agreeing on a last-known record, and keeps withdrawing offered', () => {
    expect(view(billedHere, consent(0n, false), 10n ** 18n, true).offerAgree).toBe(false);
    expect(view(billedHere, consent(FEE - 1n, false), 10n ** 18n, true).offerAgree).toBe(false);
    expect(view(billedHere, consent(FEE - 1n, false), 10n ** 18n, true).offerWithdraw).toBe(true);
    expect(view(billedNowhere, consent(FEE, true), 10n ** 18n, true).offerWithdraw).toBe(true);
  });

  it('offers withdrawing whenever any cap is stored, whatever the billing posture', () => {
    for (const billing of [billedHere, billedNowhere, { kind: 'unknown' } as const, undefined]) {
      expect(view(billing, consent(FEE, true)).offerWithdraw).toBe(true);
      expect(view(billing, consent(1n, false)).offerWithdraw).toBe(true);
      expect(view(billing, consent(0n, false)).offerWithdraw).toBe(false);
    }
  });

  it('reports the record as the contract judges it', () => {
    expect(view(billedHere, consent(0n, false)).consent).toBe('none');
    expect(view(billedHere, consent(FEE, true)).consent).toBe('covers');
    expect(view(billedHere, consent(FEE - 1n, false)).consent).toBe('below');
    // The contract's `coversCurrentFee` is the bill's own check, so it is
    // reported as given rather than recomputed from the figures.
    expect(view(billedHere, consent(FEE * 2n, false)).consent).toBe('below');
  });

  it('warns about a short vault only where a covering consent could be billed', () => {
    expect(view(billedHere, consent(FEE, true), FEE - 1n).lowVaultBalance).toBe(true);
    expect(view(billedHere, consent(FEE, true), FEE).lowVaultBalance).toBe(false);
    // An unknown balance is not a short one.
    expect(view(billedHere, consent(FEE, true), undefined).lowVaultBalance).toBe(false);
    // No consent, or no billing here: nothing would be charged, so no warning.
    expect(view(billedHere, consent(0n, false), 0n).lowVaultBalance).toBe(false);
    expect(view(billedNowhere, consent(FEE, true), 0n).lowVaultBalance).toBe(false);
    expect(view(undefined, consent(FEE, true), 0n).lowVaultBalance).toBe(false);
  });
});
