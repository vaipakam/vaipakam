import type { Address, PublicClient } from 'viem';
import type { DiamondHandle, TxResponse } from '../diamondClient.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export async function getUserVaultAddress(
  diamond: DiamondHandle,
  user: Address,
): Promise<Address | null> {
  try {
    const vault = (await diamond.getUserVaultAddress(user)) as Address;
    if (!vault || vault === ZERO_ADDRESS) return null;
    return vault;
  } catch {
    return null;
  }
}

export async function ensureUserVault(opts: {
  diamond: DiamondHandle;
  publicClient: PublicClient;
  user: Address;
}): Promise<Address> {
  const existing = await getUserVaultAddress(opts.diamond, opts.user);
  if (existing) return existing;

  const tx = (await opts.diamond.getOrCreateUserVault(opts.user)) as TxResponse;
  await tx.wait();

  const created = await getUserVaultAddress(opts.diamond, opts.user);
  if (!created) throw new Error('Vault creation succeeded but address unavailable');
  return created;
}