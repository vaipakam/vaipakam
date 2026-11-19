#!/usr/bin/env bash
# Symbolic proofs of the VaultBeacon rules (#3436), run with Halmos.
#
# Halmos builds the project it runs in, and a build of this repository is the
# full test-inclusive compile. So this copies the beacon and its proof file into
# a temporary project of their own (OpenZeppelin and forge-std linked from
# contracts/lib) and runs Halmos there. Needs `halmos` on PATH (pip package
# `halmos`). Extra arguments go to Halmos, e.g. `--function check_1`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # contracts/
command -v halmos >/dev/null || { echo "halmos is not installed (pip install halmos)" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src" "$work/test" "$work/lib"
ln -s "$here/lib/forge-std" "$work/lib/forge-std"
ln -s "$here/lib/openzeppelin-contracts-upgradeable" "$work/lib/ozu"
cp "$here/src/VaultBeacon.sol" "$work/src/"
cp "$here/test/formal/VaultBeaconHalmos.sol" "$work/test/"
sed -i.bak 's#\.\./\.\./src/#../src/#' "$work/test/VaultBeaconHalmos.sol" && rm -f "$work/test/VaultBeaconHalmos.sol.bak"
cat > "$work/remappings.txt" <<'R'
@openzeppelin/contracts/=lib/ozu/lib/openzeppelin-contracts/contracts/
forge-std/=lib/forge-std/src/
R
cat > "$work/foundry.toml" <<'T'
[profile.default]
src = "src"
test = "test"
libs = ["lib"]
solc = "0.8.29"
via_ir = true
optimizer = true
optimizer_runs = 200
evm_version = "prague"
T
cd "$work"
halmos --contract VaultBeaconHalmos "$@"
