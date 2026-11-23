import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { signMessageFor } from '../tx/walletGuard';
import { AGENT, AgentUnavailable, type AgentClient } from './agentClient';
import { isUserRejection, nextIssuedAt } from './useAlertAction';

type Hex = `0x${string}`;

/** Where one signed request to the alert service stands. `declined`: the
 *  wallet refused to sign, and nothing was sent. `unreachable`: the service
 *  could not be asked, and nothing is known to have changed. `not-offered`:
 *  the service this build uses has no such route, so no signature was asked
 *  for and nothing was sent. An answer and an unreachable request carry the
 *  request reference (#3922) when one is known, for the person to quote. */
export type SignedRun<A> =
  | { phase: 'idle' }
  | { phase: 'checking' | 'signing' | 'sending' }
  | { phase: 'answered'; answer: A; reference: string | null }
  | { phase: 'declined' }
  | { phase: 'not-offered' }
  | { phase: 'unreachable'; message: string; reference: string | null };

/**
 * Whether the alert service offers a route, asked before any signature: an
 * empty POST reaches a route's own payload check (an answer naming its
 * error), while a service without the route answers its generic 404 with no
 * JSON body. Only that 404 reads as not offered; anything else lets the
 * signed request go ahead and be read as usual.
 */
export async function routeOffered(client: AgentClient, path: string): Promise<boolean> {
  const res = await client.request('POST', path, {});
  return !(res.status === 404 && (res.data === null || typeof res.data.error !== 'string'));
}

/** How one kind of signed request is built and read. */
export interface SignedRoute<Action, Answer> {
  message: (action: Action, wallet: Hex, chainId: number, issuedAt: number) => string;
  path: (action: Action) => string;
  body: (action: Action, wallet: Hex, chainId: number, issuedAt: number, signature: Hex) => Record<string, unknown>;
  read: (action: Action, status: number, data: Record<string, unknown> | null) => Answer;
}

/**
 * One signed request at a time, for the routes that keep a wallet's private
 * notes with the alert service (#3769 watches, #3771 goals): the wallet
 * signs the route's message, the request is POSTed, and the answer is read
 * by the route's own reader. The `issuedAt` is the one the Alerts page uses,
 * so a request never repeats a second another request already signed.
 *
 * Everything is scoped to the identity it was asked for, the network, the
 * wallet and the subject the request is about, such as one loan
 * (`signedIdentity`): a run started under one is not shown under another,
 * and an answer that arrives after any of them changed is dropped (the
 * caller gets null), so one wallet's private list can never be shown, or
 * counted, under the next, nor one loan's answer on another loan's page.
 */
export function useSignedRequest<Action, Answer>(route: SignedRoute<Action, Answer>, chainId: number, wallet: Hex, client: AgentClient = AGENT, subject = '') {
  const config = useConfig();
  const who = signedIdentity(chainId, wallet, subject);
  const live = useRef(who);
  useEffect(() => {
    live.current = who;
  }, [who]);
  const [state, setState] = useState<{ who: string; run: SignedRun<Answer> }>({ who, run: { phase: 'idle' } });
  const run: SignedRun<Answer> = state.who === who ? state.run : { phase: 'idle' };
  const busy = run.phase === 'checking' || run.phase === 'signing' || run.phase === 'sending';

  const send = useCallback(
    async (action: Action): Promise<Answer | null> => {
      const asked = signedIdentity(chainId, wallet, subject);
      // A step after the identity moved is not shown under the new one.
      const setRun = (r: SignedRun<Answer>) => {
        if (live.current === asked) setState({ who: asked, run: r });
      };
      setRun({ phase: 'checking' });
      try {
        if (!(await routeOffered(client, route.path(action)))) {
          setRun({ phase: 'not-offered' });
          return null;
        }
      } catch (e) {
        setRun(unreachable(e));
        return null;
      }
      setRun({ phase: 'signing' });
      const issuedAt = nextIssuedAt();
      let signature: Hex;
      try {
        signature = await signMessageFor(config, chainId, { account: wallet, message: route.message(action, wallet, chainId, issuedAt) });
      } catch (e) {
        // Nothing was sent, so there is no request to name.
        setRun(isUserRejection(e) ? { phase: 'declined' } : { phase: 'unreachable', message: (e as Error).message, reference: null });
        return null;
      }
      setRun({ phase: 'sending' });
      try {
        const res = await client.request('POST', route.path(action), route.body(action, wallet, chainId, issuedAt, signature));
        const answer = route.read(action, res.status, res.data);
        if (live.current !== asked) return null;
        setRun({ phase: 'answered', answer, reference: res.reference });
        return answer;
      } catch (e) {
        setRun(unreachable(e));
        return null;
      }
    },
    [config, client, route, wallet, chainId, subject],
  );

  return { run, busy, send, off: client.origin === null, who };
}

/** An unreachable step, carrying the reference of the request that failed
 *  when the failure came from the service client. */
function unreachable(e: unknown): { phase: 'unreachable'; message: string; reference: string | null } {
  return e instanceof AgentUnavailable ? { phase: 'unreachable', message: e.message, reference: e.reference } : { phase: 'unreachable', message: (e as Error).message, reference: null };
}

/** The identity a signed request belongs to: the network, the wallet and
 *  the subject it is about (empty for a wallet-wide list). */
export function signedIdentity(chainId: number, wallet: string, subject = ''): string {
  return `${chainId}:${wallet.toLowerCase()}:${subject}`;
}
