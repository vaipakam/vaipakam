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
const RELEASE_WORKFLOW = '.github/workflows/keeper-host-release.yml';
const workflow = () => readFileSync(join(keeperDir, '..', '..', RELEASE_WORKFLOW), 'utf8');
/** The text of one job of the release workflow, from its key to the next job's. */
function workflowJob(name: string): string {
  const text = workflow();
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

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
    for (const flag of ['GRACE_DEFAULT_ENABLED', 'REWARD_REMIT_ENABLED', 'REWARD_COMMIT_ENABLED', 'REWARD_DELIVERY_PROOF_ENABLED', 'REWARD_SANCTIONS_KEEPER_ENABLED', 'REWARD_HORIZON_HEARTBEAT_ENABLED', 'REWARD_ENTRY_SETTLE_ENABLED', 'REWARD_DAY_CLOSE_ENABLED', 'REWARD_CLOSE_OUT_ENABLED', 'REWARD_ZEROED_DAY_ENABLED', 'REWARD_RETURN_TRANSPORT_ENABLED', 'PROTOCOL_UPKEEP_ENABLED', 'PREPAY_AUTO_LIST_ENABLED', 'PREPAY_SALE_SANCTIONS_SYNC_ENABLED', 'DISCOUNT_PATH_CHAIN_IDS']) {
      expect(values[flag]).toBe('');
    }
    for (const key of [...SECRET_BINDING_KEYS, HOST_SETTINGS.apiToken, HOST_SETTINGS.accountId, 'TG_OPS_BOT_TOKEN']) {
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

  it('starts the file update.sh installs, which CI built from the file build:host writes', () => {
    expect(pkg.scripts['build:host']).toContain('--outfile=dist/keeper-host.mjs');
    const build = read('build.sh');
    expect(build).toContain('node apps/keeper/dist/keeper-host.mjs --check');
    expect(build).toContain('install -m 644 apps/keeper/dist/keeper-host.mjs "$out_dir/keeper-host.mjs"');
    const ci = workflowJob('build');
    expect(ci).toContain('bash apps/keeper/host/deploy/build.sh "$RUNNER_TEMP/src.tar" "$RUNNER_TEMP/out"');
    expect(ci).toContain('path: ${{ runner.temp }}/out/keeper-host.mjs');
    const update = read('update.sh');
    expect(update).toContain('bundle_status="$(download "$asset.mjs" "$tmp/keeper-host.mjs")"');
    expect(update).toContain('built="$tmp/keeper-host.mjs"');
    expect(update).toContain('"$incoming/keeper-host.mjs"');
    expect(update).toContain('mv -Tf "$ROOT/current.next" "$ROOT/current"');
    // A switch whose restart did not get queued is finished by the next run.
    expect(update).toContain('if [ "$restart" = yes ]; then touch "$PENDING"; fi');
    expect(update).toContain('rm -f "$PENDING"');
    expect(read('vaipakam-keeper.service')).toContain('/opt/vaipakam-keeper/current/keeper-host.mjs');
  });

  it('never builds: it verifies and load-checks a downloaded bundle in throwaway sandboxes, then restarts only a running keeper', () => {
    const update = read('update.sh');
    for (const builder of ['build.sh', 'pnpm', 'corepack', 'git -C "$REPO" archive --format=tar']) {
      expect(update, builder).not.toContain(builder);
    }
    expect(update).not.toMatch(/--unit=vaipakam-keeper-build\b/);
    // Both steps share one sandbox: a fresh dynamic user, ephemeral, with
    // only the variables update.sh names.
    expect(update).toContain('-p DynamicUser=yes');
    expect(update).not.toContain('CacheDirectory');
    expect(update).toContain('-p PrivateTmp=yes');
    expect(update).toContain('-p ProtectSystem=strict');
    expect(update.match(/"\$\{SANDBOX\[@\]\}"/g)?.length).toBe(2);
    expect(update.match(/  \/usr\/bin\/env -i \\$/gm)?.length).toBe(2);
    // One fixed name each, so two cannot run at once.
    expect(update).toMatch(/--unit=vaipakam-keeper-verify \\$/m);
    expect(update).toMatch(/--unit=vaipakam-keeper-check \\$/m);
    // The load check gets no network.
    const check = update.slice(update.indexOf('--unit=vaipakam-keeper-check'));
    expect(check.slice(0, check.indexOf('--check'))).toContain('-p PrivateNetwork=yes');
    expect(update).toContain('release="$ROOT/releases/$target"');
    expect(update).toContain('systemctl try-restart --no-block vaipakam-keeper.service');
    expect(read('vaipakam-keeper-update.service')).toContain('ExecStart=/opt/vaipakam-keeper/update.sh');
  });

  it('installs a bundle only once its attestation proves CI built it from main, from the same build source (#2651)', () => {
    const update = read('update.sh');
    expect(update).toMatch(/^BRANCH=main$/m);
    expect(update).toContain(`RELEASE_WORKFLOW=${RELEASE_WORKFLOW}`);
    expect(update).toContain('asset="keeper-host-$target_digest"');
    expect(update).toContain('base="https://github.com/$slug/releases/download/$RELEASE_TAG"');
    for (const flag of [
      '--bundle /run/keeper-host.sigstore.json',
      '--repo "$slug"',
      '--signer-workflow "$slug/$RELEASE_WORKFLOW"',
      '--source-ref "refs/heads/$BRANCH"',
      '--deny-self-hosted-runners',
      "--jq '.[].verificationResult.signature.certificate.sourceRepositoryDigest'",
    ]) {
      expect(update, flag).toContain(flag);
    }
    // The certificate's source commit must be one commit, on main, giving
    // the build the same source as the commit deployed.
    expect(update).toContain('if ! [[ "$built_from" =~ ^[0-9a-f]{40}$ ]]; then');
    expect(update).toContain('git -C "$REPO" merge-base --is-ancestor "$built_from" "origin/$BRANCH"');
    expect(update).toContain('if [ "$built_from" != "$target" ] && [ "$(digest_of "$built_from" 2>/dev/null || true)" != "$target_digest" ]; then');
    expect(update).toContain('echo "$built_from" > "$incoming/BUILT_FROM"');
    // Verified, then checked, then installed: nothing moves before both pass.
    const verify = update.indexOf('/usr/bin/gh attestation verify');
    const ancestry = update.indexOf('merge-base --is-ancestor');
    const loads = update.indexOf('--unit=vaipakam-keeper-check');
    const incoming = update.indexOf('incoming="$(mktemp -d');
    expect(verify).toBeGreaterThan(update.indexOf('bundle_status="$(download'));
    expect(ancestry).toBeGreaterThan(verify);
    expect(loads).toBeGreaterThan(ancestry);
    expect(incoming).toBeGreaterThan(loads);
    // A bundle CI has not published yet is waited for, said once, not failed on.
    expect(update).toContain('if [ "$attestation_status" = 404 ] || [ "$bundle_status" = 404 ]; then');
    expect(update).toContain('rm -f "$ROOT/awaiting"');
  });

  it('runs the updater behind the keeper, and deploys only a commit whose build source changed (#2651)', () => {
    const unit = read('vaipakam-keeper-update.service');
    for (const line of ['Nice=19', 'CPUWeight=1', 'IOWeight=1', 'IOSchedulingClass=idle']) {
      expect(unit).toMatch(new RegExp(`^${line}$`, 'm'));
    }
    const update = read('update.sh');
    // The digests are taken with the deployed commit's own build-source.sh,
    // the script CI named its bundle with; no installed copy decides it.
    expect(update).toContain('digest_of() { bash "$kit_dir/build-source.sh" digest "$REPO" "$1" "$WORK/digest-$1"; }');
    expect(update).toContain('target_digest="$(digest_of "$target")"');
    expect(update).toContain('running_digest="$(digest_of "$running" 2>/dev/null || true)"');
    expect(update).toContain('if [ "$running_digest" = "$target_digest" ]; then');
    expect(update).toContain('rm -f "$ROOT/build-source.sh"');
    // The comparison runs after the fetch and before any download.
    const digest = update.indexOf('target_digest="$(digest_of');
    expect(digest).toBeGreaterThan(update.indexOf('git -C "$REPO" fetch'));
    expect(update.indexOf('if [ "$running_digest" = "$target_digest" ]')).toBeLessThan(update.indexOf('download "$asset'));
  });

  it('protects the keeper\'s memory in a slice of its own, and has the OOM killer take a build first (#2651)', () => {
    const memoryLow = (text: string) => text.match(/^MemoryLow=(\S+)$/m)?.[1];
    const slice = read('vaipakam.slice');
    const unit = read('vaipakam-keeper.service');
    // Protection holds only as far as the parent grants it, so the slice and
    // the keeper carry the same figure, and the slice is top-level (no dash).
    expect(memoryLow(slice)).toMatch(/^\d+M$/);
    expect(memoryLow(unit)).toBe(memoryLow(slice));
    expect(unit).toMatch(/^Slice=vaipakam\.slice$/m);
    expect(unit).toMatch(/^OOMScoreAdjust=-\d+$/m);
    const update = read('update.sh');
    expect(update).toMatch(/^  -p OOMScoreAdjust=500\n  -p Nice=19 -p CPUWeight=1 -p IOWeight=1 -p IOSchedulingClass=idle$/m);
    // The slice is a kit unit that restarts the keeper when it changes, and
    // the only one an older kit may lack (installing that kit removes it).
    expect(update).toContain('KIT_UNITS="vaipakam.slice vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer"');
    expect(update).toContain('OPTIONAL_UNITS="vaipakam.slice"');
    expect(update).toContain('KEEPER_UNITS="vaipakam.slice vaipakam-keeper.service"');
  });

  it('puts back the running release\'s kit whenever what is installed differs from it', () => {
    const update = read('update.sh');
    // A kit file an older updater did not install goes in at the next run,
    // not at the next build.
    expect(update).toContain('elif kit_dir="$(extract_kit "$running")" && ! kit_installed "$kit_dir"; then');
    expect(update.indexOf('! kit_installed')).toBeLessThan(update.indexOf('if [ "$reinstall" = yes ]; then'));
    expect(update.indexOf('if [ "$reinstall" = yes ]; then')).toBeLessThan(update.indexOf('git -C "$REPO" fetch'));
    for (const file of ['"$ROOT/update.sh"', '"$ROOT/build-source.sh"', '"/etc/systemd/system/$unit"']) {
      expect(update.slice(update.indexOf('kit_installed() {'), update.indexOf('record_kit() {')), file).toContain(file);
    }
  });

  it('keeps what the keeper runs root-owned, and never starts the keeper from the install', () => {
    const install = read('install.sh');
    expect(install).toContain('install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"');
    // A reinstall never resumes paused deploys: only the install that first completes enables the timer.
    expect(install).toMatch(/if \[ ! -e "\$ROOT\/\.installed" \]; then\n\s+systemctl enable --quiet --now vaipakam-keeper-update\.timer/);
    expect(install).toContain('touch "$ROOT/.installed"');
    expect(install).not.toMatch(/enable[^\n]*vaipakam-keeper\.service/);
    expect(install).not.toMatch(/systemctl (start|restart)[^\n]*vaipakam-keeper\.service/);
  });

  it('never kills a keeper mid-pass, and reads settings only from the env file', () => {
    const unit = read('vaipakam-keeper.service');
    expect(unit).toContain('TimeoutStopSec=infinity');
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/env -i \/usr\/local\/bin\/node --env-file=%d\/keeper.env /m);
  });

  it('reinstalls the kit of the running commit, under the deploy lock, through the updater', () => {
    const install = read('install.sh');
    // A reinstall takes the kit of the commit that is running, not the branch tip.
    expect(install).toContain('kit_commit="$(cat "$ROOT/current/SOURCE_COMMIT"');
    expect(install).toContain('VAIPAKAM_DEPLOY_LOCK_HELD=1 "$ROOT/update.sh" --kit-only "$kit_commit"');
    // The lock is taken before the trust rule and released before a deploy starts.
    const lock = install.indexOf('flock 9');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(install.indexOf('rm -rf "$ROOT"'));
    expect(install.indexOf('exec 9>&-')).toBeLessThan(install.indexOf('systemctl start vaipakam-keeper-update.service'));
    // One trust rule for each tree it runs code from, and a fresh inode for the env file.
    expect(install).toContain('rm -rf "$ROOT"');
    expect(install).toContain('rm -rf "$NODE_HOME"');
    expect(install.indexOf('rm -rf "$NODE_HOME"')).toBeLessThan(install.indexOf('"$NODE_HOME/current/bin/node" -v'));
    expect(install).toContain('umask 022');
    expect(install).toContain('mv -Tf /etc/vaipakam/.keeper.env.new /etc/vaipakam/keeper.env');
  });

  it('deploys each commit with its own build.sh, units and updater, and binds them with kit-commit', () => {
    const update = read('update.sh');
    expect(update).toContain('exec 9>/run/vaipakam-keeper-deploy.lock');
    expect(update).toContain('git -C "$REPO" archive "$1" apps/keeper/host/deploy');
    expect(update).not.toContain('$ROOT/build.sh');
    for (const unit of ['vaipakam.slice', 'vaipakam-keeper.service', 'vaipakam-keeper-update.service', 'vaipakam-keeper-update.timer']) {
      expect(update, unit).toContain(unit);
    }
    expect(update).toContain('place "$dir/$unit" "/etc/systemd/system/$unit" 644');
    expect(update).toContain('place "$dir/update.sh" "$ROOT/update.sh" 755');
    // A changed keeper unit restarts the keeper even when the bundle is identical.
    expect(update).toContain('if [ "$keeper_unit_changed" = yes ]; then restart=yes; fi');
    // The kit goes in after the build succeeds; kit-commit is cleared first and
    // written only once `current` names the same commit.
    const built = update.indexOf('built="$tmp/keeper-host.mjs"');
    const clear = update.indexOf('# refuses to start.\nrm -f "$KIT_COMMIT"\ninstall_kit "$kit_dir"');
    expect(update.indexOf('kit_dir="$(extract_kit "$target")"')).toBeLessThan(update.indexOf('systemd-run'));
    expect(clear).toBeGreaterThan(-1);
    // A kit whose updater does not parse is refused before anything changes.
    expect(update).toContain('if ! bash -n "$dir/update.sh"; then');
    // systemd is reloaded on every kit install, changed or not, before it is recorded.
    expect(update).toMatch(/  done\n(  #.*\n)*  systemctl daemon-reload\n  place "\$dir\/update\.sh"/);
    const swap = update.indexOf('mv -Tf "$ROOT/current.next" "$ROOT/current"');
    const record = update.indexOf('record_kit "$target"');
    expect(clear).toBeGreaterThan(built);
    expect(swap).toBeGreaterThan(clear);
    expect(record).toBeGreaterThan(swap);
    // Every run first puts back the running release's kit if another is recorded.
    expect(update.indexOf('install_kit "$kit_dir"')).toBeLessThan(update.indexOf('git -C "$REPO" fetch'));
    // The keeper refuses to start unless the loaded kit is the release's.
    expect(read('vaipakam-keeper.service')).toContain(
      'ExecStartPre=/usr/bin/cmp /opt/vaipakam-keeper/kit-commit /opt/vaipakam-keeper/current/SOURCE_COMMIT',
    );
  });
});

describe('the CI build the machine installs (#2651)', () => {
  it('names each bundle by the digest the machine asks for, in the release it downloads from', () => {
    const text = workflow();
    const update = read('update.sh');
    expect(text).toMatch(/^  RELEASE_TAG: keeper-host$/m);
    expect(update).toMatch(/^RELEASE_TAG=keeper-host$/m);
    expect(text).toContain('digest="$(bash apps/keeper/host/deploy/build-source.sh digest . "$GITHUB_SHA" "$RUNNER_TEMP/digest")"');
    // The build is given exactly the export that digest was taken over.
    expect(text).toContain('bash apps/keeper/host/deploy/build-source.sh export . "$GITHUB_SHA" "$RUNNER_TEMP/src.tar"');
    for (const name of ['keeper-host-$DIGEST.mjs', 'keeper-host-$DIGEST.sigstore.json']) {
      expect(text, name).toContain(name);
    }
    expect(update).toContain('download "$asset.mjs"');
    expect(update).toContain('download "$asset.sigstore.json"');
  });

  it('builds main only, which is the one ref the machine accepts', () => {
    const text = workflow();
    expect(text).toMatch(/^  push:\n    branches: \[main\]$/m);
    expect(workflowJob('build')).toContain("if: github.ref == 'refs/heads/main'");
    expect(read('update.sh')).toContain('--source-ref "refs/heads/$BRANCH"');
    const install = read('install.sh');
    expect(install).toContain('local BRANCH=main');
    expect(install).not.toContain('deploy-branch.new');
  });

  it('keeps credentials away from the job that runs install scripts, and signs in a job that runs no repository code', () => {
    const text = workflow();
    expect(text).toMatch(/^permissions:\n  contents: read$/m);
    const build = workflowJob('build');
    expect(build).not.toContain('permissions:');
    expect(build).toContain('persist-credentials: false');
    // The build sees only the variables named, so no token or OIDC request URL.
    expect(build).toMatch(/env -i \\\n\s+HOME="\$RUNNER_TEMP\/home"/);
    const publish = workflowJob('publish');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('attestations: write');
    expect(publish).toContain('contents: write');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).toMatch(/uses: actions\/attest@[0-9a-f]{40} # v/);
    expect(publish).toContain("if: needs.build.outputs.published == 'no'");
  });

  it('pins every action it uses to a full commit', () => {
    const uses = [...workflow().matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
  });

  it('installs the verifier from GitHub\'s apt repository, with its keyring pinned', () => {
    const install = read('install.sh');
    expect(install).toMatch(/local GH_KEYRING_SHA256=[0-9a-f]{64}$/m);
    expect(install).toContain('echo "$GH_KEYRING_SHA256  $tmp/githubcli.gpg" | sha256sum -c --quiet -');
    expect(install).toContain('signed-by=$gh_keyring] https://cli.github.com/packages stable main');
    expect(install).toContain('apt-get install -y -q gh');
    // The keyring is checked before apt is told to trust it.
    expect(install.indexOf('sha256sum -c --quiet - >/dev/null')).toBeLessThan(install.indexOf('install -m 644 -o root -g root "$tmp/githubcli.gpg"'));
    expect(read('update.sh')).toContain('/usr/bin/gh attestation verify');
  });
});
