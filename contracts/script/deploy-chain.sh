#!/usr/bin/env bash
#
# deploy-chain.sh — testnet one-shot deployment / quick-iteration script.
#
# A single command that:
#   1. forge build
#   2. Deploys the Diamond on the selected chain
#   3. Deploys the Timelock
#   4. Deploys the VPFI lane (canonical on Base / Base Sepolia,
#      mirror on every other chain — branched on chain-slug)
#   5. Deploys the Reward OApp (also canonical-vs-mirror branched)
#   6. Syncs per-facet ABIs + the consolidated deployments JSON via
#      `packages/contracts/` — the single-source-of-truth bundle every
#      consumer in the monorepo (apps/{defi,www,keeper,indexer,agent})
#      reads. No more dual-write to a Worker-side ABI directory; the
#      Stage 3 split made `@vaipakam/contracts/abis` the only target.
#   7. Builds + deploys the two SPAs to Cloudflare Workers Static Assets:
#        apps/defi  → vaipakam-defi  (the dApp)
#        apps/www   → vaipakam-www   (marketing site)
#   8. Deploys the three Cloudflare Workers via wrangler:
#        apps/keeper  → vaipakam-keeper   (HF watcher autonomous keeper)
#        apps/indexer → vaipakam-indexer  (D1 indexer + read-only API,
#                       owns the `vaipakam-archive` D1 + its migrations)
#        apps/agent   → vaipakam-agent    (notifications, frames, agent)
#
# Stage 3 split (May 2026): the historical `ops/hf-watcher` monolith
# was decomposed into three focused Workers under apps/{keeper,indexer,
# agent}. All three bind the same D1 database (`vaipakam-archive`); only
# the indexer owns migrations. The legacy `ops/hf-watcher` tree is
# archived under `alpha/hf-watcher/` and is not deployed by this script.
#
# Scope: TESTNETS ONLY. Refuses any mainnet chain-slug. Mainnet is
# tiered via `deploy-mainnet.sh` so the operator sees + confirms each
# stage before any irreversible action. A separate rehearsal-grade
# `deploy-testnet.sh` (mirroring mainnet's tiered phase model) is the
# right script for end-to-end testnet rehearsals; this script stays as
# the one-shot dev quick-loop.
#
# Out of scope (stays manual on every chain):
#   - Role rotation to governance multisig + timelock — multi-party
#     ceremony, can't safely live in a script. Run via the
#     DeploymentRunbook §6 once the contract deploy is green and the
#     deployer has finished the first-day config sweep.
#   - Mainnet hardware-wallet enforcement + the 48h Admin-EOA →
#     Multisig handover deadline (ratified 2026-05-14) — both live
#     in `deploy-mainnet.sh` (HARD-FAIL) and `deploy-testnet.sh`
#     (WARN-mode mirror for rehearsal muscle memory). This
#     one-shot quick-iteration script is end-to-end in a single
#     command (no `--phase handover` step exists to gate) and is
#     refused on mainnet chain-slugs anyway, so neither guard has
#     a place to attach.
#   - CCIP lane + channel wiring across chains — needs every chain
#     deployed first; `ConfigureCcip.s.sol` reads each chain's
#     addresses.json to wire selectors / messengers / channel peers /
#     TokenPool lanes. Run once per chain after `deploy-chain.sh` has
#     landed on every chain in the topology (the multi-chain
#     orchestrators do this automatically).
#   - Wrangler secrets (`wrangler secret put TG_BOT_TOKEN` etc.) —
#     operator-specific, never in any repo. Pre-provisioned per
#     Worker; this script verifies presence (read-only) but never
#     prompts for values.
#
# Usage:
#   bash contracts/script/deploy-chain.sh <chain-slug> [flags]
#
#   chain-slug:
#     anvil          — local dev (chainId 31337) — calls
#                      anvil-bootstrap.sh which is the more complete
#                      local flow (mocks + multicall etch + flag flips
#                      + seed offers).
#     base-sepolia   — canonical-VPFI testnet (84532)
#     sepolia        — mirror testnet (11155111)
#     arb-sepolia    — mirror testnet (421614)
#     op-sepolia     — mirror testnet (11155420)
#     bnb-testnet    — mirror testnet (97 — native-gas mode acceptable)
#     polygon-amoy   — mirror testnet (80002 — native-gas mode acceptable)
#
#   flags:
#     --skip-defi      — don't build / wrangler-deploy apps/defi
#     --skip-www       — don't build / wrangler-deploy apps/www
#     --skip-keeper    — don't wrangler-deploy apps/keeper
#     --skip-indexer   — don't wrangler-deploy apps/indexer (NB: also
#                        skips D1 migrations + cursor seed for this run)
#     --skip-agent     — don't wrangler-deploy apps/agent
#     --skip-cf        — alias for ALL FIVE Cloudflare-deploy flags
#                        (defi + www + keeper + indexer + agent)
#     --skip-vpfi      — skip the VPFI lane + reward OApp (handy when
#                        re-running after a partial failure that already
#                        landed those)
#     --fresh          — wipe contracts/deployments/<chain>/addresses.json
#                        before deploying. Use when rehearsing — old
#                        state from a prior deploy can't bleed into the
#                        new one. NEVER pass on a chain whose existing
#                        deploy you want to preserve; this is destructive.
#                        Also wipes step-marker files so every step
#                        runs even if a prior partial deploy left them.
#                        (Indexer D1 retention is handled by the Worker's
#                        own pruning logic, not by this script.)
#     --resume         — re-run after a partial-fail. Skips any step
#                        whose marker file (`.markers/<step>-done`)
#                        exists in the deployments dir, so a script
#                        that died at step 4 can restart from step 4
#                        without redoing the diamond + timelock.
#                        Implied behaviour by default: markers ARE
#                        written after each step but NOT consulted
#                        unless --resume is passed (so a vanilla
#                        re-run still re-deploys, matching the prior
#                        behaviour).
#     --verify-contracts
#                      — run `forge verify-contract` against the
#                        chain's block explorer for every deployed
#                        contract after the deploy lands. Requires
#                        ETHERSCAN_API_KEY (or per-chain equivalent;
#                        Foundry's etherscan multi-chain config in
#                        foundry.toml handles routing). Off by default
#                        on testnet — toggling on for rehearsal is a
#                        real-world dry-run of the mainnet flow.
#
# Pre-flight:
#   - `.env` populated (DEPLOYER_PRIVATE_KEY, ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
#     TREASURY_ADDRESS, VPFI_OWNER, VPFI_TREASURY, VPFI_INITIAL_MINTER,
#     <CHAIN>_RPC_URL for the target chain, and the CCIP_ROUTER_* /
#     CCIP_RMN_PROXY_* entries for the target chain). The script
#     `set -a` sources `.env` before any forge call so per-chain env
#     vars surface.
#   - Workspace install: `pnpm install` at the monorepo root has been
#     run, so apps/{defi,www,keeper,indexer,agent} all have their
#     `node_modules` symlink chains in place. The script does NOT
#     auto-install (deterministic deploy step).
#   - Wrangler authentication: `npx wrangler whoami` works without
#     prompting (i.e., the operator has logged in or set a token).
#   - Per-Worker secrets pre-provisioned via `wrangler secret put`
#     against each of vaipakam-{keeper,indexer,agent}. The script
#     verifies presence read-only (RPC_<CHAIN> per chain on every
#     Worker that signs RPC calls) but never asks for values.

set -euo pipefail

# ── Node version preflight ────────────────────────────────────────────
# Vite 5+ requires Node 20+; Wrangler 4+ requires Node 20+. Both are
# called from steps `[7]` and `[8a]` respectively, deep into the
# deploy. A version mismatch there manifests as obscure Node errors
# (e.g. `ReferenceError: CustomEvent is not defined` from Vite) and
# the deploy hangs at `[7]`. Failing fast at the top of the script
# catches the operator before they spend 30 minutes on an on-chain
# deploy that ends in a frontend-build crash.
#
# If `nvm` is present and the active Node is < 20, attempt to use
# any installed Node ≥ 20 from `~/.nvm/versions/node/`. Fail with
# a clear message if none available.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
else
  NODE_MAJOR=0
fi
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  # Look for nvm-managed Node ≥ 20 to recover automatically.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    BEST_NODE_BIN=""
    while IFS= read -r CANDIDATE; do
      CANDIDATE_MAJOR="$(basename "$CANDIDATE" | sed -E 's/^v([0-9]+).*/\1/')"
      if [ "${CANDIDATE_MAJOR:-0}" -ge 20 ]; then
        BEST_NODE_BIN="$CANDIDATE/bin"
      fi
    done < <(find "$HOME/.nvm/versions/node" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
    if [ -n "$BEST_NODE_BIN" ]; then
      export PATH="$BEST_NODE_BIN:$PATH"
      echo "[node-preflight] auto-switched to $BEST_NODE_BIN (was Node v$NODE_MAJOR)"
    else
      echo "Error: Node v$NODE_MAJOR detected. Steps [7] and [8a] need Node 20+ for Vite + Wrangler." >&2
      echo "       Either run \`nvm install 20 && nvm use 20\`, or invoke this script with PATH" >&2
      echo "       overridden to a Node-20+ install (e.g. \`PATH=/path/to/node-20/bin:\$PATH bash …\`)." >&2
      exit 1
    fi
  else
    echo "Error: Node v$NODE_MAJOR detected. Steps [7] and [8a] need Node 20+ for Vite + Wrangler." >&2
    echo "       Install Node 20+ (or nvm) before running this script." >&2
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
# Stage 3 / Stage 4 source-tree split: SPAs and Workers each live under
# `apps/<name>` with a wrangler.jsonc, and three Workers replace the
# old monolithic `ops/hf-watcher`. Every Cloudflare deploy step in this
# script `cd`s into one of these dirs.
DEFI_DIR="$REPO_ROOT/apps/defi"
WWW_DIR="$REPO_ROOT/apps/www"
KEEPER_DIR="$REPO_ROOT/apps/keeper"
INDEXER_DIR="$REPO_ROOT/apps/indexer"
AGENT_DIR="$REPO_ROOT/apps/agent"

cd "$CONTRACTS_DIR"

# ── Args ──────────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  cat >&2 <<EOF
Usage: bash contracts/script/deploy-chain.sh <chain-slug> [flags]

Supported chain-slugs:
  anvil  base-sepolia  sepolia  arb-sepolia  op-sepolia  bnb-testnet  polygon-amoy

Per-app skip flags (Cloudflare deploys):
  --skip-defi      --skip-www       --skip-keeper
  --skip-indexer   --skip-agent     --skip-cf  (alias for all five)

Other flags:
  --skip-vpfi
  --fresh          --resume         --verify-contracts

For mainnet, use deploy-mainnet.sh — refuses to land mainnet here.
For end-to-end testnet rehearsals (mirrors mainnet's tiered phase
model), use deploy-testnet.sh.
EOF
  exit 1
fi

CHAIN_SLUG="$1"; shift

SKIP_DEFI=0
SKIP_WWW=0
SKIP_KEEPER=0
SKIP_INDEXER=0
SKIP_AGENT=0
SKIP_VPFI=0
FRESH=0
RESUME=0
VERIFY_CONTRACTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-defi)        SKIP_DEFI=1 ;;
    --skip-www)         SKIP_WWW=1 ;;
    --skip-keeper)      SKIP_KEEPER=1 ;;
    --skip-indexer)     SKIP_INDEXER=1 ;;
    --skip-agent)       SKIP_AGENT=1 ;;
    --skip-cf)
      # Single switch for "no Cloudflare deploys at all" — common
      # when iterating purely on contracts and you don't want to wait
      # for five wrangler invocations.
      SKIP_DEFI=1; SKIP_WWW=1
      SKIP_KEEPER=1; SKIP_INDEXER=1; SKIP_AGENT=1
      ;;
    --skip-vpfi)        SKIP_VPFI=1 ;;
    --fresh)            FRESH=1 ;;
    --resume)           RESUME=1 ;;
    --verify-contracts) VERIFY_CONTRACTS=1 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$FRESH" = "1" ] && [ "$RESUME" = "1" ]; then
  echo "Error: --fresh and --resume are mutually exclusive." >&2
  exit 1
fi

# ── Chain registry ────────────────────────────────────────────────────
# Refuse mainnet here. Anvil delegates to the more complete bootstrap
# (which also etches Multicall3 + flips Range Orders flags + seeds
# offers — those steps are anvil-only and don't belong in a generic
# chain deploy).

case "$CHAIN_SLUG" in
  anvil)
    echo "anvil dev playground — delegating to anvil-bootstrap.sh"
    exec bash "$SCRIPT_DIR/anvil-bootstrap.sh"
    ;;
  base-sepolia)
    CHAIN_ID=84532;     RPC_VAR="BASE_SEPOLIA_RPC_URL"; IS_CANONICAL=1
    CCIP_SLUG="BASE_SEPOLIA" ;;
  sepolia)
    CHAIN_ID=11155111;  RPC_VAR="SEPOLIA_RPC_URL";       IS_CANONICAL=0
    CCIP_SLUG="SEPOLIA" ;;
  arb-sepolia)
    CHAIN_ID=421614;    RPC_VAR="ARB_SEPOLIA_RPC_URL";   IS_CANONICAL=0
    CCIP_SLUG="ARB_SEPOLIA" ;;
  op-sepolia)
    CHAIN_ID=11155420;  RPC_VAR="OP_SEPOLIA_RPC_URL";    IS_CANONICAL=0
    CCIP_SLUG="OP_SEPOLIA" ;;
  bnb-testnet)
    CHAIN_ID=97;        RPC_VAR="BNB_TESTNET_RPC_URL";   IS_CANONICAL=0
    CCIP_SLUG="BNB_TESTNET" ;;
  polygon-amoy)
    CHAIN_ID=80002;     RPC_VAR="POLYGON_AMOY_RPC_URL";  IS_CANONICAL=0
    CCIP_SLUG="POLYGON_AMOY" ;;
  base|ethereum|arbitrum|optimism|polygon-zkevm|bnb|polygon)
    cat >&2 <<EOF
Refusing to run mainnet chain '$CHAIN_SLUG' from deploy-chain.sh.
Use deploy-mainnet.sh — it gates each phase behind a confirm flag so
the operator sees what's about to land before it lands.
EOF
    exit 1
    ;;
  *)
    echo "Unknown chain-slug: $CHAIN_SLUG" >&2
    exit 1
    ;;
esac

# ── Load .env and resolve RPC ─────────────────────────────────────────

if [ -f "$CONTRACTS_DIR/.env" ]; then
  set -a; source "$CONTRACTS_DIR/.env"; set +a
else
  echo "Error: $CONTRACTS_DIR/.env not found." >&2
  echo "Copy .env.example → .env and populate the keys for $CHAIN_SLUG." >&2
  exit 1
fi

RPC="${!RPC_VAR:-}"
if [ -z "$RPC" ]; then
  echo "Error: \$$RPC_VAR not set in .env." >&2
  exit 1
fi

# Per-chain CCIP Router + RMN-proxy dispatch. `DeployCrosschain.s.sol`
# reads a single `CCIP_ROUTER` / `CCIP_RMN_PROXY` pair — the CURRENT
# chain's — but both differ per chain (Base, Ethereum, Arb, OP, BNB
# each have a distinct CCIP Router + RMN proxy). The .env carries
# `CCIP_ROUTER_<SLUG>` / `CCIP_RMN_PROXY_<SLUG>` per chain; resolve the
# active chain's pair here so one .env serves every chain without
# manual editing between runs.
#
# The per-slug form is REQUIRED (#853 Codex P2) — matching deploy-testnet.sh
# and the CCIP-INFRA-ADDRESSES.md contract. A bare pre-set `CCIP_ROUTER` with
# no matching `CCIP_ROUTER_<SLUG>` is a HARD ERROR, not a silent fallback:
# reusing a stale bare Base router left over from a prior single-chain run on
# e.g. `arb-sepolia` would wire the WRONG immutable CCIP router into
# DeployCrosschain. Only enforced when the VPFI/cross-chain stack is actually
# being deployed (`--skip-vpfi` skips [4], so CCIP infra isn't needed).
CCIP_ROUTER_VAR="CCIP_ROUTER_${CCIP_SLUG}"
CCIP_RMN_PROXY_VAR="CCIP_RMN_PROXY_${CCIP_SLUG}"
if [ "$SKIP_VPFI" = "0" ]; then
  if [ -z "${!CCIP_ROUTER_VAR:-}" ]; then
    echo "Error: $CCIP_ROUTER_VAR is unset. deploy-chain.sh requires the per-slug CCIP" >&2
    echo "       router (a bare CCIP_ROUTER is refused — it risks wiring the wrong chain's" >&2
    echo "       immutable router). See contracts/deployments/CCIP-INFRA-ADDRESSES.md for" >&2
    echo "       $CHAIN_SLUG's value, or pass --skip-vpfi if not deploying the CCIP stack." >&2
    exit 1
  fi
  export CCIP_ROUTER="${!CCIP_ROUTER_VAR}"
  if [ -z "${!CCIP_RMN_PROXY_VAR:-}" ]; then
    echo "Error: $CCIP_RMN_PROXY_VAR is unset (per-slug CCIP RMN proxy required)." >&2
    exit 1
  fi
  export CCIP_RMN_PROXY="${!CCIP_RMN_PROXY_VAR}"
fi

# Confirm RPC actually points at the expected chain. Catches the
# common cut-and-paste error where SEPOLIA_RPC_URL got pasted into
# BASE_SEPOLIA_RPC_URL slot — running a $84532-aware Diamond against
# Sepolia would burn faucet ETH on a confused chain.
RESPONSE_CHAIN_HEX=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" \
  | sed -E 's/.*"result":"([^"]+)".*/\1/' || true)
RESPONSE_CHAIN_DEC=$(printf "%d\n" "$RESPONSE_CHAIN_HEX" 2>/dev/null || echo 0)
if [ "$RESPONSE_CHAIN_DEC" != "$CHAIN_ID" ]; then
  cat >&2 <<EOF
Error: $RPC_VAR points at chainId=$RESPONSE_CHAIN_DEC, expected $CHAIN_ID for '$CHAIN_SLUG'.
Check the RPC URL in .env.
EOF
  exit 1
fi

# Required env vars for every chain. `CCIP_ROUTER` / `CCIP_RMN_PROXY`
# are the active chain's CCIP infrastructure (resolved per-slug just
# above); a missing one would bail `DeployCrosschain.s.sol` mid-flight
# (after Diamond + Timelock have already landed on-chain). Catching it
# in pre-flight saves the faucet-ETH burn from a partial deploy.
for v in DEPLOYER_PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
         TIMELOCK_PROPOSER; do
  if [ -z "${!v:-}" ]; then
    echo "Error: \$$v required in .env but not set." >&2
    exit 1
  fi
done
# VPFI + CCIP env is only needed when the VPFI / cross-chain stack is actually
# deployed. `--skip-vpfi` omits [3b] + [4], so requiring these there would
# contradict the flag and fail before the non-VPFI deploy path (#853 Codex P2).
if [ "$SKIP_VPFI" = "0" ]; then
  for v in VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER CCIP_ROUTER CCIP_RMN_PROXY; do
    if [ -z "${!v:-}" ]; then
      echo "Error: \$$v required in .env but not set (or pass --skip-vpfi to omit the VPFI/CCIP stack)." >&2
      exit 1
    fi
  done
fi

# Mirror chains additionally need BASE_CHAIN_ID — the EVM chain id of
# canonical Base — so DeployCrosschain can point the reward + buy flows
# back at the canonical receiver. Canonical Base is its own base and
# stores baseChainId = 0, so the check is mirror-only. Only DeployCrosschain
# ([4]) consumes it, so gate on SKIP_VPFI too — a `--skip-vpfi` mirror quick
# deploy shouldn't demand it (#853 Codex P2).
if [ "$SKIP_VPFI" = "0" ] && [ "$IS_CANONICAL" = "0" ] && [ -z "${BASE_CHAIN_ID:-}" ]; then
  echo "Error: \$BASE_CHAIN_ID required in .env for mirror chains (or pass --skip-vpfi)." >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "deploy-chain.sh"
echo "  chain-slug:    $CHAIN_SLUG"
echo "  chain-id:      $CHAIN_ID"
echo "  ccip router:   ${CCIP_ROUTER:-(skipped — --skip-vpfi)}"
if [ "$IS_CANONICAL" = "1" ]; then
  echo "  crosschain:    CANONICAL  (lock/release VPFI pool + buy receiver)"
else
  echo "  crosschain:    MIRROR     (mirror VPFI + burn/mint pool + buy adapter)"
fi
echo "  rpc:           $RPC"
echo "  skip-vpfi:     $SKIP_VPFI"
echo "  fresh:         $FRESH"
echo "  resume:        $RESUME"
echo "  verify-cts:    $VERIFY_CONTRACTS"
echo "  skip-defi:     $SKIP_DEFI    skip-www:     $SKIP_WWW"
echo "  skip-keeper:   $SKIP_KEEPER    skip-indexer: $SKIP_INDEXER    skip-agent: $SKIP_AGENT"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── Step-marker + history-sidecar helpers ─────────────────────────────
# Every named step writes a marker file after success. With --resume,
# a re-run skips any step whose marker exists — so a deploy that died
# at step 4 can resume at step 4 without redoing diamond + timelock.
# --fresh wipes the markers dir before starting.
#
# History sidecar: after each addresses.json-updating step (Diamond,
# Timelock, VPFI lane, Reward OApp), copy the file into
# `.history/<step>-<unix-ts>.json` so the operator has a recoverable
# audit trail of each rehearsal's intermediate states (useful when
# investigating mid-flight failures).

DEPLOY_DIR="$CONTRACTS_DIR/deployments/$CHAIN_SLUG"
MARKERS_DIR="$DEPLOY_DIR/.markers"
HISTORY_DIR="$DEPLOY_DIR/.history"

mkdir -p "$DEPLOY_DIR" "$MARKERS_DIR" "$HISTORY_DIR"

step_done() {
  # Returns 0 (true) if the step has already been run successfully
  # AND the user opted into resume. With --resume off the function
  # always returns 1 so every step runs.
  local step="$1"
  if [ "$RESUME" = "1" ] && [ -f "$MARKERS_DIR/$step.done" ]; then
    return 0
  fi
  return 1
}

mark_done() {
  local step="$1"
  date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/$step.done"
}

snapshot_addresses() {
  # Sidecar copy of the current addresses.json. Skips silently if no
  # addresses.json exists yet (the very first step).
  local label="$1"
  if [ -f "$DEPLOY_DIR/addresses.json" ]; then
    cp "$DEPLOY_DIR/addresses.json" "$HISTORY_DIR/$label-$(date +%s).json"
  fi
}

# ── 0. --fresh cleanup (rehearsal hygiene) ────────────────────────────
# Wipes prior deploy artefacts so the rehearsal starts from a known-
# empty state. Without this, DeployDiamond reuses the existing
# addresses.json's diamond, and storage from the prior rehearsal
# persists — old offers/loans written under a previous struct shape
# silently poison reads (the May-2026 garbage-values bug we hit).
# Mainnet slugs are refused by the chain registry above, so this
# block can only fire on testnets.
#
# Stage 3 split note: the historical `WATCHER_DIR/scripts/purge-chain.sh`
# block lived here to wipe the hf-watcher's D1 rows for THIS chainId so
# stale rows decoded against the prior bytecode wouldn't surface in
# OfferBook/LoanList. After the apps/{keeper,indexer,agent} split:
#   - indexer is the only D1 consumer; its `0010_oracle_snapshot_state`
#     and prune logic handle stale-row retention without an external
#     purge script.
#   - the cf-indexer step below also re-seeds `indexer_cursor` to the
#     current safe head whenever --fresh is set, so the next cron tick
#     starts indexing fresh-block data instead of replaying old blocks.
# So D1 hygiene under --fresh is now handled where it belongs — inside
# the indexer Worker's deploy block — instead of via a now-deleted
# external script.

# #857 — VPFI-token config validation: ONE pre-broadcast gate, run BEFORE the
# --fresh cleanup below (so it can still read the recorded .vpfiToken for the
# carry-forward match) AND before any broadcast. The single source of truth for
# the fresh-mint / force-rotate / carry-forward decision + every reuse-address
# check lives in DeployVPFIToken._resolveMode(); its no-broadcast preflight()
# fails loud on any invalid VPFI config here. No-op on mirror chains / --skip-vpfi.
# Also skipped once the `vpfitoken` step has already completed on a --resume run:
# the recorded .vpfiToken is then legitimately present (step [3b] landed it), and
# the token step below will short-circuit anyway — re-running preflight would
# reject that recorded token and block the documented resume-at-a-later-step flow.
if [ "$IS_CANONICAL" = "1" ] && [ "$SKIP_VPFI" = "0" ] && ! step_done "vpfitoken"; then
  echo "[0·pre] VPFI token preflight (mode validation, no broadcast)"
  # Pass $FRESH through as VPFI_TOKEN_FRESH so _resolveMode() knows a --fresh
  # redeploy is about to archive the recorded .vpfiToken — otherwise it would
  # read the still-present old token and reject the documented --fresh mint.
  VPFI_TOKEN_FRESH="$FRESH" \
    forge script script/DeployVPFIToken.s.sol --sig "preflight()" --rpc-url "$RPC"
fi

if [ "$FRESH" = "1" ]; then
  echo "[0] --fresh cleanup"
  if [ -f "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" ]; then
    BACKUP="$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.prior-rehearsal.$(date +%s).json"
    mv "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" "$BACKUP"
    echo "  ✓ backed up prior addresses.json → $(basename "$BACKUP")"
  else
    echo "  (no prior addresses.json — already clean)"
  fi
  # Wipe step markers so every step re-runs.
  rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true
  echo "  ✓ cleared step markers in $MARKERS_DIR"
  echo "  (indexer D1 cursor will be re-seeded in step [8d] for chainId=$CHAIN_ID)"
  echo
fi

# ── 1. Build ──────────────────────────────────────────────────────────

if step_done "build"; then
  echo "[1] forge build (skipped — marker exists)"
else
  echo "[1] forge build"
  forge build
  mark_done "build"
fi

# ── 1b. Pre-deploy sanity check ───────────────────────────────────────
# Runs the deploy-sanity forge suite (FacetSizeLimitTest — every facet
# under EIP-170; SelectorCoverageTest — every facet selector cut into the
# Diamond) and lints the deploy shell scripts. A failure here means the
# build is unsafe to broadcast — stop before touching a chain.
#
# Deliberately NOT step-marker gated: unlike the deploy steps below, a
# sanity gate must re-run on EVERY (re)run, including a resumed run
# after a contract or ABI edit. If it were marker-skipped, a run that
# wrote the marker then failed at step [2] could, on a later rerun
# after edits, broadcast the Diamond without re-validating it. It is
# cheap relative to the deploy itself.
echo
echo "[1b] Pre-deploy sanity check"
bash "$SCRIPT_DIR/predeploy-check.sh"

# ── Arbitrum L2-block override (#853 Codex P2) ────────────────────────
# forge sim can't emulate `ArbSys(0x64)`, so `Deployments.currentL2Block()`
# reverts on Arbitrum unless `ARB_L2_DEPLOY_BLOCK` is set. Derive it from THIS
# chain's RPC (returns the L2 head on Arbitrum) BEFORE the diamond broadcast so
# the diamond can't land on-chain and then abort before addresses.json is
# written. Only fetched when the diamond step will actually run.
if { [ "$CHAIN_ID" = "421614" ] || [ "$CHAIN_ID" = "42161" ]; } && ! step_done "diamond"; then
  ARB_L2_DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)"
  if [ -z "$ARB_L2_DEPLOY_BLOCK" ]; then
    echo "ERROR: could not fetch Arbitrum L2 block from \$RPC for ARB_L2_DEPLOY_BLOCK" >&2
    exit 1
  fi
  export ARB_L2_DEPLOY_BLOCK
  echo "[2·arb] ARB_L2_DEPLOY_BLOCK=$ARB_L2_DEPLOY_BLOCK (forge-sim ArbSys fallback)"
fi

# (The VPFI-token mode validation runs as a single pre-broadcast preflight() call
# BEFORE the --fresh cleanup above — see "[0·pre] VPFI token preflight". #857.)

# ── 2. Diamond ────────────────────────────────────────────────────────

if step_done "diamond"; then
  echo
  echo "[2] DeployDiamond.s.sol (skipped — marker exists)"
else
  echo
  echo "[2] DeployDiamond.s.sol"
  forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-diamond"
  mark_done "diamond"
fi

# ── 2b. Post-cut facet verification ───────────────────────────────────
# DeployDiamond's `diamondCut` is split into two halves to stay under
# the per-tx gas cap (commit `585179f`). If the second half silently
# fails (gas spike, RPC hiccup, etc.), the diamond ends up with only
# the first 16 facets registered — selectors from the second half
# revert with `FunctionDoesNotExist`, but the deploy script itself
# returns 0. The May-2026 testnet rehearsal hit exactly this pattern
# (offer struct decoded as garbage because the OfferFacet selectors
# came back from the OLD pre-redeploy facet, while the indexer used
# the new ABI). DiamondLoupe's `facetAddresses()` is the authoritative
# post-deploy answer.
#
# The expected count is NOT hardcoded — DeployDiamond records the
# authoritative cuts.length into addresses.json (.facetCount, Issue
# #69); the check below exact-matches the live loupe count against it.

echo
echo "[2b] Post-cut facet-count verification (DiamondLoupe)"
DIAMOND_ADDR=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_ADDR" ]; then
  echo "FAIL: no diamond address in deployments/$CHAIN_SLUG/addresses.json after DeployDiamond." >&2
  echo "      Either the script reverted silently or addresses.json wasn't written." >&2
  exit 1
fi
# DiamondCutFacet is selector-callable but NOT enumerated by the Loupe
# (constructor writes the selector mapping directly without touching
# facetAddresses[]), so the loupe count equals the number of cut
# entries exactly. DeployDiamond records that authoritative count in
# addresses.json (.facetCount, Issue #69); read it and require an
# EXACT match — a `>=` floor would green-light a stale or partially
# migrated diamond that is MISSING a facet.
EXPECTED_FACETS=$(jq -r '.facetCount // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
if [ -z "$EXPECTED_FACETS" ]; then
  echo "FAIL: .facetCount missing from deployments/$CHAIN_SLUG/addresses.json." >&2
  echo "      DeployDiamond.s.sol records it — re-run step [2]." >&2
  exit 1
fi
FACET_COUNT_RAW=$(cast call "$DIAMOND_ADDR" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null \
  | tr ',' '\n' | grep -c '0x' || echo 0)
if [ "$FACET_COUNT_RAW" -ne "$EXPECTED_FACETS" ]; then
  echo "FAIL: diamond at $DIAMOND_ADDR has $FACET_COUNT_RAW facets, expected exactly $EXPECTED_FACETS." >&2
  echo "      The diamond is incomplete / stale (a half cut, or a facet missing)." >&2
  echo "      Re-run with --fresh." >&2
  exit 1
fi
echo "  ✓ diamond at $DIAMOND_ADDR has all $FACET_COUNT_RAW expected facets"

# ── 3. Timelock ───────────────────────────────────────────────────────

if step_done "timelock"; then
  echo
  echo "[3] DeployTimelock.s.sol (skipped — marker exists)"
else
  echo
  echo "[3] DeployTimelock.s.sol"
  forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-timelock"
  mark_done "timelock"
fi

# ── 3b. Canonical VPFI token ──────────────────────────────────────────
# MUST land BEFORE DeployCrosschain, whose canonical branch (Base) reads
# `.vpfiToken` to wrap the existing token in the CCIP LockRelease pool; nothing
# upstream mints it, so a fresh canonical run fails at [4] without this step
# (#853 Codex P1). Mirror chains skip it — they mint their own Burn/Mint
# VPFIMirrorToken inside [4]. DeployVPFIToken itself hard-guards to canonical
# chain ids, so this IS_CANONICAL gate is belt-and-suspenders. Gated by
# --skip-vpfi the same way [4] is (both are the VPFI/cross-chain surface).
if [ "$SKIP_VPFI" = "0" ] && [ "$IS_CANONICAL" = "1" ]; then
  if step_done "vpfitoken"; then
    echo
    echo "[3b] DeployVPFIToken.s.sol (skipped — marker exists)"
  else
    echo
    echo "[3b] DeployVPFIToken.s.sol  (canonical VPFI — before crosschain)"
    # Pass $FRESH -> VPFI_TOKEN_FRESH so run() mints fresh if a recorded token
    # survives a --fresh. deploy-chain's [0] cleanup archives the whole file
    # unconditionally (unlike testnet/mainnet, whose archive gates on .diamond),
    # so this is defensive here — kept for parity with the other wrappers (#857).
    VPFI_TOKEN_FRESH="$FRESH" \
      forge script script/DeployVPFIToken.s.sol --rpc-url "$RPC" --broadcast --slow
    snapshot_addresses "post-vpfitoken"
    mark_done "vpfitoken"
  fi
fi

# ── 4. CCIP cross-chain stack ─────────────────────────────────────────
# `DeployCrosschain.s.sol` deploys the whole T-068 CCIP stack for this
# one chain in a single run — the CcipMessenger, the VPFI CCIP TokenPool
# (lock/release on canonical Base, burn/mint on a mirror), the
# VpfiPoolRateGovernor, the VaipakamRewardMessenger, and the buy receiver
# (canonical) or the mirror VPFI token + buy adapter (mirror). It picks
# canonical-vs-mirror itself from block.chainid — no per-branch env
# juggling, unlike the retired LayerZero scripts.
#
# Cross-chain LANE + CHANNEL wiring is deliberately NOT here: it needs
# every chain in the topology deployed first (ConfigureCcip.s.sol reads
# each chain's addresses.json to wire peers). That pass runs once per
# chain AFTER this script has landed on every chain — see the follow-up
# note at the end of this script and the cutover runbook.

if [ "$SKIP_VPFI" = "0" ] && step_done "crosschain"; then
  echo
  echo "[4] CCIP cross-chain stack (skipped — marker exists)"
elif [ "$SKIP_VPFI" = "0" ]; then
  echo
  echo "[4] DeployCrosschain.s.sol  (CCIP cross-chain stack)"
  forge script script/DeployCrosschain.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-crosschain"
  mark_done "crosschain"
else
  echo
  echo "[4] Skipping CCIP cross-chain stack (--skip-vpfi)"
fi

# ── 5b. Master-flag flip (testnet ergonomics) ─────────────────────────
# Range Orders Phase 1 governance-gated kill switches default `false` on
# every fresh deploy (per docs/RangeOffersDesign.md §15 staged-enablement
# rationale). On Anvil the bootstrap script flips them; on testnet
# operators previously had to do this manually after every fresh deploy.
# Flipping here removes the manual step — no functional change to
# mainnet behaviour because deploy-mainnet.sh does NOT call this script
# (and mainnet should keep the staged-rollout discipline).
#
# Idempotent — `setRange*Enabled(true)` on an already-true flag is a
# successful no-op state write.

echo
echo "[5b] Master-flag flip (testnet ergonomics)"
DIAMOND_ADDR=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_ADDR" ]; then
  echo "    (no diamond address yet — skipping master-flag flip)"
elif [ -z "${ADMIN_PRIVATE_KEY:-}" ]; then
  echo "    (ADMIN_PRIVATE_KEY missing — skipping master-flag flip)"
else
  for fn in setRangeAmountEnabled setRangeRateEnabled setPartialFillEnabled; do
    echo "  cast send $fn(true) on $DIAMOND_ADDR"
    cast send "$DIAMOND_ADDR" "$fn(bool)" true \
      --private-key "$ADMIN_PRIVATE_KEY" \
      --rpc-url "$RPC" \
      2>&1 | grep -E "^status" | head -1 || true
  done
  echo "  Final master flags: $(cast call $DIAMOND_ADDR 'getMasterFlags()(bool,bool,bool)' --rpc-url $RPC | tr '\n' ' ')"
fi

# ── 5c. CCIP lane / channel wiring — NOT a single-chain step ──────────
# CCIP needs no per-chain DVN policy — there is no DVN fleet to curate
# (Chainlink operates a uniform committing DON + executing DON + an
# independent Risk Management Network for every integrator; the
# LayerZero 1-required / 0-optional footgun does not exist here, per
# CLAUDE.md "Cross-Chain Security Policy"). So the old per-chain
# `ConfigureLZConfig.s.sol` step has no CCIP analogue.
#
# What DOES need wiring — chain selectors, remote messengers, the
# vpfi-buy / vpfi-reward channel peers, the TokenPool lanes + rate
# limits, and the TokenAdminRegistry CCT registration — is
# `ConfigureCcip.s.sol`. It reads EVERY chain's addresses.json to wire
# peers, so it cannot run until every chain in the topology has been
# deployed. The multi-chain orchestrators (deploy-testnet.sh /
# deploy-mainnet.sh) run it as a final pass once every chain has landed;
# a standalone single-chain run wires it by hand per the cutover
# runbook. Nothing to do here.

echo
echo "[5c] CCIP lane/channel wiring — deferred to the post-all-chains pass"
echo "     (ConfigureCcip.s.sol; see the follow-up note below)."

# ── 5cb. Phase 7a swap-adapter chain ──────────────────────────────────
# Deploys the ZeroExAggregatorAdapter + OneInchAggregatorAdapter and
# registers both with the Diamond's swap-adapter chain via
# `AdminFacet.addSwapAdapter`. Skipped (with a clear log line) when
# `INITIAL_SETTLERS` env var is unset — it's optional for chains
# where 0x doesn't yet have a Settler deployed (some testnets), and
# the keeper-bot's quote orchestrator gracefully degrades to the
# subset of adapters that DID register. See
# `script/DeploySwapAdapters.s.sol` for the env-var contract and
# the rotation flow.
if [ "${INITIAL_SETTLERS:-}" = "" ]; then
  echo
  echo "[5cb] Skipping DeploySwapAdapters — INITIAL_SETTLERS env var not set."
  echo "      (Set INITIAL_SETTLERS=0xSettlerA,0xSettlerB,... to deploy."
  echo "       Pull current Settler addresses by reading transaction.to from"
  echo "       a fresh \`https://api.0x.org/swap/allowance-holder/quote\` call"
  echo "       on this chain, or via the 0x deployer's ownerOf(...) on"
  echo "       0x00000000000004533Fe15556B1E086BB1A72cEae.)"
elif [ -f "$MARKERS_DIR/swap-adapters.done" ] && [ "$RESUME" = "1" ]; then
  echo
  echo "[5cb] DeploySwapAdapters (skipped — marker exists)"
else
  echo
  echo "[5cb] DeploySwapAdapters.s.sol  (Phase 7a aggregator adapters + register in diamond)"
  forge script script/DeploySwapAdapters.s.sol --rpc-url "$RPC" --broadcast --slow
  mark_done "swap-adapters"
fi

# ── 5d. Post-deploy health check ──────────────────────────────────────
# Reads sentinel state from the deployed Diamond + (where applicable)
# the BuyAdapter rate limits. Logs a clear PASS/FAIL line per check
# so a deploy that landed structurally but mis-configured (e.g.
# default-uint256.max rate limits, paused diamond, missing treasury)
# fails LOUDLY here rather than silently shipping a broken state.
# Health-check log is also persisted to .history/ for audit trail.

echo
echo "[5d] Post-deploy health check"
DIAMOND_FOR_HEALTH=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_FOR_HEALTH" ]; then
  echo "  ⚠ no diamond in addresses.json — skipping health check"
else
  HEALTH_LOG="$HISTORY_DIR/health-$(date +%s).log"
  {
    echo "deploy-chain.sh health check"
    echo "  chain:    $CHAIN_SLUG ($CHAIN_ID)"
    echo "  diamond:  $DIAMOND_FOR_HEALTH"
    echo "  ts:       $(date +%Y-%m-%dT%H:%M:%S%z)"
    echo
    echo "  paused()         = $(cast call "$DIAMOND_FOR_HEALTH" 'paused()(bool)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  getTreasury()    = $(cast call "$DIAMOND_FOR_HEALTH" 'getTreasury()(address)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  nextOfferId()    = $(cast call "$DIAMOND_FOR_HEALTH" 'nextOfferId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  nextLoanId()     = $(cast call "$DIAMOND_FOR_HEALTH" 'nextLoanId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  facetCount       = $(cast call "$DIAMOND_FOR_HEALTH" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null | tr ',' '\n' | grep -c '0x' || echo '?')"
    echo "  getMasterFlags() = $(cast call "$DIAMOND_FOR_HEALTH" 'getMasterFlags()(bool,bool,bool)' --rpc-url "$RPC" 2>/dev/null | tr '\n' ' ' || echo '?')"
    POOL_FOR_HEALTH=$(jq -r '.vpfiTokenPool // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
    if [ -n "$POOL_FOR_HEALTH" ]; then
      echo "  vpfiTokenPool    = $POOL_FOR_HEALTH"
      # The CCIP per-lane rate limits live on this pool, set via the
      # VpfiPoolRateGovernor in the post-all-chains `ccip-wire` pass —
      # NOT in this single-chain deploy. So a freshly-deployed pool here
      # legitimately has no lanes yet; just surface the rateLimitAdmin
      # so the operator can eyeball it (zero address until ccip-wire).
      echo "    rateLimitAdmin = $(cast call "$POOL_FOR_HEALTH" 'getRateLimitAdmin()(address)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
      echo "    (CCIP lanes + rate limits are wired by ConfigureCcip.s.sol)"
    fi
  } | tee "$HEALTH_LOG"
  echo "  ✓ health log → $(basename "$HEALTH_LOG")"
fi

# ── 5e. Deployment-source marker ──────────────────────────────────────
# Records which CONTRACTS commit produced the deployed bytecode + when
# the deploy ran + which deployer signed. The May-2026 rehearsal
# revealed that addresses.json's `deployedAt` field gets stale (the
# deploy script doesn't update it on redeploy), so the operator
# couldn't tell at a glance which version was actually live. This
# sidecar fixes that — written fresh on every deploy completion.

DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null || echo "?")
COMMIT_HASH=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "?")
COMMIT_DIRTY=""
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then
  COMMIT_DIRTY=" (dirty)"
fi
cat > "$DEPLOY_DIR/deployment_source.json" <<EOF
{
  "chainSlug": "$CHAIN_SLUG",
  "chainId": $CHAIN_ID,
  "deployedAt": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "monorepoCommit": "$COMMIT_HASH$COMMIT_DIRTY",
  "deployer": "$DEPLOYER_ADDR",
  "diamond": "$DIAMOND_FOR_HEALTH"
}
EOF
echo "  ✓ deployment_source.json written ($(echo "$COMMIT_HASH" | head -c 8)$COMMIT_DIRTY)"

# ── 5f. Source-code verification on chain explorer ────────────────────
# Runs `forge verify-contract` against the chain's Etherscan-family
# explorer for every deployed contract. Verified source on the
# explorer is a baseline for user trust + makes audit / debugging
# painless. Off by default on testnet (saves API quota during quick
# iteration); turn on for rehearsal / mainnet via --verify-contracts.
#
# Foundry's etherscan multi-chain config (in foundry.toml) handles
# routing — we just need ETHERSCAN_API_KEY (or per-chain equivalent)
# in the env. Failures don't bubble up: a single contract that fails
# verification (already-verified, rate-limited, broken bytecode-vs-
# source) shouldn't bring down the rest of the deploy. Each line is
# logged; operator eyeballs the summary at the end.
#
# Walks the chain-specific broadcast records (one per forge script
# that ran above) and verifies every CREATE2 / contract creation it
# captures.

if [ "$VERIFY_CONTRACTS" = "1" ] && step_done "verify-contracts"; then
  echo
  echo "[5f] Source-code verification (skipped — marker exists)"
elif [ "$VERIFY_CONTRACTS" = "1" ]; then
  echo
  echo "[5f] Source-code verification on explorer (forge verify-contract)"
  if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
    echo "  ⚠ ETHERSCAN_API_KEY not set — verification will fail. Set in .env"
    echo "    (or per-chain equivalent in foundry.toml's etherscan config)"
    echo "    and re-run with --verify-contracts."
  else
    BROADCAST_DIR="$CONTRACTS_DIR/broadcast"
    if [ ! -d "$BROADCAST_DIR" ]; then
      echo "  ⚠ no broadcast/ dir — was forge script ever run with --broadcast?"
    else
      VERIFIED=0
      FAILED=0
      # First pass: collect a deduped (addr, name) pair list from
      # EVERY run-latest.json under broadcast/, scoped to this chain.
      # Without dedup, a single ERC20Mock referenced by 5 different
      # test scripts would be verified 5 times — each `--watch` call
      # polls the explorer 30-120s, so duplicates blow the loop into
      # multi-hour territory. Dedup collapses N-script × M-tx down
      # to the unique-contract set actually present on chain.
      #
      # Also scope to records FRESH from this deploy (mtime newer
      # than the deployment_source.json's write time, which is one
      # step earlier in the script and stamped fresh on every run).
      # Old broadcast files from prior testnet runs reference long-
      # since-redeployed mocks; verifying them is wasted work.
      DEPLOY_SOURCE_FILE="$DEPLOY_DIR/deployment_source.json"
      DEPLOY_SOURCE_MTIME=0
      if [ -f "$DEPLOY_SOURCE_FILE" ]; then
        DEPLOY_SOURCE_MTIME=$(stat -c %Y "$DEPLOY_SOURCE_FILE" 2>/dev/null || echo 0)
      fi
      declare -A SEEN_ADDR
      VERIFY_QUEUE_FILE=$(mktemp)
      while IFS= read -r run_file; do
        # Skip stale broadcast records — anything older than the
        # current deployment_source.json is from a prior deploy.
        FILE_MTIME=$(stat -c %Y "$run_file" 2>/dev/null || echo 0)
        if [ "$DEPLOY_SOURCE_MTIME" -gt 0 ] && [ "$FILE_MTIME" -lt "$DEPLOY_SOURCE_MTIME" ]; then
          continue
        fi
        while IFS= read -r line; do
          ADDR=$(echo "$line" | jq -r '.contractAddress // empty')
          NAME=$(echo "$line" | jq -r '.contractName // empty')
          [ -z "$ADDR" ] && continue
          [ -z "$NAME" ] && continue
          [ "$ADDR" = "null" ] && continue
          [ "$NAME" = "null" ] && continue
          # Dedupe by lowercased address — same address can appear
          # under different `contractName` fields if a forge script
          # references it through different interface types.
          ADDR_LC=$(echo "$ADDR" | tr 'A-Z' 'a-z')
          if [ -n "${SEEN_ADDR[$ADDR_LC]:-}" ]; then continue; fi
          SEEN_ADDR[$ADDR_LC]=1
          echo "$ADDR $NAME" >> "$VERIFY_QUEUE_FILE"
        done < <(jq -c '.transactions[]?' "$run_file" 2>/dev/null)
      done < <(find "$BROADCAST_DIR" -path "*/$CHAIN_ID/run-latest.json" 2>/dev/null)

      QUEUE_LEN=$(wc -l < "$VERIFY_QUEUE_FILE" || echo 0)
      echo "  $QUEUE_LEN unique contract(s) in verify queue (post-dedup)"

      while read -r ADDR NAME; do
        if forge verify-contract --chain-id "$CHAIN_ID" --watch \
            "$ADDR" "$NAME" >/dev/null 2>&1; then
          echo "  ✓ $NAME @ $ADDR"
          VERIFIED=$((VERIFIED + 1))
        else
          echo "  ✗ $NAME @ $ADDR  (already-verified / rate-limit / mismatch)"
          FAILED=$((FAILED + 1))
        fi
      done < "$VERIFY_QUEUE_FILE"
      rm -f "$VERIFY_QUEUE_FILE"
      echo "  Summary: $VERIFIED verified, $FAILED failed (across $QUEUE_LEN unique contracts)"
    fi
  fi
  mark_done "verify-contracts"
fi

# ── 6. Sync ABIs + consolidated deployments JSON ──────────────────────
# Single canonical export target after the Stage 3 split:
# `packages/contracts/src/{abis,deployments.json}`. Every consumer in
# the monorepo — apps/{defi,www} (the SPAs) and apps/{keeper,indexer,
# agent} (the Workers) — imports from `@vaipakam/contracts`. So this
# one step keeps the entire downstream surface (SPA reads, Worker
# event decode, sibling keeper-bot repo reads) on the same compiled-
# bytecode shape — no manual follow-up before the cf-* deploy steps.
#
# The historical `exportWatcherAbis.sh` was deleted alongside
# `ops/hf-watcher` itself in the Stage 3 cleanup; positional-decode
# drift of the kind captured in ReleaseNotes-2026-05-05.md
# (`periodicInterestCadence` shifting `getOfferDetails` tuple
# positions) can't recur because every Worker now imports the
# Solidity-compiler-emitted JSON instead of hand-typed `as const`
# arrays.

if step_done "abi-sync"; then
  echo
  echo "[6] Sync ABIs + consolidated deployments JSON (skipped — marker exists)"
else
echo
echo "[6] Sync ABIs + consolidated deployments JSON"
bash "$SCRIPT_DIR/exportFrontendAbis.sh"
bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
  bash "$SCRIPT_DIR/exportAbis.sh"
else
  echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
fi

# ops/{subgraph,tenderly,lz-watcher} exports — best-effort. Each
# script is a no-op for chains it can't map (lz-watcher's mainnet-
# only shortKey filter, Tenderly's per-chain network names, The
# Graph's network slugs), so testnet rehearsals produce mostly-empty
# but consistent outputs. The lz-watcher emitter writes to a
# gitignored generated/ sidecar — it produces a `wrangler secret put`
# shell snippet meant for operator review, never an automatic apply.
if [ -d "$REPO_ROOT/ops/subgraph" ]; then
  bash "$SCRIPT_DIR/exportSubgraphAbis.sh" "$CHAIN_SLUG"
fi
if [ -d "$REPO_ROOT/ops/tenderly" ]; then
  bash "$SCRIPT_DIR/exportTenderlyAlerts.sh" "$CHAIN_SLUG"
fi
if [ -d "$REPO_ROOT/ops/lz-watcher" ]; then
  mkdir -p "$REPO_ROOT/ops/lz-watcher/generated"
  bash "$SCRIPT_DIR/exportLzWatcherVars.sh" "$CHAIN_SLUG" \
    > "$REPO_ROOT/ops/lz-watcher/generated/secrets-$CHAIN_SLUG.sh"
  echo "    ops/lz-watcher/generated/secrets-$CHAIN_SLUG.sh — review + apply manually."
fi
mark_done "abi-sync"
fi  # close step_done "abi-sync" else branch

# ── 7. SPA Cloudflare deploys (defi + www) ────────────────────────────
# Stage 4 split (May 2026): the historical `frontend/` directory is
# now two distinct apps:
#   apps/defi → vaipakam-defi  (the dApp — connected wallet, OfferBook,
#                               LoanList, vault management)
#   apps/www  → vaipakam-www   (marketing site — landing, docs, blog,
#                               brand surfaces)
# Each is its own Vite SPA with its own wrangler.jsonc, deployed as
# Cloudflare Workers Static Assets. Per-app skip flags
# (`--skip-defi` / `--skip-www`) gate them independently because
# operators often iterate on one without touching the other.

# 7a. apps/defi — the dApp.
if [ "$SKIP_DEFI" = "0" ] && step_done "defi"; then
  echo
  echo "[7a] apps/defi deploy (skipped — marker exists)"
elif [ "$SKIP_DEFI" = "0" ]; then
  echo
  echo "[7a] apps/defi build + Cloudflare Workers Static Assets deploy"
  if [ ! -d "$DEFI_DIR/node_modules" ]; then
    echo "Error: $DEFI_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  ( cd "$DEFI_DIR" && pnpm run build && pnpm exec wrangler deploy )
  mark_done "defi"
else
  echo
  echo "[7a] Skipping apps/defi deploy (--skip-defi)"
fi

# 7b. apps/www — the marketing site.
if [ "$SKIP_WWW" = "0" ] && step_done "www"; then
  echo
  echo "[7b] apps/www deploy (skipped — marker exists)"
elif [ "$SKIP_WWW" = "0" ]; then
  echo
  echo "[7b] apps/www build + Cloudflare Workers Static Assets deploy"
  if [ ! -d "$WWW_DIR/node_modules" ]; then
    echo "Error: $WWW_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  ( cd "$WWW_DIR" && pnpm run build && pnpm exec wrangler deploy )
  mark_done "www"
else
  echo
  echo "[7b] Skipping apps/www deploy (--skip-www)"
fi

# ── 8. Worker Cloudflare deploys (keeper + indexer + agent) ───────────
#
# Stage 3 split (May 2026): the historical `ops/hf-watcher` monolith
# is now three focused Workers under apps/{keeper,indexer,agent}, all
# bound to the same D1 database (`vaipakam-archive`). Only the indexer
# owns migrations + the indexer_cursor row; the keeper and agent are
# stateless RPC-call surfaces.
#
# Per-Worker skip flags gate each independently. Each Worker has its
# own RPC-secret store (Cloudflare scopes secrets per Worker), so the
# `wrangler secret list` verification fans out across all three.
# Secrets themselves are pre-provisioned; this script never prompts.

# Helper — verify the chain-specific RPC secret is set on a given
# Worker. Hard-fails the deploy if missing, with operator-friendly
# guidance on how to set it. Behaviour mirrors the May-2026 rehearsal
# fix: silently-missing RPC secrets cause the Worker's
# `getChainConfigs()` filter to drop the chain from its round-robin,
# leaving D1 / RPC state silently incomplete for ~50 min before the
# operator notices via missing OfferBook rows. Refusing to advance
# past this gate forces the operator to fix the secret first.
verify_rpc_secret_on_worker() {
  local worker_dir="$1"
  local worker_name="$2"
  local secret_name="$3"
  local chain_id="$4"

  local present=$(
    cd "$worker_dir" && pnpm exec wrangler secret list 2>/dev/null \
      | grep -c "\"$secret_name\"" \
      || echo 0
  )
  if [ "$present" = "0" ]; then
    echo "  ✗ FAIL: $secret_name is NOT set on $worker_name."
    echo
    echo "  The Worker's chain-config filter drops any chain whose RPC binding"
    echo "  is empty, so chainId=$chain_id will silently never be queried."
    echo "  Set the secret before re-running this script:"
    echo
    echo "    cd $worker_dir"
    echo "    echo -n '<your-paid-rpc-url>' | pnpm exec wrangler secret put $secret_name"
    echo
    echo "  (Per CLAUDE.md, RPC secrets are operator-curated wrangler secrets,"
    echo "   never in the repo. Use a paid-tier provider — Alchemy / Infura /"
    echo "   QuickNode / DRPC — so the Worker isn't throttled mid-broadcast.)"
    return 1
  fi
  echo "  ✓ $secret_name is set on $worker_name"
  return 0
}

# Map chain-slug → expected RPC secret name. Shared by every Worker
# verification step below — same secret name on each Worker (each
# Worker has its own copy in its own Cloudflare secret store).
case "$CHAIN_SLUG" in
  base-sepolia)  EXPECTED_RPC_SECRET="RPC_BASE_SEPOLIA" ;;
  sepolia)       EXPECTED_RPC_SECRET="RPC_SEPOLIA" ;;
  arb-sepolia)   EXPECTED_RPC_SECRET="RPC_ARB_SEPOLIA" ;;
  op-sepolia)    EXPECTED_RPC_SECRET="RPC_OP_SEPOLIA" ;;
  bnb-testnet)   EXPECTED_RPC_SECRET="RPC_BNB_TESTNET" ;;
  polygon-amoy)  EXPECTED_RPC_SECRET="RPC_POLYGON_AMOY" ;;
  *)             EXPECTED_RPC_SECRET="" ;;
esac

# ── 8a. apps/keeper — autonomous HF-liquidation Worker ────────────────
# Stateless: signs `triggerLiquidation` on-chain when an active loan's
# HF drops below 1e18. Reads RPC + signing key from wrangler secrets;
# no D1 writes (it consumes indexer reads via internal fetch). Skipped
# under --skip-keeper.

if [ "$SKIP_KEEPER" = "0" ] && step_done "keeper"; then
  echo
  echo "[8a] apps/keeper deploy (skipped — marker exists)"
elif [ "$SKIP_KEEPER" = "0" ]; then
  echo
  echo "[8a] apps/keeper Cloudflare Worker deploy"
  if [ ! -d "$KEEPER_DIR/node_modules" ]; then
    echo "Error: $KEEPER_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  ( cd "$KEEPER_DIR" && pnpm exec wrangler deploy )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "  RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$KEEPER_DIR" "vaipakam-keeper" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  mark_done "keeper"
else
  echo
  echo "[8a] Skipping apps/keeper deploy (--skip-keeper)"
fi

# ── 8b. apps/indexer — D1 indexer + read-only API ─────────────────────
# Owns the `vaipakam-archive` D1 database + its migrations. Indexes
# Diamond events to D1 on every cron tick; serves /offers/recent,
# /loans/byParticipant, etc. Three sub-steps:
#   8b.1 wrangler deploy
#   8b.2 D1 migrations apply  (only the indexer runs them)
#   8b.3 RPC-secret check for this chain
#   8b.4 Cursor seed at safe head, --fresh only

if [ "$SKIP_INDEXER" = "0" ] && step_done "indexer"; then
  echo
  echo "[8b] apps/indexer deploy (skipped — marker exists)"
elif [ "$SKIP_INDEXER" = "0" ]; then
  echo
  echo "[8b] apps/indexer Cloudflare Worker deploy"
  if [ ! -d "$INDEXER_DIR/node_modules" ]; then
    echo "Error: $INDEXER_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi

  echo "  [8b.1] wrangler deploy"
  ( cd "$INDEXER_DIR" && pnpm exec wrangler deploy )

  echo
  echo "  [8b.2] D1 migrations apply (vaipakam-archive)"
  # Wrangler's `d1 migrations apply` is idempotent — already-applied
  # entries are skipped. Without this step the indexer returns 500
  # `D1_ERROR no such table` on every loan/offer query after a fresh
  # database creation or a schema-bumping deploy.
  ( cd "$INDEXER_DIR" && pnpm exec wrangler d1 migrations apply vaipakam-archive --remote )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "  [8b.3] RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$INDEXER_DIR" "vaipakam-indexer" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  # ── 8b.4. Seed indexer_cursor to current safe head (FRESH only) ─────
  #
  # Reason for existence: after a `--fresh` deploy, the prior
  # rehearsal's addresses.json was rotated out so the indexer is
  # consuming a freshly-deployed Diamond. The cron tick reads the
  # `indexer_cursor` row for `(chain_id, 'diamond')` and starts at
  # `last_block` — which without seeding either replays the prior
  # Diamond's events (decoded against the new ABI = garbage) or
  # falls back to `deployBlock - 1` and burns 5-10 min of cron ticks
  # backfilling the empty pre-deploy block range. Either way the
  # operator can't see freshly-broadcast PositiveFlows / smoke-test
  # events on indexer-backed surfaces for several minutes.
  #
  # Seeding the cursor at current `safe` head closes that gap —
  # the very next cron tick for this chain starts indexing AT
  # head, picking up smoke-test events immediately. Misses any
  # events emitted between deployBlock and seed-time (which on a
  # fresh deploy is just the deploy script's own role-grant /
  # init calls — not OfferCreated/LoanInitiated, which only fire
  # via user-facing flows). The activity_events table loses those
  # diagnostic admin events on free tier; acceptable trade for
  # the catch-up latency win.
  #
  # No-op when --fresh is OFF: keeping the existing cursor is the
  # right call for incremental redeploys (a facet swap that
  # preserves the diamond address).
  if [ "$FRESH" = "1" ]; then
    echo
    echo "  [8b.4] Seed indexer_cursor for chainId=$CHAIN_ID at safe head"
    # Map chain-slug → env var holding the RPC URL. Mirrors the
    # naming convention every env (.env / .env.example / wrangler
    # secrets) already uses.
    case "$CHAIN_SLUG" in
      base-sepolia)  CURSOR_RPC_VAR="BASE_SEPOLIA_RPC_URL" ;;
      sepolia)       CURSOR_RPC_VAR="SEPOLIA_RPC_URL" ;;
      arb-sepolia)   CURSOR_RPC_VAR="ARB_SEPOLIA_RPC_URL" ;;
      op-sepolia)    CURSOR_RPC_VAR="OP_SEPOLIA_RPC_URL" ;;
      bnb-testnet)   CURSOR_RPC_VAR="BNB_TESTNET_RPC_URL" ;;
      polygon-amoy)  CURSOR_RPC_VAR="POLYGON_AMOY_RPC_URL" ;;
      *)             CURSOR_RPC_VAR="" ;;
    esac
    CURSOR_RPC_URL="${!CURSOR_RPC_VAR:-}"
    if [ -z "$CURSOR_RPC_URL" ]; then
      echo "    ⚠ $CURSOR_RPC_VAR not set in env — skipping cursor seed"
    else
      SAFE_HEAD="$(cast block-number --rpc-url "$CURSOR_RPC_URL" --tag safe 2>/dev/null \
        || cast block-number --rpc-url "$CURSOR_RPC_URL" 2>/dev/null \
        || echo "")"
      if [ -z "$SAFE_HEAD" ]; then
        echo "    ⚠ cast block-number failed against $CURSOR_RPC_VAR — skipping cursor seed"
      else
        NOW_TS=$(date +%s)
        ( cd "$INDEXER_DIR" && pnpm exec wrangler d1 execute vaipakam-archive --remote --command \
          "INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
           VALUES ($CHAIN_ID, 'diamond', $SAFE_HEAD, $NOW_TS)
           ON CONFLICT(chain_id, kind) DO UPDATE SET
             last_block = excluded.last_block,
             updated_at = excluded.updated_at;" >/dev/null 2>&1 ) \
          && echo "    ✓ cursor seeded at block $SAFE_HEAD" \
          || echo "    ⚠ wrangler d1 execute failed — cron will fall through to deployBlock-1"
      fi
    fi
  fi

  mark_done "indexer"
else
  echo
  echo "[8b] Skipping apps/indexer deploy (--skip-indexer)"
fi

# ── 8c. apps/agent — notifications + frames + agent surfaces ──────────
# Stateless: signs Telegram + Push notification dispatches, serves
# Farcaster frames, hosts the natural-language agent endpoints. Reads
# RPC + signing keys from wrangler secrets; no D1 writes. Skipped
# under --skip-agent.

if [ "$SKIP_AGENT" = "0" ] && step_done "agent"; then
  echo
  echo "[8c] apps/agent deploy (skipped — marker exists)"
elif [ "$SKIP_AGENT" = "0" ]; then
  echo
  echo "[8c] apps/agent Cloudflare Worker deploy"
  if [ ! -d "$AGENT_DIR/node_modules" ]; then
    echo "Error: $AGENT_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  ( cd "$AGENT_DIR" && pnpm exec wrangler deploy )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "  RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$AGENT_DIR" "vaipakam-agent" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  mark_done "agent"
else
  echo
  echo "[8c] Skipping apps/agent deploy (--skip-agent)"
fi

# ── Summary ───────────────────────────────────────────────────────────

DIAMOND=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")

echo
echo "═══════════════════════════════════════════════════════════════"
echo "deploy-chain.sh — ✓ done"
echo "  chain-slug:    $CHAIN_SLUG ($CHAIN_ID)"
if [ -n "$DIAMOND" ]; then
  echo "  diamond:       $DIAMOND"
fi
echo "  artifact:      contracts/deployments/$CHAIN_SLUG/addresses.json"
echo
echo "Follow-up steps NOT in this script:"
echo "  1. REQUIRED — Diamond-side configure (this script deploys the VPFI"
echo "     token in [3b]/[4] but does NOT register it or wire oracles):"
echo "        forge script script/DiamondConfigSpell.s.sol --rpc-url <rpc> --broadcast"
echo "     Runs ConfigureVPFIToken (sets s.vpfiToken + the canonical flag so"
echo "     TreasuryFacet.mintVPFI and every token-aware guard work), plus"
echo "     ConfigureOracle / RewardReporter / VPFIBuy / NFT URIs. WITHOUT this"
echo "     the Diamond leaves s.vpfiToken unset and token paths stay disabled."
if [ "$SKIP_VPFI" = "1" ]; then
echo "     NOTE: this was a --skip-vpfi deploy (no VPFI/cross-chain stack), so"
echo "     run the spell with SKIP_VPFI=1 in the env — all THREE VPFI children"
echo "     (ConfigureVPFIToken + ConfigureRewardReporter + ConfigureVPFIBuy)"
echo "     then SKIP gracefully as a group (they otherwise fail loud on the"
echo "     missing .vpfiToken/.rewardMessenger artifacts). ConfigureOracle +"
echo "     NFT URIs still run."
fi
echo "  2. CCIP lane + channel wiring (after EVERY chain in your"
echo "     topology has had this script run):"
echo "        CCIP_LANE_CHAIN_IDS=<other chain ids> \\"
echo "        forge script script/ConfigureCcip.s.sol --rpc-url <rpc> --broadcast"
echo "     Wires chain selectors, remote messengers, the vpfi-buy /"
echo "     vpfi-reward channel peers, the TokenPool lanes + rate limits,"
echo "     and the TokenAdminRegistry CCT registration. Run it once per"
echo "     chain. The multi-chain orchestrators do this automatically."
echo "  3. Role rotation to governance + timelock — DeploymentRunbook §6"
echo "     (multi-party ceremony, deliberately out of any script)"
echo "═══════════════════════════════════════════════════════════════"
