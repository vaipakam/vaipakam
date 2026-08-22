// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
// #1649 (Codex #1635 r5) — inherited for its SELECTOR LISTS, which are the
// authoritative surface of every facet the Diamond routes. This script used to
// hand-maintain its own lists and they had drifted badly: 34 of ConfigFacet's
// 90 selectors, 30 of OracleAdminFacet's 34, 4 of OfferCreateFacet's 7. Since a
// refresh re-points only the selectors it names, the omitted ones stayed on the
// PREVIOUS facet address — splitting one logical facet across two builds, which
// is precisely what a bytecode-refresh script exists to prevent. Reading the
// lists from the deploy script instead makes that drift structurally
// impossible rather than merely tested for.
import {DeployDiamond} from "./DeployDiamond.s.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferAcceptFeeFacet} from "../src/facets/OfferAcceptFeeFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ReplaceStaleFacets
 * @notice Redeploys a curated facet set — OfferCreate, OfferAccept, Oracle,
 *         VaultFactory, Config, NumeraireConfig, OracleAdmin, and (since #1649)
 *         RiskPreview + OfferPreview — and re-cuts every selector they own,
 *         choosing Add or Replace per selector from the target Diamond's live
 *         routing. Originally targeted the createOffer failure surfacing
 *         `CrossFacetCallFailed(string)` (0x573c3147) on Sepolia — that legacy
 *         error is only reachable through the non-typed `LibRevert.bubbleOnFailure`
 *         path, which current source no longer uses. Replacing these three
 *         facets with freshly-compiled bytecode removes any pre-refactor copy
 *         left on chain.
 *
 * @dev    PARTIAL refresh — NOT a fee-default rollout vehicle. This script
 *         redeploys only the facets listed above. A change to a `LibVaipakam`
 *         fee-default CONSTANT (e.g. the #1352 freeze bumping
 *         `LOAN_INITIATION_FEE_BPS` 10→20 / `TREASURY_FEE_BPS` 100→200) inlines
 *         into EVERY facet that calls `cfgLoanInitiationFeeBps()` /
 *         `cfgTreasuryFeeBps()` — `LoanFacet._snapshotFeeBps`, `OfferPreviewFacet`,
 *         and every settlement facet (Repay / Preclose / Refinance) — not just
 *         the ones refreshed here. Running ONLY this script after such a change
 *         leaves those facets on the OLD constant, so on a diamond with zero
 *         fee config new loans would charge/snapshot/quote inconsistent
 *         defaults. Roll a fee-default constant change out via the ALL-facet
 *         path instead: `RefreshAllFacetsInPlace.s.sol` (testnet) or a fresh
 *         `DeployDiamond`.
 *
 * Env vars: DEPLOYER_PRIVATE_KEY, DIAMOND_ADDRESS
 *
 * Usage:
 *   forge script script/ReplaceStaleFacets.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract ReplaceStaleFacets is DeployDiamond {
    function run() external override {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // Same env-var-prefix normalisation as RedeployFacets — read
        // from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback rather than the bare DIAMOND_ADDRESS.
        runWith(Deployments.readDiamond(), deployerKey);
    }

    /**
     * @notice Parameterised entry — same body as {run}, with the target and the
     *         signer passed in rather than read from the environment.
     *
     * @dev    #1649. See the twin on `RedeployFacets`: this exists so the
     *         partial-refresh routing test can drive the REAL cut assembly
     *         against an in-process Diamond without `vm.setEnv`, which writes
     *         the process environment shared across parallel test threads.
     */
    function runWith(address diamond, uint256 deployerKey) public {
        console.log("Diamond:", diamond);

        vm.startBroadcast(deployerKey);

        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        // #1835 — the accept path's borrower-LIF charge now lives on its own
        // host. Deployed alongside because the two are one behaviour across a
        // `crossFacetCall`; see the cut below for why omitting it splits the
        // accept across two builds.
        OfferAcceptFeeFacet offerAcceptFeeFacet = new OfferAcceptFeeFacet();
        OracleFacet oracleFacet = new OracleFacet();
        VaultFactoryFacet vaultFactoryFacet = new VaultFactoryFacet();
        ConfigFacet configFacet = new ConfigFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        // #394 (Codex #647 round-3) — the numeraire / PAD / periodic-interest
        // selectors were carved out of ConfigFacet into NumeraireConfigFacet.
        // They must be cut to THIS facet's address, not ConfigFacet's, or they
        // misroute to ConfigFacet bytecode that no longer implements them.
        NumeraireConfigFacet numeraireConfigFacet = new NumeraireConfigFacet();
        // #1649 — #1503 gave the sale branch of `OfferAcceptFacet.acceptOffer`
        // (the binding check for a resting sale listing) a cross-facet call to
        // `RiskPreviewFacet.saleAdmission`, a NEW selector. Refreshing
        // OfferAcceptFacet without routing it installs an accept path that
        // calls an unrouted selector, so every listing accept reverts
        // `FunctionDoesNotExist` through the fallback — new code live and
        // broken. Deploy the classifier's host alongside; its selectors are
        // partitioned by live routing below.
        RiskPreviewFacet riskPreviewFacet = new RiskPreviewFacet();
        // #1649 — the read side of the same change. Refreshing the accept path
        // alone leaves `previewAccept` on bytecode that does not know about the
        // sale block, so it quotes an accept as fine and the transaction
        // reverts — the preview/accept divergence #1503 exists to remove.
        OfferPreviewFacet offerPreviewFacet = new OfferPreviewFacet();

        console.log("OfferFacet:          ", address(offerCreateFacet));
        console.log("OfferAcceptFacet:    ", address(offerAcceptFacet));
        console.log("OfferAcceptFeeFacet: ", address(offerAcceptFeeFacet));
        console.log("OracleFacet:         ", address(oracleFacet));
        console.log("VaultFactoryFacet:  ", address(vaultFactoryFacet));
        console.log("ConfigFacet:         ", address(configFacet));
        console.log("NumeraireConfigFacet:", address(numeraireConfigFacet));
        console.log("OracleAdminFacet:    ", address(oracleAdminFacet));
        console.log("RiskPreviewFacet:    ", address(riskPreviewFacet));
        console.log("OfferPreviewFacet:   ", address(offerPreviewFacet));

        // T-068: RewardReporterFacet is intentionally NOT refreshed here.
        // The LayerZero→CCIP migration changed its selector SET (removed
        // `setLocalEid`, renamed `setBaseEid`→`setBaseChainId`), and a
        // `Replace` cut cannot migrate a facet whose selector set changed
        // — that needs a Remove(old) + Add(new) migration, which a live
        // pre-T-068 diamond gets via the dedicated CCIP deploy/migration
        // path, not this one-off bytecode-refresh script.

        // #1649 — EVERY facet is now cut through one routing-partitioned
        // builder. Previously the script mixed unconditional `Replace` cuts
        // (OfferCreate / Oracle / Config-existing / OracleAdmin-existing) with
        // unconditional `Add` cuts (Config-missing / OracleAdmin-missing /
        // Numeraire), which hard-coded ONE target Diamond's shape — the
        // pre-split Sepolia deployment this script was originally written for.
        // Run against a CURRENT Diamond, those Adds reverted the whole cut with
        // "Can't add function that already exists", so the script was unusable
        // on any Diamond built by today's `DeployDiamond`.
        //
        // The hand-kept `Existing`/`Missing` selector helpers are GONE with them
        // (Codex #1635 r5). An earlier revision of this comment claimed their
        // union enumerated each facet's full surface; it did not — Config was 34
        // of 90, OracleAdmin 30 of 34, OfferCreate 4 of 7. Since a refresh
        // re-points only the selectors it names, the rest kept resolving to the
        // PREVIOUS facet address, leaving one logical facet split across two
        // builds while this script reported success. Every list now comes from
        // the inherited `DeployDiamond` getter that defines what the Diamond
        // routes, so the surface cannot be partial (#778/#779).
        //
        // Ten facets, so at most two cuts each; empty partitions are skipped
        // and the staging array is trimmed to what was actually used (a
        // zero-selector cut reverts).
        IDiamondCut.FacetCut[] memory staging = new IDiamondCut.FacetCut[](20);
        uint256 n;
        n = _appendPartitioned(
            staging, n, diamond, address(offerCreateFacet), _getOfferCreateSelectors()
        );
        n = _appendPartitioned(
            staging, n, diamond, address(oracleFacet), _getOracleSelectors()
        );
        // RL-1 (Codex #1302 P2) — the vault-factory list grows over time (it
        // gained `vaultCreditFromDiamondERC20`), so a blanket Replace would
        // revert on a Diamond that does not route a newly-added selector yet.
        n = _appendPartitioned(
            staging, n, diamond, address(vaultFactoryFacet), _getVaultFactorySelectors()
        );
        n = _appendPartitioned(
            staging, n, diamond, address(configFacet), _getConfigSelectors()
        );
        n = _appendPartitioned(
            staging, n, diamond, address(oracleAdminFacet), _getOracleAdminSelectors()
        );
        // #1352 (Codex P2) — this facet's surface mixes long-routed selectors
        // (`calculateTransactionValueNumeraire` / `verifyAndBindAccept`, live
        // since #627/#662) with newer ones, which is exactly what the partition
        // sorts out — no hand-kept "existing vs missing" split needed.
        n = _appendPartitioned(
            staging, n, diamond, address(offerAcceptFacet), _getOfferAcceptSelectors()
        );
        // #1835 — `chargeBorrowerLifAndDeliver` moved off `OfferAcceptFacet`
        // to its own host, so it is no longer in the list above. It must be
        // re-pointed HERE or the refresh leaves it on the OLD OfferAcceptFacet
        // address: the accept path would then self-call pre-split bytecode
        // while the rest of the accept ran the new build — one logical facet
        // across two versions, the #778/#779 failure this script exists to
        // prevent, arriving by the opposite door. The partition handles both
        // Diamonds: on a pre-split one the selector is routed (to the old
        // OfferAcceptFacet) so it emits a Replace onto the fee facet; on a
        // post-split one it is already here and the Replace is a no-op refresh.
        n = _appendPartitioned(
            staging,
            n,
            diamond,
            address(offerAcceptFeeFacet),
            _getOfferAcceptFeeSelectors()
        );
        // #394 (Codex #647 round-3) — the carved-out numeraire/PAD/periodic
        // selectors go to the NumeraireConfigFacet address, NOT ConfigFacet's:
        // routing them to ConfigFacet would point them at bytecode that no
        // longer implements them.
        n = _appendPartitioned(
            staging,
            n,
            diamond,
            address(numeraireConfigFacet),
            _getNumeraireConfigSelectors()
        );
        // #1649 — the sale classifier the refreshed accept path cross-calls. On
        // a pre-#1503 Diamond the seven older preview selectors are routed
        // (Replace) and `saleAdmission` is not (Add); the Add is the half that
        // keeps the refreshed `OfferAcceptFacet`'s sale branch from reverting.
        n = _appendPartitioned(
            staging,
            n,
            diamond,
            address(riskPreviewFacet),
            _getRiskPreviewFacetSelectors()
        );
        // #1649 — `previewAccept` was carved out of OfferAcceptFacet in #980, so
        // on a pre-#980 Diamond it is routed to the OLD host and this re-points
        // it; on a current one it is already this facet's selector.
        n = _appendPartitioned(
            staging, n, diamond, address(offerPreviewFacet), _getOfferPreviewSelectors()
        );

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](n);
        for (uint256 i; i < n; ++i) {
            cuts[i] = staging[i];
        }

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied; cuts:", n);
    }

    /**
     * @notice Append the Replace and/or Add cuts needed to point `selectors` at
     *         `facet`, choosing each action from the target Diamond's LIVE
     *         routing.
     *
     * @dev    #1649. The diamond library rejects both wrong guesses — `Add` on
     *         an already-routed selector and `Replace` on an unrouted one — and
     *         a cut carrying zero selectors also reverts, so an empty partition
     *         must be skipped rather than appended. Returns the new write index.
     */
    function _appendPartitioned(
        IDiamondCut.FacetCut[] memory staging,
        uint256 n,
        address diamond,
        address facet,
        bytes4[] memory selectors
    ) internal view returns (uint256) {
        (bytes4[] memory toAdd, bytes4[] memory toReplace) =
            _partitionByRouting(diamond, selectors);
        if (toReplace.length > 0) {
            staging[n++] = _replace(facet, toReplace);
        }
        if (toAdd.length > 0) {
            staging[n++] = _add(facet, toAdd);
        }
        return n;
    }

    function _add(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    function _replace(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });
    }

    /// @dev RL-1 (Codex #1302 P2) — split `selectors` into the subset the
    ///      live diamond already routes (safe to Replace) and the subset it
    ///      doesn't (must be Add — a Replace of an unrouted selector
    ///      reverts). Mirrors `RedeployFacets._partitionByRouting`.
    function _partitionByRouting(address diamond, bytes4[] memory selectors)
        internal
        view
        returns (bytes4[] memory toAdd, bytes4[] memory toReplace)
    {
        bool[] memory routed = new bool[](selectors.length);
        uint256 addN;
        uint256 replN;
        for (uint256 i; i < selectors.length; i++) {
            routed[i] =
                IDiamondLoupe(diamond).facetAddress(selectors[i]) != address(0);
            if (routed[i]) replN++;
            else addN++;
        }
        toAdd = new bytes4[](addN);
        toReplace = new bytes4[](replN);
        uint256 a;
        uint256 r;
        for (uint256 i; i < selectors.length; i++) {
            if (routed[i]) toReplace[r++] = selectors[i];
            else toAdd[a++] = selectors[i];
        }
    }

    // RewardReporterFacet selector helpers removed (T-068) — see the
    // note in `run()`: the eid→chainId migration changed the facet's
    // selector set, so a `Replace`-based refresh no longer applies.

}
