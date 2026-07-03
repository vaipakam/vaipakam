import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { ZERO_ADDRESS } from '@vaipakam/lib/address';

const OVERRIDE_KEYS = new Set([
  'value', 'gasLimit', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'from',
]);

function extractOverrides(args: unknown[]): { finalArgs: unknown[]; value?: bigint } {
  if (args.length === 0) return { finalArgs: args };
  const last = args[args.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return { finalArgs: args };
  const keys = Object.keys(last as object);
  if (keys.length === 0 || !keys.every((k) => OVERRIDE_KEYS.has(k))) return { finalArgs: args };
  const overrides = last as { value?: bigint };
  return { finalArgs: args.slice(0, -1), value: overrides.value };
}

function abiFunctionEntry(abi: Abi, name: string) {
  return abi.find((e) => e.type === 'function' && 'name' in e && e.name === name) as
    | { stateMutability?: string }
    | undefined;
}

export interface TxResponse {
  hash: Hex;
  wait: () => Promise<unknown>;
}

export type DiamondHandle = Record<string, (...args: unknown[]) => Promise<unknown | TxResponse>>;

interface BuildProxyOpts {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient | null;
}

export function buildDiamondProxy({ address, publicClient, walletClient }: BuildProxyOpts): DiamondHandle {
  const staticCall = (name: string) => async (...args: unknown[]) => {
    const { finalArgs } = extractOverrides(args);
    return publicClient.readContract({
      address,
      abi: DIAMOND_ABI_VIEM,
      functionName: name,
      args: finalArgs as readonly unknown[],
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
            args: finalArgs as readonly unknown[],
          });
        }

        if (!walletClient?.account) {
          throw new Error(`Cannot call ${prop}: wallet not connected.`);
        }

        const hash: Hex = await walletClient.writeContract({
          address,
          abi: DIAMOND_ABI_VIEM,
          functionName: prop,
          args: finalArgs as readonly unknown[],
          ...(value !== undefined ? { value } : {}),
          account: walletClient.account,
          chain: walletClient.chain,
        });

        return {
          hash,
          wait: async () => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(`Transaction reverted on-chain. Tx ${hash}`);
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

export function createDiamondReadClient(opts: {
  diamondAddress: string | null;
  rpcUrl: string;
}): DiamondHandle {
  const address = (opts.diamondAddress ?? ZERO_ADDRESS) as Address;
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  return buildDiamondProxy({ address, publicClient, walletClient: null });
}

export function createDiamondWriteClient(opts: {
  diamondAddress: string | null;
  rpcUrl: string;
  walletClient: WalletClient;
}): DiamondHandle {
  const address = (opts.diamondAddress ?? ZERO_ADDRESS) as Address;
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  return buildDiamondProxy({ address, publicClient, walletClient: opts.walletClient });
}