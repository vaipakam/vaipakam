/**
 * #2760 item 3 — the value floor for an auto-roll the keeper pays gas for.
 *
 * Anyone may delegate AUTO_ROLL to this keeper, and a roll earns the keeper
 * nothing back (no matcher share), so the keeper wallet pays every roll's gas.
 * Owner decision 2026-10-25 ("Gas ratio"): the keeper rolls a loan only when
 * the amount it re-lends is worth at least {@link ROLL_MIN_VALUE_TO_GAS} times
 * the roll's gas cost. Both sides are valued by the Diamond's own pricing rule
 * (`NumeraireValueFacet.getNumeraireValue`), the same figure every other value
 * comparison in the protocol uses. A loan the keeper declines is not stuck: its
 * owner can still roll it, or claim it, themselves.
 *
 * The cost valued is the roll's WHOLE fee, as each chain charges it (see
 * {@link rollFeeModel}): on an OP-stack chain that is the execution gas plus
 * the separately charged L1 data fee and any operator fee. A chain whose fee
 * model this keeper does not know gets no figure, rather than the execution
 * gas alone, which would understate it.
 *
 * The fee is paid in the chain's native coin, which the Diamond does not price
 * directly, so it is valued through the chain's WRAPPED native token: one wei
 * of fee is one base unit of the wrapped token (both 18 decimals). Where this
 * keeper does not know a chain's wrapped native token or fee model, or the
 * Diamond cannot price the token, no roll is worth its gas as far as the keeper
 * can tell, and the pass says so instead of rolling unpriced.
 */
import { NumeraireValueFacetABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { Abi, Account, Address, PublicClient } from 'viem';
import { estimateContractTotalFee } from 'viem/op-stack';

/** The rolled amount must be worth at least this many times the roll's gas. */
export const ROLL_MIN_VALUE_TO_GAS = 100n;

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
 *  - null: unknown, so no roll here can be valued. */
export type RollFeeModel = 'gasOnly' | 'opStack';
const FEE_MODELS: Readonly<Record<number, RollFeeModel>> = {
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

export function rollFeeModel(chainId: number): RollFeeModel | null {
  return FEE_MODELS[chainId] ?? null;
}

/** Why no roll on `chainId` can be valued, or null when one can. */
export function rollUnpricedReason(chainId: number): string | null {
  if (!wrappedNativeToken(chainId)) return 'no wrapped native token is known for this chain';
  if (!rollFeeModel(chainId)) return "this chain's transaction fee model is not known to the keeper";
  return null;
}

/** The roll's whole fee in wei under the chain's fee model. Throws what the
 *  estimate throws (an undelegated owner's revert among them), and throws on a
 *  chain whose fee model is unknown rather than returning the gas alone. */
export async function estimateRollFeeWei(
  client: PublicClient,
  chainId: number,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; account: Account },
): Promise<bigint> {
  const model = rollFeeModel(chainId);
  if (model === 'opStack') {
    return estimateContractTotalFee(client as never, request as never);
  }
  if (model === 'gasOnly') {
    const [gas, price] = await Promise.all([client.estimateContractGas(request as never), client.getGasPrice()]);
    return gas * price;
  }
  throw new Error(`no transaction fee model is known for chain ${chainId}`);
}

/** Pure rule: is a roll worth `rolledValue` worth its `gasValue`? Both are
 *  1e18 numeraire. */
export function rollWorthItsGas(rolledValue: bigint, gasValue: bigint): boolean {
  return rolledValue >= gasValue * ROLL_MIN_VALUE_TO_GAS;
}

export type RollValueVerdict =
  | { kind: 'worth'; rolledValue: bigint; gasValue: bigint }
  | { kind: 'dust'; rolledValue: bigint; gasValue: bigint }
  /** The keeper cannot value this chain's gas, so it can value no roll here. */
  | { kind: 'gasUnpriced'; reason: string }
  /** The keeper cannot value this loan's lending asset; other loans may differ. */
  | { kind: 'assetUnpriced'; reason: string };

/** Value a roll of `amount` of `lendingAsset` against its whole fee, `feeWei`
 *  (from {@link estimateRollFeeWei}). The rolled amount rounds DOWN and the fee
 *  UP, so a borderline roll is declined rather than paid for. */
export async function judgeRollValue(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  chainId: number,
  lendingAsset: Address,
  amount: bigint,
  feeWei: bigint,
): Promise<RollValueVerdict> {
  const gasToken = wrappedNativeToken(chainId);
  if (!gasToken) return { kind: 'gasUnpriced', reason: 'no wrapped native token is known for this chain' };
  const value = (asset: Address, units: bigint, roundUp: boolean) =>
    client.readContract({
      address: diamond,
      abi: NumeraireValueFacetABI as Abi,
      functionName: 'getNumeraireValue',
      args: [asset, units, roundUp],
    }) as Promise<bigint>;
  let gasValue: bigint;
  try {
    gasValue = await value(gasToken, feeWei, true);
  } catch (err) {
    return { kind: 'gasUnpriced', reason: `the fee could not be valued: ${String(err).slice(0, 120)}` };
  }
  let rolledValue: bigint;
  try {
    rolledValue = await value(lendingAsset, amount, false);
  } catch (err) {
    return { kind: 'assetUnpriced', reason: `the Diamond could not value ${lendingAsset}: ${String(err).slice(0, 120)}` };
  }
  return rollWorthItsGas(rolledValue, gasValue)
    ? { kind: 'worth', rolledValue, gasValue }
    : { kind: 'dust', rolledValue, gasValue };
}
