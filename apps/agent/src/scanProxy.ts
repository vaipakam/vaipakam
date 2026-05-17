/**
 * ET-001 — server-side transaction-scan proxy, GoPlus-backed.
 *
 * One HTTP entry point:
 *   POST /scan/tx    — decode + risk-scan a pending transaction's
 *                      calldata via GoPlus `abi/input_decode`.
 *
 * Replaces the Phase-8b Blockaid Transaction Scanner proxy
 * (`/scan/blockaid`). The operator's GoPlus App Key + App Secret are
 * Cloudflare Secrets Store bindings (T-078) injected server-side by
 * `goPlusClient.ts`; the frontend's `useTxSimulation` hook calls
 * this route and never sees a credential. The frontend origin gate
 * (`isAllowedOrigin` in index.ts) restricts callers to the
 * operator's vaipakam.com origins, and a per-IP rate-limit binding
 * caps abuse.
 *
 * GoPlus is a *risk-data* API, not a balance-diff simulator: instead
 * of predicting asset movements it decodes the calldata and flags a
 * malicious target contract / malicious address parameters / a risky
 * function signature. The response is therefore a GoPlus-native
 * shape (decoded call + per-parameter address risk), NOT Blockaid's
 * `assets_diffs`.
 *
 * Request body:
 *   {
 *     chainId: number;   // EVM chain id, e.g. 8453 (Base)
 *     from:    string;   // the simulating EOA
 *     to:      string;   // tx target (typically the Diamond)
 *     data:    string;   // calldata, hex-prefixed
 *     value?:  string;   // accepted for request compatibility; unused
 *                        // (GoPlus input_decode scans calldata only)
 *   }
 *
 * Response: the normalized `TxScanResponse` JSON below.
 *
 * Failure modes (the frontend hook fails soft on each — see
 * `useTxSimulation`):
 *   - scan disabled (kill switch) → 503 `scan-disabled`
 *   - GoPlus creds missing        → 503 `scan-not-configured`
 *   - rate-limited                → 429 `rate-limited`
 *   - bad payload                 → 400 `invalid-payload`
 *   - unsupported chain           → 503 `chain-unsupported`
 *   - GoPlus upstream failure     → 502 `scan-upstream-error`
 */

import type { Env } from './env';
import {
  decodeInput,
  GoPlusError,
  type GoPlusDecodeResult,
  type GoPlusParamInfo,
} from './goPlusClient';

interface ScanRequest {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value?: string;
}

/** Overall scan verdict, derived from the GoPlus decode result. */
export type TxScanVerdict = 'safe' | 'warning' | 'danger';

/** Address-typed parameter enrichment (from GoPlus `AbiAddressInfo`). */
export interface TxScanAddress {
  address: string;
  isContract: boolean;
  malicious: boolean;
  contractName: string | null;
  standard: string | null; // "erc20" | "erc721" | ...
  symbol: string | null;
}

/** One decoded call parameter. */
export interface TxScanParam {
  name: string;
  type: string;
  /** Stringified decoded input value (capped). */
  value: string | null;
  /** Set when the parameter is an address GoPlus could enrich. */
  address: TxScanAddress | null;
}

/** Normalized worker → frontend scan result. */
export interface TxScanResponse {
  verdict: TxScanVerdict;
  method: string | null;
  contractName: string | null;
  contractDescription: string | null;
  maliciousContract: boolean;
  riskySignature: boolean;
  /** GoPlus free-text risk note, if any. */
  risk: string | null;
  signatureDetail: string | null;
  params: TxScanParam[];
  /** Human-readable risk lines for the preview card. */
  warnings: string[];
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOB = /^0x[0-9a-fA-F]*$/;

/**
 * EVM chain ids Vaipakam operates on. Mirrors the old Blockaid
 * allow-list — refuse an unmapped chain explicitly (503
 * `chain-unsupported`) rather than scan calldata against a chain
 * GoPlus may interpret differently. GoPlus keys its API by the
 * numeric chain id directly, so no name mapping is needed.
 */
const SUPPORTED_CHAINS = new Set<number>([
  1, // Ethereum
  8453, // Base
  42161, // Arbitrum
  10, // Optimism
  56, // BNB Chain
  137, // Polygon
  1101, // Polygon zkEVM
  11155111, // Sepolia
  84532, // Base Sepolia
]);

export async function handleTxScan(req: Request, env: Env): Promise<Response> {
  // Resolve the allowed CORS origin per request (see the note on
  // `resolveAllowedOrigin`).
  const corsOrigin = resolveAllowedOrigin(req, env);

  // Operator kill switch (ET-001). `TX_SCAN_ENABLED` is a plain var;
  // an on-chain governance flag is a separate follow-up card. When
  // disabled, the frontend's fail-soft branch shows the documented
  // "preview unavailable" footer.
  if ((env.TX_SCAN_ENABLED ?? 'true').toLowerCase() === 'false') {
    return jsonErr(503, 'scan-disabled', corsOrigin);
  }

  if (!(await checkRateLimit(req, env.SCAN_TX_RATELIMIT))) {
    return jsonErr(429, 'rate-limited', corsOrigin);
  }

  const body = await parseBody(req);
  if (!body) return jsonErr(400, 'invalid-payload', corsOrigin);

  if (!env.GOPLUS_APP_KEY || !env.GOPLUS_APP_SECRET) {
    return jsonErr(503, 'scan-not-configured', corsOrigin);
  }

  // Refuse unsupported chains explicitly — never silently rescope to
  // a different chain (per the Phase-8b #00015 rationale).
  if (!SUPPORTED_CHAINS.has(body.chainId)) {
    return jsonErr(503, 'chain-unsupported', corsOrigin);
  }

  let decoded: GoPlusDecodeResult;
  try {
    decoded = await decodeInput(env.GOPLUS_APP_KEY, env.GOPLUS_APP_SECRET, {
      chainId: body.chainId,
      to: body.to,
      from: body.from,
      data: body.data,
    });
  } catch (err) {
    // Fail soft — the frontend downgrades a 502 to "preview
    // unavailable" rather than showing a misleading verdict.
    const detail = err instanceof GoPlusError ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[scan] GoPlus input_decode failed:', detail);
    return jsonErr(502, 'scan-upstream-error', corsOrigin);
  }

  return jsonOk(normalize(decoded), corsOrigin);
}

// ─── Normalization ─────────────────────────────────────────────────────

/** Cap a stringified parameter value so the response stays small. */
const VALUE_CAP = 200;

function stringifyInput(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  let s: string;
  if (typeof input === 'string') s = input;
  else if (typeof input === 'number' || typeof input === 'boolean') {
    s = String(input);
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      return null;
    }
  }
  return s.length > VALUE_CAP ? `${s.slice(0, VALUE_CAP)}…` : s;
}

function mapParam(p: GoPlusParamInfo): TxScanParam {
  const info = p.address_info;
  let address: TxScanAddress | null = null;
  // An address-typed parameter — enrich it whenever GoPlus returned
  // `address_info`. The address value itself is the decoded `input`.
  if (info && typeof p.input === 'string' && HEX_ADDR.test(p.input)) {
    address = {
      address: p.input,
      isContract: info.is_contract === 1,
      malicious: info.malicious_address === 1,
      contractName: info.contract_name || null,
      standard: info.standard || null,
      symbol: info.symbol || null,
    };
  }
  return {
    name: p.name ?? '',
    type: p.type ?? '',
    value: stringifyInput(p.input),
    address,
  };
}

/** Exported for unit tests — see test/scanProxy.test.ts. */
export function normalize(d: GoPlusDecodeResult): TxScanResponse {
  const params = (d.params ?? []).map(mapParam);
  const maliciousContract = d.malicious_contract === 1;
  const riskySignature = d.risky_signature === 1;
  const risk = d.risk && d.risk.trim() ? d.risk.trim() : null;
  const maliciousParams = params.filter((p) => p.address?.malicious);

  const warnings: string[] = [];
  if (maliciousContract) {
    warnings.push('GoPlus flagged the target contract as malicious.');
  }
  for (const p of maliciousParams) {
    warnings.push(
      `Parameter "${p.name}" points to an address GoPlus flagged as malicious.`,
    );
  }
  if (riskySignature) {
    warnings.push(
      d.signature_detail?.trim() ||
        'GoPlus flagged this function signature as risky.',
    );
  }
  if (risk) warnings.push(risk);

  let verdict: TxScanVerdict = 'safe';
  if (maliciousContract || maliciousParams.length > 0) verdict = 'danger';
  else if (riskySignature || risk) verdict = 'warning';

  return {
    verdict,
    method: d.method || null,
    contractName: d.contract_name || null,
    contractDescription: d.contract_description || null,
    maliciousContract,
    riskySignature,
    risk,
    signatureDetail: d.signature_detail || null,
    params,
    warnings,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function checkRateLimit(
  req: Request,
  binding:
    | { limit(input: { key: string }): Promise<{ success: boolean }> }
    | undefined,
): Promise<boolean> {
  if (!binding) return true;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const { success } = await binding.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

async function parseBody(req: Request): Promise<ScanRequest | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    o.chainId <= 0
  ) {
    return null;
  }
  if (typeof o.from !== 'string' || !HEX_ADDR.test(o.from)) return null;
  if (typeof o.to !== 'string' || !HEX_ADDR.test(o.to)) return null;
  if (typeof o.data !== 'string' || !HEX_BLOB.test(o.data)) return null;
  if (
    o.value !== undefined &&
    (typeof o.value !== 'string' || !HEX_BLOB.test(o.value))
  ) {
    return null;
  }
  return {
    chainId: o.chainId,
    from: o.from,
    to: o.to,
    data: o.data,
    value: typeof o.value === 'string' ? o.value : undefined,
  };
}

function jsonOk(body: TxScanResponse, corsOrigin: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function jsonErr(status: number, code: string, corsOrigin: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

/**
 * Echo the requesting `Origin` header back iff it is in the
 * comma-separated `FRONTEND_ORIGIN` allow-list. Returns the first
 * allow-list entry as a safe fallback when the request lacks an
 * Origin (non-browser callers) or the origin doesn't match — that
 * fallback keeps debug curl calls and same-origin worker tests
 * working without granting cross-origin access to unlisted callers.
 */
function resolveAllowedOrigin(req: Request, env: Env): string {
  const origin = req.headers.get('Origin') ?? '';
  const allow = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim());
  if (origin && allow.includes(origin)) {
    return origin;
  }
  return allow[0] ?? '*';
}
