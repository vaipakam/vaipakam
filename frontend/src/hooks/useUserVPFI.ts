import { useCallback, useEffect, useState } from 'react';
import { Contract, type Provider } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TOKEN_DECIMALS_SCALE = 1e18;
const STALE_MS = 30_000;
const MINT_HISTORY_LIMIT = 10;
const TRANSFER_HISTORY_LIMIT = 20;

// Minimal ABI for Transfer-event queries on the VPFI ERC20 token contract —
// the Diamond ABI doesn't cover events emitted on the token itself.
const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

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
  const diamond = useDiamondRead();
  const chain = useReadChain();
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
    // subsequent call within STALE_MS serve a phantom zero — visible to
    // the user as "Wallet VPFI balance: 0" that only corrects after a
    // hard refresh once the connect handshake re-fires the effect.
    if (!address) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    // Drop any snapshot belonging to a previous cacheKey (chain/diamond/
    // wallet changed) so the UI doesn't keep showing e.g. a zero balance
    // fetched pre-wallet-connect while the fresh fetch is in flight.
    setSnapshot(null);
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useUserVPFI', step: 'readBalanceAndHistory' });
    try {
      const d = diamond as unknown as {
        getVPFIToken: () => Promise<string>;
        getVPFIBalanceOf: (a: string) => Promise<bigint>;
        getVPFITotalSupply: () => Promise<bigint>;
        getTreasury: () => Promise<string>;
        queryFilter: (
          event: string,
          fromBlock?: number | string,
          toBlock?: number | string,
        ) => Promise<
          Array<{
            args: { to: string; amount: bigint };
            blockNumber: number;
            transactionHash: string;
          }>
        >;
      };

      const [token, totalSupplyRaw, treasury] = await Promise.all([
        d.getVPFIToken(),
        d.getVPFITotalSupply(),
        d.getTreasury(),
      ]);

      const registered = token !== ZERO_ADDRESS;

      let balance = 0;
      if (address && registered) {
        const raw = await d.getVPFIBalanceOf(address);
        balance = Number(raw) / TOKEN_DECIMALS_SCALE;
      }
      const totalSupply = Number(totalSupplyRaw) / TOKEN_DECIMALS_SCALE;
      const shareOfCirculating = totalSupply === 0 ? 0 : balance / totalSupply;

      // Protocol-level mint history: Diamond-side VPFIMinted event.
      let recentMints: VPFIMintRecord[] = [];
      try {
        const events = await d.queryFilter('VPFIMinted', chain.deployBlock || 0, 'latest');
        recentMints = events
          .map((e) => ({
            to: e.args.to,
            amount: Number(e.args.amount) / TOKEN_DECIMALS_SCALE,
            blockNumber: e.blockNumber,
            txHash: e.transactionHash,
          }))
          .sort((a, b) => b.blockNumber - a.blockNumber)
          .slice(0, MINT_HISTORY_LIMIT);
      } catch {
        // RPC may rate-limit wide ranges — surface an empty history rather
        // than failing the whole snapshot.
        recentMints = [];
      }

      // Token-level activity: only meaningful when token is registered and
      // a wallet is connected. Uses a minimal ABI bound to the token address,
      // reusing the same provider the Diamond read is going through.
      let recentTransfers: VPFITransferRecord[] = [];
      if (registered && address) {
        try {
          const provider = (diamond as unknown as { runner: Provider }).runner;
          const tokenContract = new Contract(token, ERC20_TRANSFER_ABI, provider);
          const fromBlock = chain.deployBlock || 0;
          const [outgoing, incoming] = await Promise.all([
            tokenContract.queryFilter(
              tokenContract.filters.Transfer(address, null),
              fromBlock,
              'latest',
            ),
            tokenContract.queryFilter(
              tokenContract.filters.Transfer(null, address),
              fromBlock,
              'latest',
            ),
          ]);
          recentTransfers = mergeTransfers(
            [...outgoing, ...incoming] as unknown as RawTransfer[],
            address,
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
  }, [address, diamond, cacheKey, chain.deployBlock]);

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

interface RawTransfer {
  args: { from: string; to: string; value: bigint };
  blockNumber: number;
  transactionHash: string;
  index?: number;
  logIndex?: number;
}

function mergeTransfers(
  raw: RawTransfer[],
  user: string,
): VPFITransferRecord[] {
  const u = user.toLowerCase();
  const seen = new Set<string>();
  const out: VPFITransferRecord[] = [];

  for (const e of raw) {
    const logIdx = e.index ?? e.logIndex ?? 0;
    const dedupeKey = `${e.transactionHash}:${logIdx}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const from = (e.args.from ?? '').toLowerCase();
    const to = (e.args.to ?? '').toLowerCase();
    const amount = Number(e.args.value) / TOKEN_DECIMALS_SCALE;

    let direction: VPFITransferRecord['direction'];
    let counterparty: string;
    if (from === u && to === u) {
      direction = 'self';
      counterparty = e.args.from;
    } else if (from === ZERO_ADDRESS.toLowerCase() && to === u) {
      direction = 'mint';
      counterparty = e.args.from;
    } else if (from === u && to === ZERO_ADDRESS.toLowerCase()) {
      direction = 'burn';
      counterparty = e.args.to;
    } else if (from === u) {
      direction = 'out';
      counterparty = e.args.to;
    } else {
      direction = 'in';
      counterparty = e.args.from;
    }

    out.push({
      direction,
      counterparty,
      amount,
      blockNumber: e.blockNumber,
      txHash: e.transactionHash,
      logIndex: logIdx,
    });
  }

  out.sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });
  return out.slice(0, TRANSFER_HISTORY_LIMIT);
}
