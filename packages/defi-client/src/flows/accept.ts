import { type Address, type PublicClient, type WalletClient } from 'viem';
import type { IndexedOffer } from '../types/offers.js';
import { ASSET_TYPE_ERC20, OFFER_TYPE_LENDER } from '../types/offers.js';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import { isNftRentalOffer, rentalPrepayForOffer } from '../offers/rental.js';
import { signAcceptTerms } from '../terms.js';
import { ensureErc20Allowance } from './allowance.js';
import { ensureNftRentalApproval } from './nftApproval.js';
import { ensureUserVault } from './vault.js';

export async function acceptOfferFlow(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  chainId: number;
  offer: IndexedOffer;
  consent: boolean;
  rentalBufferBps?: number;
}) {
  const user = opts.walletClient.account?.address as Address | undefined;
  if (!user) throw new Error('Wallet not connected');
  if (opts.offer.chainId !== opts.chainId) {
    throw new Error(
      `Offer #${opts.offer.offerId} is on chain ${opts.offer.chainId}, but the wallet is on chain ${opts.chainId}. Switch networks and re-select the offer.`,
    );
  }

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

  const isLenderOffer = opts.offer.offerType === OFFER_TYPE_LENDER;
  const isRental = isNftRentalOffer(opts.offer);

  if (isLenderOffer) {
    if (isRental) {
      const prepay = rentalPrepayForOffer(opts.offer, opts.rentalBufferBps);
      if (prepay > 0n && opts.offer.prepayAsset) {
        await ensureErc20Allowance({
          publicClient: opts.publicClient,
          walletClient: opts.walletClient,
          token: opts.offer.prepayAsset as Address,
          spender: opts.diamondAddress,
          amount: prepay,
        });
      }
    } else if (opts.offer.collateralAssetType === ASSET_TYPE_ERC20) {
      const amount = BigInt(opts.offer.collateralAmount || '0');
      if (amount > 0n) {
        await ensureErc20Allowance({
          publicClient: opts.publicClient,
          walletClient: opts.walletClient,
          token: opts.offer.collateralAsset as Address,
          spender: opts.diamondAddress,
          amount,
        });
      }
    }
  } else if (isRental) {
    await ensureNftRentalApproval({
      publicClient: opts.publicClient,
      walletClient: opts.walletClient,
      nftContract: opts.offer.lendingAsset as Address,
      diamondAddress: opts.diamondAddress,
      assetType: opts.offer.assetType,
      tokenId: BigInt(opts.offer.tokenId || '0'),
    });
  } else if (opts.offer.assetType === ASSET_TYPE_ERC20) {
    const rawAmount = opts.offer.amount;
    const amount = BigInt(rawAmount || '0');
    if (amount > 0n) {
      await ensureErc20Allowance({
        publicClient: opts.publicClient,
        walletClient: opts.walletClient,
        token: opts.offer.lendingAsset as Address,
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