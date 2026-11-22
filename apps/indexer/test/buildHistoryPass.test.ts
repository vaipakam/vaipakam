/**
 * #3921 — the indexer's build history pass: its own version once per
 * version, the static builds' files at most hourly, and nothing when the
 * tick's allowance cannot pay for it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from './helpers/sqliteD1';
import { buildFileOrigins, runBuildHistoryPass, type BuildHistoryMemory } from '../src/buildHistoryPass';
import { createBudget } from '../src/subrequestBudget';

const MIGRATION = readFileSync(new URL('../migrations/0126_service_build_history.sql', import.meta.url), 'utf8');

function setup() {
  const { d1: anyD1, db: raw } = createSqliteD1([MIGRATION]);
  const d1 = anyD1 as D1Database;
  const rows = () =>
    raw.prepare('SELECT service, build, version_id, source FROM service_build_history ORDER BY seen_at, service').all();
  return { d1, rows };
}

const ORIGINS = 'app=https://app.example,www=https://www.example,bogus=https://x.example,alpha05=http://plain.example';

function fetcher(bodies: Record<string, string>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const body = bodies[url];
    return new Response(body ?? '<!doctype html>', { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('build history pass', () => {
  it('keeps only known services on https origins', () => {
    expect(buildFileOrigins(ORIGINS)).toEqual([
      { service: 'app', origin: 'https://app.example' },
      { service: 'www', origin: 'https://www.example' },
    ]);
  });

  it('notes its own version once, and reads build files at most hourly', async () => {
    const { d1, rows } = setup();
    const memory: BuildHistoryMemory = { selfVersion: null, lastBuildFileRead: 0 };
    const { f, calls } = fetcher({ 'https://app.example/build.json': '{"build":"abcdef012345"}' });
    const env = {
      DB: d1,
      CF_VERSION_METADATA: { id: 'v1', tag: 'aaaaaaaaaaaa' },
      BUILD_FILE_ORIGINS: ORIGINS,
    };
    const run = (now: number) => runBuildHistoryPass(env, createBudget('t'), { now, fetcher: f, memory });
    await run(10_000_000);
    await run(10_000_000 + 60_000);
    expect(calls).toHaveLength(2);
    expect(rows()).toEqual([
      { service: 'app', build: 'abcdef012345', version_id: null, source: 'build-file' },
      { service: 'indexer', build: 'aaaaaaaaaaaa', version_id: 'v1', source: 'self' },
    ]);
    await run(10_000_000 + 3_600_000);
    expect(calls).toHaveLength(4);
    expect(rows()).toHaveLength(2);
  });

  it('records an unstamped version as unstamped', async () => {
    const { d1, rows } = setup();
    await runBuildHistoryPass(
      { DB: d1, CF_VERSION_METADATA: { id: 'v9' } },
      createBudget('t'),
      { memory: { selfVersion: null, lastBuildFileRead: 0 } },
    );
    expect(rows()).toEqual([{ service: 'indexer', build: 'unstamped', version_id: 'v9', source: 'self' }]);
  });
});
