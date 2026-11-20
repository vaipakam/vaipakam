import { useCallback, useSyncExternalStore } from 'react';
import { useConfig } from 'wagmi';
import { newRequestKey, requestKeyHash } from '@vaipakam/lib/alertsMessage';
import { signMessageFor } from '../tx/walletGuard';
import { AGENT, AgentUnavailable, type AgentClient } from './agentClient';
import { alertBody, alertMessage, alertRoute, readAlertAnswer, type AlertAction, type AlertAnswer } from './alerts';
import { CODE_LIFETIME_S, recordAnswer } from './known';
import { clearPending, keepPending, loadPending, pendingExpiresAt, type PendingAlert } from './pendingRequest';

type Hex = `0x${string}`;

/** Where one signed alert action stands. `declined`: the wallet refused to
 *  sign, and nothing was sent. `unreachable`: the service could not be
 *  asked (or this build has none), and nothing is known to have changed. */
export type AlertRun =
  | { phase: 'idle' }
  | { phase: 'signing' | 'sending'; action: AlertAction }
  | { phase: 'answered'; action: AlertAction; answer: AlertAnswer }
  | { phase: 'declined'; action: AlertAction }
  | { phase: 'unreachable'; action: AlertAction; message: string };

/** The last `issuedAt` this browser signed. The service accepts a signed
 *  message once, and a wallet signs the same message to the same signature,
 *  so two requests for one action in the same second would read as a
 *  repeat. Each request therefore takes a second after the last one: the
 *  clock's second, or one past the last, whichever is later. The last one is
 *  also kept in this browser's storage, so a reload or a second tab cannot
 *  sign the same second again. */
let lastIssuedAt = 0;
const ISSUED_KEY = 'alpha05.alerts.lastIssuedAt';

type IssuedStore = Pick<Storage, 'getItem' | 'setItem'> | null;

function browserStore(): IssuedStore {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** How far ahead of the clock a kept count may be and still be used. The
 *  service refuses a request more than ten minutes from its own clock, so a
 *  count further ahead (left by a clock that was fast and has since been
 *  corrected) would make every request fail until real time caught up: it
 *  is dropped instead, and the clock's second is used. */
const MAX_AHEAD_S = 300;

export function nextIssuedAt(nowMs: number = Date.now(), store: IssuedStore = browserStore()): number {
  const nowS = Math.floor(nowMs / 1000);
  const usable = (n: number) => (n > 0 && n <= nowS + MAX_AHEAD_S ? n : 0);
  let stored = 0;
  try {
    const n = Number(store?.getItem(ISSUED_KEY));
    if (Number.isSafeInteger(n)) stored = usable(n);
  } catch {
    // Storage that cannot be read leaves this page's own count.
  }
  lastIssuedAt = Math.max(nowS, usable(lastIssuedAt) + 1, stored + 1);
  try {
    store?.setItem(ISSUED_KEY, String(lastIssuedAt));
  } catch {
    // Storage that cannot be written leaves this page's own count.
  }
  return lastIssuedAt;
}

/** A wallet refusal, by the EIP-1193 code wallets use or by its words. */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (c.code === 4001 || c.name === 'UserRejectedRequestError') return true;
    cur = c.cause;
  }
  return /reject|denied|cancel/i.test((e as Error)?.message ?? '');
}

/** A live Telegram link code. Held in this tab's memory only, never in
 *  storage: it is a one-time secret that lasts ten minutes. */
export interface LinkCode {
  code: string;
  botUrl: string | null;
  expiresAt: number;
}

interface RunEntry {
  run: AlertRun;
  code: LinkCode | null;
  /** The request this browser started and the service has not answered
   *  (#3836), as kept in storage; read from storage the first time the
   *  wallet and network are shown. */
  pending: PendingAlert | null;
}

const IDLE: RunEntry = { run: { phase: 'idle' }, code: null, pending: null };
/** Each wallet and network's action, outside any page: a card mounted while
 *  an action is out shows it (and offers no second one), and the outcome of
 *  an action that finishes while no card is mounted is what the next card
 *  shows. */
const runs = new Map<string, RunEntry>();
const runListeners = new Set<() => void>();

function setRun(identity: string, patch: Partial<RunEntry>): void {
  runs.set(identity, { ...(runs.get(identity) ?? IDLE), ...patch });
  for (const l of runListeners) l();
}

/** The entry for a wallet and network, reading its kept request from
 *  storage the first time. The same object is returned until it changes. */
function entryFor(identity: string, chainId: number, wallet: Hex): RunEntry {
  const known = runs.get(identity);
  if (known) return known;
  const entry = { ...IDLE, pending: loadPending(chainId, wallet) };
  runs.set(identity, entry);
  return entry;
}

/** A wallet-wide unlink revokes every code the wallet holds, on every
 *  network: none of them may still be offered. */
function dropWalletCodes(wallet: Hex): void {
  const suffix = `:${wallet.toLowerCase()}`;
  for (const [identity, entry] of runs) if (identity.endsWith(suffix) && entry.code) runs.set(identity, { ...entry, code: null });
}

function subscribeRuns(listener: () => void): () => void {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

/**
 * One signed alert action at a time for a wallet on one network (RB-ALERT-
 * CHANNELS): the wallet signs the action's message, the request is sent, the
 * service's answer is read, and what it did is recorded for the wallet and
 * network that signed, whichever page is showing by then.
 */
export function useAlertAction(chainId: number, wallet: Hex, client: AgentClient = AGENT) {
  const config = useConfig();
  const identity = `${chainId}:${wallet.toLowerCase()}`;
  const entry = useSyncExternalStore(
    subscribeRuns,
    () => entryFor(identity, chainId, wallet),
    () => IDLE,
  );
  const busy = entry.run.phase === 'signing' || entry.run.phase === 'sending';

  /** Ask the wallet to sign `p` and send it. `p` is kept before the wallet
   *  is asked and dropped once the service answers, except when it could
   *  not check the signature yet (nothing recorded the request, so the same
   *  one may be sent again). A declined signature drops it; any other
   *  failure (a wallet that stopped waiting, a network error) keeps it, to
   *  be finished later. */
  const send = useCallback(
    async (p: PendingAlert): Promise<AlertAnswer | null> => {
      const { action } = p;
      keepPending(chainId, wallet, p);
      setRun(identity, { run: { phase: 'signing', action }, pending: p });
      const drop = () => {
        clearPending(chainId, wallet);
        // A newer request started meanwhile in this tab is not dropped.
        if (runs.get(identity)?.pending === p) setRun(identity, { pending: null });
      };
      let signature: Hex;
      try {
        signature = await signMessageFor(config, chainId, { account: wallet, message: alertMessage(action, wallet, chainId, p.issuedAt, requestKeyHash(p.requestKey)) });
      } catch (e) {
        const declined = isUserRejection(e);
        if (declined) drop();
        setRun(identity, { run: declined ? { phase: 'declined', action } : { phase: 'unreachable', action, message: (e as Error).message } });
        return null;
      }
      setRun(identity, { run: { phase: 'sending', action } });
      const route = alertRoute(action);
      try {
        const res = await client.request(route.method, route.path, alertBody(action, wallet, chainId, p.issuedAt, signature, p.requestKey));
        const answer = readAlertAnswer(action, res.status, res.data);
        if (answer.ok || answer.problem !== 'verify-down') drop();
        const at = Math.floor(Date.now() / 1000);
        recordAnswer(chainId, wallet, action, answer, at);
        if (answer.ok && answer.action === 'unlink' && answer.scope === 'wallet') dropWalletCodes(wallet);
        const code =
          answer.ok && answer.action === 'link'
            ? { code: answer.code, botUrl: answer.botUrl, expiresAt: at + CODE_LIFETIME_S }
            : answer.ok && (answer.action === 'test-alert' || answer.action === 'unlink')
              ? null
              : (runs.get(identity)?.code ?? null);
        setRun(identity, { run: { phase: 'answered', action, answer }, code });
        return answer;
      } catch (e) {
        setRun(identity, { run: { phase: 'unreachable', action, message: e instanceof AgentUnavailable ? e.message : (e as Error).message } });
        return null;
      }
    },
    [config, client, wallet, chainId, identity],
  );

  /** Start `action` as a new request, with a fresh key. It replaces any
   *  request kept for this wallet and network. */
  const start = useCallback(
    async (action: AlertAction): Promise<AlertAnswer | null> => {
      const now = runs.get(identity)?.run.phase;
      if (now === 'signing' || now === 'sending') return null;
      return send({ action, issuedAt: nextIssuedAt(), requestKey: newRequestKey() });
    },
    [send, identity],
  );

  /** Finish the kept request: the same text, the same key. One past its
   *  limit is dropped instead, and nothing is asked. */
  const finish = useCallback(async (): Promise<AlertAnswer | null> => {
    const cur = runs.get(identity);
    if (!cur?.pending || cur.run.phase === 'signing' || cur.run.phase === 'sending') return null;
    if (pendingExpiresAt(cur.pending) < Math.floor(Date.now() / 1000)) {
      clearPending(chainId, wallet);
      setRun(identity, { pending: null });
      return null;
    }
    return send(cur.pending);
  }, [send, identity, chainId, wallet]);

  /** Forget the kept request. The wallet may still hold its approval; with
   *  the key gone, nothing can present it. */
  const discard = useCallback(() => {
    const cur = runs.get(identity);
    if (cur?.run.phase === 'signing' || cur?.run.phase === 'sending') return;
    clearPending(chainId, wallet);
    setRun(identity, { pending: null, run: { phase: 'idle' } });
  }, [identity, chainId, wallet]);

  const reset = useCallback(() => setRun(identity, { run: { phase: 'idle' } }), [identity]);
  return { run: entry.run, code: entry.code, pending: entry.pending, busy, start, finish, discard, reset };
}
