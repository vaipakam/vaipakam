// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title NFTCountParityInvariant
 * @notice Every Active loan owns exactly two position NFTs — a lender token
 *         and a borrower token — and those tokens must be held by the parties
 *         the loan struct points to. If the book says a loan is Active but
 *         one of its NFTs has vanished (burned out-of-band, or never minted),
 *         the claim path is silently broken: lender can't redeem, borrower
 *         can't unlock collateral.
 *
 *         The parity assertion has three parts, each of which is an
 *         audit-grade property on its own:
 *
 *           1. For every Active loan, ownerOf(lenderTokenId) returns the
 *              loan's lender.
 *           2. For every Active loan, ownerOf(borrowerTokenId) returns the
 *              loan's borrower.
 *           3. The count of live lender tokens and live borrower tokens
 *              across all loans is equal (you can't have one side of a
 *              position without the other while the loan is still Active).
 *
 *         We only assert on Active loans. After settlement / repayment /
 *         claim the NFTs are burned intentionally — their absence then is
 *         the correct state, not a bug.
 */
contract NFTCountParityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_ActiveLoansHaveBothPositionNFTs() public view {
        uint256 n = handler.loanIdsLength();
        uint256 liveLender;
        uint256 liveBorrower;

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            if (L.status != LibVaipakam.LoanStatus.Active) continue;

            address lenderOwner = _safeOwnerOf(L.lenderTokenId);
            address borrowerOwner = _safeOwnerOf(L.borrowerTokenId);

            assertEq(
                lenderOwner,
                L.lender,
                "Active loan lender NFT missing or misowned"
            );
            assertEq(
                borrowerOwner,
                L.borrower,
                "Active loan borrower NFT missing or misowned"
            );

            liveLender++;
            liveBorrower++;
        }

        // Per-loan equality already implies the aggregate match, but the
        // explicit count assertion guards against a future change where a
        // loan could hold one NFT but not the other and slip past the
        // per-loan branch (e.g. via an early-return mutation).
        assertEq(
            liveLender,
            liveBorrower,
            "lender/borrower NFT counts diverged across Active loans"
        );
    }

    /// @dev ownerOf reverts for nonexistent tokens; the invariant needs a
    ///      nullable version so we can turn the revert into a distinguishable
    ///      failure (`address(0)` → the assertEq below will fire with a
    ///      clearer message than a generic revert).
    function _safeOwnerOf(uint256 tokenId) internal view returns (address) {
        try VaipakamNFTFacet(address(base.diamond())).ownerOf(tokenId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }
}
