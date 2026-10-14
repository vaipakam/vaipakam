/** The agent Worker's origin (`VITE_AGENT_ORIGIN`), trailing slash removed,
 *  or `null` when this build has none — every agent-backed feature is
 *  fail-closed on that `null`. One reader, so the alerts, the support ticket
 *  and the close-out route agree on whether the agent exists. */
export function agentOrigin(): string | null {
  const url = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}
