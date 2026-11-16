// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibSignedOffer} from "../src/libraries/LibSignedOffer.sol";

/// @dev The SignedOffer EIP-712 body is written out three times in
///      `LibSignedOffer`: the offer typehash, the set typehash and the Permit2
///      witness type string. A wallet signs the one body, so the three must
///      be byte-identical. Every copy is pinned here to one body; a field
///      added to the struct and to one copy only fails this suite.
contract SignedOfferTypeStringsTest is Test {
    string private constant BODY =
        "SignedOffer("
        "uint8 offerType,address lendingAsset,uint256 amount,uint256 amountMax,"
        "uint256 interestRateBps,uint256 interestRateBpsMax,address collateralAsset,"
        "uint256 collateralAmount,uint256 collateralAmountMax,uint256 durationDays,"
        "uint8 assetType,uint8 collateralAssetType,uint256 tokenId,uint256 quantity,"
        "uint256 collateralTokenId,uint256 collateralQuantity,address prepayAsset,"
        "bool allowsPartialRepay,bool allowsPrepayListing,bool allowsParallelSale,"
        "uint64 expiresAt,uint8 fillMode,uint8 periodicInterestCadence,"
        "uint256 refinanceTargetLoanId,bool useFullTermInterest,uint8 lifecycleFlex,bool creatorFull,"
        "uint256 creatorMaxCStar,bool creatorAllowFullDowngrade,uint16 maxTreasuryFeeBps,"
        "uint16 maxLoanInitiationFeeBps,address allowedTaker,address coSigner,address signer,"
        "uint256 nonce,uint256 deadline,uint8 setKind,uint256 setLow,uint256 setHigh,"
        "bytes32 setRoot,uint32 setListCount,bytes32 setListHash,bytes32 exclusionsHash,"
        "uint16 loans,uint64 startTime)";

    function test_offerTypehashIsTheBody() public pure {
        assertEq(LibSignedOffer.SIGNED_OFFER_TYPEHASH, keccak256(bytes(BODY)));
    }

    function test_setTypehashCarriesTheBody() public pure {
        assertEq(
            LibSignedOffer.SIGNED_OFFER_SET_TYPEHASH,
            keccak256(bytes(string.concat("SignedOfferSet(SignedOffer[] offers)", BODY)))
        );
    }

    function test_permit2WitnessCarriesTheBody() public pure {
        assertEq(
            keccak256(bytes(LibSignedOffer.WITNESS_TYPE_STRING)),
            keccak256(
                bytes(string.concat("SignedOffer witness)", BODY, "TokenPermissions(address token,uint256 amount)"))
            )
        );
    }

    /// @dev The ordered struct is what `hashStruct` encodes: one more field
    ///      in the body than the encoder carries changes the count here.
    function test_bodyFieldCount() public pure {
        bytes memory b = bytes(BODY);
        uint256 commas;
        for (uint256 i; i < b.length; ++i) if (b[i] == ",") ++commas;
        assertEq(commas + 1, 45);
    }
}
