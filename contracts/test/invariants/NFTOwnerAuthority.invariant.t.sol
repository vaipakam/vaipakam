// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title NFTOwnerAuthorityInvariant
 * @notice For every initiated loan there must be exactly one lender
 *         position NFT and one borrower position NFT, and whichever
 *         wallet currently owns those NFTs is the authoritative claimant
 *         per README §role-based visibility. This invariant suite checks
 *         structural properties of the position-NFT ledger; race-condition
 *         transfer scenarios (NFT changes hands mid-flow) belong in
 *         scenario tests where ownership can be deterministically swapped.
 */
contract NFTOwnerAuthorityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    /// @notice Every loan has distinct, non-zero lender and borrower token IDs.
    function invariant_OneLenderOneBorrowerNFTPerLoan() public view {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loans.getLoanDetails(loanId);
            assertGt(L.lenderTokenId, 0, "lenderTokenId zero");
            assertGt(L.borrowerTokenId, 0, "borrowerTokenId zero");
            assertTrue(L.lenderTokenId != L.borrowerTokenId, "token IDs collide");
        }
    }

    /// @notice If a position NFT still exists (non-zero owner), it belongs
    ///         to the same side of the loan it was minted for. We check
    ///         by asking the NFT facet for ownerOf and matching against
    ///         the loan's recorded lender/borrower at initiation. A
    ///         mismatch is only valid if the NFT has been transferred —
    ///         which is legal per README — so we only assert non-zero.
    function invariant_PositionNFTsExistWhileLoanOpen() public view {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));
        VaipakamNFTFacet nft = VaipakamNFTFacet(address(base.diamond()));
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loans.getLoanDetails(loanId);
            if (
                L.status == LibVaipakam.LoanStatus.Active ||
                L.status == LibVaipakam.LoanStatus.FallbackPending
            ) {
                // ownerOf reverts if the token was burned — catch that.
                try nft.ownerOf(L.lenderTokenId) returns (address lOwner) {
                    assertTrue(lOwner != address(0), "lender NFT owner zero");
                } catch {
                    revert("lender NFT burned while loan open");
                }
                try nft.ownerOf(L.borrowerTokenId) returns (address bOwner) {
                    assertTrue(bOwner != address(0), "borrower NFT owner zero");
                } catch {
                    revert("borrower NFT burned while loan open");
                }
            }
        }
    }
}
