/**
 * Reading a Worker's live Cloudflare deployment, for the checks that compare
 * it with this repository: the deploy-lag check (#2242, is it running `main`?)
 * and the served-build check (#3236, is it serving what that commit builds?).
 *
 * One reader, so both checks see the same deployment the same way: the
 * latest deployment, the versions in it that take traffic, and each
 * version's stamp tag and upload time.
 *
 * WHAT COMES BACK FROM THE NETWORK IS CHECKED HERE. Every value travels into
 * a run log, a step summary, an alert issue and the ops chat, so it is kept
 * only in a known shape: a version id as a UUID, a time as the ISO string of
 * its parsed value, a tag only when it is a deploy stamp
 * (packages/lib/src/deployStamp.mjs). An error carries the HTTP status, never
 * the response body.
 *
 * It needs an API token with Account · Workers Scripts · Read and nothing
 * else.
 */
import { DEPLOY_TAG } from '../../../packages/lib/src/deployStamp.mjs';

export const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isoTime = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const oneLine = (text, max) => String(text).replace(/[\r\n]+/g, ' ').slice(0, max);

/** GET `workers/scripts/<path>` on the account. 404 is an answer, not an error. */
export async function cloudflare(path, { account, token }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.success) throw new Error('the API answered success=false');
  return { status: 200, result: body.result };
}

/**
 * The Worker's latest deployment.
 *
 * @returns {Promise<
 *   | { read: 'none' }
 *   | { read: 'error', error: string }
 *   | { read: 'ok', deployedAt: string, versions: Array<{ id: string, percentage: number, tag: string, stamp: RegExpExecArray | null, uploadedAt: string | null }> }
 * >}
 *   `tag` is the version's tag when it is a deploy stamp, else ''; `stamp` is
 *   its match (`[1]` the 12-digit commit, `[2]` '-dirty' or undefined). Only
 *   versions taking traffic are listed: a version kept at 0% serves nothing.
 */
export async function readLatestDeployment(name, auth) {
  let deployments;
  try {
    const r = await cloudflare(`${encodeURIComponent(name)}/deployments`, auth);
    if (r.status === 404) return { read: 'none' };
    deployments = Array.isArray(r.result?.deployments) ? r.result.deployments : null;
    if (!deployments) throw new Error('no deployments list in the answer');
  } catch (err) {
    return { read: 'error', error: oneLine(err.message, 120) };
  }
  if (deployments.length === 0) return { read: 'none' };
  const latest = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  const deployedAt = isoTime(latest.created_on);
  if (!deployedAt) return { read: 'error', error: 'the latest deployment carries no readable time' };
  const versions = [];
  for (const v of (latest.versions ?? []).filter((x) => Number(x.percentage) > 0)) {
    if (!VERSION_ID.test(String(v.version_id))) {
      return { read: 'error', error: 'the latest deployment names a version id of an unknown shape' };
    }
    try {
      const r = await cloudflare(`${encodeURIComponent(name)}/versions/${encodeURIComponent(v.version_id)}`, auth);
      // A version the deployment names but the API cannot find is a failed
      // read, never an unstamped version.
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const rawTag = String(r.result?.annotations?.['workers/tag'] ?? '');
      const stamp = DEPLOY_TAG.exec(rawTag);
      versions.push({
        id: String(v.version_id),
        percentage: Number(v.percentage),
        tag: stamp ? rawTag : '',
        stamp,
        uploadedAt: isoTime(r.result?.metadata?.created_on),
      });
    } catch (err) {
      return { read: 'error', error: `version ${v.version_id}: ${oneLine(err.message, 80)}` };
    }
  }
  if (versions.length === 0) return { read: 'error', error: 'the latest deployment lists no version taking traffic' };
  return { read: 'ok', deployedAt, versions };
}
