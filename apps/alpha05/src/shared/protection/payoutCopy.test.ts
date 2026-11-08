import { describe, expect, it } from 'vitest';
import { payoutLegs, routeChanged, routedDestination, routedLeg, routeNotes } from './payoutCopy';

const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const on = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false };

describe('payout copy', () => {
  it('leaves the plain wallet route and an unread mode to the flow', () => {
    expect(routedDestination('wallet', on, copy)).toBeNull();
    expect(routedDestination('unknown', null, copy)).toBeNull();
    expect(routeNotes('wallet', on, copy)).toEqual([]);
    expect(routeNotes('unknown', null, copy)).toEqual(['payout.protectionUnread']);
  });
  it('names a secondary signer on a queued payment only while the account requires one', () => {
    expect(routedDestination('queued', { ...on, requireCosign: true }, copy)).toBe('payout.toQueuedCosign');
    expect(routeNotes('queued', { ...on, requireCosign: true }, copy)).toEqual(['payout.queuedNote', 'payout.cosignNote']);
    expect(routeNotes('vault', { ...on, requireCosign: true }, copy)).toEqual(['payout.vaultNote']);
    expect(routedLeg({ kind: 'queued', amount: 1n, releaseAt: 1n }, '1', { ...on, requireCosign: true }, copy)).toBe('payout.legQueuedCosign');
    expect(routedLeg({ kind: 'held', amount: 1n }, '1', on, copy)).toBe('payout.legHeld');
    expect(routedLeg({ kind: 'vault', amount: 1n }, '1', on, copy)).toBe('payout.legVault');
  });
  it('counts a delay or a secondary signer as a change only on a queued payment', () => {
    expect(routeChanged({ route: 'queued', protection: on }, { route: 'queued', protection: { ...on, delaySeconds: 1 } })).toBe(true);
    expect(routeChanged({ route: 'vault', protection: on }, { route: 'vault', protection: { ...on, delaySeconds: 1 } })).toBe(false);
    expect(routeChanged({ route: 'wallet', protection: on }, { route: 'queued', protection: on })).toBe(true);
  });
});

describe('payoutLegs', () => {
  const base = {
    wallet: 0n,
    protection: on,
    what: (v: bigint) => v.toString(),
    exact: (v: bigint) => v.toString(),
    walletLeg: (w: string) => `wallet ${w}`,
    walletOther: (g: string, e: string) => `wallet ${g}/${e}`,
  };
  it('states each place a split payment went and counts them together', () => {
    const legs = payoutLegs(
      {
        ...base,
        outcomes: [
          { kind: 'queued', amount: 7n, releaseAt: 1n },
          { kind: 'held', amount: 5n },
        ],
        expected: 12n,
      },
      copy,
    );
    expect(legs).toEqual([
      { status: 'done', label: 'payout.legQueued' },
      { status: 'done', label: 'payout.legHeld' },
    ]);
  });
  it('flags a total short of the review on the last leg', () => {
    const legs = payoutLegs({ ...base, outcomes: [{ kind: 'queued', amount: 7n, releaseAt: 1n }], expected: 12n }, copy);
    expect(legs.at(-1)).toMatchObject({ status: 'unknown', reason: 'payout.totalOther' });
    expect(payoutLegs({ ...base, outcomes: [], expected: 3n }, copy)).toEqual([{ status: 'not-done', label: 'wallet 0', reason: 'wallet 0/3' }]);
  });
});
