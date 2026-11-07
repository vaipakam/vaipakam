/**
 * The record of which version a person approved for each site (#3236).
 *
 * The approval cannot be read from Cloudflare: anyone holding a Workers
 * Scripts Edit token writes the deployment, its message included, so a
 * message naming an approving run proves nothing by itself. The record
 * lives on GitHub instead, where the Cloudflare credential cannot write. The
 * promote job of .github/workflows/promote-one.yml, which runs only after a
 * person approves the `site-production` environment, ends by writing a
 * notice annotation `promoted <worker> <version id> <commit>` on its own
 * job, and only after reading the deployment back. Only a workflow job can
 * write an annotation on itself.
 *
 * WHAT "THE LATEST APPROVAL" MEANS. Promotion only ever moves a site to a
 * commit that descends from the one live (promote-site.mjs refuses anything
 * else), so a site's approvals form a chain ordered by COMMIT ANCESTRY. That
 * order holds whatever order runs were created, dispatched or approved in,
 * and however often a run was re-run, which is why it is the order used here
 * rather than any timestamp.
 *
 * `verifyApproval` uses the deployment's message only as a POINTER to the
 * run that claims to have approved the live version, then checks on GitHub:
 *   1. that run is a run of promote-site.yml on `main` (a run on any other
 *      branch carries that branch's copy of the workflow, so it is never
 *      trusted), whatever state the run as a whole is in;
 *   2. one of its successful `… / promote` jobs, in any attempt, recorded
 *      exactly this worker, this version and the live commit, and
 *   3. no run of it on `main` recorded this worker at a commit that strictly
 *      descends from the live one. Such a promotion can only come from a run
 *      created after the live commit existed, so every run created since the
 *      live commit's time (less a margin for clock skew) is read, to the end:
 *      an older approved version put back by hand (a replayed approval) fails,
 *      however long ago the newer approval was.
 *
 * It needs a GitHub token with actions: read and checks: read.
 */

export const PROMOTE_WORKFLOW = '.github/workflows/promote-site.yml';
const NOTICE_TITLE = 'promoted';
const NOTICE = /^promoted (vaipakam-[a-z0-9-]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([0-9a-f]{40})$/;
// A run's clock and git's are different clocks.
const SKEW_MS = 6 * 3600_000;
const RUN_URL = /^https:\/\/github\.com\/vaipakam\/vaipakam\/actions\/runs\/(\d+)$/;
// GitHub lists at most 1,000 runs for a filtered query. Past that the check
// says it could not verify, never that the site is unapproved or approved.
const MAX_PAGES = 10;

/** The workflow command the promote job prints once the version is live. */
export const promotedNotice = (worker, version, commit) => `::notice title=${NOTICE_TITLE}::promoted ${worker} ${version} ${commit}`;

/** The worker, version and commit an annotation records, or null when it is not one. */
export function parseApproval(annotation) {
  if (annotation?.annotation_level !== 'notice' || annotation?.title !== NOTICE_TITLE) return null;
  const m = NOTICE.exec(String(annotation.message ?? '').trim());
  return m ? { worker: m[1], version: m[2], commit: m[3] } : null;
}

async function gh(path, { token, repo, api = 'https://api.github.com', fetchJson }) {
  // `fetchJson` stands in for the API in the selftest.
  if (fetchJson) return fetchJson(path);
  const res = await fetch(`${api}/repos/${repo}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

// One check reads every site, so a run's promotions are read once per API.
const caches = new WeakMap();

/** Every promotion a run's successful promote jobs recorded, in every attempt: [{ worker, version, commit }]. */
async function promotionsOf(runId, auth) {
  const key = auth.fetchJson ?? gh;
  if (!caches.has(key)) caches.set(key, new Map());
  const promotionsCache = caches.get(key);
  if (promotionsCache.has(runId)) return promotionsCache.get(runId);
  const found = [];
  for (let page = 1; ; page++) {
    const jobs = (await gh(`actions/runs/${Number(runId)}/jobs?filter=all&per_page=100&page=${page}`, auth)).jobs ?? [];
    for (const job of jobs) {
      if (job.conclusion !== 'success' || !/ \/ promote$/.test(String(job.name))) continue;
      const notes = await gh(`check-runs/${Number(job.id)}/annotations?per_page=100`, auth);
      for (const note of Array.isArray(notes) ? notes : []) {
        const a = parseApproval(note);
        if (a) found.push(a);
      }
    }
    if (jobs.length < 100) break;
  }
  promotionsCache.set(runId, found);
  return found;
}

const trusted = (run) => run?.head_branch === 'main' && run?.path === PROMOTE_WORKFLOW;

/**
 * @param {{ isAncestor: (a: string, b: string) => boolean, commitTime: (c: string) => string }} git
 *   `isAncestor(a, b)`: a is an ancestor of b (or equal); `commitTime(c)`: c's ISO commit time.
 * @returns {Promise<{ read: 'ok', approved: true, runUrl: string } | { read: 'ok', approved: false, why: string } | { read: 'error', error: string }>}
 */
export async function verifyApproval({ worker, liveVersion, liveCommit, approvedBy }, auth, git) {
  try {
    const id = RUN_URL.exec(String(approvedBy ?? ''))?.[1];
    if (!id) return { read: 'ok', approved: false, why: 'its deployment names no approving run' };
    const run = await gh(`actions/runs/${id}`, auth);
    if (!trusted(run)) return { read: 'ok', approved: false, why: `its deployment names run ${id}, which is not a run of promote-site.yml on main` };
    const mine = (await promotionsOf(run.id, auth)).filter((p) => p.worker === worker);
    if (!mine.some((p) => p.version === liveVersion && p.commit === liveCommit)) {
      return { read: 'ok', approved: false, why: `run ${id}, which its deployment names, did not promote this version of ${liveCommit.slice(0, 12)}` };
    }
    // Every run that could have promoted a newer commit, read to the end.
    const since = new Date(Date.parse(git.commitTime(liveCommit)) - SKEW_MS).toISOString();
    for (let page = 1; ; page++) {
      const list = await gh(`actions/workflows/promote-site.yml/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`, auth);
      const runs = list.workflow_runs ?? [];
      for (const other of runs) {
        if (!trusted(other)) continue;
        const newer = (await promotionsOf(other.id, auth)).find(
          (p) => p.worker === worker && p.commit !== liveCommit && git.isAncestor(liveCommit, p.commit),
        );
        if (newer) {
          return { read: 'ok', approved: false, why: `a run (${other.html_url}) approved the newer commit ${newer.commit.slice(0, 12)} (version ${newer.version}), so this older one was put back without approval` };
        }
      }
      if (runs.length < 100) break;
      if (page === MAX_PAGES) return { read: 'error', error: 'more promote runs since the live commit than GitHub lists; not read to the end' };
    }
    return { read: 'ok', approved: true, runUrl: String(run.html_url) };
  } catch (err) {
    return { read: 'error', error: String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 120) };
  }
}
