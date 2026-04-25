import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useWallet } from '../context/WalletContext';

/**
 * Phase 8b.2 — client-side transaction simulation preview via Blockaid.
 *
 * Before the user clicks Confirm in the wallet, call `simulate()` with
 * the pending tx's `{ to, data, value }`. The hook posts to the
 * operator's Cloudflare Worker proxy at `${VITE_HF_WATCHER_ORIGIN}/scan/blockaid`,
 * which injects the Blockaid API key server-side and pass-throughs the
 * scanner JSON. The browser never sees the API key, satisfying the
 * docs' "API keys for transaction scanning and swap quotes must stay
 * server-side" rule (`docs/WebsiteReadme.md`).
 *
 * Blockaid returns a classification (benign / warning / malicious) plus
 * a structured `stateChanges` diff describing what the tx will move.
 * Render the result inline in the review modal so the user sees the
 * outcome before signing — closes the "blind signing" UX gap that
 * MetaMask's Security Alerts, Rabby's transaction previews, and
 * Coinbase Wallet's Blockaid integration all address.
 *
 * Fails silently on proxy outage, missing key (the worker returns 503
 * `blockaid-not-configured`), or network hiccup: the preview is
 * advisory and MUST NOT block the tx. The hook's state simply stays
 * `{ status: 'unavailable' }` and the UI renders a subdued
 * "preview unavailable" footer instead of a full preview card.
 */

const HF_WATCHER_ORIGIN = (import.meta.env.VITE_HF_WATCHER_ORIGIN as
  | string
  | undefined) ?? '';

export interface StateChange {
  kind: 'transfer-in' | 'transfer-out' | 'approval' | 'nft-in' | 'nft-out' | 'other';
  asset?: Address;
  amount?: bigint;
  tokenId?: bigint;
  description: string;
}

export type SimClassification = 'benign' | 'warning' | 'malicious';

export interface SimResult {
  status: 'ready' | 'loading' | 'unavailable' | 'error';
  classification?: SimClassification;
  stateChanges?: StateChange[];
  warnings?: string[];
  errorMessage?: string;
}

export interface TxSimInput {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** Debounced simulation — rapid successive updates (e.g. slider-driven
 *  what-ifs) trigger only the last call. Stale responses are dropped. */
export function useTxSimulation(input: TxSimInput | null, debounceMs = 400) {
  const { address, chainId } = useWallet();
  const [result, setResult] = useState<SimResult>({ status: 'ready' });
  const reqIdRef = useRef(0);

  const simulate = useCallback(async () => {
    if (!input || !address || !chainId) {
      setResult({ status: 'ready' });
      return;
    }
    if (!HF_WATCHER_ORIGIN) {
      // No worker origin configured — the proxy isn't reachable from
      // this build. Mark unavailable so the UI renders a subdued
      // footer instead of a missing preview.
      setResult({ status: 'unavailable' });
      return;
    }
    const myReq = ++reqIdRef.current;
    setResult({ status: 'loading' });
    try {
      const res = await _callBlockaidProxy({
        chainId,
        from: address as Address,
        ...input,
      });
      if (myReq !== reqIdRef.current) return;
      setResult({ status: 'ready', ...res });
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      const msg = err instanceof Error ? err.message : 'preview failed';
      // Per the docs (`docs/WebsiteReadme.md`): "Blockaid unavailability
      // must fail soft: it may collapse to a subtle preview-unavailable
      // state, but it must not block the on-chain transaction path by
      // itself." Anything that means "the scanner couldn't give us an
      // answer" — missing key, network hiccup, rate-limit, upstream
      // outage, etc. — downgrades to 'unavailable'. Only programmer
      // bugs (a thrown synchronous exception we genuinely don't
      // recognise) surface as a hard error.
      const failSoft =
        msg === 'blockaid-not-configured' ||
        msg.startsWith('network') ||
        msg.startsWith('proxy ');
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

async function _callBlockaidProxy(
  req: ProxyRequest,
): Promise<Omit<SimResult, 'status'>> {
  const url = `${HF_WATCHER_ORIGIN.replace(/\/$/, '')}/scan/blockaid`;
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
  if (res.status === 503) {
    // Worker says the operator hasn't provisioned the Blockaid key
    // yet (or `BLOCKAID_API_KEY` is empty). Treat as a quiet no-op.
    throw new Error('blockaid-not-configured');
  }
  if (!res.ok) {
    throw new Error(`proxy ${res.status}`);
  }
  const json = (await res.json()) as BlockaidResponse;

  return {
    classification: _mapClassification(json.validation?.result_type),
    stateChanges: _mapStateChanges(json.simulation),
    warnings: json.validation?.features?.map((f) => f.description) ?? [],
  };
}

interface BlockaidResponse {
  validation?: {
    result_type?: string;
    features?: Array<{ description: string }>;
  };
  simulation?: {
    assets_diffs?: Record<
      string,
      Array<{
        asset: { type: string; address?: string };
        in?: Array<{ value?: string; raw_value?: string; token_id?: string }>;
        out?: Array<{ value?: string; raw_value?: string; token_id?: string }>;
      }>
    >;
  };
}

function _mapClassification(rt: string | undefined): SimClassification {
  switch (rt) {
    case 'Benign':
      return 'benign';
    case 'Warning':
      return 'warning';
    case 'Malicious':
      return 'malicious';
    default:
      return 'benign';
  }
}

function _mapStateChanges(sim: BlockaidResponse['simulation']): StateChange[] {
  if (!sim?.assets_diffs) return [];
  const out: StateChange[] = [];
  for (const [, diffs] of Object.entries(sim.assets_diffs)) {
    for (const diff of diffs) {
      const asset = diff.asset.address as Address | undefined;
      for (const inEntry of diff.in ?? []) {
        out.push({
          kind: diff.asset.type === 'ERC20' ? 'transfer-in' : 'nft-in',
          asset,
          amount: inEntry.raw_value ? BigInt(inEntry.raw_value) : undefined,
          tokenId: inEntry.token_id ? BigInt(inEntry.token_id) : undefined,
          description: `Receive ${inEntry.value ?? inEntry.raw_value ?? '?'} from ${asset ?? 'unknown'}`,
        });
      }
      for (const outEntry of diff.out ?? []) {
        out.push({
          kind: diff.asset.type === 'ERC20' ? 'transfer-out' : 'nft-out',
          asset,
          amount: outEntry.raw_value ? BigInt(outEntry.raw_value) : undefined,
          tokenId: outEntry.token_id ? BigInt(outEntry.token_id) : undefined,
          description: `Send ${outEntry.value ?? outEntry.raw_value ?? '?'} of ${asset ?? 'unknown'}`,
        });
      }
    }
  }
  return out;
}
