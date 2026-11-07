/**
 * The record of which version a person approved for each site (#3236).
 *
 * The approval cannot be read from Cloudflare: anyone holding a Workers
 * Scripts Edit token writes the deployment, its message included, so a
 * message naming an approving run proves nothing by itself. The record
 * lives on GitHub instead, where the Cloudflare credential cannot write. The
 * promote job of .github/workflows/promote-one.yml, which runs only after a
 * person approves the `site-production` environment, ends by writing a
 * notice annotation `promoted <worker> <version id>` on its own job, and
 * only after reading the deployment back. Only a workflow job can write an
 * annotation on itself.
 *
 * `verifyApproval` uses the deployment's message only as a POINTER to the
 * run that claims to have approved the live version, then checks on GitHub:
 *   1. that run is a run of promote-site.yml on `main` (a run on any other
 *      branch carries that branch's copy of the workflow, so it is never
 *      trusted), whatever state the run as a whole is in (one site's
 *      promotion finishes while another still waits for approval);
 *   2. one of its successful `… / promote` jobs recorded exactly this worker
 *      and this version, and
 *   3. no later run of it on `main` recorded a different version for this
 *      worker, so an older approved version put back by hand (a replayed
 *      approval) fails.
 * Step 3 reads every run since the approval, with no fixed window, so a
 * site that has not changed for a long time is judged the same way.
 *
 * It needs a GitHub token with actions: read and checks: read.
 */

export const PROMOTE_WORKFLOW = '.github/workflows/promote-site.yml';
const NOTICE_TITLE = 'promoted';
const NOTICE = /^promoted (vaipakam-[a-z0-9-]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const RUN_URL = /^https:\/\/github\.com\/vaipakam\/vaipakam\/actions\/runs\/(\d+)$/;
// GitHub lists at most 1,000 runs for a filtered query. Past that the check
// says it could not verify, never that the site is unapproved.
const MAX_PAGES = 10;

/** The workflow command the promote job prints once the version is live. */
export const promotedNotice = (worker, version) => `::notice title=${NOTICE_TITLE}::promoted ${worker} ${version}`;

/** The worker and version an annotation records, or null when it is not one. */
export function parseApproval(annotation) {
  if (annotation?.annotation_level !== 'notice' || annotation?.title !== NOTICE_TITLE) return null;
  const m = NOTICE.exec(String(annotation.message ?? '').trim());
  return m ? { worker: m[1], version: m[2] } : null;
}

async function gh(path, { token, repo, api = 'https://api.github.com' }) {
  const res = await fetch(`${api}/repos/${repo}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

// One check reads every site, so a run's promotions are read once.
const promotionsCache = new Map();

/** Every promotion a run's successful promote jobs recorded: [{ worker, version }]. */
async function promotionsOf(runId, auth) {
  if (promotionsCache.has(runId)) return promotionsCache.get(runId);
  const found = [];
  const jobs = await gh(`actions/runs/${Number(runId)}/jobs?per_page=100`, auth);
  for (const job of jobs.jobs ?? []) {
    if (job.conclusion !== 'success' || !/ \/ promote$/.test(String(job.name))) continue;
    const notes = await gh(`check-runs/${Number(job.id)}/annotations?per_page=100`, auth);
    for (const note of Array.isArray(notes) ? notes : []) {
      const a = parseApproval(note);
      if (a) found.push(a);
    }
  }
  promotionsCache.set(runId, found);
  return found;
}

const trusted = (run) => run?.head_branch === 'main' && run?.path === PROMOTE_WORKFLOW;

/**
 * @returns {Promise<{ read: 'ok', approved: true, runUrl: string } | { read: 'ok', approved: false, why: string } | { read: 'error', error: string }>}
 */
export async function verifyApproval(worker, liveVersion, approvedBy, auth) {
  try {
    const id = RUN_URL.exec(String(approvedBy ?? ''))?.[1];
    if (!id) return { read: 'ok', approved: false, why: 'its deployment names no approving run' };
    const run = await gh(`actions/runs/${id}`, auth);
    if (!trusted(run)) return { read: 'ok', approved: false, why: `its deployment names run ${id}, which is not a run of promote-site.yml on main` };
    const mine = (await promotionsOf(run.id, auth)).filter((p) => p.worker === worker);
    if (!mine.some((p) => p.version === liveVersion)) {
      return { read: 'ok', approved: false, why: `run ${id}, which its deployment names, did not promote this version` };
    }
    // Every later run on main, newest first, read to the end.
    for (let page = 1; ; page++) {
      const list = await gh(`actions/workflows/promote-site.yml/runs?branch=main&created=${encodeURIComponent(`>=${run.created_at}`)}&per_page=100&page=${page}`, auth);
      const runs = list.workflow_runs ?? [];
      for (const later of runs) {
        if (later.id === run.id || !trusted(later) || Date.parse(later.created_at) < Date.parse(run.created_at)) continue;
        const other = (await promotionsOf(later.id, auth)).find((p) => p.worker === worker && p.version !== liveVersion);
        if (other) return { read: 'ok', approved: false, why: `a later approval run (${later.html_url}) promoted version ${other.version}, so this one was put back by hand` };
      }
      if (runs.length < 100) break;
      if (page === MAX_PAGES) return { read: 'error', error: 'more promote runs since the approval than GitHub lists; not read to the end' };
    }
    return { read: 'ok', approved: true, runUrl: String(run.html_url) };
  } catch (err) {
    return { read: 'error', error: String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 120) };
  }
}
