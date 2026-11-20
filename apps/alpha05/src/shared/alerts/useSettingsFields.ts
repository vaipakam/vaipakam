import { useQuery } from '@tanstack/react-query';
import { useCopy } from '../copy/useCopy';
import { AGENT, type AgentClient } from './agentClient';

/** The settings the alert service keeps, as it names them. `vault-outflow`
 *  is the #3434 vault outflow choice. */
export type SettingsField = 'vault-outflow';

/**
 * The service's `GET /thresholds/fields` answer, read strictly: a list of
 * the optional settings it keeps (`{ fields: string[] }`). A 404 with no
 * error code of its own is a service from before the route, which keeps
 * none of them; any other answer is not understood and is `null`.
 */
export function parseSettingsFields(status: number, data: unknown): SettingsField[] | null {
  const body = data as { fields?: unknown; error?: unknown } | null;
  if (status === 404 && (body === null || typeof body?.error !== 'string')) return [];
  if (status !== 200 || !body || !Array.isArray(body.fields) || !body.fields.every((f) => typeof f === 'string')) return null;
  return (body.fields as string[]).filter((f): f is SettingsField => f === 'vault-outflow');
}

export interface SettingsFieldsRead {
  /** The fields, only while the latest read succeeded. */
  current: SettingsField[] | null;
  state: 'pending' | 'error' | 'success';
  error: string | null;
}

/** #3434 — which optional settings the alert service keeps, read before a
 *  control for one is offered: the wallet signs the setting into its
 *  message, so a service that does not keep it would refuse the signature
 *  and the choice would never save. */
export function useSettingsFields(client: AgentClient = AGENT): SettingsFieldsRead {
  const { text } = useCopy();
  const q = useQuery({
    queryKey: ['alerts', 'settingsFields', client.origin],
    queryFn: async () => {
      const res = await client.request('GET', '/thresholds/fields');
      const fields = parseSettingsFields(res.status, res.data);
      if (fields === null) throw new Error(text('alertChannels.fieldsShape'));
      return fields;
    },
    enabled: client.origin !== null,
    staleTime: 60_000,
    retry: 1,
  });
  return { current: q.status === 'success' ? q.data : null, state: q.status, error: q.status === 'error' ? (q.error as Error).message : null };
}
