// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSignedOffer} from "../src/libraries/LibSignedOffer.sol";
import {ISignatureTransfer} from "../src/libraries/LibPermit2.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/**
 * @title  SignedOfferBookTest
 * @notice Targeted suite for #396 v0.5 — the gasless signed off-chain offer
 *         book (`SignedOfferFacet` + `LibSignedOffer`).
 *
 * @dev    The signed offer under test is a single-value ERC-20 **Lender**
 *         offer (1000 principal, 1500 collateral, 30 days, 5% rate) — the
 *         LTV-safe shape `LoanFacetTest.testInitiateLoanSuccessful` uses, so
 *         the materialize → accept → loan-init path clears the liquidity / HF
 *         gates. The signer is the lender; a borrower fills it by providing
 *         ERC-20 collateral via the classic accept plumbing.
 *
 *         EIP-712 signing mirrors `VaultRecoveryTest`: hash via the on-chain
 *         `hashSignedOffer` view, `vm.sign(pk, digest)`, pack `(r,s,v)`.
 *
 *         The wallet-backed (Permit2-witness) path reuses the repo's
 *         `MockPermit2` (installed at the canonical address via `vm.etch`),
 *         which skips signature reconstruction and just moves the staked
 *         tokens — so the happy path proves the wiring end-to-end without a
 *         real Permit2 witness-digest recovery. See the NOTE on
 *         {testWalletBackedHappyPathViaPermit2}.
 */
contract SignedOfferBookTest is SetupTest {
    address internal signer;
    uint256 internal signerPk;

    address internal constant CANONICAL_PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // The LTV-safe shape (mirrors LoanFacetTest.testInitiateLoanSuccessful).
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 1500 ether;
    uint256 internal constant DURATION = 30;
    uint256 internal constant RATE_BPS = 500;

    function setUp() public {
        setupHelper();
        (signer, signerPk) = makeAddrAndKey("signer");

        // Install MockPermit2 at the canonical address for the wallet-backed
        // path. Harmless for the vault-backed cases (they never route to it).
        vm.etch(CANONICAL_PERMIT2, address(new MockPermit2()).code);
    }

    // ─── Offer builders ──────────────────────────────────────────────────

    /// @dev A vault-backed-shaped Lender ERC-20 signed offer. `fillMode` is
    ///      Partial here; `amount == amountMax` so it is AON-compatible too.
    function _lenderSignedOffer(uint256 nonce, uint256 deadline)
        internal
        view
        returns (LibSignedOffer.SignedOffer memory o)
    {
        o.offerType = uint8(LibVaipakam.OfferType.Lender);
        o.lendingAsset = mockERC20;
        o.amount = PRINCIPAL;
        o.amountMax = PRINCIPAL;
        o.interestRateBps = RATE_BPS;
        o.interestRateBpsMax = RATE_BPS;
        o.collateralAsset = mockCollateralERC20;
        o.collateralAmount = COLLATERAL;
        o.collateralAmountMax = COLLATERAL;
        o.durationDays = DURATION;
        o.assetType = uint8(LibVaipakam.AssetType.ERC20);
        o.collateralAssetType = uint8(LibVaipakam.AssetType.ERC20);
        // tokenId / quantity / collateralTokenId / collateralQuantity = 0
        o.prepayAsset = mockERC20;
        // allows* flags default false
        o.expiresAt = 0; // GTC offer
        o.fillMode = uint8(LibVaipakam.FillMode.Partial);
        o.periodicInterestCadence =
            uint8(LibVaipakam.PeriodicInterestCadence.None);
        o.refinanceTargetLoanId = 0;
        o.useFullTermInterest = false;
        o.signer = signer;
        o.nonce = nonce;
        o.deadline = deadline; // 0 ⇒ GTC signature
    }

    function _sign(LibSignedOffer.SignedOffer memory o)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 digest = SignedOfferFacet(address(diamond)).hashSignedOffer(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // ─── 1. Vault-backed happy path ───────────────────────────────────────

    function testVaultBackedHappyPath() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(1, 0);
        bytes memory sig = _sign(o);

        // Signer's principal sits free in their vault.
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        bytes32 orderHash =
            SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);

        // SignedOfferFilled emitted (don't pin loanId/offerId in topics —
        // assert by reading state afterwards; just confirm the event fires
        // with the signer + acceptor + non-zero ids).
        vm.recordLogs();
        vm.prank(borrower);
        uint256 loanId =
            SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);

        assertGt(loanId, 0, "loan initiated");

        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, signer, "lender = signer");
        assertEq(loan.borrower, borrower, "borrower = acceptor");
        assertEq(loan.principal, PRINCIPAL, "principal matches offer");
        assertEq(loan.interestRateBps, RATE_BPS, "rate matches offer");
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan active"
        );

        // Ledger marks the order consumed (non-zero filled amount).
        assertTrue(
            SignedOfferFacet(address(diamond)).signedOfferFilledAmount(orderHash)
                != 0,
            "order hash consumed"
        );
    }

    // ─── 2. Bad signature ─────────────────────────────────────────────────

    function testBadSignatureReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(2, 0);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        // Tamper a binding field AFTER signing — the digest no longer
        // recovers to `o.signer`.
        o.amount = PRINCIPAL + 1 ether;

        vm.prank(borrower);
        vm.expectRevert(SignedOfferFacet.SignedOfferBadSignature.selector);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    function testWrongKeySignatureReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(3, 0);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        // Sign with a key that is NOT o.signer.
        (, uint256 wrongPk) = makeAddrAndKey("attacker");
        bytes32 digest = SignedOfferFacet(address(diamond)).hashSignedOffer(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(borrower);
        vm.expectRevert(SignedOfferFacet.SignedOfferBadSignature.selector);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, badSig, true);
    }

    // ─── 3. Replay ────────────────────────────────────────────────────────

    function testReplayReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(4, 0);
        bytes memory sig = _sign(o);
        // Fund enough for two fills — proves the revert is the consume
        // ledger, not a balance shortfall.
        _fundActorVault(signer, mockERC20, PRINCIPAL * 2);

        vm.prank(borrower);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);

        bytes32 orderHash =
            SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedOfferFacet.SignedOfferConsumed.selector,
                orderHash
            )
        );
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    // ─── 4. Cancel ────────────────────────────────────────────────────────

    function testCancelThenAcceptReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(5, 0);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        // Signer cancels on-chain.
        vm.prank(signer);
        SignedOfferFacet(address(diamond)).cancelSignedOffer(o);

        bytes32 orderHash =
            SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedOfferFacet.SignedOfferConsumed.selector,
                orderHash
            )
        );
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    function testCancelByNonSignerReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(6, 0);

        vm.prank(borrower); // not the signer
        vm.expectRevert(SignedOfferFacet.NotSignedOfferSigner.selector);
        SignedOfferFacet(address(diamond)).cancelSignedOffer(o);
    }

    // ─── 5. Batch nonce invalidate ────────────────────────────────────────

    function testNonceInvalidateReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(7, 0);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        vm.prank(signer);
        SignedOfferFacet(address(diamond)).invalidateSignedOfferNonce(o.nonce);
        assertTrue(
            SignedOfferFacet(address(diamond)).isSignedOfferNonceUsed(
                signer, o.nonce
            ),
            "nonce burned"
        );

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedOfferFacet.SignedOfferNonceInvalidated.selector,
                o.nonce
            )
        );
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    // ─── 6. Signature deadline expired ────────────────────────────────────

    function testSigDeadlineExpiredReverts() public {
        uint256 deadline = block.timestamp + 100;
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(8, deadline);
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        vm.warp(deadline + 1);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedOfferFacet.SignedOfferSigExpired.selector,
                deadline
            )
        );
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    // ─── 7. Offer GTT expired ─────────────────────────────────────────────

    function testOfferGttExpiredReverts() public {
        uint64 expiresAt = uint64(block.timestamp + 100);
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(9, 0);
        o.expiresAt = expiresAt;
        bytes memory sig = _sign(o);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        vm.warp(uint256(expiresAt) + 1);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedOfferFacet.SignedOfferExpired.selector,
                expiresAt
            )
        );
        SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);
    }

    // ─── 8. Wrong-chain domain ────────────────────────────────────────────

    function testWrongChainDomainReverts() public {
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(10, 0);
        _fundActorVault(signer, mockERC20, PRINCIPAL);

        // Build the EIP-712 digest under a DIFFERENT chainid by reconstructing
        // the domain separator manually with `block.chainid + 1`. We pin the
        // struct hash via the on-chain (domain-independent) `signedOfferOrderHash`
        // view and fold it into a domain separator the on-chain `verify` will
        // never reproduce — so the recovered signer can't match `o.signer`.
        // Computing it by hand (rather than via `vm.chainId` + the view) keeps
        // the wrong-chain binding deterministic and free of staticcall-context
        // chainid quirks.
        bytes32 structHash =
            SignedOfferFacet(address(diamond)).signedOfferOrderHash(o);
        bytes32 wrongDomainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Vaipakam SignedOffer"),
                keccak256("1"),
                block.chainid + 1, // wrong chain
                address(diamond)
            )
        );
        bytes32 wrongChainDigest = keccak256(
            abi.encodePacked("\x19\x01", wrongDomainSeparator, structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, wrongChainDigest);
        bytes memory wrongChainSig = abi.encodePacked(r, s, v);

        vm.prank(borrower);
        vm.expectRevert(SignedOfferFacet.SignedOfferBadSignature.selector);
        SignedOfferFacet(address(diamond)).acceptSignedOffer(
            o, wrongChainSig, true
        );
    }

    // ─── 9. EIP-1271 contract-wallet signer ───────────────────────────────

    function testEip1271SignerAccepted() public {
        // Deploy a 1271 wallet that delegates validity to a held EOA key.
        // The wallet is the on-chain `o.signer`; the EOA produces the
        // signature; the wallet's `isValidSignature` confirms it.
        Mock1271Wallet wallet = new Mock1271Wallet(signer);

        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(11, 0);
        o.signer = address(wallet); // the contract wallet is the signer

        // Sign with the EOA key the wallet trusts (the digest is computed
        // over the offer whose `signer` is the wallet — SignatureChecker
        // routes to the wallet's 1271 check because the code-bearing signer
        // has bytecode).
        bytes memory sig = _sign(o);

        // Fund the WALLET's vault — the materialize step locks the wallet's
        // free balance as the offer principal.
        _fundActorVault(address(wallet), mockERC20, PRINCIPAL);

        vm.prank(borrower);
        uint256 loanId =
            SignedOfferFacet(address(diamond)).acceptSignedOffer(o, sig, true);

        assertGt(loanId, 0, "1271-signed loan initiated");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, address(wallet), "lender = 1271 wallet");
        assertEq(loan.borrower, borrower, "borrower = acceptor");
    }

    // ─── 10. Wallet-backed (Permit2-witness) path ─────────────────────────

    /// @dev NOTE — simplification: the repo's `MockPermit2` deliberately
    ///      SKIPS witness-signature reconstruction (it just records the
    ///      witness + type string and moves tokens). So this asserts the
    ///      end-to-end wiring of the wallet-backed fill — the stake is
    ///      pulled from the signer's WALLET (not vault) into their vault and
    ///      a loan initiates — without exercising a real Permit2
    ///      witness-digest recovery (that belongs in a fork test against the
    ///      canonical Permit2, the same split `Permit2IntegrationTest` notes).
    function testWalletBackedHappyPathViaPermit2() public {
        // AON-only for wallet-backed (amount == amountMax already).
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(12, 0);
        o.fillMode = uint8(LibVaipakam.FillMode.Aon);

        // Signer funds + approves Permit2 from their WALLET (no vault balance).
        ERC20Mock(mockERC20).mint(signer, PRINCIPAL);
        vm.prank(signer);
        IERC20(mockERC20).approve(CANONICAL_PERMIT2, type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit =
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: mockERC20,
                    amount: PRINCIPAL
                }),
                nonce: 1,
                deadline: block.timestamp + 1800
            });

        address signerVault = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(signer);
        uint256 vaultBefore = IERC20(mockERC20).balanceOf(signerVault);

        vm.prank(borrower);
        uint256 loanId = SignedOfferFacet(address(diamond))
            .acceptSignedOfferWithPermit(o, permit, "", true);

        assertGt(loanId, 0, "wallet-backed loan initiated");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, signer, "lender = signer");
        assertEq(loan.borrower, borrower, "borrower = acceptor");
        assertEq(loan.principal, PRINCIPAL, "principal matches offer");

        // The mock pulled the stake from the signer's wallet via Permit2.
        MockPermit2 m = MockPermit2(CANONICAL_PERMIT2);
        assertEq(m.callCount(), 1, "permit2 witness pull fired once");
        assertEq(m.lastOwner(), signer, "permit2 owner = signer");
        // Vault net balance unchanged after the immediate accept consumes
        // the principal (pulled in, then lent out to the borrower).
        assertEq(
            IERC20(mockERC20).balanceOf(signerVault),
            vaultBefore,
            "principal pulled then lent out"
        );
    }

    function testWalletBackedNonAonReverts() public {
        // fillMode != Aon must be rejected up front — single Permit2
        // transfer signature authorizes exactly one full pull.
        LibSignedOffer.SignedOffer memory o = _lenderSignedOffer(13, 0);
        o.fillMode = uint8(LibVaipakam.FillMode.Partial);

        ISignatureTransfer.PermitTransferFrom memory permit =
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: mockERC20,
                    amount: PRINCIPAL
                }),
                nonce: 1,
                deadline: block.timestamp + 1800
            });

        vm.prank(borrower);
        vm.expectRevert(SignedOfferFacet.WalletBackedMustBeAon.selector);
        SignedOfferFacet(address(diamond)).acceptSignedOfferWithPermit(
            o, permit, "", true
        );
    }
}

/**
 * @title  Mock1271Wallet
 * @notice Minimal ERC-1271 contract wallet for the signed-offer 1271 test.
 *         Validity is delegated to a trusted EOA: a signature is valid iff
 *         it ECDSA-recovers to `owner`. Returns the ERC-1271 magic value on
 *         a match, so OZ `SignatureChecker.isValidSignatureNow` accepts it
 *         when the wallet is the `o.signer`.
 */
contract Mock1271Wallet is IERC1271, IERC721Receiver {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    /// @dev The wallet is the lender, so it receives the lender position
    ///      ERC-721 minted at loan init — accept it.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4)
    {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 0x20))
                v := byte(0, calldataload(add(signature.offset, 0x40)))
            }
            if (ecrecover(hash, v, r, s) == owner) {
                return IERC1271.isValidSignature.selector;
            }
        }
        return 0xffffffff;
    }
}
