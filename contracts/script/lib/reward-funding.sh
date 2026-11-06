#!/usr/bin/env bash
# reward-funding.sh — the post-deploy read of the canonical reward pool's
# delivered-fresh funding (#3253).
#
# Why this exists: since #1566 slice 4 PR B the canonical chain's
# delivered-fresh bound is `received − (paid + reserved)`, and `received` is
# credited only by `RewardCustodyFacet.fundRewardPool` and the custody era
# transfers. The 69M interaction pool is an ALLOCATION, not a balance: a
# fresh Base Diamond starts with `received` = 0, so every reward-budget
# remittance to the mirrors refuses `DeliveredFreshBoundExceeded(fresh, 0)`
# until someone funds it. After the 2026-11-03 fresh deploy nobody did, and
# day 1 never reached either mirror; the only sign was a keeper log line
# saying "coverage: 0/2". This read makes that a red verify instead.
#
# Sourced by deploy-testnet.sh and deploy-mainnet.sh (phase verify).
# deploy-chain.sh's health check runs before the reward stack is configured,
# when the role still reads Unconfigured, so it has nothing to check there.

# The reward roles, as `LibVaipakam.RewardRole` numbers them.
REWARD_ROLE_CANONICAL=0
REWARD_ROLE_MIRROR=1
REWARD_ROLE_UNCONFIGURED=2
REWARD_ROLE_DETACHED=3

# _reward_funding_word <output of cast call>
#   The first value of a cast answer, without cast's "[1.2e3]" annotation.
_reward_funding_word() {
  printf '%s' "$1" | head -n 1 | awk '{print $1}'
}

# reward_pool_funding <diamond> <rpc_url>
#   Prints what the chain says about its reward funding, and returns:
#     0  nothing to fix: funded, not the canonical chain, or the canonical
#        chain before its rewards launch anchor (printed as NOT FUNDED YET,
#        with the step that funds it, because the anchor must not be set
#        first);
#     1  the canonical chain's rewards are LAUNCHED and its delivered-fresh
#        bound is zero, so every remittance to the mirrors refuses;
#     2  a read the answer depends on failed — never read as funded.
#   Only zero is tested, so the figures are compared as text (a uint256
#   overflows shell arithmetic).
reward_pool_funding() {
  local diamond="${1:?diamond}" rpc="${2:?rpc_url}"
  local out role launch received paid remaining

  if ! out=$(cast call "$diamond" 'getRewardRole()(uint8)' --rpc-url "$rpc" 2>/dev/null) || [ -z "$out" ]; then
    echo "  ✗ getRewardRole() unreadable on $diamond — the funding cannot be judged." >&2
    return 2
  fi
  role=$(_reward_funding_word "$out")

  case "$role" in
    "$REWARD_ROLE_CANONICAL") ;;
    "$REWARD_ROLE_MIRROR")
      echo "  reward role: Mirror — funded by Base's remittances, which Base's own verify checks; nothing to fund here."
      return 0 ;;
    "$REWARD_ROLE_UNCONFIGURED")
      echo "  reward role: Unconfigured — no delivered-fresh bound applies (no reward stack configured)."
      return 0 ;;
    "$REWARD_ROLE_DETACHED")
      echo "  reward role: Detached — the bound is zero by role; recovery is re-attachment, not funding."
      return 0 ;;
    *)
      echo "  ✗ getRewardRole() answered $role, which is no reward role." >&2
      return 2 ;;
  esac

  if ! out=$(cast call "$diamond" 'getInteractionLaunchTimestamp()(uint256)' --rpc-url "$rpc" 2>/dev/null) || [ -z "$out" ]; then
    echo "  ✗ getInteractionLaunchTimestamp() unreadable on $diamond." >&2
    return 2
  fi
  launch=$(_reward_funding_word "$out")

  # The raw pair (received, paid) and the bound the remittance charges
  # (paid, remaining — remaining is net of reservations as well).
  if ! out=$(cast call "$diamond" 'armedFreshLedger()(uint256,uint256)' --rpc-url "$rpc" 2>/dev/null) || [ -z "$out" ]; then
    echo "  ✗ armedFreshLedger() unreadable on $diamond." >&2
    return 2
  fi
  received=$(_reward_funding_word "$out")
  paid=$(printf '%s\n' "$out" | sed -n 2p | awk '{print $1}')
  if ! out=$(cast call "$diamond" 'getDeliveredFreshBound()(uint256,uint256)' --rpc-url "$rpc" 2>/dev/null) || [ -z "$out" ]; then
    echo "  ✗ getDeliveredFreshBound() unreadable on $diamond." >&2
    return 2
  fi
  remaining=$(printf '%s\n' "$out" | sed -n 2p | awk '{print $1}')
  if [ -z "$received" ] || [ -z "$paid" ] || [ -z "$remaining" ]; then
    echo "  ✗ the delivered-fresh ledger answered in an unexpected shape." >&2
    return 2
  fi

  echo "  reward role: Canonical; rewards launch anchor = $launch"
  echo "  delivered-fresh received = $received wei, paid = $paid wei, remaining (net of reservations) = $remaining wei"

  if [ "$remaining" != "0" ]; then
    echo "  ✓ the reward pool is funded: remittances to the mirrors have headroom."
    return 0
  fi

  local why="nothing has been funded"
  [ "$received" != "0" ] && why="the funded amount is used up"
  if [ "$launch" = "0" ]; then
    echo "  NOT FUNDED YET: $why. Fund it with RewardCustodyFacet.fundRewardPool (ADMIN) before setting the rewards launch anchor — SetInteractionLaunch refuses until then."
    return 0
  fi
  echo "  ✗ FAIL: rewards are launched but the delivered-fresh bound is zero ($why)." >&2
  echo "          Every reward-budget remittance to the mirrors refuses" >&2
  echo "          DeliveredFreshBoundExceeded until RewardCustodyFacet.fundRewardPool (ADMIN) funds it." >&2
  return 1
}
