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
  // `CONSTANTS` is part of the surface `sendPush` uses, so the mock has to
  // carry it (#2220). Omitting it does not fail loudly: `CONSTANTS.ENV.PROD`
  // throws a TypeError INSIDE the try block, which `sendPush` catches and
  // reports as `failed` — a send that looks like a provider rejection and is
  // really a broken test double. That is this issue's own lesson about mocks
  // standing in for the code that breaks, arriving one layer up.
  CONSTANTS: { ENV: { PROD: 'prod' } },
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
 * Signer shapes, and why the compatible one is now the STOCK wallet.
 *
 * Under `@pushprotocol/restapi@0.0.1` these helpers existed because the SDK
 * signed with the ethers-v5 `_signTypedData` while the workspace resolves
 * ethers 6, whose `Wallet` exposes `signTypedData` without the underscore —
 * so a stock v6 wallet could not drive that SDK at all (#2213 r29
 * `4016866267`), and a case meaning to exercise a WORKING rail had to say so.
 *
 * On `1.7.32` (#2220) that is no longer true. The SDK wraps the signer in its
 * own `PushSigner`, which dispatches to a viem account, else `_signTypedData`
 * for ethers v5, else `signTypedData` for ethers v6. A stock `Wallet` is
 * therefore compatible with no help, which is the whole point of the upgrade.
 *
 * What still has to be pinned is the GUARD: a signer that can sign NEITHER
 * way must still be refused without entering the SDK. That is what
 * `withoutAnySigner` is for, and it replaces the old "stock v6 wallet is
 * incompatible" case, whose premise the upgrade retired.
 */
/**
 * `signTypedData` is SHADOWED, not deleted, and that detail is load-bearing.
 *
 * ethers v6 defines it further up the chain than `Wallet.prototype` (it comes
 * from the base wallet class), so `delete Wallet.prototype.signTypedData`
 * removes nothing and the method is still inherited. A first draft of these
 * helpers did exactly that, and the "signs neither way" case passed
 * `accepted` — i.e. the test asserting the guard still exists would have been
 * green while testing nothing. Defining an own property whose value is not a
 * function shadows the inherited one for `typeof`, which is what the guard
 * reads; `restoreSigner` deletes the shadow and the real method reappears.
 */
function withV5OnlySigner() {
  const proto = Wallet.prototype as unknown as Record<string, unknown>;
  proto._signTypedData = async () => '0xsignature';
  proto.signTypedData = undefined;
}
function withoutAnySigner() {
  const proto = Wallet.prototype as unknown as Record<string, unknown>;
  proto.signTypedData = undefined;
  proto._signTypedData = undefined;
}
function restoreSigner() {
  const proto = Wallet.prototype as unknown as Record<string, unknown>;
  delete proto._signTypedData;
  delete proto.signTypedData;
}

afterEach(() => {
  sdkThrows = false;
  restoreSigner();
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
    // No signer help: on 1.7.32 the stock ethers-v6 wallet is what production
    // has AND what the SDK accepts, so this case now exercises exactly the
    // production pair (#2220).
    const sdk = await import('@pushprotocol/restapi');
    const send = vi.mocked(sdk.payloads.sendNotification);
    send.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('accepted');
    // And it still targets production. `env` became a typed enum in 1.7.32;
    // the runtime value must not have moved with the type, because a silent
    // retarget to staging would look exactly like a working rail and deliver
    // to nobody.
    expect(send.mock.calls[0]?.[0]).toMatchObject({ env: 'prod' });
  });

  it('reports a request it made and could NOT confirm', async () => {
    // #2213 r10 `4013087415`. The distinction the caller needs: a request went
    // out, so the allowance is spent, and nobody can say the message arrived,
    // so it is not a reminder. Folding this into either neighbour is what let
    // a run claim deliveries it had no evidence for.
    //
    // Stock signer: the guard passes, the SDK is entered, and it throws — so
    // this exercises the throw-after-entry branch rather than the refusal.
    sdkThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPush(usableKey, payload)).toBe('failed');
  });

  it('makes no request when the signer can sign NEITHER way', async () => {
    // The surviving half of #2213 r29 `4016866267`. The original case pinned
    // "stock ethers-v6 wallet against an SDK that calls `_signTypedData`",
    // and #2220 retired that premise by correcting the pin — on 1.7.32 the
    // SDK accepts v5 and v6 alike, so there is no disagreement left to pin.
    //
    // What must NOT be lost with it is the guard itself: a signer exposing
    // neither method still has to be refused BEFORE the SDK is entered. The
    // consequence is the one r29 established — landing in `failed` instead
    // would charge the invocation's allowance for a request nobody made and
    // call the attempt one whose fate is unknown, and since r28 an unknown
    // BLOCKS the retry of a Telegram message the service merely deferred. A
    // rail that cannot issue anything must not suppress the rail that can.
    withoutAnySigner();
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

  it('accepts an ethers-v5 style signer too, because the SDK does', async () => {
    // 1.7.32's `PushSigner.signTypedData` dispatches on `_signTypedData`
    // before `signTypedData` (`src/lib/helpers/signer.js:52-58`), so a v5
    // signer is genuinely usable and the guard must not refuse it. This is
    // the case that would fail if the check were narrowed back to "has
    // `signTypedData`" — the mirror-image of the bug #2220 fixed, and just as
    // invisible, since the lane would report `not-requested` and look exactly
    // like an unset key.
    withV5OnlySigner();
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
