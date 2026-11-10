// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {Vm} from "forge-std/Vm.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../../test/helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {ERC20Mock} from "../../test/mocks/ERC20Mock.sol";

/**
 * @title PositiveFlowsVaultAndVpfi
 * @notice Vault and VPFI flows (#848 Phase 1): stuck-token recovery, the
 *         sanctioned-source ban on recovery, disown, and VPFI deposit with
 *         fee-discount consent, a HoldOnly loan and a free-balance withdraw.
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsVaultAndVpfi is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsVaultAndVpfi";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](4);
        list[0] = Scenario("PF-280", "Recover an unsolicited ERC-20 from the vault with a signed acknowledgement",
            "PF-280");
        list[1] = Scenario("PF-281", "Recovery naming a sanctioned source records the ban and moves nothing",
            "PF-281");
        list[2] = Scenario("PF-282", "User disowns an unsolicited token",
            "PF-282");
        list[3] = Scenario("PF-250", "Deposit VPFI, consent to the discount, run a HoldOnly loan, withdraw free VPFI",
            "PF-250, PF-252, PF-251");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _recoveryHappyPath();
        else if (index == 1) _recoverySanctionedBan();
        else if (index == 2) _disown();
        else if (index == 3) _vpfiDepositDiscountWithdraw();
        else revert("PositiveFlowsVaultAndVpfi: no scenario at index");
    }

    /// @dev The mock VPFI token PF-250 wires on the Diamond for its run.
    ERC20Mock internal vpfi;

    /// @dev PF-250 is one sequence: the withdraw draws on the deposit, and
    ///      the Diamond's VPFI configuration is restored only after both.
    function _vpfiDepositDiscountWithdraw() internal {
        _vpfiDepositDiscount();
        _withdrawVpfi();
        _restoreVpfiConfig();
    }

    // ─── PF-280: Adopting an untracked asset (happy path) ─────────────────────

    /// @dev A stray USDC transfer lands directly on alice's vault proxy. It
    ///      did not arrive through the protocol, so it is outside the tracked
    ///      ledger and nothing can pay it out. alice adopts it:
    ///        1. Sign the EIP-712 adoption acknowledgement
    ///           (`VaultDepositoryFacet.adoptionDigest`) naming the sender.
    ///        2. Call `adoptUntracked` with a declared source that is not on
    ///           the sanctions list: the ledger is credited, nothing moves.
    ///        3. Withdraw it to her wallet through `withdrawFromVault`.
    ///
    ///      End-state: the wallet rises by the stray amount, the adoption
    ///      nonce increments, no ban (the sanctioned-source path is PF-281).
    function _recoveryHappyPath() internal {
        vm.startBroadcast(borrowerKey);
        address aliceVault = VaultFactoryFacet(diamond).getOrCreateUserVault(borrower);
        vm.stopBroadcast();
        console.log("Alice vault:", aliceVault);

        uint256 strayAmount = 50e6; // 50 USDC stuck
        vm.startBroadcast(newBorrowerKey);
        usdc.transfer(aliceVault, strayAmount);
        vm.stopBroadcast();
        console.log("Stray USDC transferred to Alice's vault:", strayAmount);

        VaultDepositoryFacet depo = VaultDepositoryFacet(diamond);
        uint8 kind = uint8(LibVaipakam.AssetType.ERC20);
        uint256 nonce = depo.adoptionNonce(borrower);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = depo.adoptionDigest(borrower, kind, address(usdc), 0, newBorrower, strayAmount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);

        uint256 walletBefore = usdc.balanceOf(borrower);
        vm.startBroadcast(borrowerKey);
        depo.adoptUntracked(kind, address(usdc), 0, strayAmount, newBorrower, deadline, abi.encodePacked(r, s, v));
        depo.withdrawFromVault(borrower, kind, address(usdc), 0, strayAmount, borrower);
        vm.stopBroadcast();

        require(usdc.balanceOf(borrower) == walletBefore + strayAmount, "PF-280: adopted amount not withdrawn to wallet");
        uint256 nonceAfter = depo.adoptionNonce(borrower);
        require(nonceAfter == nonce + 1, "PF-280: adoption nonce did not increment");
        console.log("Adopted and withdrawn (delta):", strayAmount);
        console.log("Adoption nonce:", nonce, "->", nonceAfter);
    }

    // ─── PF-281: Adopting from a sanctioned source — ban ─────────────────────

    /// @dev Same acknowledgement as PF-280, but the declared source is on the
    ///      sanctions list: the ledger is NOT credited, the vault records the
    ///      source as its ban (`vaultBannedSource`), the nonce is burned, and
    ///      the ban lifts by itself once the source is de-listed.
    function _recoverySanctionedBan() internal {
        address user = newLender;
        uint256 userKey = newLenderKey;
        // A fresh flagged source on every run, so a second run on the same
        // Diamond does not find `user` already banned by the first.
        address strayer = address(uint160(uint256(keccak256(
            abi.encode("PF-281 stray source", block.chainid, block.number, block.timestamp)
        ))));

        vm.startBroadcast(userKey);
        address userVault = VaultFactoryFacet(diamond).getOrCreateUserVault(user);
        vm.stopBroadcast();

        vm.startBroadcast(deployerKey);
        usdc.mint(userVault, 25e6);
        sanctions.setFlagged(strayer, true);
        vm.stopBroadcast();
        console.log("Flagged stray source on sanctions oracle:", strayer);

        VaultDepositoryFacet depo = VaultDepositoryFacet(diamond);
        uint8 kind = uint8(LibVaipakam.AssetType.ERC20);
        uint256 nonce = depo.adoptionNonce(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = depo.adoptionDigest(user, kind, address(usdc), 0, strayer, 25e6, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);

        vm.startBroadcast(userKey);
        depo.adoptUntracked(kind, address(usdc), 0, 25e6, strayer, deadline, abi.encodePacked(r, s, v));
        vm.stopBroadcast();

        require(
            VaultFactoryFacet(diamond).getTrackedHolding(user, address(usdc), 0) == 0,
            "PF-281: a banned adoption must not credit the ledger"
        );
        require(depo.vaultBannedSource(user) == strayer, "PF-281: vaultBannedSource should record the sanctioned source");
        require(depo.adoptionNonce(user) == nonce + 1, "PF-281: nonce should increment on ban path");

        // Later scenarios reuse `newLender` as a Tier-1 caller, so de-list the
        // source: this also drives the ban's auto-unlock end to end.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(strayer, false);
        vm.stopBroadcast();
        require(
            !ProfileFacet(diamond).isSanctionedAddress(user),
            "PF-281: auto-unlock should clear newLender's adoption-induced ban"
        );
        console.log("Strayer de-listed; adoption-induced ban auto-unlocked for user");
    }

    // ─── PF-282: Disown an untracked asset ────────────────────────────────────

    /// @dev Event-only: the owner publicly disowns an untracked asset in their
    ///      vault without adopting it. Tier-2: a sanctioned user may still
    ///      disown. Uses newLender's vault, which still holds PF-281's
    ///      unadopted USDC.
    function _disown() internal {
        vm.startBroadcast(newLenderKey);
        VaultDepositoryFacet(diamond).disownUntracked(uint8(LibVaipakam.AssetType.ERC20), address(usdc), 0);
        vm.stopBroadcast();
        console.log("disownUntracked(USDC) by newLender emitted (audit-trail only)");
    }

    // ─── PF-250: VPFI Deposit + Fee-Discount consent + HoldOnly loan ────────

    /// @dev End-to-end borrower VPFI fee-discount flow under HoldOnly (#1352):
    ///        1. Deploy a VPFI ERC20 mock; admin sets it on the
    ///           diamond via `VPFITokenFacet.setVPFIToken` and
    ///           configures the discount conversion (fixed wei-per-VPFI
    ///           rate + ETH price reference asset = WETH).
    ///        2. Mint 5,000 VPFI to borrower.
    ///        3. Borrower approves diamond, deposits 2,000 VPFI to vault
    ///           via `depositVPFIToVault`, then opts in via
    ///           `setVPFIDiscountConsent(true)`.
    ///        4. Lender + borrower take a normal loan. The borrower's
    ///           hold-tier discount, when one resolves, is applied
    ///           DIRECTLY to the lending-asset LIF at acceptance; no VPFI
    ///           leaves the borrower's vault for the LIF.
    ///        5. Borrower repays and both sides claim.
    ///
    ///      **Required assertion: the borrower's vault VPFI is unchanged
    ///      across acceptance and the claims.** The LIF never moves VPFI and
    ///      there is no borrower VPFI rebate to pay (the peg-custody path was
    ///      removed in #1980). This drive never sets `isCanonicalVpfiChain`,
    ///      so the effective tier reads zero here; the discount arithmetic
    ///      itself is covered by the focused unit tests, not by this drive.
    // ─── VPFI-config snapshot (taken when PF-250 starts, restored at its end) ───
    //
    // PF-250's deposit, discount and withdraw steps need the mock VPFI token
    // wired on the Diamond throughout, so the Diamond's own VPFI config is
    // snapshotted before the first step and restored by
    // `_restoreVpfiConfig` after the last. On a fresh Anvil Diamond every
    // saved slot is zero/false and the restore collapses to no-ops; on a
    // rehearsal Diamond the saved token, rate and reference asset are put
    // back so the chain's own VPFI configuration is in place after the run.
    address private _savedVpfiToken;
    uint256 private _savedVpfiRate;
    address private _savedVpfiEthRefAsset;
    bool private _savedVpfiBorrowerConsent;
    bool private _vpfiSnapshotTaken;

    function _vpfiDepositDiscount() internal {
        // Snapshot — see _restoreVpfiConfig() called after PF-250 withdraw.
        _savedVpfiToken = VPFITokenFacet(diamond).getVPFIToken();
        (_savedVpfiRate, _savedVpfiEthRefAsset) =
            VPFIDiscountFacet(diamond).getVPFIDiscountConfig();
        _savedVpfiBorrowerConsent =
            VPFIDiscountFacet(diamond).getVPFIDiscountConsent(borrower);
        _vpfiSnapshotTaken = true;

        // Step 1: deploy VPFI mock + admin wires it.
        vm.startBroadcast(deployerKey);
        vpfi = new ERC20Mock("Vaipakam VPFI", "VPFI", 18);
        vpfi.mint(borrower, 5_000e18);
        vm.stopBroadcast();
        console.log("VPFI deployed:", address(vpfi));

        vm.startBroadcast(adminKey);
        VPFITokenFacet(diamond).setVPFIToken(address(vpfi));
        // The discount quote anchor: 0.001 ETH per VPFI, so with the mock
        // WETH at $2000 the discount math values 1 VPFI at $2. It is the
        // fee-discount conversion only; there is no protocol VPFI sale.
        VPFIDiscountFacet(diamond).setVPFIDiscountRate(1e15);
        // ETH-priced reference asset for the LIF→VPFI conversion.
        // WETH on this chain has the Chainlink feed wired in setup.
        VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(address(weth));
        vm.stopBroadcast();
        console.log("Diamond VPFI configured: token + discount anchor + ETH ref asset");

        // Step 3: borrower deposits 2,000 VPFI (Tier-2, 15% band) and
        // opts in. Use `depositVPFIToVault` (the Phase 5 chokepoint
        // that ticks `protocolTrackedVaultBalance` for VPFI).
        vm.startBroadcast(borrowerKey);
        vpfi.approve(diamond, 2_000e18);
        VPFIDiscountFacet(diamond).depositVPFIToVault(2_000e18);
        VPFIDiscountFacet(diamond).setVPFIDiscountConsent(true);
        vm.stopBroadcast();
        console.log("Borrower deposited 2,000 VPFI + opted in to discount path");

        // Clear the min-history gate so the drive runs the accept with a
        // holding that has lasted the minimum period (default three days).
        vm.warp(block.timestamp + 4 days);

        address borrowerVault = VaultFactoryFacet(diamond).getUserVaultAddress(borrower);
        uint256 vaultVpfiBefore = vpfi.balanceOf(borrowerVault);

        // Step 4: take a loan.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard(), type(uint64).max);
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t9 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig9 = LibAcceptTestSigner.sign(diamond, _t9, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t9, _sig9);
        vm.stopBroadcast();
        console.log("Loan initiated under HoldOnly borrower LIF:", loanId);
        require(
            vpfi.balanceOf(borrowerVault) == vaultVpfiBefore,
            "PF-250: the LIF must move no VPFI from the borrower's vault"
        );

        // Step 5: repay, then both sides claim.
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId);
        require(
            vpfi.balanceOf(borrowerVault) == vaultVpfiBefore,
            "PF-250: closing the loan must move no VPFI either"
        );
        console.log("Asserted: borrower vault VPFI unchanged across the loan");
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "PF-250: loan should be settled post-repay"
        );
    }

    /// @dev Restore the VPFI-discount config to its state before PF-250.
    ///      Called by `_vpfiDepositDiscountWithdraw` after the withdraw step,
    ///      because every step before it needs the mock VPFI wired on the
    ///      Diamond. On a fresh Anvil Diamond every saved slot is zero/false
    ///      and the restore is a sequence of no-ops; on a rehearsal Diamond
    ///      the saved token, rate and reference asset are re-applied.
    ///
    ///      `setVPFIToken(0x0)` reverts `InvalidAddress`, so the
    ///      token restore is guarded by a non-zero check — on a
    ///      throwaway anvil chain we simply leave the mock VPFI
    ///      wired (no canonical exists to point at anyway), which
    ///      is fine since anvil state doesn't survive the run.
    ///      `setVPFIDiscountRate(0)` and `setVPFIDiscountETHPriceAsset(0)`
    ///      accept zero (intentional "disable" semantics), so they
    ///      can be restored unconditionally.
    function _restoreVpfiConfig() internal {
        if (!_vpfiSnapshotTaken) return;
        vm.startBroadcast(adminKey);
        if (_savedVpfiToken != address(0)) {
            VPFITokenFacet(diamond).setVPFIToken(_savedVpfiToken);
        }
        VPFIDiscountFacet(diamond).setVPFIDiscountRate(_savedVpfiRate);
        VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(
            _savedVpfiEthRefAsset
        );
        vm.stopBroadcast();
        if (!_savedVpfiBorrowerConsent) {
            vm.startBroadcast(borrowerKey);
            VPFIDiscountFacet(diamond).setVPFIDiscountConsent(false);
            vm.stopBroadcast();
        }
        console.log("VPFI config from before PF-250 restored.");
    }

    // ─── PF-250: Withdraw VPFI (from vault) ───────────────────────

    /// @dev PF-250 left ~2,000 VPFI (Tier-2) in `borrower`'s vault. Withdraw by
    ///      calling `withdrawVPFIFromVault` and verify the wallet grows by the
    ///      withdrawn amount. This also exercises T-051's
    ///      `protocolTrackedVaultBalance` decrement on the VPFI side.
    ///      (#687-B: the staked-counter assertion was removed with the 5%
    ///      staking yield; the wallet-delta assertion is the live observable.)
    function _withdrawVpfi() internal {
        uint256 walletBefore = vpfi.balanceOf(borrower);

        // Withdraw a fixed amount strictly smaller than the 2,000 VPFI PF-250
        // deposited. A partial-but-known-safe amount sidesteps the exact-
        // balance race where a 1-wei broadcast-time divergence reverts.
        uint256 withdrawAmt = 1_000e18;

        vm.startBroadcast(borrowerKey);
        VPFIDiscountFacet(diamond).withdrawVPFIFromVault(withdrawAmt);
        vm.stopBroadcast();

        uint256 walletAfter = vpfi.balanceOf(borrower);
        console.log("VPFI wallet pre / post:", walletBefore, walletAfter);

        require(
            walletAfter == walletBefore + withdrawAmt,
            "PF-250: wallet should grow by exactly the withdrawn amount"
        );

    }
}
