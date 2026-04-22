import { useTokenMeta } from '../../lib/tokenMeta';
import { formatUnitsPretty } from '../../lib/format';

interface Props {
  amount: bigint;
  /** Token contract address; zero address = native ETH. */
  address: string;
  /** Override decimals (skips meta fetch). Useful when decimals are known. */
  decimals?: number;
  /** If true, shows `{amount} {symbol}`. Defaults to number only. */
  withSymbol?: boolean;
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
  className,
}: Props) {
  const meta = useTokenMeta(decimals === undefined ? address : null);
  const resolved = decimals ?? meta?.decimals ?? 18;
  const pretty = formatUnitsPretty(amount, resolved);
  const symbol = withSymbol ? ` ${meta?.symbol ?? ''}`.trimEnd() : '';
  return <span className={className}>{pretty}{symbol}</span>;
}
