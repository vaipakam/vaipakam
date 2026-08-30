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
  BaseError,
  ExecutionRevertedError,
  createPublicClient,
  encodeDeployData,
  hashMessage,
  http,
  recoverMessageAddress,
  universalSignatureValidatorAbi,
  universalSignatureValidatorByteCode,
  type Hex,
} from 'viem';
import { getRpcChains, type Env } from './env';

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
  | {
      ok: true;
      /** The wallet's private key signed — the universal controller,
       *  whose authority spans every chain (#2013 round 3 P1). */
      via: 'ecdsa';
    }
  | {
      ok: true;
      /** A contract at the address approved on ONE chain — named
       *  here, because a contract can have different controllers per
       *  chain, so chain-verified authority must not be spent on
       *  wallet-wide effects (#2013 rounds 3+5 P1: the unlink and
       *  the diagnostics-erasure handlers both scope on this). */
      via: 'chain';
      chainId: number;
    }
  | {
      ok: false;
      /** mismatch: EVERY relevant chain answered and none confirmed
       *  (#2013 round 3 P1 — an unanswered relevant chain forces
       *  `unavailable`, because the account might approve exactly
       *  there; a denial from a different chain proves nothing
       *  about it).
       *  unavailable: no complete definitive answer could be
       *  obtained.
       *  limited: the chain path's rate budget refused this request
       *  before any chain was consulted (#2013 round 1 P1). */
      reason: 'mismatch' | 'unavailable' | 'limited';
    };

/**
 * No-hint fan-out cap (#2013 round 1 P1): a request that names no
 * chain would otherwise consult EVERY configured chain, letting an
 * unauthenticated caller multiply one fake body into a subrequest
 * per chain. Capped consultation keeps its honesty: when the cap
 * excluded chains and none of the consulted ones confirmed, the
 * verdict is UNAVAILABLE, never mismatch — a deny is definitive only
 * for the chains actually asked, and an account living on an
 * unconsulted chain must not be told its signature is invalid.
 * Covers every currently-deployed chain; revisit when the deployed
 * set grows past it.
 */
export const MAX_CHAINS_PER_REQUEST = 3;

/**
 * Build the pre-chain-path gate from the Worker's rate-limit binding
 * (#2013 round 1 P1): the chain path spends RPC subrequests before
 * the caller has proven anything, so it is metered per client IP
 * like the other abusable endpoints (`DIAG_RECORD_RATELIMIT`
 * pattern). The ECDSA fast path stays free — it costs nothing.
 * Skipped silently when the binding is not configured (local dev),
 * matching every other rate-limit binding in this Worker.
 */
export function chainVerifyGate(
  env: Env,
  req: Request,
): () => Promise<boolean> {
  return async () => {
    const limiter = env.SIG_VERIFY_RATELIMIT;
    if (!limiter) return true;
    const ip =
      req.headers.get('CF-Connecting-IP') ??
      req.headers.get('X-Forwarded-For') ??
      'unknown';
    return (await limiter.limit({ key: ip })).success;
  };
}

/**
 * The chain-consulting primitive, injectable for tests (the same
 * pattern as `AdminVerifier` in diagAdminAuth.ts): given a chain's
 * RPC url and the chain id it is SUPPOSED to serve, does the account
 * at `wallet` validate `signature` over `message`? Throws on
 * transport failure — the caller treats a throw as "no answer from
 * this chain", never as a no.
 */
export type ChainSigChecker = (
  rpcUrl: string,
  expectedChainId: number,
  wallet: `0x${string}`,
  message: string,
  signature: Hex,
) => Promise<boolean>;

/** Per-RPC-call budget. Deliberately BELOW the frontends' request
 *  deadlines (#2013 round 2 P2 — the alerts client aborts its POST
 *  at 6s, `apps/app/src/data/alerts.ts`): a verification that
 *  succeeds after the browser gave up would let the Worker complete
 *  a link/unlink/mute while the UI reports failure, leaving local
 *  state opposite to the server's. Two calls at this budget with no
 *  retries keep the single-chain worst case ≈5s. */
const RPC_CALL_TIMEOUT_MS = 2500;

/**
 * Real checker (#2013 rounds 1–2 P1 hardened): this Worker OWNS the
 * verification `eth_call` instead of trusting viem's `verifyMessage`
 * boolean. viem's 6492 path converts a failed `eth_call` — wrapped
 * transport failures, rate limits included — into `false`, which
 * turned an RPC outage into a false "signature does not match"; a
 * liveness probe on another method was tried and beaten by review
 * with an RPC that 429s `eth_call` while serving `eth_chainId`. Here
 * the deployless universal-validator call is made directly, so the
 * verification call's OWN failure reaches us: only a genuine
 * on-chain revert (some validator wallets deny by reverting) or a
 * clean boolean counts as an answer; every other failure — HTTP
 * errors, rate limits, timeouts — throws to the caller's no-answer
 * handling.
 *
 * The endpoint must also PROVE it serves the expected chain before
 * either answer counts (#2013 round 2 P2): a crossed RPC secret or a
 * provider misrouting to another network would otherwise let a
 * same-address contract on the wrong chain confirm — or deny — for
 * the chain the request named.
 */
export const verifyOnChain: ChainSigChecker = async (
  rpcUrl,
  expectedChainId,
  wallet,
  message,
  signature,
) => {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: RPC_CALL_TIMEOUT_MS, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== expectedChainId) {
    throw new Error('rpc endpoint serves a different chain than configured');
  }
  const data = encodeDeployData({
    abi: universalSignatureValidatorAbi,
    bytecode: universalSignatureValidatorByteCode,
    args: [wallet, hashMessage(message), signature],
  });
  try {
    const { data: result } = await client.call({ data });
    return result !== undefined && BigInt(result) === 1n;
  } catch (err) {
    // A genuine execution revert is the validator's (or a quirky
    // 1271 wallet's) way of saying no — a definitive answer. Any
    // other failure is the transport failing US, not the signature
    // failing verification.
    if (
      err instanceof BaseError &&
      err.walk((e) => e instanceof ExecutionRevertedError)
    ) {
      return false;
    }
    throw err;
  }
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
  // The rate gate for the CHAIN PATH only (#2013 round 1 P1) —
  // consulted once, after the free fast path, before any RPC is
  // spent. Absent → ungated (callers without a request context,
  // and the default for tests of the decision logic).
  chainPathAllowed?: () => Promise<boolean>,
  // Injectable for tests; production uses the exported cap.
  maxChains: number = MAX_CHAINS_PER_REQUEST,
): Promise<WalletSigVerdict> {
  const sig = signature as Hex;
  const address = wallet as `0x${string}`;

  // Fast path: a plain 65-byte ECDSA signature that recovers to the
  // wallet needs no RPC. Recovery failing — or recovering a different
  // address — proves nothing yet (see header), so it falls through.
  if ((signature.length - 2) / 2 === 65) {
    try {
      const recovered = await recoverMessageAddress({ message, signature: sig });
      if (recovered.toLowerCase() === wallet.toLowerCase()) {
        return { ok: true, via: 'ecdsa' };
      }
    } catch {
      // Not ECDSA-recoverable — the chain path decides.
    }
  }

  // Every RPC-configured chain, NOT the deployment-gated list
  // (#2013 round 6 P2): verification is a deployless eth_call, so a
  // smart account on a chain with an RPC binding but no Vaipakam
  // deployment — an Ethereum Safe during the testnet phase — must
  // still be checkable rather than 503ing while its EOA twin passes
  // the fast path.
  const configured = getRpcChains(env);
  const relevant =
    chainId === undefined
      ? configured
      : configured.filter((c) => c.id === chainId);
  if (relevant.length === 0) {
    // A named chain this Worker has no RPC for — or no chains
    // configured at all (the natural pre-deploy state). We cannot
    // say "invalid"; we can only say we cannot check.
    return { ok: false, reason: 'unavailable' };
  }

  // Everything past this line spends RPC subrequests on an
  // unauthenticated body — the gate meters it (#2013 round 1 P1).
  if (chainPathAllowed && !(await chainPathAllowed())) {
    return { ok: false, reason: 'limited' };
  }

  const chains = relevant.slice(0, maxChains);
  const capped = chains.length < relevant.length;

  // CONCURRENT consultation (#2013 round 3 P2): a serial loop's
  // aggregate could outlive the callers' request deadlines (three
  // chains × two 2.5s RPCs ≈ 15s vs the erasure client's 10s abort),
  // letting a last-chain success erase records after the browser
  // reported failure. In parallel the wall time is one chain's worst
  // case (≈5s), under every caller deadline; the extra subrequests
  // on a would-have-short-circuited yes are bounded by the fan-out
  // cap and metered by the gate above.
  const outcomes = await Promise.all(
    chains.map(async (chain) => {
      try {
        return {
          answered: true,
          yes: await checker(chain.rpc, chain.id, address, message, sig),
        };
      } catch {
        // RPC down, transient, or serving the wrong chain — no
        // answer from this chain. A throw is never a "no".
        return { answered: false, yes: false };
      }
    }),
  );
  const confirmed = chains.find((c, i) => outcomes[i]!.answered && outcomes[i]!.yes);
  if (confirmed) return { ok: true, via: 'chain', chainId: confirmed.id };
  // A mismatch requires a COMPLETE set of denials (#2013 round 3
  // P1): if the cap excluded a relevant chain, or any consulted
  // chain gave no answer, the account might approve exactly on the
  // chain we could not hear from — a denial elsewhere proves nothing
  // about it, and the honest verdict is "cannot fully check".
  if (capped || outcomes.some((o) => !o.answered)) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: false, reason: 'mismatch' };
}
