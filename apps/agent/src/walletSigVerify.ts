/**
 * Chain-aware wallet-signature verification (#2009).
 *
 * Every signed endpoint on this Worker used to verify a plain 65-byte
 * ECDSA signature with `recoverMessageAddress` and require the
 * recovered EOA to equal the claimed wallet — which no smart-contract
 * account can satisfy: a Safe or a deployed smart wallet signs via
 * ERC-1271 (`isValidSignature` on the account contract), and a
 * counterfactual one wraps that in ERC-6492. Those users could not
 * exercise ANY signed control — including the GDPR erasure right —
 * and the frontends grew detection shims to route them to email.
 *
 * This module is the one verifier the whole family shares:
 *
 * 1. FAST PATH — plain ECDSA recovery, no RPC. The overwhelmingly
 *    common case (an ordinary wallet) never touches a network.
 * 2. CHAIN PATH — viem's `verifyMessage` public action against a
 *    configured chain's RPC. It performs ERC-6492/ERC-1271
 *    verification (and re-checks plain ECDSA), so a deployed OR
 *    counterfactual smart account verifies exactly like an EOA. A
 *    65-byte signature that recovers to a DIFFERENT address still
 *    takes this path: an ERC-1271 account whose owner key produced a
 *    raw signature is a mismatch under recovery and valid under 1271.
 *
 * WHICH CHAIN: an account contract lives on a specific chain, so the
 * caller supplies the chain id when its request family carries one
 * (the alerts family signs over `chain_id`). The erasure family's
 * frozen message has NO chain field — records are keyed by wallet
 * ACROSS chains, address is the identity — so those requests may name
 * a chain in the (unsigned) body to verify against, and otherwise
 * every configured chain is tried, success on the first that
 * confirms. The unsigned chain hint changes only WHERE verification
 * runs, never WHAT it proves: `isValidSignature` on the account at
 * that address must approve these exact bytes. (Two parties holding
 * one address on different chains share the identity in this
 * service's model regardless of this module — that is a property of
 * keying by address, not of the chain hint.)
 *
 * OUTCOMES are three, not two: definitive yes; definitive no
 * (`mismatch` — every consulted chain answered and none confirmed);
 * and `unavailable` — no chain produced a definitive answer (RPC
 * down, or the named chain is not configured here). The distinction
 * is deliberately surfaced: telling a smart-account user their
 * signature is INVALID when the service was merely blind would send
 * them into a retry loop that cannot succeed. None of this touches
 * retention state, so it stays outside the gag-safe uniform-response
 * rule (same as the existing malformed-request 4xxs).
 */

import {
  createPublicClient,
  http,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { getChainConfigs, type Env } from './env';

/**
 * Signature shape: 0x-prefixed, even-length hex. NOT fixed at 65
 * bytes any more (#2009): an ERC-6492 wrapper carries the account's
 * factory calldata and is far longer. The cap bounds hostile input;
 * real 6492 wrappers for common account factories sit well under it.
 */
export const MAX_SIGNATURE_BYTES = 4096;
export const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;

export function isValidSignatureShape(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    SIGNATURE_RE.test(s) &&
    (s.length - 2) / 2 <= MAX_SIGNATURE_BYTES
  );
}

export type WalletSigVerdict =
  | { ok: true }
  | {
      ok: false;
      /** mismatch: every consulted chain answered, none confirmed.
       *  unavailable: no definitive answer could be obtained. */
      reason: 'mismatch' | 'unavailable';
    };

/**
 * The chain-consulting primitive, injectable for tests (the same
 * pattern as `AdminVerifier` in diagAdminAuth.ts): given a chain's
 * RPC url, does the account at `wallet` validate `signature` over
 * `message`? Throws on transport failure — the caller treats a throw
 * as "no answer from this chain", never as a no.
 */
export type ChainSigChecker = (
  rpcUrl: string,
  wallet: `0x${string}`,
  message: string,
  signature: Hex,
) => Promise<boolean>;

/** Real checker: viem's `verifyMessage` public action — ERC-6492
 *  aware (deployless verification for counterfactual accounts),
 *  falling through to ERC-1271 and plain ECDSA. Upstream-tested in
 *  viem; the decision logic around it is what our tests pin. */
export const verifyOnChain: ChainSigChecker = async (
  rpcUrl,
  wallet,
  message,
  signature,
) => {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return client.verifyMessage({ address: wallet, message, signature });
};

/**
 * Verify that `wallet` authorised `message` with `signature`.
 *
 * @param chainId where the account lives, when the request family
 *   knows it (signed `chain_id` on the alerts family; optional
 *   unsigned hint on the erasure family). Omitted → every configured
 *   chain is consulted.
 */
export async function verifyWalletSignature(
  env: Env,
  wallet: string,
  message: string,
  signature: string,
  chainId?: number,
  checker: ChainSigChecker = verifyOnChain,
): Promise<WalletSigVerdict> {
  const sig = signature as Hex;
  const address = wallet as `0x${string}`;

  // Fast path: a plain 65-byte ECDSA signature that recovers to the
  // wallet needs no RPC. Recovery failing — or recovering a different
  // address — proves nothing yet (see header), so it falls through.
  if ((signature.length - 2) / 2 === 65) {
    try {
      const recovered = await recoverMessageAddress({ message, signature: sig });
      if (recovered.toLowerCase() === wallet.toLowerCase()) return { ok: true };
    } catch {
      // Not ECDSA-recoverable — the chain path decides.
    }
  }

  const configured = getChainConfigs(env);
  const chains =
    chainId === undefined
      ? configured
      : configured.filter((c) => c.id === chainId);
  if (chains.length === 0) {
    // A named chain this Worker has no RPC for — or no chains
    // configured at all (the natural pre-deploy state). We cannot
    // say "invalid"; we can only say we cannot check.
    return { ok: false, reason: 'unavailable' };
  }

  let sawDefinitiveNo = false;
  for (const chain of chains) {
    try {
      if (await checker(chain.rpc, address, message, sig)) return { ok: true };
      sawDefinitiveNo = true;
    } catch {
      // RPC down or transient — no answer from this chain; try the
      // next. A throw is never treated as a "no".
    }
  }
  return { ok: false, reason: sawDefinitiveNo ? 'mismatch' : 'unavailable' };
}
