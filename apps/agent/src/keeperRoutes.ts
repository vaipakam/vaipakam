/**
 * #1722 — the routes the keeper reaches the agent's Telegram state through.
 *
 * The Telegram links and LOCK requests live in the agent's own Durable Object
 * (`telegramState/`), which no D1 binding or token reaches. The keeper still
 * needs four things from them, and gets each through one route here:
 *
 *   POST /keeper/lock/poll     the open LOCK requests on a chain, oldest first
 *                              (and, by asking, says a keeper is working them)
 *   POST /keeper/lock/pending  the wallets with an open request made since a time
 *   POST /keeper/lock/handled  how a wallet's requests ended; the agent records
 *                              it and tells the chat the wallet is linked to
 *   POST /keeper/alerts        owner alerts, as data (`TelegramAlert`); the agent
 *                              renders each from the shared catalogues and sends
 *                              it to the chat linked to the wallet
 *
 * AUTHORITY. Every route needs `Authorization: Bearer <KEEPER_AGENT_TOKEN>`,
 * compared in constant time. With no token configured every route answers 503:
 * the routes fail closed, never open. The token can make the agent send only
 * the protocol's own fixed wording (`@vaipakam/lib/telegramAlerts/message`),
 * to chats the owners linked themselves; it cannot read a chat id, link or
 * unlink anything, or record a LOCK.
 *
 * THE DIAMOND FENCE. Each request names the Diamond the keeper is serving on
 * that chain, and the agent refuses one that is not the Diamond in its own
 * deployment bundle (409). This stands in for the epoch guard the keeper put
 * on its D1 writes (`epochFence.ts`): a keeper still serving a retired
 * Diamond cannot answer a LOCK made under the new one, or alert an owner
 * about a loan id that now belongs to someone else.
 */
import {
  parseAddressedAlert,
  renderTelegramAlert,
  LOCK_OUTCOMES,
  type AddressedAlert,
  type LockOutcomeKind,
} from '@vaipakam/lib/telegramAlerts/message';
import { readJsonBody } from '@vaipakam/lib/requestBody';
import type { LocaleReader } from './alertChannelChange';
import type { TelegramOutcome } from './telegram';
import type { KeeperStatePort } from './telegramLinks';
import type { ChainDeployment } from './telegramState/store';

/** Largest request body read, in bytes. */
export const KEEPER_BODY_MAX = 64 * 1024;
/** Most LOCK requests one poll returns. */
export const KEEPER_POLL_MAX = 50;
/** Most alerts one request carries. */
export const KEEPER_ALERTS_MAX = 25;

/** What a channel did with one message, in the keeper's own terms
 *  (`alertDelivery.ts`): `sent`, `retry` (refused for now, or nothing
 *  answered), `refused` (refused for good, or the alert was malformed), `off`
 *  (no chat linked, or this agent has no bot token). */
export type KeeperChannelResult = 'sent' | 'retry' | 'refused' | 'off';

/** An outcome the keeper records without a message (a request found more
 *  than a day late is dropped silently). */
const SILENT_OUTCOMES = ['dropped-old'] as const;

export interface KeeperRouteDeps {
  /** `KEEPER_AGENT_TOKEN`; undefined when not configured. */
  token: string | undefined;
  state: KeeperStatePort;
  locales: LocaleReader;
  /** Send one Telegram message; undefined when this agent has no bot token. */
  send: ((chatId: string, text: string) => Promise<TelegramOutcome>) | undefined;
  /** The Diamond this agent's bundle names for a chain, or null. */
  diamondOf: (chainId: number) => string | null;
  /** A chain's display name. */
  chainName: (chainId: number) => string;
  /** The app's origin, from this agent's configuration. */
  appOrigin: string;
  /** Unix seconds now. */
  now: () => number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NAME = /^[A-Za-z0-9_]{1,64}$/;

const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The keeper routes' paths. */
export function isKeeperPath(path: string): boolean {
  return path.startsWith('/keeper/');
}

/** Answer a keeper route, or null when `path` is not one. */
export async function handleKeeperRoute(req: Request, path: string, d: KeeperRouteDeps): Promise<Response | null> {
  if (!isKeeperPath(path)) return null;
  if (req.method !== 'POST') return reply({ error: 'method-not-allowed' }, 405);
  if (!d.token) return reply({ error: 'keeper-route-not-configured' }, 503);
  if (!(await bearerMatches(req.headers.get('Authorization'), d.token))) return reply({ error: 'unauthorized' }, 401);

  const body = await readBody(req);
  if (body instanceof Response) return body;
  const chainId = body.chainId;
  if (!isInt(chainId, 1, 2 ** 40)) return reply({ error: 'bad-chain' }, 400);
  const fence = fenceRefusal(chainId, body.diamond, d);
  if (fence) return fence;
  // The fence passed, so the body's Diamond IS the agent's own for the chain.
  // LOCK state is read and written for that deployment only.
  const dep: ChainDeployment = { chainId, diamond: (body.diamond as string).toLowerCase() };

  switch (path) {
    case '/keeper/lock/poll':
      return lockPoll(dep, body, d);
    case '/keeper/lock/pending':
      return lockPending(dep, body, d);
    case '/keeper/lock/handled':
      return lockHandled(dep, body, d);
    case '/keeper/alerts':
      return alerts(chainId, body, d);
    default:
      return reply({ error: 'not-found' }, 404);
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

async function lockPoll(dep: ChainDeployment, body: Record<string, unknown>, d: KeeperRouteDeps): Promise<Response> {
  const limit = body.limit === undefined ? 20 : body.limit;
  if (!isInt(limit, 1, KEEPER_POLL_MAX)) return reply({ error: 'bad-limit' }, 400);
  const requests = await d.state.keeperPoll(dep, d.now(), limit);
  return reply({ requests }, 200);
}

async function lockPending(dep: ChainDeployment, body: Record<string, unknown>, d: KeeperRouteDeps): Promise<Response> {
  if (!isInt(body.since, 0, 2 ** 40)) return reply({ error: 'bad-since' }, 400);
  const wallets = await d.state.pendingLockWallets(dep, body.since);
  return reply({ wallets }, 200);
}

async function lockHandled(dep: ChainDeployment, body: Record<string, unknown>, d: KeeperRouteDeps): Promise<Response> {
  const chainId = dep.chainId;
  const { wallet, upToId, outcome, reason } = body;
  if (typeof wallet !== 'string' || !ADDRESS.test(wallet)) return reply({ error: 'bad-wallet' }, 400);
  if (!isInt(upToId, 1, Number.MAX_SAFE_INTEGER)) return reply({ error: 'bad-id' }, 400);
  const silent = (SILENT_OUTCOMES as readonly unknown[]).includes(outcome);
  if (!silent && !(LOCK_OUTCOMES as readonly unknown[]).includes(outcome)) return reply({ error: 'bad-outcome' }, 400);
  if (outcome === 'refused' && (typeof reason !== 'string' || !NAME.test(reason))) return reply({ error: 'bad-reason' }, 400);

  const recordAs = outcome === 'refused' ? `refused: ${reason as string}` : (outcome as string);
  const lower = wallet.toLowerCase();
  const marked = await d.state.markLockHandled(dep, lower, upToId, recordAs, d.now());
  // Already handled: a repeated report records nothing and sends nothing, so
  // a keeper retrying after a lost answer never messages the chat twice.
  if (!marked) return reply({ recorded: false, telegram: 'off' }, 200);
  if (silent || marked.chatId === null) return reply({ recorded: true, telegram: 'off' }, 200);

  const m: AddressedAlert = {
    chainId,
    wallet: lower,
    alert:
      outcome === 'refused'
        ? { kind: 'lock', outcome: 'refused', reason: reason as string }
        : { kind: 'lock', outcome: outcome as LockOutcomeKind },
  };
  const telegram = await deliver(m, marked.chatId, d);
  return reply({ recorded: true, telegram }, 200);
}

async function alerts(chainId: number, body: Record<string, unknown>, d: KeeperRouteDeps): Promise<Response> {
  const list = body.alerts;
  if (!Array.isArray(list) || list.length === 0 || list.length > KEEPER_ALERTS_MAX) return reply({ error: 'bad-alerts' }, 400);
  const parsed = list.map((raw) => {
    const m = parseAddressedAlert(raw);
    return m && m.chainId === chainId ? m : null;
  });
  const recipients = parsed.flatMap((m) => (m ? [{ wallet: m.to ?? m.wallet, chainId }] : []));
  const chats = recipients.length > 0 ? await d.state.chatsOf(recipients) : [];
  let next = 0;
  const results: KeeperChannelResult[] = [];
  for (const m of parsed) {
    if (!m) {
      results.push('refused');
      continue;
    }
    const chatId = chats[next++] ?? null;
    results.push(chatId === null ? 'off' : await deliver(m, chatId, d));
  }
  return reply({ results }, 200);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Render `m` in its recipient's language and send it to `chatId`. */
async function deliver(m: AddressedAlert, chatId: string, d: KeeperRouteDeps): Promise<KeeperChannelResult> {
  if (!d.send) return 'off';
  const [locale] = await d.locales([{ wallet: m.to ?? m.wallet, chainId: m.chainId }]);
  const { text } = renderTelegramAlert(m, { locale, chainName: d.chainName(m.chainId), appOrigin: d.appOrigin });
  return channelResult(await d.send(chatId, text));
}

/** The agent's send outcome in the keeper's terms. `unknown` (nothing
 *  answered) is `retry`, as the keeper treats a Push send that may not have
 *  gone: a duplicate alert is better than a lost one. */
export function channelResult(o: TelegramOutcome): KeeperChannelResult {
  return o === 'accepted' ? 'sent' : o === 'refused' ? 'refused' : 'retry';
}

function fenceRefusal(chainId: number, diamond: unknown, d: KeeperRouteDeps): Response | null {
  if (typeof diamond !== 'string' || !ADDRESS.test(diamond)) return reply({ error: 'bad-diamond' }, 400);
  const ours = d.diamondOf(chainId);
  if (!ours) return reply({ error: 'chain-not-deployed' }, 404);
  if (ours.toLowerCase() !== diamond.toLowerCase()) return reply({ error: 'diamond-mismatch', diamond: ours }, 409);
  return null;
}

/** The body as a JSON object, or the refusal to answer. Read through the one
 *  bounded reader every Worker route uses (`requestBody.ts`). */
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  const read = await readJsonBody(req, KEEPER_BODY_MAX);
  if (!read.ok) return reply({ error: read.error }, read.status);
  const v = read.value;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : reply({ error: 'bad-body' }, 400);
}

/** Compare the presented bearer token with the configured one in constant
 *  time: both are hashed first, so neither the length nor a matching prefix
 *  of the secret shows in the time taken. */
export async function bearerMatches(header: string | null, token: string): Promise<boolean> {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(token)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = presented.length === 0 ? 1 : 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function reply(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
