// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IVPFIToken
 * @author Vaipakam Developer Team
 * @notice External interface for the Vaipakam DeFi Token (VPFI) on the
 *         canonical chain (Base mainnet / Base Sepolia testnet).
 * @dev Phase 1 tokenomics — see docs/TokenomicsTechSpec.md. The live
 *      canonical implementation at contracts/src/token/VPFIToken.sol is
 *      a UUPS upgradeable ERC20 (Capped + Burnable + Pausable +
 *      Ownable2Step) deployed behind an ERC1967Proxy, matching the
 *      project policy that contracts outside the Diamond are UUPS
 *      upgradeable (cf. VaipakamEscrowImplementation).
 *
 *      Cross-chain semantics: this interface describes the CANONICAL
 *      token. On mirror chains (Polygon / Arbitrum / Optimism / Ethereum
 *      mainnet + Sepolia testnet) the token is `VPFIMirror`, a pure
 *      LayerZero OFT V2 which implements only the IERC20 subset — no
 *      `mint()` / `minter()` / `TOTAL_SUPPLY_CAP()` surface, because
 *      supply on mirror chains flows in exclusively via the OFT peer
 *      bridge. Callers needing cross-chain-safe reads should go through
 *      VPFITokenFacet's view functions rather than binding to this
 *      interface directly on mirror deployments.
 */
interface IVPFIToken is IERC20 {
    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted whenever the privileged minter address is rotated.
    /// @param previousMinter The minter immediately prior to this change.
    /// @param newMinter      The minter effective after this change.
    event MinterUpdated(address indexed previousMinter, address indexed newMinter);

    /// @notice Emitted for every successful `mint(...)` call.
    /// @dev ERC20 itself emits Transfer(address(0), to, amount); this event
    ///      exists so indexers can filter mint events without scanning all
    ///      transfers from the zero address.
    event Minted(address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Caller of `mint(...)` is not the current minter.
    error NotMinter();

    // ─── Mint / Minter Management ────────────────────────────────────────────

    /// @notice Mint `amount` VPFI to `to`. Caller must equal `minter()`.
    /// @dev Reverts with NotMinter if the caller is not the configured
    ///      minter, with InvalidAddress on zero `to`, InvalidAmount on zero
    ///      `amount`, ERC20ExceededCap on cap breach, and EnforcedPause when
    ///      the contract is paused.
    function mint(address to, uint256 amount) external;

    /// @notice Set a new minter. Owner-only.
    /// @dev The owner is expected to be a Gnosis Safe with timelock, and the
    ///      minter is expected to be the TreasuryFacet (or a dedicated
    ///      distributor contract). Reverts with InvalidAddress on zero.
    function setMinter(address newMinter) external;

    /// @notice The address currently authorized to call `mint(...)`.
    function minter() external view returns (address);

    // ─── Supply Constants ────────────────────────────────────────────────────

    /// @notice Hard cap on total supply across all mints.
    /// @return 230_000_000 * 1e18.
    function TOTAL_SUPPLY_CAP() external view returns (uint256);

    /// @notice Initial one-time mint at deployment (10% of cap).
    /// @return 23_000_000 * 1e18.
    function INITIAL_MINT() external view returns (uint256);
}
