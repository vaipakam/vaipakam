import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DEPLOY_TAG } from './deployStamp.mjs';
import { buildFileBody } from './buildFile.mjs';
import { BUILD_TAG, buildValue, noteServiceBuild, parseBuildFile, UNSTAMPED, type BuildHistoryDb } from './buildHistory';

const MIGRATION = new URL('../../../apps/indexer/migrations/0126_service_build_history.sql', import.meta.url);

function db(): { d1: BuildHistoryDb; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(MIGRATION, 'utf8'));
  const d1: BuildHistoryDb = {
    prepare: (sql) => ({
      bind: (...v) => ({
        run: async () => raw.prepare(sql.replace(/\?(\d+)/g, '?$1')).run(...(v as never[])),
      }),
    }),
  };
  return { d1, raw };
}

const rows = (raw: DatabaseSync) =>
  raw.prepare('SELECT service, seen_at, build, version_id, source FROM service_build_history ORDER BY seen_at').all();

describe('build history', () => {
  it('reads tags the way the deploy stamp writes them', () => {
    expect(BUILD_TAG.source).toBe(DEPLOY_TAG.source.replace('([0-9a-f]{12})', '[0-9a-f]{12}'));
    expect(buildValue('ABCDEF012345')).toBe('abcdef012345');
    expect(buildValue('abcdef012345-dirty')).toBe('abcdef012345-dirty');
    expect(buildValue('v1.2')).toBe(UNSTAMPED);
    expect(buildValue(undefined)).toBe(UNSTAMPED);
  });

  it('adds a row only when the build or version changes, and a rollback is a row of its own', async () => {
    const { d1, raw } = db();
    const note = (at: number, build: string, versionId: string | null = null) =>
      noteServiceBuild(d1, { service: 'indexer', build, versionId, source: 'self', at });
    await note(100, 'aaaaaaaaaaaa', 'v1');
    await note(200, 'aaaaaaaaaaaa', 'v1');
    await note(300, 'bbbbbbbbbbbb', 'v2');
    await note(400, 'aaaaaaaaaaaa', 'v1');
    await note(500, 'aaaaaaaaaaaa', 'v1');
    expect(rows(raw).map((r) => [r.seen_at, r.build])).toEqual([
      [100, 'aaaaaaaaaaaa'],
      [300, 'bbbbbbbbbbbb'],
      [400, 'aaaaaaaaaaaa'],
    ]);
    await noteServiceBuild(d1, { service: 'app', build: 'cccccccccccc', versionId: null, source: 'build-file', at: 500 });
    await noteServiceBuild(d1, { service: 'app', build: 'cccccccccccc', versionId: null, source: 'build-file', at: 600 });
    expect(rows(raw).filter((r) => r.service === 'app')).toHaveLength(1);
  });

  it('reads a build file, and refuses a page that is not one', () => {
    expect(parseBuildFile('{"build":"abcdef012345"}')).toBe('abcdef012345');
    expect(parseBuildFile('{"build":"unstamped"}')).toBe(UNSTAMPED);
    expect(parseBuildFile('<!doctype html><html></html>')).toBeNull();
    expect(parseBuildFile('{"build":"<script>"}')).toBeNull();
  });

  it('writes the deploy stamp tag into the build file', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    const git = (args: string[]) => (args[0] === 'rev-parse' ? sha : '');
    expect(parseBuildFile(buildFileBody({ env: {}, git }))).toBe('abcdef012345');
    expect(parseBuildFile(buildFileBody({ env: {}, git: () => { throw new Error('no git'); } }))).toBe(UNSTAMPED);
  });
});
