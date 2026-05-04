import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { shortenAddr } from '../../lib/format';

/**
 * Inline shortened-address renderer with a one-click copy affordance.
 *
 * Renders `0x1234…abcd` (or a custom display string) followed by a
 * small `Copy` icon. On click the full underlying address goes onto
 * the clipboard and the icon flips to a green `Check` for ~1.5 s
 * before reverting — same affordance as GitHub's commit-hash copy
 * button. Hovering / focusing the icon shows a tooltip with the
 * full address so the user can verify before they paste.
 *
 * Use this wherever a redacted address is shown (Asset-wise
 * Breakdown, loan parties, claim center counterparty, etc.) so the
 * user never has to leave the page to grab the full hex.
 */
interface CopyableAddressProps {
  address: string;
  /** Override the visible label. Defaults to `shortenAddr(address)`. */
  display?: string;
  className?: string;
  /** Suppress the leading address text — useful when the icon sits
   *  next to an already-shown address (e.g. inside `AssetSymbol`)
   *  and the icon is the only new affordance. */
  iconOnly?: boolean;
}

export function CopyableAddress({
  address,
  display,
  className,
  iconOnly = false,
}: CopyableAddressProps) {
  const [copied, setCopied] = useState(false);

  if (!address) return null;

  const visible = display ?? shortenAddr(address);

  const onCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied / unsupported — fail silently;
      // the user can still long-press the visible text on mobile or
      // use the page's other inspectable surfaces (block explorer
      // link, hover tooltip).
    }
  };

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        verticalAlign: 'middle',
      }}
    >
      {!iconOnly && (
        <span className="mono" style={{ fontSize: 'inherit' }}>
          {visible}
        </span>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied address' : 'Copy address'}
        title={copied ? 'Copied!' : address}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          padding: 0,
          border: 'none',
          background: 'none',
          color: copied ? 'var(--accent-green, #10b981)' : 'var(--text-tertiary)',
          cursor: 'pointer',
          borderRadius: 'var(--radius-full, 999px)',
          transition: 'color 0.2s ease, transform 0.2s ease',
          transform: copied ? 'scale(1.15)' : 'scale(1)',
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}
