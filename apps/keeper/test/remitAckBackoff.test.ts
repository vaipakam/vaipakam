// The ack re-send backoff must outlast CCIP's source finality (2026-11-06:
// a 15-minute backoff re-sent every Arbitrum ack, whose source finality is
// 17 minutes, paying the CCIP fee twice), and must still re-send a lost ack
// well before the operator's overdue alert.
import { describe, expect, it } from 'vitest';
import { ACK_RETRY_BACKOFF_SEC, CCIP_SLOWEST_SOURCE_FINALITY_SEC } from '../src/remitAck';
import { REMIT_OVERDUE_SEC } from '../src/remitRoute';

describe('remitAck re-send backoff', () => {
  it('waits longer than the slowest source finality CCIP waits for', () => {
    expect(ACK_RETRY_BACKOFF_SEC).toBeGreaterThan(CCIP_SLOWEST_SOURCE_FINALITY_SEC);
    // Arbitrum's 17 minutes, the lane that was re-sent.
    expect(ACK_RETRY_BACKOFF_SEC).toBeGreaterThan(17 * 60);
  });

  it('still re-sends a lost ack several times before the remit is overdue', () => {
    expect(ACK_RETRY_BACKOFF_SEC * 4).toBeLessThanOrEqual(REMIT_OVERDUE_SEC);
  });
});
