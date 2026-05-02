/**
 * T-042 Phase 4 — Safe deep-link composer.
 *
 * For every "Propose change" button on the admin dashboard, we
 * compose the calldata for the target setter and hand the operator
 * off to Safe (https://app.safe.global) with the transaction
 * pre-filled. The dashboard NEVER signs the proposal — that's
 * Safe's job, and Safe's UI is the world's best multisig signing
 * flow. We just package the calldata and open the right URL.
 *
 * The deep-link format used here is Safe's `tx-builder` /
 * `transactions/queue` flow: a query-string-encoded JSON payload
 * Safe parses on landing and pre-populates the proposal review.
 * This is the pattern Aave / Compound governance UIs already use.
 *
 * Phase 4 explicitly does NOT wrap the call inside a TimelockController
 * `schedule` — the protocol's governance topology already routes
 * Safe → TimelockController via the Safe's transaction-execution
 * delegate, and the timelock proposal queue (T-042 reads it
 * separately for the "pending change" indicator) reflects the
 * post-Safe-approval state. If a deploy ever splits Safe and
 * Timelock onto different governance paths, this composer is the
 * place to add the schedule-wrap.
 */

import { encodeFunctionData, type Abi } from 'viem';
import type { KnobMeta } from './adminKnobsZones';

/** Per-network Safe app subdomain. Same Safe URL handles both
 *  mainnet and L2 chains via the `safe=<eip3770-prefix>` query. */
const EIP3770_PREFIX_BY_CHAIN_ID: Record<number, string> = {
  1: 'eth',
  10: 'oeth',
  56: 'bnb',
  137: 'matic',
  8453: 'base',
  42161: 'arb1',
  // Testnet equivalents that Safe currently supports:
  11155111: 'sep',
  84532: 'basesep',
  421614: 'arb-sep',
  11155420: 'op-sep',
  97: 'bnbtest',
  80002: 'pol-amoy',
};

export interface SafeDeepLinkParams {
  /** Connected Safe address (the multisig that will sign). */
  safe: string;
  /** Target chain id. */
  chainId: number;
  /** The diamond address (or other target contract) for the call. */
  to: string;
  /** Encoded calldata for the setter. */
  data: string;
  /** Native value to send. Always 0 for governance writes; kept for
   *  API symmetry with future calls. */
  value?: string;
}

/**
 * Build the Safe deep-link URL. Returns `null` when the chain isn't
 * Safe-supported (e.g. anvil-localhost, polygon-zkevm pre-Safe).
 */
export function buildSafeDeepLink(p: SafeDeepLinkParams): string | null {
  const prefix = EIP3770_PREFIX_BY_CHAIN_ID[p.chainId];
  if (!prefix) return null;
  // Safe Transaction Builder accepts a base64-or-jsonurl-encoded
  // payload via the `txs` param. We use the standard
  // safe-apps-sdk-compatible flat shape: an array of `{to, value, data}`.
  // This is what the Safe Apps SDK serialises and what Safe's UI
  // accepts on a deep-link landing.
  const payload = [
    {
      to: p.to,
      value: p.value ?? '0',
      data: p.data,
      operation: 0,
    },
  ];
  const safeIdentifier = `${prefix}:${p.safe}`;
  // Base URL: Safe's transaction-queue route. Adding the txs param
  // pre-populates the create-transaction modal.
  const txsB64 = encodeJsonForUrl(payload);
  return `https://app.safe.global/transactions/queue?safe=${encodeURIComponent(
    safeIdentifier,
  )}&txs=${txsB64}`;
}

/** URL-safe base64 of a JSON-stringified payload. Browser-native:
 *  no extra dep. */
function encodeJsonForUrl(value: unknown): string {
  const json = JSON.stringify(value);
  // btoa requires Latin-1; route via TextEncoder + spread to bypass.
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encode the calldata for a knob's setter given a single new value.
 *
 * Most setters take one arg. A few take a tuple (e.g. fees-config
 * sets treasuryFeeBps + loanInitiationFeeBps in one call); for those
 * the dashboard collects all needed args before calling this.
 *
 * The `args` parameter accepts the new values in the same order as
 * `knob.setter.args`. Type coercion to bigint / boolean / 0x-prefixed
 * hex happens here based on each arg's declared type.
 */
export function encodeKnobSetCall(
  knob: KnobMeta,
  diamondAbi: Abi,
  args: ReadonlyArray<string | number | bigint | boolean>,
): `0x${string}` {
  if (args.length !== knob.setter.args.length) {
    throw new Error(
      `encodeKnobSetCall: expected ${knob.setter.args.length} args for ${knob.setter.fn}, got ${args.length}`,
    );
  }
  const coerced = args.map((raw, i) => coerceArg(raw, knob.setter.args[i].type));
  return encodeFunctionData({
    abi: diamondAbi,
    functionName: knob.setter.fn,
    args: coerced,
  });
}

/** Coerce a string-or-number input into the right viem-compatible
 *  type for the named Solidity type. */
function coerceArg(raw: string | number | bigint | boolean, solType: string): unknown {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'bigint') return raw;
  if (solType === 'bool') {
    if (typeof raw === 'string') return raw === 'true' || raw === '1';
    return Boolean(raw);
  }
  if (solType === 'address') return raw as string;
  if (solType === 'bytes32') return raw as string;
  if (solType === 'string') return raw as string;
  // Numeric types — uint*, int*. Coerce string/number to bigint.
  if (typeof raw === 'number') return BigInt(raw);
  if (typeof raw === 'string') return BigInt(raw);
  return raw;
}
