import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, Globe } from 'lucide-react';
import {
  compareChainsForDisplay,
  type ChainConfig,
} from '../contracts/config';
import './ChainPicker.css';

interface ChainPickerProps {
  /** Chains to show in the menu. Caller decides the filter (usually
   *  `diamondAddress !== null`). */
  chains: ChainConfig[];
  /** Currently-selected chainId, or null for "menu-only" usage (e.g. the
   *  footer's explorer-link picker) where no persistent selection exists. */
  value?: number | null;
  /** Fired with the picked chainId. Menu closes automatically. */
  onSelect: (chainId: number) => void;
  /** Label shown on the trigger when `value` has no match in `chains`. */
  placeholder?: string;
  /** Accessible name for the trigger button. */
  ariaLabel?: string;
  /** Which edge the popup menu aligns to; defaults to 'left'. */
  menuAlign?: 'left' | 'right';
}

/**
 * Public-pages analogue of the in-app `<ChainSwitcher>` — same premium
 * trigger-pill + grouped popup menu, but decoupled from wallet state so it
 * can be reused by the Footer (explorer-link menu), the analytics dashboard
 * (view-chain override), and the Buy VPFI discount card (wallet-switch
 * request). The in-app switcher stays wired to `useWallet` because it is
 * fundamentally a wallet-switch control; this one is the input-agnostic twin.
 */
export function ChainPicker({
  chains,
  value = null,
  onSelect,
  placeholder = 'Select network',
  ariaLabel = 'Select network',
  menuAlign = 'left',
}: ChainPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Canonical display order — Ethereum family first, rest alphabetical,
  // mainnets before testnets. Applied here as a safety net so callers that
  // pass an unsorted list still render in the expected order.
  const ordered = useMemo(
    () => [...chains].sort(compareChainsForDisplay),
    [chains],
  );

  const selected = ordered.find((c) => c.chainId === value) ?? null;
  const label = selected
    ? `${selected.name}${selected.testnet ? ' Testnet' : ''}`
    : placeholder;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (chainId: number) => {
    setOpen(false);
    onSelect(chainId);
  };

  const mainnets = ordered.filter((c) => !c.testnet);
  const testnets = ordered.filter((c) => c.testnet);

  return (
    <div className="chain-picker" ref={wrapRef}>
      <button
        type="button"
        className="chain-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <Globe size={14} />
        <span className="chain-picker-label">{label}</span>
        <ChevronDown size={14} className="chain-picker-chevron" />
      </button>
      {open && (
        <div
          className={`chain-picker-menu chain-picker-menu--${menuAlign}`}
          role="listbox"
        >
          {mainnets.length > 0 && (
            <>
              <div className="chain-picker-group">Mainnets</div>
              {mainnets.map((c) => (
                <button
                  key={c.chainId}
                  type="button"
                  role="option"
                  aria-selected={c.chainId === value}
                  className="chain-picker-item"
                  onClick={() => pick(c.chainId)}
                >
                  <span className="chain-picker-item-label">
                    {c.name}
                    {c.isCanonicalVPFI && (
                      <span className="chain-picker-pill">canonical</span>
                    )}
                  </span>
                  {c.chainId === value && <Check size={14} />}
                </button>
              ))}
            </>
          )}
          {testnets.length > 0 && (
            <>
              <div className="chain-picker-group">Testnets</div>
              {testnets.map((c) => (
                <button
                  key={c.chainId}
                  type="button"
                  role="option"
                  aria-selected={c.chainId === value}
                  className="chain-picker-item"
                  onClick={() => pick(c.chainId)}
                >
                  <span className="chain-picker-item-label">
                    {c.name}
                    {c.isCanonicalVPFI && (
                      <span className="chain-picker-pill">canonical</span>
                    )}
                  </span>
                  {c.chainId === value && <Check size={14} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
