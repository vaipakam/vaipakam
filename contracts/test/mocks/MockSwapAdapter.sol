// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/// @dev Minimal Chainlink aggregator surface — just the `latestRoundData`
///      answer the adapter needs for its live price read.
interface IAggregatorV3Minimal {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/**
 * @title MockSwapAdapter — controllable ISwapAdapter for LibSwap failover tests.
 *
 * Configure with (`setShouldRevert`, `setOutputMultiplierBps`,
 * `setLabel`). The adapter pulls the full `inputAmount` via
 * `transferFrom` from `msg.sender`, then either reverts or
 * transfers `inputAmount * bps / 10000` of `outputToken` — which
 * the adapter must already hold. This shape lets a test compose
 * multiple mocks into a failover chain with varying outcomes.
 */
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    /// @dev Deployer-gated knobs: this mock gets REGISTERED as a live
    ///      liquidation venue on public testnets (DeployTestnetMocks),
    ///      where unrestricted setters would let anyone flip it to
    ///      revert (griefing HF liquidation into the fallback path) or
    ///      skew payouts. Tests deploy-and-configure from the same
    ///      address, so the gate is invisible to them.
    address public immutable owner;

    string public label;
    bool public shouldRevert;
    uint256 public outputMultiplierBps = 10_000;
    uint256 public callCount;

    /// @dev OPTIONAL per-token USD price (8-dec Chainlink scale). When BOTH
    ///      the input and output token carry a non-zero price, `execute` pays
    ///      the FAIR price-ratio amount (`inputAmount * priceIn / priceOut`)
    ///      rather than the flat `inputAmount * bps`. This keeps testnet
    ///      HF/default-liquidation demos honest once the faucet tokens carry
    ///      DISTINCT prices (Codex #1095): selling 1 mWETH ($3,000) for mUSDC
    ///      ($1) returns ~3,000 mUSDC, which clears the oracle-derived
    ///      `minOutputAmount` instead of falling into the full-collateral
    ///      fallback. Unset (0) on either leg preserves the legacy flat
    ///      behaviour every existing LibSwap failover test relies on.
    ///      NOTE: assumes input/output share the same ERC-20 decimals — true
    ///      for every faucet mock (all 18-dec); do NOT register mismatched-
    ///      decimals pairs on this mock without adding a decimals term.
    mapping(address => uint256) public tokenUsdPrice8;

    /// @dev OPTIONAL per-token LIVE price feed (Chainlink 8-dec aggregator).
    ///      When set for a token, `execute` reads the feed's current answer
    ///      instead of the static `tokenUsdPrice8` snapshot — so a token like
    ///      mWETH truly TRACKS the real ETH/USD feed the oracle uses, and its
    ///      liquidation payout never drifts out of the oracle's slippage band
    ///      as ETH moves (Codex #1095: the deploy-time snapshot went stale and
    ///      dropped mWETH liquidations into the full-collateral fallback). The
    ///      static price stays as the fallback when the feed is unset or
    ///      returns a non-positive answer. Feeds are assumed 8-dec (Chainlink
    ///      USD pairs), matching `tokenUsdPrice8`'s scale.
    mapping(address => address) public tokenUsdFeed;

    /// @dev OPT-IN execute gate. Unset (default) keeps the mock fully
    ///      open — the shape every existing test relies on. On public
    ///      testnets the deploy script sets it to the Diamond: a funded
    ///      adapter with an open `execute` is a public pot (anyone can
    ///      approve a junk inputToken and drain the seeded output
    ///      float; Codex #982 r9).
    address public restrictedTo;

    modifier onlyOwner() {
        require(msg.sender == owner, "MockSwapAdapter: not owner");
        _;
    }

    constructor(string memory _label) {
        owner = msg.sender;
        label = _label;
    }

    function setShouldRevert(bool v) external onlyOwner {
        shouldRevert = v;
    }

    function setOutputMultiplierBps(uint256 v) external onlyOwner {
        outputMultiplierBps = v;
    }

    function setRestrictedTo(address caller) external onlyOwner {
        restrictedTo = caller;
    }

    /// @notice Register a token's STATIC USD price (8-dec) so cross-asset
    ///         swaps pay the fair price ratio. See `tokenUsdPrice8`. Used as
    ///         the fallback when no live feed is registered for the token.
    function setTokenPrice(address token, uint256 price8) external onlyOwner {
        tokenUsdPrice8[token] = price8;
    }

    /// @notice Register a token's LIVE Chainlink price feed (8-dec) so its
    ///         swap payout tracks the same feed the oracle prices with. Pass
    ///         `address(0)` to clear and fall back to the static price. See
    ///         `tokenUsdFeed`.
    function setTokenFeed(address token, address feed) external onlyOwner {
        tokenUsdFeed[token] = feed;
    }

    /// @dev A token's effective 8-dec USD price: the LIVE feed answer when a
    ///      feed is registered and returns a positive value, else the static
    ///      `tokenUsdPrice8` snapshot (0 when neither is set → legacy flat
    ///      path in `execute`).
    function _tokenPrice8(address token) internal view returns (uint256) {
        address feed = tokenUsdFeed[token];
        if (feed != address(0)) {
            (, int256 answer, , , ) = IAggregatorV3Minimal(feed).latestRoundData();
            if (answer > 0) return uint256(answer);
        }
        return tokenUsdPrice8[token];
    }

    function adapterName() external view override returns (string memory) {
        return label;
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata /* adapterData */
    ) external override returns (uint256 outputAmount) {
        callCount += 1;
        if (restrictedTo != address(0) && msg.sender != restrictedTo) {
            revert("MockSwapAdapter: caller not allowed");
        }
        if (shouldRevert) revert("MockSwapAdapter: forced revert");

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);
        // Price-aware when both legs have a resolvable price (live feed first,
        // then static snapshot); else legacy flat.
        uint256 pIn = _tokenPrice8(inputToken);
        uint256 pOut = _tokenPrice8(outputToken);
        uint256 base = (pIn != 0 && pOut != 0)
            ? (inputAmount * pIn) / pOut
            : inputAmount;
        outputAmount = (base * outputMultiplierBps) / 10_000;
        require(outputAmount >= minOutputAmount, "MockSwapAdapter: min-out");
        IERC20(outputToken).safeTransfer(recipient, outputAmount);
    }
}
