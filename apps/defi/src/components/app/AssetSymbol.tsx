import { useTokenMeta } from '../../lib/tokenMeta';
import { shortenAddr } from '../../lib/format';

interface Props {
  address: string;
  /** Optional class for the wrapper span. */
  className?: string;
}

/**
 * Renders a token's symbol with the full contract address surfaced as a
 * themed hover tooltip. Falls back to a shortened address until the symbol
 * is resolved (or for non-ERC20 / unsupported tokens).
 */
export function AssetSymbol({ address, className }: Props) {
  const meta = useTokenMeta(address);
  const label = meta?.symbol || shortenAddr(address);
  return (
    <span className={className} data-tooltip={address} style={{ cursor: 'help' }}>
      {label}
    </span>
  );
}
