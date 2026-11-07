/**
 * #3237 — the governance queue on the chain the screen describes.
 *
 * A public chain read (RB-PUBLIC): no wallet, nobody's own state. The queue
 * comes from the governance timelock's storage, and each operation's calls
 * are proved against its stored id (`@vaipakam/lib/governanceQueue`), so a
 * call is shown only when the chain itself vouches for it. Every value is
 * read at one block, and the page states that block.
 *
 * The contracts a call may target are the deployment's own addresses. The
 * ones with a committed ABI are decoded; the rest are named by their
 * deployment key and shown undecoded, never guessed.
 */
import type { Abi, Address, Hex } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  CcipMessengerABI,
  DIAMOND_ABI_VIEM,
  SanctionsDelistingTimelockABI,
  SanctionsListABI,
  TestnetSanctionsOverlayABI,
  VaipakamFeedRegistryABI,
  VaipakamRewardMessengerABI,
  VaipakamTimelockABI,
  VpfiReturnReceiverABI,
} from '@vaipakam/contracts/abis';
import { readGovernanceQueue, type GovernanceTarget } from '@vaipakam/lib/governanceQueue';
import { RPC_PROXY_MAX_LOG_RANGE_BLOCKS } from '@vaipakam/lib/rpcProxyPolicy';
import { useChainRead } from '../reads/chainRead';

/** Deployment keys whose contract has a committed ABI to decode calls with. */
const ABI_BY_KEY: Readonly<Record<string, Abi>> = {
  diamond: DIAMOND_ABI_VIEM,
  timelock: VaipakamTimelockABI as Abi,
  sanctionsList: SanctionsListABI as Abi,
  sanctionsDelistingTimelock: SanctionsDelistingTimelockABI as Abi,
  sanctionsTestnetOverlay: TestnetSanctionsOverlayABI as Abi,
  ccipMessenger: CcipMessengerABI as Abi,
  rewardMessenger: VaipakamRewardMessengerABI as Abi,
  vpfiReturnReceiver: VpfiReturnReceiverABI as Abi,
  feedRegistry: VaipakamFeedRegistryABI as Abi,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Every top-level address the chain's deployment records, as a target. */
export function governanceTargets(chainId: number): GovernanceTarget[] {
  const d = getDeployment(chainId) as unknown as Record<string, unknown> | undefined;
  if (!d) return [];
  return Object.entries(d).flatMap(([key, v]) =>
    typeof v === 'string' && ADDRESS.test(v) ? [{ key, address: v as Address, abi: ABI_BY_KEY[key] ?? null }] : [],
  );
}

/** The governance timelock the deployment records for a chain, if any. */
export function governanceTimelock(chainId: number): Address | null {
  const t = (getDeployment(chainId) as { timelock?: string } | undefined)?.timelock;
  return t && ADDRESS.test(t) ? (t as Address) : null;
}

/** Blocks already proved to hold an operation's schedule, per timelock, so
 *  a refresh re-reads one window instead of searching again. A hint is only
 *  where to look: the reader proves what it finds against the id. */
const proved = new Map<string, Map<Hex, bigint>>();

export function useGovernanceQueue(chainId: number, deployBlock: number) {
  const timelock = governanceTimelock(chainId);
  return useChainRead(
    ['governance-queue', timelock],
    async (client) => {
      const key = `${chainId}:${timelock}`;
      const hints = proved.get(key) ?? new Map<Hex, bigint>();
      const queue = await readGovernanceQueue(client, timelock!, {
        maxLogRange: RPC_PROXY_MAX_LOG_RANGE_BLOCKS,
        fromBlock: BigInt(deployBlock),
        hints,
      });
      for (const op of queue.operations) if (op.details.kind === 'proved') hints.set(op.id, op.details.scheduledBlock);
      proved.set(key, hints);
      return queue;
    },
    { enabled: timelock !== null },
  );
}
