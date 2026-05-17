/**
 * ET-001 — GoPlus Security API client for the agent Worker's
 * transaction-scan proxy (`scanProxy.ts`).
 *
 * Replaces the Blockaid Transaction Scanner. GoPlus is a token /
 * address / calldata *risk-data* API — not a balance-diff simulator
 * — so the scan surface it backs decodes the pending calldata and
 * flags malicious contracts / addresses rather than predicting
 * asset movements (see `docs/DesignsAndPlans/SecretsStoreMigration.md`
 * §3 note and ET-001 #32).
 *
 * Auth — GoPlus is not a single static key. The operator holds an
 * **App Key** + **App Secret** (both Cloudflare Secrets Store
 * bindings, T-078). They are exchanged for a short-lived **access
 * token**:
 *
 *   POST /api/v1/token   { app_key, time, sign }
 *   sign = sha1(app_key + time + app_secret)      // time = unix seconds
 *
 * The access token (`expires_in` seconds, ~1 h) is sent as the
 * `Authorization` header on every data call. This module caches it
 * in isolate-scoped memory and refreshes shortly before expiry, so
 * a burst of `/scan/tx` requests costs one `/token` call per ~hour
 * per warm isolate rather than one per scan.
 *
 * The CU-metered GoPlus quota is the operator's; this client only
 * spends one `abi/input_decode` call per scan (the token-security /
 * NFT / address-risk endpoints are deliberately out of ET-001's
 * "scanner swap" scope — see the follow-up cards).
 */

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';

/** Refresh the access token this many seconds before it expires. */
const TOKEN_REFRESH_SKEW_SEC = 120;

/** One decoded address-typed parameter (GoPlus `AbiAddressInfo`). */
export interface GoPlusAddressInfo {
  contract_name?: string;
  is_contract?: number; // 0 | 1
  malicious_address?: number; // 0 | 1
  name?: string;
  standard?: string; // "erc20" | "erc721" | ...
  symbol?: string;
}

/** One decoded call parameter (GoPlus `AbiParamInfo`). */
export interface GoPlusParamInfo {
  name?: string;
  type?: string;
  input?: unknown;
  address_info?: GoPlusAddressInfo;
}

/** The decoded-calldata payload (GoPlus `ParseAbiDataResponse`). */
export interface GoPlusDecodeResult {
  method?: string;
  contract_name?: string;
  contract_description?: string;
  malicious_contract?: number; // 0 | 1
  risk?: string;
  risky_signature?: number; // 0 | 1
  signature_detail?: string;
  params?: GoPlusParamInfo[];
}

/** Raised when GoPlus is unreachable or answers with an error code. */
export class GoPlusError extends Error {
  constructor(
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'GoPlusError';
  }
}

// ─── Access-token cache ────────────────────────────────────────────────

interface CachedToken {
  token: string;
  /** epoch seconds after which the token must be refreshed */
  refreshAfter: number;
}

/**
 * Isolate-scoped token cache. Cloudflare reuses a Worker isolate
 * across many requests, so this survives between `/scan/tx` calls;
 * a cold isolate simply re-mints on first use.
 */
let cachedToken: CachedToken | null = null;

/**
 * In-flight `/token` request, deduped so a burst of scans on a cold
 * isolate triggers exactly one token mint rather than one per scan.
 */
let tokenInFlight: Promise<string> | null = null;

/** SHA-1 hex digest — GoPlus's signature scheme for `/token`. */
async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Mint a fresh GoPlus access token from the App Key + App Secret. */
async function mintAccessToken(
  appKey: string,
  appSecret: string,
): Promise<string> {
  const time = Math.floor(Date.now() / 1000);
  const sign = await sha1Hex(`${appKey}${time}${appSecret}`);

  let res: Response;
  try {
    res = await fetch(`${GOPLUS_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: appKey, time, sign }),
    });
  } catch (err) {
    throw new GoPlusError(`token request failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new GoPlusError(`token request HTTP ${res.status}`, res.status);
  }

  let body: {
    code?: number;
    message?: string;
    result?: { access_token?: string; expires_in?: number };
  };
  try {
    body = await res.json();
  } catch {
    throw new GoPlusError('token response was not JSON');
  }
  const token = body.result?.access_token;
  if (body.code !== 1 || !token) {
    throw new GoPlusError(
      `token rejected: code=${body.code ?? '?'} ${body.message ?? ''}`.trim(),
    );
  }

  // `expires_in` is seconds; default to 1 h if GoPlus omits it.
  const ttl = body.result?.expires_in ?? 3600;
  cachedToken = {
    token,
    refreshAfter: Math.floor(Date.now() / 1000) + ttl - TOKEN_REFRESH_SKEW_SEC,
  };
  return token;
}

/** Return a valid access token, minting / refreshing as needed. */
async function getAccessToken(
  appKey: string,
  appSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedToken.refreshAfter) {
    return cachedToken.token;
  }
  // Dedupe concurrent mints on a cold / just-expired isolate.
  if (!tokenInFlight) {
    tokenInFlight = mintAccessToken(appKey, appSecret).finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

// ─── Calldata decode ───────────────────────────────────────────────────

export interface DecodeInputArgs {
  /** EVM chain id (numeric); GoPlus expects it as a string. */
  chainId: number;
  /** Transaction target — typically the Diamond. */
  to: string;
  /** The simulating EOA. */
  from: string;
  /** Hex-prefixed calldata. */
  data: string;
}

/**
 * Decode + risk-scan a pending transaction's calldata via GoPlus
 * `POST /api/v1/abi/input_decode`. Returns the raw
 * `ParseAbiDataResponse`; `scanProxy.ts` normalizes it into the
 * worker → frontend `TxScanResponse` shape.
 *
 * Throws `GoPlusError` on transport failure or a non-success GoPlus
 * code so the caller can fail soft (the frontend shows
 * "preview unavailable" rather than a misleading verdict).
 */
export async function decodeInput(
  appKey: string,
  appSecret: string,
  args: DecodeInputArgs,
): Promise<GoPlusDecodeResult> {
  const token = await getAccessToken(appKey, appSecret);

  let res: Response;
  try {
    res = await fetch(`${GOPLUS_BASE}/abi/input_decode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // GoPlus expects the bare access token in `Authorization`
        // (no "Bearer" prefix).
        Authorization: token,
      },
      body: JSON.stringify({
        chain_id: String(args.chainId),
        contract_address: args.to,
        signer: args.from,
        data: args.data,
      }),
    });
  } catch (err) {
    throw new GoPlusError(`input_decode request failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new GoPlusError(`input_decode HTTP ${res.status}`, res.status);
  }

  let body: { code?: number; message?: string; result?: GoPlusDecodeResult };
  try {
    body = await res.json();
  } catch {
    throw new GoPlusError('input_decode response was not JSON');
  }
  // code 1 = success. Any other code (incl. an expired-token 4xx
  // surfaced as a body code) is a soft failure for the caller.
  if (body.code !== 1 || !body.result) {
    // An auth failure here most likely means a stale cached token;
    // drop it so the next scan re-mints.
    cachedToken = null;
    throw new GoPlusError(
      `input_decode rejected: code=${body.code ?? '?'} ${
        body.message ?? ''
      }`.trim(),
    );
  }
  return body.result;
}

/** Test seam — clear the isolate-scoped token cache. */
export function __resetTokenCacheForTest(): void {
  cachedToken = null;
  tokenInFlight = null;
}
