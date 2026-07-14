/**
 * RPC read-diet PR A — the rail-health verdict, pinned (design
 * §4.1.1). These states decide whether every stretched hook polls at
 * the 180s net or today's 30s, so each honesty rule gets its own pin:
 * unknown cadence never reads healthy, a wedged cursor (heartbeats
 * flowing, persisted stamp frozen) decays to unhealthy, and a closed
 * socket demotes immediately. The fork e2e tier can't exercise any of
 * this (no WS rail by design — spec 15 pins that posture), so the
 * store's truth table lives here and the live half rides the
 * post-deploy review per COVERAGE.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _railResetForTests,
  isRailHealthy,
  NET_REFRESH_MS,
  railCursorSignal,
  railSocketLive,
  signalAware,
  tipAware,
} from './railHealth';

const CADENCE = 60; // matches the DO's EXPECTED_SCAN_CADENCE_SEC

describe('railHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _railResetForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is unhealthy by default and after socket close', () => {
    expect(isRailHealthy()).toBe(false);
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    expect(isRailHealthy()).toBe(true);
    railSocketLive(false);
    expect(isRailHealthy()).toBe(false);
  });

  it('never reads healthy without a reported cadence (fail-safe)', () => {
    railSocketLive(true);
    railCursorSignal(1_000, null); // older worker: no metadata
    expect(isRailHealthy()).toBe(false);
  });

  it('stays healthy while heartbeats advance the persisted stamp', () => {
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(60_000);
      railCursorSignal(1_000 + i * 60, CADENCE);
      expect(isRailHealthy()).toBe(true);
    }
  });

  it('decays to unhealthy when heartbeats STOP (scans dead, socket open)', () => {
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    expect(isRailHealthy()).toBe(true);
    vi.advanceTimersByTime(CADENCE * 1000 * 1.5 + 1_000);
    expect(isRailHealthy()).toBe(false);
  });

  it('decays to unhealthy when heartbeats flow but the persisted stamp freezes (wedged safe head)', () => {
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    // Heartbeats keep arriving each minute but updatedAt never moves —
    // the PR 0 DO reports the PERSISTED row precisely so this case is
    // detectable.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(60_000);
      railCursorSignal(1_000, CADENCE);
    }
    expect(isRailHealthy()).toBe(false);
  });

  it('a reconnect must re-prove freshness (no inherited stamps)', () => {
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    railSocketLive(false);
    railSocketLive(true); // reconnected, no frame yet
    expect(isRailHealthy()).toBe(false);
    railCursorSignal(2_000, CADENCE);
    expect(isRailHealthy()).toBe(true);
  });

  it('signalAware: 180s net when healthy, idle-aware base otherwise', () => {
    const interval = signalAware(30_000);
    expect(interval()).toBe(30_000); // unhealthy, active session
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    expect(interval()).toBe(NET_REFRESH_MS);
  });

  it('tipAware: stretches only when BOTH rails cover the root', () => {
    const withWs = tipAware(30_000, true);
    const noWs = tipAware(30_000, false);
    railSocketLive(true);
    railCursorSignal(1_000, CADENCE);
    expect(withWs()).toBe(NET_REFRESH_MS);
    // HTTP-only chain: no tip nudge exists, so the interval must stay
    // at today's cadence no matter how healthy the indexer rail is.
    expect(noWs()).toBe(30_000);
  });
});
