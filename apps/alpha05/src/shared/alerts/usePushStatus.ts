import { useQuery } from '@tanstack/react-query';
import { useCopy } from '../copy/useCopy';
import { AGENT } from './agentClient';
import { parsePushStatus, type PushStatus } from './alerts';

export interface PushStatusRead {
  /** The answer, only while the latest read succeeded: after a failed
   *  refetch the query keeps its last answer, which must not stand beside
   *  "could not ask" (RB-ALERT-CHANNELS). */
  current: PushStatus | null;
  state: 'pending' | 'error' | 'success';
  /** Why the latest read failed, when it did. */
  error: string | null;
}

/** The alert service's push status (`GET /push/status`), one read shared by
 *  every card that needs it. Disabled in a build with no alert service. */
export function usePushStatus(): PushStatusRead {
  const { text, format } = useCopy();
  const q = useQuery({
    queryKey: ['alerts', 'pushStatus'],
    queryFn: async () => {
      const res = await AGENT.request('GET', '/push/status');
      if (res.status !== 200) throw new Error(format('alertChannels.pushStatusCode', { status: String(res.status) }));
      const status = parsePushStatus(res.data);
      if (status === null) throw new Error(text('alertChannels.pushStatusShape'));
      return status;
    },
    enabled: AGENT.origin !== null,
    staleTime: 60_000,
    retry: 1,
  });
  return { current: q.status === 'success' ? q.data : null, state: q.status, error: q.status === 'error' ? (q.error as Error).message : null };
}
