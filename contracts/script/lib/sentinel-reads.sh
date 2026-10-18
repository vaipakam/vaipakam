#!/usr/bin/env bash
# sentinel-reads.sh — the post-deploy sentinel reads every deploy script runs
# against a freshly deployed Diamond (#2548).
#
# Why this is one shared function: the three deploy scripts each carried their
# own copy of these reads, each ending in `|| echo '?'`. Two of the reads
# (`nextOfferId()` / `nextLoanId()`) named selectors no facet exposes any more,
# so every run printed `?` for them and passed — the check had stopped
# checking, in three places at once, and nothing made it visible. Keeping the
# list here means a getter rename is fixed once, and an unreadable sentinel is
# a counted failure rather than a printed question mark.
#
# Sourced by deploy-testnet.sh, deploy-chain.sh and deploy-mainnet.sh.

# The sentinels, as "<label>|<cast signature>". Each is a zero-argument view
# that must answer on any correctly cut Diamond, live or empty:
#   paused()               — PausableFacet; a deploy must not land paused
#   getTreasury()          — the fee sink the configure phase sets
#   getActiveOffersCount() — MetricsFacet; replaces the retired nextOfferId()
#   getActiveLoansCount()  — MetricsFacet; replaces the retired nextLoanId()
SENTINEL_READS=(
  "paused()|paused()(bool)"
  "getTreasury()|getTreasury()(address)"
  "getActiveOffersCount()|getActiveOffersCount()(uint256)"
  "getActiveLoansCount()|getActiveLoansCount()(uint256)"
)

# sentinel_reads <diamond> <rpc_url>
#   Prints one line per sentinel. A read that reverts, errors or returns
#   nothing prints UNREADABLE. Returns the number of unreadable sentinels, so
#   0 means every sentinel answered. Callers decide whether that is fatal;
#   all three deploy scripts treat it as fatal.
sentinel_reads() {
  local diamond="${1:?diamond}" rpc="${2:?rpc_url}"
  local failed=0 entry label sig out
  for entry in "${SENTINEL_READS[@]}"; do
    label="${entry%%|*}"
    sig="${entry#*|}"
    if out=$(cast call "$diamond" "$sig" --rpc-url "$rpc" 2>/dev/null) && [ -n "$out" ]; then
      printf '  %-24s = %s\n' "$label" "$(printf '%s' "$out" | tr '\n' ' ')"
    else
      printf '  %-24s = UNREADABLE\n' "$label"
      failed=$((failed + 1))
    fi
  done
  return "$failed"
}

# diamond_facet_count <diamond> <rpc_url>
#   Prints the number of facets the Diamond's loupe reports. Returns 1, and
#   prints nothing, when the loupe cannot be read or reports no facet at all.
#
#   Why this exists (#2548): every deploy script counted facets with
#   `cast call … | tr | grep -c '0x' || echo 0`. When the read fails,
#   `grep -c` prints 0 AND exits non-zero, so `|| echo 0` appends a second 0.
#   The two-line value then made `[ "$n" -ne "$expected" ]` an integer-syntax
#   ERROR rather than a false comparison, the `if` took its else branch, and
#   the check printed "all 0 expected facets registered" and passed. A failed
#   read passed verify on BNB testnet on 2026-10-18. The count is now a
#   single number or a refusal, never both.
diamond_facet_count() {
  local diamond="${1:?diamond}" rpc="${2:?rpc_url}" raw n
  raw=$(cast call "$diamond" 'facetAddresses()(address[])' --rpc-url "$rpc" 2>/dev/null) || return 1
  n=$(printf '%s' "$raw" | tr ',' '\n' | grep -c '0x') || true
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -gt 0 ] || return 1
  printf '%s\n' "$n"
}
