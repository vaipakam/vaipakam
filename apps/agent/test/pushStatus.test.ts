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
import { KEEPER_RAIL_FRESH_SEC, decidePushOptIn, handlePushStatus, servicePushStatus } from '../src/pushRail';

const ORIGIN = 'https://app.vaipakam.com';
/** A throwaway key, generated per run so none is ever written down. */
const key = generatePrivateKey();

const NOW = 1_800_000_000;

/** A shared D1 whose `push_rail_status` holds `row` for the keeper (none by
 *  default), or whose read throws, as on a database the migration has not
 *  reached. */
function sharedDb(row: Record<string, unknown> | null = null, opts: { throws?: boolean } = {}) {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (opts.throws) throw new Error('no such table: push_rail_status');
          expect(sql).toContain('FROM push_rail_status WHERE sender = ?');
          expect(binds).toEqual(['keeper']);
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
}

async function statusFor(
  env: { PUSH_CHANNEL_PK?: string; PUSH_CHANNEL_ADDRESS?: string },
  db: D1Database = sharedDb(),
) {
  const res = await handlePushStatus({ ...env, DB: db }, ORIGIN, NOW);
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
      rail: 'agent',
      scope: 'agent',
    });
  });

  it('says so for a key that is set and unusable — the case that used to look configured', async () => {
    expect(await statusFor({ PUSH_CHANNEL_PK: 'not-a-key' })).toEqual({
      available: false,
      reason: 'signer-malformed',
      rail: 'agent',
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

describe('GET /push/status covers the keeper too, as it last published (#2667)', () => {
  const CHANNEL = '0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b';
  const agentEnv = { PUSH_CHANNEL_PK: key, PUSH_CHANNEL_ADDRESS: CHANNEL };
  const keeperUsable = (channel = CHANNEL, observed_at = NOW - 60) => ({ usable: 1, reason: null, channel, observed_at });

  it('is available for the whole service when both rails post on the same channel', async () => {
    expect(await statusFor(agentEnv, sharedDb(keeperUsable(CHANNEL.toLowerCase())))).toEqual({
      available: true,
      channel: CHANNEL,
      scope: 'service',
    });
  });

  it("says the keeper's rail is down, and why, when it published that it cannot send", async () => {
    const row = { usable: 0, reason: 'signer-unset', channel: null, observed_at: NOW - 30 };
    expect(await statusFor(agentEnv, sharedDb(row))).toEqual({
      available: false,
      reason: 'signer-unset',
      rail: 'keeper',
      scope: 'service',
    });
  });

  it("says the agent's rail is down for the whole service even while the keeper's is up", async () => {
    expect(await statusFor({}, sharedDb(keeperUsable()))).toEqual({
      available: false,
      reason: 'signer-unset',
      rail: 'agent',
      scope: 'service',
    });
  });

  it('is unavailable when the two rails post on different channels, since one opt-in names one channel', async () => {
    const other = '0x1DAefA360ED370285f003Fa2d92DB75628088282';
    expect(await statusFor(agentEnv, sharedDb(keeperUsable(other)))).toEqual({
      available: false,
      reason: 'channel-mismatch',
      scope: 'service',
    });
  });

  it("falls back to the agent's own answer, scoped to it, when nothing trustworthy is known about the keeper", async () => {
    const agentOnly = { available: true, channel: CHANNEL, scope: 'agent' };
    // No row yet; the table not migrated; a row past the freshness bound; one
    // stamped well ahead of this clock; rows of neither written shape.
    for (const db of [
      sharedDb(null),
      sharedDb(null, { throws: true }),
      sharedDb(keeperUsable(CHANNEL, NOW - KEEPER_RAIL_FRESH_SEC - 1)),
      sharedDb(keeperUsable(CHANNEL, NOW + 3600)),
      sharedDb({ usable: 1, reason: null, channel: 'not-an-address', observed_at: NOW }),
      sharedDb({ usable: 0, reason: 'something-new', channel: null, observed_at: NOW }),
      sharedDb({ usable: 2, reason: null, channel: CHANNEL, observed_at: NOW }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await statusFor(agentEnv, db)).toEqual(agentOnly);
    }
  });

  it('judges a new opt-in against the same answer', async () => {
    const row = { usable: 0, reason: 'signer-malformed', channel: null, observed_at: NOW };
    const status = await servicePushStatus({ ...agentEnv, DB: sharedDb(row) }, NOW);
    expect(status.usable).toBe(false);
    expect(await decidePushOptIn({ push_channel: 'subscribed' }, status, async () => false)).toEqual({ refused: true });
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
