/**
 * #3921 — the indexer's part of the build history (TroubleshootingPictureDesign
 * §4.5 "Builds", `@vaipakam/lib/buildHistory`):
 *
 *   - its OWN build: the version tag and id from the version-metadata binding,
 *     noted once per version an isolate runs (`source = 'self'`);
 *   - the STATIC builds (the app, the public site, alpha05): the `build.json`
 *     each serves, read from its public origin at most once an hour per
 *     isolate (`source = 'build-file'`).
 *
 * Runs in the post-ingest queue and asks the tick's live allowance first, so
 * it never takes what a chain pass needs; a tick that cannot afford it leaves
 * it for the next. A failure is logged and changes nothing.
 */
import {
  BUILD_HISTORY_SERVICES,
  noteServiceBuild,
  parseBuildFile,
  UNSTAMPED,
  type BuildHistoryService,
} from '@vaipakam/lib/buildHistory';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { affords, meterD1, spendExternal, type TickBudget } from './subrequestBudget';

/** How often an isolate reads the static builds' files. */
export const BUILD_FILE_READ_INTERVAL_MS = 60 * 60 * 1000;
const BUILD_FILE_TIMEOUT_MS = 5_000;

/** The static builds named in `BUILD_FILE_ORIGINS` (`service=https://origin,…`); unknown services and non-https origins are dropped. */
export function buildFileOrigins(raw: string | undefined): { service: BuildHistoryService; origin: string }[] {
  const out: { service: BuildHistoryService; origin: string }[] = [];
  for (const pair of (raw ?? '').split(',')) {
    const [name, origin] = pair.split('=').map((s) => s?.trim() ?? '');
    if (!(BUILD_HISTORY_SERVICES as readonly string[]).includes(name)) continue;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) continue;
      out.push({ service: name as BuildHistoryService, origin: u.origin });
    } catch {
      /* not a URL: dropped */
    }
  }
  return out;
}

/** Per-isolate memory of what was already noted, so a tick costs nothing when nothing changed. */
export interface BuildHistoryMemory {
  selfVersion: string | null;
  lastBuildFileRead: number;
}
const isolateMemory: BuildHistoryMemory = { selfVersion: null, lastBuildFileRead: 0 };

export async function runBuildHistoryPass(
  env: {
    DB: D1Database;
    CF_VERSION_METADATA?: { id: string; tag?: string };
    BUILD_FILE_ORIGINS?: string;
  },
  budget: TickBudget,
  opts: { now?: number; fetcher?: typeof fetch; memory?: BuildHistoryMemory } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  const at = Math.floor(now / 1000);
  const memory = opts.memory ?? isolateMemory;
  const doFetch = opts.fetcher ?? fetch;
  const db = meterD1(env.DB, budget);

  const self = env.CF_VERSION_METADATA;
  if (self?.id && memory.selfVersion !== self.id && affords(budget, { external: 0, d1Queries: 1 })) {
    await noteServiceBuild(db, { service: 'indexer', build: self.tag ?? UNSTAMPED, versionId: self.id, source: 'self', at });
    memory.selfVersion = self.id;
  }

  const origins = buildFileOrigins(env.BUILD_FILE_ORIGINS);
  if (origins.length === 0 || now - memory.lastBuildFileRead < BUILD_FILE_READ_INTERVAL_MS) return;
  if (!affords(budget, { external: origins.length, d1Queries: origins.length })) return;
  memory.lastBuildFileRead = now;
  for (const { service, origin } of origins) {
    if (!spendExternal(budget)) return;
    try {
      const res = await doFetch(`${origin}/build.json`, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(BUILD_FILE_TIMEOUT_MS),
      });
      const build = res.ok ? parseBuildFile(await res.text()) : null;
      if (build === null) {
        // eslint-disable-next-line no-console
        console.warn(`[indexer] build history: ${service} served no build file (status ${res.status})`);
        continue;
      }
      await noteServiceBuild(db, { service, build, versionId: null, source: 'build-file', at });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[indexer] build history: ${service} build file unreadable: ${describeFailure(err)}`);
    }
  }
}
