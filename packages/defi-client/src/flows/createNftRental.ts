import type { Address, PublicClient, WalletClient } from 'viem';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import {
  toNftRentalBorrowerDemandPayload,
  toNftRentalLenderPayload,
  type NftRentalDemandForm,
  type NftRentalListForm,
} from '../offers/nftRentalSchema.js';
import { computeRentalPrepayWei } from '../offers/rental.js';
import type { OfferPayloadDecimals } from '../offers/schema.js';
import { ensureErc20Allowance } from './allowance.js';
import { ensureNftRentalApproval } from './nftApproval.js';
import { ensureUserVault } from './vault.js';

async function prepVault(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  user: Address;
}) {
  await ensureUserVault({
    diamond: opts.diamond,
    publicClient: opts.publicClient,
    user: opts.user,
  });
}

/** N1 — vault NFT + list for rent. */
export async function createNftRentalListing(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  form: NftRentalListForm;
  decimals?: OfferPayloadDecimals;
}) {
  const user = opts.walletClient.account?.address as Address;
  const payload = toNftRentalLenderPayload(opts.form, opts.decimals);
  await prepVault({ ...opts, user });
  await ensureNftRentalApproval({
    publicClient: opts.publicClient,
    walletClient: opts.walletClient,
    nftContract: opts.form.nftContract as Address,
    diamondAddress: opts.diamondAddress,
    assetType: payload.assetType,
    tokenId: payload.tokenId,
  });
  const tx = (await opts.diamond.createOffer(payload)) as TxResponse;
  await tx.wait();
  return tx.hash;
}

/** PF-044 — renter posts demand; prepay + buffer lock at create. */
export async function createNftRentalDemand(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  form: NftRentalDemandForm;
  decimals?: OfferPayloadDecimals;
  rentalBufferBps?: number;
}) {
  const user = opts.walletClient.account?.address as Address;
  const payload = toNftRentalBorrowerDemandPayload(opts.form, opts.decimals);
  const totalPrepay = computeRentalPrepayWei(
    payload.amount,
    Number(payload.durationDays),
    opts.rentalBufferBps,
  );
  await prepVault({ ...opts, user });
  if (totalPrepay > 0n) {
    await ensureErc20Allowance({
      publicClient: opts.publicClient,
      walletClient: opts.walletClient,
      token: opts.form.prepayAsset as Address,
      spender: opts.diamondAddress,
      amount: totalPrepay,
    });
  }
  const tx = (await opts.diamond.createOffer(payload)) as TxResponse;
  await tx.wait();
  return tx.hash;
}