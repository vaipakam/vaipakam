/**
 * #3088 / #1722 — the protected account pass's store: the LOCK requests and
 * their reports through the agent's keeper routes, each naming this keeper's
 * Diamond, and an owner's Push subscription and language from the shared
 * database (run against the indexer's own migrations).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentClient, AgentLockOutcome } from '../src/agentClient';
import { protectedStoreOf } from '../src/protectedTelegram';
import { createSharedD1 } from './helpers/schemas';

const CHAIN = 84532;
const DIAMOND = '0x' + 'd'.repeat(40);
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';

/** An agent that records each call and answers from fixed values. */
function fakeAgent() {
  const calls: unknown[][] = [];
  const agent: AgentClient = {
    async lockPoll(chainId, diamond, limit) {
      calls.push(['poll', chainId, diamond, limit]);
      return [{ id: 9, wallet: '0x00000000000000000000000000000000000000A1', requestedAt: 150 }];
    },
    async lockPending(chainId, diamond, since) {
      calls.push(['pending', chainId, diamond, since]);
      return ['0x00000000000000000000000000000000000000B2'];
    },
    async lockHandled(chainId, diamond, wallet, upToId, outcome: AgentLockOutcome, reason) {
      calls.push(['handled', chainId, diamond, wallet, upToId, outcome, reason]);
      return { recorded: true, telegram: 'sent' };
    },
    async sendAlerts() {
      throw new Error('not used here');
    },
  };
  return { agent, calls };
}

describe('protectedStoreOf', () => {
  let shared: ReturnType<typeof createSharedD1>;

  const subscribe = (wallet: string, push: string | null, locale: string) =>
    shared.db
      .prepare(
        `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale, created_at, updated_at)
         VALUES (?, ?, 1.5, 1.2, 1.05, ?, ?, 1, 1)`,
      )
      .run(wallet, CHAIN, push, locale);

  beforeEach(() => {
    shared = createSharedD1();
  });

  it('reads the open LOCK requests from the agent, naming the Diamond, with wallets lowercased', async () => {
    const { agent, calls } = fakeAgent();
    const store = protectedStoreOf(agent, shared.d1 as D1Database, DIAMOND as `0x${string}`);
    expect(await store.lockRequests(CHAIN, 20)).toEqual([{ id: 9, wallet: ALICE, requestedAt: 150 }]);
    expect([...(await store.pendingLockWallets(CHAIN, 100))]).toEqual([BOB]);
    expect(calls).toEqual([
      ['poll', CHAIN, DIAMOND, 20],
      ['pending', CHAIN, DIAMOND, 100],
    ]);
  });

  it("reports an outcome in the agent's shape: a refusal as `refused` with its error name, folded to the accepted characters", async () => {
    const { agent, calls } = fakeAgent();
    const store = protectedStoreOf(agent, shared.d1 as D1Database, DIAMOND as `0x${string}`);
    expect(await store.markHandled(CHAIN, ALICE as `0x${string}`, 9, 'locked')).toEqual({ recorded: true, telegram: 'sent' });
    await store.markHandled(CHAIN, ALICE as `0x${string}`, 9, 'refused: VaultFrozen');
    await store.markHandled(CHAIN, ALICE as `0x${string}`, 9, 'refused: 0x1234abcd (reverted)');
    await store.markHandled(CHAIN, ALICE as `0x${string}`, 9, 'dropped-old');
    expect(calls).toEqual([
      ['handled', CHAIN, DIAMOND, ALICE, 9, 'locked', undefined],
      ['handled', CHAIN, DIAMOND, ALICE, 9, 'refused', 'VaultFrozen'],
      ['handled', CHAIN, DIAMOND, ALICE, 9, 'refused', '0x1234abcd__reverted_'],
      ['handled', CHAIN, DIAMOND, ALICE, 9, 'dropped-old', undefined],
    ]);
  });

  it('with no agent configured throws on every LOCK call, naming why', async () => {
    const store = protectedStoreOf(null, shared.d1 as D1Database, DIAMOND as `0x${string}`, 'AGENT_ORIGIN is unset');
    await expect(store.lockRequests(CHAIN, 20)).rejects.toThrow(/the agent is not reachable: AGENT_ORIGIN is unset/);
    await expect(store.pendingLockWallets(CHAIN, 0)).rejects.toThrow(/not reachable/);
    await expect(store.markHandled(CHAIN, ALICE as `0x${string}`, 1, 'locked')).rejects.toThrow(/not reachable/);
  });

  it("reads an owner's Push opt-in and locale, and nothing for a wallet with no row", async () => {
    const store = protectedStoreOf(null, shared.d1 as D1Database, DIAMOND as `0x${string}`);
    subscribe(ALICE, 'subscribed', 'fr');
    subscribe(BOB, null, 'en');
    expect(await store.subscriber(CHAIN, '0x00000000000000000000000000000000000000A1')).toEqual({ push: true, locale: 'fr' });
    expect(await store.subscriber(CHAIN, BOB as `0x${string}`)).toEqual({ push: false, locale: 'en' });
    expect(await store.subscriber(97, ALICE as `0x${string}`)).toBeNull();
  });
});
