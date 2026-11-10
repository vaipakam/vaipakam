import { useEffect, useId, useRef, useState } from 'react';
import { useModal } from 'connectkit';
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { DEFAULT_CHAIN, SUPPORTED_CHAINS, getSupportedChain, supportedChainNames } from '../chain/chains';
import { useCopy } from '../shared/copy/useCopy';
import { refusalFromError } from '../shared/eligibility/refusal';
import { WhyLink } from '../shared/help/WhyLink';
import { shortAddress } from '../shared/ui/format';
import { Notice } from '../shared/ui/Notice';

/**
 * The wallet control in the shell (matrix ACC-01, ACC-03): connect, the
 * connected identity as address and network, and the unsupported-network
 * state as a tier-A notice with the one remedy this session can drive (a
 * switch to a served network). The control itself never hides which identity
 * the page's figures belong to.
 *
 * ConnectKit's modal is used to CONNECT only (its wallet list). Once a wallet
 * is connected, the account surface is this app's own panel (#3476):
 * ConnectKit's connected surfaces (its button renderer, profile page and
 * avatar) each look up an ENS name on Ethereum mainnet, and with no mainnet
 * in this app's chains they read it from a third-party endpoint the page
 * never names, which refuses the page's origin. The app reads nothing on
 * mainnet, so the panel shows the address itself.
 */
export function WalletControl() {
  const { text, format } = useCopy();
  const { address, chainId, status } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const { setOpen: openConnect } = useModal();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const chain = getSupportedChain(chainId);

  const unsupported = status === 'connected' && chain === null;
  const switchTo = async (target: number) => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: target });
    } catch (e) {
      setSwitchError(refusalFromError(e).reason);
    }
  };

  // The label follows the wallet's own state, not the picker's: an open
  // picker connects nothing until a wallet is chosen, so it must not read as
  // connecting.
  const connecting = status === 'connecting' || status === 'reconnecting';
  return (
    <div className="wallet">
      {status === 'connected' && address ? (
        <AccountPanel address={address} chainId={chainId} onSwitch={switchTo} switching={isPending} />
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => openConnect(true)} disabled={connecting}>
          {connecting ? text('wallet.connecting') : text('wallet.connect')}
        </button>
      )}
      {unsupported && (
        <Notice tone="danger" tier="A">
          {format('wallet.unsupported', { chains: supportedChainNames() })}{' '}
          <button type="button" className="btn" onClick={() => void switchTo(DEFAULT_CHAIN.chainId)} disabled={isPending}>
            {format('wallet.switchTo', { chain: DEFAULT_CHAIN.name })}
          </button>
        </Notice>
      )}
      {switchError && (
        <Notice tone="danger" tier="A">
          {format('wallet.switchFailed', { reason: switchError })}
        </Notice>
      )}
    </div>
  );
}

/** The connected wallet's chip and the panel it opens: the full address
 *  (with a copy action), the network, a switch to each other served network,
 *  and disconnect. Escape or a press outside closes it. */
function AccountPanel({
  address,
  chainId,
  onSwitch,
  switching,
}: {
  address: `0x${string}`;
  chainId: number | undefined;
  onSwitch: (chainId: number) => Promise<void>;
  switching: boolean;
}) {
  const { text, format } = useCopy();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const chain = getSupportedChain(chainId);
  const chainName = chain?.name ?? `chain ${chainId ?? '?'}`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      chip.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="wallet-account" ref={root}>
      <button
        type="button"
        ref={chip}
        className="btn wallet-chip"
        onClick={() => {
          setCopied(null);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={format('wallet.account', { address, chain: chainName })}
        data-testid="wallet-chip"
      >
        <span className="wallet-address">{shortAddress(address)}</span>
        <span className="wallet-chain">{chainName}</span>
      </button>
      {open && (
        <div className="wallet-panel" id={panelId} role="group" aria-label={text('wallet.panel')} data-testid="wallet-panel">
          <p className="wallet-full">{address}</p>
          <button type="button" className="btn" onClick={() => void copy()}>
            {text('wallet.copy')}
          </button>
          {copied && (
            <span className="tier-b" role="status">
              {text(copied === 'copied' ? 'wallet.copied' : 'wallet.copyFailed')}
            </span>
          )}
          <p className="tier-b">{format('wallet.network', { chain: chainName })}</p>
          {SUPPORTED_CHAINS.filter((c) => c.chainId !== chainId).map((c) => (
            <button key={c.chainId} type="button" className="btn" disabled={switching} onClick={() => void onSwitch(c.chainId).then(() => setOpen(false))}>
              {format('wallet.switchTo', { chain: c.name })}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            {text('wallet.disconnect')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The identity line a page's figures belong to (RB-RAILS), with its "Why?". */
export function IdentityLine() {
  const { address, chainId, status } = useAccount();
  const chain = getSupportedChain(chainId);
  if (status !== 'connected' || !address || !chain) return null;
  return <WhyLink summaryKey="wallet.account" detailKey="wallet.accountWhy" vars={{ address: shortAddress(address), chain: chain.name }} />;
}
