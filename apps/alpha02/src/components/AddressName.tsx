/**
 * ENS display sugar (#1030): a WALLET address with a mainnet ENS
 * reverse name renders as that name; otherwise (no name, lookup
 * pending, lookup failed, ENS unreachable) the shortened hex renders
 * — the name is never part of any verdict or check, per the spec.
 * The read-only mainnet client this resolves against is registered
 * in chain/wagmi.ts for exactly this purpose.
 *
 * Use ONLY for wallet addresses (the connected account, offer
 * creators). Asset/contract addresses stay hex — a token contract
 * with a vanity ENS name would be misleading, not sugar.
 */
import { useEnsName } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { shortAddress } from '../lib/format';

export function AddressName({ address }: { address: string }) {
  const ens = useEnsName({
    address: address as `0x${string}`,
    chainId: mainnet.id,
    query: {
      // Reverse names change rarely; don't re-resolve per render.
      staleTime: 60 * 60 * 1000,
      retry: false,
    },
  });
  return <>{ens.data ?? shortAddress(address)}</>;
}
