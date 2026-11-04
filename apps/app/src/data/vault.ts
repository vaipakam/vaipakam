/**
 * "Your Vaipakam Vault" reads. Per asset the displayed numbers are:
 *   total  = min(raw ERC-20 balanceOf(vault), protocol-tracked)
 *            — unsolicited transfers never inflate anything (T-051)
 *   free   = min(freeHolding(user, ERC-20, asset, 0), total) — the
 *            contract's own figure: tracked minus liens minus what
 *            protected account mode holds back for queued payouts
 *   locked = total - free
 *
 * The asset list: canonical per-chain tokens, every ERC-20 leg of the
 * wallet's loans and open offers, VPFI, and every asset the contract lists
 * as credited to the wallet's depository holding (a standalone deposit).
 */
import { useQuery } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
} from 'viem';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';
import { useActiveChain } from '../chain/useActiveChain';
import { AssetType } from '../lib/types';
import { rowSetCaveats, rowSetState, useMyLoansFull, useMyOffersFull } from './hooks';
import { signalAware } from '../chain/railHealth';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface VaultAssetRow {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  total: bigint;
  locked: bigint;
  free: bigint;
}

export interface VaultSnapshot {
  vaultAddress: `0x${string}` | null; // null = not created yet
  assets: VaultAssetRow[];
  /** Tokens whose reads FAILED this scan (transient RPC/metadata
   *  errors). Non-empty means the list may be missing real balances —
   *  the page must say so instead of looking complete. */
  unreadable: `0x${string}`[];
  /** Candidate tokens beyond the scanned window (#1247 PAG-001 rider)
   *  — the page offers "check more" to widen the scan. */
  moreTokens: number;
  /** NFT collections on the wallet's depository list. The token rows above
   *  are ERC-20 balances only, so these are named separately and the page
   *  never calls a vault holding deposited NFTs empty. */
  nftCollections: `0x${string}`[];
}

export function useVaultAssets(scanWindow: number) {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const loans = useMyLoansFull();
  const offers = useMyOffersFull();
  // The candidate list depends on loans+offers — a failed dependency
  // must surface as UNAVAILABLE, not as a canonical-only scan that
  // renders an incomplete "where my assets sit" page.
  const depsUnavailable = loans.data === null || offers.data === null;
  const depsLoading =
    !depsUnavailable &&
    (loans.data === undefined || offers.data === undefined) &&
    Boolean(address);
  // #2536 — both lists answered, but not as the wallet's whole set
  // (lagging fallback, and/or a leg neither source could read): an asset
  // behind a missing position may be absent from the scan. The page
  // states every gap that applies, instead of looking whole.
  const depsCaveats =
    loans.data != null && offers.data != null
      ? rowSetCaveats(rowSetState(loans.data), rowSetState(offers.data))
      : [];

  // Candidate ERC-20 set: canonical + every ERC-20 leg we know about.
  const candidates = new Set<string>(
    getCanonicalAssetsForChain(readChain.chainId).map((a) => a.toLowerCase()),
  );
  for (const loan of loans.data?.rows ?? []) {
    if (loan.assetType === AssetType.ERC20) candidates.add(loan.lendingAsset.toLowerCase());
    if (loan.collateralAssetType === AssetType.ERC20 && loan.collateralAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(loan.collateralAsset.toLowerCase());
    }
  }
  for (const offer of offers.data?.rows ?? []) {
    if (offer.assetType === AssetType.ERC20) candidates.add(offer.lendingAsset.toLowerCase());
    if (offer.collateralAssetType === AssetType.ERC20 && offer.collateralAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(offer.collateralAsset.toLowerCase());
    }
    if (offer.prepayAsset && offer.prepayAsset.toLowerCase() !== ZERO_ADDRESS) {
      candidates.add(offer.prepayAsset.toLowerCase());
    }
  }
  const tokenList = [...candidates].sort();

  const query = useQuery({
    queryKey: ['vaultAssets', readChain.chainId, address?.toLowerCase(), tokenList.join(','), scanWindow],
    enabled:
      Boolean(address) &&
      Boolean(publicClient) &&
      !depsUnavailable &&
      !depsLoading,
    // RPC read-diet PR A — receipt + focus + push + 180s net (§4.1.2).
    refetchInterval: signalAware(30_000),
    queryFn: async (): Promise<VaultSnapshot> => {
      const vault = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserVaultAddress',
        args: [address!],
      })) as `0x${string}`;
      if (vault.toLowerCase() === ZERO_ADDRESS) {
        return { vaultAddress: null, assets: [], unreadable: [], moreTokens: 0, nftCollections: [] };
      }

      // VPFI deposits arrive via the VPFI page, not via any loan or
      // offer, and VPFI isn't a canonical asset — without this the
      // vault of a VPFI-only depositor reads "empty".
      // #1247 PAG-001 rider (Codex #1265 r1) — window the SCANNED
      // candidate set: the five per-token reads fan out right here
      // inside the query, so the window must bound the scan itself,
      // not just the rendered rows. VPFI is appended AFTER the slice
      // — it must never fall out of the window.
      const scanTokens = tokenList.slice(0, scanWindow);
      try {
        const vpfiToken = (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getVPFIToken',
        })) as string;
        if (
          vpfiToken.toLowerCase() !== ZERO_ADDRESS &&
          !scanTokens.includes(vpfiToken.toLowerCase())
        ) {
          scanTokens.push(vpfiToken.toLowerCase());
        }
      } catch (err) {
        // Only a REVERT/zero-data means "VPFI facet absent on this
        // chain" (skip the token, scan the rest). A transport failure
        // is not knowledge — swallowing it would render a VPFI-only
        // vault as "empty"; rethrow so the page shows unavailable.
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (!isRevert) throw err;
      }
      // Assets the wallet deposited (or was paid into the vault) that no
      // loan or offer names: the contract lists every asset ever credited
      // to the depository ledger, in first-credit order, so a standalone
      // deposit is found after a reload. Read inside the same window as
      // the candidates; the rest counts toward "check more". An NFT
      // collection on that list is skipped only when it SAYS it is one
      // (ERC-165); a token that does not answer is read as an ERC-20, so a
      // failed read still lands in `unreadable` rather than vanishing.
      let depositoryMore = 0;
      const nftCollections: `0x${string}`[] = [];
      try {
        const [listed, listedTotal] = (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getDepositoryAssets',
          args: [address!, 0n, BigInt(scanWindow)],
        })) as readonly [readonly `0x${string}`[], bigint];
        depositoryMore = Math.max(0, Number(listedTotal) - listed.length);
        const fresh = listed.map((a) => a.toLowerCase()).filter((a) => !scanTokens.includes(a));
        const nftFlags = await Promise.all(fresh.map((a) => saysItIsAnNft(publicClient!, a as `0x${string}`)));
        fresh.forEach((a, i) => {
          if (nftFlags[i]) nftCollections.push(a as `0x${string}`);
          else scanTokens.push(a);
        });
      } catch (err) {
        // Same rule as VPFI: only a revert / zero data means the Diamond
        // predates the depository list; a transport failure is rethrown.
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (!isRevert) throw err;
      }
      // Counted AFTER the VPFI append (Codex #1265 r3): a VPFI token
      // that sat past the slice but was appended above IS scanned —
      // it must not leave a phantom "Check 1 more token" button.
      const scannedSet = new Set(scanTokens);
      const moreTokens = tokenList.filter((t) => !scannedSet.has(t)).length + depositoryMore;

      const unreadable: `0x${string}`[] = [];
      const rows = await Promise.all(
        scanTokens.map(async (tokenLower): Promise<VaultAssetRow | null> => {
          const token = tokenLower as `0x${string}`;
          try {
            const [raw, tracked, contractFree, symbol, decimals] = await Promise.all([
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [vault],
              }),
              publicClient!.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'getTrackedHolding',
                args: [address!, token, 0n],
              }) as Promise<bigint>,
              publicClient!.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'freeHolding',
                args: [address!, 0, token, 0n],
              }) as Promise<bigint>,
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'symbol',
              }),
              publicClient!.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'decimals',
              }),
            ]);
            const total = raw < tracked ? raw : tracked;
            // The contract's free figure (liens and queued payouts out),
            // never more than the vault actually holds; the rest is locked.
            const free = contractFree < total ? contractFree : total;
            const locked = total - free;
            if (total === 0n && locked === 0n) return null; // hide empty rows
            return { token, symbol, decimals, total, locked, free };
          } catch {
            // Don't sink the whole page on one bad token, but don't
            // pretend the scan was complete either — a transient read
            // failure on an asset backing a live position would make
            // locked funds silently vanish from "where my assets sit".
            unreadable.push(token);
            return null;
          }
        }),
      );

      const assets = rows
        .filter((r): r is VaultAssetRow => r !== null)
        .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
      return { vaultAddress: vault, assets, unreadable, moreTokens, nftCollections };
    },
  });

  return { ...query, depsUnavailable, depsLoading, depsCaveats };
}

const ERC721_INTERFACE_ID = '0x80ac58cd' as const;
const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;
const ERC165_ABI = [
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** True only when `token` answers ERC-165 for ERC-721 or ERC-1155. A
 *  revert or failed read is "not known to be an NFT". */
async function saysItIsAnNft(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  token: `0x${string}`,
): Promise<boolean> {
  const ask = (id: `0x${string}`) =>
    client
      .readContract({ address: token, abi: ERC165_ABI, functionName: 'supportsInterface', args: [id] })
      .catch(() => false);
  const [is721, is1155] = await Promise.all([ask(ERC721_INTERFACE_ID), ask(ERC1155_INTERFACE_ID)]);
  return is721 === true || is1155 === true;
}
