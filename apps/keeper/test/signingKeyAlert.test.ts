/**
 * #3119 — the machine-level ops alert for a signing key that cannot sign.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  SIGNING_KEY_ALERT_INTERVAL_SEC,
  SIGNING_KEY_ALERT_KEY,
  signingKeyAlertText,
  signingKeyHealth,
  type SigningKeyAlertDeps,
} from '../src/signingKeyAlert';
import type { OpsAlertOutcome } from '../src/opsAlert';

// A valid secp256k1 scalar used only as test data (the well-known first Anvil key).
const GOOD_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let sent: { key: string; text: string; interval: number }[];
let record: unknown;
let cleared: string[];
let outcome: OpsAlertOutcome;
let priorFails: boolean;

const deps: SigningKeyAlertDeps = {
  send: async (_env, key, text, interval) => {
    sent.push({ key, text, interval });
    if (outcome === 'sent') record = { firstSeenAt: 1, lastSentAt: 1 };
    return outcome;
  },
  prior: async () => {
    if (priorFails) throw new Error('d1 down');
    return record;
  },
  clear: async (_env, key) => {
    cleared.push(key);
    record = null;
  },
};

const env = (over: Partial<Env>): Env => ({ KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: GOOD_KEY, ...over }) as unknown as Env;

beforeEach(() => {
  sent = [];
  record = null;
  cleared = [];
  outcome = 'sent';
  priorFails = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('signingKeyHealth (#3119)', () => {
  it('alerts ops once for the machine when the key is unset, naming no value', async () => {
    const r = await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: undefined }), deps);
    expect(r).toEqual({ kind: 'alerted', outcome: 'sent' });
    expect(sent).toEqual([{ key: SIGNING_KEY_ALERT_KEY, text: signingKeyAlertText('unset'), interval: SIGNING_KEY_ALERT_INTERVAL_SEC }]);
    expect(sent[0].text).toMatch(/KEEPER_PRIVATE_KEY is unset, so every keeper pass is disarmed/);
  });

  it('names the form of a malformed key, never the key', async () => {
    const bad = '0x1234';
    await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: bad }), deps);
    expect(sent[0].text).toMatch(/KEEPER_PRIVATE_KEY is malformed \(6 chars, expected 66\)/);
    expect(sent[0].text).not.toContain(bad);
    const notKey = `0x${'0'.repeat(64)}`;
    sent = [];
    await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: notKey }), deps);
    expect(sent[0].text).toMatch(/malformed \(not a valid signing key\)/);
    expect(sent[0].text).not.toContain(notKey);
  });

  it('says nothing while KEEPER_ENABLED is off, whatever the key', async () => {
    for (const KEEPER_ENABLED of [undefined, 'false', 'ture']) {
      expect(await signingKeyHealth(env({ KEEPER_ENABLED, KEEPER_PRIVATE_KEY: undefined }), deps)).toEqual({ kind: 'ok' });
    }
    expect(sent).toEqual([]);
  });

  it('accepts KEEPER_ENABLED as the pass gate does (True, 1)', async () => {
    await signingKeyHealth(env({ KEEPER_ENABLED: 'True', KEEPER_PRIVATE_KEY: undefined }), deps);
    await signingKeyHealth(env({ KEEPER_ENABLED: '1', KEEPER_PRIVATE_KEY: undefined }), deps);
    expect(sent).toHaveLength(2);
  });

  it('clears its record once the key signs again, so a recurrence alerts at once', async () => {
    await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: undefined }), deps);
    expect(await signingKeyHealth(env({}), deps)).toEqual({ kind: 'cleared' });
    expect(cleared).toEqual([SIGNING_KEY_ALERT_KEY]);
    // Nothing more to clear on later ticks.
    expect(await signingKeyHealth(env({}), deps)).toEqual({ kind: 'ok' });
    expect(cleared).toHaveLength(1);
  });

  it('clears its record when the keeper is switched off', async () => {
    await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: undefined }), deps);
    expect(await signingKeyHealth(env({ KEEPER_ENABLED: 'false', KEEPER_PRIVATE_KEY: undefined }), deps)).toEqual({ kind: 'cleared' });
  });

  it('writes nothing on a healthy machine with no record', async () => {
    expect(await signingKeyHealth(env({}), deps)).toEqual({ kind: 'ok' });
    expect(sent).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('never throws when its record cannot be read', async () => {
    priorFails = true;
    expect(await signingKeyHealth(env({}), deps)).toEqual({ kind: 'ok' });
  });

  it('reports a post that did not go out, for the next tick to repeat', async () => {
    outcome = 'failed';
    expect(await signingKeyHealth(env({ KEEPER_PRIVATE_KEY: undefined }), deps)).toEqual({ kind: 'alerted', outcome: 'failed' });
  });
});
