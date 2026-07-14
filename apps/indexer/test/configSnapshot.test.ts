/**
 * RPC read-diet PR B — the config-snapshot refresh decision, pinned.
 * The suffix rule and the backstop decide when the indexer spends the
 * two `eth_call`s that keep GET /config/:chainId current; a miss means
 * the apps' display config lags governance until the backstop, an
 * over-trigger burns a redundant read per scan.
 */
import { describe, expect, it } from 'vitest';
import {
  isConfigEventName,
  shouldRefreshConfig,
} from '../src/configSnapshot';

describe('configSnapshot', () => {
  it('matches every governance setter shape (representatives)', () => {
    for (const name of [
      'FeesConfigSet',
      'RiskConfigSet',
      'MaxOfferDurationDaysSet',
      'PartialFillEnabledSet',
      'SanctionsOracleSet',
      'GraceBucketsUpdated',
      'AssetMinPartialBpsUpdated',
      'TierTableVersionBumped',
    ]) {
      expect(isConfigEventName(name), name).toBe(true);
    }
  });

  it('never matches domain lifecycle events', () => {
    for (const name of [
      'OfferCreated',
      'OfferAccepted',
      'OfferCanceled',
      'LoanInitiated',
      'LoanRepaid',
      'LoanDefaulted',
      'Transfer',
      'PartialRepaid',
      'InternalMatchExecuted',
    ]) {
      expect(isConfigEventName(name), name).toBe(false);
    }
  });

  it('refreshes on config events, bootstrap, and the backstop — not otherwise', () => {
    const now = 1_000_000;
    // Config event in the scan → always refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: true, rowUpdatedAt: now, nowSec: now }),
    ).toBe(true);
    // No row yet (bootstrap) → refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: null, nowSec: now }),
    ).toBe(true);
    // Fresh row, quiet scan → skip (this is the steady state).
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 60,
        nowSec: now,
      }),
    ).toBe(false);
    // Row older than the 6h backstop → refresh.
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 7 * 3600,
        nowSec: now,
      }),
    ).toBe(true);
  });
});
