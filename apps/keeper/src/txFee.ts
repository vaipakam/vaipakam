/**
 * The whole fee of a keeper transaction, and what it is worth (#2760 item 3,
 * #2697).
 *
 * Two passes decide on gas: the auto-roll pass declines a roll worth less than
 * its fee (rollGasFloor.ts), and the flash-loan discount path requires a trade
 * to net at least its fee (keeper.ts). Both measure the fee and value it here,
 * by one rule, so the two can never price the same transaction differently.
 *
 * The cost measured is the transaction's WHOLE fee, as each chain charges it
 * (see {@link txFeeModel}): on an OP-stack chain that is the execution gas plus
 * the separately charged L1 data fee and operator fee, each read, and none
 * assumed zero because its read failed. A chain whose fee model this keeper
 * does not know gets no figure, rather than the execution gas alone, which
 * would understate it.
 *
 * The fee is paid in the chain's native coin, which the Diamond does not price
 * directly, so it is valued through the chain's WRAPPED native token: one wei
 * of fee is one base unit of the wrapped token (both 18 decimals), valued by
 * the Diamond's own pricing rule (`NumeraireValueFacet.getNumeraireValue`).
 * Where this keeper does not know a chain's wrapped native token or fee model,
 * or the Diamond cannot price the token, the fee has no value as far as the
 * keeper can tell, and the caller says so instead of acting unpriced.
 */
import { NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';
import { encodeFunctionData, type Abi, type Account, type Address, type PublicClient } from 'viem';
import { estimateL1Fee } from 'viem/op-stack';

/** Chains whose native gas coin is ETH: their wrapped native token is the
 *  deployment's `weth`. */
const ETH_GAS_CHAINS: ReadonlySet<number> = new Set([
  1, // Ethereum
  8453, // Base
  42161, // Arbitrum One
  10, // Optimism
  11155111, // Ethereum Sepolia
  84532, // Base Sepolia
  421614, // Arbitrum Sepolia
  11155420, // OP Sepolia
]);

/** Chains whose native gas coin is not ETH, with their canonical wrapped
 *  native token. BNB Testnet is deliberately absent: its deployment's `weth` is
 *  a mock WETH stand-in, not wrapped BNB, so pricing BNB gas through it would
 *  be a made-up figure. */
const OTHER_GAS_TOKENS: Readonly<Record<number, Address>> = {
  137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // Polygon: WPOL
};

/** The token the keeper values a chain's gas in, or null when it has none. */
export function wrappedNativeToken(chainId: number): Address | null {
  if (ETH_GAS_CHAINS.has(chainId)) {
    return (getDeployment(chainId)?.weth as Address | undefined) ?? null;
  }
  return OTHER_GAS_TOKENS[chainId] ?? null;
}

/** How a chain charges for a transaction, as far as this keeper knows.
 *
 *  - `gasOnly`: the fee is the gas used times the gas price. Ethereum and
 *    Polygon PoS charge nothing else; Arbitrum charges for its L1 data in L2
 *    gas, which its gas estimate already includes.
 *  - `opStack`: the execution gas, plus an L1 data fee and (from Isthmus) an
 *    operator fee that the gas estimate leaves out.
 *  - null: unknown, so no transaction here can be valued. */
export type TxFeeModel = 'gasOnly' | 'opStack';
const FEE_MODELS: Readonly<Record<number, TxFeeModel>> = {
  1: 'gasOnly', // Ethereum
  11155111: 'gasOnly', // Ethereum Sepolia
  137: 'gasOnly', // Polygon PoS
  42161: 'gasOnly', // Arbitrum One (L1 data is in the gas estimate)
  421614: 'gasOnly', // Arbitrum Sepolia
  8453: 'opStack', // Base
  84532: 'opStack', // Base Sepolia
  10: 'opStack', // Optimism
  11155420: 'opStack', // OP Sepolia
};

export function txFeeModel(chainId: number): TxFeeModel | null {
  return FEE_MODELS[chainId] ?? null;
}

/** Why no transaction fee on `chainId` can be valued, or null when one can. */
export function txFeeUnpricedReason(chainId: number): string | null {
  if (!wrappedNativeToken(chainId)) return 'no wrapped native token is known for this chain';
  if (!txFeeModel(chainId)) return "this chain's transaction fee model is not known to the keeper";
  return null;
}

/** OP-stack `L1Block` predeploy: carries the operator-fee parameters. */
const OP_L1_BLOCK = '0x4200000000000000000000000000000000000015' as const;
const OP_L1_BLOCK_ABI = [
  { type: 'function', name: 'operatorFeeScalar', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'operatorFeeConstant', inputs: [], outputs: [{ type: 'uint64' }], stateMutability: 'view' },
] as const;

/** One contract call whose fee is estimated. */
export interface TxFeeRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  account: Account;
}

/** The call's whole fee in wei under the chain's fee model. Throws what the
 *  estimate throws (the call's own revert among them, which callers read: an
 *  undelegated owner, an unprofitable trade), and throws on a chain whose fee
 *  model is unknown rather than returning the gas alone.
 *
 *  On an OP-stack chain every part is read, and a part that cannot be read
 *  fails the estimate (Codex #2807 r3). viem's own `estimateTotalFee` treats a
 *  failed operator-fee read as "no operator fee" whatever the reason, which on
 *  an RPC outage understates the fee; every chain this keeper lists as
 *  OP-stack has the operator fee (Isthmus), so its parameters must answer. */
export async function estimateTxFeeWei(
  client: PublicClient,
  chainId: number,
  request: TxFeeRequest,
): Promise<bigint> {
  const model = txFeeModel(chainId);
  if (model === null) throw new Error(`no transaction fee model is known for chain ${chainId}`);
  const [gas, price] = await Promise.all([client.estimateContractGas(request as never), client.getGasPrice()]);
  const execution = gas * price;
  if (model === 'gasOnly') return execution;
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never);
  const [l1Fee, scalar, constant] = await Promise.all([
    estimateL1Fee(client as never, { account: request.account, to: request.address, data, chain: client.chain } as never),
    client.readContract({ address: OP_L1_BLOCK, abi: OP_L1_BLOCK_ABI, functionName: 'operatorFeeScalar' }),
    client.readContract({ address: OP_L1_BLOCK, abi: OP_L1_BLOCK_ABI, functionName: 'operatorFeeConstant' }),
  ]);
  // The operator fee as the chain charges it: gasUsed x scalar / 1e6 + constant.
  const operatorFee = (gas * BigInt(scalar)) / 1_000_000n + BigInt(constant);
  return execution + l1Fee + operatorFee;
}

/** A fee's value, or why it has none. */
export type FeeValue = { kind: 'priced'; value: bigint } | { kind: 'unpriced'; reason: string };

/** `feeWei` (from {@link estimateTxFeeWei}) in 1e18 numeraire, by the
 *  Diamond's pricing rule, rounded UP so a borderline decision errs against
 *  spending the gas. */
export async function feeNumeraireValue(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  chainId: number,
  feeWei: bigint,
): Promise<FeeValue> {
  const gasToken = wrappedNativeToken(chainId);
  if (!gasToken) return { kind: 'unpriced', reason: 'no wrapped native token is known for this chain' };
  try {
    const value = (await client.readContract({
      address: diamond,
      abi: NumeraireValueFacetABI as Abi,
      functionName: 'getNumeraireValue',
      args: [gasToken, feeWei, true],
    })) as bigint;
    return { kind: 'priced', value };
  } catch (err) {
    return { kind: 'unpriced', reason: `the fee could not be valued: ${summarizeFailure(err, 120)}` };
  }
}
