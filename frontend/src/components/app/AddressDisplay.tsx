import type { CSSProperties, ReactNode } from 'react';
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
  className,
  style,
  emptyLabel = '',
}: AddressDisplayProps) {
  const { name } = useEnsName(hexOnly ? null : address);

  if (!address) return <>{emptyLabel}</>;

  const short = compact
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : shortenAddr(address);
  const display = hexOnly ? short : name ?? short;

  if (withTooltip && !hexOnly && name) {
    return (
      <span
        className={className}
        style={style}
        data-tooltip={address}
        data-tooltip-placement="below"
      >
        {display}
      </span>
    );
  }

  return (
    <span className={className} style={style}>
      {display}
    </span>
  );
}
