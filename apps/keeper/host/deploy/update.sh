#!/usr/bin/env bash
# Deploys main's tip to this machine, if it is not running yet. This
# machine never builds the keeper (#2651): CI builds it.
#
# Run as root by vaipakam-keeper-update.service, every five minutes from its
# timer, never two at once (a oneshot unit does not overlap itself). One run:
#
#   1. fetches main into root's own checkout, so no other account can
#      redirect where the code comes from;
#   2. stops if `current` is already that commit's release, or if the
#      source a build of that commit would be given is byte-identical to the
#      running release's (build-source.sh digest): it would be the same
#      bundle;
#   3. downloads the bundle CI published for that build source, with its
#      provenance attestation, from the `keeper-host` release
#      (.github/workflows/keeper-host-release.yml builds it from the paths
#      build-paths lists, the same export the digest is taken over). Until
#      CI has published it, the run says so once and stops;
#   4. verifies the attestation with `gh attestation verify`: it must be
#      signed for this repository's keeper-host-release workflow, run on
#      main, on a GitHub-hosted runner, over exactly these bytes. The commit
#      the certificate names as the build's source must be on main and give
#      the build the same source as the commit being deployed. Release assets
#      can be uploaded by more accounts than can merge to main; the
#      attestation is what makes a substituted bundle fail;
#   5. runs the bundle with --check, to prove it loads on this machine's
#      Node. Verification and the check each run in a throwaway sandbox: a
#      fresh dynamic user that cannot read the env file or write the
#      releases, and keeps nothing once it ends;
#   6. installs that same commit's systemd units and root-side scripts
#      (each only if it changed), so a bundle never runs under the units or
#      updater of another commit: a change that needs a new credential,
#      sandbox setting or ExecStart lands together with the code that needs
#      it;
#   7. copies the bundle into releases/<commit> and switches `current` to it
#      in one rename;
#   8. restarts a running keeper onto it gracefully, unless both the bundle
#      and the keeper's unit are unchanged, which needs no restart.
#
# Any failure exits non-zero before `current` moves, so the running keeper is
# untouched and the next run retries. A run interrupted after the switch, or
# whose restart could not be queued, leaves `restart-pending`, and the next
# run queues the restart.
#
# The kit and the release are bound by `kit-commit`, which names the commit
# whose units are installed and loaded. It is removed before a deploy touches
# the units and written again only once `current` is that commit's release,
# and the keeper unit refuses to start unless it matches current/SOURCE_COMMIT.
# So however a deploy is interrupted, the keeper never starts one commit's
# bundle under another commit's units; every run first puts back the kit of
# whatever `current` is, which also makes the keeper startable again. It does
# the same when the installed kit differs from that release's in any file, so
# a kit file an older updater did not know to install (vaipakam.slice, say)
# goes in at the next run rather than at the next deploy.
#
# `update.sh --kit-only [<commit>]` does only that last step, under the same
# lock, for the installer: it installs the kit of the running release, or of
# <commit> on a machine with no release yet.
#
# What this cannot protect against is stated in docs/ops/KeeperMachine.md
# §1: whoever can merge to main, or tamper with a dependency the CI build
# fetches, controls what runs, as with the Workers' auto-deploy.
set -euo pipefail

ROOT=/opt/vaipakam-keeper
REPO="$ROOT/repo"
# The one branch CI builds and attests, and so the one this machine follows.
BRANCH=main
# Where CI publishes the keeper's bundles, and the workflow whose attestation
# a bundle must carry (.github/workflows/keeper-host-release.yml).
RELEASE_TAG=keeper-host
RELEASE_WORKFLOW=.github/workflows/keeper-host-release.yml
KEEP_RELEASES=5

log() { echo "[keeper-update] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
umask 022

# One deploy lock, shared with install.sh, so a reinstall and a deploy never
# interleave their writes to the units, the scripts or `current`. The
# installer takes it itself and says so when it runs --kit-only.
if [ "${VAIPAKAM_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  exec 9>/run/vaipakam-keeper-deploy.lock
  flock 9
fi

KIT_COMMIT="$ROOT/kit-commit"
WORK=""
incoming=""
# A run that fails part-way leaves neither its scratch nor a half-written
# release behind (the glob that prunes releases skips dot-directories).
trap 'rm -rf ${WORK:+"$WORK"} ${incoming:+"$incoming"}' EXIT
WORK="$(mktemp -d)"

# Replace a file only when its content changed (a unit's mtime is what
# install.sh's restart check reads), and by rename, so the copy of this
# script bash is running stays intact.
place() { # place <source> <destination> <mode>
  if ! cmp -s "$1" "$2"; then
    install -m "$3" -o root -g root "$1" "$2.new"
    mv -Tf "$2.new" "$2"
    return 0
  fi
  return 1
}

# Extract <commit>'s kit and print where. Fails, changing nothing, if its
# update.sh does not parse: installed, it would fail every later run before
# it could fetch a fix, so the working one is kept instead.
extract_kit() {
  local dir="$WORK/kit-$1"
  mkdir -p "$dir"
  git -C "$REPO" archive "$1" apps/keeper/host/deploy | tar -x --no-same-owner -C "$dir"
  dir="$dir/apps/keeper/host/deploy"
  if ! bash -n "$dir/update.sh"; then
    echo "[keeper-update] $1's update.sh does not parse; not installing it" >&2
    return 1
  fi
  echo "$dir"
}
# The kit's systemd units. A kit from before vaipakam.slice existed has none,
# and installing that kit (a rollback) removes it; every other unit must be
# in every kit.
KIT_UNITS="vaipakam.slice vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer"
OPTIONAL_UNITS="vaipakam.slice"
# The units the keeper itself runs under: a change to either restarts it.
KEEPER_UNITS="vaipakam.slice vaipakam-keeper.service"
has_word() { [[ " $1 " == *" $2 "* ]]; }

# Install the units and update.sh of an extracted kit, then reload systemd.
# Sets keeper_unit_changed=yes when a unit the keeper runs under changed.
keeper_unit_changed=no
install_kit() {
  local dir="$1" unit changed
  for unit in $KIT_UNITS; do
    changed=no
    if [ ! -f "$dir/$unit" ] && has_word "$OPTIONAL_UNITS" "$unit"; then
      if [ -e "/etc/systemd/system/$unit" ]; then
        rm -f "/etc/systemd/system/$unit"
        changed=yes
      fi
    elif place "$dir/$unit" "/etc/systemd/system/$unit" 644; then
      changed=yes
    fi
    if [ "$changed" = yes ] && has_word "$KEEPER_UNITS" "$unit"; then
      keeper_unit_changed=yes
    fi
  done
  # Always: equal files do not prove systemd loaded them (a run interrupted
  # between placing a unit and reloading leaves exactly that), and the kit is
  # recorded as installed only after this.
  systemctl daemon-reload
  place "$dir/update.sh" "$ROOT/update.sh" 755 || true
  # Kits before CI built the keeper installed their own copy of
  # build-source.sh here. Each run now takes the deployed commit's own, so
  # the installed copy is removed rather than left to look as if it decided
  # anything.
  rm -f "$ROOT/build-source.sh"
}
# Whether every file of an extracted kit is the installed one, and nothing a
# kit may lack is installed without it.
kit_installed() {
  local dir="$1" unit
  for unit in $KIT_UNITS; do
    if [ -f "$dir/$unit" ]; then
      cmp -s "$dir/$unit" "/etc/systemd/system/$unit" || return 1
    elif [ -e "/etc/systemd/system/$unit" ]; then
      return 1
    fi
  done
  cmp -s "$dir/update.sh" "$ROOT/update.sh" || return 1
  [ ! -e "$ROOT/build-source.sh" ] || return 1
}
# Record that <commit>'s kit is installed and loaded.
record_kit() {
  echo "$1" > "$KIT_COMMIT.new"
  mv -Tf "$KIT_COMMIT.new" "$KIT_COMMIT"
}
running_commit() {
  local c
  c="$(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || true)"
  if [[ "$c" =~ ^[0-9a-f]{40}$ ]]; then echo "$c"; fi
}

# Written just before `current` moves to a release the keeper must restart
# onto, and removed once that restart is queued. So a run that was stopped,
# timed out, or could not queue the restart after switching leaves it behind,
# and the next run finishes the job instead of seeing its release in place
# and stopping with the old bundle still running.
PENDING="$ROOT/restart-pending"
queue_restart() {
  systemctl try-restart --no-block vaipakam-keeper.service
  rm -f "$PENDING"
}

if [ "${1:-}" = --kit-only ]; then
  commit="$(running_commit)"
  commit="${commit:-${2:-}}"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "--kit-only: no release and no commit given" >&2; exit 1; }
  kit_dir="$(extract_kit "$commit")"
  rm -f "$KIT_COMMIT"
  install_kit "$kit_dir"
  record_kit "$commit"
  # A running keeper is on its old unit until it restarts; install.sh's
  # restart check sees the changed unit and restarts it.
  exit 0
fi

# Put back the kit of the release in use, if an interrupted run left another
# one (or none) recorded, or if what is installed differs from that kit: an
# older updater installed this release without a file it did not know of.
# Until a recorded kit is put back, the keeper refuses to start.
# The comparison is best-effort: if the release's kit cannot be extracted
# (its commit no longer in the checkout, say), the run goes on as it would
# have without it. A recorded kit that is not the release's still has to be
# put back, and a failure to extract it then stops the run as always.
running="$(running_commit)"
reinstall=no
kit_dir=""
if [ -n "$running" ]; then
  if [ "$(cat "$KIT_COMMIT" 2>/dev/null || true)" != "$running" ]; then
    reinstall=yes
  elif kit_dir="$(extract_kit "$running")" && ! kit_installed "$kit_dir"; then
    reinstall=yes
  fi
fi
if [ "$reinstall" = yes ]; then
  log "installing the units of $running, which is the release in use"
  if [ -z "$kit_dir" ]; then kit_dir="$(extract_kit "$running")"; fi
  rm -f "$KIT_COMMIT"
  install_kit "$kit_dir"
  record_kit "$running"
  if [ "$keeper_unit_changed" = yes ]; then touch "$PENDING"; fi
fi

# Finish a restart an earlier run left pending, before anything that can
# fail (the fetch, a newer commit's download or verification), so a newer
# bundle that fails can never leave the keeper on one older than `current`.
if [ -e "$PENDING" ]; then
  log "restarting the keeper onto $(readlink "$ROOT/current"), which an earlier run switched to but did not restart"
  queue_restart
fi

git -C "$REPO" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
target="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
release="$ROOT/releases/$target"
if [ "$(readlink -f "$ROOT/current" 2>/dev/null || true)" = "$release" ]; then
  exit 0
fi
# `checked` remembers the last running/newer pair found to give the build the
# same source, so a branch that moves only elsewhere is compared, and logged,
# once per commit rather than every run.
pair="$running $target"
if [ -n "$running" ] && [ "$(cat "$ROOT/checked" 2>/dev/null || true)" = "$pair" ]; then
  exit 0
fi

# This commit's own kit: its units and updater go in with it below, and its
# build-source.sh names the bundle, so the digest is taken the way the CI
# build of this commit took it. Checked first, so a commit whose updater does
# not parse costs no download and changes nothing.
kit_dir="$(extract_kit "$target")"
if [ ! -f "$kit_dir/build-source.sh" ]; then
  echo "[keeper-update] $target's kit has no build-source.sh, so its bundle cannot be named" >&2
  exit 1
fi
digest_of() { bash "$kit_dir/build-source.sh" digest "$REPO" "$1" "$WORK/digest-$1"; }
target_digest="$(digest_of "$target")"
if ! [[ "$target_digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo "[keeper-update] could not take the digest of $target's build source" >&2
  exit 1
fi

# A commit whose build source is byte-identical to the running release's
# would get that release's bundle again. Most merges to main are such a
# commit, so the machine stays on the release it has. A running digest that
# cannot be taken means a deploy.
if [ -n "$running" ]; then
  running_digest="$(digest_of "$running" 2>/dev/null || true)"
  if [ "$running_digest" = "$target_digest" ]; then
    log "$target gives the build the same source as $running; staying on $running"
    echo "$pair" > "$ROOT/checked.new"
    mv -Tf "$ROOT/checked.new" "$ROOT/checked"
    exit 0
  fi
fi

# The bundle CI published for this build source, and its attestation. The
# repository is the one the code is fetched from.
origin="$(git -C "$REPO" remote get-url origin)"
if ! [[ "$origin" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then
  echo "[keeper-update] origin $origin is not a github.com repository; cannot find its keeper builds" >&2
  exit 1
fi
slug="${BASH_REMATCH[1]%.git}"
asset="keeper-host-$target_digest"
base="https://github.com/$slug/releases/download/$RELEASE_TAG"
tmp="$WORK/release"
mkdir -m 700 "$tmp"
# Prints the HTTP status, or 000 for a transfer that failed outright. Neither
# file is near 64 MiB (the bundle is about 12 MB), so nothing larger is taken.
download() { # download <asset file> <destination>
  curl -sSL --proto '=https' --proto-redir '=https' --max-time 300 --max-filesize 67108864 \
    -o "$2" -w '%{http_code}' "$base/$1" || true
}
# The attestation first: CI uploads the two together, and while the small
# one is missing there is no point fetching the large one.
attestation_status="$(download "$asset.sigstore.json" "$tmp/keeper-host.sigstore.json")"
bundle_status=""
if [ "$attestation_status" = 200 ]; then
  bundle_status="$(download "$asset.mjs" "$tmp/keeper-host.mjs")"
fi
if [ "$attestation_status" = 404 ] || [ "$bundle_status" = 404 ]; then
  # CI builds a commit after it lands on main, so for a few minutes after a
  # merge its bundle is not there yet. Said once per build source.
  if [ "$(cat "$ROOT/awaiting" 2>/dev/null || true)" != "$target_digest" ]; then
    log "waiting for CI to publish the keeper build of $target ($asset at $base); staying on ${running:-no release} until it does"
    echo "$target_digest" > "$ROOT/awaiting.new"
    mv -Tf "$ROOT/awaiting.new" "$ROOT/awaiting"
  fi
  exit 0
fi
if [ "$attestation_status" != 200 ] || [ "$bundle_status" != 200 ]; then
  echo "[keeper-update] could not download $asset from $base (HTTP status of the attestation: ${attestation_status:-none}, of the bundle: ${bundle_status:-not tried})" >&2
  exit 1
fi
if ! [ -x /usr/bin/gh ]; then
  echo "[keeper-update] the GitHub CLI (/usr/bin/gh) is not installed, so $asset cannot be verified; re-run install.sh (docs/ops/KeeperMachine.md §3)" >&2
  exit 1
fi
chmod 644 "$tmp/keeper-host.sigstore.json" "$tmp/keeper-host.mjs"

# Verification and the load check run in a throwaway sandbox each: a fresh
# dynamic user that can read only the files bound in for it, at the lowest
# priority so the keeper always comes first, the first to go if memory runs
# out, and gone, with everything it wrote, once it ends. `env -i`: the
# sandbox sees only the variables named, never anything the service manager
# would otherwise pass on. A fixed unit name each, so two cannot run at once,
# and PartOf stops either when the updater stops.
SANDBOX=(
  -p DynamicUser=yes
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes
  -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes
  -p ProtectControlGroups=yes -p RestrictNamespaces=yes -p LockPersonality=yes
  -p OOMScoreAdjust=500
  -p Nice=19 -p CPUWeight=1 -p IOWeight=1 -p IOSchedulingClass=idle
  -p PartOf=vaipakam-keeper-update.service
)

# Prints the commit the attestation's certificate names as the build's
# source. The certificate's fields come from GitHub's OIDC token for the run
# that signed it, so neither the workflow nor whoever uploaded the asset can
# set them. gh fetches Sigstore's trust root itself; with --bundle it needs no
# GitHub login.
built_from="$(systemd-run --quiet --wait --pipe --collect \
  --unit=vaipakam-keeper-verify \
  "${SANDBOX[@]}" \
  -p BindReadOnlyPaths="$tmp/keeper-host.mjs:/run/keeper-host.mjs $tmp/keeper-host.sigstore.json:/run/keeper-host.sigstore.json" \
  /usr/bin/env -i \
  HOME=/tmp \
  PATH=/usr/bin:/bin \
  GH_NO_UPDATE_NOTIFIER=1 \
  GH_PROMPT_DISABLED=1 \
  /usr/bin/gh attestation verify /run/keeper-host.mjs \
  --bundle /run/keeper-host.sigstore.json \
  --repo "$slug" \
  --signer-workflow "$slug/$RELEASE_WORKFLOW" \
  --source-ref "refs/heads/$BRANCH" \
  --deny-self-hosted-runners \
  --format json \
  --jq '.[].verificationResult.signature.certificate.sourceRepositoryDigest')" || {
  echo "[keeper-update] $asset from $base did not verify; not installing it" >&2
  exit 1
}
if ! [[ "$built_from" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[keeper-update] $asset's attestation names no single source commit (got: ${built_from:-nothing}); not installing it" >&2
  exit 1
fi
# The attestation proves CI built these bytes from $built_from. That commit
# must be on main as this machine fetched it, and must give the build the
# same source as the commit being deployed; usually it is that commit.
if ! git -C "$REPO" merge-base --is-ancestor "$built_from" "origin/$BRANCH" 2>/dev/null; then
  echo "[keeper-update] $asset was built from $built_from, which is not on $BRANCH as fetched; not installing it" >&2
  exit 1
fi
if [ "$built_from" != "$target" ] && [ "$(digest_of "$built_from" 2>/dev/null || true)" != "$target_digest" ]; then
  echo "[keeper-update] $asset was built from $built_from, whose build source differs from $target's; not installing it" >&2
  exit 1
fi

# The bundle must load on this machine's Node, with no settings and no
# network, before it can replace the running one.
systemd-run --quiet --wait --pipe --collect \
  --unit=vaipakam-keeper-check \
  "${SANDBOX[@]}" \
  -p PrivateNetwork=yes \
  -p BindReadOnlyPaths="$tmp/keeper-host.mjs:/run/keeper-host.mjs" \
  /usr/bin/env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node /run/keeper-host.mjs --check || {
  echo "[keeper-update] $asset does not load on this machine (keeper-host.mjs --check failed); not installing it" >&2
  exit 1
}
log "verified $asset: built by $RELEASE_WORKFLOW on $BRANCH from $built_from"
built="$tmp/keeper-host.mjs"

incoming="$(mktemp -d "$ROOT/releases/.incoming.XXXXXX")"
install -m 644 -o root -g root "$built" "$incoming/keeper-host.mjs"
echo "$target" > "$incoming/SOURCE_COMMIT"
# The commit CI built the bundle from; the same build source as $target.
echo "$built_from" > "$incoming/BUILT_FROM"
chmod 755 "$incoming"
restart=yes
if [ -f "$ROOT/current/keeper-host.mjs" ] && cmp -s "$incoming/keeper-host.mjs" "$ROOT/current/keeper-host.mjs"; then
  restart=no
fi

# This commit's kit goes in only now, after its bundle verified and loaded.
# From removing kit-commit until it names this commit again, the keeper
# refuses to start.
rm -f "$KIT_COMMIT"
install_kit "$kit_dir"
# The keeper's own unit changed: it must restart onto it even when its bundle
# did not.
if [ "$keeper_unit_changed" = yes ]; then restart=yes; fi
rm -rf "$release"
mv -T "$incoming" "$release"
incoming=""
if [ "$restart" = yes ]; then touch "$PENDING"; fi
ln -sfn "$release" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
record_kit "$target"
rm -f "$ROOT/awaiting"
if [ "$restart" = yes ]; then
  log "deployed $target; a running keeper restarts onto it after its current tick"
  queue_restart
else
  log "deployed $target; the keeper is byte-identical to the running one, so no restart"
fi

# Keep the last few releases for a manual rollback, never the one in use.
# Release names are commit hashes, so `ls` is safe here.
in_use="$(readlink -f "$ROOT/current")"
# shellcheck disable=SC2012
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r dir; do
  dir="${dir%/}"
  [ "$dir" = "$in_use" ] || rm -rf "$dir"
done
