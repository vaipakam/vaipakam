/** The stand-in Worker's control surface, for specs that change its posture. */
export const STUB_PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

export type IndexPosture = 'live' | 'stale' | 'down' | 'other-diamond';

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
