import { type Address, type PublicClient, type WalletClient } from 'viem';
import type { IndexedOffer } from '../types/offers.js';
import { ASSET_TYPE_ERC20, OFFER_TYPE_LENDER } from '../types/offers.js';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import { signAcceptTerms } from '../terms.js';
import { ensureErc20Allowance } from './allowance.js';
import { ensureUserVault } from './vault.js';

export async function acceptOfferFlow(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  chainId: number;
  offer: IndexedOffer;
  consent: boolean;
}) {
  const user = opts.walletClient.account?.address as Address | undefined;
  if (!user) throw new Error('Wallet not connected');

  await ensureUserVault({
    diamond: opts.diamond,
    publicClient: opts.publicClient,
    user,
  });

  const { terms, signature } = await signAcceptTerms({
    publicClient: opts.publicClient,
    walletClient: opts.walletClient,
    diamondAddress: opts.diamondAddress,
    chainId: opts.chainId,
    offerId: BigInt(opts.offer.offerId),
    consent: opts.consent,
  });

  if (opts.offer.assetType === ASSET_TYPE_ERC20) {
    const isLenderOffer = opts.offer.offerType === OFFER_TYPE_LENDER;
    const token = (isLenderOffer ? opts.offer.collateralAsset : opts.offer.lendingAsset) as Address;
    const rawAmount = isLenderOffer ? opts.offer.collateralAmount : opts.offer.amount;
    const amount = BigInt(rawAmount || '0');
    if (amount > 0n) {
      await ensureErc20Allowance({
        publicClient: opts.publicClient,
        walletClient: opts.walletClient,
        token,
        spender: opts.diamondAddress,
        amount,
      });
    }
  }

  const tx = (await opts.diamond.acceptOffer(BigInt(opts.offer.offerId), terms, signature)) as TxResponse;
  await tx.wait();
  return tx.hash;
}

/** @deprecated Use acceptOfferFlow */
export async function acceptLenderOffer(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  chainId: number;
  offerId: bigint;
  consent: boolean;
  offer?: IndexedOffer;
}) {
  if (!opts.offer) throw new Error('offer metadata required');
  return acceptOfferFlow({ ...opts, offer: opts.offer });
}