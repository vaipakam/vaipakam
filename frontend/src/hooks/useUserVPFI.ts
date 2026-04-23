import { useCallback, useEffect, useState } from 'react';
import { parseAbiItem, type Address, type PublicClient } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TOKEN_DECIMALS_SCALE = 1e18;
const STALE_MS = 30_000;
const MINT_HISTORY_LIMIT = 10;
const TRANSFER_HISTORY_LIMIT = 20;

// Viem-parsed Transfer event for token-level log queries. The Diamond ABI
// doesn't cover token-emitted events, so we parse the standard ERC-20
// Transfer signature directly.
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

// Protocol-level VPFIMinted event. Searched by topic on the diamond address
// via `getContractEvents`. Kept here as a typed abiItem so viem narrows the
// log args appropriately.
const VPFI_MINTED_EVENT = parseAbiItem(
  'event VPFIMinted(address indexed to, uint256 amount)',
);

export interface VPFIMintRecord {
  to: string;
  amount: number;
  blockNumber: number;
  txHash: string;
}

/**
 * One ERC-20 Transfer log involving the connected wallet.
 *
 * - `in`   : wallet received from another account
 * - `out`  : wallet sent to another account
 * - `mint` : wallet received from `0x0` (token-side mint into the user)
 * - `burn` : wallet sent to `0x0` (user-initiated burn)
 * - `self` : from == to == wallet (benign round-trip — shown once)
 */
export interface VPFITransferRecord {
  direction: 'in' | 'out' | 'mint' | 'burn' | 'self';
  counterparty: string;
  amount: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

export interface UserVPFISnapshot {
  /** VPFI token proxy address on the current read-chain (`0x0` when unregistered). */
  token: string;
  /** True when the Diamond on this chain has been bound to a VPFI token. */
  registered: boolean;
  /** Connected wallet's VPFI balance; 0 when token unregistered or wallet empty. */
  balance: number;
  /** Fraction of circulating supply held by the wallet, 0..1. */
  shareOfCirculating: number;
  /** Treasury address stored on the Diamond (sole Phase-1 mint destination). */
  treasury: string;
  /** Most recent protocol-level VPFIMinted emissions, newest first. */
  recentMints: VPFIMintRecord[];
  /** Most recent token-level Transfer logs touching the wallet, newest first. */
  recentTransfers: VPFITransferRecord[];
  fetchedAt: number;
}

interface CacheEntry {
  data: UserVPFISnapshot;
  at: number;
  key: string;
}

let cached: CacheEntry | null = null;

/**
 * Wallet-scoped VPFI view: on-chain balance plus the two event streams that
 * matter to a user — protocol-level mints (Diamond → treasury) and
 * token-level transfers (received / sent / minted-to / burned-from the
 * wallet). Both streams are sorted newest-first.
 *
 * Cached module-scope under a key that includes chainId + diamondAddress, so
 * switching networks (or wallet accounts) invalidates cleanly.
 */
export function useUserVPFI(address: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const cacheKey = buildCacheKey(chain.chainId, chain.diamondAddress, address);

  const [snapshot, setSnapshot] = useState<UserVPFISnapshot | null>(() => {
    if (!cached) return null;
    return cached.key === cacheKey ? cached.data : null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setSnapshot(cached.data);
      setLoading(false);
      return;
    }
    // Skip the fetch entirely when the wallet hasn't connected yet.
    // A pre-connect fetch can only produce `balance: 0` (no address to
    // query), and caching that under the current cacheKey makes every
    // subsequent call within STALE_MS serve a phantom zero.
    if (!address) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    // Drop any snapshot belonging to a previous cacheKey so the UI doesn't
    // keep showing stale data while the fresh fetch is in flight.
    setSnapshot(null);
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useUserVPFI', step: 'readBalanceAndHistory' });
    try {
      const readDiamond = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T> => {
        return (await publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName,
          args,
        })) as T;
      };

      const [token, totalSupplyRaw, treasury] = await Promise.all([
        readDiamond<string>('getVPFIToken'),
        readDiamond<bigint>('getVPFITotalSupply'),
        readDiamond<string>('getTreasury'),
      ]);

      const registered = token !== ZERO_ADDRESS;

      let balance = 0;
      if (address && registered) {
        const raw = await readDiamond<bigint>('getVPFIBalanceOf', [address as Address]);
        balance = Number(raw) / TOKEN_DECIMALS_SCALE;
      }
      const totalSupply = Number(totalSupplyRaw) / TOKEN_DECIMALS_SCALE;
      const shareOfCirculating = totalSupply === 0 ? 0 : balance / totalSupply;

      // Protocol-level mint history: Diamond-emitted VPFIMinted events.
      let recentMints: VPFIMintRecord[] = [];
      try {
        const logs = await publicClient.getContractEvents({
          address: diamondAddress,
          abi: [VPFI_MINTED_EVENT],
          eventName: 'VPFIMinted',
          fromBlock: chain.deployBlock > 0 ? BigInt(chain.deployBlock) : 0n,
          toBlock: 'latest',
        });
        recentMints = logs
          .map((log) => ({
            to: String(log.args.to ?? ''),
            amount: Number(log.args.amount ?? 0n) / TOKEN_DECIMALS_SCALE,
            blockNumber: Number(log.blockNumber ?? 0n),
            txHash: String(log.transactionHash ?? ''),
          }))
          .sort((a, b) => b.blockNumber - a.blockNumber)
          .slice(0, MINT_HISTORY_LIMIT);
      } catch {
        // RPC may rate-limit wide ranges — surface an empty history rather
        // than failing the whole snapshot.
        recentMints = [];
      }

      // Token-level activity: only meaningful when token is registered and a
      // wallet is connected. Fetches both sides of Transfer with indexed-arg
      // filters and merges client-side.
      let recentTransfers: VPFITransferRecord[] = [];
      if (registered && address) {
        try {
          recentTransfers = await fetchTransferHistory(
            publicClient,
            token as Address,
            address as Address,
            chain.deployBlock > 0 ? BigInt(chain.deployBlock) : 0n,
          );
        } catch {
          recentTransfers = [];
        }
      }

      const next: UserVPFISnapshot = {
        token,
        registered,
        balance,
        shareOfCirculating,
        treasury,
        recentMints,
        recentTransfers,
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now(), key: cacheKey };
      setSnapshot(next);
      step.success({
        note: `balance ${balance.toFixed(2)}, ${recentMints.length} mints, ${recentTransfers.length} transfers`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress, cacheKey, chain.deployBlock]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  return { snapshot, loading, error, reload };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearUserVPFICache() {
  cached = null;
}

// ── internals ──────────────────────────────────────────────────────────────

function buildCacheKey(
  chainId: number,
  diamondAddress: string | null,
  user: string | null,
): string {
  const d = diamondAddress?.toLowerCase() ?? 'none';
  const u = user?.toLowerCase() ?? 'none';
  return `${chainId}:${d}:${u}`;
}

async function fetchTransferHistory(
  publicClient: PublicClient,
  tokenAddress: Address,
  user: Address,
  fromBlock: bigint,
): Promise<VPFITransferRecord[]> {
  const [outgoing, incoming] = await Promise.all([
    publicClient.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT,
      args: { from: user },
      fromBlock,
      toBlock: 'latest',
    }),
    publicClient.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT,
      args: { to: user },
      fromBlock,
      toBlock: 'latest',
    }),
  ]);

  const u = user.toLowerCase();
  const seen = new Set<string>();
  const out: VPFITransferRecord[] = [];

  for (const log of [...outgoing, ...incoming]) {
    const logIdx = Number(log.logIndex ?? 0n);
    const dedupeKey = `${log.transactionHash}:${logIdx}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const from = String(log.args.from ?? '').toLowerCase();
    const to = String(log.args.to ?? '').toLowerCase();
    const amount = Number(log.args.value ?? 0n) / TOKEN_DECIMALS_SCALE;

    let direction: VPFITransferRecord['direction'];
    let counterparty: string;
    if (from === u && to === u) {
      direction = 'self';
      counterparty = String(log.args.from ?? '');
    } else if (from === ZERO_ADDRESS.toLowerCase() && to === u) {
      direction = 'mint';
      counterparty = String(log.args.from ?? '');
    } else if (from === u && to === ZERO_ADDRESS.toLowerCase()) {
      direction = 'burn';
      counterparty = String(log.args.to ?? '');
    } else if (from === u) {
      direction = 'out';
      counterparty = String(log.args.to ?? '');
    } else {
      direction = 'in';
      counterparty = String(log.args.from ?? '');
    }

    out.push({
      direction,
      counterparty,
      amount,
      blockNumber: Number(log.blockNumber ?? 0n),
      txHash: String(log.transactionHash ?? ''),
      logIndex: logIdx,
    });
  }

  out.sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });
  return out.slice(0, TRANSFER_HISTORY_LIMIT);
}
