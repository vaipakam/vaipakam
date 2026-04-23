/**
 * Thin viem → ethers adapter. wagmi v2 hands us a viem `WalletClient` when
 * a wallet is connected; the existing contract-interaction code in this
 * app is built on ethers `BrowserProvider` + `JsonRpcSigner`. Rather than
 * rewrite every hook at once (deferred to Phase B of the migration plan)
 * we bridge here so `useWallet()` can keep exposing the ethers shape the
 * call sites already consume.
 *
 * When Phase B lands and the hooks use wagmi's `useReadContract` +
 * `useWriteContract` directly, this adapter can be deleted.
 */
import { BrowserProvider, JsonRpcSigner } from 'ethers';
import type { WalletClient } from 'viem';

export interface EthersAdapter {
  provider: BrowserProvider;
  signer: JsonRpcSigner;
}

/**
 * Wrap a viem `WalletClient` in ethers' `BrowserProvider` + `JsonRpcSigner`.
 * viem's `client.transport` is an EIP-1193-shaped object (exposes `.request`),
 * which is exactly what ethers' `BrowserProvider` expects — so no custom
 * request shim is needed here.
 *
 * The `network` object is passed to `BrowserProvider` so ethers doesn't
 * race-resolve the chain via `eth_chainId` on first use. This matters
 * because wagmi can hand us a client for a chain the user just switched
 * to, before the ethers provider has observed the `chainChanged` event.
 */
export async function walletClientToEthers(
  walletClient: WalletClient,
): Promise<EthersAdapter> {
  const { account, chain, transport } = walletClient;
  if (!account) {
    throw new Error('walletClientToEthers: wallet client has no account');
  }
  if (!chain) {
    throw new Error('walletClientToEthers: wallet client has no chain');
  }
  const provider = new BrowserProvider(transport as never, {
    chainId: chain.id,
    name: chain.name,
  });
  const signer = await provider.getSigner(account.address);
  return { provider, signer };
}
