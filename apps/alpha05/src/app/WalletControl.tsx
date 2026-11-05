import { useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount, useSwitchChain } from 'wagmi';
import { DEFAULT_CHAIN, getSupportedChain, supportedChainNames } from '../chain/chains';
import { useCopy } from '../shared/copy/useCopy';
import { refusalFromError } from '../shared/eligibility/refusal';
import { WhyLink } from '../shared/help/WhyLink';
import { shortAddress } from '../shared/ui/format';
import { Notice } from '../shared/ui/Notice';

/**
 * The wallet control in the shell (matrix ACC-01, ACC-03): connect, the
 * connected identity as address and network, and the unsupported-network
 * state as a tier-A notice with the one remedy this session can drive (a
 * switch to a served network). ConnectKit's modal lists the connectors and
 * holds the disconnect; the control itself never hides which identity the
 * page's figures belong to.
 */
export function WalletControl() {
  const { text, format } = useCopy();
  const { address, chainId, status } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const chain = getSupportedChain(chainId);

  const unsupported = status === 'connected' && chain === null;
  const switchTo = async () => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: DEFAULT_CHAIN.chainId });
    } catch (e) {
      setSwitchError(refusalFromError(e).reason);
    }
  };

  return (
    <div className="wallet">
      <ConnectKitButton.Custom>
        {({ isConnected, isConnecting, show }) => {
          if (!isConnected) {
            return (
              <button type="button" className="btn btn-primary" onClick={show} disabled={isConnecting}>
                {isConnecting ? text('wallet.connecting') : text('wallet.connect')}
              </button>
            );
          }
          return (
            <button type="button" className="btn wallet-chip" onClick={show} aria-label={format('wallet.account', { address: address ?? '', chain: chain?.name ?? String(chainId ?? '') })} data-testid="wallet-chip">
              <span className="wallet-address">{address ? shortAddress(address) : ''}</span>
              <span className="wallet-chain">{chain?.name ?? `chain ${chainId ?? '?'}`}</span>
            </button>
          );
        }}
      </ConnectKitButton.Custom>
      {unsupported && (
        <Notice tone="danger" tier="A">
          {format('wallet.unsupported', { chains: supportedChainNames() })}{' '}
          <button type="button" className="btn" onClick={() => void switchTo()} disabled={isPending}>
            {format('wallet.switchTo', { chain: DEFAULT_CHAIN.name })}
          </button>
          {switchError && <span className="tier-a"> {format('wallet.switchFailed', { reason: switchError })}</span>}
        </Notice>
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
