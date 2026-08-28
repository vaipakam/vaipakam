/**
 * The exit is never gated (#1961, review round 1 P1).
 *
 * The gate's own footnote promises repaying, claiming and withdrawing
 * are never blocked by it, and the first cut wrapped every route, so the
 * promise and the code disagreed. These cases pin the promise: they are
 * about which routes a user in ANY terms state can still reach.
 */
import { describe, expect, it } from 'vitest';
import { isExitRoute } from './tosExitRoutes';

describe('isExitRoute', () => {
  it('exempts every route carrying an exit action', () => {
    for (const path of [
      '/positions',
      '/positions/7',
      '/claims',
      '/vpfi',
      '/vault',
      '/recover',
    ]) {
      expect(isExitRoute(path), path).toBe(true);
    }
  });

  it('exempts the desk, which hosts the only signed-order cancel', () => {
    // Review round 5 P1. `/desk` renders `OpenOrdersPanel`, the ONLY
    // place a live signed order can be cancelled. Gating it left a user
    // who declined new Terms unable to revoke a standing order that
    // anyone holding the signed row could still fill — the gate
    // creating the exposure it was meant to withhold.
    //
    // Safe to exempt only BECAUSE enforcement moved to the writes: the
    // desk's order-creating controls are refused by `tosWriteGate.ts`
    // whatever route they are pressed from.
    expect(isExitRoute('/desk')).toBe(true);
  });

  it('exempts the aliases that redirect into them', () => {
    // An alias renders its <Navigate> INSIDE the gate, so holding the
    // alias means the redirect never runs and the exit is unreachable
    // by the URL a user actually has.
    for (const path of [
      '/loans',
      '/loans/7',
      '/app/loans/7',
      '/dashboard',
      '/manage',
      '/claim',
      '/claim-center',
      '/trade',
      '/terminal',
      '/vpfi-vault',
      '/vault-assets',
    ]) {
      expect(isExitRoute(path), path).toBe(true);
    }
  });

  it('gates the routes that take on new exposure', () => {
    for (const path of [
      '/',
      '/borrow',
      '/lend',
      '/rent',
      '/offers',
      '/activity',
      '/faucet',
      '/settings',
      '/help',
      '/nft',
      '/risk-access',
    ]) {
      expect(isExitRoute(path), path).toBe(false);
    }
  });

  it('does not let a lookalike route inherit an exemption', () => {
    // A gate that can be widened by naming a route carefully is not a
    // gate; the prefix match stops at a segment boundary.
    for (const path of ['/vaults-of-x', '/positionsomething', '/claiming', '/recovery']) {
      expect(isExitRoute(path), path).toBe(false);
    }
  });

  it('ignores a trailing slash', () => {
    expect(isExitRoute('/claims/')).toBe(true);
    expect(isExitRoute('/borrow/')).toBe(false);
  });

  it('exempts regardless of case', () => {
    // React Router matches route declarations case-insensitively, so
    // `/POSITIONS/7` renders the same page. A case-sensitive exemption
    // would block repayment for anyone whose bookmark or inbound link
    // differed in case.
    expect(isExitRoute('/POSITIONS/7')).toBe(true);
    expect(isExitRoute('/Claims')).toBe(true);
    expect(isExitRoute('/VPFI')).toBe(true);
    expect(isExitRoute('/Loans/7')).toBe(true);
    // ...and case does not smuggle a gated route past the exemption.
    expect(isExitRoute('/BORROW')).toBe(false);
    expect(isExitRoute('/Offers')).toBe(false);
  });
});
