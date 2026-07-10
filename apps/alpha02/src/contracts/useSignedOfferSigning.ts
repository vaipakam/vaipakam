/**
 * SignedOffer EIP-712 signer (#1131 slice D) — the maker half of the
 * gasless order book. Mirrors `usePermit2Signing`'s idiom: a `sign`
 * function the ticket calls with the fully-built wire order; it asks
 * the wallet for ONE typed-data signature over the canonical domain
 * `{name: 'Vaipakam SignedOffer', version: '1', chainId,
 * verifyingContract: <diamond>}` (LibSignedOffer.sol / the indexer's
 * ingest gate both pin this exact shape) and returns the signature
 * ready for `POST /signed-offers`.
 *
 * Like the Permit2 hook, signing errors are NOT caught here — a wallet
 * that refuses EIP-712 throws out of `sign` and the ticket surfaces it
 * (there is no fallback: gasless posting IS the signature).
 */
import { useCallback } from 'react';
import type { Hex } from 'viem';
import { useWalletClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import {
  SIGNED_OFFER_TYPES,
  signedOfferTypedMessage,
  type SignedOrderWire,
} from '../lib/signedOffer';

export function useSignedOfferSigning() {
  const { address, walletChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();

  const sign = useCallback(
    async (order: SignedOrderWire): Promise<Hex> => {
      if (!address || !walletChain) throw new Error('Wallet not connected');
      if (!walletClient) throw new Error('Wallet client not available');
      return walletClient.signTypedData({
        account: address,
        domain: {
          name: 'Vaipakam SignedOffer',
          version: '1',
          chainId: walletChain.chainId,
          verifyingContract: walletChain.diamondAddress,
        },
        types: SIGNED_OFFER_TYPES,
        primaryType: 'SignedOffer',
        message: signedOfferTypedMessage(order),
      });
    },
    [address, walletChain, walletClient],
  );

  const canSign = Boolean(walletClient) && Boolean(address) && Boolean(walletChain);

  return { sign, canSign };
}
