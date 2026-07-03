import { useWallet } from '../context/WalletContext';
import { useReadChain } from '../hooks/useDiamond';

export function WrongChainBanner() {
  const { address, isCorrectChain, switchToAppChain } = useWallet();
  const chain = useReadChain();

  if (!address || isCorrectChain) return null;

  return (
    <div className="banner banner-warn">
      Switch to {chain.name} to use Vaipakam on this network.{' '}
      <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => void switchToAppChain()}>
        Switch network
      </button>
    </div>
  );
}