/**
 * RW-05 — the wallet's VPFI, read at one block where the chain allows: in
 * the wallet, counted in the vault (the protocol-tracked figure the tier
 * reads), sitting in the vault (the token's own balance, which can be more
 * than is counted when VPFI was sent to the vault directly) and free to
 * withdraw now (the protocol's own `withdrawableNow`: what no loan, offer,
 * claim or queued payout holds). What is counted but not free is held.
 * Each figure is null when its read had no answer, said as unread.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { VPFI_DISCOUNT_ABI } from '../consent/feeDiscount';
import { ASSET_TYPE } from '../nft/nft';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

export interface VpfiBalances {
  /** The wallet's vault; null when it has none yet. */
  vault: Hex | null;
  wallet: bigint | null;
  counted: bigint | null;
  sitting: bigint | null;
  free: bigint | null;
  blockNumber: bigint;
}

export async function readVpfiBalances(c: PublicClient, diamond: Hex, account: Hex, token: Hex): Promise<VpfiBalances> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber };
  const [vaultRaw, wallet, counted, free] = await Promise.all([
    c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at }) as Promise<Hex>,
    answerOrNull(c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at })),
    answerOrNull(c.readContract({ address: diamond, abi: VPFI_DISCOUNT_ABI, functionName: 'getTrackedVPFIBalance', args: [account], ...at }) as Promise<bigint>),
    answerOrNull(c.readContract({ address: diamond, abi: DEPOSITORY, functionName: 'withdrawableNow', args: [account, ASSET_TYPE.erc20, token, 0n], ...at }) as Promise<bigint>),
  ]);
  const vault = vaultRaw.toLowerCase() === ZERO ? null : vaultRaw;
  const sitting = vault === null ? 0n : await answerOrNull(c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [vault], ...at }));
  return { vault, wallet, counted, sitting, free, blockNumber };
}

/** The figures the panel states beside the reads: what is held (counted
 *  but not free) and what sits in the vault uncounted; each null when an
 *  input was unread. */
export function vpfiFigures(b: Pick<VpfiBalances, 'counted' | 'sitting' | 'free'>): { held: bigint | null; uncounted: bigint | null } {
  const held = b.counted === null || b.free === null ? null : b.counted > b.free ? b.counted - b.free : 0n;
  const uncounted = b.counted === null || b.sitting === null ? null : b.sitting > b.counted ? b.sitting - b.counted : 0n;
  return { held, uncounted };
}

/** Why the withdrawal cannot open, or null when something is free: nothing
 *  counted at all, or everything counted is held. Unread when the free
 *  figure was not read. */
export function withdrawClosed(b: Pick<VpfiBalances, 'vault' | 'counted' | 'free'>): 'no-vault' | 'none' | 'all-held' | 'unread' | null {
  if (b.vault === null) return 'no-vault';
  if (b.free === null) return 'unread';
  if (b.free > 0n) return null;
  return b.counted === 0n ? 'none' : 'all-held';
}
