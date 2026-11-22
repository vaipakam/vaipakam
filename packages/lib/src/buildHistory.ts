/**
 * The build history (#3921, TroubleshootingPictureDesign §4.5 "Builds"):
 * which build of each service was running, from when. One row is added each
 * time a service is seen running a build other than the one its latest row
 * names, so a rollback to an earlier build is a row of its own.
 *
 * Where each service's build comes from:
 *   - a Worker with code (the indexer, the agent) notes its own version's
 *     tag, the commit stamp every deploy records (`deployStamp.mjs`), and the
 *     version id, on its scheduled run (`source = 'self'`);
 *   - the failed transaction pass reports its commit with the writes it
 *     already sends (`source = 'pass-report'`);
 *   - the app, the public site and alpha05 serve a `build.json` their build
 *     writes, which the indexer reads from their public origins
 *     (`source = 'build-file'`).
 *
 * A build that cannot be named is recorded as `unstamped` rather than not at
 * all: the record then says when the service ran something unknown.
 */

/** The deploy stamp's tag (`deployStamp.mjs` DEPLOY_TAG): 12 hex digits, optionally `-dirty`. */
export const BUILD_TAG = /^[0-9a-f]{12}(-dirty)?$/;

/** The header a service sends its build in, where it reports through an indexer route. */
export const BUILD_HEADER = 'x-vaipakam-build';

/** The record's value for a build the service could not name. */
export const UNSTAMPED = 'unstamped';

export type BuildSource = 'self' | 'pass-report' | 'build-file';

/** The services the build history names, so a typo cannot start a new one. */
export const BUILD_HISTORY_SERVICES = ['indexer', 'agent', 'failed-tx-pass', 'app', 'www', 'alpha05'] as const;
export type BuildHistoryService = (typeof BUILD_HISTORY_SERVICES)[number];

/** The build value to record for a tag as a service reported it. */
export function buildValue(tag: string | null | undefined): string {
  const t = (tag ?? '').trim().toLowerCase();
  return BUILD_TAG.test(t) ? t : UNSTAMPED;
}

export interface BuildHistoryDb {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/**
 * Add a row when `service` is now running a build (or version) other than
 * the one its latest row names. One statement, safe to repeat: the same build
 * seen again adds nothing.
 */
export async function noteServiceBuild(
  db: BuildHistoryDb,
  note: { service: BuildHistoryService; build: string; versionId: string | null; source: BuildSource; at: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO service_build_history (service, seen_at, build, version_id, source)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT build, version_id FROM service_build_history
             WHERE service = ?1 ORDER BY seen_at DESC, rowid DESC LIMIT 1
          ) latest
           WHERE latest.build = ?3 AND latest.version_id IS ?4
        )`,
    )
    .bind(note.service, note.at, buildValue(note.build), note.versionId, note.source)
    .run();
}

/**
 * The body of a `build.json` a static build serves. `build` is the deploy
 * stamp's tag, or `unstamped` when the build could not name its commit.
 */
export interface BuildFile {
  build: string;
}

/** The build a fetched `build.json` names, or null when the body is not one (an SPA fallback page, say). */
export function parseBuildFile(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const b = (parsed as { build?: unknown }).build;
    return typeof b === 'string' && (BUILD_TAG.test(b) || b === UNSTAMPED) ? b : null;
  } catch {
    return null;
  }
}
