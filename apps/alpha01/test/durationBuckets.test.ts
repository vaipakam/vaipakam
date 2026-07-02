import { describe, expect, it } from 'vitest';
import {
  OFFER_DURATION_BUCKETS_DAYS,
  OFFER_DURATION_DEFAULT_DAYS,
  formatDurationBucketLabel,
} from '@vaipakam/defi-client';

describe('duration buckets', () => {
  it('includes the default duration', () => {
    expect(OFFER_DURATION_BUCKETS_DAYS).toContain(OFFER_DURATION_DEFAULT_DAYS);
  });

  it('formats bucket labels for the picker', () => {
    expect(formatDurationBucketLabel(30)).toBe('30 days');
    expect(formatDurationBucketLabel(365)).toBe('1 year');
  });
});