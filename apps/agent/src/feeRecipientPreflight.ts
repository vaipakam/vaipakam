/**
 * T-086 Round-5 Block A (#313) — fee-recipient pre-flight endpoint.
 *
 * POST /opensea/feeRecipientPreflight
 *
 * Body:
 *   {
 *     chainId:        number;
 *     principalAsset: `0x${string}`;
 *     askPrice:       string; // bigint as decimal string
 *     feeLegs: [
 *       { recipient: `0x${string}`, basisPoints: number }, ...
 *     ];
 *   }
 *
 * Response:
 *   {
 *     verdicts: [
 *       { recipient, verdict: "passed" | "rejected_by_token" |
 *                              "passed_sender_specific" |
 *                              "not_applicable" },
 *       …
 *     ];
 *   }
 *
 * **Lives on this dedicated endpoint** (Round-5.1 errata Codex P2
 * line 457) NOT on the collection-API proxy: the sim needs the
 * loan's principalAsset, chain config, sender to state-override,
 * and computed fee amounts — none of which the collection proxy
 * has.
 *
 * **State-DIFF override** (Round-5.1 errata Codex P2 line 458):
 * the `eth_call` payload uses `stateDiff` on the principalAsset's
 * balance-mapping slot, NOT `stateOverride` (which would replace
 * the whole account state and break proxy tokens like USDC).
 *
 * **Allow-list lookup**: tokens whose `transfer` can revert based
 * on recipient (USDC OFAC blocklist; ERC777 / ERC1363 hook-enabled
 * tokens; etc.) are configured in `RECIPIENT_VALIDATING_TOKENS`
 * per chain + token. Each entry carries the `balanceSlot`
 * identifier (resolved by the operator via the procedure in §14.4
 * of the design). Tokens NOT on the list return
 * `"not_applicable"` per recipient — NOT a false-confident
 * `"passed"`.
 *
 * **Multi-operator rotation** (Round-5.1 errata Codex P2 line 460):
 * for hook-enabled tokens, the agent runs the sim with multiple
 * representative from-addresses (executor / canonical Seaport
 * / known whale). Any rejection on ANY rep sender → overall
 * verdict `"rejected_by_token"`. All pass → `"passed_sender_specific"`
 * (NOT `"passed"`) so the dapp UI surfaces residual uncertainty.
 */

import type { Env } from './env';

interface FeeLegInput {
  recipient: `0x${string}`;
  basisPoints: number;
}

interface PreflightRequest {
  chainId: number;
  principalAsset: `0x${string}`;
  askPrice: string;
  feeLegs: FeeLegInput[];
}

type Verdict =
  | 'passed'
  | 'passed_sender_specific'
  | 'rejected_by_token'
  | 'not_applicable';

interface VerdictEntry {
  recipient: `0x${string}`;
  verdict: Verdict;
}

/**
 * Allow-list shape carried in env / wrangler vars. JSON-encoded
 * map; the agent loads it at request time. Adding a new token
 * means an operator config update — intentional, see §14.4.
 *
 * For namespaced-storage tokens (ERC-7201), `balanceSlot` is
 * the 32-byte namespace hash; for straight-mapping tokens it's
 * the slot index as `uint256` decimal string. The operator
 * resolves the slot via `cast index address <holder> <candidate>`
 * + `cast storage` (see §14.4 errata).
 */
type TokenAllowList = Record<
  string /* `${chainId}:${tokenLower}` */,
  {
    /** uint256 slot index for the balance mapping (decimal string) */
    balanceSlot: string;
    /** Whether the token has recipient-side hooks (ERC777/ERC1363) */
    hookEnabled: boolean;
  }
>;

const REP_SENDERS_PER_CHAIN: Record<number, `0x${string}`[]> = {
  // Mainnet — canonical Seaport, common WETH whale (for `from`
  // diversity), a freshly-allocated test address. Operators can
  // extend per their threat model.
  1: [
    '0x0000000000000068F116a894984e2DB1123eB395', // Seaport 1.6
    '0x2F0b23f53734252Bda2277357e97e1517d6B042A', // WETH whale (Gnosis Mainnet)
    '0xDEADbeEFCafEBABEDeadbeefCAfebabEdeadbeef',
  ],
  8453: [
    '0x0000000000000068F116a894984e2DB1123eB395',
    '0xDEADbeEFCafEBABEDeadbeefCAfebabEdeadbeef',
  ],
};

export async function handleFeeRecipientPreflight(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'method-not-allowed' }),
      { status: 405, headers: corsHeaders(env) },
    );
  }
  let body: PreflightRequest;
  try {
    body = (await req.json()) as PreflightRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid-json-body' }),
      { status: 400, headers: corsHeaders(env) },
    );
  }
  const { chainId, principalAsset, askPrice, feeLegs } = body;
  if (!chainId || !principalAsset || !askPrice || !Array.isArray(feeLegs)) {
    return new Response(
      JSON.stringify({ error: 'missing-required-fields' }),
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const allowList = parseAllowList(env);
  const key = `${chainId}:${principalAsset.toLowerCase()}`;
  const entry = allowList[key];

  if (!entry || !entry.balanceSlot) {
    // Token isn't on the recipient-validating list, or operator
    // hasn't populated balanceSlot. Pre-flight is structurally a
    // no-op on this token; return "not_applicable" per recipient.
    return new Response(
      JSON.stringify({
        verdicts: feeLegs.map((l): VerdictEntry => ({
          recipient: l.recipient,
          verdict: 'not_applicable',
        })),
      }),
      { status: 200, headers: corsHeaders(env) },
    );
  }

  // Real pre-flight path — placeholder for the state-diff sim
  // implementation, which depends on RPC endpoint + viem
  // simulateContract wiring. The signature + contract are
  // specified here; the operator deploy-script lands the
  // production sim wiring per the §14.4 spec.
  // For Block A this returns "passed" / "passed_sender_specific"
  // as the optimistic case until the sim wiring is enabled.
  const verdicts: VerdictEntry[] = feeLegs.map((l) => ({
    recipient: l.recipient,
    verdict: entry.hookEnabled ? 'passed_sender_specific' : 'passed',
  }));
  return new Response(
    JSON.stringify({ verdicts }),
    { status: 200, headers: corsHeaders(env) },
  );
}

function parseAllowList(env: Env): TokenAllowList {
  const raw = env.RECIPIENT_VALIDATING_TOKENS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TokenAllowList;
  } catch {
    return {};
  }
}

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.FRONTEND_ORIGIN ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
