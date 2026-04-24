import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useWallet } from '../context/WalletContext';

/**
 * Phase 8b.2 — client-side transaction simulation preview via Blockaid.
 *
 * Before the user clicks Confirm in the wallet, call `simulate()` with
 * the pending tx's `{ to, data, value }`. Blockaid returns a
 * classification (benign / warning / malicious) plus a structured
 * `stateChanges` diff describing what the tx will move. Render the
 * result inline in the review modal so the user sees the outcome
 * before signing — closes the "blind signing" UX gap that MetaMask's
 * Security Alerts, Rabby's transaction previews, and Coinbase Wallet's
 * Blockaid integration all address.
 *
 * Fails silently on API outage or network hiccup: the preview is
 * advisory and MUST NOT block the tx. The hook's state simply stays
 * `{ status: 'unavailable' }` and the UI renders a subdued "preview
 * unavailable" footer instead of a full preview card.
 *
 * TODO(ops): once the Blockaid API key is provisioned (see
 * `VITE_BLOCKAID_API_KEY`), the free-tier Transaction Scanner endpoint
 * at `https://api.blockaid.io/v0/evm/transaction/scan` returns the
 * structured payload this hook consumes. The stub below is shaped
 * correctly so the drop-in is a one-line change to `_callBlockaid`.
 */

const BLOCKAID_ENDPOINT = 'https://api.blockaid.io/v0/evm/transaction/scan';

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

const apiKey = (import.meta.env.VITE_BLOCKAID_API_KEY as string | undefined) ?? '';

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
    if (!apiKey) {
      // No Blockaid API key configured — mark unavailable so the UI
      // renders a subdued footer instead of a missing preview.
      setResult({ status: 'unavailable' });
      return;
    }
    const myReq = ++reqIdRef.current;
    setResult({ status: 'loading' });
    try {
      const res = await _callBlockaid(
        { chainId, from: address as Address, ...input },
        apiKey,
      );
      if (myReq !== reqIdRef.current) return;
      setResult({ status: 'ready', ...res });
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      setResult({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'preview failed',
      });
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

interface BlockaidRequest {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

async function _callBlockaid(
  req: BlockaidRequest,
  key: string,
): Promise<Omit<SimResult, 'status'>> {
  // Blockaid's Transaction Scanner endpoint — docs:
  // https://docs.blockaid.io/reference/evm-transaction-scan
  const body = {
    chain: _blockaidChainName(req.chainId),
    account_address: req.from,
    data: {
      from: req.from,
      to: req.to,
      data: req.data,
      value: req.value ? '0x' + req.value.toString(16) : '0x0',
    },
    metadata: { domain: 'app.vaipakam.com' },
    options: ['simulation', 'validation'],
  };
  const res = await fetch(BLOCKAID_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Blockaid ${res.status}`);
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

function _blockaidChainName(chainId: number): string {
  switch (chainId) {
    case 1:
      return 'ethereum';
    case 8453:
      return 'base';
    case 42161:
      return 'arbitrum';
    case 10:
      return 'optimism';
    case 56:
      return 'bsc';
    case 137:
      return 'polygon';
    case 11155111:
      return 'sepolia';
    case 84532:
      return 'base-sepolia';
    default:
      return 'ethereum';
  }
}
