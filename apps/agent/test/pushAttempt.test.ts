/**
 * `sendPush` reports whether it actually made a request (#2213 r9
 * `4012940120`).
 *
 * The periodic-interest lane spends a per-invocation allowance of outbound
 * requests and cannot see inside this function, which swallows its own
 * failures by design. So "we called sendPush" is not the same question as "a
 * request happened", and charging on the first was wrong in a way that gets
 * worse the more broken the deployment is: a malformed channel key fails every
 * push, so every push is charged for and every recipient the platform COULD
 * have reached over Telegram is deferred behind requests that never left.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendPush } from '../src/push';

const payload = {
  subscriber: '0x1111111111111111111111111111111111111111',
  title: 'Interest due',
  body: 'Pay before the deadline',
};

afterEach(() => vi.restoreAllMocks());

describe('what sendPush says it did', () => {
  it('makes no request, and says so, when the channel key is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendPush(undefined, payload)).toBe('not-requested');
  });

  it('makes no request, and says so, when the channel key is MALFORMED', async () => {
    // The case the truthiness guard could not see: non-empty, so it looked
    // like a usable rail, and unusable, so nothing was ever sent. No network
    // is touched here — the failure happens building the signer.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPush('not-a-private-key', payload)).toBe('not-requested');
    expect(err).toHaveBeenCalled();
  });

  it('does not put the key in the log when it is the thing that is wrong', async () => {
    // A private key is the argument in scope in that branch, so the failure is
    // described by class rather than quoted.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef00';
    await sendPush(secret, payload);
    const said = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).not.toContain(secret);
    expect(said).not.toContain('deadbeef');
  });
});
