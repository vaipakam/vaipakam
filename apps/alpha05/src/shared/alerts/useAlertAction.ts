import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { signMessage } from 'wagmi/actions';
import { AGENT, AgentUnavailable, type AgentClient } from './agentClient';
import { alertBody, alertMessage, alertRoute, readAlertAnswer, type AlertAction, type AlertAnswer } from './alerts';

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

export function nextIssuedAt(nowMs: number = Date.now(), store: IssuedStore = browserStore()): number {
  let stored = 0;
  try {
    const n = Number(store?.getItem(ISSUED_KEY));
    if (Number.isSafeInteger(n) && n > 0) stored = n;
  } catch {
    // Storage that cannot be read leaves this page's own count.
  }
  lastIssuedAt = Math.max(Math.floor(nowMs / 1000), lastIssuedAt + 1, stored + 1);
  try {
    store?.setItem(ISSUED_KEY, String(lastIssuedAt));
  } catch {
    // Storage that cannot be written leaves this page's own count.
  }
  return lastIssuedAt;
}

/** A wallet refusal, by the EIP-1193 code wallets use or by its words. */
function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const c = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (c.code === 4001 || c.name === 'UserRejectedRequestError') return true;
    cur = c.cause;
  }
  return /reject|denied|cancel/i.test((e as Error)?.message ?? '');
}

/**
 * One signed alert action at a time for a wallet on one network (RB-ALERT-
 * CHANNELS): the wallet signs the action's message, the request is sent, and
 * the service's answer is read. An answer that arrives after the wallet or
 * network changed is not shown against the new identity; it is still
 * returned, so what the service did is recorded for the wallet that signed.
 */
export function useAlertAction(chainId: number, wallet: Hex, client: AgentClient = AGENT) {
  const config = useConfig();
  const identity = `${chainId}:${wallet.toLowerCase()}`;
  const [state, setState] = useState<{ identity: string; run: AlertRun }>({ identity, run: { phase: 'idle' } });
  const current = useRef(identity);
  useEffect(() => {
    current.current = identity;
  }, [identity]);
  // A run started for another wallet or network is not this one's.
  const run: AlertRun = state.identity === identity ? state.run : { phase: 'idle' };
  const busy = run.phase === 'signing' || run.phase === 'sending';

  const start = useCallback(
    async (action: AlertAction): Promise<AlertAnswer | null> => {
      const startedAs = identity;
      const settle = (next: AlertRun) => {
        if (current.current === startedAs) setState({ identity: startedAs, run: next });
      };
      settle({ phase: 'signing', action });
      const issuedAt = nextIssuedAt();
      let signature: Hex;
      try {
        signature = await signMessage(config, { account: wallet, message: alertMessage(action, wallet, chainId, issuedAt) });
      } catch (e) {
        if (isUserRejection(e)) settle({ phase: 'declined', action });
        else settle({ phase: 'unreachable', action, message: (e as Error).message });
        return null;
      }
      settle({ phase: 'sending', action });
      const route = alertRoute(action);
      try {
        const res = await client.request(route.method, route.path, alertBody(action, wallet, chainId, issuedAt, signature));
        const answer = readAlertAnswer(action, res.status, res.data);
        // The answer is returned whoever is connected now, so the caller can
        // record what the service did for the wallet that signed; only the
        // run shown on the page is dropped.
        settle({ phase: 'answered', action, answer });
        return answer;
      } catch (e) {
        settle({ phase: 'unreachable', action, message: e instanceof AgentUnavailable ? e.message : (e as Error).message });
        return null;
      }
    },
    [config, client, wallet, chainId, identity],
  );

  const reset = useCallback(() => setState({ identity: current.current, run: { phase: 'idle' } }), []);
  return { run, busy, start, reset };
}
