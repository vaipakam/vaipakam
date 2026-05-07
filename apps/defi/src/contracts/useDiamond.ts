import { useMemo } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { useWallet } from '../context/WalletContext';
import { useChainOverride } from '../context/ChainContext';
import { CHAIN_REGISTRY, DEFAULT_CHAIN, type ChainConfig } from './config';
import { DIAMOND_ABI_VIEM } from './abis';

/**
 * Resolves the chain that reads should target, in priority order:
 *   1. Explicit view-chain override (set by wallet-less UIs like the public
 *      dashboard's per-chain selector).
 *   2. The wallet's active chain, if it's a supported Diamond-deployed chain.
 *   3. DEFAULT_CHAIN — so read-only flows always work.
 */
function resolveReadChain(
  viewChainId: number | null,
  activeChain: ChainConfig | null,
  isCorrectChain: boolean,
): ChainConfig {
  if (viewChainId != null) {
    const override = CHAIN_REGISTRY[viewChainId];
    if (override && override.diamondAddress) return override;
  }
  if (activeChain && isCorrectChain && activeChain.diamondAddress) {
    return activeChain;
  }
  return DEFAULT_CHAIN;
}

// Keys that identify an ethers-style "overrides" trailing-arg object
// (only `value` is actually used in this codebase, but we list the
// common ones so a future override won't silently get passed as a struct).
const OVERRIDE_KEYS = new Set([
  'value',
  'gasLimit',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'from',
]);

function extractOverrides(
  args: unknown[],
): { finalArgs: unknown[]; value?: bigint } {
  if (args.length === 0) return { finalArgs: args };
  const last = args[args.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) {
    return { finalArgs: args };
  }
  const keys = Object.keys(last as object);
  if (keys.length === 0 || !keys.every((k) => OVERRIDE_KEYS.has(k))) {
    return { finalArgs: args };
  }
  const overrides = last as { value?: bigint };
  return { finalArgs: args.slice(0, -1), value: overrides.value };
}

function abiFunctionEntry(abi: Abi, name: string) {
  return abi.find(
    (e) => e.type === 'function' && 'name' in e && e.name === name,
  ) as { stateMutability?: string } | undefined;
}

/**
 * Ethers-Contract-shaped handle exposing dynamic `.method(args...)` access.
 * Read calls (view/pure) resolve to the decoded return value; write calls
 * resolve to `{ hash, wait() }` mirroring ethers' TransactionResponse —
 * so the existing `const tx = await diamond.X(...); await tx.wait();`
 * pattern at every call site works unchanged.
 *
 * Each method also exposes `.staticCall(args...)` which forces an
 * `eth_call` read regardless of the function's mutability — mirroring
 * ethers' `contract.fn.staticCall(...)` escape hatch used for nonpayable
 * lazy-deploy helpers (e.g. `getUserEscrow`).
 *
 * The value type is `any` because dispatch is name-driven — individual
 * call sites retain their own cast to the concrete return shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DiamondHandle = Record<string, any>;

interface BuildProxyOpts {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient | null;
}

function buildDiamondProxy({
  address,
  publicClient,
  walletClient,
}: BuildProxyOpts): DiamondHandle {
  // Staticcall helper — always goes through `eth_call`, regardless of the
  // function's declared mutability. Mirrors ethers' `fn.staticCall(...)`.
  const staticCall = (name: string) => async (...args: unknown[]) => {
    const { finalArgs } = extractOverrides(args);
    return publicClient.readContract({
      address,
      abi: DIAMOND_ABI_VIEM,
      functionName: name,
      args: finalArgs,
    });
  };

  return new Proxy({} as DiamondHandle, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const invoke = async (...args: unknown[]) => {
        const entry = abiFunctionEntry(DIAMOND_ABI_VIEM, prop);
        const mutability = entry?.stateMutability ?? 'nonpayable';
        const { finalArgs, value } = extractOverrides(args);

        if (mutability === 'view' || mutability === 'pure') {
          return publicClient.readContract({
            address,
            abi: DIAMOND_ABI_VIEM,
            functionName: prop,
            args: finalArgs,
          });
        }

        if (!walletClient) {
          throw new Error(
            `Cannot call state-changing function ${prop}: wallet not connected.`,
          );
        }
        const account = walletClient.account;
        if (!account) {
          throw new Error(`Cannot call ${prop}: wallet has no account.`);
        }
        const hash: Hex = await walletClient.writeContract({
          address,
          abi: DIAMOND_ABI_VIEM,
          functionName: prop,
          args: finalArgs,
          ...(value !== undefined ? { value } : {}),
          account,
          chain: walletClient.chain,
        });
        return {
          hash,
          // Wait for inclusion AND verify the receipt's `status` is
          // 'success'. viem's `waitForTransactionReceipt` resolves on
          // any inclusion (status 0 or 1), so a reverted tx would
          // otherwise look identical to a successful one — the
          // calling page would render "submitted successfully" while
          // the on-chain state never changed. Throwing here lets the
          // common `try { await tx.wait() } catch { … }` shape
          // surface the failure to the user.
          wait: async () => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(
                `Transaction reverted on-chain (status=${receipt.status}). ` +
                `Tx ${hash} mined but did not succeed — check the explorer ` +
                `for the revert reason.`,
              );
            }
            return receipt;
          },
        };
      };
      (invoke as { staticCall?: unknown }).staticCall = staticCall(prop);
      return invoke;
    },
  });
}

/**
 * Returns a Diamond handle that can drive both reads and writes.
 * Writes are only possible when a wallet is connected and its chain
 * matches the resolved read chain; otherwise calls to state-changing
 * functions throw with "wallet not connected" (matches the read-only
 * fallback the prior ethers-based implementation had).
 */
export function useDiamondContract(): DiamondHandle {
  const { isCorrectChain, activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);
  const wagmiPublic = usePublicClient({ chainId: chain.chainId });
  const { data: wagmiWallet } = useWalletClient();

  // The signer only matches the wallet's actual chain — if the user has
  // overridden the view chain, fall back to a read-only handle so writes
  // don't fire against the wrong network.
  const signerMatches =
    isCorrectChain &&
    (viewChainId == null || viewChainId === activeChain?.chainId);

  return useMemo(() => {
    const address = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress!) as Address;
    const publicClient = (wagmiPublic ??
      createPublicClient({ transport: http(chain.rpcUrl) })) as PublicClient;
    const walletClient =
      wagmiWallet && signerMatches ? (wagmiWallet as WalletClient) : null;
    return buildDiamondProxy({ address, publicClient, walletClient });
  }, [
    chain.diamondAddress,
    chain.rpcUrl,
    wagmiPublic,
    wagmiWallet,
    signerMatches,
  ]);
}

/**
 * Returns a read-only Diamond handle (always uses a public RPC — no wallet
 * needed). Targets the resolved read chain. Calling a state-changing
 * function on this handle throws because no wallet client is bound.
 */
export function useDiamondRead(): DiamondHandle {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);
  const wagmiPublic = usePublicClient({ chainId: chain.chainId });

  return useMemo(() => {
    const address = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress!) as Address;
    const publicClient = (wagmiPublic ??
      createPublicClient({ transport: http(chain.rpcUrl) })) as PublicClient;
    return buildDiamondProxy({
      address,
      publicClient,
      walletClient: null,
    });
  }, [chain.diamondAddress, chain.rpcUrl, wagmiPublic]);
}

/** viem `PublicClient` bound to the current read chain. Hooks that need to
 *  drive raw multicalls, `getLogs` scans, or other viem-native actions
 *  against the same chain as `useDiamondRead()` should use this. */
export function useDiamondPublicClient(): PublicClient {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain, isCorrectChain);
  const wagmiClient = usePublicClient({ chainId: chain.chainId });
  return useMemo(
    () =>
      (wagmiClient ??
        createPublicClient({ transport: http(chain.rpcUrl) })) as PublicClient,
    [wagmiClient, chain.rpcUrl],
  );
}

/** The ChainConfig reads will be dispatched against. Useful for hooks that
 *  also need to know the deploy block, explorer URL, or chainId that goes
 *  with the Diamond they just read. */
export function useReadChain(): ChainConfig {
  const { activeChain, isCorrectChain } = useWallet();
  const { viewChainId } = useChainOverride();
  return resolveReadChain(viewChainId, activeChain, isCorrectChain);
}

/**
 * Single source of truth for "can this page submit a write tx right now?".
 *
 * A write is safe iff all of these hold:
 *   - wallet is connected (address + wallet client present)
 *   - wallet is on a supported chain (isCorrectChain)
 *   - the dashboard's view-chain override, if set, matches the wallet's
 *     actual chain — otherwise useDiamondContract() has silently bound
 *     to a read-only handle and any state-changing call would throw.
 *
 * Write pages MUST gate buttons/handlers on this instead of just
 * isCorrectChain, or they'll allow clicks that can never settle.
 */
export function useCanWrite(): boolean {
  const { address, isCorrectChain, activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const { data: walletClient } = useWalletClient();
  return (
    !!address &&
    !!walletClient &&
    isCorrectChain &&
    (viewChainId == null || viewChainId === activeChain?.chainId)
  );
}
