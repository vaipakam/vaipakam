/**
 * The machine host's deploy kit (host/deploy/): the env template and the
 * files that name one another's paths. Each of these drifts silently: a
 * setting missing from the template reaches the machine unset, and a path
 * one file changes and another does not leaves systemd starting a file that
 * is never built.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_SETTINGS } from '../host/hostEnv';
import { PLAIN_VAR_KEYS, SECRET_BINDING_KEYS } from '../src/env';

const keeperDir = fileURLToPath(new URL('..', import.meta.url));
const deployDir = join(keeperDir, 'host', 'deploy');
const read = (name: string) => readFileSync(join(deployDir, name), 'utf8');

function templateEntries(): [string, string][] {
  return read('keeper.env.example')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    });
}

describe('host env template', () => {
  it('lists every setting the keeper reads, once, and nothing else', () => {
    const keys = templateEntries().map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    const expected = [...SECRET_BINDING_KEYS, ...PLAIN_VAR_KEYS, ...Object.values(HOST_SETTINGS)];
    expect([...keys].sort()).toEqual([...expected].sort());
  });

  it('ships disarmed, with no secret filled in', () => {
    const values = Object.fromEntries(templateEntries());
    expect(values.KEEPER_ENABLED).toBe('false');
    for (const flag of ['GRACE_DEFAULT_ENABLED', 'REWARD_REMIT_ENABLED', 'REWARD_COMMIT_ENABLED']) {
      expect(values[flag]).toBe('');
    }
    for (const key of [...SECRET_BINDING_KEYS, HOST_SETTINGS.apiToken, HOST_SETTINGS.accountId]) {
      expect(values[key], key).toBe('');
    }
  });

  it('points at the shared database the Worker binds', () => {
    const wrangler = readFileSync(join(keeperDir, 'wrangler.jsonc'), 'utf8');
    const databaseId = Object.fromEntries(templateEntries())[HOST_SETTINGS.databaseId];
    expect(databaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wrangler).toContain(databaseId);
  });
});

describe('host deploy kit paths', () => {
  const pkg = JSON.parse(readFileSync(join(keeperDir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('starts the file promote.sh installs, built from the file build:host writes', () => {
    expect(pkg.scripts['build:host']).toContain('--outfile=dist/keeper-host.mjs');
    expect(read('update.sh')).toContain('apps/keeper/dist/keeper-host.mjs');
    expect(read('update.sh')).toContain('"$STAGING/keeper-host.mjs"');
    const promote = read('promote.sh');
    expect(promote).toContain('STAGING=/var/lib/vaipakam-build/staging');
    expect(promote).toContain('"$tmp/keeper-host.mjs"');
    expect(read('vaipakam-keeper.service')).toContain('/opt/vaipakam-keeper/current/keeper-host.mjs');
  });

  it('promotes on the marker update.sh rewrites, and restarts only a running keeper', () => {
    expect(read('update.sh')).toContain('"$STAGING/ready"');
    expect(read('vaipakam-keeper-promote.path')).toContain('PathChanged=/var/lib/vaipakam-build/staging/ready');
    expect(read('vaipakam-keeper-promote.service')).toContain('ExecStart=/opt/vaipakam-keeper/promote.sh');
    expect(read('promote.sh')).toContain('systemctl try-restart --no-block vaipakam-keeper.service');
  });

  it('keeps the build user out of what the keeper runs', () => {
    expect(read('vaipakam-keeper-update.service')).toContain('ReadWritePaths=/var/lib/vaipakam-build\n');
    expect(read('install.sh')).toContain('install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"');
  });

  it('never kills a keeper mid-pass, and reads settings only from the env file', () => {
    const unit = read('vaipakam-keeper.service');
    expect(unit).toContain('TimeoutStopSec=infinity');
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/env -i \/usr\/local\/bin\/node --env-file=%d\/keeper.env /m);
  });

  it('installs every unit in the kit', () => {
    const install = read('install.sh');
    for (const unit of [
      'vaipakam-keeper.service',
      'vaipakam-keeper-update.service',
      'vaipakam-keeper-update.timer',
      'vaipakam-keeper-promote.path',
      'vaipakam-keeper-promote.service',
      'promote.sh',
      'update.sh',
    ]) {
      expect(install, unit).toContain(unit);
    }
  });
});
