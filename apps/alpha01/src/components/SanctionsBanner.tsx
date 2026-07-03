import { useSanctionsCheck } from '../hooks/useSanctionsCheck';
import { useWallet } from '../context/WalletContext';

export function SanctionsBanner() {
  const { address } = useWallet();
  const { isSanctioned, loading } = useSanctionsCheck(address);

  if (!address || loading || !isSanctioned) return null;

  return (
    <div className="banner banner-error" role="alert">
      This wallet is flagged by the sanctions oracle. New positions are blocked; you can still
      close out existing obligations.
    </div>
  );
}