import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Globe } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';
import {
  CHAIN_REGISTRY,
  DEFAULT_CHAIN,
  compareChainsForDisplay,
} from '../../contracts/config';
import './ChainSwitcher.css';

/**
 * Always-visible chain switcher in the app topbar. Lets the user jump between
 * any network Vaipakam has a live Diamond on, regardless of whether the wallet
 * is currently on a supported chain. When no wallet is connected, the button
 * shows the read-only DEFAULT_CHAIN and clicking a chain prompts the wallet
 * to connect/switch via wallet_switchEthereumChain + wallet_addEthereumChain.
 */
export function ChainSwitcher() {
  const { activeChain, chainId, switchToChain } = useWallet();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = activeChain ?? (chainId == null ? DEFAULT_CHAIN : null);
  const label = current
    ? `${current.name}${current.testnet ? ' Testnet' : ''}`
    : chainId != null
      ? `Unsupported (${chainId})`
      : 'Read-only';

  const deployedChains = Object.values(CHAIN_REGISTRY)
    .filter((c) => c.diamondAddress !== null)
    .sort(compareChainsForDisplay);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const onPick = async (targetChainId: number) => {
    setOpen(false);
    if (targetChainId === chainId) return;
    await switchToChain(targetChainId);
  };

  const unsupported = chainId != null && !activeChain;

  return (
    <div className="chain-switcher" ref={wrapRef}>
      <button
        type="button"
        className={`chain-switcher-btn ${unsupported ? 'unsupported' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip="Switch network"
        data-tooltip-placement="below"
      >
        <Globe size={14} />
        <span className="chain-switcher-label">{label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="chain-switcher-menu" role="listbox">
          {deployedChains.some((c) => !c.testnet) && (
            <>
              <div className="chain-switcher-group">Mainnets</div>
              {deployedChains
                .filter((c) => !c.testnet)
                .map((c) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={c.chainId === chainId}
                    key={c.chainId}
                    className="chain-switcher-item"
                    onClick={() => onPick(c.chainId)}
                  >
                    <span>
                      {c.name}
                      {c.isCanonicalVPFI && (
                        <span className="chain-switcher-pill">canonical</span>
                      )}
                    </span>
                    {c.chainId === chainId && <Check size={14} />}
                  </button>
                ))}
            </>
          )}
          {deployedChains.some((c) => c.testnet) && (
            <>
              <div className="chain-switcher-group">Testnets</div>
              {deployedChains
                .filter((c) => c.testnet)
                .map((c) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={c.chainId === chainId}
                    key={c.chainId}
                    className="chain-switcher-item"
                    onClick={() => onPick(c.chainId)}
                  >
                    <span>
                      {c.name}
                      {c.isCanonicalVPFI && (
                        <span className="chain-switcher-pill">canonical</span>
                      )}
                    </span>
                    {c.chainId === chainId && <Check size={14} />}
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
