/**
 * #1722 — the keeper's client of the agent's keeper-only routes: what it
 * sends (the bearer, the chain and the Diamond in every body), how it reads
 * each answer, and what it throws for a refusal, a Diamond mismatch and a
 * request nothing answered. The token never appears in an error.
 */
import { describe, expect, it } from 'vitest';
import type { AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import {
  AGENT_ALERTS_MAX,
  agentClientOf,
  AgentDiamondMismatch,
  AgentRequestFailed,
  agentUnconfiguredReason,
  httpAgentClient,
  lockReason,
} from '../src/agentClient';
import { EpochFenceRefusal } from '../src/epochFence';

const ORIGIN = 'https://agent.example';
const TOKEN = 'f3a9c1d27e4b8a6055c3e1d9b7a2f40c';
const DIAMOND = '0x' + 'd'.repeat(40);
const WALLET = '0x' + 'a'.repeat(40);

/** A fetch that records each request and answers `status` with `body`. */
function fetchAnswering(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fn, seen };
}

describe('agentClientOf', () => {
  it('is configured only with an https origin (http only on localhost) and a token', () => {
    expect(agentClientOf({ AGENT_ORIGIN: ORIGIN, KEEPER_AGENT_TOKEN: TOKEN })).not.toBeNull();
    expect(agentClientOf({ AGENT_ORIGIN: 'http://localhost:8787', KEEPER_AGENT_TOKEN: TOKEN })).not.toBeNull();
    expect(agentClientOf({ AGENT_ORIGIN: 'http://agent.example', KEEPER_AGENT_TOKEN: TOKEN })).toBeNull();
    expect(agentClientOf({ AGENT_ORIGIN: ORIGIN, KEEPER_AGENT_TOKEN: '  ' })).toBeNull();
    expect(agentClientOf({ KEEPER_AGENT_TOKEN: TOKEN })).toBeNull();
  });

  it('names why it is not configured', () => {
    expect(agentUnconfiguredReason({})).toBe('AGENT_ORIGIN is unset');
    expect(agentUnconfiguredReason({ AGENT_ORIGIN: 'ftp://x' })).toBe('AGENT_ORIGIN is not an https origin');
    expect(agentUnconfiguredReason({ AGENT_ORIGIN: ORIGIN })).toBe('KEEPER_AGENT_TOKEN is unset');
    expect(agentUnconfiguredReason({ AGENT_ORIGIN: ORIGIN, KEEPER_AGENT_TOKEN: TOKEN })).toBeNull();
  });

  it('posts to the origin alone, whatever path the setting carried', async () => {
    const { fn, seen } = fetchAnswering(200, { wallets: [] });
    await agentClientOf({ AGENT_ORIGIN: `${ORIGIN}/some/path?q=1`, KEEPER_AGENT_TOKEN: TOKEN }, fn)!.lockPending(1, DIAMOND, 0);
    expect(seen[0]!.url).toBe(`${ORIGIN}/keeper/lock/pending`);
  });
});

describe('httpAgentClient', () => {
  it('sends the bearer and, in every body, the chain and the Diamond', async () => {
    const { fn, seen } = fetchAnswering(200, { requests: [{ id: 3, wallet: WALLET, requestedAt: 100 }, { id: 'x' }] });
    const reqs = await httpAgentClient(ORIGIN, TOKEN, fn).lockPoll(84532, DIAMOND, 20);
    // An entry out of shape is dropped, not guessed at.
    expect(reqs).toEqual([{ id: 3, wallet: WALLET, requestedAt: 100 }]);
    expect(seen[0]!.url).toBe(`${ORIGIN}/keeper/lock/poll`);
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ limit: 20, chainId: 84532, diamond: DIAMOND });
  });

  it("reports a LOCK outcome, with a refusal's reason only for a refusal", async () => {
    const { fn, seen } = fetchAnswering(200, { recorded: true, telegram: 'retry' });
    const c = httpAgentClient(ORIGIN, TOKEN, fn);
    expect(await c.lockHandled(1, DIAMOND, WALLET, 4, 'refused', 'Vault Frozen!')).toEqual({ recorded: true, telegram: 'retry' });
    await c.lockHandled(1, DIAMOND, WALLET, 4, 'locked', 'ignored');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ wallet: WALLET, upToId: 4, outcome: 'refused', reason: 'Vault_Frozen_', chainId: 1, diamond: DIAMOND });
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ wallet: WALLET, upToId: 4, outcome: 'locked', chainId: 1, diamond: DIAMOND });
  });

  it('reads an answer without the recorded flag as a failed request', async () => {
    const { fn } = fetchAnswering(200, { telegram: 'sent' });
    await expect(httpAgentClient(ORIGIN, TOKEN, fn).lockHandled(1, DIAMOND, WALLET, 4, 'locked')).rejects.toBeInstanceOf(AgentRequestFailed);
  });

  it('returns one result per alert, reading a short or malformed answer as worth another try', async () => {
    const alert: AddressedAlert = { chainId: 1, wallet: WALLET, alert: { kind: 'preGrace', loanId: 1, hoursToEnd: 5 } };
    const { fn } = fetchAnswering(200, { results: ['sent', 'nonsense'] });
    expect(await httpAgentClient(ORIGIN, TOKEN, fn).sendAlerts(1, DIAMOND, [alert, alert, alert])).toEqual(['sent', 'retry', 'retry']);
    await expect(httpAgentClient(ORIGIN, TOKEN, fn).sendAlerts(1, DIAMOND, Array(AGENT_ALERTS_MAX + 1).fill(alert))).rejects.toBeInstanceOf(RangeError);
    expect(await httpAgentClient(ORIGIN, TOKEN, fn).sendAlerts(1, DIAMOND, [])).toEqual([]);
  });

  it('throws a Diamond mismatch, an epoch fence refusal, when the agent serves another Diamond', async () => {
    const other = '0x' + 'e'.repeat(40);
    const { fn } = fetchAnswering(409, { error: 'diamond-mismatch', diamond: other });
    const err = await httpAgentClient(ORIGIN, TOKEN, fn).lockPending(1, DIAMOND, 0).catch((e) => e);
    expect(err).toBeInstanceOf(AgentDiamondMismatch);
    expect(err).toBeInstanceOf(EpochFenceRefusal);
    expect(err.agentDiamond).toBe(other);
  });

  it('marks a refusal that will repeat as permanent, and a rate limit, a timeout or a fault as passing', async () => {
    const failure = async (status: number, body: unknown) =>
      (await httpAgentClient(ORIGIN, TOKEN, fetchAnswering(status, body).fn).lockPending(1, DIAMOND, 0).catch((e) => e)) as AgentRequestFailed;
    expect((await failure(401, { error: 'unauthorized' })).permanent).toBe(true);
    expect((await failure(400, 'not json')).permanent).toBe(true);
    expect((await failure(429, {})).permanent).toBe(false);
    expect((await failure(503, { error: 'no-token' })).permanent).toBe(false);
    expect((await failure(408, {})).permanent).toBe(false);
  });

  it('never puts the token in an error, even when the network fails', async () => {
    const boom = async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    };
    const err = (await httpAgentClient(ORIGIN, TOKEN, boom).lockPoll(1, DIAMOND, 1).catch((e) => e)) as AgentRequestFailed;
    expect(err).toBeInstanceOf(AgentRequestFailed);
    expect(err.status).toBe(0);
    expect(err.permanent).toBe(false);
    expect(err.message).not.toContain(TOKEN);
    const refused = await httpAgentClient(ORIGIN, TOKEN, fetchAnswering(401, { error: TOKEN }).fn).lockPoll(1, DIAMOND, 1).catch((e) => e);
    // An answer's text reaches the error only as one of the agent's short
    // codes, so nothing it carries can reach a log line.
    expect(String(refused.message)).toBe('agent /keeper/lock/poll answered 401: no reason given');
  });
});

describe('lockReason', () => {
  it("passes a custom error's name as it is and folds anything else to the agent's character set", () => {
    expect(lockReason('KeeperAccessRequired')).toBe('KeeperAccessRequired');
    expect(lockReason('0xdeadbeef')).toBe('0xdeadbeef');
    expect(lockReason('call reverted: out of gas')).toBe('call_reverted__out_of_gas');
    expect(lockReason('x'.repeat(100))).toHaveLength(64);
    expect(lockReason('???')).toBe('unknown');
    expect(lockReason(undefined)).toBe('unknown');
  });
});
