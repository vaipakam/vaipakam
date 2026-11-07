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
  // The deployment's own message: an approved promotion (#3236) names the
  // GitHub run that approved it. Kept only when it has that exact shape, and
  // only a cross-check: the deployer writes it (see approvalRecord.mjs).
  const rawMessage = String(latest.annotations?.['workers/message'] ?? '');
  const approvedBy = APPROVED_MESSAGE.exec(rawMessage)?.[1] ?? null;
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
  return { read: 'ok', deployedAt, approvedBy, versions };
}

/**
 * The deployment message an approved promotion writes, and the only form
 * read back: the approving run's URL. Whoever deploys writes this message,
 * so it is a cross-check only; the proof of an approval is GitHub's record
 * (approvalRecord.mjs).
 */
export const APPROVED_MESSAGE = /^approved in (https:\/\/github\.com\/vaipakam\/vaipakam\/actions\/runs\/\d+)$/;

/**
 * One version of a Worker, shape-checked like readLatestDeployment's.
 *
 * @returns {Promise<{ read: 'ok', id: string, tag: string, stamp: RegExpExecArray | null, message: string, uploadedAt: string | null, hasPreview: boolean } | { read: 'none' } | { read: 'error', error: string }>}
 */
export async function readVersion(name, id, auth) {
  if (!VERSION_ID.test(String(id))) return { read: 'error', error: 'not a version id' };
  try {
    const r = await cloudflare(`${encodeURIComponent(name)}/versions/${encodeURIComponent(id)}`, auth);
    if (r.status === 404) return { read: 'none' };
    const rawTag = String(r.result?.annotations?.['workers/tag'] ?? '');
    const stamp = DEPLOY_TAG.exec(rawTag);
    const rawMessage = String(r.result?.annotations?.['workers/message'] ?? '');
    return {
      read: 'ok',
      id: String(id),
      tag: stamp ? rawTag : '',
      stamp,
      // Only the stamp's own wording is kept: "built from <40 hex>".
      message: /^built from [0-9a-f]{40}$/.test(rawMessage) ? rawMessage : '',
      uploadedAt: isoTime(r.result?.metadata?.created_on),
      hasPreview: r.result?.metadata?.has_preview === true,
    };
  } catch (err) {
    return { read: 'error', error: oneLine(err.message, 120) };
  }
}

/**
 * The most recent versions of a Worker (newest first), shape-checked.
 *
 * @returns {Promise<{ read: 'ok', versions: Array<{ id: string, tag: string, message: string, uploadedAt: string | null, hasPreview: boolean }> } | { read: 'error', error: string }>}
 */
export async function readRecentVersions(name, auth, perPage = 20) {
  try {
    const r = await cloudflare(`${encodeURIComponent(name)}/versions?per_page=${Number(perPage)}`, auth);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const items = Array.isArray(r.result?.items) ? r.result.items : null;
    if (!items) throw new Error('no versions list in the answer');
    const versions = [];
    for (const v of items) {
      if (!VERSION_ID.test(String(v.id))) continue;
      const rawTag = String(v.annotations?.['workers/tag'] ?? '');
      const rawMessage = String(v.annotations?.['workers/message'] ?? '');
      versions.push({
        id: String(v.id),
        tag: DEPLOY_TAG.test(rawTag) ? rawTag : '',
        message: /^built from [0-9a-f]{40}$/.test(rawMessage) ? rawMessage : '',
        uploadedAt: isoTime(v.metadata?.created_on),
        hasPreview: v.metadata?.has_preview === true,
      });
    }
    return { read: 'ok', versions };
  } catch (err) {
    return { read: 'error', error: oneLine(err.message, 120) };
  }
}

/**
 * Make `versionId` take all of the Worker's traffic, recording the approving
 * run in the deployment's message. Needs a token with Workers Scripts Edit.
 */
export async function deployVersion(name, versionId, runUrl, { account, token }) {
  if (!VERSION_ID.test(String(versionId))) throw new Error('not a version id');
  const message = `approved in ${runUrl}`;
  if (!APPROVED_MESSAGE.test(message)) throw new Error('the approving run URL is not this repository\'s');
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(name)}/deployments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      strategy: 'percentage',
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { 'workers/message': message },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.success) throw new Error('the API answered success=false');
}
