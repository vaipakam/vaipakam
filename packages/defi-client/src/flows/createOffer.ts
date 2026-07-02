import type { Address, PublicClient, WalletClient } from 'viem';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';
import type { CreateOfferForm } from '../types/offers.js';
import { toCreateOfferPayload, toBorrowerOfferPayload } from '../offers/schema.js';
import { ensureUserVault } from './vault.js';
import { ensureErc20Allowance } from './allowance.js';

async function prepCreate(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  lockToken: Address;
  lockAmount: bigint;
}) {
  const user = opts.walletClient.account?.address as Address;
  await ensureUserVault({ diamond: opts.diamond, publicClient: opts.publicClient, user });
  if (opts.lockAmount > 0n) {
    await ensureErc20Allowance({
      publicClient: opts.publicClient,
      walletClient: opts.walletClient,
      token: opts.lockToken,
      spender: opts.diamondAddress,
      amount: opts.lockAmount,
    });
  }
}

export async function createLenderOffer(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  form: CreateOfferForm;
}) {
  const payload = toCreateOfferPayload(opts.form);
  const lockAmount = payload.amountMax > 0n ? payload.amountMax : payload.amount;
  await prepCreate({
    ...opts,
    lockToken: opts.form.lendingAsset as Address,
    lockAmount: lockAmount,
  });
  const tx = (await opts.diamond.createOffer(payload)) as TxResponse;
  await tx.wait();
  return tx.hash;
}

export async function createBorrowerOffer(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  form: CreateOfferForm;
}) {
  const payload = toBorrowerOfferPayload(opts.form);
  await prepCreate({
    ...opts,
    lockToken: opts.form.collateralAsset as Address,
    lockAmount: payload.collateralAmount,
  });
  const tx = (await opts.diamond.createOffer(payload)) as TxResponse;
  await tx.wait();
  return tx.hash;
}