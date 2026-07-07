/**
 * #1028 item 2 — client-side pre-sign transaction preflight, ported
 * from apps/defi's ET-001 hook.
 *
 * Before the wallet prompt, the review step passes the pending tx's
 * `{ to, data, value }`; this hook runs it as a viem `eth_call`
 * against the wallet's own chain — a free, read-only dry run of the
 * exact calldata. Nothing is broadcast.
 *
 * ADVISORY ONLY — it must never gate `canSign` or the submit path.
 * On an RPC hiccup or a preview artefact (placeholder signature,
 * not-yet-granted allowance) it degrades to a subdued "no verdict"
 * footer. The wallet-context plumbing is the only real difference
 * from the defi original: alpha02 uses `useActiveChain` + wagmi's
 * `usePublicClient` bound to the WALLET chain (never the read-chain
 * fallback — simulating on a different network than the one the
 * user will sign on is a misleading verdict, so an unsupported
 * wallet chain reports `unavailable`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BaseError,
  decodeErrorResult,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { usePublicClient } from 'wagmi';
import { friendlyContractError } from '@vaipakam/lib';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM } from './diamond';

export interface TxSimInput {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Set ONLY when the previewed calldata carries a PLACEHOLDER
   *  signature the flow hasn't generated yet (the accept path's
   *  EIP-712 AcceptTerms is signed at submit time) — a signature
   *  revert is then an artefact, downgraded to `unavailable`. Unset
   *  everywhere else so genuine signature reverts still surface. */
  allowSignatureRevert?: boolean;
  /** Set ONLY when the SUBMIT path provisions an ERC-20 allowance
   *  before broadcasting — at preview time the allowance is still
   *  zero, so that one revert is downgraded to the benign
   *  `approval-needed` verdict instead of crying wolf. */
  allowAllowanceRevert?: boolean;
  /** NFT sibling of the above: set ONLY when the submit path runs
   *  `setApprovalForAll` / NFT approval first (the rent LIST flow) —
   *  the missing-operator revert at preview time is then the benign
   *  `approval-needed` case, not a real failure. */
  allowNftApprovalRevert?: boolean;
}

export interface SimResult {
  /** idle: nothing to preview · loading: in flight · ok: would not
   *  revert · revert: would fail (reason set) · approval-needed: the
   *  only blocker is the allowance the submit grants first ·
   *  unavailable: no verdict (RPC down / preview artefact). */
  status: 'idle' | 'loading' | 'ok' | 'revert' | 'approval-needed' | 'unavailable';
  /** Friendly, user-facing reason (curated copy or a humanized error name). */
  revertReason?: string;
  /** Raw decoded error name (e.g. `MaxLendingAboveCeiling`) — kept alongside
   *  the friendly reason for the diagnostics / support report, never shown as
   *  the primary message. */
  revertName?: string;
}

/** Debounced preflight — rapid form edits trigger only the last
 *  call; stale responses are dropped via the request id. */
export function useTxSimulation(input: TxSimInput | null, debounceMs = 400) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  // Bound to the WALLET chain (undefined off-chain) — never the
  // read-chain fallback; see the header note.
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const [result, setResult] = useState<SimResult>({ status: 'idle' });
  const reqIdRef = useRef(0);

  const simulate = useCallback(async () => {
    // Bump the request id FIRST — before any early return — so a
    // chain switch or cleared input invalidates an `eth_call` still
    // in flight; otherwise it could resolve later and overwrite the
    // verdict with a stale one.
    const myReq = ++reqIdRef.current;
    if (!input || !address) {
      setResult({ status: 'idle' });
      return;
    }
    if (!onSupportedChain || !publicClient) {
      setResult({ status: 'unavailable' });
      return;
    }
    setResult({ status: 'loading' });
    try {
      // viem `call` === `eth_call`: executes the calldata from the
      // user's address against current state; throws on revert.
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
      setResult(
        classifyError(
          err,
          input.allowSignatureRevert ?? false,
          input.allowAllowanceRevert ?? false,
          input.allowNftApprovalRevert ?? false,
        ),
      );
    }
  }, [address, onSupportedChain, publicClient, input]);

  useEffect(() => {
    // Drop the previous verdict SYNCHRONOUSLY on any input change —
    // a stale "passed" must not sit under a changed receipt during
    // the debounce window (round 1). The bump also invalidates any
    // eth_call still in flight for the old input.
    reqIdRef.current++;
    setResult(input ? { status: 'loading' } : { status: 'idle' });
    const t = setTimeout(() => {
      void simulate();
    }, debounceMs);
    return () => clearTimeout(t);
  }, [input, simulate, debounceMs]);

  return { result, refresh: simulate };
}

/** Pull the RAW revert data out of a viem error, if any. `eth_call`
 *  through `publicClient.call` has no ABI, so a custom-error revert
 *  surfaces as "Execution reverted for an unknown reason" with the
 *  selector hex only in the cause chain — found live on Base
 *  Sepolia: the allowance artefact was NOT being downgraded because
 *  neither the short nor the full message carried the selector. */
function rawRevertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const cause = err.walk(
    (e) => typeof (e as { data?: unknown }).data !== 'undefined',
  ) as { data?: Hex | { data?: Hex } } | null;
  const d = cause?.data;
  if (typeof d === 'string' && d.startsWith('0x')) return d;
  if (d && typeof d === 'object' && typeof d.data === 'string') return d.data;
  return undefined;
}

/** Decode the revert into a readable name when the Diamond / ERC-20
 *  ABIs know it — "InsufficientAllowance" beats "Execution reverted
 *  for an unknown reason" in a user-facing footer. */
function decodeRevert(data: Hex | undefined): string | null {
  if (!data || data.length < 10) return null;
  for (const abi of [DIAMOND_ABI_VIEM, erc20Abi]) {
    try {
      const dec = decodeErrorResult({ abi, data });
      // The Solidity built-ins decode to their GENERIC names — for
      // Error(string)/Panic(uint256) viem's own message already
      // carries the actual reason text, which beats rendering the
      // bare word "Error" (round 1). Only a named custom error is
      // an improvement over the message.
      if (dec.errorName === 'Error' || dec.errorName === 'Panic') return null;
      return dec.errorName;
    } catch {
      // not in this ABI — try the next
    }
  }
  return null;
}

/** Map a thrown `eth_call` error to a verdict. Non-revert errors
 *  (network / RPC / timeout) yield no verdict; the artefact
 *  downgrades are strictly opt-in per call site so real failures
 *  are never masked. Matching runs against the RAW selector + the
 *  decoded error name + both message forms — the message-only
 *  matching of the first cut missed custom errors entirely. */
function classifyError(
  err: unknown,
  allowSignatureRevert: boolean,
  allowAllowanceRevert: boolean,
  allowNftApprovalRevert: boolean,
): SimResult {
  const msg = err instanceof BaseError ? err.shortMessage : String(err);
  const full = err instanceof BaseError ? err.message : String(err);
  if (!/revert/i.test(msg)) {
    return { status: 'unavailable' };
  }
  const data = rawRevertData(err);
  const decoded = decodeRevert(data);
  const selector = data?.slice(0, 10)?.toLowerCase() ?? '';
  const haystack = `${selector} ${decoded ?? ''} ${full}`;
  if (
    allowSignatureRevert &&
    /permit|signature|ecdsa|invalidsigner/i.test(`${decoded ?? ''} ${msg}`)
  ) {
    return { status: 'unavailable' };
  }
  // ERC20InsufficientAllowance (0xfb8f41b2) or legacy string variants.
  if (
    allowAllowanceRevert &&
    /0xfb8f41b2|insufficient\s*allowance|ERC20InsufficientAllowance/i.test(haystack)
  ) {
    return { status: 'approval-needed' };
  }
  // ERC721InsufficientApproval (0x177e802f) / ERC1155MissingApprovalForAll
  // (0xe237d922) or the legacy string variants — the rent LIST flow
  // approves the NFT operator at submit time.
  if (
    allowNftApprovalRevert &&
    /0x177e802f|0xe237d922|InsufficientApproval|MissingApprovalForAll|not (?:token )?owner (?:n?or|or) approved|caller is not .*approved/i.test(
      haystack,
    )
  ) {
    return { status: 'approval-needed' };
  }
  // Prefer friendly, user-facing copy for the revert. `friendlyContractError`
  // returns curated copy for the errors a normal user can hit, else a
  // humanized sentence from the decoded name (e.g. `MaxLendingAboveCeiling`
  // → "Max lending above ceiling"); fall back to the decoded name, then the
  // raw short message. The raw name rides along in `revertName` for the
  // diagnostics/support report.
  const friendly = friendlyContractError({
    name: decoded ?? undefined,
    selector: selector || undefined,
  });
  return {
    status: 'revert',
    revertReason: friendly ?? decoded ?? msg,
    revertName: decoded ?? undefined,
  };
}
