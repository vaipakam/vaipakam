/**
 * #2251 — the agent's `GET /push/status` body is read strictly. Only the two
 * documented shapes mean anything; every other answer is `unknown`, which the
 * Alerts card states rather than reading as "available" or "unavailable".
 */
import { describe, it, expect } from 'vitest';
import { parsePushStatus } from './alerts';

const CHANNEL = '0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b';

describe('parsePushStatus', () => {
  it('reads an available rail and links to the channel the agent posts as', () => {
    expect(parsePushStatus({ available: true, channel: CHANNEL, scope: 'agent' })).toEqual({
      kind: 'available',
      channel: CHANNEL,
      channelUrl: `https://app.push.org/channels/${CHANNEL}`,
      scope: 'agent',
    });
  });

  it('reads an unavailable rail, whatever the reason', () => {
    expect(parsePushStatus({ available: false, reason: 'signer-unset', scope: 'agent' })).toEqual({
      kind: 'unavailable',
      scope: 'agent',
    });
  });

  // Codex #2665 r1 — the answer covers ONE sender's rail; whose is kept, and
  // an answer that does not say is not used.
  it('keeps whose rail the answer covers, and refuses an unscoped answer', () => {
    expect(parsePushStatus({ available: true, channel: CHANNEL, scope: 'service' })).toMatchObject({
      kind: 'available',
      scope: 'service',
    });
    expect(parsePushStatus({ available: true, channel: CHANNEL })).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({ available: false, reason: 'signer-unset' })).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({ available: true, channel: CHANNEL, scope: 'keeper' })).toEqual({
      kind: 'unknown',
    });
  });

  it('treats anything else as unknown, never as either answer', () => {
    expect(parsePushStatus(null)).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({})).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({ available: true })).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({ available: true, channel: '0x1234' })).toEqual({ kind: 'unknown' });
    expect(parsePushStatus({ available: 'yes', channel: CHANNEL, scope: 'agent' })).toEqual({
      kind: 'unknown',
    });
    expect(parsePushStatus({ available: true, channel: '0x1234', scope: 'agent' })).toEqual({
      kind: 'unknown',
    });
  });
});
