import { describe, expect, it } from 'vitest';
import { routeChanged, routedDestination, routedLeg, routeNotes } from './payoutCopy';

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
