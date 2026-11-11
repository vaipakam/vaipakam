/**
 * The one way this app sends a contract write (RB-GAS). Every write is sent
 * with a gas limit taken from a fresh estimate plus the margin every sender in
 * the repository uses (`@vaipakam/lib/gasLimit`), never with the node's bare
 * estimate.
 *
 * Why: an estimate is the LOWEST limit that works in the latest block, and
 * the write mines in a later one. A call whose cost moves with the clock (an
 * oracle read, a rate limiter that refills with time) then needs a little
 * more, and at a zero-margin limit a nested call runs out of gas and the
 * whole write reverts with no reason. The connected app met exactly that on
 * an accept a block after its estimate. Unused gas is not charged, so the
 * margin costs nothing when it is not needed.
 *
 * The estimate is asked of the wallet's own provider first (the node the
 * write is sent through), then of the app's own endpoints. When the call
 * reverts on estimation, or no source can estimate it, no limit is set and
 * the wallet estimates as it always did: it then reports the same refusal,
 * which is what the error surfaces read. A limit the caller set on purpose
 * (a batch whose estimate is taken on a stricter form) is kept as given.
 */
import type { Abi, ContractFunctionArgs, ContractFunctionName } from 'viem';
import { estimateContractGas } from 'viem/actions';
import type { Config } from 'wagmi';
import { getConnectorClient, writeContract, type WriteContractParameters, type WriteContractReturnType } from 'wagmi/actions';
import { gasLimitFromEstimate } from '@vaipakam/lib/gasLimit';
import { isRevert } from './simulate';

/** One way of asking for the estimate, tried in order. */
export type GasEstimator = () => Promise<bigint>;

/**
 * The gas limit to send with: the first estimate any source gives, plus the
 * margin. `undefined` (the wallet estimates) when the call reverts on
 * estimation, since every later source would say the same, or when no
 * source could estimate it at all.
 */
export async function gasLimitThrough(estimators: readonly GasEstimator[]): Promise<bigint | undefined> {
  for (const estimate of estimators) {
    try {
      return gasLimitFromEstimate(await estimate());
    } catch (e) {
      if (isRevert(e)) return undefined;
    }
  }
  return undefined;
}

type Mutability = 'nonpayable' | 'payable';

/**
 * Send a contract write with a margined gas limit. Same parameters and
 * result as wagmi's `writeContract`; it is the only caller of it outside
 * the held protection files (eslint `no-restricted-imports`).
 */
export async function sendWrite<
  config extends Config,
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, Mutability>,
  args extends ContractFunctionArgs<abi, Mutability, functionName>,
  chainId extends config['chains'][number]['id'],
>(config: config, parameters: WriteContractParameters<abi, functionName, args, config, chainId>): Promise<WriteContractReturnType> {
  // A loose view of the request for the estimate; the call itself keeps
  // wagmi's typing.
  const p = parameters as unknown as {
    gas?: bigint;
    address: `0x${string}`;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
    account?: `0x${string}`;
    chainId?: number;
  };
  if (p.gas !== undefined) return writeContract(config, parameters);
  type Estimate = Parameters<typeof estimateContractGas>[1];
  const request = { address: p.address, abi: p.abi, functionName: p.functionName, args: p.args, value: p.value };
  const gas = await gasLimitThrough([
    async () => {
      const wallet = await getConnectorClient(config, { chainId: p.chainId, assertChainId: false });
      return estimateContractGas(wallet, { ...request, account: p.account ?? wallet.account } as Estimate);
    },
    async () => {
      if (!p.account) throw new Error('no account to estimate as');
      return estimateContractGas(config.getClient({ chainId: p.chainId }), { ...request, account: p.account } as Estimate);
    },
  ]);
  return writeContract(config, { ...parameters, gas } as typeof parameters);
}
