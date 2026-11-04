/**
 * The commit a Worker deploy was built from, recorded ON the deployment (#2242).
 *
 * WHY. Merged code that never reached its Worker went unnoticed for days: the
 * connected app served a build from before #2190 while #2190 sat on `main`,
 * and nothing said so. The deploy-lag check (.github/scripts/check-deploy-lag.mjs)
 * now compares each Worker's live deployment with `main`. Cloudflare records
 * WHEN a version was uploaded but not WHAT it was built from, so every deploy
 * this repository runs stamps that itself: the version's tag carries the
 * commit, and its message says so in words. Without a stamp the check can
 * only infer the commit from the upload time, and it says that it did.
 *
 * WHAT THE STAMP SAYS, and does not.
 *   - `tag`     — the first 12 hex digits of the commit, with `-dirty` when
 *                 the checkout had uncommitted changes to tracked files. A
 *                 dirty build contains that commit plus something no commit
 *                 records, and the check reports it that way.
 *   - `message` — the same, in words, with the full commit.
 *   Untracked files are not looked at: a build reads them only if something
 *   tracked imports them, and that import would itself be a tracked change.
 *   A build step that rewrites a tracked file marks a working-copy deploy
 *   dirty too; the check then reports "plus uncommitted changes", which
 *   overstates and never hides.
 *
 * WHERE THE COMMIT COMES FROM. Workers Builds checks the repository out and
 * names the commit in WORKERS_CI_COMMIT_SHA; a deploy from a working copy asks
 * git. Neither available → no stamp, a warning, and the deploy goes ahead: a
 * missing stamp costs the check its precision, not the release.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The tag form the check reads back: 12 hex digits, optionally `-dirty`. */
export const DEPLOY_TAG = /^([0-9a-f]{12})(-dirty)?$/;

/**
 * The stamp for a build of `cwd`'s checkout, or null with the reason when the
 * commit cannot be named.
 *
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, git?: (args: string[]) => string }} [opts]
 *   `git` runs git and returns its stdout; injectable for tests.
 * @returns {{ commit: string, dirty: boolean, tag: string, message: string } | { reason: string }}
 */
export function deployStamp({ cwd = process.cwd(), env = process.env, git } = {}) {
  const run = git ?? ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const fromBuildEnv = (env.WORKERS_CI_COMMIT_SHA ?? '').trim().toLowerCase();
  let commit = fromBuildEnv;
  if (!commit) {
    try {
      commit = run(['rev-parse', 'HEAD']).trim().toLowerCase();
    } catch (err) {
      return { reason: `git could not name the commit (${String(err?.message ?? err).split('\n')[0]})` };
    }
  }
  // Workers Builds builds the commit it names from a fresh checkout, so its
  // tree holds no uncommitted source; asking git there would only see what
  // the build itself wrote. A working copy is asked, and one git cannot
  // inspect is not shown to be clean, so it is stamped dirty.
  let dirty = false;
  if (!fromBuildEnv) {
    try {
      dirty = run(['status', '--porcelain', '--untracked-files=no']).trim() !== '';
    } catch {
      dirty = true;
    }
  }
  if (!FULL_SHA.test(commit)) return { reason: `not a full commit hash: ${JSON.stringify(commit.slice(0, 64))}` };
  return {
    commit,
    dirty,
    tag: `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}`,
    message: dirty ? `built from ${commit} plus uncommitted changes` : `built from ${commit}`,
  };
}

/** The wrangler flags that record `stamp` on the deployment. */
export function deployStampArgs(stamp) {
  return 'tag' in stamp ? ['--tag', stamp.tag, '--message', stamp.message] : [];
}

/**
 * The JavaScript entry of the wrangler the package at `cwd` declares.
 *
 * Read from the package's own `bin` field rather than resolved as the
 * subpath `wrangler/bin/wrangler.js`: wrangler's `exports` map stopped
 * exposing that subpath (4.114 lists only `.`, `./experimental-config` and
 * `./package.json`), and Node refuses any subpath an `exports` map omits.
 * `./package.json` is exported by every version, and `bin.wrangler` is the
 * file the `wrangler` command itself runs.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function wranglerEntry(cwd) {
  const manifest = createRequire(join(cwd, 'package.json')).resolve('wrangler/package.json');
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  const rel = typeof bin === 'string' ? bin : bin?.wrangler;
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`wrangler at ${dirname(manifest)} declares no "wrangler" bin`);
  }
  return join(dirname(manifest), rel);
}

/**
 * Run `wrangler deploy <args…> <stamp flags>` for the package at `cwd`.
 *
 * Wrangler is started as its own JavaScript entry under this Node, never
 * through a shell: on Windows a shell would split the stamp's message (it
 * has spaces) into separate arguments, and wrangler would refuse them. The
 * entry is resolved from `cwd`, so each package deploys with the wrangler
 * it declares.
 *
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer>}
 */
export function wranglerDeploy(args, { cwd = process.cwd(), stamp, stdio = 'inherit' } = {}) {
  const entry = wranglerEntry(cwd);
  return spawnSync(process.execPath, [entry, 'deploy', ...args, ...deployStampArgs(stamp ?? { reason: 'none given' })], {
    cwd,
    stdio,
  });
}
