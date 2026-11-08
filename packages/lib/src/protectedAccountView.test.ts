import { describe, expect, it } from 'vitest';
import { protectedAccountFromView } from './protectedAccountView';

describe('protectedAccountFromView', () => {
  it('maps the renamed retired* fields to the consumer names', () => {
    const v = protectedAccountFromView({ enabled: true, retiredProtectNfts: true, retiredPendingNftOffAt: 9n });
    expect(v).toEqual({ enabled: true, protectNfts: true, pendingNftOffAt: 9n });
  });
  it('passes an old-named decoding through', () => {
    expect(protectedAccountFromView({ protectNfts: false, pendingNftOffAt: 3n })).toEqual({ protectNfts: false, pendingNftOffAt: 3n });
  });
  it('never yields undefined for the pending time', () => {
    expect(protectedAccountFromView({ enabled: false }).pendingNftOffAt).toBe(0n);
  });
});
