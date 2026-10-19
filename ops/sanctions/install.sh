#!/usr/bin/env bash
# Installs, or moves to a new commit, the two sanctions services on an
# always-on Ubuntu machine (ops/sanctions/README.md): the ADDER, which lists
# OFAC's new designations, and the DELISTER, which proposes OFAC's delistings
# to the timelock. Both run from ONE release of the named commit, so they
# always read a publication with the same parser.
#
#   C=<full commit sha on main>
#   curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/ops/sanctions/install.sh"
#   sudo bash install.sh "$C"
#
# Download first and run second, so a transfer cut short can never run half a
# script; the body is one function called on the last line for the same
# reason.
#
# A deploy is a DELIBERATE act, never a merge: both services sign compliance
# transactions, so the code they run is the commit an operator named, and that
# commit must be on main (reviewed). Nothing here follows a branch.
#
# Safe to run again. It creates each service's env file from its template only
# when the file does not exist, never overwrites one, and never ENABLES or
# STARTS a timer: enabling one is that service's cutover in the README, done
# once its env file is filled in and its key appointed on each chain.
#
# Needs systemd 247+ (LoadCredential=) and Node 22.18+ at /usr/local/bin/node.
# On the keeper machine the keeper's own install provides that Node.
set -euo pipefail

main() {
  local commit="${1:-}"
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local ROOT=/opt/vaipakam-sanctions
  # The adder's release root before the delister joined it (#2557). Its units
  # are replaced below, so nothing runs from it afterwards.
  local OLD_ROOT=/opt/vaipakam-sanctions-adder
  local SERVICES=(adder delister)

  log() { echo "[sanctions-install] $*"; }
  die() { echo "[sanctions-install] $*" >&2; exit 1; }
  umask 022

  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "usage: sudo bash install.sh <full 40-character commit sha on main>"
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
  local systemd_version
  systemd_version="$(systemctl --version | awk 'NR==1 { print $2 }')"
  [ "${systemd_version%%.*}" -ge 247 ] 2>/dev/null || die "systemd ${systemd_version:-unknown} is too old: 247 or newer is needed"
  [ -x /usr/local/bin/node ] || die "no Node at /usr/local/bin/node: install Node 22 first (the keeper's install.sh does)"
  local node_major
  node_major="$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] 2>/dev/null || die "Node $node_major at /usr/local/bin/node: 22 or newer is needed"
  # The scripts ask Node whether they were started directly (import.meta.main,
  # packages/contracts/scripts/entry-point.mjs), which Node sets from 22.18.
  /usr/local/bin/node --input-type=module -e 'process.exit(import.meta.main === true ? 0 : 1)' \
    || die "Node $(/usr/local/bin/node -v) at /usr/local/bin/node does not set import.meta.main: 22.18 or newer is needed"

  # One install at a time, for the whole run: two at once could repoint the
  # candidate link between one run's two checks, or race each other's build,
  # switch and pruning. The lock goes when this process exits.
  exec 9>/run/vaipakam-sanctions-deploy.lock
  flock -n 9 || { log "waiting for another sanctions install to finish"; flock 9; }

  export DEBIAN_FRONTEND=noninteractive
  command -v git >/dev/null || { apt-get update -q >/dev/null; apt-get install -y -q git ca-certificates >/dev/null; }

  mkdir -p "$ROOT/releases"
  chmod 755 "$ROOT" "$ROOT/releases"

  # The source, root-owned. Fetched fresh from main every run.
  if [ ! -d "$ROOT/repo/.git" ]; then
    log "cloning $REPO_URL"
    rm -rf "$ROOT/repo"
    git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$ROOT/repo"
  fi
  git -C "$ROOT/repo" remote set-url origin "$REPO_URL"
  git -C "$ROOT/repo" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"
  git -C "$ROOT/repo" cat-file -e "${commit}^{commit}" 2>/dev/null || die "commit $commit is not in $REPO_URL"
  git -C "$ROOT/repo" merge-base --is-ancestor "$commit" origin/main || die "commit $commit is not on main: only reviewed code is deployed"
  # This installer serves both services; a commit from before they shared one
  # kit has no delister and its own adder-only installer.
  git -C "$ROOT/repo" cat-file -e "${commit}:ops/sanctions/install.sh" 2>/dev/null \
    || die "commit $commit predates the combined sanctions kit: install it with that commit's ops/sanctions-adder/install.sh, after disabling vaipakam-sanctions-delister.timer"
  # Moving off the adder-only layout deletes the release a running adder is
  # executing from; wait for its run to end rather than cut it short.
  if [ -d "$OLD_ROOT" ] && systemctl is-active --quiet vaipakam-sanctions-adder.service; then
    die "the adder is mid-run from $OLD_ROOT; re-run once 'systemctl is-active vaipakam-sanctions-adder.service' reports inactive"
  fi

  local rel="$ROOT/releases/$commit"
  local s
  if [ ! -f "$rel/.complete" ]; then
    log "building release $commit"
    rm -rf "$rel"
    local build
    build="$(mktemp -d "$ROOT/releases/.build.XXXXXX")"
    # Only what the services run: the contracts package (their scripts,
    # compiled ABIs and fixtures), the workspace manifests pnpm needs to honour
    # the lockfile, and this kit for the units.
    git -C "$ROOT/repo" archive "$commit" package.json pnpm-lock.yaml pnpm-workspace.yaml packages/contracts ops/sanctions \
      | tar -x --no-same-owner -C "$build"
    # Dependencies exactly as the lockfile pins them, checked against its
    # hashes. --ignore-scripts: nothing a package ships runs during install.
    # Corepack's pnpm and pnpm's store live in the build directory and are
    # removed with it.
    (
      cd "$build"
      HOME="$build/.home" COREPACK_HOME="$build/.corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
        /usr/local/bin/corepack pnpm install --frozen-lockfile --ignore-scripts --filter '@vaipakam/contracts' \
        --store-dir "$build/.store" >/dev/null
    )
    rm -rf "$build/.home" "$build/.corepack"
    echo "$commit" > "$build/SOURCE_COMMIT"
    chown -R root:root "$build"
    chmod -R go-w "$build"
    touch "$build/.complete"
    mv -T "$build" "$rel"
  fi

  # The services run as a dynamic user, which must be able to enter the
  # release. Opened on every run, not only at build: mktemp makes the
  # directory 0700, and a release an earlier installer built is still 0700.
  chmod 755 "$rel"
  # Each service's check runs on every run, a rollback included, against the
  # release about to become current, and the way its unit runs that service:
  # as a throwaway dynamic user, with an empty environment, through a link to
  # the release (the units start through `current`). A release that user
  # cannot read, or a script that does not run when started through a link,
  # fails here and never becomes current. The check must also print its
  # "release ok" line, since a script that never reached its main prints
  # nothing and still exits 0. No network: the check needs none.
  ln -sfnT "$rel" "$ROOT/.candidate"
  local out
  for s in "${SERVICES[@]}"; do
    out="$(systemd-run --quiet --wait --pipe --collect \
      --unit="vaipakam-sanctions-check-$s" \
      -p DynamicUser=yes \
      -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
      -p PrivateNetwork=yes -p NoNewPrivileges=yes \
      /usr/bin/env -i /usr/local/bin/node --max-old-space-size=192 \
      "$ROOT/.candidate/packages/contracts/scripts/sanctions-$s.mjs" --check)" \
      || die "the $s check failed on release $commit; current is unchanged"
    grep -q "^sanctions-$s: release ok " <<<"$out" \
      || die "the $s check printed no 'release ok' line on release $commit, so the script did not run (a commit from before #2586 never runs through a link); current is unchanged"
    log "$out"
  done
  rm -f "$ROOT/.candidate"

  # The release in use before this run is kept beside the new one, so
  # re-running with its commit is a rollback that needs no rebuild.
  local previous
  previous="$(basename "$(readlink "$ROOT/current" 2>/dev/null || true)")"

  # Units from the release itself, so they always match the code they run.
  for s in "${SERVICES[@]}"; do
    install -m 644 "$rel/ops/sanctions/vaipakam-sanctions-$s.service" /etc/systemd/system/
    install -m 644 "$rel/ops/sanctions/vaipakam-sanctions-$s.timer" /etc/systemd/system/
  done
  ln -sfn "$rel" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
  systemctl daemon-reload
  if [ -d "$OLD_ROOT" ]; then
    rm -rf "$OLD_ROOT"
    log "removed the adder-only layout at $OLD_ROOT; both services now run from $ROOT/current"
  fi

  # Keep the release now in use and the one it replaced; nothing else.
  local r
  for r in "$ROOT"/releases/*; do
    r="$(basename "$r")"
    [[ "$r" =~ ^[0-9a-f]{40}$ ]] || continue
    [ "$r" = "$commit" ] || [ "$r" = "$previous" ] || rm -rf "${ROOT:?}/releases/$r"
  done
  rm -rf "$ROOT"/releases/.build.*
  rm -f "$ROOT/.candidate"

  # The settings: ONE file per service for every chain, beside the keeper's
  # keeper.env and held the same way (/etc/vaipakam root-only at 750, each
  # file 0600). Each service's unit hands its own file to that service alone.
  [ -L /etc/vaipakam ] && die "/etc/vaipakam must not be a link; fix it by hand and re-run"
  install -d -o root -g root -m 750 /etc/vaipakam
  local env_file
  for s in "${SERVICES[@]}"; do
    env_file="/etc/vaipakam/sanctions-$s.env"
    [ -L "$env_file" ] && die "$env_file must not be a link; fix it by hand and re-run"
    if [ ! -e "$env_file" ]; then
      install -m 600 -o root -g root "$rel/ops/sanctions/sanctions-$s.env.example" "$env_file"
      log "created $env_file from the template; fill it in before that service's cutover"
    fi
    [ -f "$env_file" ] || die "$env_file must be a regular file; fix it by hand and re-run"
    # Enforced on every run, not only at creation: a file made earlier by
    # hand keeps its contents but not looser access. A fresh root-owned copy
    # replaces it, so a descriptor someone held on the old inode reaches
    # nothing new.
    install -m 600 -o root -g root "$env_file" "/etc/vaipakam/.sanctions-$s.env.new"
    mv -Tf "/etc/vaipakam/.sanctions-$s.env.new" "$env_file"
  done

  log "release $commit is current."
  log "each service once (see README §3):"
  for s in "${SERVICES[@]}"; do
    log "  sudoedit /etc/vaipakam/sanctions-$s.env"
    log "  systemctl start vaipakam-sanctions-$s.service   # one run now"
    log "  systemctl enable --now vaipakam-sanctions-$s.timer"
  done
}

main "$@"
