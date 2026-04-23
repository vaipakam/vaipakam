import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Link2, Wallet } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';

interface Props {
  /** Extra classes applied to the primary button (e.g. `btn-sm`). */
  className?: string;
  /** When true, renders the button at `width: 100%` — used in the mobile
   *  navbar where the button is the full-row CTA. */
  fullWidth?: boolean;
}

/**
 * Single-source-of-truth Connect-Wallet button.
 *
 * Behaviour:
 *   - When WalletConnect is NOT configured (no `VITE_WALLETCONNECT_PROJECT_ID`),
 *     acts as a plain button that calls `connect('injected')`.
 *   - When WalletConnect IS configured, renders a split-button: the main
 *     click still goes to the injected path (same UX as before — most
 *     users still use MetaMask / Rabby), and a chevron next to it opens a
 *     small menu with a "WalletConnect" option for users on mobile
 *     browsers or users who want to connect from a non-injected wallet
 *     (Rainbow / Trust / Coinbase Wallet via QR).
 *
 * Single component used by both the landing-page `Navbar` and the
 * authenticated `AppLayout` topbar so the choice UX stays consistent.
 */
export function ConnectWalletButton({ className = '', fullWidth = false }: Props) {
  const { connect, isConnecting, walletConnectAvailable } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside click / Escape, standard popover hygiene.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (ev: MouseEvent) => {
      if (!menuRef.current?.contains(ev.target as Node)) setMenuOpen(false);
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const primaryLabel = isConnecting ? 'Connecting…' : 'Connect Wallet';

  // Single-button path — no WalletConnect, no split UI.
  if (!walletConnectAvailable) {
    return (
      <button
        type="button"
        className={`btn btn-primary ${className}`}
        onClick={() => void connect('injected')}
        disabled={isConnecting}
        style={fullWidth ? { width: '100%' } : undefined}
      >
        <Wallet size={16} />
        {primaryLabel}
      </button>
    );
  }

  // Split-button path — injected main + WalletConnect dropdown.
  return (
    <div
      ref={menuRef}
      style={{
        display: 'inline-flex',
        position: 'relative',
        width: fullWidth ? '100%' : 'auto',
      }}
    >
      <button
        type="button"
        className={`btn btn-primary ${className}`}
        onClick={() => void connect('injected')}
        disabled={isConnecting}
        style={{
          flex: fullWidth ? 1 : undefined,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          paddingRight: 12,
        }}
      >
        <Wallet size={16} />
        {primaryLabel}
      </button>
      <button
        type="button"
        className={`btn btn-primary ${className}`}
        onClick={() => setMenuOpen((v) => !v)}
        disabled={isConnecting}
        aria-label="More wallet options"
        aria-expanded={menuOpen}
        data-tooltip="Other wallets (WalletConnect)"
        data-tooltip-placement="below-end"
        style={{
          borderLeft: '1px solid rgba(255, 255, 255, 0.25)',
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        <ChevronDown size={16} />
      </button>

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 240,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            padding: 6,
            zIndex: 200,
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost"
            onClick={() => {
              setMenuOpen(false);
              void connect('injected');
            }}
            style={{
              width: '100%',
              justifyContent: 'flex-start',
              gap: 10,
              padding: '10px 12px',
            }}
          >
            <Wallet size={16} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Browser Wallet</div>
              <div
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--text-tertiary)',
                  marginTop: 2,
                }}
              >
                MetaMask, Rabby, Brave, or any injected wallet
              </div>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost"
            onClick={() => {
              setMenuOpen(false);
              void connect('walletconnect');
            }}
            style={{
              width: '100%',
              justifyContent: 'flex-start',
              gap: 10,
              padding: '10px 12px',
              marginTop: 2,
            }}
          >
            <Link2 size={16} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>WalletConnect</div>
              <div
                style={{
                  fontSize: '0.72rem',
                  color: 'var(--text-tertiary)',
                  marginTop: 2,
                }}
              >
                Rainbow, Trust, Coinbase Wallet, Phantom… (QR)
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
