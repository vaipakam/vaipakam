# Release Notes — 2026-04-30

Functional record of everything delivered on 2026-04-30, written
as plain-English user-facing / operator-facing descriptions —
no code. Continues from
[`ReleaseNotes-2026-04-29.md`](./ReleaseNotes-2026-04-29.md).

Coverage at a glance: a **fresh testnet redeploy** across Base
Sepolia (canonical) + Sepolia (mirror) + BNB Smart Chain Testnet
(mirror), bringing all three chains' on-chain state in line with
the current codebase (~31 commits ahead of the 2026-04-22
deployments); three **deploy-script patches** caught during a
pre-deploy sanity audit (a missing `legalFacet` write to
`addresses.json`, two configure-scripts running without ADMIN
role-gate pre-flight checks); a **stuck-tx recovery** on BNB
Testnet where forge defaulted to a 1-wei gas price the network
silently dropped; **cross-chain peer wiring** of the OFT mesh +
fixed-rate buy mesh + reward-aggregation mesh across all three
chains (12 `setPeer` calls); a clean **positive-flow E2E** of all
15 lifecycle scenarios on Base Sepolia (204 txs / 204 receipts);
and **partial-flow E2Es** on Sepolia + BNB Testnet that leave
each chain in a frontend-testable midpoint state (open offers,
active loans, repaid-but-unclaimed loans, NFT-collateral and
rental-NFT loans).

## Testnet redeploy — fresh canonical + mirrors

The on-chain Diamonds on the three Phase 1 testnets had drifted
~31 commits behind master since the 2026-04-22 deployment. Recent
landed work that wasn't reflected on chain included the partial-
repay opt-in flag (added new fields to `Offer` and `Loan`
storage), the position-NFT name change ("Vaipakam NFT" / `VAIPAK`),
the Tellor + API3 + DIA secondary oracle quorum (Pyth removed),
the 4-DEX swap failover with `LibSwap`, the Phase 5 borrower-LIF
VPFI rebate path, the Phase 6 keeper per-action authorization
model, the Phase 8b Permit2 plumbing on `acceptOffer` /
`createOffer`, the LegalFacet (ToS gate), the governance-config
sweep (`getProtocolConfigBundle` + `getProtocolConstants`), the
LZGuardianPausable mixin on the 5 OApps, and the
`OfferCanceledDetails` companion event added 2026-04-29.

A clean redeploy was the right move (rather than upgrading
existing storage in place) because some of those changes
included struct-shape edits that Diamond-cut migration would
have had to handle field-by-field. With nothing on those
testnets that needed preserving, fresh addresses gave the
cleanest path.

Sequence per chain (in order):

1. `DeployDiamond.s.sol` — 31 facets, escrow impl, ERC-173
   ownership handover from deployer to admin.
2. `DeployVPFICanonical.s.sol` (Base only) / `DeployVPFIMirror.s.sol`
   (mirrors) — VPFIToken proxy + OFT Adapter (Base) or Mirror
   (others), `setVPFIToken` + `setCanonicalVPFIChain` on the
   Diamond.
3. `DeployVPFIBuyReceiver.s.sol` (Base only) /
   `DeployVPFIBuyAdapter.s.sol` (mirrors) — fixed-rate VPFI buy
   plumbing.
4. `DeployRewardOAppCreate2.s.sol` — CREATE2-deterministic
   bootstrap pattern so the Reward OApp proxy lands at the same
   address on all three chains (`0x5f0Fb9F1...c52E`).
5. `DeployTestnetLiquidityMocks.s.sol` — mUSDC + mWBTC ERC-20s,
   mock Chainlink registry + per-asset feeds, mock Uniswap V3
   factory + pools above the $1M depth threshold so both mocks
   classify as Liquid; oracle wiring on the Diamond +
   `updateRiskParams` for both assets and the chain's WETH.
6. `ConfigureVPFIBuy.s.sol` (Base only) — buy-rate and caps.
7. `ConfigureRewardReporter.s.sol` — local + base EIDs, reward
   OApp pointer, canonical flag.

Final addresses recorded in `contracts/deployments/<chain>/addresses.json`
on each chain. The Diamond and impl addresses changed on every
chain; the Reward OApp proxy address is identical across all
three by design.

| Chain | Diamond | VPFI Token / Mirror |
|---|---|---|
| Base Sepolia (84532) | 0x76C39e552f08556D6287A67A1e2B2D82F4E76c66 | 0xc9e4e60551e9D1AE460B7343Ad070ab2FcaF83E7 (canonical) |
| Sepolia (11155111) | 0x381BA2f7959613294Cf432063fe3C33CB68625AD | 0x1992C3038D2312dCc6fB51071509a272450d6A66 (mirror) |
| BNB Testnet (97) | 0xe46F8AE352bc28998083A2EC8Cf379063A73BEf7 | 0x771248712d35c54261C2A9441f3cAc7f9ad57839 (mirror) |

VPFI Reward OApp proxy: `0x5f0Fb9F11c11AA939518f45b6BC610336156c52E`
on all three chains (CREATE2 deterministic).

## Deploy-script patches

A pre-deploy audit pass turned up three operational gaps. All
three landed before any RPC traffic so the new deploys ran
clean.

### `DeployDiamond.s.sol` — `legalFacet` missing from artifact

The diamond-cut step of `DeployDiamond` adds 30 facets via the
cuts array (DiamondCutFacet is added by the diamond's
constructor). The script then writes each facet's address into
`addresses.json` via `Deployments.writeFacet(...)` so downstream
config / verification scripts can look up impl addresses without
querying the diamond loupe. The block of `writeFacet` calls had
30 entries — but `LegalFacet` (added in the Phase 4.1 ToS gate
work) wasn't among them. The facet was deployed and cut into the
diamond correctly; only the artifact write was missing, so
`addresses.json.facets.legalFacet` came back `null` after every
deploy.

Today's blast radius was zero (no script or frontend reads
`legalFacet` from the artifact yet — the frontend talks through
the diamond proxy), but the gap would have shipped silently and
broken any future tooling that did. One line added; verified by
the redeploy on each of the three testnets writing all 31 facet
addresses.

### `ConfigureOracle.s.sol` — wrong key + missing role pre-flight

Two issues on the same script:

1. The script's docstring said *"broadcast by a holder of
   ADMIN_ROLE"* but the code read `vm.envUint("PRIVATE_KEY")` —
   the deployer key. After `DeployDiamond`'s ownership handover,
   the deployer holds nothing; the broadcasted txs would revert
   with `LibDiamond` ownership errors and `AccessControl`
   role-missing errors that surface as the generic "execution
   reverted" RPC response. Fixed: read `ADMIN_PRIVATE_KEY`
   instead.
2. No pre-flight check on the broadcaster's role. The
   `OracleAdminFacet` setters use `LibDiamond.enforceIsContractOwner`
   (ERC-173 owner) and the `AdminFacet` setters use
   `onlyRole(ADMIN_ROLE)`. If either gate fails the tx reverts
   with a useless surface. Added a pre-broadcast block that:
   - reads `IERC173(diamond).owner()` and reverts with
     `"ConfigureOracle: broadcaster <0x...> is not Diamond owner <0x...>"`
     if mismatched;
   - reads `AccessControlFacet(diamond).hasRole(ADMIN_ROLE, broadcaster)`
     and reverts with a similarly explicit message if false.

### `ConfigureVPFIBuy.s.sol` — ADMIN_ROLE pre-flight

Same shape as the second `ConfigureOracle` fix. The script broadcasts
4 setter calls on `VPFIDiscountFacet`, all of which enforce
`onlyRole(ADMIN_ROLE)`. The pre-flight block now reads
`hasRole(ADMIN_ROLE, broadcaster)` before `vm.startBroadcast` and
reverts with an explicit message if missing.

## BNB Testnet — stuck-tx recovery + 5 gwei deploys

Forge's gas-price auto-detection on BNB Smart Chain Testnet
returned 1 wei for the first `DeployVPFIBuyAdapter` run, which
the network silently swallowed (no error, no eviction, no
mining). The tx sat in mempool for 25+ minutes, blocking the
deployer's nonce-126 slot.

Recovery sequence:

1. Killed the forge process holding the mempool slot.
2. Sent a 0-value self-tx at the stuck nonce with 5 gwei gas to
   evict the original.
3. Re-ran every subsequent BNB deploy script with
   `--with-gas-price 5gwei` (forge flag) — clean from there.

Same 1-wei-gas symptom hit a follow-up `DeployRewardOAppCreate2`
run despite the explicit gas flag (the script's CREATE2 path has
a separate codepath that re-derives gas internally). Re-ran with
the same flag and confirmed the proxy actually had bytecode at
the expected CREATE2 address before continuing.

The cross-chain peer wiring step then ran into the same shape
once more (one of the 12 `setPeer` calls on BNB Testnet got
stuck in mempool at low gas). Recovered by sending the
`setPeer(uint32,bytes32)` call directly via `cast send` at 20
gwei, with the `--nonce <stuck-nonce>` flag forcing replacement.
All 12 peer wirings verified after recovery via
`peers(uint32) → bytes32` reads on each OApp.

Operational note for future BNB Testnet runs: always pass
`--with-gas-price 5gwei` to forge, and have a `cast send …
--gas-price 20gwei --nonce <N>` recovery one-liner ready in case
forge's auto-detection misses again. The other two testnets
(Base Sepolia, Sepolia) auto-detect gas correctly.

## Cross-chain peer wiring — 12 setPeer calls

After all three chains were independently deployed, the OApp
peers needed wiring across the mesh. Mesh shapes:

- **VPFI OFT** (Base canonical adapter ↔ Sepolia + BNB mirrors)
  — hub-and-spoke: each mirror peers with the canonical adapter,
  no mirror-to-mirror peering. 4 wirings (2 bidirectional pairs).
- **Fixed-rate buy** (Base BuyReceiver ↔ Sepolia + BNB
  BuyAdapters) — same hub-and-spoke shape. 4 wirings.
- **Reward aggregation** (Base RewardOApp ↔ Sepolia + BNB
  RewardOApps) — hub-and-spoke through Base since reports flow
  mirror→canonical and broadcasts flow canonical→mirror. 4
  wirings.

All 12 wirings completed. Verification: `peers(remoteEid)` reads
on every OApp on every chain returned the expected counterparty
address (right-padded to bytes32). The BNB→Base reward peer
needed a manual `cast send` recovery (per the stuck-tx note
above); the other 11 went through the script cleanly.

## Positive flow E2E — Base Sepolia

`SepoliaPositiveFlows.s.sol` (despite the name, chain-agnostic)
ran on Base Sepolia covering all 15 lifecycle scenarios:

1-8. Liquid ERC-20 lending — create offer, accept, partial
     repay, full repay, default, fallback collateral split,
     claim, terminal-state event verification.
9.   Illiquid ERC-20 collateral — full-collateral transfer on
     default (no DEX swap path).
10.  ERC-721 collateral.
11.  ERC-1155 collateral.
12.  ERC-721 rental — borrower as renter, daily prepay deductions.
13.  ERC-1155 rental.
14.  Illiquid lending + illiquid collateral — both legs require
     dual fallback consent.
15.  Illiquid lending + liquid collateral.

Result: 204 transactions / 204 receipts, all green. Estimated
gas 71.5M, actual cost ~0.0008 ETH on Base Sepolia. The fresh
diamond + mock liquidity infrastructure exercised every lifecycle
write at least once; the per-loan invariants (settlement
breakdown, treasury accrual, claim payload shape) all matched
expectations.

## Partial flow E2Es — Sepolia + BNB Testnet

`BaseSepoliaPartialFlows.s.sol` (chain-agnostic) ran on Sepolia
and BNB Testnet. Unlike the positive flow which exercises every
lifecycle to terminal state, the partial flow intentionally
stops each scenario at a UI-testable midpoint so the frontend
team can drive the remaining steps through the wallet:

- **A.** Open lender offer (ERC-20 + liquid collateral) — accept
  via the borrower UI.
- **B.** Open borrower offer — accept via the lender UI.
- **C.** Active liquid loan — repay / add collateral / preclose
  via the borrower UI; observe HF / LTV from either side.
- **D.** Repaid-but-unclaimed loan — drives the Claim Center on
  both sides.
- **E.** Active ERC-721-collateral loan — exercises the NFT-
  collateral surfaces.
- **F.** Active ERC-721 rental loan — exercises the rental
  position UI.

Both chains ended with all six states populated, ready for
manual UI walkthroughs.

## Test-wallet funding — BNB Testnet

The lender / borrower / new-lender / new-borrower test wallets
on BNB Testnet had zero balance going into today's runs (only
the canonical `LENDER_ADDRESS` had been pre-funded). The deployer
transferred 0.05 BNB to each of the three zero-balance test
wallets so the partial-flow script could broadcast tx from each
identity. Sepolia and Base Sepolia test wallets already had
adequate balance from prior runs.

## Frontend address sync (pending)

The new on-chain addresses need to land in
`frontend/src/contracts/config.ts` so the connected-wallet flow
hits the freshly-deployed Diamond on each chain. Per the
project's frontend-ABI-sync workflow in `CLAUDE.md`, this also
requires running `bash contracts/script/exportFrontendAbis.sh`
to capture any ABI deltas from the 31 commits of contract
changes since the last frontend sync. Coordinated frontend
deploy after the address sweep + ABI re-export + `tsc -b` clean.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
