import type { Address, PublicClient, WalletClient } from 'viem';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import { signAcceptTerms } from '../terms.js';

export async function acceptLenderOffer(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  chainId: number;
  offerId: bigint;
  consent: boolean;
}) {
  const { terms, signature } = await signAcceptTerms({
    publicClient: opts.publicClient,
    walletClient: opts.walletClient,
    diamondAddress: opts.diamondAddress,
    chainId: opts.chainId,
    offerId: opts.offerId,
    consent: opts.consent,
  });

  const tx = (await opts.diamond.acceptOffer(opts.offerId, terms, signature)) as TxResponse;
  await tx.wait();
  return tx.hash;
}