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
import { Wallet } from 'ethers';

/** Whether the pinned Push SDK resolves or throws for this case. */
let sdkThrows = false;
vi.mock('@pushprotocol/restapi', () => ({
  payloads: {
    sendNotification: vi.fn(async () => {
      if (sdkThrows) throw new Error('channel not found');
      return { status: 204 };
    }),
  },
}));

const { sendPush } = await import('../src/push');

/** A throwaway key, generated per run so none is ever written down. */
const usableKey = Wallet.createRandom().privateKey;

const payload = {
  subscriber: '0x1111111111111111111111111111111111111111',
  title: 'Interest due',
  body: 'Pay before the deadline',
};

/**
 * Give the wallet the method the pinned SDK actually calls.
 *
 * `@pushprotocol/restapi@0.0.1` signs with the ethers-v5 `_signTypedData`,
 * and the workspace resolves ethers 6, whose `Wallet` has `signTypedData`
 * without the underscore — so a stock v6 wallet cannot drive that SDK at all
 * (#2213 r29 `4016866267`). The cases below that mean to exercise a WORKING
 * rail have to say so explicitly; before r29 they were silently exercising a
 * rail that cannot work in production, because the SDK is mocked here and the
 * mock does not sign.
 */
function withCompatibleSigner() {
  (Wallet.prototype as unknown as Record<string, unknown>)._signTypedData =
    async () => '0xsignature';
}
function removeCompatibleSigner() {
  delete (Wallet.prototype as unknown as Record<string, unknown>)._signTypedData;
}

afterEach(() => {
  sdkThrows = false;
  removeCompatibleSigner();
  vi.restoreAllMocks();
});

describe('what sendPush says it did', () => {
  it('makes no request, and says so, when the channel key is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendPush(undefined, payload)).toBe('not-requested');
  });

  it('makes no request, and says so QUIETLY, when the channel key is MALFORMED', async () => {
    // The case the truthiness guard could not see: non-empty, so it looked
    // like a usable rail, and unusable, so nothing was ever sent. No network
    // is touched here — the failure happens building the signer.
    //
    // AND IT DOES NOT LOG (#2213 r24 `4015538623`). This is a property of the
    // DEPLOYMENT, not of this recipient: a malformed key fails for every
    // subscriber, so a line here printed the identical message once per
    // attempted recipient — on a wide window, the log flood that turns a real
    // configuration failure into background noise. The caller reports it once
    // per chain per run with a count, which is the only place that can see
    // how many were affected.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPush('not-a-private-key', payload)).toBe('not-requested');
    expect(err).not.toHaveBeenCalled();
  });

  it('reports a request it made and the provider accepted', async () => {
    withCompatibleSigner();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('accepted');
  });

  it('reports a request it made and could NOT confirm', async () => {
    // #2213 r10 `4013087415`. The distinction the caller needs: a request went
    // out, so the allowance is spent, and nobody can say the message arrived,
    // so it is not a reminder. Folding this into either neighbour is what let
    // a run claim deliveries it had no evidence for.
    withCompatibleSigner();
    sdkThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('failed');
  });

  it('makes no request when the SDK and the wallet disagree about signing', async () => {
    // #2213 r29 `4016866267`, and the finding is about the CHECKED dependency
    // set rather than a hypothetical: `@pushprotocol/restapi@0.0.1` calls the
    // ethers-v5 `signer._signTypedData` in `payloads/helpers.js`, before its
    // POST, and `pnpm-lock.yaml` resolves it against ethers 6.16, whose
    // `Wallet` exposes `signTypedData` instead. Every Push send on this
    // deployment therefore throws inside the SDK having issued nothing.
    //
    // It used to land in the `failed` branch, which charged the invocation's
    // allowance for a request nobody made and called the attempt one whose
    // fate is unknown — and since r28 an unknown BLOCKS the retry of a
    // Telegram message the service merely deferred. A rail that cannot issue
    // anything was suppressing the retry of the rail that can.
    //
    // No `withCompatibleSigner()` here: this is the stock v6 wallet, which is
    // what production has.
    const sdk = await import('@pushprotocol/restapi');
    const send = vi.mocked(sdk.payloads.sendNotification);
    send.mockClear();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('not-requested');
    // The SDK was never entered, so nothing could have gone out...
    expect(send).not.toHaveBeenCalled();
    // ...and it is silent, like the other deployment-wide branches: the
    // caller discloses it once per chain per run with a count, rather than
    // once per recipient.
    expect(err).not.toHaveBeenCalled();
  });

  it('takes the normal path again if the SDK is ever made compatible', async () => {
    // The check asks a CAPABILITY question rather than matching an error
    // message, so an upgrade that fixes the pair needs no change here. Stated
    // as a test because the alternative — a classifier over exception text —
    // is what this PR has argued against twice, and it would silently keep
    // refusing after the upgrade.
    withCompatibleSigner();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('accepted');
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
