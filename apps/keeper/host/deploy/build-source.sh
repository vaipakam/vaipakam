#!/usr/bin/env bash
# The source a keeper build is given, and a digest of it (#2651).
#
#   build-source.sh export <repo> <commit> <tar file>
#     Writes the build's source: the paths that <commit>'s own build-paths
#     lists, exported with `git archive`. Exits 3 without writing anything
#     when <commit> has no build-paths (it predates #2651); update.sh then
#     exports the whole tree, as it always did.
#
#   build-source.sh digest <repo> <commit> <scratch directory>
#     Prints one SHA-256 over exactly what `export` gives the build: every
#     path, its type and mode, and its bytes after git's own conversions
#     (line endings, export-subst, ident). The archive's timestamps and the
#     commit id it carries are left out; the build reads neither. So are
#     the owner and the permission bits beyond git's own executable bit,
#     so the digest is the same whichever account takes it. Two commits
#     with the same digest hand the build the same files, so their bundles
#     are the same, byte for byte.
#
# CI (.github/workflows/keeper-host-release.yml) builds the export and
# publishes the bundle under its digest. update.sh compares the running
# release's digest with the branch tip's, deploys only when they differ, and
# then asks for the bundle by the tip's digest. Comparing what the build is
# given, rather
# than predicting which changes could matter to it, is the point: any path
# the build can read is in the export, and nothing outside it can reach the
# build. A path the build needs but build-paths leaves out makes the build
# fail; it can never leave the keeper on stale code.
set -euo pipefail

# The paths <commit>'s build-paths names, one per line. Returns 3 if the
# commit has no build-paths, and 1 if a line is not a plain repository path
# (so no line can pass git an option or reach outside the tree).
build_paths() {
  local repo="$1" commit="$2" list line
  list="$(git -C "$repo" show "$commit:apps/keeper/host/deploy/build-paths" 2>/dev/null)" || return 3
  local count=0
  while IFS= read -r line; do
    line="${line%%#*}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    if ! [[ "$line" =~ ^[A-Za-z0-9._@+][A-Za-z0-9._@+/-]*$ ]] || [[ "/$line/" == */../* || "/$line/" == */./* ]]; then
      echo "build-paths: not a plain repository path: $line" >&2
      return 1
    fi
    echo "$line"
    count=$((count + 1))
  done <<< "$list"
  [ "$count" -gt 0 ] || { echo "build-paths names no path" >&2; return 1; }
}

export_source() {
  local repo="$1" commit="$2" out="$3" status=0 paths
  paths="$(build_paths "$repo" "$commit")" || status=$?
  [ "$status" -eq 0 ] || return "$status"
  local -a list
  mapfile -t list <<< "$paths"
  git -C "$repo" archive --format=tar -o "$out" "$commit" -- "${list[@]}"
}

source_digest() {
  local repo="$1" commit="$2" scratch="$3"
  local tree="$scratch/tree"
  rm -rf "$scratch"
  mkdir -p "$tree"
  export_source "$repo" "$commit" "$scratch/source.tar"
  tar -xf "$scratch/source.tar" -C "$tree" --no-same-owner
  # Re-packed in a fixed order with fixed timestamps, owners and modes: what
  # is left is paths, types, the executable bit and contents, which is all git
  # records. The mode is set, not taken from the extracted tree, because
  # extraction does not give every account the same one: root keeps the
  # archive's 0664, anyone else gets it under their umask. CI digests as a
  # runner user and the keeper machine as root, and both must name the same
  # bundle (#2651).
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
    --mode='u=rwX,go=rX' \
    -cf - -C "$tree" . | sha256sum | cut -d' ' -f1
  rm -rf "$scratch"
}

commit_re='^[0-9a-f]{40}$'
case "${1:-}" in
  export | digest)
    if [ "$#" -ne 4 ] || ! [[ "$3" =~ $commit_re ]]; then
      echo "usage: build-source.sh $1 <repo> <commit> <tar file | scratch directory>" >&2
      exit 2
    fi
    if [ "$1" = export ]; then
      export_source "$2" "$3" "$4"
    else
      source_digest "$2" "$3" "$4"
    fi
    ;;
  *)
    echo "usage: build-source.sh export|digest ..." >&2
    exit 2
    ;;
esac
