import { describe, it, expect } from 'vitest';
import { TX_DEADLINE_SECONDS, txValidUntil } from './txDeadline';

describe('txValidUntil', () => {
  it('adds the one window to the chain time', () => {
    expect(TX_DEADLINE_SECONDS).toBe(1800);
    expect(txValidUntil(1_700_000_000n)).toBe(1_700_001_800n);
  });
});
