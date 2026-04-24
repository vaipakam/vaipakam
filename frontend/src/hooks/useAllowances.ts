import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useUserLoans } from './useUserLoans';
import { getCanonicalAssetsForChain } from '../lib/canonicalAssets';
import type { Address } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Minimal ERC20 ABI — just the three fields we need for the allowance
// listing + the revoke call. Keeps the frontend bundle small.
const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export interface AllowanceRow {
  token: string;       // lowercase 0x-hex
  symbol: string;      // e.g. "USDC"; falls back to shortened addr on failure
  decimals: number;
  allowance: bigint;   // raw token-units
  source: 'canonical' | 'loan' | 'vpfi';
}

interface UseAllowancesResult {
  rows: AllowanceRow[];
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Phase 8a.4 — enumerate the ERC-20 allowances the current user has
 * granted to the Vaipakam Diamond across three asset buckets:
 *
 *   1. `canonical` — the well-known per-chain token list (WETH, USDC,
 *      USDT, DAI, WBTC …). Catches stale approvals the user might have
 *      granted outside the app + forgotten.
 *   2. `loan`      — principal + collateral assets of every loan the
 *      user has ever participated in (via `useUserLoans`). Covers the
 *      assets the user has actually interacted with through Vaipakam.
 *   3. `vpfi`      — the VPFI token on chains where it's deployed.
 *
 * The three sets are deduplicated by lowercase address; `source` on
 * each row reflects the first bucket that contributed the token so the
 * UI can highlight why it's shown. Revoke = `approve(diamond, 0)`.
 */
export function useAllowances(): UseAllowancesResult {
  const { address, chainId } = useWallet();
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const { loans } = useUserLoans(address);

  const [rows, setRows] = useState<AllowanceRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address || !chainId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      // Union the three token sources into a single dedup-by-address set,
      // preserving the first-seen `source` label.
      const bySourceAddr = new Map<string, 'canonical' | 'loan' | 'vpfi'>();
      for (const t of getCanonicalAssetsForChain(chainId)) {
        bySourceAddr.set(t.toLowerCase(), 'canonical');
      }
      for (const loan of loans) {
        for (const t of [loan.principalAsset, loan.collateralAsset]) {
          const k = t.toLowerCase();
          if (k === ZERO_ADDRESS) continue;
          if (!bySourceAddr.has(k)) bySourceAddr.set(k, 'loan');
        }
      }
      // VPFI token address isn't on the frontend ChainConfig (it's read
      // from on-chain state via VPFITokenFacet); surfaces automatically
      // through the `loan`-sourced bucket whenever the user has taken
      // the VPFI LIF path. Reading it explicitly via getVPFIToken() is
      // a follow-up if we want it listed even when the user has no
      // VPFI-path loans.

      const tokens = Array.from(bySourceAddr.entries());
      // Multicall all three reads per token (allowance + symbol + decimals).
      // Viem doesn't have a built-in multicall batcher across heterogeneous
      // targets without opts; we just run them concurrently and hope the
      // public RPC handles the burst. For a ≤20-token canonical + loan set
      // this is typically 60 requests — fine for Alchemy/Infura.
      const results = await Promise.all(
        tokens.map(async ([addr, source]) => {
          try {
            const [allowance, symbol, decimals] = await Promise.all([
              publicClient.readContract({
                address: addr as Address,
                abi: ERC20_MIN_ABI,
                functionName: 'allowance',
                args: [address as Address, diamondAddress],
              }),
              publicClient
                .readContract({
                  address: addr as Address,
                  abi: ERC20_MIN_ABI,
                  functionName: 'symbol',
                })
                .catch(() => shortAddr(addr)),
              publicClient
                .readContract({
                  address: addr as Address,
                  abi: ERC20_MIN_ABI,
                  functionName: 'decimals',
                })
                .catch(() => 18),
            ]);
            return {
              token: addr,
              symbol: String(symbol),
              decimals: Number(decimals),
              allowance: allowance as bigint,
              source,
            } as AllowanceRow;
          } catch {
            return null;
          }
        }),
      );
      const good = results.filter((r): r is AllowanceRow => r !== null);
      // Sort: non-zero allowances first (these are the ones the user
      // cares about), then zero-allowance rows.
      good.sort((a, b) => {
        if (a.allowance > 0n && b.allowance === 0n) return -1;
        if (a.allowance === 0n && b.allowance > 0n) return 1;
        return a.symbol.localeCompare(b.symbol);
      });
      setRows(good);
    } finally {
      setLoading(false);
    }
  }, [address, chainId, publicClient, diamondAddress, loans]);

  useEffect(() => {
    load();
  }, [load]);

  return { rows, loading, reload: load };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
