/**
 * #1722 — the keeper's one way to the owners' Telegram chats: the agent's
 * keeper-only routes (`apps/agent/src/keeperRoutes.ts`).
 *
 * The agent alone holds the Telegram bot token and the wallet-to-chat links,
 * in a Durable Object no other Worker can bind. The keeper holds neither. It
 * says WHAT happened, as typed data (`@vaipakam/lib/telegramAlerts/message`),
 * and the agent decides whether a chat is linked, renders the protocol's own
 * wording in the owner's language and sends it. The keeper's LOCK step reads
 * its requests from the agent and reports each outcome back the same way.
 *
 * Every request carries the chain and the Diamond this keeper serves there.
 * The agent refuses another Diamond (409), which stands in for the epoch
 * guard the keeper used to put on its own writes to the shared LOCK table: a
 * keeper still serving a retired Diamond cannot answer a LOCK made under the
 * new one. That refusal throws {@link AgentDiamondMismatch}, a kind of the
 * epoch fence's own refusal, so the passes handle the two alike.
 *
 * Configuration: `AGENT_ORIGIN` (a plain var) and `KEEPER_AGENT_TOKEN` (a
 * secret, the bearer the agent compares in constant time). With either unset,
 * {@link agentClientOf} returns null and every Telegram channel reads as off;
 * the passes say so once per run rather than per alert.
 */
import type { AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import type { ChannelResult } from './alertDelivery';
import { EpochFenceRefusal } from './epochFence';

/** How long one agent request may take before it counts as unanswered. */
export const AGENT_REQUEST_TIMEOUT_MS = 10_000;
/** Most alerts the agent takes in one request (its `KEEPER_ALERTS_MAX`). */
export const AGENT_ALERTS_MAX = 25;

/** The agent refused the request because it serves another Diamond on the
 *  chain: this keeper's build is behind or ahead of the agent's. An epoch
 *  fence refusal, so every handler of the fence's own refusal handles it. */
export class AgentDiamondMismatch extends EpochFenceRefusal {
  constructor(readonly chainId: number, readonly agentDiamond: string | null) {
    super(`the agent serves ${agentDiamond ?? 'another Diamond'} on chain ${chainId}, not this keeper's`);
    this.name = 'AgentDiamondMismatch';
  }
}

/** An agent request that did not produce an answer the keeper can use: the
 *  network, a timeout, a server fault, or a refusal of the request itself
 *  (`status` 0 when nothing answered). */
export class AgentRequestFailed extends Error {
  constructor(readonly path: string, readonly status: number, detail: string) {
    super(`agent ${path} ${status === 0 ? 'unanswered' : `answered ${status}`}: ${detail}`);
    this.name = 'AgentRequestFailed';
  }
  /** A refusal that will repeat on every try until someone changes the
   *  configuration (a missing or wrong token, a malformed request). */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

/** One open LOCK request group, as the agent returns it: a wallet's newest
 *  open request id and request time. */
export interface AgentLockRequest {
  id: number;
  wallet: string;
  requestedAt: number;
}

/** What the agent did with a LOCK outcome. `recorded` is false when the
 *  outcome was already on record (nothing was sent again). */
export interface LockHandledAnswer {
  recorded: boolean;
  telegram: ChannelResult;
}

/** The LOCK outcomes the agent records; `dropped-old` sends no message. */
export type AgentLockOutcome =
  | 'locked'
  | 'locked-again'
  | 'already-locked'
  | 'not-protected'
  | 'not-allowed'
  | 'expired'
  | 'refused'
  | 'dropped-old';

export interface AgentClient {
  /** Open LOCK requests on the chain, oldest first, one per wallet. Asking
   *  also tells the agent a keeper able to sign is working the chain now. */
  lockPoll(chainId: number, diamond: string, limit: number): Promise<AgentLockRequest[]>;
  /** Wallets with an open LOCK request on the chain made at or after `since`. */
  lockPending(chainId: number, diamond: string, since: number): Promise<string[]>;
  /** Report how a wallet's open requests up to `upToId` ended. */
  lockHandled(
    chainId: number,
    diamond: string,
    wallet: string,
    upToId: number,
    outcome: AgentLockOutcome,
    reason?: string,
  ): Promise<LockHandledAnswer>;
  /** Send alerts (all on one chain), in order; one result per alert. */
  sendAlerts(chainId: number, diamond: string, alerts: readonly AddressedAlert[]): Promise<ChannelResult[]>;
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** The configured agent, or null when `AGENT_ORIGIN` or `KEEPER_AGENT_TOKEN`
 *  is unset (or the origin is not an https URL, http only for localhost). */
export function agentClientOf(
  env: { AGENT_ORIGIN?: string; KEEPER_AGENT_TOKEN?: string },
  fetchFn: FetchFn = (input, init) => fetch(input, init),
): AgentClient | null {
  const origin = normaliseOrigin(env.AGENT_ORIGIN);
  const token = env.KEEPER_AGENT_TOKEN?.trim();
  if (!origin || !token) return null;
  return httpAgentClient(origin, token, fetchFn);
}

/** Why {@link agentClientOf} returned null, for the run line. */
export function agentUnconfiguredReason(env: { AGENT_ORIGIN?: string; KEEPER_AGENT_TOKEN?: string }): string | null {
  if (!normaliseOrigin(env.AGENT_ORIGIN)) {
    return env.AGENT_ORIGIN?.trim() ? 'AGENT_ORIGIN is not an https origin' : 'AGENT_ORIGIN is unset';
  }
  if (!env.KEEPER_AGENT_TOKEN?.trim()) return 'KEEPER_AGENT_TOKEN is unset';
  return null;
}

function normaliseOrigin(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  return u.origin;
}

const CHANNEL_RESULTS: readonly ChannelResult[] = ['sent', 'retry', 'refused', 'off'];
const asChannel = (v: unknown): ChannelResult | null =>
  (CHANNEL_RESULTS as readonly unknown[]).includes(v) ? (v as ChannelResult) : null;

export function httpAgentClient(origin: string, token: string, fetchFn: FetchFn): AgentClient {
  async function post(path: string, chainId: number, diamond: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchFn(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, chainId, diamond }),
        signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
        // The agent never redirects. Refusing one keeps the bearer from
        // following a misconfigured origin anywhere else.
        redirect: 'error',
      });
    } catch (err) {
      // Never the token: the error names the path and the failure only.
      throw new AgentRequestFailed(path, 0, err instanceof Error ? err.name : 'network');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // A body that is not JSON is judged by its status below.
    }
    const obj = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    if (res.status === 409 && obj.error === 'diamond-mismatch') {
      throw new AgentDiamondMismatch(chainId, typeof obj.diamond === 'string' ? obj.diamond : null);
    }
    // The agent answers a refusal with a short code (`bad-diamond`,
    // `unauthorized`); anything else is not printed, so no text from the
    // answer reaches a log line.
    const code = typeof obj.error === 'string' && /^[a-z]+(-[a-z]+)*$/.test(obj.error) && obj.error.length <= 32 ? obj.error : 'no reason given';
    if (!res.ok) throw new AgentRequestFailed(path, res.status, code);
    return obj;
  }

  return {
    async lockPoll(chainId, diamond, limit) {
      const r = await post('/keeper/lock/poll', chainId, diamond, { limit });
      if (!Array.isArray(r.requests)) throw new AgentRequestFailed('/keeper/lock/poll', 200, 'no requests list');
      return r.requests.flatMap((q: unknown) => {
        const o = q as Record<string, unknown>;
        return Number.isSafeInteger(o?.id) && typeof o.wallet === 'string' && Number.isSafeInteger(o.requestedAt)
          ? [{ id: o.id as number, wallet: o.wallet, requestedAt: o.requestedAt as number }]
          : [];
      });
    },
    async lockPending(chainId, diamond, since) {
      const r = await post('/keeper/lock/pending', chainId, diamond, { since });
      if (!Array.isArray(r.wallets)) throw new AgentRequestFailed('/keeper/lock/pending', 200, 'no wallets list');
      return r.wallets.filter((w: unknown): w is string => typeof w === 'string');
    },
    async lockHandled(chainId, diamond, wallet, upToId, outcome, reason) {
      const r = await post('/keeper/lock/handled', chainId, diamond, {
        wallet,
        upToId,
        outcome,
        ...(outcome === 'refused' ? { reason: lockReason(reason) } : {}),
      });
      if (typeof r.recorded !== 'boolean') throw new AgentRequestFailed('/keeper/lock/handled', 200, 'no recorded flag');
      return { recorded: r.recorded, telegram: asChannel(r.telegram) ?? 'retry' };
    },
    async sendAlerts(chainId, diamond, alerts) {
      if (alerts.length === 0) return [];
      if (alerts.length > AGENT_ALERTS_MAX) throw new RangeError(`at most ${AGENT_ALERTS_MAX} alerts per request`);
      const r = await post('/keeper/alerts', chainId, diamond, { alerts });
      const results = Array.isArray(r.results) ? r.results : [];
      // An answer short of one result per alert leaves the rest unknown: a
      // send that may not have gone, as for Push.
      return alerts.map((_, i) => asChannel(results[i]) ?? 'retry');
    },
  };
}

/** A refusal's name in the shape the agent takes (`[A-Za-z0-9_]{1,64}`): a
 *  custom error name passes as it is; anything else is folded to it. */
export function lockReason(reason: string | undefined): string {
  const folded = (reason ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  return /[A-Za-z0-9]/.test(folded) ? folded : 'unknown';
}
