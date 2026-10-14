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

  it('starts the file update.sh installs, built from the file build:host writes', () => {
    expect(pkg.scripts['build:host']).toContain('--outfile=dist/keeper-host.mjs');
    const build = read('build.sh');
    expect(build).toContain('apps/keeper/dist/keeper-host.mjs --check');
    expect(build).toContain('install -m 644 apps/keeper/dist/keeper-host.mjs "$out_dir/keeper-host.mjs"');
    const update = read('update.sh');
    expect(update).toContain('-p BindPaths="$tmp/out:/run/keeper-out"');
    expect(update).toContain('/bin/bash /run/keeper-build.sh /run/keeper-src.tar /run/keeper-out');
    expect(update).toContain('built="$tmp/out/keeper-host.mjs"');
    expect(update).toContain('"$incoming/keeper-host.mjs"');
    expect(update).toContain('mv -Tf "$ROOT/current.next" "$ROOT/current"');
    // A switch whose restart did not get queued is finished by the next run.
    expect(update).toContain('if [ "$restart" = yes ]; then touch "$PENDING"; fi');
    expect(update).toContain('rm -f "$PENDING"');
    expect(read('vaipakam-keeper.service')).toContain('/opt/vaipakam-keeper/current/keeper-host.mjs');
  });

  it('builds the deployed commit\'s own export in a throwaway sandbox, then restarts only a running keeper', () => {
    const update = read('update.sh');
    expect(update).toContain('git -C "$REPO" archive --format=tar -o "$tmp/src.tar" "$target"');
    expect(update).toContain('-p DynamicUser=yes');
    // Ephemeral: no cache survives a build, so no build can plant tooling.
    expect(update).not.toContain('CacheDirectory');
    expect(update).toContain('-p PrivateTmp=yes');
    // The build sees only the variables update.sh names.
    expect(update).toMatch(/-p Nice=10 \\\n  \/usr\/bin\/env -i \\$/m);
    // One fixed name, so two builds cannot run at once.
    expect(update).toMatch(/--unit=vaipakam-keeper-build \\$/m);
    expect(update).toContain('-p ProtectSystem=strict');
    expect(update).toContain('release="$ROOT/releases/$target"');
    expect(update).toContain('systemctl try-restart --no-block vaipakam-keeper.service');
    expect(read('vaipakam-keeper-update.service')).toContain('ExecStart=/opt/vaipakam-keeper/update.sh');
  });

  it('keeps what the keeper runs root-owned, and never starts the keeper from the install', () => {
    const install = read('install.sh');
    expect(install).toContain('install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"');
    // A reinstall never resumes paused deploys: only a first install enables the timer.
    expect(install).toMatch(/if \[ "\$first_install" = yes \]; then\n\s+systemctl enable --quiet --now vaipakam-keeper-update\.timer/);
    expect(install).not.toMatch(/enable[^\n]*vaipakam-keeper\.service/);
    expect(install).not.toMatch(/systemctl (start|restart)[^\n]*vaipakam-keeper\.service/);
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
      'build.sh',
      'update.sh',
    ]) {
      expect(install, unit).toContain(unit);
    }
  });
});
