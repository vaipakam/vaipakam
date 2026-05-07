import { useTokenMeta } from '../../lib/tokenMeta';
import { formatUnitsPretty, formatUnitsCompact } from '../../lib/format';

interface Props {
  amount: bigint;
  /** Token contract address; zero address = native ETH. */
  address: string;
  /** Override decimals (skips meta fetch). Useful when decimals are known. */
  decimals?: number;
  /** If true, shows `{amount} {symbol}`. Defaults to number only. */
  withSymbol?: boolean;
  /**
   * If true, render with locale-aware compact notation (e.g. `2.5K`,
   * `4.54M`, `2,5 Mio.` in de, `2.5万` in ja). The full precise value
   * is surfaced as a hover tooltip so users who need the exact number
   * can still read it. Use in dense list views; leave off for detail
   * pages where the exact amount is load-bearing.
   */
  compact?: boolean;
  className?: string;
}

/**
 * Human-readable token amount. Pulls decimals from the token's `decimals()`
 * unless overridden. Defaults to 18 decimals while metadata is loading, so
 * the first render of common ERC-20s looks right immediately.
 */
export function TokenAmount({
  amount,
  address,
  decimals,
  withSymbol = false,
  compact = false,
  className,
}: Props) {
  const meta = useTokenMeta(decimals === undefined ? address : null);
  const resolved = decimals ?? meta?.decimals ?? 18;
  const pretty = formatUnitsPretty(amount, resolved);
  const symbol = withSymbol ? ` ${meta?.symbol ?? ''}`.trimEnd() : '';
  if (compact) {
    const display = formatUnitsCompact(amount, resolved);
    return (
      <span
        className={className}
        data-tooltip={`${pretty}${symbol}`}
        style={{ cursor: 'help' }}
      >
        {display}
        {symbol}
      </span>
    );
  }
  return <span className={className}>{pretty}{symbol}</span>;
}
