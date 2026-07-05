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
import { BaseError, type Address, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';

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
  revertReason?: string;
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
    const t = setTimeout(() => {
      void simulate();
    }, debounceMs);
    return () => clearTimeout(t);
  }, [simulate, debounceMs]);

  return { result, refresh: simulate };
}

/** Map a thrown `eth_call` error to a verdict. Non-revert errors
 *  (network / RPC / timeout) yield no verdict; the two artefact
 *  downgrades are strictly opt-in per call site so real failures
 *  are never masked (same gates as the defi original). */
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
  if (allowSignatureRevert && /permit|signature|ecdsa|invalidsigner/i.test(msg)) {
    return { status: 'unavailable' };
  }
  // ERC20InsufficientAllowance (0xfb8f41b2) or legacy string
  // variants — matched on the full message (viem puts the selector /
  // decoded name in the details, not always the shortMessage).
  if (
    allowAllowanceRevert &&
    /0xfb8f41b2|insufficient\s*allowance|ERC20InsufficientAllowance/i.test(full)
  ) {
    return { status: 'approval-needed' };
  }
  // ERC721InsufficientApproval (0x177e802f) / ERC1155MissingApprovalForAll
  // (0xe237d922) or the legacy string variants — the rent LIST flow
  // approves the NFT operator at submit time.
  if (
    allowNftApprovalRevert &&
    /0x177e802f|0xe237d922|InsufficientApproval|MissingApprovalForAll|not (?:token )?owner (?:n?or|or) approved|caller is not .*approved/i.test(
      full,
    )
  ) {
    return { status: 'approval-needed' };
  }
  return { status: 'revert', revertReason: msg };
}
