// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {ERC20Mock} from "../../test/mocks/ERC20Mock.sol";
import {MockSanctionsList} from "../../test/mocks/MockSanctionsList.sol";

/**
 * @title PositiveFlowsVaultAndVpfi
 * @notice Vault and VPFI flows (#848 Phase 1): stuck-token recovery, the
 *         sanctioned-source ban on recovery, disown, and VPFI deposit with
 *         fee-discount consent, a HoldOnly loan and a free-balance withdraw.
 *
 *         Staged (#3574). The recovery scenarios take one step each. PF-250
 *         takes two: the first funds the borrower in a mock VPFI token
 *         (registering one only on a Diamond that has none, never rotating
 *         a registered token), deposits and consents, and posts the
 *         lender's offer; the second, once the deposit has been held the
 *         Diamond's minimum staking period plus a day
 *         (`getTwaConfig().minStakedDays`), opens the loan, closes it,
 *         withdraws free VPFI and puts the discount configuration back.
 *         Every setting a scenario changes is recorded to put back (PF-281's
 *         flagged source, and PF-250's discount rate, ETH reference asset
 *         and the borrower's consent), so `unwind()` restores what an
 *         abandoned run left changed, and `finish()` refuses while any is.
 *         A mock VPFI registered on a Diamond that had no token stays
 *         registered: the setter refuses the zero address, and a later
 *         rotation away from it could not be undone. `run()` is the simulation and
 *         `stage()` the broadcastable run ({PositiveFlowsStaged},
 *         `script/positive-flows/run-staged.sh`).
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsVaultAndVpfi is PositiveFlowsStaged {
    /// @dev Values PF-250's first step leaves for its second.
    string private constant OFFER = "offer";
    string private constant VPFI_MOCK = "vpfiMock";

    /// @dev Settings to put back, recorded before the step that changes them.
    /// @dev PF-281's flagged source: put back means the oracle no longer flags it.
    string private constant STRAY_SOURCE_FLAG = "straySourceFlag";
    /// @dev The discount rate before PF-250 (wei per VPFI; 0 = disabled).
    string private constant VPFI_DISCOUNT_RATE = "vpfiDiscountRate";
    /// @dev The discount's ETH reference asset before PF-250.
    string private constant VPFI_ETH_REF_ASSET = "vpfiEthRefAsset";
    /// @dev The borrower, recorded only when it had not consented before
    ///      PF-250: put back means its consent is off again.
    string private constant VPFI_CONSENT = "vpfiConsent";

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

    /// @dev PF-250 sets up and posts, then fills; the others take one step.
    function _stepCount(uint256 index) internal pure override returns (uint256) {
        return index == 3 ? 2 : 1;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index == 0) return _recoveryHappyPath();
        if (index == 1) return _recoverySanctionedBan();
        if (index == 2) return _disown();
        if (index == 3) {
            if (step == 0) return _vpfiDepositAndPost();
            // PF-250 is one sequence: the withdraw draws on the deposit, and
            // the Diamond's VPFI configuration is restored only after both.
            vpfi = ERC20Mock(address(uint160(_kept(VPFI_MOCK))));
            _vpfiLoanUnderDiscount(_kept(OFFER));
            _withdrawVpfi();
            return _restoreVpfiConfig();
        }
        revert("PositiveFlowsVaultAndVpfi: no scenario at index");
    }

    // ─── Settings to put back ─────────────────────────────────────────────

    function _stillToRestore(string memory name, uint256 value) internal view override returns (bool) {
        address a = address(uint160(value));
        if (_eq(name, STRAY_SOURCE_FLAG)) return ProfileFacet(diamond).isSanctionedAddress(a);
        if (_eq(name, VPFI_DISCOUNT_RATE)) {
            (uint256 rate,) = VPFIDiscountFacet(diamond).getVPFIDiscountConfig();
            return rate != value;
        }
        if (_eq(name, VPFI_ETH_REF_ASSET)) {
            (, address ref) = VPFIDiscountFacet(diamond).getVPFIDiscountConfig();
            return ref != a;
        }
        if (_eq(name, VPFI_CONSENT)) return VPFIDiscountFacet(diamond).getVPFIDiscountConsent(a);
        return super._stillToRestore(name, value);
    }

    function _restore(string memory name, uint256 value) internal override {
        address a = address(uint160(value));
        if (_eq(name, STRAY_SOURCE_FLAG)) {
            // The oracle the Diamond reads is the fixture's mock, which anyone
            // may set; read from the Diamond so unwind needs only the chain.
            vm.startBroadcast(deployerKey);
            MockSanctionsList(ProfileFacet(diamond).getSanctionsOracle()).setFlagged(a, false);
            vm.stopBroadcast();
            return;
        }
        if (_eq(name, VPFI_CONSENT)) {
            // Recorded only for the borrower, PF-250's only consenting party.
            require(a == borrower, "PositiveFlowsVaultAndVpfi: consent recorded for an unknown wallet");
            vm.startBroadcast(borrowerKey);
            VPFIDiscountFacet(diamond).setVPFIDiscountConsent(false);
            vm.stopBroadcast();
            return;
        }
        if (_eq(name, VPFI_DISCOUNT_RATE) || _eq(name, VPFI_ETH_REF_ASSET)) {
            vm.startBroadcast(adminKey);
            if (_eq(name, VPFI_DISCOUNT_RATE)) VPFIDiscountFacet(diamond).setVPFIDiscountRate(value);
            else VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(a);
            vm.stopBroadcast();
            return;
        }
        super._restore(name, value);
    }

    /// @dev The mock VPFI token PF-250 wires on the Diamond for its run.
    ERC20Mock internal vpfi;

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

        _toRestore(STRAY_SOURCE_FLAG, uint256(uint160(strayer)));
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
    ///        4. Lender + borrower take a normal loan, a step later, once the
    ///           holding has lasted the minimum staking period. The
    ///           borrower's hold-tier discount, when one resolves, is applied
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
    ///
    ///      THE DIAMOND'S VPFI TOKEN IS NEVER ROTATED. A rotation is not
    ///      undoable: it archives the deposit epoch and clears every service
    ///      capacity curve (`LibServiceCapacity.onTokenRotated`), and setting
    ///      the old token back is a second rotation that restores neither. So
    ///      the scenario registers a mock VPFI only on a Diamond that has no
    ///      token (a first registration archives and clears nothing), and
    ///      that mock then stays registered, since the setter refuses the zero
    ///      address. On a Diamond whose token is already a mock anyone may
    ///      mint ({ERC20Mock}, as an earlier run of this scenario leaves), it
    ///      mints into that one. Any other registered token is left alone and
    ///      the scenario is skipped, saying why.
    ///
    ///      The discount rate, reference asset and the borrower's consent are
    ///      recorded before they change and put back after the withdraw
    ///      ({_restoreVpfiConfig}).
    function _vpfiDepositAndPost() internal {
        address registered = VPFITokenFacet(diamond).getVPFIToken();
        if (registered != address(0) && registered.codehash != keccak256(type(ERC20Mock).runtimeCode)) {
            return _skip("the Diamond's VPFI token is not a mintable mock, and rotating it cannot be undone");
        }
        (uint256 savedRate, address savedRef) = VPFIDiscountFacet(diamond).getVPFIDiscountConfig();
        _toRestore(VPFI_DISCOUNT_RATE, savedRate);
        _toRestore(VPFI_ETH_REF_ASSET, uint256(uint160(savedRef)));
        if (!VPFIDiscountFacet(diamond).getVPFIDiscountConsent(borrower)) {
            _toRestore(VPFI_CONSENT, uint256(uint160(borrower)));
        }

        // Step 1: the mock VPFI (registered on a Diamond with none) and the
        // borrower's balance in it.
        vm.startBroadcast(deployerKey);
        vpfi = registered == address(0) ? new ERC20Mock("Vaipakam VPFI", "VPFI", 18) : ERC20Mock(registered);
        vpfi.mint(borrower, 5_000e18);
        vm.stopBroadcast();
        _keep(VPFI_MOCK, uint256(uint160(address(vpfi))));
        console.log("VPFI mock:", address(vpfi));

        vm.startBroadcast(adminKey);
        if (registered == address(0)) VPFITokenFacet(diamond).setVPFIToken(address(vpfi));
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

        // The lender's offer for the next step, which runs once the holding
        // has lasted the Diamond's minimum staking period, plus a day.
        _keep(OFFER, _createLenderOffer(lenderKey));
        _nextStepNotBefore(
            block.timestamp + (uint256(VPFIDiscountFacet(diamond).getTwaConfig().minStakedDays) + 1) * 1 days
        );
    }

    /// @dev Steps 4 and 5: open the loan on `offerId`, close it, and show the
    ///      borrower's vault VPFI did not move.
    function _vpfiLoanUnderDiscount(uint256 offerId) internal {
        address borrowerVault = VaultFactoryFacet(diamond).getUserVaultAddress(borrower);
        uint256 vaultVpfiBefore = vpfi.balanceOf(borrowerVault);

        // Step 4: take a loan.
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
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

    /// @dev Puts back the VPFI settings PF-250's first step recorded, each
    ///      only when the chain still shows it changed: the same rule as
    ///      `unwind()`, so a restore never sends a no-op the setter refuses.
    function _restoreVpfiConfig() internal {
        string[3] memory names = [VPFI_DISCOUNT_RATE, VPFI_ETH_REF_ASSET, VPFI_CONSENT];
        for (uint256 i = 0; i < names.length; i++) {
            if (!_restoreRecorded(names[i])) continue;
            uint256 value = _restoreValueOf(names[i]);
            if (_stillToRestore(names[i], value)) _restore(names[i], value);
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
