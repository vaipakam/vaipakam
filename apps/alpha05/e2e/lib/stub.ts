/** The stand-in Worker's control surface, for specs that change its posture. */
export const STUB_PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

/** Put every stand-in setting back as it started: the index live, no
 *  unplaced loans, no added inbox rows, a fresh alert service. The suite
 *  calls it after every test (`lib/wallet.ts`); a spec need not. */
export async function resetStandIns(): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub refused reset: ${res.status}`);
}

export type IndexPosture = 'live' | 'stale' | 'down' | 'other-diamond' | 'schema-pending';

/** Put the stand-in index into a posture: `stale` reports a cursor half an
 *  hour old, `down` answers 503, `other-diamond` reports a Diamond this
 *  build does not bind to. `live` restores the chain-hydrated answer. */
export async function setIndexPosture(posture: IndexPosture): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/index-posture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posture }),
  });
  if (!res.ok) throw new Error(`stub refused posture ${posture}: ${res.status}`);
}

/** Set how many loans on a pair `/loans/recent` reports as having terms the
 *  index has not confirmed (`{ count: 0, capped: false }` restores none). */
export async function setUnplacedLoans(count: number, capped: boolean): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/unplaced`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count, capped }),
  });
  if (!res.ok) throw new Error(`stub refused unplaced ${count}: ${res.status}`);
}

/** Add inbox rows for `recipient` that the fixture chain cannot produce by
 *  itself (each row's `kind` and the fields it names; the stand-in stamps
 *  the rest after every chain row). */
export async function addNotifications(recipient: string, rows: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/notifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient, rows }) });
  if (!res.ok) throw new Error(`stub refused notifications: ${res.status}`);
}

/** Remove every inbox row a spec added. */
export async function resetNotifications(): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/notifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
  if (!res.ok) throw new Error(`stub refused notifications reset: ${res.status}`);
}

/** One request the stand-in alert service received, as sent. */
export interface AgentRequest {
  path: string;
  body: Record<string, unknown>;
}

/** Drive the stand-in alert service: `reset` forgets everything; `push` sets
 *  what `GET /push/status` answers; `handshake` marks a wallet's latest link
 *  code as received by the bot; `next` forces the next answer on one path. */
export async function controlAgent(control: {
  reset?: true;
  push?: 'available' | 'agent-only' | 'unavailable' | 'down';
  billed?: number[];
  handshake?: string;
  next?: { path: string; status: number; body: Record<string, unknown> };
  slow?: { path: string };
}): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(control) });
  if (!res.ok) throw new Error(`stub refused agent control: ${res.status} ${await res.text()}`);
}

/** Every request the stand-in alert service received, and what it stored. */
export async function agentState(): Promise<{ requests: AgentRequest[]; thresholds: Record<string, Record<string, unknown>>; linked: string[] }> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/agent`);
  if (!res.ok) throw new Error(`stub refused agent state: ${res.status}`);
  return res.json();
}

/** One list's state as `/assets/rankings` states it. */
export interface StubRankingSource {
  listFetchedAt: number | null;
  lastRun: { fetchedAt: number; ok: boolean; rowCount: number; detail: string | null } | null;
}

/** Store a rankings answer for one token chain (#3446), or make the route
 *  answer 503 with `{ down: true }`. The suite's reset clears both. */
export async function setRankings(
  control: { chainId: number; sources: { cg: StubRankingSource; cp: StubRankingSource }; assets: { address: string; ranks: Record<string, { rank: number; name: string; symbol: string }> }[] } | { down: true },
): Promise<void> {
  const res = await fetch(`${STUB_ORIGIN}/__stub/rankings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(control) });
  if (!res.ok) throw new Error(`stub refused rankings: ${res.status} ${await res.text()}`);
}
