#!/usr/bin/env bash
# Cases for check-test-treasury-sync.sh: builds small test trees in a temp
# directory and checks the verdict on each. Bash only; compiles nothing.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-test-treasury-sync.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# expect <name> <0|1> : run the check over $TMP/<name> and compare the exit.
expect() {
  local name="$1" want="$2" got=0
  bash "$CHECK" "$TMP/$name" >/dev/null 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "✗ $name: expected exit $want, got $got"
    fail=1
  else
    echo "✓ $name"
  fi
}

mk() { mkdir -p "$(dirname "$TMP/$1")"; printf '%s\n' "$2" > "$TMP/$1"; }

mk clean/FooTest.t.sol '        LibTestVaultBeacon.setTreasury(address(diamond), t);'
expect clean 0

mk raw/FooTest.t.sol '        AdminFacet(address(diamond)).setTreasury(t);'
expect raw 1

mk nested/invariants/Base.sol '        AdminFacet(d).setTreasury(d);'
expect nested 1

mk aliased/FooTest.t.sol '        _admin().setTreasury(makeAddr("t"));'
expect aliased 1

mk comment/FooTest.t.sol '        // LibVaipakam.setTreasury(owner);
    ///      AdminFacet.setTreasury() stored the wrong address.
     * setTreasury(x) in a block comment'
expect comment 0

mk allowed/AdminFacetTest.t.sol '        AdminFacet(address(diamond)).setTreasury(t);'
mk allowed/helpers/LibTestVaultBeacon.sol '        ITreasurySetter(diamond).setTreasury(treasury);'
expect allowed 0

# An allowlisted NAME in another directory is not the allowlisted file.
mk elsewhere/sub/AdminFacetTest.t.sol '        AdminFacet(address(diamond)).setTreasury(t);'
expect elsewhere 1

mk both/FooTest.t.sol '        LibTestVaultBeacon.setTreasury(d, t); AdminFacet(d).setTreasury(t);'
expect both 1

expect missing-root 2

exit "$fail"
