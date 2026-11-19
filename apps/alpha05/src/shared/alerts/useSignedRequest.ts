import { useCallback, useState } from 'react';
import { useConfig } from 'wagmi';
import { signMessage } from 'wagmi/actions';
import { AGENT, AgentUnavailable, type AgentClient } from './agentClient';
import { isUserRejection, nextIssuedAt } from './useAlertAction';

type Hex = `0x${string}`;

/** Where one signed request to the alert service stands. `declined`: the
 *  wallet refused to sign, and nothing was sent. `unreachable`: the service
 *  could not be asked, and nothing is known to have changed. */
export type SignedRun<A> = { phase: 'idle' } | { phase: 'signing' | 'sending' } | { phase: 'answered'; answer: A } | { phase: 'declined' } | { phase: 'unreachable'; message: string };

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
 */
export function useSignedRequest<Action, Answer>(route: SignedRoute<Action, Answer>, chainId: number, wallet: Hex, client: AgentClient = AGENT) {
  const config = useConfig();
  const [run, setRun] = useState<SignedRun<Answer>>({ phase: 'idle' });
  const busy = run.phase === 'signing' || run.phase === 'sending';

  const send = useCallback(
    async (action: Action): Promise<Answer | null> => {
      setRun({ phase: 'signing' });
      const issuedAt = nextIssuedAt();
      let signature: Hex;
      try {
        signature = await signMessage(config, { account: wallet, message: route.message(action, wallet, chainId, issuedAt) });
      } catch (e) {
        setRun(isUserRejection(e) ? { phase: 'declined' } : { phase: 'unreachable', message: (e as Error).message });
        return null;
      }
      setRun({ phase: 'sending' });
      try {
        const res = await client.request('POST', route.path(action), route.body(action, wallet, chainId, issuedAt, signature));
        const answer = route.read(action, res.status, res.data);
        setRun({ phase: 'answered', answer });
        return answer;
      } catch (e) {
        setRun({ phase: 'unreachable', message: e instanceof AgentUnavailable ? e.message : (e as Error).message });
        return null;
      }
    },
    [config, client, route, wallet, chainId],
  );

  return { run, busy, send, off: client.origin === null };
}
