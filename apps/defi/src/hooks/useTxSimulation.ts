import { useCallback, useEffect, useRef, useState } from 'react';
import { BaseError, type Address, type Hex } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useDiamondPublicClient } from '../contracts/useDiamond';

/**
 * ET-001 — client-side pre-sign transaction preflight.
 *
 * Before the user clicks Confirm in the wallet, the review modal
 * passes the pending tx's `{ to, data, value }`; this hook runs it
 * as a viem **`eth_call`** against the chain's own RPC — a free,
 * read-only simulation that executes the exact calldata and reports
 * whether it would succeed or revert. Nothing is broadcast.
 *
 * History: this surface was Blockaid, then briefly a GoPlus proxy.
 * Both were dropped — see PR #41. A pre-sign scan of a transaction
 * against Vaipakam's *own audited Diamond* is a comprehension /
 * correctness aid (catch a doomed tx before gas, let the user
 * sanity-check), not a threat shield. A free `eth_call` delivers
 * exactly that, on **every chain** Vaipakam runs (all testnets +
 * mainnets) — unlike GoPlus's Transaction Simulation API, which is
 * mainnet-only (3 chains) and could not serve the testnet phase.
 * Third-party-asset risk (honeypot collateral, scam counterparty)
 * is a separate surface — the GoPlus contextual checks, ET-012/14/
 * 15/16.
 *
 * Advisory only: it MUST NOT block the transaction. On an RPC
 * hiccup, or an artefact revert (e.g. a not-yet-valid Permit2
 * signature on the accept-with-permit path), it degrades to a
 * subdued "preview unavailable" footer.
 */

export interface TxSimInput {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface SimResult {
  /**
   * - `idle`        — no tx to preview yet
   * - `loading`     — simulation in flight
   * - `ok`          — `eth_call` succeeded; the tx will not revert
   * - `revert`      — the tx would revert (`revertReason` set)
   * - `unavailable` — no verdict (RPC down, or a preview artefact)
   */
  status: 'idle' | 'loading' | 'ok' | 'revert' | 'unavailable';
  revertReason?: string;
}

/** Debounced preflight — rapid input changes (slider/form edits)
 *  trigger only the last call; stale responses are dropped. */
export function useTxSimulation(input: TxSimInput | null, debounceMs = 400) {
  const { address, isCorrectChain } = useWallet();
  const publicClient = useDiamondPublicClient();
  const [result, setResult] = useState<SimResult>({ status: 'idle' });
  const reqIdRef = useRef(0);

  const simulate = useCallback(async () => {
    if (!input || !address || !publicClient) {
      setResult({ status: 'idle' });
      return;
    }
    // The read client (`useDiamondPublicClient`) follows the wallet's
    // chain only while that chain is supported; on an unsupported
    // chain it falls back to DEFAULT_CHAIN. Simulating there would
    // run the `eth_call` on a DIFFERENT network than the one the
    // user will sign on — a misleading verdict. Surface that as
    // "unavailable" instead. (PR #41 Codex review.)
    if (!isCorrectChain) {
      setResult({ status: 'unavailable' });
      return;
    }
    const myReq = ++reqIdRef.current;
    setResult({ status: 'loading' });
    try {
      // viem `call` === `eth_call`: executes the calldata from the
      // user's address against current state, returns on success,
      // throws on revert. The read client is bound to the wallet's
      // active chain (guarded above via `isCorrectChain`).
      await publicClient.call({
        account: address as Address,
        to: input.to,
        data: input.data,
        value: input.value,
      });
      if (myReq !== reqIdRef.current) return;
      setResult({ status: 'ok' });
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      setResult(classifyError(err));
    }
  }, [address, isCorrectChain, publicClient, input]);

  useEffect(() => {
    const t = setTimeout(() => {
      void simulate();
    }, debounceMs);
    return () => clearTimeout(t);
  }, [simulate, debounceMs]);

  return { result, refresh: simulate };
}

/**
 * Map a thrown `eth_call` error to a `SimResult`.
 *
 * A clean on-chain revert with a readable reason → `revert`.
 * Everything else — an RPC/network failure, OR a revert that is an
 * artefact of previewing a not-yet-signed tx (a placeholder Permit2
 * signature on the accept-with-permit path) — → `unavailable`, so
 * the preview never raises a false alarm and never blocks.
 */
function classifyError(err: unknown): SimResult {
  const msg = err instanceof BaseError ? err.shortMessage : String(err);
  if (!/revert/i.test(msg)) {
    // Network / RPC / timeout — no verdict.
    return { status: 'unavailable' };
  }
  // Signature-verification reverts are expected when previewing the
  // Permit2 single-sig accept path with a placeholder signature —
  // not a real problem with the user's intended transaction.
  if (/permit|signature|ecdsa|invalidsigner/i.test(msg)) {
    return { status: 'unavailable' };
  }
  return { status: 'revert', revertReason: msg };
}
