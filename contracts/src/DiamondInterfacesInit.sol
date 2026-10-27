// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IERC165} from "@diamond-3/interfaces/IERC165.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/**
 * @title DiamondInterfacesInit
 * @author Vaipakam Developer Team
 * @notice The ONE list of ERC-165 interfaces the Vaipakam Diamond advertises,
 *         and the EIP-2535 initializer that records it (#2752).
 * @dev    The Diamond answers `supportsInterface` from LibDiamond's
 *         `supportedInterfaces` table (DiamondLoupeFacet), so it advertises
 *         exactly what was written there. Before #2752 the only writer was the
 *         NFT facet's initializer, which recorded the ERC-721 family and
 *         EIP-2981 and nothing else, so the Diamond denied ERC-165 itself
 *         (which ERC-165 requires a compliant contract to affirm), the loupe,
 *         ERC-173 and the ERC-1155 receiver it hosts in ReceiverFacet. An
 *         integration that checks ERC-165 before a safe transfer could refuse
 *         the Diamond.
 *
 *         Each claim names an interface whose every function the deploy
 *         routes: the cut and loupe (EIP-2535), `owner`/`transferOwnership`
 *         (OwnershipFacet), the position NFT (VaipakamNFTFacet: ERC-721,
 *         metadata, enumerable, `royaltyInfo`), and both ERC-1155 receiver
 *         hooks (ReceiverFacet). Advertising the receiver does not open the
 *         Diamond as a sink: the hooks accept only the one pinned token of an
 *         in-flight consolidation move and refuse every batch; ERC-165 says
 *         the functions exist, not that every transfer is accepted.
 *         `DeployDiamondIntegrationTest` checks every claim against the
 *         routing of the Diamond the deploy builds.
 *
 *         Run by `DeployDiamond` as the `_init` of one `diamondCut` after the
 *         last facet batch, so it executes by delegatecall in the Diamond's
 *         own storage, with every claimed function already routed. It holds no
 *         state and has no other entry point; calling it directly writes only
 *         to its own (unused) storage.
 */
contract DiamondInterfacesInit {
    /// @notice Every interface id the Diamond advertises.
    function interfaceIds() public pure returns (bytes4[] memory ids) {
        ids = new bytes4[](9);
        ids[0] = type(IERC165).interfaceId;
        ids[1] = type(IDiamondCut).interfaceId;
        ids[2] = type(IDiamondLoupe).interfaceId;
        ids[3] = type(IERC173).interfaceId;
        ids[4] = type(IERC721).interfaceId;
        ids[5] = type(IERC721Metadata).interfaceId;
        ids[6] = type(IERC721Enumerable).interfaceId;
        ids[7] = type(IERC2981).interfaceId;
        ids[8] = type(IERC1155Receiver).interfaceId;
    }

    /// @notice Record {interfaceIds} in the Diamond's ERC-165 table. Meant to
    ///         run only as a `diamondCut` initializer (delegatecall).
    function init() external {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        bytes4[] memory ids = interfaceIds();
        for (uint256 i; i < ids.length; ++i) {
            ds.supportedInterfaces[ids[i]] = true;
        }
    }
}
