/**
 * The record of which version a person approved for each site (#3236).
 *
 * The approval cannot be read from Cloudflare: anyone holding a Workers
 * Scripts Edit token writes the deployment, its message included, so a
 * message naming an approving run proves nothing. The record lives on
 * GitHub instead, where the Cloudflare credential cannot write. The promote
 * job of .github/workflows/promote-one.yml, which runs only after a person
 * approves the `site-production` environment, ends by writing a notice
 * annotation `promoted <worker> <version id>` on its own job, and only after
 * reading the deployment back.
 *
 * `latestApproval` walks the newest completed runs of promote-site.yml on
 * `main` (a run from any other branch carries that branch's copy of the
 * workflow, so it is never trusted) and returns the newest such annotation
 * for the worker. The live version must be that one: a version nobody
 * approved, and an older approved version put back by hand (a replayed
 * approval), both fail.
 *
 * It needs a GitHub token with actions: read and checks: read.
 */

export const PROMOTE_WORKFLOW = '.github/workflows/promote-site.yml';
const NOTICE_TITLE = 'promoted';
const NOTICE = /^promoted (vaipakam-[a-z0-9-]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

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

/**
 * @returns {Promise<{ read: 'ok', approval: { version: string, runUrl: string } | null } | { read: 'error', error: string }>}
 *   `approval` is null when no run in the window approved this worker.
 */
export async function latestApproval(worker, auth, runsToScan = 30) {
  try {
    const runs = await gh(`actions/workflows/promote-site.yml/runs?branch=main&status=completed&per_page=${Number(runsToScan)}`, auth);
    for (const run of runs.workflow_runs ?? []) {
      if (run.head_branch !== 'main' || run.path !== PROMOTE_WORKFLOW) continue;
      const jobs = await gh(`actions/runs/${Number(run.id)}/jobs?per_page=100`, auth);
      for (const job of jobs.jobs ?? []) {
        if (job.conclusion !== 'success' || !/ \/ promote$/.test(String(job.name))) continue;
        const notes = await gh(`check-runs/${Number(job.id)}/annotations?per_page=100`, auth);
        for (const note of Array.isArray(notes) ? notes : []) {
          const a = parseApproval(note);
          if (a && a.worker === worker) return { read: 'ok', approval: { version: a.version, runUrl: String(run.html_url) } };
        }
      }
    }
    return { read: 'ok', approval: null };
  } catch (err) {
    return { read: 'error', error: String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 120) };
  }
}
