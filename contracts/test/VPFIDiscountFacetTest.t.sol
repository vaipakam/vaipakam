// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title VPFIDiscountFacetTest
/// @notice Exercises the borrower VPFI discount mechanism end-to-end
///         (docs/TokenomicsTechSpec.md):
///          - canonical-chain-only fixed-rate ETH → VPFI buy
///          - cap + kill-switch + reserve guards
///          - bridge-then-deposit helper
///          - quote view
///          - OfferFacet.acceptOffer discount path gated by the platform-
///            level VPFI-discount consent flag (happy + silent-fallback
///            branches)
///          - emitDiscountApplied access gating
contract VPFIDiscountFacetTest is SetupTest {
    VPFIDiscountFacet internal vpfiDiscountFacet;
    VPFIToken internal vpfiToken;
    ERC20Mock internal weth; // ETH price-reference asset

    // Rate: 1 VPFI = 0.001 ETH  → 1e15 wei per VPFI (18 dec).
    uint256 internal constant RATE_WEI_PER_VPFI = 1e15;
    uint256 internal constant GLOBAL_CAP = 200_000 ether;
    uint256 internal constant WALLET_CAP = 2_000 ether;

    // Price constants for the conversion chain. mockERC20 is the lending
    // asset (already priced in SetupTest at $1 with 8 decimals). WETH is
    // set to $2000 with 8 decimals so the USD→ETH leg produces a sane,
    // non-zero feeWei under default fuzz inputs.
    uint256 internal constant ETH_USD_PRICE = 2000e8;

    address internal treasuryRecipient;
    address internal buyer;

    event VPFIPurchasedWithETH(
        address indexed buyer,
        uint256 vpfiAmount,
        uint256 ethAmount
    );
    event VPFIDepositedToEscrow(address indexed user, uint256 amount);
    event VPFIDiscountApplied(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );
    event VPFIYieldFeeDiscountApplied(
        uint256 indexed loanId,
        address indexed lender,
        address indexed lendingAsset,
        uint256 vpfiDeducted
    );

    function setUp() public {
        setupHelper();

        // Point the protocol's treasury at a real address so buy-path ETH
        // forwards don't clash with the diamond balance assertions.
        treasuryRecipient = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        // Deploy VPFI token behind an ERC1967 proxy (UUPS).
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        // Register VPFI on the diamond + mark this chain as canonical so
        // buyVPFIWithETH is permitted. Fund the diamond's reserve with the
        // full global cap + some slack.
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        vpfiToken.transfer(address(diamond), GLOBAL_CAP + 1_000 ether);

        // Give `lender`/`borrower` some VPFI in their wallets for deposit
        // + discount tests.
        vpfiToken.transfer(lender, 5_000 ether);
        vpfiToken.transfer(borrower, 5_000 ether);

        // Deploy + cut VPFIDiscountFacet in. SetupTest does not include it.
        vpfiDiscountFacet = new VPFIDiscountFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiDiscountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Configure buy-side parameters + ETH reference asset.
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);
        _facet().setVPFIBuyRate(RATE_WEI_PER_VPFI);
        _facet().setVPFIBuyCaps(GLOBAL_CAP, WALLET_CAP);
        // Stamp `s.localEid` before enabling the buy switch — the
        // canonical-chain direct-buy path now reverts
        // `VPFICanonicalEidNotSet` when `localEid == 0`, because the
        // per-(buyer, originEid) cap bucket would otherwise land in
        // bucket 0 while the frontend reads the chain-registry eid
        // (#00010 hardening). Use Base mainnet's eid here since the
        // test simulates the canonical Base Diamond.
        TestMutatorFacet(address(diamond)).setLocalEidForTest(30184);
        _facet().setVPFIBuyEnabled(true);
        _facet().setVPFIDiscountETHPriceAsset(address(weth));

        // Mock the WETH oracle feed. SetupTest already mocks mockERC20 at
        // $1/8dec; we overlay a WETH feed at $2000/8dec.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, address(weth)),
            abi.encode(ETH_USD_PRICE, uint8(8))
        );

        buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);
    }

    // ─── Shorthand ───────────────────────────────────────────────────────────

    function _facet() internal view returns (VPFIDiscountFacet) {
        return VPFIDiscountFacet(address(diamond));
    }

    function _buyerEscrow(address user) internal returns (address) {
        return EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user);
    }

    // ─── buyVPFIWithETH ──────────────────────────────────────────────────────

    function testBuyVPFIWithETHHappyPath() public {
        uint256 sendValue = 1 ether; // → 1000 VPFI at 1e15 wei each
        uint256 expectedVpfi = (sendValue * 1e18) / RATE_WEI_PER_VPFI;

        vm.expectEmit(true, false, false, true, address(diamond));
        emit VPFIPurchasedWithETH(buyer, expectedVpfi, sendValue);

        uint256 buyerBalBefore = vpfiToken.balanceOf(buyer);

        vm.prank(buyer);
        _facet().buyVPFIWithETH{value: sendValue}();

        // Per spec: VPFI is credited to the buyer's wallet, NOT auto-deposited
        // into escrow. Funding escrow is a separate explicit user action.
        assertEq(
            vpfiToken.balanceOf(buyer) - buyerBalBefore,
            expectedVpfi,
            "buyer wallet credited"
        );
        // Escrow proxy was not created implicitly either.
        assertEq(
            vpfiToken.balanceOf(_buyerEscrow(buyer)),
            0,
            "escrow untouched on buy"
        );
        assertEq(treasuryRecipient.balance, sendValue, "treasury received ETH");
        assertEq(_facet().getVPFISoldTo(buyer), expectedVpfi, "per-wallet tally");
    }

    function testBuyVPFIRevertsWhenNotCanonical() public {
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(false);
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.NotCanonicalVPFIChain.selector);
        _facet().buyVPFIWithETH{value: 1 ether}();
    }

    function testBuyVPFIRevertsWhenDisabled() public {
        _facet().setVPFIBuyEnabled(false);
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIBuyDisabled.selector);
        _facet().buyVPFIWithETH{value: 1 ether}();
    }

    function testBuyVPFIRevertsWhenRateNotSet() public {
        _facet().setVPFIBuyRate(0);
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIBuyRateNotSet.selector);
        _facet().buyVPFIWithETH{value: 1 ether}();
    }

    /// @notice #00010 hardening — direct buy must revert when
    ///         `s.localEid` is unset, otherwise the on-chain bucket
    ///         debit (eid 0) would silently desync from the
    ///         frontend's per-chain reads (eid 30184 / 40245 / …).
    function testBuyVPFIRevertsWhenLocalEidUnset() public {
        // Roll localEid back to 0 so we can exercise the revert. The
        // shared setUp stamps a non-zero eid before flipping the buy
        // switch on; this test undoes that for the negative path only.
        TestMutatorFacet(address(diamond)).setLocalEidForTest(0);
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFICanonicalEidNotSet.selector);
        _facet().buyVPFIWithETH{value: 1 ether}();
    }

    function testBuyVPFIRevertsOnZeroValue() public {
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        _facet().buyVPFIWithETH{value: 0}();
    }

    function testBuyVPFIRevertsWhenAmountRoundsToZero() public {
        // With weiPerVpfi == 1e15, any msg.value < 1e-3 wei would round to
        // zero VPFI. Set a much larger rate so a realistic msg.value rounds
        // down to zero.
        _facet().setVPFIBuyRate(10 ether);
        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIBuyAmountTooSmall.selector);
        _facet().buyVPFIWithETH{value: 1}();
    }

    function testBuyVPFIRevertsOnPerWalletCap() public {
        // Buy up to the wallet cap, then one more wei of VPFI should break.
        uint256 capEth = (WALLET_CAP * RATE_WEI_PER_VPFI) / 1e18;
        vm.deal(buyer, capEth + 1 ether);
        vm.prank(buyer);
        _facet().buyVPFIWithETH{value: capEth}();

        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIPerWalletCapExceeded.selector);
        _facet().buyVPFIWithETH{value: RATE_WEI_PER_VPFI}();
    }

    function testBuyVPFIRevertsOnGlobalCap() public {
        // Push wallet cap above global cap so the global gate fires first.
        _facet().setVPFIBuyCaps(WALLET_CAP, GLOBAL_CAP + 1 ether);

        uint256 globalCapEth = (WALLET_CAP * RATE_WEI_PER_VPFI) / 1e18;
        vm.deal(buyer, globalCapEth + 1 ether);

        // Drain the wallet cap by buying from a series of addresses isn't
        // necessary; we just raise the per-wallet cap above the global cap
        // and drive total sold to the global cap from a single wallet.
        _facet().setVPFIBuyCaps(GLOBAL_CAP, GLOBAL_CAP + 1 ether);
        uint256 fullCapEth = (GLOBAL_CAP * RATE_WEI_PER_VPFI) / 1e18;
        vm.deal(buyer, fullCapEth + 1 ether);
        vm.prank(buyer);
        _facet().buyVPFIWithETH{value: fullCapEth}();

        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIGlobalCapExceeded.selector);
        _facet().buyVPFIWithETH{value: RATE_WEI_PER_VPFI}();
    }

    // ─── Zero-fallback cap semantics (spec §8 / §8a) ─────────────────────────

    function testGetVPFIBuyConfigReturnsSpecDefaultsWhenStoredCapsZero() public {
        // Reset both caps to 0 — the on-chain getter must resolve them to
        // the spec defaults (docs/TokenomicsTechSpec.md §8 / §8a), never
        // "uncapped".
        _facet().setVPFIBuyCaps(0, 0);
        (, uint256 globalCap, uint256 perWalletCap, , , ) = _facet()
            .getVPFIBuyConfig();
        assertEq(
            globalCap,
            LibVaipakam.VPFI_FIXED_GLOBAL_CAP,
            "zero stored global cap resolves to spec default (2.3M VPFI)"
        );
        assertEq(
            perWalletCap,
            LibVaipakam.VPFI_FIXED_WALLET_CAP,
            "zero stored per-wallet cap resolves to spec default (30k VPFI)"
        );
    }

    function testBuyVPFIRevertsAtDefaultPerWalletCapWhenStoredZero() public {
        // With both caps stored as 0, the effective per-wallet cap is the
        // 30k VPFI spec default. Drive a buy up to that cap and confirm the
        // next wei reverts — zero-fallback is enforced, not uncapped.
        _facet().setVPFIBuyCaps(0, 0);
        uint256 defaultWalletCap = LibVaipakam.VPFI_FIXED_WALLET_CAP;
        uint256 capEth = (defaultWalletCap * RATE_WEI_PER_VPFI) / 1e18;
        vm.deal(buyer, capEth + 1 ether);

        vm.prank(buyer);
        _facet().buyVPFIWithETH{value: capEth}();
        assertEq(
            _facet().getVPFISoldTo(buyer),
            defaultWalletCap,
            "wallet tally reached 30k default"
        );

        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIPerWalletCapExceeded.selector);
        _facet().buyVPFIWithETH{value: RATE_WEI_PER_VPFI}();
    }

    function testBuyVPFIRevertsWhenReserveInsufficient() public {
        // Pull the diamond's VPFI reserve out so the on-hand balance is
        // lower than the buy-out amount.
        address treasury2 = makeAddr("treasury2");
        AdminFacet(address(diamond)).setTreasury(treasury2);
        uint256 diamondBal = vpfiToken.balanceOf(address(diamond));
        TreasuryFacet(address(diamond)).claimTreasuryFees; // silence unused lint
        // Easiest way: transfer diamond's reserve to someone else via a
        // direct vm.prank-free bridge — just call the token directly as
        // the Diamond via low-level call is unavailable. Use vm.store to
        // zero it.
        vm.prank(address(diamond));
        vpfiToken.transfer(treasury2, diamondBal);

        vm.prank(buyer);
        vm.expectRevert(IVaipakamErrors.VPFIReserveInsufficient.selector);
        _facet().buyVPFIWithETH{value: 1 ether}();
    }

    // ─── depositVPFIToEscrow ─────────────────────────────────────────────────

    function testDepositVPFIToEscrowHappyPath() public {
        uint256 amount = 100 ether;
        vm.prank(borrower);
        vpfiToken.approve(address(diamond), amount);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit VPFIDepositedToEscrow(borrower, amount);

        vm.prank(borrower);
        _facet().depositVPFIToEscrow(amount);

        address escrow = _buyerEscrow(borrower);
        assertEq(vpfiToken.balanceOf(escrow), amount);
    }

    function testDepositVPFIToEscrowRevertsOnZero() public {
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        _facet().depositVPFIToEscrow(0);
    }

    // ─── quoteVPFIDiscount ───────────────────────────────────────────────────

    function testQuoteVPFIDiscountForLenderOfferWithKnownBorrower() public {
        // For a Lender offer the borrower is unknown at the base view — use
        // the acceptor-aware {quoteVPFIDiscountFor}. Pre-fund borrower escrow
        // to tier 1 (>= 100 VPFI) so the tier gate does not short-circuit.
        uint256 offerId = _createLenderERC20Offer(10_000 ether);
        address borrowerEscrow = _buyerEscrow(borrower);
        vpfiToken.transfer(borrowerEscrow, 500 ether); // tier 1

        (bool eligible, uint256 vpfi, uint256 bal, uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertTrue(eligible, "eligible");
        assertGt(vpfi, 0, "vpfi required non-zero");
        assertEq(bal, 500 ether, "surfaces borrower escrow VPFI balance");
        assertEq(tier, 1, "tier 1");

        // Base view surfaces (false, 0, 0, 0) for Lender offers because the
        // acceptor is unknown at quote time.
        (bool eligibleBase, , , uint8 tierBase) = _facet().quoteVPFIDiscount(
            offerId
        );
        assertFalse(eligibleBase);
        assertEq(tierBase, 0);
    }

    function testQuoteVPFIDiscountIneligibleWhenRateNotSet() public {
        _facet().setVPFIBuyRate(0);
        uint256 offerId = _createLenderERC20Offer(10_000 ether);
        address borrowerEscrow = _buyerEscrow(borrower);
        vpfiToken.transfer(borrowerEscrow, 500 ether); // tier 1

        (bool eligible, , , ) = _facet().quoteVPFIDiscountFor(offerId, borrower);
        assertFalse(eligible);
    }

    function testQuoteVPFIDiscountIneligibleForMissingOffer() public {
        (bool eligible, , , ) = _facet().quoteVPFIDiscount(9999);
        assertFalse(eligible);
    }

    function testQuoteVPFIDiscountIneligibleWhenBorrowerInTier0() public {
        // Borrower holds 0 VPFI in escrow → tier 0, quote returns
        // (false, 0, 0, 0) without reverting. Uses acceptor-aware view since
        // base view returns false-for-known-borrower only on Borrower offers.
        uint256 offerId = _createLenderERC20Offer(10_000 ether);
        (bool eligible, uint256 vpfi, uint256 bal, uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertFalse(eligible);
        assertEq(vpfi, 0);
        assertEq(bal, 0);
        assertEq(tier, 0);
    }

    function testGetVPFIDiscountTier() public {
        address escrow = _buyerEscrow(borrower);

        // Tier 0 — empty escrow.
        (uint8 t0, uint256 bal0, uint256 bps0) = _facet().getVPFIDiscountTier(
            borrower
        );
        assertEq(t0, 0);
        assertEq(bal0, 0);
        assertEq(bps0, 0);

        // Tier 1: >= 100 and < 1,000 → 10%.
        vpfiToken.transfer(escrow, 500 ether);
        (uint8 t1, , uint256 bps1) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t1, 1);
        assertEq(bps1, 1000);

        // Tier 2: >= 1,000 and < 5,000 → 15%. Bump to 2k.
        vpfiToken.transfer(escrow, 1_500 ether);
        (uint8 t2, , uint256 bps2) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t2, 2);
        assertEq(bps2, 1500);

        // Tier 3 boundary: 20,000 inclusive. Currently at 2k → top up
        // to exactly 20,000.
        vpfiToken.transfer(escrow, 18_000 ether);
        (uint8 t3, uint256 bal3, uint256 bps3) = _facet().getVPFIDiscountTier(
            borrower
        );
        assertEq(bal3, 20_000 ether);
        assertEq(t3, 3, "20k inclusive is tier 3");
        assertEq(bps3, 2000);

        // Tier 4: strictly > 20,000. Add 1 wei.
        vpfiToken.transfer(escrow, 1);
        (uint8 t4, , uint256 bps4) = _facet().getVPFIDiscountTier(borrower);
        assertEq(t4, 4);
        assertEq(bps4, 2400);
    }

    // ─── acceptOffer with platform-level consent: happy path ────────────────

    function testAcceptOfferWithVPFIDiscountApplied() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderERC20Offer(principal);

        // Seed borrower escrow to tier 1 so the tier gate unlocks, then quote.
        // Phase 5: quote returns the FULL 0.1% LIF equivalent in VPFI
        // (no tier discount at init). Tier is still surfaced to show
        // what time-weighted rebate the borrower is positioned to earn.
        address borrowerEscrow = _buyerEscrow(borrower);
        address lenderEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(lender);
        vpfiToken.transfer(borrowerEscrow, 500 ether); // tier 1

        (bool eligible, uint256 vpfiRequired, , uint8 tier) = _facet()
            .quoteVPFIDiscountFor(offerId, borrower);
        assertTrue(eligible);
        assertEq(tier, 1);
        assertGt(vpfiRequired, 0);

        // Top up so the escrow has the tier-1 seed + enough to cover the
        // FULL VPFI-denominated LIF (not a discounted slice).
        vpfiToken.transfer(borrowerEscrow, vpfiRequired * 2);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 escrowVpfiBefore = vpfiToken.balanceOf(borrowerEscrow);
        uint256 lenderEscrowBalBefore = IERC20(mockERC20).balanceOf(
            lenderEscrow
        );
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        // Borrower opts in to the platform-level VPFI-discount consent.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(
            offerId,
            true
        );

        // Lender escrow is drained by exactly the full principal — no fee
        // skimmed before delivery.
        assertEq(
            lenderEscrowBalBefore -
                IERC20(mockERC20).balanceOf(lenderEscrow),
            principal,
            "lender escrow debited by principal only"
        );
        // Treasury did NOT receive any lending-asset fee (VPFI path takes
        // the fee in VPFI from borrower instead of lender-side haircut).
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient),
            treasuryErc20Before,
            "treasury ERC20 fee untouched on VPFI path"
        );
        // Phase 5: VPFI moves borrower escrow → Diamond custody, NOT
        // treasury directly. Treasury credit happens at settlement when
        // the held amount splits between borrower rebate + treasury.
        assertEq(
            escrowVpfiBefore - vpfiToken.balanceOf(borrowerEscrow),
            vpfiRequired,
            "borrower escrow debited VPFI"
        );
        assertEq(
            vpfiToken.balanceOf(address(diamond)) - diamondVpfiBefore,
            vpfiRequired,
            "Diamond holds VPFI pending settlement"
        );
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "treasury NOT credited VPFI at init on Phase 5 path"
        );
        (uint256 rebateAmount, uint256 vpfiHeld) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(vpfiHeld, vpfiRequired, "custody recorded against loanId");
        assertEq(rebateAmount, 0, "rebate not credited until settlement");
        assertGt(loanId, 0, "loan created");
    }

    // ─── acceptOffer overload: silent fallback branches ──────────────────────

    function testAcceptOfferFallsBackWhenBorrowerHasInsufficientVPFI() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderERC20Offer(principal);

        // Borrower opts in to platform consent but holds ZERO VPFI in
        // escrow — tryApply must return (false, 0) and the lender-paid fee
        // path fires.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        uint256 treasuryErc20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Fee = 0.1% of principal flows into treasury in the lending
        // asset, MINUS the 1% Range Orders Phase 1 matcher kickback
        // that goes to msg.sender (the borrower in this test).
        uint256 expectedFee = (principal * 10) / 10_000;
        uint256 expectedMatcherCut = (expectedFee * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryCut = expectedFee - expectedMatcherCut;
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryErc20Before,
            expectedTreasuryCut,
            "treasury credited 99% of LIF on fallback (1% matcher kickback)"
        );
        // No VPFI moved when fallback fires.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "no VPFI deducted on fallback"
        );
    }

    function testAcceptOfferFallsBackWhenLendingAssetIlliquid() public {
        // Switch the lending asset's mocked liquidity to Illiquid; the
        // discount path bails silently and normal flow runs.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                mockERC20
            ),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        // Collateral flag also needs consent; we already pass true below.

        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderERC20Offer(principal);

        address borrowerEscrow = _buyerEscrow(borrower);
        vpfiToken.transfer(borrowerEscrow, 5_000 ether); // plenty

        // Borrower opts in; discount still skipped because asset is illiquid.
        vm.prank(borrower);
        _facet().setVPFIDiscountConsent(true);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // No VPFI moved — discount path skipped entirely.
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient),
            treasuryVpfiBefore,
            "treasury VPFI unchanged"
        );
    }

    // ─── emitDiscountApplied access control ──────────────────────────────────

    function testEmitDiscountAppliedRevertsWhenCalledDirectly() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _facet().emitDiscountApplied(1, address(this), mockERC20, 1 ether);
    }

    function testEmitYieldFeeDiscountAppliedRevertsWhenCalledDirectly() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _facet().emitYieldFeeDiscountApplied(
            1,
            address(this),
            mockERC20,
            1 ether
        );
    }

    // ─── Lender Yield Fee Discount (Tokenomics §6) ───────────────────────────

    /// @notice Happy path: lender has consent + funded escrow → on full
    ///         repayment the 1% treasury cut is paid in VPFI from the
    ///         lender's escrow, and the lender keeps 100% of interest in
    ///         the lending asset.
    function testRepayAppliesLenderYieldFeeDiscount() public {
        uint256 principal = 10_000 ether;

        // Lender funds escrow via the sanctioned deposit path BEFORE the
        // offer is accepted — this is the only path that wires the lender
        // into `rollupUserDiscount`, which stamps their current tier so
        // it applies for the full loan window. Raw `transfer(escrow, …)`
        // bypasses the rollup entirely and (correctly) yields a zero
        // time-weighted average at settlement.
        vpfiToken.transfer(lender, 5_000 ether);
        vm.startPrank(lender);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToEscrow(5_000 ether);
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        uint256 offerId = _createLenderERC20Offer(principal);

        // Borrower accepts normally (no borrower discount).
        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        address lenderEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(lender);

        // Advance past the full loan duration so interest fully accrues.
        vm.warp(block.timestamp + 30 days);

        // Borrower pre-approves the repay amount (principal + interest).
        // interestRateBps = 500 (5%), duration 30d → interest ≈ principal
        // * 500 * 30 / (365 * 10000) ≈ 0.4% of principal. Approve the
        // full principal + a generous interest pad.
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryERC20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );
        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 lenderEscrowBefore = IERC20(mockERC20).balanceOf(lenderEscrow);
        uint256 lenderVpfiBefore = vpfiToken.balanceOf(lenderEscrow);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Treasury did NOT receive any lending-asset yield-fee cut.
        assertEq(
            IERC20(mockERC20).balanceOf(treasuryRecipient),
            treasuryERC20Before,
            "treasury ERC20 untouched on lender discount path"
        );
        // Treasury DID receive VPFI (exact amount matches escrow debit).
        uint256 treasuryVpfiDelta = vpfiToken.balanceOf(treasuryRecipient) -
            treasuryVpfiBefore;
        uint256 lenderVpfiDelta = lenderVpfiBefore -
            vpfiToken.balanceOf(lenderEscrow);
        assertGt(treasuryVpfiDelta, 0, "treasury got VPFI");
        assertEq(
            treasuryVpfiDelta,
            lenderVpfiDelta,
            "VPFI conserved: lender escrow delta == treasury delta"
        );
        // Lender escrow received principal + full interest (no haircut).
        uint256 lenderEscrowDelta = IERC20(mockERC20).balanceOf(lenderEscrow) -
            lenderEscrowBefore;
        assertGe(
            lenderEscrowDelta,
            principal,
            "lender escrow at least principal"
        );
    }

    /// @notice Fallback: lender has consent but ZERO VPFI in escrow → the
    ///         normal 1% split fires. Treasury receives the ERC-20 cut and
    ///         the lender escrow receives principal + 99% of interest.
    function testRepayFallsBackWhenLenderHasNoVPFI() public {
        uint256 principal = 10_000 ether;
        uint256 offerId = _createLenderERC20Offer(principal);

        _approveAndAcceptForLoan(offerId, principal);
        uint256 loanId = 1;

        // Lender opts in, but holds ZERO VPFI in escrow.
        vm.prank(lender);
        _facet().setVPFIDiscountConsent(true);

        vm.warp(block.timestamp + 30 days);
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryERC20Before = IERC20(mockERC20).balanceOf(
            treasuryRecipient
        );

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // Fallback fired → treasury received the lending-asset cut.
        assertGt(
            IERC20(mockERC20).balanceOf(treasuryRecipient) - treasuryERC20Before,
            0,
            "treasury ERC20 credited on fallback"
        );
    }

    /// @notice Helper: borrower accepts a lender ERC-20 offer and the loan
    ///         lands in `Active` status. No VPFI-discount consent is set.
    function _approveAndAcceptForLoan(
        uint256 offerId,
        uint256 principal
    ) internal {
        // Borrower needs to post collateral equal to principal.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    // ─── Phase 5 — Borrower LIF time-weighted rebate ─────────────────────────

    /// @notice Long-hold happy path: borrower funds escrow via the sanctioned
    ///         deposit (which wires the discount rollup so the stamp is live
    ///         for the whole loan window), accepts via the VPFI path, holds
    ///         through the full loan duration, repays properly. The rebate
    ///         at claim-time should be the tier-1 percentage (10%) of the
    ///         VPFI paid up-front.
    function testBorrowerLifRebateCreditedOnProperRepayLongHold() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via the sanctioned deposit path so the
        // discount accumulator is stamped correctly.
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToEscrow(500 ether); // tier 1 (≥ 100 < 1000)
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        uint256 offerId = _createLenderERC20Offer(principal);

        // Top up enough to cover the full 0.1% LIF in VPFI.
        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        vpfiToken.transfer(_buyerEscrow(borrower), vpfiRequired * 2);

        // Also fund borrower collateral for acceptOffer.
        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Phase 5 custody: the Diamond holds the full LIF in VPFI.
        (uint256 rebateAtInit, uint256 heldAtInit) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(rebateAtInit, 0, "no rebate until settlement");
        assertEq(heldAtInit, vpfiRequired, "custody records full LIF");

        // Advance past the full duration so the borrower accrued tier-1 across
        // the entire loan.
        vm.warp(block.timestamp + 30 days);

        // Borrower repays the loan fully. settleBorrowerLifProper should split
        // the held amount: rebateAmount = held × avgBps / BPS, treasury share
        // = remainder.
        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (uint256 rebateAfterRepay, uint256 heldAfterRepay) = ClaimFacet(
            address(diamond)
        ).getBorrowerLifRebate(loanId);
        assertEq(heldAfterRepay, 0, "custody drained at settlement");
        assertGt(rebateAfterRepay, 0, "rebate credited");
        // Tier 1 = 1000 bps discount ⇒ rebate == held × 10%.
        // Allow 1% slack for same-block accrual edge effects.
        uint256 expected = (vpfiRequired * 1000) / 10_000;
        assertApproxEqRel(rebateAfterRepay, expected, 0.01e18, "rebate ~10% of held");

        // Treasury received (held − rebate) in VPFI MINUS the 1% Range
        // Orders matcher kickback. Per design §"1% match fee mechanic"
        // the matcher gets 1% of any LIF flowing to treasury; on the
        // VPFI path this fires at proper-close (here). msg.sender at
        // accept = borrower = matcher, so the borrower receives the
        // matcher cut directly in VPFI.
        uint256 fullTreasuryShare = vpfiRequired - rebateAfterRepay;
        uint256 expectedMatcherCut =
            (fullTreasuryShare * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryDelta = fullTreasuryShare - expectedMatcherCut;
        uint256 treasuryDelta = vpfiToken.balanceOf(treasuryRecipient) -
            treasuryVpfiBefore;
        assertEq(
            treasuryDelta,
            expectedTreasuryDelta,
            "treasury got (held - rebate) MINUS 1% matcher kickback in VPFI"
        );
    }

    /// @notice Stamp-refresh fix verification (Option X): borrower tops up to
    ///         tier 1 just before loan acceptance, accepts the VPFI path,
    ///         then immediately withdraws back to tier 0. On settlement
    ///         after the full duration the time-weighted avg BPS must be
    ///         ≈ 0 (not tier-1 BPS) because the stamp re-seeded at post-
    ///         mutation balance after each mutation. This is the exact
    ///         gaming vector Phase 5 was designed to block.
    function testBorrowerLifGamingBlockedByStampRefresh() public {
        uint256 principal = 10_000 ether;

        // Tier-1 seed via deposit so the accumulator is live.
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToEscrow(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        uint256 offerId = _createLenderERC20Offer(principal);

        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        // Top up so the escrow can cover the LIF itself.
        vpfiToken.transfer(_buyerEscrow(borrower), vpfiRequired * 2);

        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Immediately unstake the lot — stamp-refresh fix should set the
        // post-withdraw stamp at tier 0, so the whole loan period accrues
        // at tier-0 BPS (0).
        uint256 withdrawable = vpfiToken.balanceOf(_buyerEscrow(borrower));
        vm.prank(borrower);
        _facet().withdrawVPFIFromEscrow(withdrawable);

        // Full term at tier 0.
        vm.warp(block.timestamp + 30 days);

        uint256 approvalPad = principal + (principal / 10);
        ERC20Mock(mockERC20).mint(borrower, approvalPad);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), approvalPad);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (uint256 rebate, uint256 held) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(held, 0, "custody drained");
        // With stamp-refresh fix, the post-mutation stamp is tier 0, so the
        // rebate should be ≈ 0. We accept a tiny non-zero value from the
        // pre-withdraw same-block tier-1 window but not anywhere close to
        // the full tier-1 rate.
        uint256 fullTier1 = (vpfiRequired * 1000) / 10_000;
        assertLt(rebate, fullTier1 / 100, "gaming blocked: rebate well under tier-1");
    }

    /// @notice Forfeit path: VPFI-path loan that defaults routes the full
    ///         held amount to treasury with zero rebate. The Diamond must
    ///         not retain any VPFI for the loan, and the borrower's claim
    ///         slot carries zero rebateAmount.
    function testBorrowerLifForfeitedOnDefault() public {
        uint256 principal = 10_000 ether;

        // Seed borrower into tier 1 via deposit (stamp live).
        vpfiToken.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfiToken.approve(address(diamond), 5_000 ether);
        _facet().depositVPFIToEscrow(500 ether); // tier 1
        _facet().setVPFIDiscountConsent(true);
        vm.stopPrank();

        // Use an illiquid-principal offer so default goes through
        // DefaultedFacet.markDefaulted rather than the HF-liquidation path,
        // and acceptOffer takes the VPFI path.
        uint256 offerId = _createLenderERC20Offer(principal);

        (, uint256 vpfiRequired, , ) = _facet().quoteVPFIDiscountFor(
            offerId,
            borrower
        );
        vpfiToken.transfer(_buyerEscrow(borrower), vpfiRequired * 2);

        ERC20Mock(mockCollateralERC20).mint(borrower, principal);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(address(diamond), principal);

        vm.prank(borrower);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(offerId, true);

        // Skip past grace period so time-based default fires.
        vm.warp(block.timestamp + 60 days);

        uint256 treasuryVpfiBefore = vpfiToken.balanceOf(treasuryRecipient);
        uint256 diamondVpfiBefore = vpfiToken.balanceOf(address(diamond));

        // Lender calls triggerDefault — triggers forfeitBorrowerLif.
        vm.prank(lender);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        (uint256 rebate, uint256 held) = ClaimFacet(address(diamond))
            .getBorrowerLifRebate(loanId);
        assertEq(held, 0, "custody drained on default");
        assertEq(rebate, 0, "no rebate on default");

        // Full held amount left the Diamond — drained correctly.
        // Range Orders Phase 1: 1% goes to the recorded matcher
        // (msg.sender at accept = borrower), 99% to treasury. Both
        // outflow paths together drain the full vpfiRequired.
        assertEq(
            diamondVpfiBefore - vpfiToken.balanceOf(address(diamond)),
            vpfiRequired,
            "Diamond drained the full custody"
        );
        uint256 expectedMatcherCut =
            (vpfiRequired * LibVaipakam.LIF_MATCHER_FEE_BPS) / 10_000;
        uint256 expectedTreasuryDelta = vpfiRequired - expectedMatcherCut;
        assertEq(
            vpfiToken.balanceOf(treasuryRecipient) - treasuryVpfiBefore,
            expectedTreasuryDelta,
            "treasury got 99% of forfeited VPFI (1% matcher kickback)"
        );
    }

    function _createLenderERC20Offer(uint256 amount) internal returns (uint256) {
        // Lender funds the offer with `amount` of mockERC20; collateral is
        // the same asset to keep test wiring minimal.
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        return
            OfferFacet(address(diamond)).createOffer(
                LibVaipakam.CreateOfferParams({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    amount: amount,
                    interestRateBps: 500,
                    collateralAsset: mockCollateralERC20,
                    collateralAmount: amount,
                    durationDays: 30,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    creatorFallbackConsent: true,
                    prepayAsset: mockERC20,
                    collateralAssetType: LibVaipakam.AssetType.ERC20,
                    collateralTokenId: 0,
                    collateralQuantity: 0,
                    allowsPartialRepay: false,
                    amountMax: 0,
                    interestRateBpsMax: 0
                })
            );
    }
}
