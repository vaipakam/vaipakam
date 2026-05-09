/**
 * T-038 — Buy-asset display info for the Buy VPFI page.
 *
 * Resolves the chain + buy-adapter mode into a `{ symbol, coinGeckoUrl }`
 * pair so the UI can:
 *   - Label the input field with the actual asset the user pays in
 *     ("ETH" on ETH-native chains, "BNB"/"tBNB" on BNB native-gas mode,
 *     "WETH" on BNB / Polygon WETH-pull mode, etc.).
 *   - Deep-link the symbol to the canonical CoinGecko coin page so
 *     users can confirm exactly which token they need to acquire
 *     (WETH on BNB ≠ WETH on Polygon — different bridged contracts
 *     even though both share the symbol).
 *
 * The adapter mode comes either from runtime
 * (`useVPFIBuyBridge` returns `mode: 'native' | 'token'` after a quote)
 * or — when no quote is in flight yet — from the static
 * `chainConfig.vpfiBuyPaymentToken` field, which mirrors the on-chain
 * `paymentToken` storage slot through the deployments JSON.
 */
import type { ChainConfig } from '../contracts/config';

export interface BuyAssetInfo {
  /** Asset ticker shown in the BuyVPFI input + balance + rate cards. */
  symbol: string;
  /** Canonical CoinGecko deep-link for this asset, or `null` when no
   *  CoinGecko page exists for it (anvil, an unrecognised testnet,
   *  etc.). */
  coinGeckoUrl: string | null;
  /** True when the BuyAdapter is in WETH-pull mode on this chain.
   *  Drives the "approve before buy" UX branch in BuyVPFI. */
  isWethPullMode: boolean;
}

const COINGECKO_BASE = 'https://www.coingecko.com/en/coins/';

/**
 * Resolve the buy-asset for a chain. Mode argument lets the caller
 * override the static deployments-JSON inference with a live read
 * from `useVPFIBuyBridge` when a quote has fetched the adapter's
 * actual `paymentToken()`.
 *
 * @param chain Chain config (provides static metadata + the
 *              deployments-JSON-mirrored `vpfiBuyPaymentToken`).
 * @param modeOverride  Optional. Pass `'native'` or `'token'` after
 *              a successful `useVPFIBuyBridge.quote()` returns —
 *              that's the runtime authority. Omit (or pass null)
 *              to fall back to the chain-config inference.
 */
export function getBuyAssetInfo(
  chain: ChainConfig,
  modeOverride?: 'native' | 'token' | null,
): BuyAssetInfo {
  // Mode resolution: explicit > config-inferred.
  const isWethPullMode =
    modeOverride === 'token'
      ? true
      : modeOverride === 'native'
        ? false
        : chain.vpfiBuyPaymentToken != null;

  if (isWethPullMode) {
    return {
      symbol: 'WETH',
      coinGeckoUrl: chain.bridgedWethCoinGeckoSlug
        ? COINGECKO_BASE + chain.bridgedWethCoinGeckoSlug
        : null,
      isWethPullMode: true,
    };
  }

  return {
    symbol: chain.nativeGasSymbol,
    coinGeckoUrl: chain.nativeGasCoinGeckoSlug
      ? COINGECKO_BASE + chain.nativeGasCoinGeckoSlug
      : null,
    isWethPullMode: false,
  };
}
