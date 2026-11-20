import { describe, expect, it } from 'vitest';
import { isOpeningRoute } from './closedNetworkRoutes';

describe('screens a Closed network replaces (#3858)', () => {
  it('replaces every screen that opens a position', () => {
    for (const p of ['/', '/borrow', '/lend/', '/rent', '/offers', '/marketplace', '/faucet', '/BORROW', '/fr/lend']) {
      expect(isOpeningRoute(p), p).toBe(true);
    }
  });

  it('keeps every way out and every record reachable', () => {
    for (const p of ['/vault', '/claims', '/positions', '/positions/7', '/activity', '/settings', '/help', '/desk', '/recover', '/vpfi', '/lending']) {
      expect(isOpeningRoute(p), p).toBe(false);
    }
  });
});
