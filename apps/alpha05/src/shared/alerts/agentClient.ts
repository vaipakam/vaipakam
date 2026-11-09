/**
 * The alert service's transport (#3180 Alerts, ACC-50 / ACC-52): one client
 * per build for the agent Worker, created from `agentOrigin` so there is one
 * place a route is appended. A build with no agent origin has a client that
 * refuses every call with a stated reason, so the Alerts page says Telegram
 * and push alerts are not set up here and never sends anything (RB-FUNDS).
 *
 * Unlike the indexer's client, a request that reaches the service and is
 * answered with a non-2xx status does NOT throw: each signed action reads
 * the status and the body's `error` to say what happened (already used,
 * refused, not linked, try again shortly), so the answer is handed back.
 */
import { agentOrigin } from '../../chain/endpoints';

export type AgentFailure = 'not-configured' | 'network';

export class AgentUnavailable extends Error {
  readonly why: AgentFailure;
  constructor(why: AgentFailure, message: string) {
    super(message);
    this.name = 'AgentUnavailable';
    this.why = why;
  }
}

/** One answer from the service: its status and its JSON body (`null` when
 *  the body was not JSON). */
export interface AgentAnswer {
  status: number;
  data: Record<string, unknown> | null;
}

export interface AgentClient {
  /** The origin every route is appended to; `null` when this build has none. */
  readonly origin: string | null;
  /** A request to `path` (which starts with `/`), with a JSON body when one
   *  is given. Throws {@link AgentUnavailable} only when the service could
   *  not be asked; every answer, 2xx or not, is returned. */
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<AgentAnswer>;
}

export const AGENT_TIMEOUT_MS = 15_000;

export function createAgentClient(origin: string | null, fetchImpl: typeof fetch = fetch): AgentClient {
  return {
    origin,
    async request(method, path, body, opts = {}) {
      if (origin === null) throw new AgentUnavailable('not-configured', 'This build has no alert service origin.');
      if (!path.startsWith('/')) throw new Error(`agent path must start with "/": ${path}`);
      let res: Response;
      try {
        res = await fetchImpl(`${origin}${path}`, {
          method,
          signal: AbortSignal.timeout(opts.timeoutMs ?? AGENT_TIMEOUT_MS),
          headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) {
        throw new AgentUnavailable('network', `The alert service did not answer: ${(e as Error).message}`);
      }
      let data: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await res.json();
        data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        data = null;
      }
      return { status: res.status, data };
    },
  };
}

/** One alert-service client per build. */
export const AGENT = createAgentClient(agentOrigin(import.meta.env));
