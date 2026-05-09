import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import './WalletAddressPill.css';

/**
 * `<WalletAddressPill>` — connected-wallet badge that doubles as a
 * one-click copy affordance.
 *
 * Anatomy (left → right):
 *   - status dot (green) — visual marker for "wallet connected"
 *   - address text — `<AddressDisplay compact />` so the redacted
 *     form is `0x12…abc`, with ENS winning when resolved
 *   - copy icon button — clicks copy the FULL hex (not the redacted
 *     form) to the clipboard, then briefly swap to a green check +
 *     "Copied" label for 1.2s before reverting
 *
 * Replaces the WalletMenu popover-pill on the public Navbar + in-app
 * topbar. The chain switcher and disconnect actions live alongside
 * this pill as siblings (in `.wallet-connected`), not nested inside,
 * so each control is one click away on every viewport.
 *
 * Clipboard fallback: on iOS Safari < 13.4 (and other environments
 * where `navigator.clipboard` is gated), drops to the legacy
 * textarea + `execCommand('copy')` trick so copy still works.
 */
export interface WalletAddressPillProps {
  address: string;
  /** Extra className on the outer wrapper. Useful for placement
   *  tweaks at a specific callsite (e.g. `.navbar-cta`). */
  className?: string;
}

export function WalletAddressPill({ address, className }: WalletAddressPillProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Clear any pending "Copied" timer on unmount so it doesn't fire
  // setState on a dead component (e.g. user disconnected mid-flash).
  useEffect(
    () => () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        // Legacy fallback for environments without the clipboard
        // API (older iOS Safari, http:// origins).
        const ta = document.createElement('textarea');
        ta.value = address;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1200);
    } catch {
      // Silent fail — most browsers also support long-press → Copy
      // via native UI, so the user can still extract the address
      // even when the JS clipboard path is blocked.
    }
  }

  return (
    <button
      type="button"
      className={`wallet-address-pill${
        copied ? ' wallet-address-pill--copied' : ''
      }${className ? ' ' + className : ''}`}
      onClick={handleCopy}
      aria-label={copied ? 'Address copied' : 'Copy wallet address'}
      aria-live="polite"
    >
      <span className="wallet-dot" aria-hidden="true" />
      <span className="wallet-address-pill-text">
        {/* Mobile-flyout context — 6 + 6 redacted hex form
         *  (`0x123456…abcdef`) so the address has enough visual
         *  weight to read as a real artifact, matching the
         *  WalletMenu popover row exactly. ENS is intentionally
         *  bypassed: this surface is the "I want to copy my
         *  on-chain address" affordance. */}
        {`${address.slice(0, 8)}…${address.slice(-6)}`}
      </span>
      {/* Copy / check glyph — now a non-interactive `<span>` since
       *  the entire pill is the click target. Tapping anywhere
       *  inside the pill copies the full address; the glyph just
       *  reflects whether we're idle or in the post-copy flash. */}
      <span className="wallet-address-pill-copy-icon" aria-hidden="true">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </span>
    </button>
  );
}

export default WalletAddressPill;
