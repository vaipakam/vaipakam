// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {LibPermit2} from "../../src/libraries/LibPermit2.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";

/// @dev Permit2's EIP-712 domain getter.
interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * @title  RefinancePayoffPermitHelper
 * @notice #1558: a refinance pays off the old loan through the payoff permit
 *         the borrower attached to the request. Tests attach one through this
 *         helper.
 *
 *         Two ways. {attach} installs `MockPermit2` at the canonical address
 *         (it moves tokens on the owner's approval of Permit2 and skips
 *         signature checks), for suites that only need a refinance to
 *         complete. {installReal} + {attachSigned} install Uniswap's real
 *         Permit2 runtime (the same bytes the e2e harness installs) and sign a
 *         real permit, so the witness binding and the type string the Diamond
 *         hands Permit2 are checked by Permit2 itself.
 *
 * @dev    The signed digest is built here from literal EIP-712 type strings,
 *         NOT from `LibRefinancePayoff`'s constants: a wallet encodes the
 *         witness from typed data, so a test that reused the contract's own
 *         string would agree with a typo in it.
 */
library RefinancePayoffPermitHelper {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The full EIP-712 type a wallet signs for the payoff permit:
    ///         Permit2's witness stub, then the referenced types in
    ///         alphabetical order.
    bytes32 internal constant PERMIT_WITNESS_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,RefinancePayoff witness)"
        "RefinancePayoff(uint256 loanId,uint256 offerId)"
        "TokenPermissions(address token,uint256 amount)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant REFINANCE_PAYOFF_TYPEHASH =
        keccak256("RefinancePayoff(uint256 loanId,uint256 offerId)");

    /// @notice Install `MockPermit2` at the canonical Permit2 address, once.
    function install() internal {
        if (LibPermit2.PERMIT2.code.length == 0) {
            vm.etch(LibPermit2.PERMIT2, address(new MockPermit2()).code);
        }
    }

    /// @notice Install Uniswap's real Permit2 runtime at the canonical address.
    function installReal() internal {
        string memory hexCode =
            vm.trim(vm.readFile(string.concat(vm.projectRoot(), "/script/e2e/Permit2.runtime.hex")));
        vm.etch(LibPermit2.PERMIT2, vm.parseBytes(hexCode));
    }

    /// @notice `borrower` approves Permit2 for `asset` and attaches an
    ///         uncapped, long-lived payoff permit to their request `offerId`.
    function attach(address diamond, address borrower, address asset, uint256 offerId) internal {
        attachCapped(diamond, borrower, asset, offerId, type(uint256).max);
    }

    /// @notice {attach} with the permit capped at `maxAmount`.
    function attachCapped(
        address diamond,
        address borrower,
        address asset,
        uint256 offerId,
        uint256 maxAmount
    ) internal {
        install();
        vm.prank(borrower);
        IERC20(asset).approve(LibPermit2.PERMIT2, type(uint256).max);
        vm.prank(borrower);
        RefinanceFacet(diamond).setRefinancePayoffPermit(
            offerId, maxAmount, offerId, type(uint64).max, hex"01"
        );
    }

    /// @notice The payoff permit a wallet would sign: `maxAmount` of `asset`
    ///         to `diamond`, binding `loanId` through request `offerId`.
    function sign(
        uint256 pk,
        address diamond,
        address asset,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        uint256 loanId,
        uint256 offerId
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITNESS_TYPEHASH,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, asset, maxAmount)),
                diamond,
                nonce,
                deadline,
                keccak256(abi.encode(REFINANCE_PAYOFF_TYPEHASH, loanId, offerId))
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IPermit2Domain(LibPermit2.PERMIT2).DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice The borrower (key `pk`) approves Permit2 for `asset`, signs a
    ///         real payoff permit for `loanId` through `offerId`, and attaches
    ///         it to the request.
    function attachSigned(
        address diamond,
        uint256 pk,
        address asset,
        uint256 loanId,
        uint256 offerId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline
    ) internal {
        address borrower = vm.addr(pk);
        bytes memory sig = sign(pk, diamond, asset, maxAmount, nonce, deadline, loanId, offerId);
        vm.prank(borrower);
        IERC20(asset).approve(LibPermit2.PERMIT2, type(uint256).max);
        vm.prank(borrower);
        RefinanceFacet(diamond).setRefinancePayoffPermit(offerId, maxAmount, nonce, deadline, sig);
    }

    /// @notice For a live-fork test that runs a chain's DEPLOYED code: when
    ///         that Diamond routes the permit entry (#1558), attach a real
    ///         permit for the payoff at the end of grace and return true. A
    ///         Diamond deployed before #1558 has no such route and still pulls
    ///         the payoff on the wallet approval the test grants, so this
    ///         returns false and attaches nothing.
    function attachSignedIfRouted(
        address diamond,
        uint256 pk,
        address asset,
        uint256 loanId,
        uint256 offerId,
        uint256 nonce
    ) internal returns (bool) {
        if (
            IDiamondLoupe(diamond).facetAddress(RefinanceFacet.setRefinancePayoffPermit.selector)
                == address(0)
        ) return false;
        (, , uint256 atGraceEnd, , , , , ) =
            RefinanceFacet(diamond).getRefinancePayoff(loanId, offerId);
        attachSigned(diamond, pk, asset, loanId, offerId, atGraceEnd, nonce, block.timestamp + 1 days);
        return true;
    }
}
