import { ExternalLink } from 'lucide-react';
import { resolveSymbol } from '../lib/formatAsset';
import { contractExplorerUrl } from '../lib/explorer';
import { peekTokenMeta, type TokenMeta } from '../lib/tokenMeta';
import { useReadChain } from '../hooks/useDiamond';
import './AssetSymbolLink.css';

interface Props {
  address: string;
  meta?: TokenMeta | null;
  showIcon?: boolean;
  className?: string;
}

export function AssetSymbolLink({ address, meta, showIcon = false, className }: Props) {
  const chain = useReadChain();
  const resolved = meta ?? peekTokenMeta(address);
  const symbol = resolveSymbol(resolved, address);
  const href = contractExplorerUrl(chain.blockExplorer, address);

  if (!href) {
    return <span className={className}>{symbol}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`asset-symbol-link ${className ?? ''}`}
      title={`View ${symbol} on ${chain.name} explorer`}
      onClick={(e) => e.stopPropagation()}
    >
      {symbol}
      {showIcon ? <ExternalLink size={12} className="asset-symbol-link-icon" aria-hidden /> : null}
    </a>
  );
}