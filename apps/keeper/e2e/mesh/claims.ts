/**
 * Interaction-reward claims on a mesh chain, made the way a user makes them:
 * the claim simulated first, then sent, with any staging domain a deferring
 * claim opens stepped home by its permissionless step from another account.
 * Shared by the two-chain scenarios that pay a delivered day out.
 */
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem';
import { expect } from 'vitest';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { TOKEN_ABI, type Party } from '@vaipakam/anvil-harness/scenarioChain';
import type { MeshChain } from './mesh';

/** `LibVaipakam.RewardDelivery.Vault`: pay the claim into the caller's vault.
 *  The payout rule (#3805) refuses a party's reward sent to a wallet; only
 *  the owner's own withdrawal reaches one. */
const TO_VAULT = 2;

export function balanceOf(sc: MeshChain, token: Address, who: Address): Promise<bigint> {
  return sc.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
}

/** `who`'s VPFI in its vault on `sc`; 0 while it has no vault yet (a claim
 *  into the vault creates one). */
async function vaultBalance(sc: MeshChain, token: Address, who: Party): Promise<bigint> {
  const vault = (await sc.pub.readContract({
    address: sc.diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserVaultAddress',
    args: [sc.address(who)],
  } as never)) as Address;
  return /^0x0{40}$/i.test(vault) ? 0n : balanceOf(sc, token, vault);
}

/**
 * What `who`'s claim on `sc` would pay into its vault, by running the claim
 * itself in a frame that always reverts, or null when the claim would revert
 * for a reason of its own (nothing to claim, among them).
 */
export async function simulatedClaim(sc: MeshChain, who: Party): Promise<bigint | null> {
  try {
    await sc.pub.simulateContract({
      account: sc.address(who),
      address: sc.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'simulateClaimInteractionRewards',
      args: [sc.address(who), TO_VAULT],
    } as never);
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'InteractionRewardsSimulation') {
      return BigInt((reverted.data.args as readonly bigint[])[0]);
    }
    return null;
  }
  throw new Error('simulateClaimInteractionRewards returned instead of reverting');
}

/**
 * Claim `who`'s rewards on `sc` (a mirror) into its vault until a claim pays.
 * A claim that defers opens the staging domain of its entry's slice, and that
 * domain is stepped home by its permissionless step, by another account.
 * Returns what the paying claim moved into the vault.
 */
export async function claimUntilPaid(sc: MeshChain, who: Party): Promise<bigint> {
  const vpfi = sc.fixture.artifact.vpfiMirror as Address;
  for (let round = 0; round < 4; round++) {
    const simulated = await simulatedClaim(sc, who); // eslint-disable-line no-await-in-loop
    const before = await vaultBalance(sc, vpfi, who); // eslint-disable-line no-await-in-loop
    const from = await sc.blockNumber(); // eslint-disable-line no-await-in-loop
    await sc.diamondWrite(who, 'claimInteractionRewardsTo', [TO_VAULT]); // eslint-disable-line no-await-in-loop
    const paid = (await vaultBalance(sc, vpfi, who)) - before; // eslint-disable-line no-await-in-loop
    if (paid > 0n) {
      expect(paid).toBe(simulated);
      return paid;
    }
    const opened = (await sc.diamondEvents('LegacySliceDomainOpened', from + 1n)).map((e) => BigInt(e.args.entryId as bigint)); // eslint-disable-line no-await-in-loop
    expect(opened.length, `${who}'s claim paid nothing and opened no staging domain`).toBeGreaterThan(0);
    for (const entryId of opened) {
      let consumed = false;
      for (let step = 0; step < 32 && !consumed; step++) {
        // eslint-disable-next-line no-await-in-loop
        const { result } = await sc.pub.simulateContract({
          account: sc.address('other'),
          address: sc.diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'stepLegacySlice',
          args: [entryId],
        } as never);
        await sc.diamondWrite('other', 'stepLegacySlice', [entryId]); // eslint-disable-line no-await-in-loop
        consumed = result as boolean;
      }
      expect(consumed, `entry ${entryId}'s staging domain was not consumed`).toBe(true);
    }
  }
  throw new Error(`${who}'s claim on the mirror never paid`);
}
