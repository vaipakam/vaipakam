import { describe, it, expect } from 'vitest';
import {
  watermarkPolicy,
  pushBackedInterval,
  PUSH_BACKED_MIN_INTERVAL_MS,
} from '../../src/hooks/watermarkPolicy';

describe('#843 delta 1 — adaptive polling (pushBackedInterval)', () => {
  const hot = watermarkPolicy('hot').pollIntervalMs!; // 5_000
  const warm = watermarkPolicy('warm').pollIntervalMs!; // 30_000
  const cool = watermarkPolicy('cool').pollIntervalMs!; // 180_000

  it('relaxes faster-than-floor tiers to the push-backed floor when push is healthy', () => {
    // hot (5 s) and warm (30 s) are below the 60 s floor → raised to the floor.
    expect(pushBackedInterval(hot, true)).toBe(PUSH_BACKED_MIN_INTERVAL_MS);
    expect(pushBackedInterval(warm, true)).toBe(PUSH_BACKED_MIN_INTERVAL_MS);
  });

  it('leaves already-slower tiers untouched when push is healthy (floor never speeds up)', () => {
    // cool (180 s) is already slower than the 60 s floor → unchanged.
    expect(pushBackedInterval(cool, true)).toBe(cool);
  });

  it('restores the full tier cadence the moment push is unhealthy (degradation)', () => {
    // disconnect / polling fallback → today's cadence, unchanged, for every tier.
    expect(pushBackedInterval(hot, false)).toBe(hot);
    expect(pushBackedInterval(warm, false)).toBe(warm);
    expect(pushBackedInterval(cool, false)).toBe(cool);
  });

  it('never CREATES poll demand: null (no subscribers / all paused) stays null', () => {
    expect(pushBackedInterval(null, true)).toBeNull();
    expect(pushBackedInterval(null, false)).toBeNull();
  });

  it('is monotonic: a push-backed interval is always >= the tier interval', () => {
    for (const tier of [hot, warm, cool]) {
      expect(pushBackedInterval(tier, true)!).toBeGreaterThanOrEqual(tier);
    }
  });
});
