import { useState, type CSSProperties, type ReactNode, type MouseEvent } from 'react';
import { Copy, Check } from 'lucide-react';
import { shortenAddr } from '../../lib/format';
import { useEnsName } from '../../hooks/useEnsName';

interface AddressDisplayProps {
  /** Raw `0x…` address. Pass-through when missing or the zero address. */
  address: string | null | undefined;
  /** When true the raw address appears in a dimmed tooltip next to the
   *  resolved name. Useful on loan-detail parties; skip on dense lists. */
  withTooltip?: boolean;
  /** Renders the monospace-hex shortform with no ENS lookup. Escape hatch
   *  for places that specifically want the hex (auditor views, tx traces). */
  hexOnly?: boolean;
  /** Tighter hex truncation for cramped surfaces like the topbar
   *  wallet pill — `0x12…abcd` (2+4 visible) instead of the
   *  default `0x1234…abcd` (4+4). Has no effect when ENS
   *  resolves; ENS names are always shown in full. */
  compact?: boolean;
  /** When true, renders a small copy icon next to the address that
   *  copies the FULL underlying hex to clipboard on click and flips to
   *  a green check for ~1.5 s. Off by default — opt-in on surfaces
   *  where the user might want to grab the full address (loan parties,
   *  offer creator, claim center counterparty). */
  copyable?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Fallback override for the "no address" render. Default empty string. */
  emptyLabel?: ReactNode;
}

/**
 * Phase 8a.1 — ENS / Basenames display wrapper.
 *
 * Resolves the address to `nick.eth` / `nick.base.eth` via `useEnsName`,
 * falls back to `shortenAddr` (`0x1234…abcd`) while loading or when no
 * record exists. Never blocks rendering; first paint uses the short
 * hex, the name swaps in asynchronously when the reverse lookup lands.
 *
 * Always safe to use — zero-address and invalid-hex inputs render
 * `emptyLabel` (defaults to an empty span).
 */
export function AddressDisplay({
  address,
  withTooltip = false,
  hexOnly = false,
  compact = false,
  copyable = false,
  className,
  style,
  emptyLabel = '',
}: AddressDisplayProps) {
  const { name } = useEnsName(hexOnly ? null : address);
  const [copied, setCopied] = useState(false);

  if (!address) return <>{emptyLabel}</>;

  const short = compact
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : shortenAddr(address);
  const display = hexOnly ? short : name ?? short;

  const onCopy = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied / unsupported — fail silently.
    }
  };

  const copyButton = copyable ? (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied address' : 'Copy address'}
      title={copied ? 'Copied!' : address}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        marginLeft: 4,
        padding: 0,
        border: 'none',
        background: 'none',
        color: copied ? 'var(--accent-green, #10b981)' : 'var(--text-tertiary)',
        cursor: 'pointer',
        borderRadius: 'var(--radius-full, 999px)',
        transition: 'color 0.2s ease, transform 0.2s ease',
        transform: copied ? 'scale(1.15)' : 'scale(1)',
        verticalAlign: 'middle',
      }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  ) : null;

  if (withTooltip && !hexOnly && name) {
    return (
      <span
        className={className}
        style={style}
        data-tooltip={address}
        data-tooltip-placement="below"
      >
        {display}
        {copyButton}
      </span>
    );
  }

  return (
    <span className={className} style={style}>
      {display}
      {copyButton}
    </span>
  );
}
