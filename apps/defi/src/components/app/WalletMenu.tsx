import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Globe, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import {
  CHAIN_REGISTRY,
  DEFAULT_CHAIN,
  compareChainsForDisplay,
} from '../../contracts/config';
import { AddressDisplay } from './AddressDisplay';
import { ChainIcon } from './ChainIcon';
import './WalletMenu.css';

/**
 * `<WalletMenu>` — connected-wallet pill that doubles as the entry-point
 * for "switch network" and "disconnect" actions.
 *
 * Why this replaces the inline pill + standalone disconnect-icon + topbar
 * `<ChainSwitcher>` triplet:
 *
 *   - Three separate controls in the topbar (chain switcher, wallet
 *     pill, disconnect icon) compete for horizontal real-estate on
 *     mobile and produce a busy reading order. Folding the chain
 *     switcher and disconnect under the wallet address makes the
 *     pill the single discoverable entry-point for everything that
 *     mutates session state.
 *   - The chain icon next to the address gives users a glance-able
 *     "which network am I on" cue; the address pill on its own only
 *     shows hex/ENS, which doesn't disambiguate Sepolia vs Base
 *     Sepolia vs BNB Testnet at a glance.
 *
 * Behaviour:
 *   - Click the pill → popover opens with current network + a list of
 *     other deployed chains + a disconnect button.
 *   - Picking a chain calls `wallet_switchEthereumChain`. If the
 *     wallet doesn't have the chain, `switchToChain` falls back to
 *     `wallet_addEthereumChain`.
 *   - Pointer-down outside the menu, Escape, or scroll/resize closes
 *     it. Same dismissal pattern as the InfoTip / Settings popover.
 *
 * The wrong-chain banner is rendered separately (not in this menu)
 * so the warning stays visible without requiring the user to open
 * a menu first.
 */
export function WalletMenu() {
  const { t } = useTranslation();
  const { address, chainId, activeChain, disconnect, switchToChain } =
    useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // Close on outside click / Escape / scroll. Same pattern as the
  // settings popover and InfoTip — the bubble shouldn't outlive the
  // user's attention.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Clear any pending "Copied" timer on unmount so a closing menu
  // doesn't fire setState on a dead component.
  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  if (!address) return null;

  const current = activeChain ?? (chainId == null ? DEFAULT_CHAIN : null);
  const currentLabel = current
    ? `${current.name}${current.testnet ? ' Testnet' : ''}`
    : chainId != null
      ? `Unsupported (${chainId})`
      : 'Read-only';

  // Show every chain we have a Diamond on — sorted mainnets first by
  // canonical, then testnets. Same sort the standalone ChainSwitcher
  // uses, so ordering stays consistent across surfaces.
  const deployedChains = Object.values(CHAIN_REGISTRY)
    .filter((c) => c.diamondAddress !== null)
    .sort(compareChainsForDisplay);

  const handlePickChain = async (targetChainId: number) => {
    setOpen(false);
    if (targetChainId === chainId) return;
    await switchToChain(targetChainId);
  };

  const handleDisconnect = () => {
    setOpen(false);
    disconnect();
  };

  /** Copy the connected wallet's full hex address to the clipboard
   *  and flash a "Copied" state for 1.2s. Falls back to the legacy
   *  textarea + execCommand trick on environments without the
   *  clipboard API (older iOS Safari, http:// origins). The popover
   *  stays open so the user can confirm the copy succeeded. */
  const handleCopyAddress = async () => {
    if (!address) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
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
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1200);
    } catch {
      // Silent fail — most browsers also offer long-press → Copy
      // via native UI on the visible hex text.
    }
  };

  return (
    <div className="wallet-menu" ref={wrapRef}>
      <button
        type="button"
        className="wallet-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('wallet.menuAriaLabel')}
      >
        <span className="wallet-dot" />
        <span className="wallet-menu-address">
          {/* Compact form (`0x12…abcd`, 2+4) so the trigger pill
           *  stays short. ENS still wins when resolved. The full
           *  redacted form (`0x123456…abcdef`, 6+6) appears at the
           *  top of the popover alongside the copy button. */}
          <AddressDisplay address={address} compact />
        </span>
        {/* Chain badge — icon + chain name. Lives on the trailing edge
         *  of the trigger so the address is read first; chevron stays
         *  rightmost. The full chain name (not just the icon) is
         *  surfaced here so the user always knows which network they're
         *  about to transact on without having to open the popover or
         *  decode the icon. Falls back to "Unsupported" when the wallet
         *  is on an unrecognised chain (the warning recovery picker
         *  appears alongside in that state).  */}
        <span
          className="wallet-menu-chain"
          aria-label={`Network: ${currentLabel}`}
        >
          <ChainIcon chainId={chainId} size={16} />
          <span className="wallet-menu-chain-label">{currentLabel}</span>
        </span>
        <ChevronDown
          size={14}
          className="wallet-menu-chevron"
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          className="wallet-menu-panel"
          role="menu"
          aria-label={t('wallet.actionsAriaLabel')}
        >
          {/* Address section at the very top of the popover —
           *  redacted hex form (always, even when ENS resolves)
           *  with a click-anywhere-to-copy affordance. The whole
           *  row is the click target; the trailing icon is just
           *  the visual cue and swaps to a green Check + brand-
           *  tinted background flash for 1.2s after each copy.
           *  Copying writes the FULL hex to the clipboard, not
           *  the redacted display form. */}
          <div className="wallet-menu-section">
            <div className="wallet-menu-section-label">
              <span>Address</span>
            </div>
            <button
              type="button"
              className={`wallet-menu-address-row${
                copied ? ' wallet-menu-address-row--copied' : ''
              }`}
              onClick={handleCopyAddress}
              aria-label={copied ? 'Address copied' : 'Copy wallet address'}
              aria-live="polite"
            >
              <span className="wallet-menu-address-hex">
                {`${address.slice(0, 8)}…${address.slice(-6)}`}
              </span>
              <span
                className="wallet-menu-address-copy-icon"
                aria-hidden="true"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </span>
            </button>
          </div>

          <div className="wallet-menu-section">
            <div className="wallet-menu-section-label">
              <Globe size={12} aria-hidden="true" />
              <span>Network</span>
            </div>
            <div className="wallet-menu-current">
              <ChainIcon chainId={chainId} size={20} />
              <div className="wallet-menu-current-text">
                <span className="wallet-menu-current-name">{currentLabel}</span>
                {current?.isCanonicalVPFI && (
                  <span className="wallet-menu-canonical-pill">{t('wallet.canonical')}</span>
                )}
              </div>
            </div>
          </div>

          {deployedChains.length > 1 && (
            <div className="wallet-menu-section">
              <div className="wallet-menu-section-label">{t('wallet.switchTo')}</div>
              <div className="wallet-menu-chain-list" role="listbox">
                {deployedChains
                  .filter((c) => c.chainId !== chainId)
                  .map((c) => (
                    <button
                      key={c.chainId}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="wallet-menu-chain-item"
                      onClick={() => handlePickChain(c.chainId)}
                    >
                      <ChainIcon chainId={c.chainId} size={18} />
                      <span className="wallet-menu-chain-name">
                        {c.name}
                        {c.testnet && (
                          <span className="wallet-menu-testnet-tag">
                            {t('wallet.testnet')}
                          </span>
                        )}
                      </span>
                      {c.isCanonicalVPFI && (
                        <span className="wallet-menu-canonical-pill">
                          canonical
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <button
            type="button"
            className="wallet-menu-disconnect"
            onClick={handleDisconnect}
            role="menuitem"
          >
            <LogOut size={14} aria-hidden="true" />
            <span>{t('common.disconnect')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default WalletMenu;
