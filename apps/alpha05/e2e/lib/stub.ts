/** The stand-in Worker's control surface, for specs that change its posture. */
export const STUB_PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

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
