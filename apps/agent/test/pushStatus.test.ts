/**
 * The app learns whether Push can be sent from the agent, not from its own
 * build-time channel address (#2251), and a Push opt-in is stored only where
 * the rail can honour it.
 *
 * Runs against the REAL shared rail (`@vaipakam/push`); nothing here sends,
 * because the status and the opt-in decision are answered without a request.
 */
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { decidePushOptIn, handlePushStatus } from '../src/pushRail';

const ORIGIN = 'https://app.vaipakam.com';
/** A throwaway key, generated per run so none is ever written down. */
const key = generatePrivateKey();

async function statusFor(env: { PUSH_CHANNEL_PK?: string; PUSH_CHANNEL_ADDRESS?: string }) {
  const res = handlePushStatus(env, ORIGIN);
  expect(res.status).toBe(200);
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /push/status', () => {
  it('says the rail is unavailable, and why, when no key is set', async () => {
    expect(await statusFor({})).toEqual({
      available: false,
      reason: 'signer-unset',
      scope: 'agent',
    });
  });

  it('says so for a key that is set and unusable — the case that used to look configured', async () => {
    expect(await statusFor({ PUSH_CHANNEL_PK: 'not-a-key' })).toEqual({
      available: false,
      reason: 'signer-malformed',
      scope: 'agent',
    });
  });

  it('names the channel the rail posts as, which is what the app links to', async () => {
    const own = privateKeyToAddress(key);
    expect(await statusFor({ PUSH_CHANNEL_PK: key })).toEqual({
      available: true,
      channel: own,
      scope: 'agent',
    });
    const configured = '0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b';
    expect(
      await statusFor({ PUSH_CHANNEL_PK: key, PUSH_CHANNEL_ADDRESS: configured }),
    ).toEqual({ available: true, channel: configured, scope: 'agent' });
  });

  it('never carries any part of the key', async () => {
    const body = JSON.stringify(await statusFor({ PUSH_CHANNEL_PK: key }));
    expect(body).not.toContain(key.slice(2, 18));
  });
});

describe('what a settings save does with a Push opt-in', () => {
  const save = { wallet: '0x1DAefA360ED370285f003Fa2d92DB75628088282', push_channel: 'subscribed' };

  it('stores it when the rail can send', () => {
    expect(decidePushOptIn(save, { usable: true })).toEqual({ write: save, push: 'stored' });
  });

  it('drops ONLY the push field when the rail cannot send, and says so', () => {
    const { write, push } = decidePushOptIn(save, { usable: false });
    expect(push).toBe('unavailable');
    // The rest of the save stands; a null push field leaves a STORED opt-in
    // in place (the write keeps a stored channel when the field is absent).
    expect(write).toEqual({ ...save, push_channel: null });
  });

  it('reports nothing about Push for a save that carried no opt-in', () => {
    const plain = { ...save, push_channel: null };
    expect(decidePushOptIn(plain, { usable: false })).toEqual({
      write: plain,
      push: 'not-requested',
    });
  });
});
