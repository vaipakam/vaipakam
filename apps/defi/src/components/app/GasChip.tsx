import { type FC } from 'react';
import { formatUnits } from 'viem';
import './GasChip.css';

/**
 * Props for {@link GasChip}.
 */
export interface GasChipProps {
  /**
   * Gas units the transaction is estimated to consume. Typically the
   * return of a viem `publicClient.estimateGas(...)` or
   * `estimateContractGas(...)` call.
   *
   * When null / undefined, the chip renders an em-dash placeholder so
   * the surface keeps its layout while the estimate is in flight.
   */
  gasUnits?: bigint | null;
  /**
   * Gas price (wei per unit). Typically `publicClient.getGasPrice()`
   * on legacy chains or the `maxFeePerGas` portion of EIP-1559 for
   * cleaner UX (the user-facing number tracks the cap, not the
   * effective).
   *
   * When null / undefined, behaves identically to a null `gasUnits`.
   */
  gasPriceWei?: bigint | null;
  /**
   * Native token (ETH / BNB / MATIC etc.) decimals. Defaults to 18 —
   * every Vaipakam-supported chain uses 18-decimal native gas, so the
   * default is correct, but the prop stays explicit for any future
   * non-18-dec chain integration.
   */
  nativeDecimals?: number;
  /**
   * Native token symbol for the display (`ETH` / `BNB` / etc.). The
   * chip renders the native amount with this suffix; the USD price
   * (if present) gives the reader a quick "is this gas reasonable"
   * cross-check.
   */
  nativeSymbol: string;
  /**
   * USD price of one native token. When provided, the chip renders a
   * "(~ $X.XX)" qualifier next to the native amount. When undefined
   * / null, the qualifier is omitted (the surface degrades to native-
   * only display, still useful).
   */
  nativePriceUsd?: number | null;
  /**
   * Optional className passthrough for layout-side styling.
   */
  className?: string;
  /**
   * Accessible label for the chip. Defaults to `Estimated network
   * fee`; consumers can override for specific surfaces (e.g.,
   * `Cross-chain CCIP fee` on the buy-flow modal).
   */
  ariaLabel?: string;
}

/**
 * Hard cap on the visible native-amount precision so a chip on a
 * tight modal layout doesn't render `0.00012345 ETH` and break the
 * line wrap. We keep four significant digits worth of decimal
 * precision — enough to disambiguate $0.20 vs $0.30 at typical
 * mainnet prices, not enough to break the chip's width budget.
 */
const NATIVE_PRECISION = 6;

/**
 * Round an integer-decimal string ("0.000123456789...") to a target
 * decimal precision without going via `parseFloat` (which would lose
 * precision on big numbers). Pure-string trim; the caller has
 * already ensured the input is finite + non-negative.
 *
 * The second return value flags whether the input was truncated to
 * zero — i.e. the value was non-zero but smaller than `10^-precision`.
 * The caller renders a "< floor" indicator in that case so a tiny
 * gas fee never displays as a flat zero (which would understate the
 * estimate to a low-fee-chain user — Codex round-1 P2 catch).
 */
function trimDecimal(
  s: string,
  precision: number,
): { display: string; truncatedToZero: boolean } {
  const idx = s.indexOf('.');
  if (idx < 0) return { display: s, truncatedToZero: false };
  const trimmed = s.slice(0, idx + precision + 1);
  // Drop trailing zeros after the decimal point so "0.001000" reads
  // as "0.001" — cleaner on the chip without losing information.
  const cleaned = trimmed
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

  // Detect the "truncated to zero" case: original string had a
  // non-zero digit somewhere, but the trim sliced it off so `cleaned`
  // ends at "0" or "-0". The caller turns this into a "< 10^-precision"
  // display rather than silently rendering "0 ETH" for a tiny non-zero
  // fee.
  const isZero = cleaned === '0' || cleaned === '-0';
  const sourceHasNonZero = /[1-9]/.test(s);
  return { display: cleaned, truncatedToZero: isZero && sourceHasNonZero };
}

/**
 * `GasChip` — the canonical state-mutating-confirm gas-disclosure
 * surface per the UX direction ADR Tier A.8 (PR #201). Renders a
 * compact "X.XXX ETH (~ $Y.YY)" chip pinned to the bottom of every
 * state-mutating confirm modal above the primary CTA, matching how
 * Uniswap / 1inch / Cowswap render their estimated network-fee
 * line.
 *
 * Pre-#216 the gas disclosure appears on `LiquidateButton` (one
 * shape) + the Permit2-preview modal (a different shape). This card
 * unifies the visual treatment so each consuming sub-card lands a
 * single-line `<GasChip ... />` instead of re-rolling the formatting.
 *
 * Deliberately **pure-presentational**: the chip takes pre-computed
 * `gasUnits` + `gasPriceWei` + `nativePriceUsd` props and renders.
 * It does NOT make any RPC calls itself — the consuming page /
 * modal is responsible for fetching the estimate via viem + the
 * price via the project's price-feed surface. This keeps the
 * component testable without mocking RPC, and keeps the
 * fetch-frequency policy (one-shot, polling, refresh-pre-sign) at
 * the consumer where it belongs.
 *
 * The chip auto-renders a placeholder em-dash when `gasUnits` or
 * `gasPriceWei` is null / undefined, so a modal opening with the
 * estimate in flight doesn't flicker layout.
 *
 * @example
 * // Consumer responsibility — compute the values once + refresh on
 * // a pre-sign hook the page already owns:
 * const gasUnits = await publicClient.estimateContractGas({...});
 * const gasPriceWei = await publicClient.getGasPrice();
 * const nativePriceUsd = useNativePriceUsd();
 *
 * <GasChip
 *   gasUnits={gasUnits}
 *   gasPriceWei={gasPriceWei}
 *   nativeSymbol="ETH"
 *   nativePriceUsd={nativePriceUsd}
 * />
 *
 * @example
 * // Placeholder while estimating
 * <GasChip
 *   gasUnits={null}
 *   gasPriceWei={null}
 *   nativeSymbol="ETH"
 * />
 * // renders: "— ETH"
 */
export const GasChip: FC<GasChipProps> = ({
  gasUnits,
  gasPriceWei,
  nativeDecimals = 18,
  nativeSymbol,
  nativePriceUsd,
  className,
  ariaLabel = 'Estimated network fee',
}) => {
  // Null state — keep the surface stable while the estimate is in flight.
  if (gasUnits == null || gasPriceWei == null) {
    return (
      <span
        role="status"
        aria-label={ariaLabel}
        className={`gas-chip gas-chip-pending${className ? ` ${className}` : ''}`}
      >
        — {nativeSymbol}
      </span>
    );
  }

  // Total wei the user pays for gas, in BigInt to avoid loss-of-
  // precision risks on chains where the gas-units value can exceed
  // 2^53 (rare but possible for complex multi-call transactions).
  const totalWei = gasUnits * gasPriceWei;
  // `formatUnits` returns a decimal string keyed off the decimals
  // parameter — this is the standard viem helper, no custom math.
  const nativeDecimalStr = formatUnits(totalWei, nativeDecimals);
  const { display: trimmed, truncatedToZero } = trimDecimal(
    nativeDecimalStr,
    NATIVE_PRECISION,
  );

  // Tiny-fee preservation: a non-zero fee smaller than the display
  // precision floor (10^-NATIVE_PRECISION native units) would otherwise
  // render as "0 <SYMBOL>" — understating the estimate on low-fee
  // chains (Base / Polygon / BNB at quiet mempool moments). Render it
  // as "< 0.000001 <SYMBOL>" instead so the user knows the fee is
  // bounded-but-non-zero. The "<" semantic mirrors the way Uniswap
  // / 1inch surface dust-sized swap impacts.
  const floor = `0.${'0'.repeat(NATIVE_PRECISION - 1)}1`; // e.g. "0.000001"
  const nativeDisplay = truncatedToZero ? `< ${floor}` : trimmed;

  // USD qualifier — optional. When undefined / null, the chip just
  // renders the native amount; the qualifier auto-degrades.
  let usdSuffix = '';
  if (nativePriceUsd != null && Number.isFinite(nativePriceUsd)) {
    // Parse the trimmed decimal back to a float for the USD math —
    // we accept the float-rounding cost here because the USD figure
    // is itself approximate and we cap precision at $0.01.
    const nativeFloat = Number(nativeDecimalStr);
    if (Number.isFinite(nativeFloat)) {
      const usd = nativeFloat * nativePriceUsd;
      // Round half-away-from-zero with `toFixed(2)` — fine for a
      // display estimate the user is reading not bookkeeping against.
      // For truncated-to-zero native amounts, also surface the USD as
      // a "< $0.01" bound when the computed USD rounds to zero — same
      // semantic, same reason.
      if (truncatedToZero && usd < 0.005) {
        usdSuffix = ' (~ < $0.01)';
      } else {
        usdSuffix = ` (~ $${usd.toFixed(2)})`;
      }
    }
  }

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={`gas-chip${className ? ` ${className}` : ''}`}
    >
      {nativeDisplay} {nativeSymbol}{usdSuffix}
    </span>
  );
};
