import { describe, expect, it, vi } from 'vitest';
import { readTelegramTarget, resolveEnv, rpcFor, type Env } from '../src/env';
import { configuredRpcChainIds } from '../src/redact';

const binding = (value: string) => ({ get: async () => value });
const failing = () => ({
  get: async () => {
    throw new Error('store unavailable');
  },
});

describe('resolveEnv — Secrets Store bindings resolved at the boundary', () => {
  it('turns store bindings into the plain strings every reader expects', async () => {
    const db = { prepare: () => null } as unknown as D1Database;
    const env = await resolveEnv({
      DB: db,
      CANONICAL_CHAIN_ID: '84532',
      TG_OPS_BOT_TOKEN: binding('bot-token'),
      TG_OPS_CHAT_ID: binding('-100123'),
      RPC_84532: binding('https://base.example/key'),
      RPC_421614: binding('https://arb.example/key'),
    } as unknown as Env);

    expect(readTelegramTarget(env)).toEqual({ token: 'bot-token', chatId: '-100123' });
    expect(rpcFor(env, 84532)).toBe('https://base.example/key');
    expect(rpcFor(env, 421614)).toBe('https://arb.example/key');
    // The redactor discovers configured chains from the RESOLVED env.
    expect(configuredRpcChainIds(env).sort()).toEqual([421614, 84532]);
    expect(env.DB).toBe(db);
    expect(env.CANONICAL_CHAIN_ID).toBe('84532');
  });

  it('keeps a plain per-Worker secret of the same name working', async () => {
    const env = await resolveEnv({
      TG_OPS_BOT_TOKEN: 'plain-token',
      TG_OPS_CHAT_ID: 'plain-chat',
      RPC_97: 'https://bnb.example/key',
    } as unknown as Env);
    expect(readTelegramTarget(env)).toEqual({ token: 'plain-token', chatId: 'plain-chat' });
    expect(rpcFor(env, 97)).toBe('https://bnb.example/key');
  });

  it('treats a failed store read as UNSET, and logs the name only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = await resolveEnv({
      TG_OPS_BOT_TOKEN: binding('bot-token'),
      TG_OPS_CHAT_ID: failing(),
      RPC_84532: failing(),
    } as unknown as Env);

    // A missing chat id leaves delivery unconfigured, which the tick reports.
    expect(readTelegramTarget(env)).toBeNull();
    // A missing RPC is a coverage gap, not a silently dropped chain.
    expect(rpcFor(env, 84532)).toBeNull();
    expect(configuredRpcChainIds(env)).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).not.toContain('bot-token');
    log.mockRestore();
  });

  it('never resolves WATCHER_RUN_TOKEN from a binding (it is per-Worker)', async () => {
    const env = await resolveEnv({
      WATCHER_RUN_TOKEN: binding('should-not-resolve'),
    } as unknown as Env);
    expect(typeof env.WATCHER_RUN_TOKEN).not.toBe('string');
  });
});
