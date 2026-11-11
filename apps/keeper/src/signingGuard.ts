// apps/keeper/src/signingGuard.ts
//
// #3543 — the last check before the keeper key signs anything.
//
// Every place the keeper key signs (`queuedWallet` in `submissionQueue.ts`,
// on the slot path and on a send whose nonce the caller chose, and
// `sendInSubmissionSlot` in `keeperSend.ts`) lets viem's
// `prepareTransactionRequest` fill the fee fields and the chain id from the
// RPC. A faulty or hostile RPC could therefore ask the keeper to sign a
// transaction that burns the wallet's gas money in fees (an inflated fee per
// gas, tip or gas limit), or one for a different chain. This module checks
// the prepared request against figures the RPC does not supply, and refuses
// to sign anything outside them:
//
//   - the chain id must be the chain the pass was configured for (the keeper's
//     own chain list, never an RPC answer); the signed bytes carry that id;
//   - the fee per gas (`maxFeePerGas`, or `gasPrice` on a legacy chain) and
//     the tip (`maxPriorityFeePerGas`) must be at or under the chain's
//     ceilings;
//   - the most the fee can cost (gas limit × fee per gas) must be at or under
//     the chain's per-transaction ceiling. This is the bound on an inflated
//     gas limit, which no per-gas ceiling catches.
//
// The value a transaction carries is not in the cost ceiling: the RPC does
// not choose it (the pass does), and a paid CCIP fee is bounded by that
// pass's own ceiling (`feeCeiling.ts`, #2627). An OP-stack chain's L1 data
// fee is charged on top by the chain itself, from L1 prices, and is not a
// field of the transaction.
//
// A refusal throws BEFORE the signature, so nothing can reach the network and
// the submission slot releases the nonce. It is logged, and raised as an ops
// alert (one per chain per ten minutes) naming the action and the figures, so
// a real fee spike above a ceiling is an operator's decision to raise it, not
// a silent stall. A ceiling that cannot be read (a malformed variable, a chain
// with neither a built-in figure nor an entry) holds every send on that chain,
// and says why: an unknown never signs.
//
// The ceilings are plain vars, not secrets: a comma list of `<chainId>=<wei>`
// entries plus an optional `*=<wei>` (the same form as the #2627 fee
// ceilings, parsed by the same function). A chain the variable does not name
// uses the built-in figure for that chain.

import { decodeFunctionData, type Hex, type LocalAccount } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { chainWeiEntry } from './feeCeiling';

const GWEI = 10n ** 9n;
/** 10^18 wei: one whole native token. */
const COIN = 10n ** 18n;

/** The three figures a chain's sends must stay at or under. */
export interface GasCeiling {
  /** Highest fee per gas: `maxFeePerGas`, or `gasPrice` on a legacy chain. */
  maxFeePerGasWei: bigint;
  /** Highest tip per gas (`maxPriorityFeePerGas`). */
  maxPriorityFeePerGasWei: bigint;
  /** Highest gas limit × fee per gas: the most one send's fee can cost. */
  maxTxFeeWei: bigint;
}

/** The variables an operator sets to change a chain's ceilings. */
export const GAS_CEILING_VARS = {
  maxFeePerGasWei: 'GAS_MAX_FEE_PER_GAS_WEI',
  maxPriorityFeePerGasWei: 'GAS_MAX_PRIORITY_FEE_PER_GAS_WEI',
  maxTxFeeWei: 'GAS_MAX_TX_FEE_WEI',
} as const satisfies Record<keyof GasCeiling, string>;

function ceiling(maxFeeGwei: bigint, maxTipGwei: bigint, maxTxFeeMilli: bigint): GasCeiling {
  return {
    maxFeePerGasWei: maxFeeGwei * GWEI,
    maxPriorityFeePerGasWei: maxTipGwei * GWEI,
    // In thousandths of the native token, so a figure reads as written.
    maxTxFeeWei: (maxTxFeeMilli * COIN) / 1000n,
  };
}

/**
 * The built-in ceilings per chain, used where the variables name neither the
 * chain nor `*`. Each is many times what the chain charges in a busy hour, so
 * normal operation never meets it, and low enough that a hostile RPC cannot
 * drain the keeper wallet in a few sends. A testnet carries its mainnet's
 * figures (the testnets are kept in parity with what will run on mainnet),
 * except Ethereum Sepolia, whose fee market swings far wider and whose coin
 * has no value. Anvil (31337) is the local test chain.
 */
export const DEFAULT_GAS_CEILINGS: ReadonlyMap<number, GasCeiling> = new Map([
  // Ethereum: up to 300 gwei, 20 gwei tip, 0.3 ETH a send.
  [1, ceiling(300n, 20n, 300n)],
  [11155111, ceiling(1_000n, 100n, 1_000n)],
  // OP-stack and Arbitrum L2s: up to 20 gwei, 2 gwei tip, 0.01 ETH a send.
  [8453, ceiling(20n, 2n, 10n)],
  [84532, ceiling(20n, 2n, 10n)],
  [10, ceiling(20n, 2n, 10n)],
  [11155420, ceiling(20n, 2n, 10n)],
  [42161, ceiling(20n, 2n, 10n)],
  [421614, ceiling(20n, 2n, 10n)],
  // Polygon PoS: up to 3,000 gwei, 1,000 gwei tip, 30 POL a send.
  [137, ceiling(3_000n, 1_000n, 30_000n)],
  [80002, ceiling(3_000n, 1_000n, 30_000n)],
  // BNB Chain: up to 30 gwei (its tip can equal its whole price), 0.03 BNB.
  [56, ceiling(30n, 30n, 30n)],
  [97, ceiling(30n, 30n, 30n)],
  // Anvil: wide, so the local scenarios never meet it.
  [31337, ceiling(1_000n, 1_000n, 10_000n)],
]);

/** The variables the ceilings are read from (a subset of the keeper env). */
export type GasCeilingVars = Partial<Record<(typeof GAS_CEILING_VARS)[keyof GasCeiling], string>>;

/** A chain's ceilings, each figure with where it came from, or why none. */
export type ResolvedGasCeiling =
  | { ceiling: GasCeiling; from: Record<keyof GasCeiling, string> }
  | { unread: string };

/** The ceilings `vars` set for `chainId`. */
export function resolveGasCeiling(vars: GasCeilingVars, chainId: number): ResolvedGasCeiling {
  const builtIn = DEFAULT_GAS_CEILINGS.get(chainId);
  const out = {} as GasCeiling;
  const from = {} as Record<keyof GasCeiling, string>;
  for (const field of Object.keys(GAS_CEILING_VARS) as (keyof GasCeiling)[]) {
    const varName = GAS_CEILING_VARS[field];
    const entry = chainWeiEntry(vars[varName], chainId, varName);
    if ('unread' in entry) return { unread: `${varName} is malformed (${entry.unread})` };
    if ('wei' in entry) {
      out[field] = entry.wei;
      from[field] = entry.from;
    } else if (builtIn) {
      out[field] = builtIn[field];
      from[field] = `the built-in figure for chain ${chainId}`;
    } else {
      return { unread: `chain ${chainId} has no built-in gas ceiling and ${varName} names neither it nor *` };
    }
  }
  return { ceiling: out, from };
}

/** The fields of a prepared request this check reads. */
export interface PreparedFees {
  chainId?: number;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  to?: Hex | null;
  data?: Hex;
}

/** Thrown in place of a signature; nothing was signed or sent. */
export class SigningRefused extends Error {
  override readonly name = 'SigningRefused';
  constructor(
    readonly chainId: number,
    readonly reason: string,
  ) {
    super(`keeper refused to sign on chain ${chainId}: ${reason}`);
  }
}

const gwei = (wei: bigint): string => {
  const whole = wei / GWEI;
  const frac = wei % GWEI;
  return frac === 0n ? `${whole} gwei` : `${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '')} gwei`;
};

/**
 * Why `request` must not be signed for `chainId` under `resolved`, or null
 * when it may. Every field it needs must be present: a request missing its
 * gas limit or fee is refused, since its cost cannot be bounded.
 */
export function signingRefusal(request: PreparedFees, chainId: number, resolved: ResolvedGasCeiling): string | null {
  if (request.chainId !== chainId) {
    return `the prepared request is for chain ${String(request.chainId)}, not the configured chain ${chainId}`;
  }
  if ('unread' in resolved) return `its gas ceiling cannot be read: ${resolved.unread}`;
  const c = resolved.ceiling;
  const legacy = request.gasPrice !== undefined && request.maxFeePerGas === undefined;
  const feePerGas = legacy ? request.gasPrice : request.maxFeePerGas;
  if (typeof request.gas !== 'bigint' || typeof feePerGas !== 'bigint') {
    return 'the prepared request has no gas limit or no fee per gas, so its cost cannot be bounded';
  }
  if (feePerGas > c.maxFeePerGasWei) {
    return `${legacy ? 'gas price' : 'max fee per gas'} ${gwei(feePerGas)} is above the ceiling ${gwei(c.maxFeePerGasWei)} (${resolved.from.maxFeePerGasWei})`;
  }
  // A legacy price is all tip above the base fee; bound it by the fee
  // ceiling alone, as above.
  if (!legacy) {
    const tip = request.maxPriorityFeePerGas;
    if (typeof tip !== 'bigint') return 'the prepared request has no priority fee, so its cost cannot be bounded';
    if (tip > c.maxPriorityFeePerGasWei) {
      return `priority fee ${gwei(tip)} is above the ceiling ${gwei(c.maxPriorityFeePerGasWei)} (${resolved.from.maxPriorityFeePerGasWei})`;
    }
  }
  const cost = request.gas * feePerGas;
  if (cost > c.maxTxFeeWei) {
    return `the most its fee can cost, ${cost} wei (gas limit ${request.gas} × ${gwei(feePerGas)}), is above the ceiling ${c.maxTxFeeWei} wei (${resolved.from.maxTxFeeWei})`;
  }
  return null;
}

/**
 * The action a refused request was for, in words an operator can act on:
 * the Diamond function and its first argument (a loan or offer id for every
 * keeper pass that acts on one), else the target and selector.
 */
export function describeAction(request: PreparedFees): string {
  const to = request.to ?? 'a contract creation';
  const data = request.data;
  if (!data || data.length < 10) return `a call to ${to}`;
  try {
    const decoded = decodeFunctionData({ abi: DIAMOND_ABI_VIEM, data });
    const first = decoded.args?.[0];
    const arg = typeof first === 'bigint' || typeof first === 'number' || typeof first === 'string' ? `(${String(first)}, …)` : '()';
    return `${decoded.functionName}${arg} on ${to}`;
  } catch {
    return `selector ${data.slice(0, 10)} on ${to}`;
  }
}

/** How often one chain's held-send alert may repeat: once per ten minutes. */
export const SIGNING_GUARD_ALERT_INTERVAL_SEC = 600;

/** Where a refusal is reported. Armed per tick; a test or script has none. */
export interface SigningGuardEvents {
  held(chainId: number, line: string): Promise<void>;
}

let armedVars: GasCeilingVars = {};
let armedEvents: SigningGuardEvents | null = null;
/** Chains whose held-send alert is being posted right now. */
const alertsInFlight = new Set<number>();

/**
 * Arm the guard for this tick: the variables to read ceilings from and where
 * a refusal is reported. Unarmed, the guard still enforces the built-in
 * ceilings; it only has nowhere to raise an alert.
 */
export function armSigningGuard(vars: GasCeilingVars, events: SigningGuardEvents | null): void {
  armedVars = vars;
  armedEvents = events;
}

/** Back to the unarmed state (tests). */
export function resetSigningGuard(): void {
  armedVars = {};
  armedEvents = null;
  alertsInFlight.clear();
}

/**
 * The check {@link signGuarded} runs between preparation and signature.
 * Returns the request with its chain id fixed to `chainId` (so the signed
 * bytes carry the configured chain, whatever a later field says); throws
 * {@link SigningRefused} otherwise, after logging and reporting the refusal.
 */
export function guardBeforeSigning<R extends object>(chainId: number, request: R): R & { chainId: number } {
  const fees = request as PreparedFees;
  const reason = signingRefusal(fees, chainId, resolveGasCeiling(armedVars, chainId));
  if (reason === null) return { ...request, chainId };
  const line = `held ${describeAction(fees)}: ${reason}. Nothing was signed.`;
  console.warn(`[signing-guard] chain=${chainId} ${line}`);
  const events = armedEvents;
  // One alert in flight per chain. The alert hook's interval is recorded only
  // once its post succeeds, so refusals landing while the first post is
  // still out would each read the old record and post again; a chain-wide
  // spike refuses every send on the chain at once.
  if (events && !alertsInFlight.has(chainId)) {
    alertsInFlight.add(chainId);
    void events
      .held(chainId, line)
      .catch((err: unknown) => {
        console.warn(`[signing-guard] chain=${chainId} could not raise the held-send alert (${err instanceof Error ? err.name : 'error'})`);
      })
      .finally(() => alertsInFlight.delete(chainId));
  }
  throw new SigningRefused(chainId, reason);
}

/**
 * Check `request` ({@link guardBeforeSigning}) and sign it with the local
 * key, over the configured chain id. Every place the keeper key signs goes
 * through here.
 *
 * It calls the account's own signer rather than viem's `signTransaction`
 * action: that action reads the chain id from the RPC (`eth_chainId`) and
 * signs over the answer, whatever chain id the request carries, so an RPC
 * that reported the configured chain during preparation and another one at
 * signing would get a signature for the other chain. Here no RPC is asked.
 * A signer that is not a local key is refused: the keeper only signs with
 * its own.
 */
export async function signGuarded(chainId: number, account: unknown, request: object): Promise<Hex> {
  const guarded = guardBeforeSigning(chainId, request);
  const signer = account as { type?: unknown; signTransaction?: unknown } | null | undefined;
  if (typeof signer !== 'object' || signer === null || signer.type !== 'local' || typeof signer.signTransaction !== 'function') {
    throw new SigningRefused(chainId, 'the signer is not a local key');
  }
  return (signer as unknown as LocalAccount).signTransaction(guarded as never);
}
