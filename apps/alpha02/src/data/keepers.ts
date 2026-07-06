/**
 * Keeper permissions (Phase 6) — the per-user trio the contracts
 * enforce for every third-party-driven lifecycle action
 * (LibAuth.requireKeeperFor): master switch ON + the action bit on
 * that keeper's whitelist entry + the per-loan enable. All three are
 * strictly OPT-IN (defaults off); a keeper can never receive funds —
 * proceeds always route to the position-NFT holder.
 *
 * alpha02 v1 exposes the six loan-lifecycle bits only. The two
 * capital-deployment bits (SIGNED_FILL 0x40 / AUTO_ROLL 0x80) gate
 * the lender-intent surface alpha02 doesn't have, and the reference
 * app deliberately never default-grants them — excluded here
 * entirely rather than shown as mystery toggles.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';
import { idleAware } from '../lib/idle';

export interface KeeperActionDef {
  bit: number;
  label: string;
  /** Display line for whose loans the action drives. */
  side: string;
  blurb: string;
}

/** Bits mirror LibVaipakam.KEEPER_ACTION_*; strings live in
 *  copy.keepers.actions under the SAME keys, so neither side can
 *  drift by reordering. Display order: borrower actions first. */
export const KEEPER_ACTIONS: KeeperActionDef[] = [
  { bit: 0x08, ...copy.keepers.actions.initPreclose },
  { bit: 0x10, ...copy.keepers.actions.refinance },
  { bit: 0x02, ...copy.keepers.actions.completeOffset },
  { bit: 0x20, ...copy.keepers.actions.extend },
  { bit: 0x04, ...copy.keepers.actions.initEarlyWithdraw },
  { bit: 0x01, ...copy.keepers.actions.completeLoanSale },
];

/** Sum of the bits alpha02 exposes. */
export const EXPOSED_ACTIONS_MASK = KEEPER_ACTIONS.reduce(
  (m, a) => m | a.bit,
  0,
);

/** Contract cap on whitelist size (LibVaipakam.MAX_APPROVED_KEEPERS). */
export const MAX_APPROVED_KEEPERS = 5;

export interface KeeperEntry {
  keeper: `0x${string}`;
  /** Raw on-chain mask; null when the read FAILED — an entry whose
   *  mask is unknown must never be edited (writing a synthesized
   *  default would silently overwrite real permissions). */
  actions: number | null;
}

export interface KeeperConfig {
  enabled: boolean;
  keepers: KeeperEntry[];
}

export function useKeeperConfig() {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['keeperConfig', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(readClient) && Boolean(address),
    refetchInterval: idleAware(60_000),
    queryFn: async (): Promise<KeeperConfig> => {
      const diamond = readChain.diamondAddress;
      const [enabled, list] = await Promise.all([
        readClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getKeeperAccess',
          args: [address!],
        }) as Promise<boolean>,
        readClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getApprovedKeepers',
          args: [address!],
        }) as Promise<readonly `0x${string}`[]>,
      ]);
      const keepers = await Promise.all(
        list.map(async (keeper): Promise<KeeperEntry> => {
          try {
            const actions = (await readClient!.readContract({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getKeeperActions',
              args: [address!, keeper],
            })) as number | bigint;
            return { keeper, actions: Number(actions) };
          } catch {
            return { keeper, actions: null };
          }
        }),
      );
      return { enabled, keepers };
    },
  });
}

/** Per-loan keeper enables for the connected wallet's approved
 *  keepers — the third leg of the trio; without it nothing executes
 *  on a specific loan. */
export function useLoanKeeperEnables(
  loanId: number,
  keepers: readonly `0x${string}`[],
  enabled: boolean,
) {
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: [
      'loanKeeperEnabled',
      readChain.chainId,
      loanId,
      [...keepers].sort().join(','),
    ],
    enabled: enabled && Boolean(readClient) && keepers.length > 0,
    refetchInterval: idleAware(60_000),
    queryFn: async (): Promise<Record<string, boolean>> => {
      const diamond = readChain.diamondAddress;
      const entries = await Promise.all(
        keepers.map(async (keeper) => {
          const on = (await readClient!.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'isLoanKeeperEnabled',
            args: [BigInt(loanId), keeper],
          })) as boolean;
          return [keeper.toLowerCase(), on] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });
}
