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
      // A reverse name is effectively static within a session: resolve
      // each address at most once (staleTime) and keep the result
      // cached across unmounts (gcTime) — list pages mount one of
      // these per counterparty row, and per-remount re-resolution is
      // what burst-429'd the public mainnet endpoint (RPC diet).
      staleTime: Infinity,
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
      // `retry: false` only bounds ONE fetch — TanStack's
      // retryOnMount default would re-fire a FAILED (data-less)
      // lookup on every row remount, recreating exactly the burst
      // this caps (Codex #1084 r1). One attempt per address per
      // session, success or failure.
      retryOnMount: false,
    },
  });
  return <>{ens.data ?? shortAddress(address)}</>;
}
