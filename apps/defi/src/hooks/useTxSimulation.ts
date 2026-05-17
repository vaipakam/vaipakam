import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useWallet } from '../context/WalletContext';

/**
 * ET-001 — client-side transaction-scan preview, GoPlus-backed.
 *
 * Before the user clicks Confirm in the wallet, the review modal
 * passes the pending tx's `{ to, data, value }`; this hook posts it
 * to the operator's Cloudflare Worker proxy at
 * `${VITE_AGENT_ORIGIN}/scan/tx`. The worker exchanges the GoPlus
 * App Key + App Secret for an access token server-side and calls
 * GoPlus `abi/input_decode`; the browser never sees a credential.
 *
 * Replaces the Phase-8b Blockaid integration. GoPlus is a *risk-data*
 * API, not a balance-diff simulator — so the result is a decoded
 * call (method, parameters) plus risk flags (malicious target
 * contract / malicious address parameters / risky signature), NOT a
 * predicted asset diff. The hook name is kept for call-site
 * stability; the shape it returns is GoPlus-native (`ScanResult`).
 *
 * Fails soft on proxy outage, the operator kill switch
 * (`TX_SCAN_ENABLED=false` → 503 `scan-disabled`), missing GoPlus
 * creds (503 `scan-not-configured`), an unsupported chain, a GoPlus
 * upstream error (502) or a network hiccup: the preview is advisory
 * and MUST NOT block the tx. The state stays `{ status:
 * 'unavailable' }` and the UI renders a subdued footer.
 */

const AGENT_ORIGIN = (import.meta.env.VITE_AGENT_ORIGIN as
  | string
  | undefined) ?? '';

/** Overall scan verdict (mirrors the worker's `TxScanVerdict`). */
export type ScanVerdict = 'safe' | 'warning' | 'danger';

/** Address-typed parameter enrichment from GoPlus. */
export interface ScanAddress {
  address: string;
  isContract: boolean;
  malicious: boolean;
  contractName: string | null;
  standard: string | null; // "erc20" | "erc721" | ...
  symbol: string | null;
}

/** One decoded call parameter. */
export interface ScanParam {
  name: string;
  type: string;
  value: string | null;
  address: ScanAddress | null;
}

/** Hook result — GoPlus-native scan shape + a fetch status. */
export interface ScanResult {
  status: 'ready' | 'loading' | 'unavailable' | 'error';
  verdict?: ScanVerdict;
  method?: string | null;
  contractName?: string | null;
  contractDescription?: string | null;
  maliciousContract?: boolean;
  riskySignature?: boolean;
  risk?: string | null;
  signatureDetail?: string | null;
  params?: ScanParam[];
  warnings?: string[];
  errorMessage?: string;
}

export interface TxSimInput {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** Debounced scan — rapid successive updates (e.g. slider-driven
 *  what-ifs) trigger only the last call. Stale responses are dropped. */
export function useTxSimulation(input: TxSimInput | null, debounceMs = 400) {
  const { address, chainId } = useWallet();
  const [result, setResult] = useState<ScanResult>({ status: 'ready' });
  const reqIdRef = useRef(0);

  const simulate = useCallback(async () => {
    if (!input || !address || !chainId) {
      setResult({ status: 'ready' });
      return;
    }
    if (!AGENT_ORIGIN) {
      // No worker origin configured — the proxy isn't reachable from
      // this build. Mark unavailable so the UI renders a subdued
      // footer instead of a missing preview.
      setResult({ status: 'unavailable' });
      return;
    }
    const myReq = ++reqIdRef.current;
    setResult({ status: 'loading' });
    try {
      const res = await _callScanProxy({
        chainId,
        from: address as Address,
        ...input,
      });
      if (myReq !== reqIdRef.current) return;
      setResult({ status: 'ready', ...res });
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      const msg = err instanceof Error ? err.message : 'preview failed';
      // The scan is advisory and must fail soft: anything that means
      // "the scanner couldn't give us a verdict" — kill switch,
      // missing creds, unsupported chain, GoPlus upstream error,
      // rate-limit, network hiccup, a malformed response — downgrades
      // to 'unavailable' (a subdued footer). The worker returns those
      // as a non-2xx status, surfaced here as a `proxy `/`network`
      // message. Only a genuinely unrecognised thrown error becomes a
      // hard 'error'.
      const failSoft = msg.startsWith('network') || msg.startsWith('proxy ');
      if (failSoft) {
        setResult({ status: 'unavailable' });
        return;
      }
      setResult({ status: 'error', errorMessage: msg });
    }
  }, [address, chainId, input]);

  useEffect(() => {
    const t = setTimeout(() => {
      void simulate();
    }, debounceMs);
    return () => clearTimeout(t);
  }, [simulate, debounceMs]);

  return { result, refresh: simulate };
}

interface ProxyRequest {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

/** The worker's normalized `/scan/tx` response (see scanProxy.ts). */
interface TxScanResponse {
  verdict?: string;
  method?: string | null;
  contractName?: string | null;
  contractDescription?: string | null;
  maliciousContract?: boolean;
  riskySignature?: boolean;
  risk?: string | null;
  signatureDetail?: string | null;
  params?: ScanParam[];
  warnings?: string[];
}

async function _callScanProxy(
  req: ProxyRequest,
): Promise<Omit<ScanResult, 'status'>> {
  const url = `${AGENT_ORIGIN.replace(/\/$/, '')}/scan/tx`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId: req.chainId,
        from: req.from,
        to: req.to,
        data: req.data,
        value: req.value ? '0x' + req.value.toString(16) : '0x0',
      }),
    });
  } catch {
    throw new Error('network');
  }
  if (!res.ok) {
    // Every non-2xx — 503 (disabled / not-configured / chain
    // unsupported), 502 (GoPlus upstream error), 429 (rate-limited),
    // 400 (bad payload) — means "no verdict". The `proxy ` prefix
    // routes it through the fail-soft branch in `useTxSimulation`.
    throw new Error(`proxy ${res.status}`);
  }
  const json = (await res.json()) as TxScanResponse;

  // An unknown / missing `verdict` is a worker schema drift or a
  // partial response — we don't have a verdict, so surface as
  // preview-unavailable rather than rendering a card the user may
  // misread. The `proxy ` prefix triggers the fail-soft downgrade.
  const v = json.verdict;
  if (v !== 'safe' && v !== 'warning' && v !== 'danger') {
    throw new Error('proxy malformed');
  }

  return {
    verdict: v,
    method: json.method ?? null,
    contractName: json.contractName ?? null,
    contractDescription: json.contractDescription ?? null,
    maliciousContract: json.maliciousContract ?? false,
    riskySignature: json.riskySignature ?? false,
    risk: json.risk ?? null,
    signatureDetail: json.signatureDetail ?? null,
    params: json.params ?? [],
    warnings: json.warnings ?? [],
  };
}
