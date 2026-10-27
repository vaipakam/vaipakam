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

    // ─── PF-280: Stuck-Token Recovery (happy path) ────────────────────────────

    /// @dev A random USDC transfer lands directly on alice's vault
    ///      proxy (e.g., someone confused a contract address for a
    ///      wallet). The funds aren't accounted for in
    ///      `protocolTrackedVaultBalance` because they didn't flow
    ///      through the chokepoint, so they're "stuck" — the loan /
    ///      offer paths can't move them. alice notices via the Asset
    ///      Viewer page and uses the Recovery flow:
    ///        1. Look up `recoveryDomainSeparator()` + `recoveryNonce`.
    ///        2. Sign the EIP-712 `RecoveryAcknowledgment` for
    ///           (token, declaredSource, amount, deadline).
    ///        3. Call `recoverStuckERC20(token, declaredSource, amount,
    ///           deadline, signature)` with `declaredSource ≠ herself`
    ///           and not on the sanctions oracle.
    ///        4. Tokens transfer from her vault back to her wallet.
    ///
    ///      End-state: alice's wallet balance increases by the stray
    ///      amount; recovery nonce increments; no ban activates
    ///      (sanctioned-source path is PF-281, separate scenario).
    function _recoveryHappyPath() internal {
        // alice (borrower) needs an vault already created for the
        // stray transfer to have a target. createOffer is the simplest
        // way — she can cancel afterward to clean up. Faster: deposit
        // a token via a no-op deposit. Even faster: just call
        // `getOrCreateUserVault` from the Diamond's perspective.
        // We use a thin createOffer + cancelOffer dance to ensure the
        // vault proxy exists and alice is a known user.
        // Faster path actually used: lender or any other actor calls
        // getOrCreateUserVault on alice's behalf via cross-facet ...
        // but that's diamond-internal. So we use `createOffer` for
        // alice (we just need her vault to exist).
        //
        // Actually `getOrCreateUserVault` is publicly callable per
        // the deploy-script selector list — alice can call it
        // directly to provision her vault.
        vm.startBroadcast(borrowerKey);
        address aliceVault = VaultFactoryFacet(diamond).getOrCreateUserVault(borrower);
        vm.stopBroadcast();
        console.log("Alice vault:", aliceVault);

        // The stray sender — we use `newBorrower` to play the role of
        // the third party who accidentally transferred to alice's vault.
        // declaredSource in alice's recovery sig must match this address.
        uint256 strayAmount = 50e6; // 50 USDC stuck
        vm.startBroadcast(newBorrowerKey);
        usdc.transfer(aliceVault, strayAmount);
        vm.stopBroadcast();
        console.log("Stray USDC transferred to Alice's vault:", strayAmount);

        // Build the EIP-712 digest and sign. Recovery typehash:
        //   RecoveryAcknowledgment(address user, address token,
        //                          address declaredSource, uint256 amount,
        //                          uint256 nonce, uint256 deadline,
        //                          bytes32 ackTextHash)
        bytes32 recTypehash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 domainSep = VaultFactoryFacet(diamond).recoveryDomainSeparator();
        bytes32 ackText = VaultFactoryFacet(diamond).recoveryAckTextHash();
        uint256 nonce = VaultFactoryFacet(diamond).recoveryNonce(borrower);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                recTypehash,
                borrower,
                address(usdc),
                newBorrower, // declaredSource (the address that sent the stray)
                strayAmount,
                nonce,
                deadline,
                ackText
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Snapshot wallet balance pre-recovery.
        uint256 walletBefore = usdc.balanceOf(borrower);

        vm.startBroadcast(borrowerKey);
        VaultFactoryFacet(diamond).recoverStuckERC20(
            address(usdc),
            newBorrower,
            strayAmount,
            deadline,
            sig
        );
        vm.stopBroadcast();

        uint256 walletAfter = usdc.balanceOf(borrower);
        require(
            walletAfter == walletBefore + strayAmount,
            "PF-280: stray amount not recovered to wallet"
        );

        // Nonce should have incremented.
        uint256 nonceAfter = VaultFactoryFacet(diamond).recoveryNonce(borrower);
        require(nonceAfter == nonce + 1, "PF-280: recovery nonce did not increment");

        console.log("Recovered to wallet (delta):", strayAmount);
        console.log("Recovery nonce:", nonce, "->", nonceAfter);
    }

    // ─── PF-281: Stuck-Token Recovery — Sanctioned-Source Ban ────────────────

    /// @dev Same EIP-712 + recoverStuckERC20 path as PF-280, but the
    ///      `declaredSource` is on the sanctions oracle. Per T-054
    ///      design (`docs/DesignsAndPlans/VaultStuckRecoveryDesign.md`):
    ///        - oracle.isSanctioned(declaredSource) returns true
    ///        - recoverStuckERC20 does NOT execute (tokens stay)
    ///        - vaultBannedSource[user] is set to declaredSource
    ///        - VaultBannedFromRecoveryAttempt event is emitted
    ///        - subsequent recovery attempts revert until oracle un-flags
    ///
    ///      Scenario uses `newLender` as the user this time (clean
    ///      vault); `newBorrower` (already used in PF-280 as the stray
    ///      sender — clean address) is flagged on the oracle.
    function _recoverySanctionedBan() internal {
        address user = newLender;
        uint256 userKey = newLenderKey;
        // A dummy stray sender we flag, fresh on every run. The ban this
        // scenario records stays on `user`'s vault, so a fixed address would
        // make a second run on the same Diamond flag the source of the FIRST
        // run's ban, which sanctions `user` before it can sign the recovery.
        address strayer = address(uint160(uint256(keccak256(
            abi.encode("PF-281 stray source", block.chainid, block.number, block.timestamp)
        ))));

        // Provision user's vault.
        vm.startBroadcast(userKey);
        address userVault = VaultFactoryFacet(diamond).getOrCreateUserVault(user);
        vm.stopBroadcast();

        // Stray transfer from `strayer`. We don't have a key for the
        // dummy strayer address. Mint mock USDC directly into the
        // user's vault via the deployer (ERC20Mock allows public
        // mint). The source-of-funds is what gets attested to in the
        // EIP-712 sig, not the actual transfer path — what matters for
        // the test is that the vault has tokens NOT recorded in the
        // protocolTrackedVaultBalance counter.
        vm.startBroadcast(deployerKey);
        usdc.mint(userVault, 25e6);
        vm.stopBroadcast();
        console.log("Stray USDC parked in vault:", uint256(25e6));

        // Flag the strayer on the sanctions oracle.
        vm.startBroadcast(deployerKey);  // sanctions deployed by deployer in setup
        sanctions.setFlagged(strayer, true);
        vm.stopBroadcast();
        console.log("Flagged stray source on sanctions oracle:", strayer);

        // User signs recovery for the flagged source.
        bytes32 recTypehash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 domainSep = VaultFactoryFacet(diamond).recoveryDomainSeparator();
        bytes32 ackText = VaultFactoryFacet(diamond).recoveryAckTextHash();
        uint256 nonce = VaultFactoryFacet(diamond).recoveryNonce(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                recTypehash,
                user,
                address(usdc),
                strayer,
                uint256(25e6),
                nonce,
                deadline,
                ackText
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 walletBefore = usdc.balanceOf(user);
        uint256 vaultBefore = usdc.balanceOf(userVault);

        vm.startBroadcast(userKey);
        VaultFactoryFacet(diamond).recoverStuckERC20(
            address(usdc),
            strayer,
            25e6,
            deadline,
            sig
        );
        vm.stopBroadcast();

        // Verify ban activated, tokens stayed in vault, no transfer.
        require(
            usdc.balanceOf(user) == walletBefore,
            "PF-281: user wallet balance should be unchanged after sanctioned-ban"
        );
        require(
            usdc.balanceOf(userVault) == vaultBefore,
            "PF-281: vault balance should be unchanged after sanctioned-ban"
        );
        address ban = VaultFactoryFacet(diamond).vaultBannedSource(user);
        require(ban == strayer, "PF-281: vaultBannedSource should record the sanctioned source");

        // Nonce DOES increment on the sanctioned-ban path (per T-054
        // design — the call records state and burns the nonce so the
        // sig can't be replayed).
        uint256 nonceAfter = VaultFactoryFacet(diamond).recoveryNonce(user);
        require(nonceAfter == nonce + 1, "PF-281: nonce should increment on ban path");

        console.log("Banned source recorded:", ban);
        console.log("Nonce burned:", nonce, "->", nonceAfter);

        // T-054 auto-unlock: while the banned source remains flagged on
        // the oracle, `LibVaipakam.isSanctionedAddress(user)` returns
        // true via the source-tracked clause (LibVaipakam.sol:3288-3299).
        // Downstream scenarios (the operator scenarios) re-use `newLender` as a Tier-1
        // entry-point caller (createOffer, etc.), so de-list the
        // strayer here to lift the recovery-induced ban. This also
        // exercises the auto-unlock branch end-to-end.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(strayer, false);
        vm.stopBroadcast();
        require(
            !ProfileFacet(diamond).isSanctionedAddress(user),
            "PF-281: auto-unlock should clear newLender's recovery-induced ban"
        );
        console.log("Strayer de-listed; recovery-induced ban auto-unlocked for user");
    }

    // ─── PF-282: Disown Unsolicited Tokens ────────────────────────────────────

    /// @dev User's vault received tokens they don't want to claim
    ///      (event-only audit trail, no state mutation beyond the
    ///      event). Per Advanced Guide § Disowning unsolicited tokens.
    ///      Tier-2 entry point — sanctioned users can still disown
    ///      (it's purely informational, no funds move).
    function _disown() internal {
        // borrower's vault already has the recovered amount from PF-280
        // (recovery moved it to wallet); use newBorrower for a clean
        // disown event. They have no vault yet — disown takes a token
        // address only, so doesn't need an existing vault.
        vm.startBroadcast(newBorrowerKey);
        VaultFactoryFacet(diamond).disown(address(usdc));
        vm.stopBroadcast();

        // disown is event-only — no on-chain state to verify beyond the
        // event being emitted. The Anvil run captures it in the
        // broadcast logs; existence of a successful tx is the assertion.
        console.log("disown(USDC) by newBorrower emitted (audit-trail only)");
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
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
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
