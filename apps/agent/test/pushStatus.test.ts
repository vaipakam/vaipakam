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
  const never = async (): Promise<boolean> => {
    throw new Error('the stored opt-in is read only when it can matter');
  };

  it('stores it when the rail can send', async () => {
    expect(await decidePushOptIn(save, { usable: true }, never)).toEqual({
      write: save,
      push: 'stored',
    });
  });

  // Codex #2665 r1 — a 2xx here would read as "stored" to an app bundle from
  // before this change, so a NEW opt-in the rail cannot honour refuses the
  // whole save (the handler answers 409 and stores nothing).
  it('refuses the whole save for a NEW opt-in the rail cannot send', async () => {
    expect(await decidePushOptIn(save, { usable: false }, async () => false)).toEqual({
      refused: true,
    });
  });

  it('keeps an opt-in ALREADY stored, so a client holding it can still save other settings', async () => {
    const out = await decidePushOptIn(save, { usable: false }, async () => true);
    expect(out).toEqual({ write: { ...save, push_channel: null }, push: 'kept' });
  });

  it('reports nothing about Push for a save that carried no opt-in', async () => {
    const plain = { ...save, push_channel: null };
    expect(await decidePushOptIn(plain, { usable: false }, never)).toEqual({
      write: plain,
      push: 'not-requested',
    });
  });
});
