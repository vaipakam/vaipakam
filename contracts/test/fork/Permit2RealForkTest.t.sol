// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {ISignatureTransfer} from "../../src/libraries/LibPermit2.sol";

/**
 * @title Permit2RealForkTest
 * @notice Phase 8b.1 nice-to-have — exercises the **real** Uniswap
 *         Permit2 contract at the canonical address against a forked
 *         mainnet to confirm signature-flow semantics that the
 *         `MockPermit2` test stand-in skips.
 *
 *         The mock at `test/mocks/MockPermit2.sol` records call args
 *         and performs the underlying transfer but skips signature
 *         verification entirely. That's enough to assert "the diamond
 *         hits Permit2 in the right shape" but not "real Permit2
 *         accepts our EIP-712 digest". This fork test closes that
 *         gap by:
 *
 *           1. Building the same `PermitTransferFrom` struct the
 *              frontend produces.
 *           2. Computing the EIP-712 digest against Permit2's actual
 *              `DOMAIN_SEPARATOR()` on the forked chain.
 *           3. Signing with `vm.sign` against a deterministic test
 *              private key.
 *           4. Calling Permit2 directly and asserting it accepts
 *              valid signatures + reverts on every spec'd failure
 *              mode (expired deadline, wrong amount, replayed nonce).
 *
 *         Gated by the `FORK_URL_MAINNET` env (same gate the rest of
 *         the fork suite uses). Silently skipped when the env is
 *         empty so CI without archive-node credentials passes.
 */
contract Permit2RealForkTest is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Permit2 type hashes — copied verbatim from
    // https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol
    // and https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol.
    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH =
        keccak256(
            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
        );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");

    bool internal forkEnabled;

    // Test wallet — deterministic so digests reproduce across runs.
    uint256 internal constant OWNER_PK = uint256(keccak256("vaipakam-permit2-fork-owner"));
    address internal owner;
    address internal spender;

    ERC20Mock internal token;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_MAINNET", string(""));
        if (bytes(url).length == 0) {
            forkEnabled = false;
            return;
        }
        vm.createSelectFork(url);
        forkEnabled = true;

        // Sanity: Permit2 must be deployed at the canonical address on
        // the chosen fork. Aborts the test with a clear error if the
        // operator pointed FORK_URL_MAINNET at a chain without
        // Permit2 (e.g. a fresh devnet).
        require(PERMIT2.code.length > 0, "Permit2 not deployed on this fork");

        owner = vm.addr(OWNER_PK);
        spender = makeAddr("spender");
        vm.deal(owner, 1 ether);

        // Fresh token on the fork — avoids any "real-USDC mint
        // requires impersonating the issuer" mess.
        token = new ERC20Mock("ForkToken", "FORK", 18);
        token.mint(owner, 1_000_000 ether);

        // The owner pre-approves Permit2 on the token contract (one-
        // time ERC20 allowance; this is what the real flow does too).
        vm.prank(owner);
        token.approve(PERMIT2, type(uint256).max);
    }

    // ─── Tests ─────────────────────────────────────────────────────

    function test_Fork_HappyPathPermitTransferFromSucceeds() public {
        if (!forkEnabled) return;
        uint256 amount = 1_000 ether;
        uint256 nonce = _uniqueNonce(0);
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(token), amount, nonce, block.timestamp + 1800);
        bytes memory sig = _signPermit(OWNER_PK, permit, spender);

        uint256 spenderBefore = token.balanceOf(spender);
        uint256 ownerBefore = token.balanceOf(owner);

        vm.prank(spender);
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: spender,
                requestedAmount: amount
            }),
            owner,
            sig
        );

        assertEq(
            token.balanceOf(spender) - spenderBefore,
            amount,
            "spender credited the requested amount"
        );
        assertEq(
            ownerBefore - token.balanceOf(owner),
            amount,
            "owner debited the requested amount"
        );
    }

    function test_Fork_RevertsOnExpiredDeadline() public {
        if (!forkEnabled) return;
        uint256 amount = 1_000 ether;
        uint256 nonce = _uniqueNonce(1);
        // Deadline already in the past.
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(token), amount, nonce, block.timestamp - 1);
        bytes memory sig = _signPermit(OWNER_PK, permit, spender);

        vm.prank(spender);
        // Real Permit2 reverts with `SignatureExpired(uint256 signatureDeadline)`.
        // Selector is the keccak prefix of the canonical signature.
        vm.expectRevert();
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: spender,
                requestedAmount: amount
            }),
            owner,
            sig
        );
    }

    function test_Fork_RevertsOnRequestedAmountAboveSigned() public {
        if (!forkEnabled) return;
        uint256 signedAmount = 500 ether;
        uint256 nonce = _uniqueNonce(2);
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(token), signedAmount, nonce, block.timestamp + 1800);
        bytes memory sig = _signPermit(OWNER_PK, permit, spender);

        // Caller asks for more than the user signed for.
        vm.prank(spender);
        vm.expectRevert();
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: spender,
                requestedAmount: signedAmount + 1
            }),
            owner,
            sig
        );
    }

    function test_Fork_RevertsOnNonceReuse() public {
        if (!forkEnabled) return;
        uint256 amount = 100 ether;
        uint256 nonce = _uniqueNonce(3);
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(token), amount, nonce, block.timestamp + 1800);
        bytes memory sig = _signPermit(OWNER_PK, permit, spender);

        // First use — should succeed.
        vm.prank(spender);
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: spender,
                requestedAmount: amount
            }),
            owner,
            sig
        );

        // Second use of the same nonce — Permit2 burned the bitmap
        // slot on first use, so any retry reverts `InvalidNonce()`.
        vm.prank(spender);
        vm.expectRevert();
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: spender,
                requestedAmount: amount
            }),
            owner,
            sig
        );
    }

    function test_Fork_RevertsOnSpenderMismatch() public {
        if (!forkEnabled) return;
        uint256 amount = 100 ether;
        uint256 nonce = _uniqueNonce(4);
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(token), amount, nonce, block.timestamp + 1800);

        // Owner signs with `spender` as the bound spender — but a
        // DIFFERENT address tries to redeem. Since `spender` is
        // implicitly `msg.sender` inside Permit2, calling from
        // anywhere else makes the signature invalid.
        bytes memory sig = _signPermit(OWNER_PK, permit, spender);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: attacker,
                requestedAmount: amount
            }),
            owner,
            sig
        );
    }

    // ─── Helpers ───────────────────────────────────────────────────

    function _buildPermit(
        address asset,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (ISignatureTransfer.PermitTransferFrom memory) {
        return
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: asset,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });
    }

    function _signPermit(
        uint256 pk,
        ISignatureTransfer.PermitTransferFrom memory permit,
        address spenderAddr
    ) internal view returns (bytes memory) {
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(
                TOKEN_PERMISSIONS_TYPEHASH,
                permit.permitted.token,
                permit.permitted.amount
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TRANSFER_FROM_TYPEHASH,
                tokenPermissionsHash,
                spenderAddr,
                permit.nonce,
                permit.deadline
            )
        );
        // Read DOMAIN_SEPARATOR from real Permit2 so we don't have to
        // recompute it (and don't fail if Permit2 ever rolls).
        (bool ok, bytes memory ret) = PERMIT2.staticcall(
            abi.encodeWithSignature("DOMAIN_SEPARATOR()")
        );
        require(ok && ret.length >= 32, "Permit2 DOMAIN_SEPARATOR read failed");
        bytes32 domainSeparator = abi.decode(ret, (bytes32));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Each test consumes a unique nonce so subsequent tests in
    ///      the same fork session don't trip Permit2's replay guard.
    function _uniqueNonce(uint256 testIdx) internal view returns (uint256) {
        return uint256(
            keccak256(abi.encode("vaipakam-fork-nonce", block.chainid, owner, testIdx))
        );
    }
}
