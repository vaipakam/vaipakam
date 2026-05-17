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
  /**
   * Set ONLY by a call site previewing calldata that carries a
   * PLACEHOLDER signature it hasn't generated yet — the OfferBook
   * accept-with-permit path encodes a zeroed Permit2 signature so
   * the preflight sees the real Diamond entry point. On such a
   * preview a signature-verification revert is an artefact, not a
   * real failure, so it is downgraded to `unavailable` instead of
   * `revert`. Unset everywhere else — a genuine permit / signature
   * revert then surfaces normally as `would revert`. (PR #41 review.)
   */
  allowSignatureRevert?: boolean;
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
    // Bump the request id FIRST — before any early return — so a
    // chain switch or cleared input invalidates an `eth_call` still
    // in flight from a previous render; otherwise it could resolve
    // later and overwrite the guard's verdict with a stale
    // ok/revert. (PR #41 Codex review.)
    const myReq = ++reqIdRef.current;
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
      setResult(classifyError(err, input.allowSignatureRevert ?? false));
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
 * A clean on-chain revert with a readable reason → `revert`. An
 * RPC / network failure → `unavailable` (no verdict).
 *
 * `allowSignatureRevert` (set only by a placeholder-signature
 * preview — see `TxSimInput`) gates the one artefact case: a
 * signature-verification revert. When it is `true` such a revert is
 * the expected consequence of the zeroed Permit2 signature and is
 * downgraded to `unavailable`. When `false` — every other call site
 * — a permit / signature revert is a GENUINE failure and surfaces
 * as `revert`, so real doomed transactions are never masked.
 * (PR #41 Codex review — the gate was previously a blanket regex.)
 */
function classifyError(
  err: unknown,
  allowSignatureRevert: boolean,
): SimResult {
  const msg = err instanceof BaseError ? err.shortMessage : String(err);
  if (!/revert/i.test(msg)) {
    // Network / RPC / timeout — no verdict.
    return { status: 'unavailable' };
  }
  if (
    allowSignatureRevert &&
    /permit|signature|ecdsa|invalidsigner/i.test(msg)
  ) {
    return { status: 'unavailable' };
  }
  return { status: 'revert', revertReason: msg };
}
