#!/usr/bin/env node
/**
 * Is each site serving what its recorded commit builds? (#3236)
 *
 * WHY THIS EXISTS. The deploy-lag check (#2242) asks whether a Worker runs
 * `main`; it trusts the deploy stamp to say what the Worker runs. This check
 * asks the next question: do the bytes a visitor receives match a build of
 * that commit? A wallet-facing app is the place an attacker who reached the
 * Cloudflare account, the Workers Build settings or the edge would change
 * code, and nothing else in the repository would notice. Builds are
 * reproducible (#3273): two builds of one commit with the same build
 * variables write the same files, so any difference is a finding.
 *
 * WHAT IT DOES, per site in .github/served-build.json:
 *   1. reads the Worker's live deployment (one version taking all traffic,
 *      stamped with a clean commit — anything else is `unverifiable`);
 *   2. refuses to build a commit that is not on `main` (`off-main`): the
 *      deployed code was never merged, which is itself the finding;
 *   3. checks that commit out in a temporary worktree, installs from the
 *      lockfile and runs the site's build with the build variables recorded
 *      in .github/served-build.json, in an environment holding no token;
 *   4. fetches every file the Worker serves from every host and compares
 *      SHA-256 digests, and compares the security headers `_headers` sets for
 *      `/` with the ones the host sends;
 *   5. reads the deployment again and discards the result when it changed
 *      during the check (a deploy landing mid-run is not a finding).
 *
 * WHAT FAILS (exit 1), each named:
 *   - `mismatch:<worker>`     — a served file or header differs from the
 *                               build. Two causes are possible and the report
 *                               names both: the dashboard's build variables
 *                               changed without the same change to
 *                               .github/served-build.json, or what is served
 *                               was altered. Treat it as the second until the
 *                               first is shown;
 *   - `unverifiable:<worker>` — the deployment cannot be read, is split
 *                               across versions, carries no stamp, or was
 *                               built from uncommitted changes;
 *   - `off-main:<worker>`     — the stamped commit is not on `main`;
 *   - `unbuildable:<worker>`  — the recorded commit did not build here;
 *   - `unapproved:<worker>`   — deploy approval is on (the repository
 *                               variable SITE_DEPLOY_APPROVAL=on) and the
 *                               live deployment was not made by an approval
 *                               run (.github/workflows/promote-site.yml).
 * An unknown is never reported as a match.
 *
 * WHAT IT DOES NOT SEE. Only the files the build writes are compared. A file
 * the host serves that the build does not write (or an edge script injected
 * into a page) is outside it, except where it changes a compared file. The
 * marketing site's prerendered pages are written by a later deploy step and
 * are not compared, only its assets.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_DEPLOY_READ_TOKEN=… \
 *     node .github/scripts/check-served-build.mjs [--site vaipakam-app]
 *   node .github/scripts/check-served-build.mjs --site vaipakam-app --version <uuid>
 *     (a candidate awaiting approval, compared through its preview URL)
 *   node .github/scripts/check-served-build.mjs --selftest
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { latestApproval } from './lib/approvalRecord.mjs';
import { readLatestDeployment, readVersion } from './lib/workerDeployments.mjs';

const CONFIG_PATH = '.github/served-build.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const oneLine = (text, max = 160) => String(text).replace(/[\r\n]+/g, ' ').slice(0, max);

// ── pure parts (selftested) ──────────────────────────────────────────────

/**
 * The header rules of a Cloudflare `_headers` file, as a map from path
 * pattern to `[name, value]` pairs. A detach rule (`! Name`) is kept as a
 * null value. Comments and blank lines are ignored.
 */
export function parseHeaderRules(text) {
  const rules = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (!/^\s/.test(raw)) {
      current = raw.trim();
      if (!rules.has(current)) rules.set(current, []);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (line.startsWith('!')) {
      rules.get(current).push([line.slice(1).trim().toLowerCase(), null]);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    rules.get(current).push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/**
 * The headers the rules set for the site root `/`, from the `/*` and `/`
 * rules only (the two that always match it; a placeholder rule never matches
 * an empty path). Repeated names join with ", ", as Cloudflare sends them.
 */
export function rootHeaders(rules) {
  const out = new Map();
  for (const pattern of ['/*', '/']) {
    for (const [name, value] of rules.get(pattern) ?? []) {
      if (value === null) out.delete(name);
      else out.set(name, out.has(name) ? `${out.get(name)}, ${value}` : value);
    }
  }
  return out;
}

/** The files of a build the Worker serves, as dist-relative POSIX paths. */
export function servedFiles(files, { compare, ignored }) {
  const config = new Set(['_headers', '_redirects', '_routes.json', '.assetsignore', ...ignored]);
  return files
    .filter((f) => !config.has(f))
    .filter((f) => compare === 'all' || f.startsWith('assets/'))
    .sort();
}

/** The URL path a dist file is served at. */
export const servedPath = (file) => (file === 'index.html' ? '/' : `/${file}`);

/**
 * One file's verdict: 'match', 'suffix' (the built bytes end what is served,
 * on a path the config says a host rewrites), or a reason it does not match.
 */
export function judgeFile({ built, served, status, suffixAllowed }) {
  if (status !== 200) return `answered HTTP ${status}`;
  if (built.equals(served)) return 'match';
  if (suffixAllowed && served.length > built.length && served.subarray(served.length - built.length).equals(built)) {
    return 'suffix';
  }
  return `differs (${served.length} bytes served, ${built.length} built, sha256 ${sha256(served).slice(0, 12)} vs ${sha256(built).slice(0, 12)})`;
}

/** Whether a deployment answer can be verified, and from which commit. */
export function verifiableCommit(live) {
  if (live.read === 'none') return { reason: 'the Worker has no deployment' };
  if (live.read === 'error') return { reason: `its deployment could not be read (${live.error})` };
  if (live.versions.length !== 1) return { reason: `traffic is split across ${live.versions.length} versions` };
  const [v] = live.versions;
  if (!v.stamp) return { reason: `version ${v.id} carries no commit stamp (deployed outside the package deploy script)` };
  if (v.stamp[2]) return { reason: `version ${v.id} was built from ${v.stamp[1]} plus uncommitted changes, which no commit records` };
  return { short: v.stamp[1], version: v.id };
}

/** Whether a deployment read after the comparison still serves only `version`. */
export const deploymentUnchanged = (live, version) =>
  live.read === 'ok' && live.versions.length === 1 && live.versions[0].id === version;

// ── side effects ─────────────────────────────────────────────────────────

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

function ignoredByAssetsIgnore(dist) {
  const file = join(dist, '.assetsignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * The build environment: what a build needs to run, the site's recorded
 * build variables, and nothing else. In particular no Cloudflare or GitHub
 * token reaches the build, which runs code from the deployed commit.
 */
function buildEnv(buildVars) {
  // The proxy settings are kept so the check also runs where outbound
  // traffic must go through one; they carry no credential of this check's.
  const keep = [
    'PATH', 'HOME', 'TMPDIR', 'COREPACK_HOME', 'PNPM_HOME', 'npm_config_store_dir',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  ];
  const env = { LANG: 'C.UTF-8', TZ: 'UTC', CI: 'true' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...buildVars };
}

function run(cmd, args, { cwd, env }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.signal}\n${tail}`);
  }
}

/** One worktree per commit, installed once and shared by the sites built from it. */
const worktrees = new Map();
function worktreeFor(commit) {
  if (worktrees.has(commit)) return worktrees.get(commit);
  const dir = mkdtempSync(join(tmpdir(), `served-build-${commit.slice(0, 12)}-`));
  git(['worktree', 'add', '--detach', '--force', dir, commit]);
  const entry = { dir, installed: false };
  worktrees.set(commit, entry);
  return entry;
}

async function fetchBytes(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'cache-control': 'no-cache', 'user-agent': 'vaipakam-served-build-check' },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * The preview origin of one version: `https://<first 8 of its id>-<worker>.<subdomain>.workers.dev`,
 * from the site's own workers.dev host in the config.
 */
export function previewHost(site, versionId) {
  const own = site.hosts.find((h) => h.startsWith(`https://${site.worker}.`) && h.endsWith('.workers.dev'));
  if (!own) return null;
  return own.replace(`https://${site.worker}.`, `https://${versionId.slice(0, 8)}-${site.worker}.`);
}

/**
 * `target` is `{ mode: 'live' }` (what visitors receive now) or
 * `{ mode: 'candidate', version }` (a version uploaded for approval, #3236,
 * compared through its preview URL before anyone approves it).
 */
async function checkSite(site, { auth, github, ref, suffixPaths, approvalOn, target = { mode: 'live' } }) {
  const problem = (kind, text) => ({ key: `${kind}:${site.worker}`, text: `${site.worker}: ${text}` });
  let v;
  let hosts = site.hosts;
  if (target.mode === 'candidate') {
    const ver = await readVersion(site.worker, target.version, auth);
    if (ver.read !== 'ok') return { problems: [problem('unverifiable', `version ${target.version} cannot be read (${ver.read === 'none' ? 'not found' : ver.error}).`)], report: [] };
    if (!ver.stamp || ver.stamp[2] || !ver.message) return { problems: [problem('unverifiable', `version ${ver.id} carries no clean commit stamp, so it cannot be approved.`)], report: [] };
    const preview = ver.hasPreview ? previewHost(site, ver.id) : null;
    if (!preview) return { problems: [problem('unverifiable', `version ${ver.id} has no preview URL to compare.`)], report: [] };
    v = { short: ver.stamp[1], version: ver.id };
    hosts = [preview];
  } else {
    const before = await readLatestDeployment(site.worker, auth);
    v = verifiableCommit(before);
    if (v.reason) return { problems: [problem('unverifiable', `cannot be verified: ${v.reason}.`)], report: [] };
    // With the deploy approval on (#3236), the live version must be the one
    // most recently approved, by GitHub's record (lib/approvalRecord.mjs).
    // The deployment's own message is written by whoever deploys, so it is
    // only a cross-check, never the proof. Anything else went live around
    // the approval: a dashboard change of the deploy mode, a deploy made
    // directly with a Cloudflare token, or an older approved version put
    // back by hand.
    if (approvalOn) {
      const rec = await latestApproval(site.worker, github);
      if (rec.read !== 'ok') return { problems: [problem('unverifiable', `its approval record on GitHub cannot be read (${rec.error}).`)], report: [] };
      const why = !rec.approval
        ? 'no approval run on main has promoted any version of it'
        : rec.approval.version !== v.version
          ? `the latest approved version is ${rec.approval.version} (${rec.approval.runUrl})`
          : before.approvedBy !== rec.approval.runUrl
            ? `its deployment does not name the run that approved it (${rec.approval.runUrl})`
            : null;
      if (why) {
        return { problems: [problem('unapproved', `is live on version ${v.version}, which is not the version a person last approved: ${why}. Deploy approval is on (SITE_DEPLOY_APPROVAL); check the Workers Build deploy mode and who deployed it.`)], report: [] };
      }
    }
  }

  let commit;
  try {
    commit = git(['rev-parse', '--verify', '--quiet', `${v.short}^{commit}`]).trim();
  } catch {
    return { problems: [problem('off-main', `is stamped ${v.short}, which is no commit in this repository.`)], report: [] };
  }
  try {
    git(['merge-base', '--is-ancestor', commit, ref]);
  } catch {
    return { problems: [problem('off-main', `is serving ${v.short}, which is not on main: the deployed code was never merged.`)], report: [] };
  }

  let dist;
  try {
    const wt = worktreeFor(commit);
    const env = buildEnv({});
    if (!wt.installed) {
      run('pnpm', ['install', '--frozen-lockfile'], { cwd: wt.dir, env });
      wt.installed = true;
    }
    const siteDir = join(wt.dir, site.dir);
    rmSync(join(siteDir, 'dist'), { recursive: true, force: true });
    run('pnpm', ['run', 'build'], { cwd: siteDir, env: buildEnv(site.buildVars) });
    dist = join(siteDir, 'dist');
  } catch (err) {
    console.error(err.message);
    return { problems: [problem('unbuildable', `its recorded commit ${v.short} did not build here (${oneLine(err.message.split('\n')[0])}); the run log has the build output.`)], report: [] };
  }

  const files = servedFiles(listFiles(dist), { compare: site.compare, ignored: ignoredByAssetsIgnore(dist) });
  const headersFile = join(dist, '_headers');
  const expectedHeaders = existsSync(headersFile) ? rootHeaders(parseHeaderRules(readFileSync(headersFile, 'utf8'))) : new Map();

  const differences = [];
  let matched = 0;
  for (const host of hosts) {
    const verdicts = await pool(files, 8, async (file) => {
      const path = servedPath(file);
      try {
        const res = await fetchBytes(`${host}${path}`);
        return { file, verdict: judgeFile({ built: readFileSync(join(dist, file)), served: res.body, status: res.status, suffixAllowed: suffixPaths.has(path) }) };
      } catch (err) {
        return { file, verdict: `could not be fetched (${oneLine(err.message, 60)})` };
      }
    });
    for (const { file, verdict } of verdicts) {
      if (verdict === 'match' || verdict === 'suffix') matched++;
      else differences.push(`${host}${servedPath(file)} ${verdict}`);
    }
    if (expectedHeaders.size > 0) {
      try {
        const res = await fetchBytes(`${host}/`);
        for (const [name, value] of expectedHeaders) {
          const sent = res.headers.get(name);
          if (sent !== value) differences.push(`${host}/ header ${name}: ${sent === null ? 'not sent' : 'differs from _headers'}`);
        }
      } catch (err) {
        differences.push(`${host}/ headers could not be fetched (${oneLine(err.message, 60)})`);
      }
    }
  }

  // Only an OBSERVED change of version excuses the result. A failed second
  // read shows nothing changed, so it leaves the site unverified, never
  // passed and never skipped.
  const after = target.mode === 'live' ? await readLatestDeployment(site.worker, auth) : null;
  if (after && after.read !== 'ok') {
    const why = after.read === 'none' ? 'the Worker has no deployment' : `it could not be read (${after.error})`;
    return { problems: [problem('unverifiable', `cannot be verified: its deployment was read before the comparison but not after it: ${why}.`)], report: [] };
  }
  if (after && !deploymentUnchanged(after, v.version)) {
    const now = after.versions.map((x) => `${x.id} at ${x.percentage}%`).join(', ');
    return { problems: [], report: [`${site.worker}: its deployment changed during the check (${v.version} → ${now}); not judged this run.`] };
  }

  const summary = `${files.length} file(s) on ${hosts.length} host(s), built from ${v.short} (version ${v.version})`;
  if (differences.length === 0) {
    return { problems: [], report: [`${site.worker}: serving exactly what ${v.short} builds — ${summary}${expectedHeaders.size ? `, and the ${expectedHeaders.size} root header(s) _headers sets` : ''}.`] };
  }
  for (const d of differences.slice(0, 50)) console.log(`  ${site.worker} ${d}`);
  return {
    problems: [
      problem(
        'mismatch',
        `${differences.length} difference(s) between what is served and a build of ${v.short} (${matched} file fetch(es) matched), e.g. ${differences[0]}. ` +
          `Either the dashboard's build variables changed without the same change to ${CONFIG_PATH}, or what is served was altered. Treat it as altered until the variables are shown to be the cause.`,
      ),
    ],
    report: [],
  };
}

// ── selftest ─────────────────────────────────────────────────────────────

function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`selftest: ${msg}`);
  };
  const rules = parseHeaderRules(
    ['# comment', '/*', '  X-A: one', '  Content-Security-Policy: default-src \'self\'', '', '/', '  Cache-Control: no-store', '  X-A: two', '/positions', '  X-Robots-Tag: noindex', '/:locale/*', '  X-Robots-Tag: noindex', '/x', '  ! X-A'].join('\n'),
  );
  const root = rootHeaders(rules);
  ok(root.get('x-a') === 'one, two', 'repeated names join');
  ok(root.get('content-security-policy') === "default-src 'self'", 'value with a colon-free tail is kept whole');
  ok(root.get('cache-control') === 'no-store', '/ rule applies to the root');
  ok(!root.has('x-robots-tag'), 'an exact or placeholder rule elsewhere does not reach the root');
  ok(rules.get('/x')[0][1] === null, 'a detach rule is recorded');
  ok(rootHeaders(parseHeaderRules('/*\n  X-B: 1\n/\n  ! X-B')).has('x-b') === false, 'a detach on / removes a /* header');

  const files = ['index.html', 'assets/a.js', '_headers', '_redirects', '.assetsignore', 'wrangler.json', 'robots.txt'];
  const all = servedFiles(files, { compare: 'all', ignored: ['wrangler.json'] });
  ok(JSON.stringify(all) === JSON.stringify(['assets/a.js', 'index.html', 'robots.txt']), `served files: ${all}`);
  ok(JSON.stringify(servedFiles(files, { compare: 'assets', ignored: [] })) === JSON.stringify(['assets/a.js']), 'assets mode');
  ok(servedPath('index.html') === '/' && servedPath('assets/a.js') === '/assets/a.js', 'served paths');

  const b = Buffer.from('built');
  ok(judgeFile({ built: b, served: Buffer.from('built'), status: 200, suffixAllowed: false }) === 'match', 'exact match');
  ok(judgeFile({ built: b, served: Buffer.from('prefix built'), status: 200, suffixAllowed: true }) === 'suffix', 'allowed suffix');
  ok(judgeFile({ built: b, served: Buffer.from('prefix built'), status: 200, suffixAllowed: false }).startsWith('differs'), 'suffix not allowed elsewhere');
  ok(judgeFile({ built: b, served: Buffer.from('built extra'), status: 200, suffixAllowed: true }).startsWith('differs'), 'appended bytes differ');
  ok(judgeFile({ built: b, served: Buffer.from('built'), status: 307, suffixAllowed: false }) === 'answered HTTP 307', 'status');

  const stamp = (tag) => /^([0-9a-f]{12})(-dirty)?$/.exec(tag);
  const version = (tag) => ({ id: 'v1', percentage: 100, tag, stamp: stamp(tag), uploadedAt: null });
  ok(verifiableCommit({ read: 'none' }).reason, 'no deployment is unverifiable');
  ok(verifiableCommit({ read: 'error', error: 'HTTP 403' }).reason.includes('HTTP 403'), 'read error is unverifiable');
  ok(verifiableCommit({ read: 'ok', versions: [version('aaaaaaaaaaaa'), version('bbbbbbbbbbbb')] }).reason, 'split traffic is unverifiable');
  ok(verifiableCommit({ read: 'ok', versions: [{ ...version(''), stamp: null }] }).reason.includes('no commit stamp'), 'unstamped');
  ok(verifiableCommit({ read: 'ok', versions: [version('aaaaaaaaaaaa-dirty')] }).reason.includes('uncommitted'), 'dirty');
  ok(verifiableCommit({ read: 'ok', versions: [version('aaaaaaaaaaaa')] }).short === 'aaaaaaaaaaaa', 'clean stamp');
  ok(deploymentUnchanged({ read: 'ok', versions: [version('aaaaaaaaaaaa')] }, 'v1'), 'same version is unchanged');
  ok(!deploymentUnchanged({ read: 'ok', versions: [{ ...version('aaaaaaaaaaaa'), id: 'v2' }] }, 'v1'), 'a new version is a change');
  ok(!deploymentUnchanged({ read: 'ok', versions: [version('aaaaaaaaaaaa'), { ...version('aaaaaaaaaaaa'), id: 'v2' }] }, 'v1'), 'a split is a change');
  ok(!deploymentUnchanged({ read: 'error', error: 'HTTP 503' }, 'v1'), 'a failed read is not "unchanged"');

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  for (const site of config.sites) {
    ok(/^vaipakam-[a-z0-9-]+$/.test(site.worker), `worker name ${site.worker}`);
    ok(existsSync(join(site.dir, 'package.json')), `${site.worker}: ${site.dir} is a package`);
    ok(site.compare === 'all' || site.compare === 'assets', `${site.worker}: compare mode`);
    ok(site.hosts.length > 0 && site.hosts.every((h) => /^https:\/\/[a-z0-9.-]+$/.test(h)), `${site.worker}: hosts are bare https origins`);
    ok(Object.entries(site.buildVars).every(([k, val]) => /^VITE_[A-Z0-9_]+$/.test(k) && typeof val === 'string'), `${site.worker}: only public VITE_ build variables are recorded`);
  }
  const site0 = { worker: 'vaipakam-alpha05', hosts: ['https://alpha05.vaipakam.com', 'https://vaipakam-alpha05.dawn-fire-139e.workers.dev'] };
  ok(previewHost(site0, '67d96165-ae24-4a8a-b655-192fd468d1dc') === 'https://67d96165-vaipakam-alpha05.dawn-fire-139e.workers.dev', 'preview host');
  ok(previewHost({ worker: 'x', hosts: ['https://x.example.com'] }, '67d96165-ae24-4a8a-b655-192fd468d1dc') === null, 'no workers.dev host, no preview');
  console.log('check-served-build selftest: OK');
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_DEPLOY_READ_TOKEN;
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_DEPLOY_READ_TOKEN are required');
  const ref = process.env.SERVED_BUILD_REF || 'HEAD';
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const only = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : null;
  const sites = config.sites.filter((s) => !only || s.worker === only);
  if (sites.length === 0) throw new Error(`no site ${only} in ${CONFIG_PATH}`);
  const suffixPaths = new Set(config.suffixMatch.map((s) => s.path));
  // A candidate (#3236): one site's uploaded version, compared through its
  // preview URL before it is approved.
  const candidate = process.argv.includes('--version') ? process.argv[process.argv.indexOf('--version') + 1] : null;
  if (candidate && sites.length !== 1) throw new Error('--version needs --site');
  const target = candidate ? { mode: 'candidate', version: candidate } : { mode: 'live' };
  // Whether deploy approval is on is a repository setting, stated in the
  // report either way.
  const approvalOn = (process.env.SITE_DEPLOY_APPROVAL ?? '').trim() === 'on';
  // The approval record is read from GitHub (actions: read, checks: read).
  const github = { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY || 'vaipakam/vaipakam', api: process.env.GITHUB_API_URL || 'https://api.github.com' };
  if (approvalOn && !candidate && !github.token) throw new Error('deploy approval is on, so GITHUB_TOKEN (actions: read, checks: read) is required to read the approval record');

  const problems = [];
  const report = [];
  try {
    for (const site of sites) {
      const r = await checkSite(site, { auth: { account, token }, github, ref, suffixPaths, approvalOn, target });
      problems.push(...r.problems);
      report.push(...r.report, ...r.problems.map((p) => p.text));
    }
  } finally {
    for (const { dir } of worktrees.values()) {
      try {
        git(['worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  if (!candidate) report.push(`Deploy approval (SITE_DEPLOY_APPROVAL) is ${approvalOn ? 'ON: a live version must have been approved' : 'off: sites deploy on merge'}.`);
  for (const line of report) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Served build\n\n${report.map((l) => `- ${oneLine(l, 600)}`).join('\n')}\n`);
  }
  if (problems.length === 0) return;
  for (const p of problems) console.log(`::error title=Served build::${oneLine(p.text, 600)}`);
  // For the alert job: single-line values under a random heredoc delimiter,
  // so no text (some of it from the network) can end a value early.
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `EOF_${randomUUID()}`;
    const lines = problems.map((p) => oneLine(p.text, 600));
    const keys = problems.map((p) => p.key.replace(/[^0-9A-Za-z_.:,-]/g, '?')).sort().join(',');
    appendFileSync(process.env.GITHUB_OUTPUT, `problems<<${delimiter}\n${lines.join('\n')}\n${delimiter}\nkeys=${keys}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
