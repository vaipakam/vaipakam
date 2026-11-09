import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { billingOn, CONSENT_CEILING, consentProblem, consentRouting, measureConsent, NOTIFICATION_FEE, parseCap, storedCap, type PaidPushFacts } from './paidPush';
import type { PushStatus } from './alerts';

const DIAMOND = '0x00000000000000000000000000000000000d1a00' as const;
const ME = '0xabcdef0000000000000000000000000000000001' as const;
const VPFI = 10n ** 18n;
const copy = { text: (k: string) => k, format: (k: string, v: Record<string, string>) => `${k}:${Object.values(v).join(',')}` };

const facts = (over: Partial<PaidPushFacts> = {}): PaidPushFacts => ({ fee: VPFI / 2n, cap: 0n, covers: false, frozen: null, ...over });

describe('billing and routing', () => {
  it('reads billing from the service answer, unknown without one', () => {
    const push: PushStatus = { kind: 'available', channel: DIAMOND, scope: 'service', billedChainIds: [84532] };
    expect(billingOn(push, 84532)).toBe('charges');
    expect(billingOn(push, 97)).toBe('free');
    expect(billingOn(null, 84532)).toBe('unknown');
  });
  it('tells a deployment with no consent record whether it can still bill', () => {
    expect(consentRouting(null, '0x01', '0x02')).toBe('checking');
    expect(consentRouting(new Set(['0x01', '0x02']), '0x01', '0x02')).toBe('consent');
    expect(consentRouting(new Set(['0x02']), '0x01', '0x02')).toBe('no-consent-bills');
    expect(consentRouting(new Set([]), '0x01', '0x02')).toBe('no-consent-no-bill');
  });
});

describe('a cap', () => {
  it('is a plain VPFI decimal', () => {
    expect(parseCap(' 2.5 ')).toBe(25n * 10n ** 17n);
    expect(parseCap('50')).toBe(CONSENT_CEILING);
    expect(parseCap('1e1')).toBeNull();
    expect(parseCap('-1')).toBeNull();
    expect(parseCap('')).toBeNull();
    expect(parseCap('0.0000000000000000001')).toBeNull();
  });
});

describe('what may be sent', () => {
  it('always lets a stored agreement be withdrawn', () => {
    expect(consentProblem({ kind: 'withdraw' }, facts({ cap: VPFI, frozen: 'flagged' }), 'unknown')).toBeNull();
    expect(consentProblem({ kind: 'withdraw' }, facts(), 'charges')).toBe('nothing-stored');
  });
  it('agrees only where the service charges, at or above the fee and within the ceiling', () => {
    expect(consentProblem({ kind: 'agree', cap: VPFI / 2n }, facts(), 'charges')).toBeNull();
    expect(consentProblem({ kind: 'agree', cap: VPFI / 2n }, facts(), 'free')).toBe('not-billed');
    expect(consentProblem({ kind: 'agree', cap: VPFI / 2n }, facts(), 'unknown')).toBe('billing-unknown');
    expect(consentProblem({ kind: 'agree', cap: VPFI / 4n }, facts(), 'charges')).toBe('below-fee');
    expect(consentProblem({ kind: 'agree', cap: CONSENT_CEILING + 1n }, facts(), 'charges')).toBe('above-ceiling');
    expect(consentProblem({ kind: 'agree', cap: VPFI }, facts({ cap: VPFI }), 'charges')).toBe('same-cap');
    expect(consentProblem({ kind: 'agree', cap: VPFI }, facts({ frozen: 'flagged' }), 'charges')).toBe('flagged');
    // Agreeing moves nothing and the bill screens the payer itself.
    expect(consentProblem({ kind: 'agree', cap: VPFI }, facts({ frozen: 'outage' }), 'charges')).toBeNull();
  });
});

describe('the record', () => {
  function consentLog(user: `0x${string}`, previous: bigint, cap: bigint, address: `0x${string}` = DIAMOND): Log {
    return {
      address,
      topics: encodeEventTopics({ abi: NOTIFICATION_FEE, eventName: 'NotificationFeeConsentSet', args: { user } }) as Log['topics'],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [previous, cap]),
      blockHash: null,
      blockNumber: null,
      logIndex: null,
      transactionHash: null,
      transactionIndex: null,
      removed: false,
    } as Log;
  }
  it('names the cap stored for this wallet by this Diamond only', () => {
    expect(storedCap([consentLog(ME, 0n, VPFI)], DIAMOND, ME)).toBe(VPFI);
    expect(storedCap([consentLog(ME, 0n, VPFI, '0x00000000000000000000000000000000000000ff')], DIAMOND, ME)).toBeNull();
    expect(storedCap([consentLog('0x00000000000000000000000000000000000000ee', 0n, VPFI)], DIAMOND, ME)).toBeNull();
  });
  it('measures an agreement, a withdrawal, and a record that names none', () => {
    expect(measureConsent([consentLog(ME, 0n, VPFI)], DIAMOND, ME, { kind: 'agree', cap: VPFI }, copy)).toEqual([{ status: 'done', label: 'paidPush.legAgreed:1' }]);
    expect(measureConsent([consentLog(ME, VPFI, 0n)], DIAMOND, ME, { kind: 'withdraw' }, copy)).toEqual([{ status: 'done', label: 'paidPush.legWithdrawn' }]);
    expect(measureConsent([], DIAMOND, ME, { kind: 'withdraw' }, copy)).toEqual([{ status: 'not-done', label: 'paidPush.withdrawTitle', reason: 'paidPush.notRecorded' }]);
  });
});
