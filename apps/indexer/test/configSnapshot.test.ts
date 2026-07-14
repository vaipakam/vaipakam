/**
 * RPC read-diet PR B — the config-snapshot refresh decision, pinned.
 * The explicit event allowlist and the backstop decide when the indexer
 * spends the two `eth_call`s that keep GET /config/:chainId current; a
 * miss means the apps' display config lags governance until the
 * backstop, an over-trigger burns a redundant read per scan.
 */
import { describe, expect, it } from 'vitest';
import {
  isConfigEventName,
  serializeTuple,
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
      // Suffix-shaped lifecycle names the retired /(Set|Updated|Bumped)$/
      // rule wrongly matched (Codex #1231 r1) — pinned as negatives so
      // an allowlist regression can't silently re-trigger on them.
      'NFTStatusUpdated',
      'PrepayListingUpdated',
      // Per-user admin events — they never change the served bundle.
      'KYCTierUpdated',
      'KeeperAccessUpdated',
      'TradeAllowanceSet',
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
    // Stale-marked row (updated_at zeroed after a failed config-event
    // refresh) → the backstop math retries immediately.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: 0, nowSec: now }),
    ).toBe(true);
  });

  it('serializes nested bigint arrays (the uint256[4] tier slots)', () => {
    // A top-level-only map left nested BigInts for JSON.stringify to
    // throw on, which fail-opened every refresh (Codex #1231 r1).
    const json = serializeTuple([
      100n,
      [1n, 2n, 3n, 4n],
      { threshold: 5_000_000_000_000_000_000n },
      true,
      'addr',
    ]);
    expect(JSON.parse(json)).toEqual([
      '100',
      ['1', '2', '3', '4'],
      { threshold: '5000000000000000000' },
      true,
      'addr',
    ]);
  });
});
