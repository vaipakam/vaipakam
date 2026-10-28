#!/usr/bin/env node
/**
 * Is every Worker running what `main` says it should? (#2242)
 *
 * WHY THIS EXISTS. Merged code that never reaches its Worker is silent. The
 * connected app served a build from before #2190 for days while #2190 sat on
 * `main`; the definition of done's live review never happened because the
 * deploy never happened, and nothing said so. This check compares each
 * Worker's live deployment with `main` and fails, naming the Worker and the
 * merged changes it is missing, once a change has waited longer than the
 * grace period.
 *
 * WHICH WORKERS. Every tracked wrangler config (`wrangler.json` /
 * `wrangler.jsonc`) that names a Worker, so a new Worker is watched with no
 * edit here. A Pages project (`pages_build_output_dir`) is not a Worker
 * deploy and is skipped; a TOML config is refused, because this check does
 * not parse TOML and will not guess.
 *
 * WHAT COUNTS AS THE WORKER'S CODE (its "inputs"). Its own directory, plus
 * every workspace package its build reaches:
 *   - a workspace member reaches the packages in its package.json
 *     `dependencies` (runtime, never `devDependencies`) that use the
 *     `workspace:` protocol, and theirs, transitively;
 *   - a Worker outside the workspace (ops/*) reaches the packages its own
 *     tracked sources name by a relative path into `packages/`, and theirs.
 * A change only to tests, end-to-end drivers, Markdown, or a dependency
 * package's `scripts/` is not a bundle change and is not counted. The root
 * lockfile is not counted either: a dependency bump also edits the package's
 * own package.json, which is. What this cannot see: a change outside those
 * inputs that still alters a bundle — a build reading a file by a path no
 * package declares. Such a change goes unreported, never falsely reported.
 *
 * WHAT A DEPLOYMENT WAS BUILT FROM. Every deploy this repository runs records
 * its commit on the version's tag (packages/lib/src/deployStamp.mjs). With a
 * tag the check is exact. Without one — a deploy from before the stamp, or one
 * run by hand outside the package scripts — it takes the last commit on `main`
 * at the deploy's time, and every line it writes about that Worker says the
 * commit was inferred. A tag marked `-dirty` means the build also contained
 * uncommitted changes; the Worker is judged against the commit and the report
 * says what else it may hold.
 *
 * WHAT FAILS (exit 1), each named:
 *   - `behind:<worker>`     — a merged change to its inputs is not in the live
 *                             deployment, and has been on `main` longer than
 *                             DEPLOY_LAG_GRACE_SECONDS;
 *   - `unreadable:<worker>` — Cloudflare's deployment list could not be read;
 *   - `undeployed:<worker>` — the Worker has no deployment at all;
 *   - `unplaced:<worker>`   — its deployment cannot be matched to any commit.
 * A Worker listed in DEPLOY_LAG_HELD (`worker=reason;…`, in a reviewed commit)
 * is still judged and reported, with its reason, but does not fail: a hold is
 * a decision someone made, and it is stated rather than hidden.
 *
 * The keys carry no counts or ages, so the alert issue (the workflow's
 * `alert` job) is notified once per changed condition, not once per merge.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_DEPLOY_READ_TOKEN=… \
 *   DEPLOY_LAG_GRACE_SECONDS=21600 DEPLOY_LAG_HELD= DEPLOY_LAG_REF=HEAD \
 *     node .github/scripts/check-deploy-lag.mjs
 *   node .github/scripts/check-deploy-lag.mjs --selftest
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { parseJsonc } from '../../apps/keeper/scripts/lib/jsonc.mjs';
// The tag form the deploy stamp writes, from its one definition.
import { DEPLOY_TAG as STAMP_TAG } from '../../packages/lib/src/deployStamp.mjs';

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * True for a changed file that is not part of any bundle. `ownDir` is the
 * Worker's directory: a `scripts/` folder there can feed its build (the app's
 * Vite config imports one), so only a DEPENDENCY package's `scripts/` is
 * excluded.
 */
export function isNonBundle(file, ownDir) {
  const segments = file.split('/');
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.md')) return true;
  if (segments.some((s) => s === 'test' || s === 'tests' || s === '__tests__' || s === 'e2e')) return true;
  return !(file === ownDir || file.startsWith(`${ownDir}/`)) && (segments.includes('scripts') || segments.includes('bin'));
}

/** The `packages/<dir>` directories a set of relative specifiers in `file` reach. */
export function packagesReachedBy(file, source) {
  const out = new Set();
  for (const m of source.matchAll(/['"`]((?:\.\.?\/)+[^'"`\s]*)['"`]/g)) {
    const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
    const hit = /^packages\/([^/]+)(?:\/|$)/.exec(target);
    if (hit) out.add(`packages/${hit[1]}`);
  }
  return out;
}

/** `worker=reason;worker=reason` → Map. Strict: a malformed entry is refused. */
export function parseHeld(raw) {
  const held = new Map();
  for (const part of (raw ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const name = eq > 0 ? part.slice(0, eq).trim() : '';
    const reason = eq > 0 ? part.slice(eq + 1).trim() : '';
    if (!/^[a-z0-9-]+$/.test(name) || !reason) throw new Error(`DEPLOY_LAG_HELD: "${part}" is not worker=reason`);
    held.set(name, reason);
  }
  return held;
}

function age(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * The verdict on the gathered facts. Pure, so the selftest pins it.
 *
 * @param {Array<object>} workers facts per Worker (see gather()).
 * @param {{ now: number, graceSeconds: number, held: Map<string, string> }} opts
 * @returns {{ problems: { key: string, text: string }[], report: string[] }}
 *   `report` is one line per Worker, healthy ones included, for the summary.
 */
export function judgeDeployLag(workers, { now, graceSeconds, held }) {
  const problems = [];
  const report = [];
  for (const w of workers) {
    const hold = held.get(w.name);
    const fail = (key, text) => {
      if (hold) {
        report.push(`${w.name}: HELD (${hold}) — ${text}`);
      } else {
        problems.push({ key: `${key}:${w.name}`, text: `${w.name}: ${text}` });
        report.push(`${w.name}: ${text}`);
      }
    };
    if (w.read === 'error') {
      fail('unreadable', `its deployments could not be read (${w.error}); whether it is current is UNKNOWN`);
      continue;
    }
    if (w.read === 'none') {
      fail('undeployed', 'Cloudflare reports no deployment of this Worker');
      continue;
    }
    // Every version that takes traffic is judged on its own; the Worker is
    // behind when ANY of them lacks an overdue change. Which version is
    // "furthest behind" is not a count — two versions can each lack changes
    // the other has — so the one lacking the OLDEST overdue change is the
    // one described.
    const split = w.versions.length > 1 ? ` (split deployment, ${w.versions.length} versions)` : '';
    const unplaced = w.versions.find((v) => !v.pending);
    if (unplaced) {
      fail('unplaced', `deployed ${w.deployedAt}, but version ${unplaced.id} cannot be placed on main: no commit on main precedes that time${split}`);
      continue;
    }
    const judged = w.versions.map((v) => ({ v, overdue: v.pending.filter((c) => now - c.time > graceSeconds) }));
    const behind = judged.filter((j) => j.overdue.length > 0);
    if (behind.length === 0) {
      const waiting = Math.max(...w.versions.map((v) => v.pending.length));
      const note = waiting ? `; ${waiting} newer change(s) still inside the grace period` : '';
      report.push(`${w.name}: current — deployed ${w.deployedAt} ${w.versions.map(describeBasis).join(' and ')}${note}${split}${hold ? ` (held: ${hold})` : ''}`);
      continue;
    }
    const oldestOf = (j) => j.overdue[j.overdue.length - 1];
    const worst = behind.reduce((a, b) => (oldestOf(b).time < oldestOf(a).time ? b : a));
    const oldest = oldestOf(worst);
    const which = split ? `; ${behind.length} of ${w.versions.length} versions behind, described: ${worst.v.id}` : '';
    fail(
      'behind',
      `${worst.overdue.length} merged change(s) not deployed, the oldest ${oldest.sha.slice(0, 9)} (${oldest.subject.slice(0, 80)}) merged ${age(now - oldest.time)} ago; live deployment ${w.deployedAt} ${describeBasis(worst.v)}${split}${which}`,
    );
  }
  return { problems, report };
}

function describeBasis(v) {
  if (v.basis === 'tag') return `from ${v.commit.slice(0, 9)}${v.dirty ? ' plus uncommitted changes' : ''}`;
  if (v.basis === 'tag-unknown') {
    return `from ${v.tag}, a commit this checkout of main does not have — so placed by deploy time at ${v.commit?.slice(0, 9) ?? 'nothing'} (INFERRED)`;
  }
  return `with no recorded commit — placed by deploy time at ${v.commit?.slice(0, 9) ?? 'nothing'} (INFERRED)`;
}

// ── facts ────────────────────────────────────────────────────────────────

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function tracked() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

/** The workspace's member directories, from pnpm-workspace.yaml's `dir/*` patterns. */
function workspaceMembers(files) {
  const lines = readFileSync('pnpm-workspace.yaml', 'utf8').split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start < 0) throw new Error('pnpm-workspace.yaml has no packages: list');
  const members = new Map();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/.exec(line);
    if (!m) continue;
    const glob = /^([a-z0-9_-]+)\/\*$/.exec(m[1]);
    if (!glob) throw new Error(`pnpm-workspace.yaml: pattern ${m[1]} is not dir/* — teach this check before using it`);
    for (const f of files) {
      const hit = new RegExp(`^${glob[1]}/([^/]+)/package\\.json$`).exec(f);
      if (hit) {
        const dir = `${glob[1]}/${hit[1]}`;
        members.set(JSON.parse(readFileSync(f, 'utf8')).name, dir);
      }
    }
  }
  return members;
}

/** Every Worker the tree configures: { name, dir, inputs }. */
function discoverWorkers(files) {
  const members = workspaceMembers(files);
  const dirOfMember = new Map([...members].map(([n, d]) => [d, n]));
  const closure = (startDirs) => {
    const seen = new Set();
    const queue = [...startDirs];
    while (queue.length) {
      const dir = queue.shift();
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!dirOfMember.has(dir)) continue;
      const deps = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).dependencies ?? {};
      for (const [name, spec] of Object.entries(deps)) {
        if (!String(spec).startsWith('workspace:')) continue;
        const depDir = members.get(name);
        if (!depDir) throw new Error(`${dir}/package.json: workspace dependency ${name} is not a workspace member`);
        queue.push(depDir);
      }
    }
    return seen;
  };
  const workers = [];
  for (const f of files) {
    const base = posix.basename(f);
    if (/^wrangler[^/]*\.toml$/.test(base)) throw new Error(`${f}: a TOML wrangler config — this check reads JSON(C) only`);
    if (base !== 'wrangler.json' && base !== 'wrangler.jsonc') continue;
    const config = parseJsonc(readFileSync(f, 'utf8'));
    if (config.pages_build_output_dir !== undefined) continue;
    if (typeof config.name !== 'string' || !config.name) throw new Error(`${f}: no Worker name`);
    const dir = posix.dirname(f);
    let reached = [dir];
    if (!dirOfMember.has(dir)) {
      const pkgs = new Set();
      for (const src of files.filter((s) => s.startsWith(`${dir}/`) && SOURCE_EXT.test(s))) {
        for (const p of packagesReachedBy(src, readFileSync(src, 'utf8'))) pkgs.add(p);
      }
      reached = [dir, ...pkgs];
    }
    workers.push({ name: config.name, dir, inputs: [...closure(reached)].sort() });
  }
  return workers.sort((a, b) => a.name.localeCompare(b.name));
}

function commitExists(rev) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/**
 * The changes to the Worker's code that reached main after `base`, newest
 * first, one per INTEGRATION — a commit on main's first-parent line — timed
 * by when it landed on main. A merged branch's own commits keep their
 * authoring times, so timing by them would start the grace period before
 * the change reached main; the integration commit's committer time is when
 * it did (a merge, squash or rebase onto main all stamp it then). A merge is
 * read as what it brought in: its difference from its first parent.
 */
function pendingSince(base, ref, worker, cwd) {
  const out = git(['log', '--first-parent', '--diff-merges=first-parent', '--format=%x1e%H%x1f%ct%x1f%s', '--name-only', `${base}..${ref}`], cwd);
  const pending = [];
  for (const block of out.split('\x1e').slice(1)) {
    const [head, ...rest] = block.split('\n');
    const [sha, ct, subject] = head.split('\x1f');
    const changed = rest.filter(Boolean).filter((f) => worker.inputs.some((i) => f === i || f.startsWith(`${i}/`)));
    if (changed.some((f) => !isNonBundle(f, worker.dir))) pending.push({ sha, time: Number(ct), subject });
  }
  return pending;
}

async function cloudflare(path, { account, token }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return { status: 404 };
  // The status only: the body is the network's text, and it travels into the
  // workflow's outputs, the issue and the chat message.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.success) throw new Error('the API answered success=false');
  return { status: 200, result: body.result };
}

async function gather(worker, { ref, auth }) {
  let deployments;
  try {
    const r = await cloudflare(`${encodeURIComponent(worker.name)}/deployments`, auth);
    if (r.status === 404) return { ...worker, read: 'none' };
    deployments = Array.isArray(r.result?.deployments) ? r.result.deployments : null;
    if (!deployments) throw new Error('no deployments list in the answer');
  } catch (err) {
    return { ...worker, read: 'error', error: String(err.message).replace(/[\r\n]+/g, ' ').slice(0, 120) };
  }
  if (deployments.length === 0) return { ...worker, read: 'none' };
  const latest = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  const placedByTime = () => {
    const sha = git(['rev-list', '-1', '--first-parent', `--before=${latest.created_on}`, ref]).trim();
    return sha || null;
  };
  const versions = [];
  for (const v of latest.versions ?? []) {
    let tag = '';
    try {
      const r = await cloudflare(`${encodeURIComponent(worker.name)}/versions/${encodeURIComponent(v.version_id)}`, auth);
      // A version the deployment names but the API cannot find is a failed
      // read, never an unstamped version: only a version actually read may
      // be placed by its deploy time.
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      tag = String(r.result?.annotations?.['workers/tag'] ?? '');
    } catch (err) {
      return { ...worker, read: 'error', error: `version ${v.version_id}: ${String(err.message).slice(0, 80)}` };
    }
    const stamp = STAMP_TAG.exec(tag);
    let basis = 'time';
    let commit = null;
    if (stamp) {
      commit = commitExists(stamp[1]);
      basis = commit ? 'tag' : 'tag-unknown';
    }
    if (!commit) commit = placedByTime();
    versions.push({
      id: v.version_id,
      percentage: v.percentage,
      tag,
      basis,
      commit,
      dirty: Boolean(stamp?.[2]),
      pending: commit ? pendingSince(commit, ref, worker) : null,
    });
  }
  if (versions.length === 0) return { ...worker, read: 'error', error: 'the latest deployment lists no versions' };
  return { ...worker, read: 'ok', deployedAt: latest.created_on, versions };
}

// ── selftest ─────────────────────────────────────────────────────────────

function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`selftest: ${msg}`);
  };
  const now = 1_000_000;
  const H = 3600;
  const opts = { now, graceSeconds: 6 * H, held: new Map() };
  const v = (pending, extra = {}) => ({ id: 'v', percentage: 100, tag: 'abcdefabcdef', basis: 'tag', commit: 'abcdefabcdef'.padEnd(40, '0'), dirty: false, pending, ...extra });
  const w = (name, versions, extra = {}) => ({ name, dir: `apps/${name}`, inputs: [], read: 'ok', deployedAt: '2026-10-27T00:00:00Z', versions, ...extra });
  const c = (h, sha = 'f'.repeat(40)) => ({ sha, time: now - h * H, subject: 'a change' });

  let r = judgeDeployLag([w('a', [v([])])], opts);
  ok(r.problems.length === 0 && /current/.test(r.report[0]), 'a Worker with nothing pending is current');
  r = judgeDeployLag([w('a', [v([c(1)])])], opts);
  ok(r.problems.length === 0 && /inside the grace period/.test(r.report[0]), 'a change inside the grace period does not fail, and is reported');
  r = judgeDeployLag([w('a', [v([c(1), c(30, '1'.repeat(40))])])], opts);
  ok(r.problems.length === 1 && r.problems[0].key === 'behind:a', 'an overdue change fails as behind');
  ok(/1 merged change/.test(r.problems[0].text) && /111111111/.test(r.problems[0].text), 'the overdue count and oldest commit are named');
  r = judgeDeployLag([w('a', [v([c(30)], { basis: 'time' })])], opts);
  ok(/INFERRED/.test(r.problems[0].text), 'a time-placed deployment says the commit was inferred');
  r = judgeDeployLag([w('a', [v([c(30)], { dirty: true })])], opts);
  ok(/plus uncommitted changes/.test(r.problems[0].text), 'a dirty build is reported as such');
  r = judgeDeployLag([w('a', [v([c(30)])])], { ...opts, held: new Map([['a', 'held for the fresh deploy']]) });
  ok(r.problems.length === 0 && /HELD \(held for the fresh deploy\)/.test(r.report[0]), 'a held Worker is reported with its reason and does not fail');
  r = judgeDeployLag([w('a', [], { read: 'error', error: 'HTTP 403' })], opts);
  ok(r.problems[0].key === 'unreadable:a' && /UNKNOWN/.test(r.problems[0].text), 'an unreadable Worker fails as unknown, never as current');
  r = judgeDeployLag([w('a', [], { read: 'none' })], opts);
  ok(r.problems[0].key === 'undeployed:a', 'a Worker with no deployment fails');
  r = judgeDeployLag([w('a', [v(null)])], opts);
  ok(r.problems[0].key === 'unplaced:a', 'a deployment no commit precedes fails as unplaced');
  r = judgeDeployLag([w('a', [v([]), v([c(30)], { id: 'w' })])], opts);
  ok(r.problems.length === 1 && /split deployment/.test(r.problems[0].text) && /1 of 2 versions behind/.test(r.problems[0].text), 'a split deployment with one version behind is behind');
  // Divergent versions: one lacks two NEW changes (inside grace), the other
  // lacks one OLD change. A count would pick the first and pass.
  r = judgeDeployLag([w('a', [v([c(1), c(2)], { id: 'x' }), v([c(30, '2'.repeat(40))], { id: 'y' })])], opts);
  ok(r.problems.length === 1 && /described: y/.test(r.problems[0].text) && /222222222/.test(r.problems[0].text), 'every version is judged, not the one missing the most changes');
  r = judgeDeployLag([w('a', [v([]), v(null, { id: 'z' })])], opts);
  ok(r.problems[0]?.key === 'unplaced:a' && /version z/.test(r.problems[0].text), 'one unplaced version makes the Worker unplaced');
  const k1 = judgeDeployLag([w('a', [v([c(30)])])], opts).problems[0].key;
  const k2 = judgeDeployLag([w('a', [v([c(30), c(40), c(50)])])], opts).problems[0].key;
  ok(k1 === k2, 'the key carries no count, so more merges do not re-notify');

  ok(isNonBundle('apps/app/e2e/tests/x.spec.ts', 'apps/app'), 'an e2e spec is not bundle code');
  ok(isNonBundle('packages/lib/src/x.test.ts', 'apps/app'), 'a unit test is not bundle code');
  ok(isNonBundle('packages/contracts/scripts/build-diamond-abi.mjs', 'apps/indexer'), "a dependency's scripts/ is not bundle code");
  ok(!isNonBundle('apps/app/scripts/viteEnv.mjs', 'apps/app'), "the Worker's own scripts/ can feed its build");
  ok(!isNonBundle('packages/contracts/src/abis/RiskFacet.json', 'apps/indexer'), 'an ABI is bundle code');
  ok(isNonBundle('apps/www/README.md', 'apps/www'), 'Markdown is not bundle code');

  const reached = packagesReachedBy('ops/w/src/a.ts', "import x from '../../../packages/lib/src/d1Binds';\nimport y from './local';\nconst z = '../../../packages/contracts/src/deployments.json';");
  ok(reached.size === 2 && reached.has('packages/lib') && reached.has('packages/contracts'), 'relative paths into packages/ are found, local ones ignored');
  ok(packagesReachedBy('ops/w/src/a.ts', "'../../packagesX/y'").size === 0, 'a sibling named like packages is not a package');

  ok(parseHeld('').size === 0, 'an empty hold list is none');
  ok(parseHeld('vaipakam-app=frozen until the fresh deploy; vaipakam-www=x').get('vaipakam-app') === 'frozen until the fresh deploy', 'holds parse');
  let threw = false;
  try {
    parseHeld('vaipakam-app');
  } catch {
    threw = true;
  }
  ok(threw, 'a hold with no reason is refused');
  selftestIntegrationTime(ok);
  console.log('check-deploy-lag selftest: OK');
}

/**
 * A branch authored days ago and merged a minute ago is timed by the merge:
 * a throwaway repository, a merge without squashing, and pendingSince.
 */
function selftestIntegrationTime(ok) {
  const repo = mkdtempSync(join(tmpdir(), 'deploy-lag-selftest-'));
  try {
    const at = (when) => ({
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.test',
      GIT_AUTHOR_DATE: `@${when} +0000`,
      GIT_COMMITTER_DATE: `@${when} +0000`,
    });
    const g = (args, when) => execFileSync('git', args, { cwd: repo, env: at(when), encoding: 'utf8' }).trim();
    const put = (file, body) => {
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), body);
    };
    g(['init', '-q', '-b', 'main'], 1000);
    put('apps/w/src/a.ts', '1');
    g(['add', '-A'], 1000);
    g(['commit', '-q', '-m', 'base'], 1000);
    const base = g(['rev-parse', 'HEAD'], 1000);
    g(['checkout', '-q', '-b', 'feature'], 2000);
    put('apps/w/src/a.ts', '2');
    g(['commit', '-q', '-am', 'old branch work'], 2000);
    put('apps/w/e2e/x.spec.ts', '');
    g(['add', '-A'], 2000);
    g(['commit', '-q', '-m', 'test only'], 2000);
    g(['checkout', '-q', 'main'], 9000);
    put('docs/x.md', '');
    g(['add', '-A'], 9000);
    g(['commit', '-q', '-m', 'unrelated'], 9000);
    g(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'], 9500);
    const pending = pendingSince(base, 'HEAD', { dir: 'apps/w', inputs: ['apps/w'] }, repo);
    ok(pending.length === 1 && pending[0].subject === 'merge feature', 'a merged branch is one change, the merge itself');
    ok(pending[0].time === 9500, 'its time is when it reached main, not when the branch was written');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_DEPLOY_READ_TOKEN;
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_DEPLOY_READ_TOKEN are required');
  const graceSeconds = Number(process.env.DEPLOY_LAG_GRACE_SECONDS ?? 21600);
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) throw new Error('DEPLOY_LAG_GRACE_SECONDS must be a non-negative number');
  const held = parseHeld(process.env.DEPLOY_LAG_HELD);
  const ref = process.env.DEPLOY_LAG_REF || 'HEAD';
  if (!commitExists(ref)) throw new Error(`DEPLOY_LAG_REF ${ref} is not a commit here`);

  const workers = discoverWorkers(tracked());
  for (const name of held.keys()) {
    if (!workers.some((w) => w.name === name)) throw new Error(`DEPLOY_LAG_HELD names ${name}, which no tracked wrangler config defines`);
  }
  const facts = [];
  for (const w of workers) facts.push(await gather(w, { ref, auth: { account, token } }));
  const { problems, report } = judgeDeployLag(facts, { now: Math.floor(Date.now() / 1000), graceSeconds, held });

  for (const line of report) console.log(line);
  for (const w of workers) console.log(`  ${w.name} inputs: ${w.inputs.join(', ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Deploy lag (grace ${age(graceSeconds)})\n\n${report.map((l) => `- ${l.replace(/[\r\n]+/g, ' ')}`).join('\n')}\n`,
    );
  }
  if (problems.length === 0) return;
  for (const p of problems) console.log(`::error title=Deploy lag::${p.text}`);
  // For the alert job. Every line is single-line and the heredoc delimiter is
  // random, so no text — some of it from the network — can end a value early.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const delimiter = `EOF_${randomUUID()}`;
    const lines = problems.map((p) => p.text.replace(/[\r\n]+/g, ' ').slice(0, 500));
    const keys = problems.map((p) => p.key.replace(/[^0-9A-Za-z_.:,-]/g, '?')).sort().join(',');
    appendFileSync(process.env.GITHUB_OUTPUT, `problems<<${delimiter}\n${lines.join('\n')}\n${delimiter}\nkeys=${keys}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
