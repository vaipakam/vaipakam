/**
 * The time a build stamps into its output (#3236).
 *
 * WHY. A build that stamps the clock never matches itself: two builds of one
 * commit carry two times, so every file that holds the stamp gets a new name
 * and a new hash. That made it impossible to answer "is the site we serve the
 * site this commit builds?" by rebuilding the commit and comparing. The build
 * now stamps the time of the COMMIT it was built from, which every rebuild of
 * that commit reads the same.
 *
 * WHERE THE TIME COMES FROM, in order:
 *   1. `SOURCE_DATE_EPOCH` (the reproducible-builds convention, whole seconds
 *      since 1970), when the caller sets it;
 *   2. the committer time of `HEAD`, from git (a shallow checkout has it too);
 *   3. neither available: the current time, with `reproducible: false`, so
 *      the caller can say the build will not match a rebuild.
 *
 * WHAT IT DOES NOT SAY. It is when the source was committed, not when the
 * bundle was made. A build of a working copy with uncommitted changes gets
 * the time of the commit those changes sit on.
 */
import { execFileSync } from 'node:child_process';

/**
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, git?: (args: string[]) => string, now?: () => Date }} [opts]
 *   `git` runs git and returns its stdout; `now` is the clock. Both injectable for tests.
 * @returns {{ iso: string, source: 'SOURCE_DATE_EPOCH' | 'commit' | 'clock', reproducible: boolean, reason?: string }}
 */
export function buildSourceTime({ cwd = process.cwd(), env = process.env, git, now = () => new Date() } = {}) {
  const raw = (env.SOURCE_DATE_EPOCH ?? '').trim();
  if (raw !== '') {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`SOURCE_DATE_EPOCH must be whole seconds since 1970, got "${raw}"`);
    }
    return { iso: new Date(Number(raw) * 1000).toISOString(), source: 'SOURCE_DATE_EPOCH', reproducible: true };
  }
  const run = git ?? ((args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  let reason;
  try {
    const out = run(['log', '-1', '--format=%ct', 'HEAD']).trim();
    if (/^\d+$/.test(out)) {
      return { iso: new Date(Number(out) * 1000).toISOString(), source: 'commit', reproducible: true };
    }
    reason = `git gave no commit time (${JSON.stringify(out)})`;
  } catch (err) {
    reason = `git could not read the commit time (${String(err?.message ?? err).split('\n')[0]})`;
  }
  return { iso: now().toISOString(), source: 'clock', reproducible: false, reason };
}
