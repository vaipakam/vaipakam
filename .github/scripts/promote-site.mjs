#!/usr/bin/env node
/**
 * Approve-to-go-live for the sites (#3236): the helper behind
 * .github/workflows/promote-site.yml.
 *
 * WHY. Every merge to `main` deploys the app, alpha05 and the marketing site
 * by itself. At mainnet the owner decided (2026-11-06, built 2026-11-07) that
 * a person approves each of those deploys: a bad merge, a stolen token or an
 * agent's mistake must not reach the page users sign through without a
 * person looking first.
 *
 * HOW. With the gate on, a site's Workers Build runs with
 * `VAIPAKAM_DEPLOY_MODE=upload` (packages/lib/bin/wrangler-deploy.mjs): the
 * new version is uploaded, stamped with its commit and previewable, and takes
 * no traffic. The workflow then:
 *   1. `plan`    — names the sites this commit rebuilds (the same path rules
 *                  as their Workers Build triggers);
 *   2. `find`    — waits for the stamped version, and says whether it is
 *                  already live (the gate is off), older than what is live
 *                  (never promoted: approving it would roll the site back),
 *                  or pending;
 *   3. the served-build check compares the pending version, through its
 *      preview URL, with a build of its commit, BEFORE anyone is asked;
 *   4. a person approves the job in the GitHub environment, and
 *   5. `deploy`  — re-checks all of it and makes that version take all
 *                  traffic, writing the approving run into the deployment's
 *                  message, which the served-build check reads back.
 *
 *   node .github/scripts/promote-site.mjs plan   --commit <sha> [--base <sha>]
 *   node .github/scripts/promote-site.mjs find   --site <worker> --commit <sha>
 *   node .github/scripts/promote-site.mjs deploy --site <worker> --commit <sha> --version <uuid>
 *   node .github/scripts/promote-site.mjs --selftest
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseApproval, promotedNotice, verifyApproval } from './lib/approvalRecord.mjs';
import { deployVersion, readLatestDeployment, readRecentVersions } from './lib/workerDeployments.mjs';

const CONFIG_PATH = '.github/served-build.json';
const FULL_SHA = /^[0-9a-f]{40}$/;
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

// ── pure parts (selftested) ──────────────────────────────────────────────

/** Whether a changed path rebuilds the site (the Workers Build trigger's own rules). */
export function rebuilds(site, path) {
  return path.startsWith(`${site.dir}/`) || path.startsWith('packages/') || path === 'pnpm-lock.yaml';
}

/** The newest version stamped from exactly `commit` (clean, never `-dirty`). */
export function versionFor(versions, commit) {
  return versions.find((v) => v.tag === commit.slice(0, 12) && v.message === `built from ${commit}`) ?? null;
}

/**
 * Where the candidate stands against what is live: 'live' (it already takes
 * all traffic), 'newer' (it descends from the live commit: promotable),
 * 'older' (the live commit descends from it: promoting would roll back),
 * 'unrelated' (neither), or 'unknown' (the live commit cannot be
 * established). Only 'newer' is ever promoted.
 */
export function standing({ candidateCommit, candidateVersion, liveVersion, liveCommit }, isAncestor) {
  if (liveVersion === candidateVersion) return 'live';
  // A live deployment whose commit cannot be established (split traffic, no
  // clean stamp, a stamp that is no commit here) cannot be ordered against
  // the candidate, so promoting could roll the site back: refuse. Restore a
  // stamped version by hand first (the runbook, section 9).
  if (!liveCommit) return 'unknown';
  if (liveCommit === candidateCommit) return 'newer';
  if (isAncestor(liveCommit, candidateCommit)) return 'newer';
  if (isAncestor(candidateCommit, liveCommit)) return 'older';
  return 'unrelated';
}

// ── side effects ─────────────────────────────────────────────────────────

const isAncestor = (a, b) => {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
};

function output(values) {
  for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([k, v]) => {
    const value = String(v).replace(/[\r\n]+/g, ' ');
    const d = `EOF_${randomUUID()}`;
    return `${k}<<${d}\n${value}\n${d}\n`;
  });
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function siteOf(config, worker) {
  const site = config.sites.find((s) => s.worker === worker);
  if (!site) throw new Error(`no site ${worker} in ${CONFIG_PATH}`);
  return site;
}

function fullCommit(raw) {
  const commit = git(['rev-parse', '--verify', '--quiet', `${raw}^{commit}`]).trim();
  if (!FULL_SHA.test(commit)) throw new Error(`${raw} is not a commit here`);
  // Only merged code is ever promoted, whatever ref the run started from.
  if (!isAncestor(commit, 'origin/main')) throw new Error(`${commit} is not on main`);
  return commit;
}

async function liveFacts(site, auth) {
  const live = await readLatestDeployment(site.worker, auth);
  if (live.read !== 'ok') throw new Error(`${site.worker}: its live deployment cannot be read (${live.read === 'none' ? 'none' : live.error})`);
  const only = live.versions.length === 1 ? live.versions[0] : null;
  const short = only?.stamp && !only.stamp[2] ? only.stamp[1] : null;
  let liveCommit = null;
  if (short) {
    try {
      liveCommit = git(['rev-parse', '--verify', '--quiet', `${short}^{commit}`]).trim();
    } catch {
      liveCommit = null;
    }
  }
  return { liveVersion: only?.id ?? null, liveCommit };
}

async function find(config, auth) {
  const site = siteOf(config, arg('--site'));
  const commit = fullCommit(arg('--commit'));
  const waitMinutes = Number(process.env.PROMOTE_WAIT_MINUTES ?? 30);
  const deadline = Date.now() + waitMinutes * 60_000;
  let version = null;
  for (;;) {
    const recent = await readRecentVersions(site.worker, auth, 30);
    if (recent.read !== 'ok') throw new Error(`${site.worker}: versions cannot be read (${recent.error})`);
    version = versionFor(recent.versions, commit);
    if (version || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (!version) {
    summary(`${site.worker}: no version stamped ${commit.slice(0, 12)} appeared within ${waitMinutes} min. Its Workers Build did not run or failed; nothing to approve.`);
    output({ state: 'missing', version: '', short: commit.slice(0, 12) });
    process.exitCode = 1;
    return;
  }
  const facts = await liveFacts(site, auth);
  const state = standing({ candidateCommit: commit, candidateVersion: version.id, ...facts }, isAncestor);
  const words = {
    live: 'is already live, so it deployed without approval: the gate is off on its Workers Build (VAIPAKAM_DEPLOY_MODE is not "upload").',
    newer: `is uploaded and waiting for approval (live now: ${facts.liveCommit?.slice(0, 12) ?? 'an unplaced version'}).`,
    older: `is OLDER than what is live (${facts.liveCommit?.slice(0, 12)}); promoting it would roll the site back, so it is not offered.`,
    unrelated: `does not descend from the live commit ${facts.liveCommit?.slice(0, 12)}; it is not offered.`,
    unknown: 'cannot be ordered against the live deployment, whose commit cannot be established (split traffic, no clean stamp, or a stamp that is no commit on main); it is not offered. Put a stamped version back by hand first (runbook, section 9).',
  };
  summary(`${site.worker}: version ${version.id} built from ${commit.slice(0, 12)} ${words[state]}`);
  output({ state: state === 'newer' ? 'pending' : state, version: version.id, short: commit.slice(0, 12) });
}

async function deploy(config, readAuth, writeAuth) {
  const site = siteOf(config, arg('--site'));
  const commit = fullCommit(arg('--commit'));
  const versionId = arg('--version');
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  // Everything is read again after the approval: what was approved must
  // still be the version stamped from this commit, and still newer than live.
  const recent = await readRecentVersions(site.worker, readAuth, 50);
  if (recent.read !== 'ok') throw new Error(`${site.worker}: versions cannot be read (${recent.error})`);
  const version = versionFor(recent.versions, commit);
  if (!version || version.id !== versionId) throw new Error(`${site.worker}: ${versionId} is no longer the version stamped from ${commit}`);
  const facts = await liveFacts(site, readAuth);
  const state = standing({ candidateCommit: commit, candidateVersion: versionId, ...facts }, isAncestor);
  if (state === 'live') {
    summary(`${site.worker}: ${versionId} is already live; nothing to do.`);
    return;
  }
  if (state !== 'newer') throw new Error(`${site.worker}: ${versionId} is ${state} than the live deployment now; refusing to promote it.`);
  await deployVersion(site.worker, versionId, runUrl, writeAuth);
  const after = await readLatestDeployment(site.worker, readAuth);
  if (after.read !== 'ok' || after.versions.length !== 1 || after.versions[0].id !== versionId || after.approvedBy !== runUrl) {
    throw new Error(`${site.worker}: the deployment was sent but reading it back does not show ${versionId} live under this run`);
  }
  // GitHub's record of the approval, which the served-build check reads
  // (lib/approvalRecord.mjs): written only here, after the read-back.
  console.log(promotedNotice(site.worker, versionId, commit));
  summary(`${site.worker}: version ${versionId} (${commit.slice(0, 12)}) is live, approved in ${runUrl}.`);
}

function plan(config) {
  const commit = fullCommit(arg('--commit'));
  // The push's own range when the workflow gives it (a push may carry more
  // than one commit), else the commit's parent.
  const rawBase = arg('--base');
  const base = rawBase && FULL_SHA.test(rawBase) && !/^0+$/.test(rawBase) ? rawBase : git(['rev-parse', `${commit}^`]).trim();
  const changed = git(['diff', '--name-only', base, commit]).split('\n').filter(Boolean);
  const sites = config.sites.filter((s) => changed.some((p) => rebuilds(s, p))).map((s) => s.worker);
  summary(`Commit ${commit.slice(0, 12)} rebuilds: ${sites.length ? sites.join(', ') : 'no site'}.`);
  const has = (w) => (sites.includes(w) ? 'true' : 'false');
  output({ app: has('vaipakam-app'), alpha05: has('vaipakam-alpha05'), www: has('vaipakam-www') });
}

// ── selftest ─────────────────────────────────────────────────────────────

async function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`selftest: ${msg}`);
  };
  const app = { worker: 'vaipakam-app', dir: 'apps/app' };
  ok(rebuilds(app, 'apps/app/src/x.ts') && rebuilds(app, 'packages/lib/src/a.mjs') && rebuilds(app, 'pnpm-lock.yaml'), 'app paths');
  ok(!rebuilds(app, 'apps/application/x') && !rebuilds(app, 'apps/www/x') && !rebuilds(app, 'docs/x.md'), 'other paths');

  const c = 'a'.repeat(40);
  const vs = [
    { id: 'v3', tag: `${c.slice(0, 12)}-dirty`, message: '' },
    { id: 'v2', tag: c.slice(0, 12), message: `built from ${c}` },
    { id: 'v1', tag: c.slice(0, 12), message: `built from ${c}` },
  ];
  ok(versionFor(vs, c)?.id === 'v2', 'the newest clean version of the commit');
  ok(versionFor(vs, 'b'.repeat(40)) === null, 'no version for another commit');

  const anc = (a, b) => a === 'old' && b === 'new';
  ok(standing({ candidateCommit: 'new', candidateVersion: 'v', liveVersion: 'v', liveCommit: 'new' }, anc) === 'live', 'live');
  ok(standing({ candidateCommit: 'new', candidateVersion: 'v2', liveVersion: 'v1', liveCommit: 'old' }, anc) === 'newer', 'newer');
  ok(standing({ candidateCommit: 'old', candidateVersion: 'v1', liveVersion: 'v2', liveCommit: 'new' }, anc) === 'older', 'older');
  ok(standing({ candidateCommit: 'x', candidateVersion: 'v1', liveVersion: 'v2', liveCommit: 'y' }, anc) === 'unrelated', 'unrelated');
  ok(standing({ candidateCommit: 'x', candidateVersion: 'v1', liveVersion: null, liveCommit: null }, anc) === 'unknown', 'an unplaced live deployment is never promoted over');
  ok(standing({ candidateCommit: 'x', candidateVersion: 'v1', liveVersion: 'v2', liveCommit: null }, anc) === 'unknown', 'an unknown live commit is never promoted over');

  const id = '0123abcd-0000-4000-8000-00000000beef';
  const note = (message, extra = {}) => ({ annotation_level: 'notice', title: 'promoted', message, ...extra });
  const cc = 'c'.repeat(40);
  ok(promotedNotice('vaipakam-app', id, cc) === `::notice title=promoted::promoted vaipakam-app ${id} ${cc}`, 'notice command');
  ok(parseApproval(note(`promoted vaipakam-app ${id} ${cc}`))?.commit === cc, 'approval read back');
  ok(parseApproval(note(`promoted vaipakam-app ${id}`)) === null, 'a commit is required');
  ok(parseApproval(note(`promoted vaipakam-app ${id} ${cc}`, { annotation_level: 'warning' })) === null, 'only a notice');
  ok(parseApproval(note(`promoted vaipakam-app ${id} ${cc}`, { title: 'other' })) === null, 'only the promoted title');
  ok(parseApproval(note(`promoted vaipakam-app ${id} ${cc} and more`)) === null, 'exact shape only');
  ok(parseApproval(note(`promoted vaipakam-app not-a-uuid ${cc}`)) === null, 'a version id only');
  // verifyApproval against a fake GitHub: runs 1 (approves L), 2 (approves
  // the newer N), 3 (a branch run claiming N), each promote job's notices.
  const L = '1'.repeat(40);
  const N = '2'.repeat(40);
  const vL = '0123abcd-0000-4000-8000-000000000001';
  const vN = '0123abcd-0000-4000-8000-000000000002';
  const url = (n) => `https://github.com/vaipakam/vaipakam/actions/runs/${n}`;
  const mkRun = (n, branch = 'main') => ({ id: n, head_branch: branch, path: '.github/workflows/promote-site.yml', html_url: url(n), created_at: '2026-11-07T00:00:00Z' });
  const fake = (runs, notesByRun) => async (path) => {
    let m;
    if ((m = /^actions\/runs\/(\d+)$/.exec(path))) return runs.find((r) => r.id === Number(m[1])) ?? Promise.reject(new Error('GitHub HTTP 404'));
    if ((m = /^actions\/runs\/(\d+)\/jobs/.exec(path))) return { jobs: notesByRun[m[1]] ? [{ id: Number(m[1]) * 10, name: 'app / promote', conclusion: 'success' }] : [] };
    if ((m = /^check-runs\/(\d+)\/annotations/.exec(path))) return (notesByRun[Number(m[1]) / 10] ?? []).map((msg) => note(msg));
    if (path.startsWith('actions/workflows/promote-site.yml/runs')) return { workflow_runs: runs };
    throw new Error(`unexpected ${path}`);
  };
  const gitFake = { isAncestor: (a, b) => a === b || (a === L && b === N), commitTime: () => '2026-11-06T00:00:00Z' };
  const verify = async (runs, notes, live) => verifyApproval(live, { fetchJson: fake(runs, notes) }, gitFake);
  const liveL = { worker: 'vaipakam-app', liveVersion: vL, liveCommit: L, approvedBy: url(1) };
  const okL = await verify([mkRun(1)], { 1: [`promoted vaipakam-app ${vL} ${L}`] }, liveL);
  ok(okL.read === 'ok' && okL.approved, 'an approved live version passes');
  const replay = await verify([mkRun(2), mkRun(1)], { 1: [`promoted vaipakam-app ${vL} ${L}`], 2: [`promoted vaipakam-app ${vN} ${N}`] }, liveL);
  ok(replay.read === 'ok' && !replay.approved, 'an older approval put back after a newer one fails');
  // Created in either order, the newer COMMIT decides.
  const okN = await verify([mkRun(1), mkRun(2)], { 1: [`promoted vaipakam-app ${vL} ${L}`], 2: [`promoted vaipakam-app ${vN} ${N}`] }, { ...liveL, liveVersion: vN, liveCommit: N, approvedBy: url(2) });
  ok(okN.read === 'ok' && okN.approved, 'the newest approved commit passes, whatever order its run was created in');
  const branch = await verify([mkRun(3, 'feature'), mkRun(1)], { 1: [`promoted vaipakam-app ${vL} ${L}`], 3: [`promoted vaipakam-app ${vN} ${N}`] }, liveL);
  ok(branch.read === 'ok' && branch.approved, 'a run on another branch is not a newer approval');
  const forged = await verify([mkRun(3, 'feature')], { 3: [`promoted vaipakam-app ${vL} ${L}`] }, { ...liveL, approvedBy: url(3) });
  ok(forged.read === 'ok' && !forged.approved, 'a pointer to a run on another branch fails');
  const wrongVersion = await verify([mkRun(1)], { 1: [`promoted vaipakam-app ${vN} ${L}`] }, liveL);
  ok(wrongVersion.read === 'ok' && !wrongVersion.approved, 'the named run must have promoted this exact version');
  const none = await verify([mkRun(1)], {}, { ...liveL, approvedBy: '' });
  ok(none.read === 'ok' && !none.approved, 'no pointer fails');
  console.log('promote-site selftest: OK');
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cmd = process.argv[2];
  if (cmd === 'plan') return plan(config);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const readToken = process.env.CLOUDFLARE_DEPLOY_READ_TOKEN;
  if (!account || !readToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_DEPLOY_READ_TOKEN are required');
  const readAuth = { account, token: readToken };
  if (cmd === 'find') return find(config, readAuth);
  if (cmd === 'deploy') {
    const writeToken = process.env.CLOUDFLARE_PROMOTE_TOKEN;
    if (!writeToken) throw new Error('CLOUDFLARE_PROMOTE_TOKEN is required to deploy (the approval environment holds it)');
    return deploy(config, readAuth, { account, token: writeToken });
  }
  throw new Error('usage: promote-site.mjs plan|find|deploy …');
}

main().catch((err) => {
  console.error(String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 500));
  process.exit(2);
});
