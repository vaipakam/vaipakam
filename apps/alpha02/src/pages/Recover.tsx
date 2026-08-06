/**
 * Stuck-token recovery (T-054 PR-4, defi /recover ported onto
 * alpha02's UI/UX) — returns ERC-20s that landed in the user's vault
 * proxy OUTSIDE the protocol deposit flow (mistaken direct transfer,
 * third-party dust) to the connected wallet.
 *
 * DELIBERATELY UNLISTED — no nav or Settings entry; noindex,nofollow
 * in SeoMeta + _headers. The only in-app path here is the Help page's
 * stuck-token explainer. That discoverability gate is part of the
 * security design (as in the defi original): a user dust-poisoned by
 * a stranger must read WHY recovering unknown dust is dangerous
 * before they can find the button — declaring a sanctions-listed
 * source LOCKS recovery for their vault, and `recoverStuckERC20`
 * deliberately does NOT revert on that path (the ban-state writes
 * must persist), so the outcome is read from the receipt's events:
 *   StuckERC20Recovered            → success
 *   VaultBannedFromRecoveryAttempt → ban-as-outcome
 *
 * Flow (alpha02 in-page steps, no modal): form → review card with the
 * typed-CONFIRM friction → EIP-712 acknowledgement signature → tx →
 * outcome card. The typed CONFIRM is a deliberate speed bump, kept
 * from the original.
 *
 * Pre-sign hardening (Codex #1547 r1): before the wallet prompt, the
 * submit path re-verifies EVERYTHING the signature commits to against
 * live chain state — oracle answerability, the connected wallet's own
 * sanctions status, the surplus cap, the canonical ack text's hash,
 * and the EIP-712 domain separator. A mismatch on any of them aborts
 * with a specific message instead of letting the user sign against
 * stale or unverifiable state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ownLocaleResource } from '../i18n/ownLocaleResource';
import { RECOVERY_ACK_TEXT } from '../lib/recoveryAck';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Lock, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  hashDomain,
  hexToString,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
  decodeEventLog,
  TransactionNotFoundError,
  UserRejectedRequestError,
  type Hex,
  type PublicClient,
} from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy, copySource } from '../content/copy';
import { getSupportedChain } from '../chain/chains';
import { useActiveChain } from '../chain/useActiveChain';
import { publishReceiptInvalidation } from '../chain/receiptSync';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  assertWalletNotSanctionedLive,
  useSanctionsCheck,
} from '../data/sanctions';
import {
  captureTxError,
  isContractAnswered,
  isUserRejection,
} from '../lib/errors';
import { ADVANCED_USER_GUIDE_STUCK_TOKENS_URL } from '../lib/externalLinks';
import { exactAmountString, shortAddress } from '../lib/format';
import { makePendingMarkerStore } from '../lib/pendingMarker';

/** EIP-712 shape — must match VaultFactoryFacet's RECOVERY_TYPEHASH
 *  exactly, or the recovered signer won't equal msg.sender and the
 *  contract reverts RecoverySignatureInvalid. */
const RECOVERY_TYPES = {
  RecoveryAcknowledgment: [
    { name: 'user', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'declaredSource', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'ackTextHash', type: 'bytes32' },
  ],
} as const;

const RECOVERY_DEADLINE_SECONDS = 30 * 60;

/** UI friction constant, not copy — the user types this literal to
 *  arm the sign button (same untranslated rule as signing text). */
const CONFIRM_WORD = 'CONFIRM';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ERC20_META_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** The PRE-STANDARD `symbol()` shape (Codex #1547 r15): MKR and its
 *  contemporaries declare it as a fixed 32-byte word rather than the
 *  ABI `string` the final ERC-20 settled on. Read only after the
 *  `string` decode fails, so a modern token never pays for it. */
const ERC20_SYMBOL_BYTES32_ABI = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

/** Chainalysis-style oracle surface for the answerability probe. */
const ORACLE_PROBE_ABI = parseAbi([
  'function isSanctioned(address) view returns (bool)',
]);

/**
 * Two-step oracle probe (Codex #1547 r1): `getSanctionsOracle`
 * returning non-zero only proves an address is CONFIGURED — a wrong or
 * dead address would still let the user sign, then have the outcome
 * mis-adjudicated (or reverted) at submit time. So also staticcall the
 * oracle itself with a fixed benign argument and require a clean
 * answer. Any throw propagates to the caller, which treats it as
 * "not ready" (fail-safe blocked state).
 */
async function probeSanctionsOracle(
  publicClient: PublicClient,
  diamond: `0x${string}`,
): Promise<boolean> {
  const oracle = (await publicClient.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getSanctionsOracle',
  })) as `0x${string}`;
  if (oracle.toLowerCase() === ZERO_ADDRESS) return false;
  await publicClient.readContract({
    address: oracle,
    abi: ORACLE_PROBE_ABI,
    functionName: 'isSanctioned',
    args: [ZERO_ADDRESS],
  });
  return true;
}

/** How many times the availability probe re-tries itself after an
 *  unreadable answer before it waits for the user (Codex #1547 r6) —
 *  bounded so a hard-down RPC can't spin. */
const ORACLE_PROBE_AUTO_RETRIES = 3;
const ORACLE_PROBE_RETRY_MS = 4_000;

/**
 * Device-local record of a BROADCAST recovery (Codex #1547 r6).
 *
 * The pending card is the ONLY safe landing for a transaction whose
 * receipt couldn't be read — but it lived in React state alone, so an
 * account switch, a network switch, or a plain reload erased the hash
 * and dropped the user back on a blank form over a recovery that may
 * still be mining. That is exactly the double-recovery the pending
 * card exists to prevent.
 *
 * The record is keyed per (chain, account) by the shared pending-marker
 * store, so another identity can never see it; the identity reset now
 * HIDES it rather than discarding it, and a rehydrate on the way back
 * in restores the pending card.
 */
const pendingRecoveryStore = makePendingMarkerStore('alpha02.recoverPending');

interface PendingRecoveryRecord {
  /** NULL when the attempt was SIGNED and handed to the wallet but the
   *  wallet never returned a hash (Codex #1547 r8) — a send whose
   *  JSON-RPC reply was lost is still a possible broadcast, so the
   *  record must exist before the hash does. Reconciliation for a
   *  hashless record skips every by-hash probe and adjudicates from the
   *  on-chain recovery counter and the signed deadline alone. */
  txHash: Hex | null;
  /** Unique per ATTEMPT (Codex #1547 r10) — the reservation's identity.
   *
   *  The signed recovery NONCE cannot play that role: two tabs racing
   *  the same wallet read the SAME nonce, so a nonce-matched clear from
   *  the losing attempt would delete the winner's record — the only
   *  durable lock over its live transaction. This id is minted per
   *  signAndSubmit call, written with the reservation BEFORE the
   *  signature prompt, and every later clear/update matches on it.
   *
   *  OPTIONAL on read: a record written by a pre-r10 build has none and
   *  still reconciles under the legacy hash/nonce rule. */
  attemptId?: string;
  /** The ERC-20 the attempt named (Codex #1547 r10). Carried so a
   *  terminal card built from a REHYDRATED record can tell whether the
   *  outcome event it decoded describes the same token — a replaced
   *  transaction may not. OPTIONAL for the same legacy-record reason. */
  token?: string;
  declaredSource: string;
  /** Base units, decimal string — JSON carries no bigint. */
  amount: string;
  symbol: string;
  decimals: number;
  /** The per-user recovery nonce the SIGNATURE committed to. The
   *  reconcile path compares it against the live on-chain counter to
   *  adjudicate a transaction whose receipt it cannot read. */
  recoveryNonce: string;
  /** The signed deadline (unix seconds, decimal string) — Codex #1547
   *  r7. Past it the signature can never be used again, and that is
   *  the ONLY thing that turns "we can't find this transaction" into
   *  the positive fact "it can never go through".
   *
   *  OPTIONAL on read so a record written by an earlier build still
   *  rehydrates its pending card — dropping the card is the
   *  double-recovery risk this store exists to prevent, and a record
   *  without a deadline simply never reaches the "never processed"
   *  verdict. */
  deadline?: string;
  /** Terminal lock (Codex #1547 r7): set when a receipt-less
   *  reconcile found the on-chain recovery counter ADVANCED — i.e. an
   *  attempt was processed. Persisted so a reload cannot step around
   *  the no-fresh-recovery lock that verdict imposes; cleared only by
   *  the explicit two-step acknowledgement on the card. */
  settled?: 'executed';
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const DIGITS = /^\d+$/;

/** Upper bound on a stored attempt id — it is only ever compared for
 *  equality, but a hand-edited storage value must not be unbounded. */
const MAX_ATTEMPT_ID_LENGTH = 64;

/**
 * A fresh per-attempt identity (Codex #1547 r10).
 *
 * `crypto.randomUUID` is the normal source; it is absent on insecure
 * origins in some browsers, so fall back to random bytes and finally to
 * a time+Math.random string. Uniqueness is all that matters here — the
 * id is a local reservation token, never a secret and never on-chain —
 * so the weakest fallback is still fit for purpose.
 */
function newAttemptId(): string {
  try {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
    if (typeof c?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall through to the last-resort id below.
  }
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Parse + VALIDATE a stored record. Anything malformed (hand-edited
 *  storage, a shape from an older build) reads as absent — a bad
 *  record must never become a rendered card or a bigint conversion
 *  that throws during render. */
function readPendingRecovery(
  chainId: number,
  account: string,
): PendingRecoveryRecord | null {
  return parsePendingRecovery(
    pendingRecoveryStore.read(chainId, account.toLowerCase()),
  );
}

/** The same parse + validation over a RAW value (Codex #1547 r13) — a
 *  cross-tab `storage` event carries the removed record in
 *  `event.oldValue`, which is no longer in storage to be read back, and
 *  identifying WHICH attempt another tab dropped is what keeps this tab
 *  from clearing a newer one. */
function parsePendingRecovery(
  raw: string | null,
): PendingRecoveryRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    // `null` is a first-class value here (Codex #1547 r8) — the
    // signed-but-unacknowledged attempt. Anything else must still be a
    // well-formed hash.
    if (
      r.txHash !== null &&
      (typeof r.txHash !== 'string' || !HEX32.test(r.txHash))
    ) {
      return null;
    }
    // Both r10 fields are OPTIONAL (a pre-r10 record carries neither)
    // but must be well-formed when present — a malformed one reads as a
    // malformed record, never as a silently-dropped identity.
    if (
      r.attemptId !== undefined &&
      (typeof r.attemptId !== 'string' ||
        r.attemptId === '' ||
        r.attemptId.length > MAX_ATTEMPT_ID_LENGTH)
    ) {
      return null;
    }
    if (
      r.token !== undefined &&
      (typeof r.token !== 'string' || !isAddress(r.token))
    ) {
      return null;
    }
    if (typeof r.declaredSource !== 'string' || !isAddress(r.declaredSource)) {
      return null;
    }
    if (typeof r.amount !== 'string' || !DIGITS.test(r.amount)) return null;
    if (typeof r.symbol !== 'string') return null;
    if (
      typeof r.decimals !== 'number' ||
      !Number.isInteger(r.decimals) ||
      r.decimals < 0 ||
      r.decimals > 255
    ) {
      return null;
    }
    if (typeof r.recoveryNonce !== 'string' || !DIGITS.test(r.recoveryNonce)) {
      return null;
    }
    // Both r7 fields are OPTIONAL but must be well-formed when present
    // — a malformed one reads as a malformed record, never as a
    // silently-ignored field that could downgrade a lock.
    if (
      r.deadline !== undefined &&
      (typeof r.deadline !== 'string' || !DIGITS.test(r.deadline))
    ) {
      return null;
    }
    if (r.settled !== undefined && r.settled !== 'executed') return null;
    return {
      txHash: r.txHash === null ? null : (r.txHash as Hex),
      ...(r.attemptId === undefined ? {} : { attemptId: r.attemptId }),
      ...(r.token === undefined ? {} : { token: r.token }),
      declaredSource: r.declaredSource,
      amount: r.amount,
      symbol: r.symbol,
      decimals: r.decimals,
      recoveryNonce: r.recoveryNonce,
      ...(r.deadline === undefined ? {} : { deadline: r.deadline }),
      ...(r.settled === undefined ? {} : { settled: 'executed' as const }),
    };
  } catch {
    return null;
  }
}

/** Returns FALSE when the browser refused to store the record (Codex
 *  #1547 r8) — private mode, quota, storage disabled. The caller
 *  surfaces that as a degraded state rather than pretending the safety
 *  record exists. */
function writePendingRecovery(
  chainId: number,
  account: string,
  record: PendingRecoveryRecord,
): boolean {
  return pendingRecoveryStore.write(
    chainId,
    account.toLowerCase(),
    JSON.stringify(record),
  );
}

/**
 * Drop the stored record ONLY when it is the attempt being settled
 * (Codex #1547 r8).
 *
 * An unconditional clear could delete a NEWER record another tab wrote
 * for the same wallet — throwing away that tab's pending card (or its
 * executed LOCK) over an outcome that belongs to an older attempt. So
 * the clear is identity-matched: by transaction hash when one is
 * known, and by the signed recovery nonce for a hashless record.
 */
function clearPendingRecoveryIfMatches(
  chainId: number,
  account: string,
  txHash: Hex | null,
  recoveryNonce?: string,
  attemptId?: string,
): void {
  const stored = readPendingRecovery(chainId, account);
  if (stored === null) return;
  if (!pendingRecoveryMatches(stored, txHash, recoveryNonce, attemptId)) return;
  pendingRecoveryStore.write(chainId, account.toLowerCase(), null);
}

/**
 * The ONE identity rule every conditional writer uses: is the record
 * currently in storage the same attempt the caller is settling?
 *
 * ATTEMPT ID FIRST (Codex #1547 r10). When both sides carry one, it is
 * the whole answer — nothing else may widen or narrow it. The legacy
 * rule below is not an adequate identity: two tabs racing the same
 * wallet read the SAME recovery nonce, so a nonce match let one tab's
 * settled (or rejected) attempt delete the OTHER tab's record while its
 * transaction was still live.
 *
 * LEGACY fallback, used only when either side has no id (a record
 * written by a pre-r10 build, which must still reconcile rather than be
 * stranded): by transaction hash when the caller knows one; by the
 * signed recovery nonce against a still-HASHLESS record otherwise (the
 * signed-but-unacknowledged shape, which has no hash to compare).
 */
function pendingRecoveryMatches(
  stored: PendingRecoveryRecord,
  txHash: Hex | null,
  recoveryNonce?: string,
  attemptId?: string,
): boolean {
  if (stored.attemptId !== undefined && attemptId !== undefined) {
    return stored.attemptId === attemptId;
  }
  return txHash !== null
    ? stored.txHash !== null &&
        stored.txHash.toLowerCase() === txHash.toLowerCase()
    : stored.txHash === null &&
      recoveryNonce !== undefined &&
      stored.recoveryNonce === recoveryNonce;
}

/**
 * Re-point the stored record at a new transaction hash ONLY when the
 * record still belongs to THIS attempt (Codex #1547 r9).
 *
 * The unconditional write this replaces could clobber a NEWER record
 * another tab wrote: a wallet that answers late (the send was handed
 * over, the reply took minutes) can return its hash after the other tab
 * already reconciled this attempt, acknowledged it and started a fresh
 * recovery — and the write would then stamp the OLD attempt's hash onto
 * the new record, whose lock the later conditional clear would delete
 * as if it were ours. Matching first leaves the newer record alone; this
 * attempt's own outcome handling runs off local state either way.
 *
 * Returns FALSE only when a MATCHING record could not be written
 * (storage refused) — the degraded state the caller surfaces. A
 * non-matching record is a deliberate no-op, not a persistence failure.
 */
function updatePendingRecoveryHashIfMatches(
  chainId: number,
  account: string,
  matchHash: Hex | null,
  recoveryNonce: string,
  nextHash: Hex,
  attemptId?: string,
): boolean {
  const stored = readPendingRecovery(chainId, account);
  if (stored === null) return true;
  if (!pendingRecoveryMatches(stored, matchHash, recoveryNonce, attemptId)) {
    return true;
  }
  // Spread the STORED record, not the caller's copy — it is this
  // attempt by the check above, and anything a concurrent writer added
  // to it survives the hash upgrade.
  return writePendingRecovery(chainId, account, { ...stored, txHash: nextHash });
}

/**
 * Persist a REPLACEMENT record for an attempt only while storage still
 * holds that same attempt (Codex #1547 r10).
 *
 * The receipt-less "executed" lock used an unconditional write, which
 * could stamp its verdict over a NEWER record another tab wrote for the
 * same wallet — silently converting that tab's live pending attempt
 * into a terminal lock keyed to an older submission, and handing its
 * later identity-matched clear the power to delete it.
 *
 * A record that is ABSENT counts as not-ours too: it was cleared by
 * whoever settled or acknowledged it, and resurrecting it here would
 * re-impose a lock the user has already been released from. The local
 * step state still shows the verdict to THIS tab either way.
 *
 * Returns FALSE only when a MATCHING record could not be written
 * (storage refused) — the degraded state the caller surfaces.
 */
function writePendingRecoveryIfMatches(
  chainId: number,
  account: string,
  matchHash: Hex | null,
  recoveryNonce: string,
  attemptId: string | undefined,
  record: PendingRecoveryRecord,
): boolean {
  const stored = readPendingRecovery(chainId, account);
  if (stored === null) return true;
  if (!pendingRecoveryMatches(stored, matchHash, recoveryNonce, attemptId)) {
    return true;
  }
  return writePendingRecovery(chainId, account, record);
}

/**
 * The outcome of trying to CLAIM the reservation for one identity.
 *
 * `claimed: false` with an `existing` record means another attempt is
 * already reserved (render its card); with `existing: null` it means
 * another TAB is claiming the very same identity right now — the same
 * verdict, observed an instant earlier, before its record was written.
 */
type ReservationClaim =
  | { claimed: true; persisted: boolean }
  | { claimed: false; existing: PendingRecoveryRecord | null };

/**
 * Claim the reservation under a REAL cross-tab mutex (Codex #1547 r11).
 *
 * Read-then-write is a check-then-act over storage that every tab of
 * the origin shares: two tabs can both read "no record", both write
 * their own attempt id, and both go on to sign and broadcast. r10's
 * per-attempt id stopped the loser from CLEARING the winner's record,
 * but it never ELECTED a single claimant — it only made the collision
 * survivable after the fact.
 *
 * The Web Locks API is the browser's own cross-tab mutex: one holder
 * per lock name across every tab of the origin, with the lock released
 * automatically when the holding tab dies. The lock is held across the
 * read+write ONLY — never across the wallet prompt. A lock held over an
 * open prompt would wedge every other tab behind a dialogue the user
 * may leave sitting for minutes; the persisted record is what guards
 * the rest of the flow.
 *
 * `ifAvailable: true` means "run the callback, or hand me `null`
 * immediately if somebody else holds it" — no queueing. A held lock IS
 * another tab claiming this identity, so that answer is treated exactly
 * like finding an existing record: abort as in-flight.
 */
async function claimPendingRecovery(
  chainId: number,
  account: string,
  record: PendingRecoveryRecord,
): Promise<ReservationClaim> {
  const readThenWrite = (): ReservationClaim => {
    const existing = readPendingRecovery(chainId, account);
    if (existing !== null) return { claimed: false, existing };
    return {
      claimed: true,
      persisted: writePendingRecovery(chainId, account, record),
    };
  };

  const lockManager: LockManager | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (lockManager === undefined) {
    // FALLBACK for browsers without Web Locks (older Safari, some
    // embedded webviews): read-then-write, then VERIFY by re-reading —
    // a tab that lost the race sees the winner's attempt id and aborts
    // WITHOUT signing.
    //
    // Residual narrowness, stated plainly: verification shrinks the
    // window from "read → write → wallet prompt" to "write → re-read",
    // two synchronous statements. Two tabs whose writes land on either
    // side of the other's verify (T1 write, T1 verify, T2 write, T2
    // verify) can still both believe they won. There is no way to close
    // that without a mutex; every browser that ships one takes the
    // branch above, and the per-attempt id keeps the outcome survivable
    // either way.
    const claim = readThenWrite();
    if (!claim.claimed) return claim;
    const stored = readPendingRecovery(chainId, account);
    if (stored === null || stored.attemptId !== record.attemptId) {
      return { claimed: false, existing: stored };
    }
    return claim;
  }

  const outcome = await lockManager.request(
    // Per IDENTITY, not per page: two tabs on different wallets or
    // different chains are not racing each other and must not block.
    `alpha02.recoverClaim.${chainId}.${account.toLowerCase()}`,
    { ifAvailable: true },
    (lock) => (lock === null ? null : readThenWrite()),
  );
  return outcome ?? { claimed: false, existing: null };
}

/**
 * Is this the node POSITIVELY answering "I don't have that
 * transaction" (Codex #1547 r7), as opposed to any other read failure?
 *
 * Only that answer may feed the "nothing was recovered" verdict, so
 * the check must not over-match — and must not UNDER-match either:
 * `instanceof` alone is unreliable in a pnpm workspace that resolves
 * more than one physical copy of viem (the wallet's public client may
 * come from a different copy than this module's import), so viem's
 * stable error `name` is the fallback. A miss is merely conservative —
 * the card stays pending — but it would make the verdict unreachable.
 */
function isTransactionNotFound(err: unknown): boolean {
  if (err instanceof TransactionNotFoundError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'TransactionNotFoundError'
  );
}

/**
 * Did the user EXPLICITLY reject the transaction in the wallet (Codex
 * #1547 r9)?
 *
 * This is the one post-signature failure that positively proves nothing
 * was broadcast: the wallet asked, the user said no, the send was never
 * made. Every other failure after the signature is ambiguous (a lost
 * JSON-RPC reply over a transaction already in the mempool), which is
 * why the signed-attempt marker exists at all — but treating a flat
 * rejection as ambiguous locks the flow behind a pending card until the
 * 30-minute deadline expires, over a transaction that does not exist.
 *
 * The signature alone cannot execute anything: `recoverStuckERC20`
 * requires the recovered signer to EQUAL msg.sender, so nobody else can
 * relay it. Clearing the record on this branch is safe.
 *
 * Detection mirrors `isTransactionNotFound`'s name-fallback discipline:
 * `instanceof` alone is unreliable when the pnpm workspace resolves more
 * than one physical copy of viem (the wallet client's errors may come
 * from a different copy than this module's import), so the viem error
 * `name` and the EIP-1193 `code` 4001 are checked down the cause chain
 * too. `isUserRejection` covers the viem-BaseError `walk` path; the loop
 * below covers the plain nested shapes an injected provider produces.
 */
function isUserRejectedTransaction(err: unknown): boolean {
  if (err instanceof UserRejectedRequestError) return true;
  if (isUserRejection(err)) return true;
  let node: unknown = err;
  for (let depth = 0; node != null && depth < 6; depth += 1) {
    if (typeof node !== 'object') break;
    const o = node as { name?: unknown; code?: unknown; cause?: unknown };
    if (o.name === 'UserRejectedRequestError') return true;
    if (o.code === 4001) return true;
    node = o.cause;
  }
  return false;
}

/**
 * Is this OPTIONAL metadata read's failure safe to fall back on
 * (Codex #1547 r15)?
 *
 * `symbol()` / `decimals()` are optional in ERC-20, and a token that
 * lacks them stays recoverable: raw base units for a missing
 * `decimals()`, the shortened address for a missing `symbol()`. The
 * question a failure has to answer is only ever "did the NODE answer?"
 * — anything the node answered describes the token as it actually is,
 * whatever shape that answer took.
 *
 * The r10 rule listed the two contract-level shapes it knew (revert,
 * zero data) and rethrew everything else, which turned out to be too
 * narrow: legacy pre-standard tokens (MKR and its contemporaries)
 * declare `symbol()` / `name()` as `bytes32`, so the call REACHES the
 * contract and returns 32 perfectly good bytes that viem's `string`
 * decoder then rejects (an `IntegerOutOfRangeError` under a
 * `ContractFunctionExecutionError`). Rethrowing that failed the whole
 * lookup and made those tokens unrecoverable, instead of the shortened-
 * address fallback the guide promises.
 *
 * So the discriminator POSITIVELY identifies a contract answer and
 * defaults to unreadable (Codex #1547 r16). The r15 shape — a denylist
 * of transport names — silently re-opened the r10 bug, because viem
 * also reports node-side failures as RpcRequestError /
 * InternalRpcError / LimitExceededRpcError / ResourceUnavailableRpcError:
 * a rate-limited eth_call fell through as "no metadata" and flipped an
 * ordinary 18-decimal token into raw base units, so a user who typed
 * `1` would sign for a single base unit. Anything not recognised as a
 * contract answer fails the lookup, with the honest "we couldn't read
 * this token's details" the user can retry out of.
 */
function isOptionalMetadataUnavailable(err: unknown): boolean {
  return isContractAnswered(err);
}

/** Display cap for an attacker-controlled token symbol. */
const MAX_SYMBOL_LENGTH = 20;

/**
 * Sanitize the token's self-reported symbol() (Codex #1547 r3): it is
 * attacker-controlled Unicode rendered directly NEXT TO addresses on
 * the review card. A symbol carrying bidi override/embedding/isolate
 * controls (U+202A–U+202E, U+2066–U+2069) or the LRM/RLM marks
 * (U+200E/U+200F) can visually REORDER the adjacent address text, so a
 * lookalike address reads as the real one at review time. Strip those
 * plus C0/DEL controls at lookup time — the source of every render —
 * and cap the length so a paragraph-sized "symbol" can't push the
 * address off-screen. Rendering additionally bidi-isolates the spans
 * (defense in depth).
 */
function sanitizeTokenSymbol(raw: string): string {
  return raw
    .replace(
      // eslint-disable-next-line no-control-regex -- stripping controls is the point
      /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      '',
    )
    .slice(0, MAX_SYMBOL_LENGTH);
}

/** One atomic lookup result, carrying the token address it describes
 *  (Codex #1547 r1): the previous four-state shape (symbol / decimals /
 *  surplus / failed) could interleave a slow response for a PREVIOUS
 *  token with the current input and gate `canReview` on mismatched
 *  values. Consumers must check `token === tokenInput` before use. */
interface TokenLookup {
  token: string;
  symbol: string;
  decimals: number;
  /** decimals() unavailable → amounts are raw base units (integers). */
  rawUnits: boolean;
  surplus: bigint;
}

/**
 * Everything a terminal outcome card needs that the RECEIPT alone
 * can't supply (Codex #1547 r5). Carried on the pending step so the
 * reconcile action can render a full success/banned card later, long
 * after the form inputs behind it may have been cleared.
 */
interface SubmittedContext {
  /** This attempt's reservation identity (Codex #1547 r10) — what every
   *  clear/update matches on. Absent only for a pre-r10 record. */
  attemptId?: string;
  /** The ERC-20 the attempt named (Codex #1547 r10) — compared against
   *  the token a decoded outcome event reports, so a card built from a
   *  REPLACED transaction can't silently borrow this attempt's symbol
   *  and decimals for a different token. Absent only for a pre-r10
   *  record. */
  token?: string;
  declaredSource: string;
  amount: bigint;
  symbol: string;
  decimals: number;
  /** The recovery nonce the SIGNATURE committed to (Codex #1547 r6) —
   *  the reconcile path's fallback authority when the receipt for the
   *  stored hash can't be found (a replaced transaction never has one). */
  recoveryNonce: bigint;
  /** The deadline the SIGNATURE committed to (Codex #1547 r7), unix
   *  seconds. Once chain time is past it the signature is unusable, so
   *  a transaction that is absent from the node can no longer be
   *  resurrected — the one fact that lets the reconcile conclude
   *  "never processed" instead of guessing. Absent only for a record
   *  written by an earlier build. */
  deadline?: bigint;
}

/**
 * The (account, chain) a TERMINAL card belongs to (Codex #1547 r13).
 *
 * Terminal outcome cards render AHEAD of every account/oracle gate (the
 * r2 rule — a ban refetches sanctions, and the generic flagged-wallet
 * gate would otherwise swallow the receipt-specific card). That
 * ordering made the passive identity reset too late: a direct
 * account → account switch on the same chain, or a chain → chain
 * switch, re-renders BEFORE the reset effect runs, so the previous
 * wallet's outcome card painted for one frame — with an explorer link
 * built from the NEWLY selected chain's explorer base, pointing a
 * real hash at the wrong network's scanner.
 *
 * Tagging the card with the identity it describes lets the render
 * suppress a mismatched one SYNCHRONOUSLY, so the reset effect is only
 * ever housekeeping, never the thing standing between a wallet switch
 * and someone else's receipt.
 */
interface StepOwner {
  /** LOWERCASED — every comparison is case-insensitive by construction. */
  address: string;
  chainId: number;
}

type Step =
  | { kind: 'form' }
  | { kind: 'review' }
  /** Pre-sign checks + the wallet signature prompt are in flight —
   *  review controls stay rendered but locked (Codex #1547 r1). */
  | { kind: 'signing' }
  | { kind: 'submitting' }
  /** `unknownToken` (Codex #1547 r10): the outcome event named a token
   *  this flow has no metadata for — the honest rendering is the raw
   *  base-unit amount next to that token's address, never this
   *  attempt's symbol/decimals applied to someone else's amount. */
  | {
      kind: 'success';
      /** The identity this card describes (Codex #1547 r13). */
      owner: StepOwner;
      txHash: Hex;
      amount: bigint;
      symbol: string;
      decimals: number;
      unknownToken?: string;
    }
  | {
      kind: 'banned';
      /** The identity this card describes (Codex #1547 r13). */
      owner: StepOwner;
      txHash: Hex;
      declaredSource: string;
    }
  /** TERMINAL (Codex #1547 r3): the tx receipt was a success but no
   *  outcome event decoded — the recovery may already have completed,
   *  so the flow must never re-arm the sign button from here.
   *  `pending` (Codex #1547 r4): the tx was BROADCAST but its receipt
   *  couldn't be read (RPC drop, wallet disconnect mid-wait) — it may
   *  still mine, so the same terminal card renders with a body that
   *  says "submitted but unconfirmed" instead of "confirmed".
   *  `replaced` (Codex #1547 r5): the wallet CANCELLED or wholesale
   *  replaced the original tx and the tx that actually mined carries
   *  no recovery event — nothing was recovered, which is a DIFFERENT
   *  statement from "the outcome couldn't be read". Deliberately NOT
   *  set for a 'repriced' replacement (Codex #1547 r7): viem's
   *  repriced reason means the SAME calldata, destination and value
   *  went out at a higher fee, so a successful receipt with no
   *  decodable event is an unreadable OUTCOME, not proof that no
   *  recovery happened.
   *  `ctx` (Codex #1547 r5): carried by the `pending` variant — the
   *  reconcile action needs it to build a success/banned card, and its
   *  signed nonce + deadline are what let the reconcile adjudicate a
   *  receipt-less transaction. The `receiptless: 'executed'` variant
   *  carries it for parity (Codex #1547 r7) — that card's LOCK lives
   *  in the persisted record, not in this field, but the step should
   *  still fully describe the submission it belongs to.
   *  `receiptless` (Codex #1547 r6): the reconcile could not find a
   *  receipt for the stored hash (the hallmark of a wallet
   *  replacement) and adjudicated from the on-chain recovery counter
   *  instead — 'executed' (counter moved: the attempt WAS processed)
   *  or 'never' (counter unmoved AND the transaction is positively
   *  absent AND its signature has expired). */
  | {
      kind: 'unknownOutcome';
      /** The identity this card describes (Codex #1547 r13). */
      owner: StepOwner;
      /** NULL for a signed attempt the wallet never acknowledged
       *  (Codex #1547 r8) — the card renders without an explorer link
       *  rather than linking a hash that does not exist. */
      txHash: Hex | null;
      pending?: boolean;
      replaced?: boolean;
      receiptless?: 'executed' | 'never';
      ctx?: SubmittedContext;
    };

/** The identity a TERMINAL card belongs to, or NULL for the steps that
 *  render behind the gates and are covered by the reset effect alone
 *  (Codex #1547 r13). The three variants listed here are exactly the
 *  ones that render AHEAD of the account/oracle gates. */
function terminalStepOwner(step: Step): StepOwner | null {
  return step.kind === 'success' ||
    step.kind === 'banned' ||
    step.kind === 'unknownOutcome'
    ? step.owner
    : null;
}

/** The identity tag for a card built for a given wallet + chain (Codex
 *  #1547 r13). Lowercases once, here, so no comparison has to. */
function stepOwnerOf(address: string, chainId: number): StepOwner {
  return { address: address.toLowerCase(), chainId };
}

/**
 * The card a PERSISTED record rehydrates to. Shared by the identity
 * effect, the cross-tab `storage` listener and the pre-sign re-read
 * (Codex #1547 r8) so all three land on exactly the same state.
 *
 * `owner` (Codex #1547 r13) is the identity the record was READ for —
 * a rehydrated card is tagged exactly like a freshly-built one, so the
 * render-time identity check treats both the same.
 *
 * A record marked `settled: 'executed'` rehydrates as the TERMINAL
 * locked card, not as a pending one (Codex #1547 r7) — the verdict "an
 * attempt was processed" must survive a reload, or refreshing the page
 * would hand the user a fresh form over a recovery that may have moved
 * only part of the surplus.
 */
function stepFromRecord(
  stored: PendingRecoveryRecord,
  owner: StepOwner,
): Step {
  const ctx: SubmittedContext = {
    ...(stored.attemptId === undefined ? {} : { attemptId: stored.attemptId }),
    ...(stored.token === undefined ? {} : { token: stored.token }),
    declaredSource: stored.declaredSource,
    amount: BigInt(stored.amount),
    symbol: stored.symbol,
    decimals: stored.decimals,
    recoveryNonce: BigInt(stored.recoveryNonce),
    ...(stored.deadline === undefined
      ? {}
      : { deadline: BigInt(stored.deadline) }),
  };
  return stored.settled === 'executed'
    ? {
        kind: 'unknownOutcome',
        owner,
        txHash: stored.txHash,
        receiptless: 'executed',
        ctx,
      }
    : {
        kind: 'unknownOutcome',
        owner,
        txHash: stored.txHash,
        pending: true,
        ctx,
      };
}

/**
 * The outcome event a mined receipt carries, or null when none of the
 * two recovery outcomes is present. Shared by the submit path and the
 * reconcile action (Codex #1547 r5) so both adjudicate identically.
 *
 * The contract deliberately does NOT revert on the sanctioned-source
 * path (the ban-state writes must persist), so the outcome lives in
 * the logs, not in the receipt status.
 */
interface DecodedRecoveryOutcome {
  kind: 'recovered' | 'banned';
  /** The event's OWN arguments (Codex #1547 r10), each present only
   *  when that event carries it — the admin-triggered
   *  `StuckERC20Recovered` overload has no `declaredSource`, and a
   *  future shape may carry neither. */
  token?: string;
  amount?: bigint;
  declaredSource?: string;
}

/** Read one field off a decoded event's args without asserting a shape
 *  the ABI union doesn't guarantee. */
function eventArg(args: unknown, name: string): unknown {
  return typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)[name]
    : undefined;
}

function decodeRecoveryOutcome(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
  diamond: string,
): DecodedRecoveryOutcome | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: DIAMOND_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const kind =
        decoded.eventName === 'StuckERC20Recovered'
          ? ('recovered' as const)
          : decoded.eventName === 'VaultBannedFromRecoveryAttempt'
            ? ('banned' as const)
            : null;
      if (kind === null) continue;
      // The ARGS travel with the verdict (Codex #1547 r10). Discarding
      // them meant a card for a REPLACED transaction was built from the
      // original submission — the wrong amount and the wrong declared
      // source, next to an explorer link showing different values.
      const token = eventArg(decoded.args, 'token');
      const amount = eventArg(decoded.args, 'amount');
      const declaredSource = eventArg(decoded.args, 'declaredSource');
      return {
        kind,
        ...(typeof token === 'string' && isAddress(token) ? { token } : {}),
        ...(typeof amount === 'bigint' ? { amount } : {}),
        ...(typeof declaredSource === 'string' && isAddress(declaredSource)
          ? { declaredSource }
          : {}),
      };
    } catch {
      // Some other event on the diamond — skip.
    }
  }
  return null;
}

/**
 * Build the terminal card for a decoded outcome, preferring the EVENT's
 * own values over the submission context (Codex #1547 r10).
 *
 * `ctx` describes what the user SUBMITTED; the event describes what
 * actually happened. When a wallet replaces a transaction those can
 * differ, and the old code rendered the submission — reporting the
 * original amount and symbol next to an explorer link showing other
 * values, or naming the original declared source on a ban the mined
 * transaction had declared differently.
 *
 * Token identity is checked, not assumed: an event naming a token this
 * attempt didn't reference gets the raw-base-unit rendering with its
 * own address, because this flow's symbol/decimals describe a different
 * contract. A pre-r10 record carries no token to compare, so it keeps
 * the best-effort context rendering.
 *
 * Returns NULL when neither source can supply what the card needs —
 * the caller falls back to the outcome-unknown card.
 */
function outcomeStepFrom(
  decoded: DecodedRecoveryOutcome,
  txHash: Hex,
  ctx: SubmittedContext | undefined,
  /** The identity the card belongs to (Codex #1547 r13) — the account
   *  and chain the receipt was read for, never whatever is connected by
   *  the time the card renders. */
  owner: StepOwner,
): Step | null {
  if (decoded.kind === 'banned') {
    const declaredSource = decoded.declaredSource ?? ctx?.declaredSource;
    return declaredSource === undefined
      ? null
      : { kind: 'banned', owner, txHash, declaredSource };
  }
  const amount = decoded.amount ?? ctx?.amount;
  if (amount === undefined) return null;
  const sameToken =
    decoded.token === undefined ||
    ctx?.token === undefined ||
    decoded.token.toLowerCase() === ctx.token.toLowerCase();
  if (!sameToken || ctx === undefined) {
    // No trustworthy metadata for the token the event names — say so
    // rather than dress its amount in another token's decimals.
    return decoded.token === undefined
      ? null
      : {
          kind: 'success',
          owner,
          txHash,
          amount,
          symbol: shortAddress(decoded.token),
          decimals: 0,
          unknownToken: decoded.token,
        };
  }
  return {
    kind: 'success',
    owner,
    txHash,
    amount,
    symbol: ctx.symbol,
    decimals: ctx.decimals,
  };
}

export function Recover() {
  const { address, onSupportedChain, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const sanctions = useSanctionsCheck();
  // The reading aid below the declaration is only honest if the
  // reader's OWN bundle actually carries it, so it is gated on the
  // resource rather than on the language code: what we check is
  // exactly what we render. `useTranslation` re-renders on the store's
  // `added` event, so a bundle that lands late switches this on by
  // itself.
  //
  // BOTH halves are checked, and both are rendered from the checked
  // value. The label is what makes the claim ("in your language"), so
  // an English label over a translated block states it in a language
  // the reader may not read; a translated label over English text
  // states something false. Either alone is worse than showing
  // neither (Codex #1563 r10).
  const { i18n } = useTranslation();
  const localizedAckText = ownLocaleResource(
    i18n,
    'copy.recover.ackTextTranslation',
    copySource.recover.ackTextTranslation,
  );
  const localizedAckLabel = ownLocaleResource(
    i18n,
    'copy.recover.ackTextTranslationLabel',
    copySource.recover.ackTextTranslationLabel,
  );

  const [tokenInput, setTokenInput] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  // RAW step state (Codex #1547 r13): what the flow last committed,
  // which may belong to a wallet/chain that is no longer connected. The
  // `step` the render consumes is DERIVED from it below, after the
  // identity check — nothing outside that derivation reads this.
  const [rawStep, setStepState] = useState<Step>({ kind: 'form' });
  // The step as of the LAST COMMIT REQUEST, not the last render (Codex
  // #1547 r15). Event listeners — the cross-tab `storage` handler
  // below — need to know what this tab is showing without
  // re-subscribing on every step change, and they need the raw step
  // (tag included) to decide whether an event concerns them.
  //
  // Written by `setStep` itself, in the same synchronous turn as the
  // state update, because a passive `useEffect` mirror is a RENDER
  // behind: another tab that reserves an attempt and then immediately
  // drops it (a signature the user rejected at once) delivers both
  // `storage` events in one task, and React batches the two updates
  // with no render in between. The removal handler then read a mirror
  // still showing `form`, skipped the release, and left this tab stuck
  // on the hashless card it had just adopted.
  const stepRef = useRef<Step>({ kind: 'form' });
  /** The ONLY way to commit a step. Functional updaters read the ref —
   *  which is exactly what was last handed to React — so back-to-back
   *  commits inside one batch compose correctly without waiting for a
   *  render. */
  const setStep = (next: Step | ((prev: Step) => Step)) => {
    const value =
      typeof next === 'function'
        ? (next as (prev: Step) => Step)(stepRef.current)
        : next;
    stepRef.current = value;
    setStepState(value);
  };
  const [error, setError] = useState<string | null>(null);
  // Reconcile state for the PENDING terminal card (Codex #1547 r5).
  // Its failure line is SEPARATE from `error` on purpose: the shared
  // error banner is titled "Recovery didn't go through", which would
  // misdescribe a transaction that simply hasn't been mined yet.
  //
  // Generation-KEYED, exactly like inFlightRef (Codex #1547 r7): a
  // component-wide boolean meant an identity change mid-read left the
  // NEW identity's button disabled forever (nothing cleared it but the
  // old flow's finally), and that old finally could equally clear a
  // NEWER identity's claim. The ref is the synchronous mutex; the
  // state exists only so the button can re-render.
  const reconcileRef = useRef<number | null>(null);
  const [reconcileClaim, setReconcileClaim] = useState<number | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  // Two-step acknowledgement on the terminal 'executed' card (Codex
  // #1547 r7) — true once the user has confirmed they checked their
  // wallet, which is what reveals the (still explicit) new-recovery
  // action. Reset by the identity effect below.
  const [executedAcked, setExecutedAcked] = useState(false);
  // The browser refused to persist the safety record (Codex #1547 r8) —
  // private mode, quota, storage disabled. NON-blocking: the recovery
  // still runs, but the user is told plainly that a reload will lose
  // the app's ability to pick this attempt back up, so they check their
  // wallet before retrying. Silently reporting success here was the
  // bug: the flow behaved as if the record existed.
  const [persistFailed, setPersistFailed] = useState(false);
  // Generation-KEYED in-flight mutex (Codex #1547 r4): stores the
  // identity generation of the running signAndSubmit, or null when
  // idle. Keying by generation (instead of a boolean) means the reset
  // effect implicitly releases it — a mismatched generation reads as
  // not-in-flight — while a still-running OLD closure's finally can't
  // clear a NEW flow's claim (it only clears its own generation).
  const inFlightRef = useRef<number | null>(null);
  // Identity generation token (Codex #1547 r3): bumped by the reset
  // effect below on every account/chain change. `signAndSubmit`
  // captures the value at entry and re-checks it before EVERY state
  // commit, so an async flow started under a previous identity can
  // never commit a step, an error, a lookup, or an explorer link
  // against the new one — the r2 reset alone couldn't stop a promise
  // that was already in flight from writing after the reset ran.
  const genRef = useRef(0);

  // Bounded auto-retry budget for the availability probe (Codex #1547
  // r6) — a ref, so consuming it never re-renders; reset by the
  // identity effect below and by the manual Retry button.
  const oracleAutoRetriesRef = useRef(0);
  // Bumping this re-runs the availability probe (auto-retry / Retry).
  const [oracleAttempt, setOracleAttempt] = useState(0);

  // Full reset to the initial state whenever the connected account OR
  // chain changes (Codex #1547 r2): a terminal success/banned card,
  // its explorer link, and every typed input belong to the PREVIOUS
  // account/chain — another account (or the same one on another
  // network) must never see that outcome or a wrong-chain tx link.
  //
  // The BROADCAST-recovery record is the one thing the reset does not
  // discard (Codex #1547 r6): it is stored per (chain, account), so
  // switching away merely hides it, and switching back — or reloading
  // the page — REHYDRATES the pending card instead of presenting a
  // blank form over a transaction that may still be mining.
  /** Back to a blank form with every derived banner cleared — the state
   *  an identity change lands on, and the state the explicit start-over
   *  actions land on. Deliberately does NOT touch the persisted record;
   *  each caller decides whether that record is theirs to drop. */
  const clearToFreshForm = () => {
    setTokenInput('');
    setSourceInput('');
    setAmountInput('');
    setConfirmInput('');
    setError(null);
    setReconcileError(null);
    setExecutedAcked(false);
    setPersistFailed(false);
    setStep({ kind: 'form' });
  };

  useEffect(() => {
    genRef.current += 1; // invalidate any in-flight signAndSubmit (Codex #1547 r3)
    clearToFreshForm();
    oracleAutoRetriesRef.current = 0;
    const chainId = walletChain?.chainId;
    const stored =
      address && chainId !== undefined
        ? readPendingRecovery(chainId, address)
        : null;
    // A rehydrated card is TAGGED with the identity it was read for
    // (Codex #1547 r13), exactly like a freshly-built one.
    if (stored !== null && address && chainId !== undefined) {
      setStep(stepFromRecord(stored, stepOwnerOf(address, chainId)));
    }
  }, [address, walletChain?.chainId]);

  // The step the RENDER consumes (Codex #1547 r13). A terminal card is
  // tagged with the account + chain it describes, and a card whose tag
  // no longer matches the connected wallet is suppressed HERE —
  // synchronously, in the same render that first sees the new identity
  // — instead of waiting for the passive reset effect above.
  //
  // Why it can't wait: the terminal cards render AHEAD of every
  // account/oracle gate (the r2 rule), so on a direct account → account
  // switch (or chain → chain) React paints once with the previous
  // wallet's outcome card still committed, and its explorer link is
  // built from the newly-selected chain's explorer base — a real hash
  // pointed at the wrong network's scanner. Suppressing it reads as
  // "there is no terminal step": the render falls through to the same
  // form / probing states a fresh identity starts from, and the reset
  // effect then does the state housekeeping a beat later.
  const stepOwner = terminalStepOwner(rawStep);
  const step: Step =
    stepOwner !== null &&
    !(
      address !== undefined &&
      walletChain !== null &&
      stepOwner.address === address.toLowerCase() &&
      stepOwner.chainId === walletChain.chainId
    )
      ? { kind: 'form' }
      : rawStep;

  // CROSS-TAB rehydrate (Codex #1547 r8): a second tab on the same
  // wallet must not sit on a blank form while the first tab has a
  // recovery in flight — localStorage `storage` events fire in every
  // OTHER tab of the origin, so pick the record up as soon as it is
  // written. Only a form/review state is replaced: a card that already
  // describes an attempt (or an in-flight signature) is never
  // overwritten by a background event.
  //
  // The REMOVAL case matters just as much (Codex #1547 r13). Another
  // tab drops the shared record when it rejects the signature, or when
  // it reads a definitive receipt — at which point this tab's pending
  // card describes an attempt that no longer exists. Left alone it
  // stayed there: for a rejected HASHLESS reservation there is no
  // transaction for "check again" to find, so the card sat locked until
  // the signed 30-minute deadline expired, over a send that was never
  // made. So a removal releases the card — but only a pending one, and
  // only when the record that went away is the one this card describes.
  //
  // Both halves are decided from the EVENT itself (Codex #1547 r14) —
  // `oldValue` says which attempt LEFT the shared slot, `newValue` says
  // which one now owns it — never from a fresh read of storage. A
  // re-read only ever sees the LATEST record, so a backgrounded tab
  // whose queued event is processed after another tab both removed the
  // displayed attempt AND claimed a new one saw that newer record, took
  // the "slot still occupied" branch, and refused to replace its card —
  // and the following write event did the same, stranding this tab on
  // an attempt that no longer owns the slot. Order matters: RELEASE the
  // stale card first, then ADOPT the record that replaced it.
  useEffect(() => {
    const chainId = walletChain?.chainId;
    if (!address || chainId === undefined) return;
    const owner = stepOwnerOf(address, chainId);
    const ownKey = pendingRecoveryStore.key(chainId, address.toLowerCase());
    const onStorage = (event: StorageEvent) => {
      // `key === null` is a whole-storage clear, which also concerns us.
      if (event.key !== null && event.key !== ownKey) return;
      // RELEASE. Only an UNRESOLVED card is released: a settled one
      // (success, banned, the executed lock, "nothing was processed")
      // is a verdict the user still has to read, and another tab
      // tidying storage must never wipe it off this screen.
      const current = stepRef.current;
      if (
        current.kind === 'unknownOutcome' &&
        current.pending === true &&
        current.owner.address === owner.address &&
        current.owner.chainId === owner.chainId
      ) {
        // Whose attempt left the slot? `event.oldValue` still carries
        // it, and matching on it is what stops a card belonging to a
        // NEWER attempt (this tab re-submitted after the other tab
        // settled) from being cleared by a stale event. When the
        // browser gives no oldValue — a whole-storage clear, or an
        // event shape without it — the only safe reading left is the
        // weaker one: this card is pending and no record exists for it
        // at all, so it is stale either way.
        const removed = parsePendingRecovery(event.oldValue);
        const releases =
          removed !== null
            ? pendingRecoveryMatches(
                removed,
                current.txHash,
                current.ctx?.recoveryNonce.toString(),
                current.ctx?.attemptId,
              )
            : readPendingRecovery(chainId, address) === null;
        if (releases) clearToFreshForm();
      }
      // ADOPT. Only a form/review state takes on the record that now
      // owns the slot — a card that already describes an attempt (or an
      // in-flight signature) is never overwritten by a background
      // event. The release above runs first precisely so a card the
      // event itself just invalidated cannot block the newer record
      // from landing.
      const written = parsePendingRecovery(event.newValue);
      if (written !== null) {
        setStep((s) =>
          s.kind === 'form' || s.kind === 'review'
            ? stepFromRecord(written, owner)
            : s,
        );
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [address, walletChain?.chainId]);

  // Fail-safe availability probe: `recoverStuckERC20` HARD-REQUIRES
  // the sanctions oracle (it reverts SanctionsOracleUnavailable when
  // unset — the outcome can't be adjudicated without screening the
  // declared source). Never let the user sign into that: with the
  // oracle unset, unanswerable, OR the probe failing, the flow renders
  // a blocked state instead of the form (per the WebsiteReadme
  // recovery spec).
  //
  // FOUR states, not a boolean (Codex #1547 r6): a probe that THREW is
  // a different fact from a confirmed-zero oracle address. Both fail
  // closed, but 'unset' is a permanent property of the network while
  // 'unreachable' is a passing read failure the user can retry out of
  // — collapsing them told a user on a flaky RPC that recovery would
  // never work here, with a page reload as the only way back.
  const [oracleState, setOracleState] = useState<
    'probing' | 'ready' | 'unset' | 'unreachable'
  >('probing');
  useEffect(() => {
    if (!publicClient || !walletChain) {
      setOracleState('probing');
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setOracleState('probing');
    (async () => {
      try {
        const ready = await probeSanctionsOracle(
          publicClient,
          walletChain.diamondAddress,
        );
        if (!cancelled) setOracleState(ready ? 'ready' : 'unset');
      } catch {
        if (cancelled) return;
        setOracleState('unreachable'); // fail-safe: blocked, but retryable
        if (oracleAutoRetriesRef.current < ORACLE_PROBE_AUTO_RETRIES) {
          oracleAutoRetriesRef.current += 1;
          retryTimer = setTimeout(
            () => setOracleAttempt((n) => n + 1),
            ORACLE_PROBE_RETRY_MS,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [publicClient, walletChain, oracleAttempt]);

  // Contract-account gate (Codex #1547 r6): `recoverStuckERC20`
  // authorises with ECDSA.recover and requires the recovered signer to
  // EQUAL msg.sender, so a smart-contract account (Safe & co.) can
  // never satisfy it — its "signature" is a contract-side validation
  // the facet doesn't consult. Block before the form instead of
  // walking the user through CONFIRM, a signature and a transaction
  // that can only revert.
  //
  // Fails OPEN (Codex #1547 r6): a failed code read must not lock a
  // real EOA out of recovery. The pre-sign path still surfaces the
  // contract-side revert for the case this probe missed.
  //
  // The verdict is TAGGED with the identity it was read for (Codex
  // #1547 r11) and only counts while that tag still matches the
  // connected wallet. Untagged state left the PREVIOUS account's
  // verdict on screen while the new account's probe was in flight, so
  // switching an EOA → Safe rendered the recovery form under the old
  // 'eoa' answer until the slower probe answered. A stale tag reads as
  // 'probing', which is what the availability card already covers.
  const [accountProbe, setAccountProbe] = useState<{
    address: string;
    chainId: number | undefined;
    kind: 'eoa' | 'contract';
  } | null>(null);
  const accountKind: 'probing' | 'eoa' | 'contract' =
    accountProbe !== null &&
    address !== undefined &&
    accountProbe.address === address &&
    accountProbe.chainId === walletChain?.chainId
      ? accountProbe.kind
      : 'probing';
  useEffect(() => {
    if (!publicClient || !address) {
      setAccountProbe(null);
      return;
    }
    const probedChainId = walletChain?.chainId;
    let cancelled = false;
    const record = (kind: 'eoa' | 'contract') => {
      if (!cancelled) setAccountProbe({ address, chainId: probedChainId, kind });
    };
    (async () => {
      try {
        const code = await publicClient.getCode({ address });
        // viem answers `undefined` for an account with no code; some
        // nodes answer the empty-bytes literal instead.
        const raw = (code ?? '0x').toLowerCase();
        const hasCode = raw !== '0x' && raw !== '0x0';
        // EIP-7702 DELEGATED EOAs are still EOAs (Codex #1547 r8): an
        // account that signed a 7702 authorization carries exactly
        // 0xef0100 ‖ <delegate address> as its code, but its private
        // key still signs ordinary ECDSA messages — so
        // `ECDSA.recover(...) == msg.sender` holds and recovery works
        // fine. Blocking on "any code at all" would lock every
        // smart-account-upgraded EOA out of recovery. Only NON-
        // delegated code is a true contract account.
        const delegatedEoa = raw.startsWith('0xef0100');
        record(hasCode && !delegatedEoa ? 'contract' : 'eoa');
      } catch {
        record('eoa'); // fail OPEN
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address, walletChain?.chainId]);

  // Live token meta + the unsolicited-surplus cap for the entered
  // token: surplus = max(0, balanceOf(vault) − protocol-tracked).
  const [lookup, setLookup] = useState<TokenLookup | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  // NON-ZERO is part of "valid" here (Codex #1547 r9): `isAddress`
  // accepts 0x0000…0000, so without this the user could reach review
  // and SIGN an ownership declaration ("this address is mine, or acted
  // with my permission") over the zero address — an address nobody
  // controls, and the burn/uninitialised sentinel besides. The token
  // side gets the same guard: the zero address is not an ERC-20.
  const isZeroAddressInput = (value: string) =>
    isAddress(value) && value.toLowerCase() === ZERO_ADDRESS;
  const validToken = isAddress(tokenInput) && !isZeroAddressInput(tokenInput);
  const validSource = isAddress(sourceInput) && !isZeroAddressInput(sourceInput);

  // The lookup only counts when it describes the CURRENT input — a
  // stale object for a previously-entered token must gate nothing.
  const activeLookup =
    lookup !== null && lookup.token === tokenInput ? lookup : null;

  const amountWei = useMemo(() => {
    if (!amountInput || !activeLookup) return null;
    // Raw-units tokens (no decimals()): accept plain integers only —
    // parseUnits(x, 0) would ROUND a fractional input instead of
    // rejecting it, silently changing what the user signs.
    if (activeLookup.rawUnits && !/^\d+$/.test(amountInput)) return null;
    // Decimal-reporting tokens (Codex #1547 r2): reject MORE fractional
    // digits than the token supports BEFORE parseUnits — parseUnits
    // ROUNDS the excess (parseUnits('0.0000009', 6) → 1 base unit)
    // instead of rejecting it, silently changing what the user signs.
    if (!activeLookup.rawUnits) {
      const pattern =
        activeLookup.decimals > 0
          ? new RegExp(`^\\d+(\\.\\d{1,${activeLookup.decimals}})?$`)
          : /^\d+$/;
      if (!pattern.test(amountInput)) return null;
    }
    try {
      const v = parseUnits(amountInput, activeLookup.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amountInput, activeLookup]);

  // Drives the too-many-decimals hint (Codex #1547 r2): true when the
  // entered amount's fractional part exceeds what the token supports —
  // the case `amountWei` silently rejects above.
  const tooManyDecimals = useMemo(() => {
    if (!amountInput || !activeLookup || activeLookup.rawUnits) return false;
    const m = /^\d+\.(\d+)$/.exec(amountInput);
    return m !== null && m[1].length > activeLookup.decimals;
  }, [amountInput, activeLookup]);

  useEffect(() => {
    if (!validToken || !address || !publicClient || !walletChain) {
      setLookup(null);
      setLookupFailed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // One pinned block for the balance/tracked pair — the surplus
        // must not straddle a deposit landing mid-read.
        const blockNumber = await publicClient.getBlockNumber();
        const token = tokenInput as `0x${string}`;
        // symbol()/decimals() are OPTIONAL in ERC-20 (Codex #1547 r1):
        // catch each INDIVIDUALLY so a metadata-less token stays
        // recoverable — decimals missing → raw base units; symbol
        // missing → shortened address. The vault/balance reads are the
        // load-bearing ones and still fail the whole lookup.
        //
        // ONLY a TRANSPORT failure re-throws (Codex #1547 r10, widened
        // in r15). Catching every failure meant a passing RPC error
        // read as "this token has no decimals", so an ordinary
        // 18-decimal token parsed at 0 decimals and a user who typed
        // `1` signed for a single base unit. A transport failure
        // therefore RE-THROWS into the outer catch, which is the
        // existing lookup-failed path — an honest "we couldn't read
        // this token's details" the user can retry out of. Every other
        // failure, decoding failures included, is the token being what
        // it is, and takes the fallback.
        const absentOrRethrow = (err: unknown): null => {
          if (isOptionalMetadataUnavailable(err)) return null;
          throw err;
        };
        // Legacy `bytes32` symbol (Codex #1547 r15): MKR and its
        // pre-standard contemporaries return a fixed 32-byte word, so
        // the ABI-`string` read above fails to DECODE something the
        // contract did answer. One extra read with the bytes32 shape
        // recovers the real ticker instead of falling back to the
        // shortened address. It costs nothing on the happy path — it
        // runs only inside the failed read's catch, still inside the
        // same parallel batch as the decimals/vault reads.
        const symbolWithBytes32Fallback = publicClient
          .readContract({
            address: token,
            abi: ERC20_META_ABI,
            functionName: 'symbol',
            blockNumber,
          })
          .catch((err: unknown) => {
            if (!isOptionalMetadataUnavailable(err)) throw err;
            return publicClient
              .readContract({
                address: token,
                abi: ERC20_SYMBOL_BYTES32_ABI,
                functionName: 'symbol',
                blockNumber,
              })
              // `size: 32` trims the right-hand zero padding a bytes32
              // ticker carries; whatever survives goes through the same
              // sanitizer + short-address fallback as a string symbol.
              .then((raw) => hexToString(raw as Hex, { size: 32 }))
              .catch(absentOrRethrow);
          });
        const [symRes, decRes, vault] = await Promise.all([
          symbolWithBytes32Fallback,
          publicClient
            .readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: 'decimals',
              blockNumber,
            })
            .catch(absentOrRethrow),
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getUserVaultAddress',
            args: [address],
            blockNumber,
          }) as Promise<`0x${string}`>,
        ]);
        const rawUnits = decRes === null;
        const decimals = rawUnits ? 0 : Number(decRes);
        // Sanitized at the source (Codex #1547 r3) so every consumer —
        // form meta, review card, success card — gets the scrubbed
        // string. A symbol that sanitizes to NOTHING falls back to the
        // shortened address, same as a missing symbol().
        const sanitizedSymbol =
          symRes === null ? '' : sanitizeTokenSymbol(symRes as string);
        const symbol = sanitizedSymbol === '' ? shortAddress(token) : sanitizedSymbol;
        let surplus = 0n;
        if (vault.toLowerCase() !== ZERO_ADDRESS) {
          const [bal, tracked] = await Promise.all([
            publicClient.readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: 'balanceOf',
              args: [vault],
              blockNumber,
            }) as Promise<bigint>,
            publicClient.readContract({
              address: walletChain.diamondAddress,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getProtocolTrackedVaultBalance',
              args: [address, token],
              blockNumber,
            }) as Promise<bigint>,
          ]);
          surplus = bal > tracked ? bal - tracked : 0n;
        }
        if (cancelled) return;
        // ONE atomic write, stamped with the token it was queried for
        // (Codex #1547 r1) — consumers gate on that stamp.
        setLookup({ token: tokenInput, symbol, decimals, rawUnits, surplus });
        setLookupFailed(false);
      } catch {
        if (cancelled) return;
        setLookup(null);
        setLookupFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [validToken, tokenInput, address, publicClient, walletChain]);

  const canReview =
    validToken &&
    validSource &&
    amountWei !== null &&
    activeLookup !== null &&
    amountWei <= activeLookup.surplus;

  async function signAndSubmit() {
    // Capture the identity generation at entry (Codex #1547 r3). Every
    // state commit below re-checks it — if the account or chain changed
    // while an await was pending, the reset effect bumped genRef and
    // this flow must fall silent instead of committing a step, error,
    // lookup, or tx link that belongs to the previous identity.
    const gen = genRef.current;
    // Mutex claim is generation-keyed (Codex #1547 r4): a claim left by
    // a PREVIOUS identity's still-running flow doesn't block the new
    // identity (its generation no longer matches), so an identity reset
    // can never permanently jam submission.
    if (inFlightRef.current === gen) return;
    inFlightRef.current = gen;
    // THIS attempt's reservation identity (Codex #1547 r10) — minted
    // before anything is written, and the only thing every later
    // clear/update on the persisted record matches against.
    const attemptId = newAttemptId();
    // Set once writeContract RETURNS a hash (Codex #1547 r4): from that
    // moment the tx is broadcast and may mine even if the receipt wait
    // (or anything after it) throws — the catch below must not bounce
    // back to review with the sign button re-armed.
    let submittedTxHash: Hex | null = null;
    // Set the moment the SIGNATURE exists and the send has been handed
    // to the wallet (Codex #1547 r8). From then on a rejection cannot
    // prove the transaction never went out — only a READ receipt can —
    // so the catch must land on the pending card, hash or no hash.
    // Cleared again only by a definitively-read reverted receipt.
    let attemptSigned = false;
    // Identity-matched clear for THIS attempt's persisted record, made
    // available to the catch (Codex #1547 r9). Assigned the moment the
    // record exists; the explicit-rejection branch is its only caller
    // outside the try.
    let forgetSignedAttempt: ((hash: Hex | null) => void) | null = null;
    // What a terminal card needs beyond the receipt (Codex #1547 r5) —
    // captured alongside the hash so the pending card can hand it to
    // the reconcile action.
    let submittedCtx: SubmittedContext | null = null;
    // Did the wallet replace the submitted tx while we waited, and HOW
    // (Codex #1547 r5, reason retained in r7)? A one-field OBJECT, not
    // a `let` — a value assigned only inside a callback reads as
    // never-reassigned to TypeScript's control-flow analysis at the
    // later comparison.
    const replacement: { reason: 'repriced' | 'cancelled' | 'replaced' | null } =
      { reason: null };
    // The identity every terminal card this flow builds is TAGGED with
    // (Codex #1547 r13) — the wallet and chain the recovery was signed
    // for, not whoever is connected by the time a card renders. Assigned
    // the moment the connection is known; the catch below reads it, and
    // it is still NULL only on the paths where nothing was ever signed.
    let cardOwner: StepOwner | null = null;
    setError(null);
    try {
      if (!walletClient || !publicClient || !address || !walletChain) {
        throw new Error(copy.errors.walletConnectFirst);
      }
      const snapshot = activeLookup;
      if (!snapshot || amountWei === null) {
        // Unreachable through the UI (canReview gates the review step),
        // but never sign from a stale snapshot.
        throw new Error(copy.recover.errSurplusMoved);
      }
      const diamond = walletChain.diamondAddress;
      const owner = stepOwnerOf(address, walletChain.chainId);
      cardOwner = owner;
      const token = snapshot.token as `0x${string}`;
      const declaredSource = sourceInput as `0x${string}`;
      const amount = amountWei;

      // Mirror of the form gate (Codex #1547 r9) — never sign an
      // ownership declaration naming the zero address, whatever route
      // reached this call.
      if (
        declaredSource.toLowerCase() === ZERO_ADDRESS ||
        token.toLowerCase() === ZERO_ADDRESS
      ) {
        throw new Error(copy.recover.errZeroAddress);
      }

      // Lock the review controls for the whole pre-sign-check + wallet
      // prompt window (Codex #1547 r1) — every abort path below
      // restores the review step alongside its error.
      if (genRef.current !== gen) return;
      setStep({ kind: 'signing' });
      const abortToReview = (message: string) => {
        // Stale-generation aborts commit nothing (Codex #1547 r3).
        if (genRef.current !== gen) return;
        setStep({ kind: 'review' });
        setError(message);
      };

      // (a) Live oracle answerability — the mount-time probe may be
      // minutes stale; re-run the same two-step check now, fail-safe.
      //
      // The two failure shapes stay DISTINCT here (Codex #1547 r7),
      // exactly as they do on the mount probe: a THROWN read is a
      // passing network problem the user can retry out of, a
      // confirmed-zero oracle is a permanent property of the network.
      // Collapsing them into one `false` told someone on a flaky RPC
      // that recovery would never work on this network. Neither may
      // proceed to sign — the fail-CLOSED behaviour is unchanged; only
      // the message and the blocked-state card differ. Both also
      // refresh `oracleState` from this fresh observation, so the gate
      // the user is left looking at matches what we just read.
      let oracleLive: boolean;
      try {
        oracleLive = await probeSanctionsOracle(publicClient, diamond);
      } catch {
        if (genRef.current === gen) {
          // Refill the auto-retry budget: this is a NEW observation,
          // not a continuation of an earlier failing chain.
          oracleAutoRetriesRef.current = 0;
          setOracleState('unreachable');
        }
        abortToReview(copy.recover.errOracleUnreachable);
        return;
      }
      if (!oracleLive) {
        if (genRef.current === gen) setOracleState('unset');
        abortToReview(copy.recover.errOracleUnset);
        return;
      }

      // (b) Live re-screen of the connected wallet itself — the hook's
      // cached read can be up to five minutes old; a flagged wallet
      // must not reach the wallet prompt.
      //
      // FAIL-CLOSED (Codex #1547 r8): the default posture is fail-OPEN
      // ("the contract screens this path anyway"), which is wrong here
      // — we just proved, one check above, that the screening oracle
      // is the thing deciding this transaction's outcome, and an
      // unreadable wallet-specific query is the SAME class of failure
      // as an unreadable availability probe. Waving it through let a
      // user sign against a screen nobody could read. So an unreadable
      // screen aborts into the same retryable blocked treatment the
      // availability probe gets, and a FLAGGED wallet aborts with its
      // own definite message.
      try {
        await assertWalletNotSanctionedLive(publicClient, diamond, address, {
          failClosed: true,
        });
      } catch (err) {
        // Distinguish the two verdicts by the message the helper
        // throws: a read failure is a passing network problem the user
        // can retry out of (and should leave the page's own gate
        // showing that), a flagged wallet is a settled fact.
        const unreadableScreen =
          err instanceof Error &&
          err.message === copy.errors.sanctionsCheckRetry;
        if (unreadableScreen && genRef.current === gen) {
          // Refill the auto-retry budget: a NEW observation, exactly as
          // the availability probe's own catch does.
          oracleAutoRetriesRef.current = 0;
          setOracleState('unreachable');
        }
        abortToReview(captureTxError(err));
        return;
      }

      // (c) The surplus cap, re-read at ONE fresh block (Codex #1547
      // r1) — the reviewed amount may exceed what is recoverable NOW
      // (a deposit reconciled, another recovery landed).
      const blockNumber = await publicClient.getBlockNumber();
      const vault = (await publicClient.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getUserVaultAddress',
        args: [address],
        blockNumber,
      })) as `0x${string}`;
      let liveSurplus = 0n;
      if (vault.toLowerCase() !== ZERO_ADDRESS) {
        const [bal, tracked] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: ERC20_META_ABI,
            functionName: 'balanceOf',
            args: [vault],
            blockNumber,
          }) as Promise<bigint>,
          publicClient.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getProtocolTrackedVaultBalance',
            args: [address, token],
            blockNumber,
          }) as Promise<bigint>,
        ]);
        liveSurplus = bal > tracked ? bal - tracked : 0n;
      }
      if (amount > liveSurplus) {
        // Refresh the keyed lookup with the LIVE surplus (Codex #1547
        // r2) — without this the stale cap keeps showing the old
        // maximum and `canReview` stays green for an amount the chain
        // will never accept, looping the user through the same abort
        // until a full reload. Same token stamp, so the atomic-lookup
        // gate still holds. Guarded (Codex #1547 r3): a stale flow must
        // not plant a previous token's lookup under the new identity.
        if (genRef.current !== gen) return;
        setLookup({ ...snapshot, surplus: liveSurplus });
        abortToReview(copy.recover.errSurplusMoved);
        return;
      }

      // Deadline from CHAIN time, not device time (Codex #1547 r1) —
      // a skewed device clock could produce an already-expired (or
      // far-future) deadline the user still signs.
      const chainNow = (await publicClient.getBlock()).timestamp;
      const deadline = chainNow + BigInt(RECOVERY_DEADLINE_SECONDS);

      const [nonce, ackTextHash, liveDomainSeparator] = await Promise.all([
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'recoveryNonce',
          args: [address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'recoveryAckTextHash',
        }) as Promise<Hex>,
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'recoveryDomainSeparator',
        }) as Promise<Hex>,
      ]);

      // (d) NEVER sign an unverifiable hash (Codex #1547 r1): the
      // displayed declaration must hash to the on-chain constant, or
      // the user would be attesting to text they were not shown.
      if (
        keccak256(stringToBytes(RECOVERY_ACK_TEXT)).toLowerCase() !==
        ackTextHash.toLowerCase()
      ) {
        abortToReview(copy.recover.errAckTextDrift);
        return;
      }

      const domain = {
        name: 'Vaipakam Recovery',
        version: '1',
        chainId: walletChain.chainId,
        verifyingContract: diamond,
      } as const;

      // (e) Domain validation (Codex #1547 r1): a drifted separator
      // (renamed domain, bumped version, proxy migration) makes the
      // signature unusable — surface that BEFORE the wallet prompt.
      // `types` is REQUIRED by viem's hashDomain (it does not derive
      // the field list); this shape must mirror the contract's
      // EIP712_DOMAIN_TYPEHASH field order exactly.
      if (
        hashDomain({
          // Same domain object the signature uses; chainId widened to
          // bigint because the explicit uint256 field type demands it
          // (encodes identically).
          domain: { ...domain, chainId: BigInt(domain.chainId) },
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          },
        }).toLowerCase() !== liveDomainSeparator.toLowerCase()
      ) {
        abortToReview(copy.recover.errDomainDrift);
        return;
      }

      // (f) CLAIM the reservation — re-read, then WRITE — BEFORE the
      // wallet prompt opens (Codex #1547 r10, tightening r8).
      //
      // r8 only READ here and wrote the record after the signature came
      // back. Two tabs could therefore both pass this read, and the
      // slower signature then wrote its record over the faster one's;
      // because both attempts share the same recovery nonce, the loser's
      // later rejection deleted the WINNER's record by nonce match — the
      // only durable lock over a transaction that was already live.
      //
      // So the record is the reservation: claimed hashless before the
      // prompt, stamped with this attempt's own id, and released again
      // if the signature never happens. Everything the record needs is
      // already known (the signed nonce and deadline were read above),
      // and the read→write gap is now a couple of synchronous
      // statements rather than a wallet round-trip.
      //
      // r11 makes the claim ATOMIC. Shrinking the read→write gap was
      // not the same as closing it: two tabs could still both read "no
      // record", both write their own id, and both sign and broadcast.
      // `claimPendingRecovery` holds a cross-tab mutex across that pair,
      // so exactly one tab may claim an identity — see its doc comment.
      const persistedRecord: PendingRecoveryRecord = {
        txHash: null,
        attemptId,
        token,
        declaredSource,
        amount: amount.toString(),
        symbol: snapshot.symbol,
        decimals: snapshot.decimals,
        recoveryNonce: nonce.toString(),
        // The signed expiry travels with the record (Codex #1547 r7) —
        // a later reconcile can only call an absent transaction dead
        // once chain time is past it.
        deadline: deadline.toString(),
      };
      // Claimed under the identity being signed for (not whoever is
      // connected by the time a later line runs).
      const claim = await claimPendingRecovery(
        walletChain.chainId,
        address,
        persistedRecord,
      );
      if (!claim.claimed) {
        if (genRef.current !== gen) return;
        // A record we can read describes the in-flight attempt, so show
        // its card; a lock held with no record yet (the other tab is
        // between its read and its write) has nothing to render, so fall
        // back to review. Same message either way — one attempt at a
        // time per wallet is the rule being enforced.
        if (claim.existing !== null) {
          setStep(stepFromRecord(claim.existing, owner));
          setError(copy.recover.errAttemptInFlight);
        } else {
          abortToReview(copy.recover.errAttemptInFlight);
        }
        return;
      }
      // A REFUSED write is surfaced, never swallowed (Codex #1547 r8) —
      // it does not block the recovery, it warns that a reload will lose
      // the record.
      if (!claim.persisted && genRef.current === gen) setPersistFailed(true);
      // Every later clear/update matches on this attempt's ID, so a
      // record another tab wrote is untouchable from here.
      const forgetPending = (hash: Hex | null) =>
        clearPendingRecoveryIfMatches(
          walletChain.chainId,
          address,
          hash,
          nonce.toString(),
          attemptId,
        );
      // Exposed to the catch (Codex #1547 r9) so the explicit-rejection
      // branch can drop THIS attempt's record.
      forgetSignedAttempt = forgetPending;

      let signature: Hex;
      try {
        signature = await walletClient.signTypedData({
          account: address,
          domain,
          types: RECOVERY_TYPES,
          primaryType: 'RecoveryAcknowledgment',
          message: {
            user: address,
            token,
            declaredSource,
            amount,
            nonce,
            deadline,
            ackTextHash,
          },
        });
      } catch (err) {
        // The signature never happened, so nothing can execute — the
        // reservation must not outlive it (Codex #1547 r10), or a
        // declined prompt would lock this wallet out of recovery until
        // the deadline it never signed. Identity-matched like every
        // other clear.
        forgetPending(null);
        throw err;
      }

      // Identity check BEFORE anything is broadcast (Codex #1547 r10).
      // If the account or chain changed while the prompt was open, the
      // reset effect bumped genRef; nothing has gone out (writeContract
      // hasn't run), so release the reservation and fall silent instead
      // of leaving the old identity locked until its deadline.
      if (genRef.current !== gen) {
        forgetPending(null);
        return;
      }

      submittedCtx = {
        attemptId,
        token,
        declaredSource,
        amount,
        symbol: snapshot.symbol,
        decimals: snapshot.decimals,
        recoveryNonce: nonce,
        deadline,
      };
      // From here a rejection is NOT provably pre-broadcast (with the
      // one exception the catch handles — an explicit wallet rejection
      // of the TRANSACTION, Codex #1547 r9).
      attemptSigned = true;

      setStep({ kind: 'submitting' });
      const txHash = await walletClient.writeContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'recoverStuckERC20',
        args: [token, declaredSource, amount, deadline, signature],
        chain: walletClient.chain,
        account: address,
      });
      submittedTxHash = txHash; // broadcast — no return-to-review past here (Codex #1547 r4)
      // Upgrade the hashless record now that the wallet named the
      // transaction — the by-hash probes become available again.
      //
      // CONDITIONAL (Codex #1547 r9, id-matched in r10): only while the
      // stored record is still THIS attempt. A wallet that answered late
      // may be returning into a world where another tab already
      // reconciled this attempt and recorded a NEW one; that record must
      // survive untouched.
      if (
        !updatePendingRecoveryHashIfMatches(
          walletChain.chainId,
          address,
          null, // match the hashless record this attempt persisted
          nonce.toString(),
          txHash,
          attemptId,
        )
      ) {
        if (genRef.current === gen) setPersistFailed(true);
      }
      // Wallet REPLACEMENTS are followed, not lost (Codex #1547 r5): a
      // speed-up / cancel from the wallet mines a DIFFERENT hash under
      // the same nonce. Without `onReplaced` the wait would give up on
      // the original hash and every outcome card + explorer link would
      // point at a transaction that never mined.
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        onReplaced: (event) => {
          // Every reason means the hash the user was shown is not the
          // one that mines — but the REASON is kept (Codex #1547 r7),
          // because only 'cancelled' licenses the definite "nothing was
          // recovered" copy (narrowed in r8). A 'repriced' replacement
          // carries the SAME calldata, destination and value per viem,
          // so it is still the recovery transaction; a generic
          // 'replaced' only says destination/value/input DIFFER, which
          // a second recovery with other parameters also satisfies.
          replacement.reason = event.reason;
          // The hash the record currently carries — matched against
          // storage below BEFORE the marker moves on.
          const persistedHash = submittedTxHash;
          // Keep the post-broadcast marker on the hash that is actually
          // live, so a later throw parks the pending card on it.
          submittedTxHash = event.transaction.hash;
          // Re-point the PERSISTED record at the live hash too (Codex
          // #1547 r6) — a receipt lookup after a reload then resolves
          // directly instead of falling back to the nonce comparison.
          // Identity-matched like every other write on this path (Codex
          // #1547 r9): a record another tab has since replaced is left
          // alone rather than stamped with this attempt's hash.
          if (
            !updatePendingRecoveryHashIfMatches(
              walletChain.chainId,
              address,
              persistedHash,
              nonce.toString(),
              event.transaction.hash,
              attemptId,
            )
          ) {
            if (genRef.current === gen) setPersistFailed(true);
          }
        },
      });
      // From here on the RECEIPT's hash is the authority (Codex #1547
      // r5) — it equals `txHash` in the normal case and the
      // replacement's hash when the wallet sped it up or cancelled it.
      const minedHash = receipt.transactionHash;
      submittedTxHash = minedHash;
      // waitForTransactionReceipt resolves on REVERTED receipts too
      // (Codex #1547 r1) — decoding events out of one would misread
      // "no event" as a missing outcome. Fail loud first. The receipt
      // WAS read here, so the outcome is definitive (reverted, nothing
      // moved) — clearing the submitted-hash marker lets the catch use
      // the normal return-to-review path for this one post-broadcast
      // error (Codex #1547 r4).
      if (receipt.status !== 'success') {
        forgetPending(minedHash); // settled: nothing to rehydrate (Codex #1547 r6)
        submittedTxHash = null;
        // A READ reverted receipt is the one post-signature fact that
        // definitively rules out a live broadcast (Codex #1547 r8), so
        // the signed-attempt marker is released too.
        attemptSigned = false;
        throw new Error(copy.recover.errTxReverted);
      }

      // The contract deliberately does NOT revert on the sanctioned-
      // source path — read the outcome from the emitted event.
      const decodedOutcome = decodeRecoveryOutcome(receipt.logs, diamond);
      // Built from the EVENT's own arguments where it carries them
      // (Codex #1547 r10) — this receipt may belong to a transaction the
      // wallet replaced, whose amount and declared source need not be
      // the ones submitted here. `submittedCtx` is only the fallback.
      const outcome: Step | null =
        decodedOutcome === null
          ? null
          : outcomeStepFrom(
              decodedOutcome,
              minedHash,
              submittedCtx ?? undefined,
              owner,
            );
      // The receipt was READ, so this transaction's fate is settled
      // whichever branch runs below — drop the persisted record
      // (Codex #1547 r6) so a later mount doesn't rehydrate a pending
      // card over an outcome the user has already been shown. In
      // particular the fork spec's happy path must leave nothing
      // behind for the next run.
      forgetPending(minedHash);
      if (outcome) {
        // Own-receipt floor (Codex #1547 r1): a recovery moves vault
        // balances (and a ban flips sanctions-derived state) — push the
        // standard invalidation set to this and every other tab. The
        // banned outcome additionally carries the sanctions root so the
        // flagged-state banners refresh without waiting out the cache.
        // The invalidation publishes even for a stale generation (the
        // on-chain mutation happened regardless of who is connected
        // now); only the STEP commit is identity-bound (Codex #1547 r3).
        publishReceiptInvalidation(
          queryClient,
          outcome.kind === 'banned' ? ['sanctions'] : [],
        );
        if (genRef.current !== gen) return;
        setStep(outcome);
      } else {
        // Success receipt but NO decodable outcome event (Codex #1547
        // r3): this previously bounced back to review with CONFIRM
        // still armed and SKIPPED invalidation — inviting a double
        // submit of a recovery that may already have completed, over
        // stale balances. Terminal card instead: invalidate (a success
        // receipt means state moved), then park on the unknown-outcome
        // step with the tx link and no sign-again path.
        publishReceiptInvalidation(queryClient);
        if (genRef.current !== gen) return;
        // ONLY a CANCEL licenses the definite "nothing was recovered"
        // copy (Codex #1547 r8, narrowing r5). viem's replacement
        // reasons are not equally informative:
        //   'cancelled' — the wallet sent a zero-value self-transfer
        //                 under the same nonce: nothing was recovered,
        //                 and that IS a fact.
        //   'repriced'  — same calldata, destination and value at a
        //                 higher fee (r7): the transaction that mined
        //                 IS this recovery, so an event-less success
        //                 receipt is an unreadable OUTCOME.
        //   'replaced'  — means only that destination, value or input
        //                 DIFFER. Another `recoverStuckERC20` with
        //                 different parameters satisfies that exactly,
        //                 so it is NOT proof no recovery happened.
        // Everything but 'cancelled' therefore falls through to the
        // outcome-unknown card.
        setStep({
          kind: 'unknownOutcome',
          owner,
          txHash: minedHash,
          replaced: replacement.reason === 'cancelled',
        });
      }
    } catch (err) {
      // Post-SIGNATURE failure (Codex #1547 r4, widened in r8): either
      // writeContract returned a hash (the tx is in the mempool and may
      // still mine) or the send was handed to the wallet and the reply
      // never came back (it may equally be in the mempool — we simply
      // don't know its hash). Returning to review would re-arm the sign
      // button over a recovery that may yet complete. Invalidate (state
      // may move any moment) and park on the terminal unknown-outcome
      // card instead; the `pending` flag picks the "submitted but
      // unconfirmed" body, and a NULL hash picks its hashless variant.
      // The invalidation publishes even for a stale generation (same
      // rule as the decoded outcomes); only the step commit is
      // identity-bound.
      //
      // ONE exception (Codex #1547 r9): the user EXPLICITLY rejected the
      // transaction in the wallet. That is a positive fact — the send
      // was never made — and treating it as ambiguous stranded the flow
      // on a pending card until the signed 30-minute deadline expired,
      // over a transaction that does not exist. The signature alone
      // can't execute anything (`recoverStuckERC20` requires the
      // recovered signer to equal msg.sender, so nobody can relay it),
      // so drop this attempt's record — identity-matched, never a newer
      // one — and go back to review with the normal rejection message.
      // Ambiguous transport failures keep the pending treatment below.
      if (
        submittedTxHash === null &&
        attemptSigned &&
        isUserRejectedTransaction(err)
      ) {
        forgetSignedAttempt?.(null);
        if (genRef.current !== gen) return; // Codex #1547 r3
        setStep({ kind: 'review' });
        setError(captureTxError(err));
        return;
      }
      // `cardOwner` is set the moment the connection is validated, so it
      // is never null on a path that got as far as signing (Codex #1547
      // r13) — the check is what lets the card be TAGGED without an
      // assertion, and its false arm falls through to the pre-broadcast
      // handling below.
      if ((submittedTxHash !== null || attemptSigned) && cardOwner !== null) {
        publishReceiptInvalidation(queryClient);
        if (genRef.current !== gen) return;
        // Carry the submitted context (Codex #1547 r5) so the pending
        // card's reconcile action can render a full success/banned
        // card once the receipt becomes readable.
        setStep({
          kind: 'unknownOutcome',
          owner: cardOwner,
          txHash: submittedTxHash,
          pending: true,
          ctx: submittedCtx ?? undefined,
        });
        return;
      }
      // Pre-broadcast errors (checks, signature, submission rejection,
      // definitive revert) keep the return-to-review behaviour.
      if (genRef.current !== gen) return; // Codex #1547 r3
      setStep({ kind: 'review' });
      setError(captureTxError(err));
    } finally {
      // Only release a claim that is still OURS (Codex #1547 r4): after
      // an identity reset a new flow may hold the mutex under the new
      // generation — this old closure must not clear it.
      if (inFlightRef.current === gen) inFlightRef.current = null;
    }
  }

  /**
   * The PENDING card's only way forward (Codex #1547 r5).
   *
   * A plain "Start over" here would DISCARD the broadcast hash while
   * the transaction may still be mining — and a fresh attempt would
   * read the (already incremented) recovery nonce and the remaining
   * surplus, letting the user recover a SECOND time without ever
   * intending to. So the pending card re-reads the receipt for the
   * stored hash instead: only once the receipt resolves — with any
   * outcome — does a fresh-form action become available.
   */
  async function reconcilePending(txHash: Hex | null, ctx?: SubmittedContext) {
    // Identity generation, same discipline as signAndSubmit (Codex
    // #1547 r3): an account/chain change mid-read must not commit a
    // step belonging to the previous identity.
    const gen = genRef.current;
    // Generation-KEYED mutex (Codex #1547 r7), mirroring inFlightRef:
    // a claim left behind by a PREVIOUS identity's still-running read
    // doesn't block the new identity, and this closure's finally can
    // only release its OWN claim.
    if (reconcileRef.current === gen) return;
    if (!publicClient || !walletChain || !address) {
      setReconcileError(copy.errors.walletConnectFirst);
      return;
    }
    const diamond = walletChain.diamondAddress;
    const chainId = walletChain.chainId;
    const account = address;
    // The identity every card this read produces is tagged with (Codex
    // #1547 r13) — the wallet the receipt is being read FOR.
    const owner = stepOwnerOf(account, chainId);
    // Identity-matched clear (Codex #1547 r8) — never delete a NEWER
    // record another tab wrote for this wallet.
    const forgetPending = () =>
      clearPendingRecoveryIfMatches(
        chainId,
        account,
        txHash,
        ctx?.recoveryNonce.toString(),
        ctx?.attemptId,
      );
    reconcileRef.current = gen;
    setReconcileClaim(gen);
    setReconcileError(null);
    try {
      // getTransactionReceipt, NOT waitForTransactionReceipt: this is a
      // user-driven "check now", so an unmined transaction must answer
      // immediately (it throws receipt-not-found) rather than hold the
      // button in a long poll.
      //
      // A MISSING receipt is not an error here (Codex #1547 r6): an
      // exact-hash lookup can NEVER resolve for a transaction the
      // wallet replaced, so this card would otherwise be a permanent
      // dead end — "check again" forever, with no way to a fresh form.
      // Fall through to the nonce adjudication below instead. Any
      // reason for the miss is treated the same, because the counter
      // read that follows is authoritative regardless of why the
      // receipt was unreadable.
      //
      // A HASHLESS record (Codex #1547 r8) skips every by-hash probe
      // outright — there is no hash to look up — and goes straight to
      // the counter-vs-deadline adjudication.
      const receipt =
        txHash === null
          ? null
          : await publicClient
              .getTransactionReceipt({ hash: txHash })
              .catch(() => null);
      if (receipt === null) {
        await reconcileWithoutReceipt(txHash, ctx, {
          gen,
          chainId,
          account,
          owner,
          forgetPending,
        });
        return;
      }
      const decoded =
        receipt.status === 'success'
          ? decodeRecoveryOutcome(receipt.logs, diamond)
          : null;
      // The receipt was read, so on-chain state is settled either way —
      // invalidate regardless of who is connected now (same rule the
      // submit path uses), and drop the persisted record (Codex #1547
      // r6) so no later mount rehydrates a pending card over a settled
      // transaction. Only the STEP commit is identity-bound.
      publishReceiptInvalidation(
        queryClient,
        decoded?.kind === 'banned' ? ['sanctions'] : [],
      );
      forgetPending();
      if (genRef.current !== gen) return;
      const minedHash = receipt.transactionHash;
      if (receipt.status !== 'success') {
        // Definitive: the transaction mined and REVERTED — nothing
        // moved and the on-chain recovery nonce is untouched, so a
        // retry is safe.
        //
        // WHERE to land depends on whether a review card can even be
        // rendered (Codex #1547 r8). When this reconcile started from a
        // REHYDRATED record — a reload, or a switch back to this
        // identity — the form inputs and the token lookup behind them
        // are empty, so 'review' would show a card with no token, no
        // sender and no amount, and its sign button permanently
        // unusable. Fall back to the fresh FORM in that case and carry
        // the reason across; the reviewed fields are only intact when
        // the reconcile ran in the same session that filled them.
        if (canReview) {
          setStep({ kind: 'review' });
        } else {
          setConfirmInput('');
          setStep({ kind: 'form' });
        }
        setError(copy.recover.errTxReverted);
        return;
      }
      // The EVENT's own values lead (Codex #1547 r10). This card is the
      // one most likely to describe a REPLACED transaction — the whole
      // reason the reconcile exists — so building it from the original
      // submission would state the amount and the declared source the
      // user submitted next to an explorer link showing others. The
      // stored context is the fallback for what the event doesn't carry,
      // and an event that names a token the record doesn't know is
      // rendered in that token's own terms instead of this one's.
      const outcome =
        decoded === null
          ? null
          : outcomeStepFrom(decoded, minedHash, ctx, owner);
      if (outcome) {
        setStep(outcome);
        return;
      }
      // Receipt read but no outcome event decoded — the NON-pending
      // unknown-outcome card, which does offer a fresh start because
      // the transaction's fate is now settled.
      setStep({ kind: 'unknownOutcome', owner, txHash: minedHash });
    } catch {
      // Still unreadable — stay exactly where we are, hash intact.
      if (genRef.current !== gen) return;
      setReconcileError(copy.recover.reconcileStillPending);
    } finally {
      // Release only a claim that is still OURS (Codex #1547 r7) —
      // after an identity reset a new flow may already hold it under
      // the new generation, and this old closure must not clear that.
      if (reconcileRef.current === gen) {
        reconcileRef.current = null;
        setReconcileClaim((claim) => (claim === gen ? null : claim));
      }
    }
  }

  /**
   * Adjudicate a broadcast recovery whose RECEIPT cannot be read
   * (Codex #1547 r6) — the permanent state of any transaction the
   * wallet replaced, since an exact-hash lookup will never find the
   * replacement.
   *
   * The authority is the account's own on-chain recovery counter,
   * which `recoverStuckERC20` increments EXACTLY ONCE per processed
   * attempt — on the successful path AND on the sanctioned-source ban
   * path (VaultFactoryFacet.sol ~892/908), and never on a revert. So:
   *
   *   live > signed  → the attempt (or its replacement) was processed.
   *                    Terminal AND LOCKED (Codex #1547 r7): no fresh
   *                    recovery from a claim we can't verify by
   *                    receipt, and the verdict is PERSISTED so a
   *                    reload can't step around the lock. The copy
   *                    must own that it can't say WHICH of the two
   *                    outcomes it was.
   *   live == signed → nothing consumed that nonce YET. That alone is
   *                    not enough to call the transaction dead (see
   *                    below) — only positive absence plus an expired
   *                    signature is.
   *   read failed    → decide nothing; stay pending.
   *
   * "Nothing was recovered" needs POSITIVE evidence (Codex #1547 r7).
   * The previous shape treated a FAILED `getTransaction` read as proof
   * the transaction was gone and cleared the record — an RPC hiccup
   * could therefore hand the user a fresh form over a recovery still
   * sitting in the mempool, which is the exact double-recovery this
   * card exists to prevent. So the verdict now needs all three of:
   *
   *   1. the recovery counter is unchanged (nothing processed), AND
   *   2. the node positively reports the transaction as NOT FOUND (an
   *      unreadable probe, or a transaction that is merely queued,
   *      keeps the card pending), AND
   *   3. chain time is past the DEADLINE the signature committed to —
   *      after which the contract rejects it, so no re-broadcast of
   *      that transaction can ever succeed.
   *
   * Until (3) holds, an absent transaction is still resurrectable: a
   * wallet can re-broadcast the very same signed payload and it would
   * be accepted. The card says so and names when we WILL know.
   *
   * The account-nonce refinement (comparing the sender's transaction
   * count against the submitted transaction's own nonce) is
   * deliberately skipped: it would need a `getTransaction` round-trip
   * at broadcast time, and it cannot change either verdict above — the
   * recovery counter already answers "did a recovery happen".
   */
  async function reconcileWithoutReceipt(
    /** NULL for a signed attempt the wallet never named (Codex #1547
     *  r8): every by-hash probe is skipped and the verdict rests on the
     *  recovery counter and the signed deadline alone. */
    txHash: Hex | null,
    ctx: SubmittedContext | undefined,
    scope: {
      gen: number;
      chainId: number;
      account: `0x${string}`;
      /** The identity every card this verdict produces is tagged with
       *  (Codex #1547 r13). */
      owner: StepOwner;
      forgetPending: () => void;
    },
  ) {
    const { gen, chainId, account, owner, forgetPending } = scope;
    if (!publicClient || !walletChain) {
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    if (!ctx) {
      // No signed nonce to compare against (a record from before this
      // context was carried) — nothing can be concluded, so hold the
      // pending card rather than guess at a fund-moving outcome.
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    // A throw here propagates to reconcilePending's catch, which keeps
    // the card pending with the "still no confirmation" line — the
    // correct answer for an unreadable chain.
    const liveNonce = (await publicClient.readContract({
      address: walletChain.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'recoveryNonce',
      args: [account],
    })) as bigint;
    if (liveNonce > ctx.recoveryNonce) {
      // A recovery WAS processed. Balances moved on the success arm and
      // sanctions-derived state moved on the ban arm — and we can't
      // tell which — so publish the union, exactly as the banned
      // outcome does.
      //
      // The record is REWRITTEN, not dropped (Codex #1547 r7): this
      // verdict locks out a fresh recovery, and a lock that a page
      // reload clears is not a lock. Keyed to the identity that
      // broadcast it, so the write happens regardless of who is
      // connected now.
      //
      // CONDITIONAL (Codex #1547 r10), by the same rule the hash
      // upgrades use: only while storage still holds THIS attempt. The
      // unconditional write could stamp this verdict over a newer record
      // another tab wrote — turning that tab's live pending attempt into
      // a lock keyed to an older submission. When it doesn't match,
      // nothing is written; the local step below still shows the verdict
      // to this tab.
      const locked = writePendingRecoveryIfMatches(
        chainId,
        account,
        txHash,
        ctx.recoveryNonce.toString(),
        ctx.attemptId,
        {
          txHash,
          ...(ctx.attemptId === undefined ? {} : { attemptId: ctx.attemptId }),
          ...(ctx.token === undefined ? {} : { token: ctx.token }),
          declaredSource: ctx.declaredSource,
          amount: ctx.amount.toString(),
          symbol: ctx.symbol,
          decimals: ctx.decimals,
          recoveryNonce: ctx.recoveryNonce.toString(),
          ...(ctx.deadline === undefined
            ? {}
            : { deadline: ctx.deadline.toString() }),
          settled: 'executed',
        },
      );
      // A lock this browser refused to store is a lock a reload clears
      // (Codex #1547 r8) — say so rather than imply it survives.
      if (!locked && genRef.current === gen) setPersistFailed(true);
      publishReceiptInvalidation(queryClient, ['sanctions']);
      if (genRef.current !== gen) return;
      setStep({
        kind: 'unknownOutcome',
        owner,
        txHash,
        receiptless: 'executed',
        ctx,
      });
      return;
    }
    if (liveNonce < ctx.recoveryNonce) {
      // UNREADABLE, not "unchanged" (Codex #1547 r12). The recovery
      // counter is monotonic — the contract only ever increments it —
      // so a value BELOW the one this attempt was signed against cannot
      // describe the chain. It is proof of a bad read (a lagging or
      // load-balanced RPC serving stale state), not evidence about the
      // attempt. Falling through would let the branch below conclude
      // 'never processed' once the deadline passed and the hash read
      // absent, forgetting the record and permitting a second recovery
      // on the strength of an inconsistent read. Stay pending instead
      // and keep the record: a later, consistent read decides.
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    // Counter untouched: no recovery has run under this signature YET.
    // Establish where the transaction actually is before saying
    // anything stronger. THREE outcomes, kept apart on purpose:
    //   queued     — positively in the node, not yet mined: pending.
    //   absent     — the node positively reports it as not found.
    //   unreadable — the probe failed, or the transaction is mined but
    //                its receipt wasn't (a contradiction we can't
    //                resolve): decide NOTHING.
    //
    // A HASHLESS attempt (Codex #1547 r8) has nothing to probe — the
    // wallet never told us what it sent. Treat it as 'absent' and let
    // the DEADLINE do the deciding: an expired signature can no longer
    // be accepted by the contract, whatever the wallet did with it,
    // which is exactly the certainty this verdict needs.
    const presence =
      txHash === null
        ? ('absent' as const)
        : await publicClient
            .getTransaction({ hash: txHash })
            .then((tx) =>
              tx.blockNumber === null
                ? ('queued' as const)
                : ('unreadable' as const),
            )
            .catch((err: unknown) =>
              isTransactionNotFound(err)
                ? ('absent' as const)
                : ('unreadable' as const),
            );
    if (presence !== 'absent') {
      if (genRef.current !== gen) return;
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    // Absent — but an unexpired signature can still be re-broadcast by
    // any wallet holding it, so absence alone proves nothing. Without a
    // stored deadline (a record from an earlier build) we can never
    // reach the certainty this verdict needs: stay pending.
    if (ctx.deadline === undefined) {
      if (genRef.current !== gen) return;
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    // Chain time, not device time — the same rule the deadline was
    // MINTED under. An unreadable block keeps the card pending.
    let chainNow: bigint;
    try {
      chainNow = (await publicClient.getBlock()).timestamp;
    } catch {
      if (genRef.current !== gen) return;
      setReconcileError(copy.recover.reconcileStillPending);
      return;
    }
    if (chainNow <= ctx.deadline) {
      if (genRef.current !== gen) return;
      // Round UP so the user is never told to come back before the
      // signature has actually expired, and never told "0 minutes".
      const minutesLeft = Number((ctx.deadline - chainNow) / 60n) + 1;
      setReconcileError(
        copy.recover.reconcileAwaitingDeadline(String(minutesLeft)),
      );
      return;
    }
    // Gone, nothing was processed, and the signature can never be used
    // again — nothing moved on-chain, so there is no invalidation to
    // publish, and starting over is genuinely safe.
    forgetPending();
    if (genRef.current !== gen) return;
    setStep({ kind: 'unknownOutcome', owner, txHash, receiptless: 'never' });
  }

  /** Explorer link for a terminal card, built from the chain the card is
   *  TAGGED with (Codex #1547 r13) — never from whatever chain happens
   *  to be connected when it renders. Those are the same chain by the
   *  time a card survives the identity check above; sourcing the base
   *  from the tag is what makes that true by construction rather than
   *  by ordering. NULL for a chain the registry doesn't describe, which
   *  the render treats as "no link" instead of a half-built URL. */
  const explorerTx = (txHash: Hex, owner: StepOwner): string | null => {
    const base = getSupportedChain(owner.chainId)?.blockExplorer;
    return base === undefined ? null : `${base}/tx/${txHash}`;
  };

  /** The explorer anchor, or nothing when no link can be built. */
  const txLink = (txHash: Hex, owner: StepOwner, label: string) => {
    const href = explorerTx(txHash, owner);
    return href === null ? null : (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    );
  };

  // The review card stays mounted through 'signing' and 'submitting'
  // with every control locked (Codex #1547 r1) — unmounting it would
  // lose the user's context mid-wallet-prompt, and an enabled Back
  // button could fork the UI away from an in-flight signature.
  const reviewBusy = step.kind === 'signing' || step.kind === 'submitting';

  // Only a claim held by the CURRENT identity busies the button (Codex
  // #1547 r7) — a claim left behind by a previous account's still
  // running read must not disable the new account's card.
  const reconciling =
    reconcileClaim !== null && reconcileClaim === genRef.current;

  /** Back to a blank form, nothing carried over — the same shape the
   *  account/chain effect resets to. The persisted record is discarded
   *  so no reload resurrects a card the user has deliberately left
   *  (Codex #1547 r6/r7) — but only when it IS the attempt this card
   *  describes (Codex #1547 r8): a newer record another tab wrote for
   *  the same wallet must survive, or leaving one resolved card would
   *  silently disarm the other tab's live pending card. */
  const resetToFreshForm = () => {
    if (address && walletChain && step.kind === 'unknownOutcome') {
      clearPendingRecoveryIfMatches(
        walletChain.chainId,
        address,
        step.txHash,
        step.ctx?.recoveryNonce.toString(),
        step.ctx?.attemptId,
      );
    }
    clearToFreshForm();
  };

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.recover.title}</h1>
        <p className="page-lede">{copy.recover.lede}</p>
      </div>

      {/* The Help explainer is the intended way in — nudge anyone who
          landed here cold back to it before they touch anything. */}
      <p className="muted" style={{ margin: 0 }}>
        {copy.recover.helpFirst}{' '}
        <Link to="/help#stuck-tokens">{copy.chrome.nav.help}</Link>
      </p>

      {!address ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {copy.wallet.connectFirst}
          </p>
        </section>
      ) : !onSupportedChain || !walletChain ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.recover.wrongChain}</span>
        </div>
      ) : step.kind === 'success' ? (
        // Terminal outcomes render BEFORE the availability/sanctions
        // gates (Codex #1547 r2): after a ban the sanctions query
        // refetches and flags this wallet, and the generic sanctioned-
        // wallet gate below would replace the receipt-specific outcome
        // card (declared-source explanation + tx link) the user needs.
        <div className="banner banner-info" role="status">
          <CircleCheck aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.successTitle}</strong>
            <br />
            {/* exactAmountString, not formatTokenAmount (Codex #1547
                r3): the display formatter rounds to ~4 significant
                digits — the receipt must state the EXACT amount that
                was recovered.

                `unknownToken` (Codex #1547 r10): the event named a
                token this flow has no metadata for (the shape a
                wholesale wallet replacement can produce), so the amount
                is stated in that token's raw base units next to its
                address rather than dressed in another token's decimals
                and symbol. */}
            {step.unknownToken
              ? copy.recover.successBodyUnknownToken(
                  exactAmountString(step.amount, 0),
                  step.unknownToken,
                )
              : copy.recover.successBody(
                  exactAmountString(step.amount, step.decimals),
                  step.symbol,
                )}
            <br />
            {txLink(step.txHash, step.owner, copy.recover.viewTx)}
            <br />
            {/* A completed recovery must offer the way back to a blank
                form (Codex #1547 r15). This card is terminal and the
                route stays mounted, so without an explicit action a
                wallet holding a SECOND unsolicited token had to reload
                or navigate away and back to try again. Safe here in a
                way it is not on the executed-lock card: this outcome
                was DECODED from the receipt, so the attempt is fully
                accounted for, and a fresh flow re-reads the remaining
                surplus and signs its own declaration. */}
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 8 }}
              onClick={resetToFreshForm}
            >
              {copy.recover.recoverAnother}
            </button>
          </span>
        </div>
      ) : step.kind === 'banned' ? (
        // DELIBERATELY no start-over action here (Codex #1547 r15).
        // The success card above gets one, but a flagged wallet is
        // blocked protocol-wide until the declared address is
        // de-listed: `recoverStuckERC20` is a Tier-1 entry point, so a
        // fresh form here could only walk the user into another doomed
        // signature. Withholding the action leaves the standing
        // verdict — and the auto-unlock note — as the last word.
        <div className="banner banner-danger" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.bannedTitle}</strong>
            <br />
            {copy.recover.bannedBody(shortAddress(step.declaredSource))}{' '}
            {copy.recover.bannedAutoUnlock}
            <br />
            {txLink(step.txHash, step.owner, copy.recover.viewTx)}
          </span>
        </div>
      ) : step.kind === 'unknownOutcome' ? (
        // TERMINAL unknown-outcome card (Codex #1547 r3): success
        // receipt, no decodable outcome event. Never returns to review
        // — the recovery may already have completed, and re-arming the
        // sign button here invites a double submit. The `pending`
        // variant (Codex #1547 r4) covers a BROADCAST tx whose
        // confirmation couldn't be read; the `replaced` variant (Codex
        // #1547 r5) covers a wallet speed-up / cancel whose mined tx
        // carries no recovery event — a definite "nothing happened";
        // the `receiptless` variants (Codex #1547 r6) cover a
        // transaction with NO readable receipt at all, adjudicated
        // from the on-chain recovery counter instead.
        <div className="banner banner-warn" role="alert">
          <TriangleAlert aria-hidden />
          <span className="banner-body">
            <strong>
              {step.pending
                ? step.txHash === null
                  ? copy.recover.unknownOutcomeSignedTitle
                  : copy.recover.unknownOutcomePendingTitle
                : step.receiptless === 'executed'
                  ? copy.recover.recoveryLandedTitle
                  : step.receiptless === 'never'
                    ? copy.recover.notProcessedTitle
                    : step.replaced
                      ? copy.recover.replacedTitle
                      : copy.recover.unknownOutcomeTitle}
            </strong>
            <br />
            {/* Body picked by the variant (Codex #1547 r4 / r5 / r6): a
                broadcast-but-unconfirmed tx must not be described as
                "went through"; a replaced-then-mined tx that carries no
                recovery event must not be described as "the recovery
                may already have completed"; and a receipt-less verdict
                must name what the counter actually proves, without
                claiming a cause (replaced vs dropped) it can't see. */}
            {step.pending
              ? step.txHash === null
                ? copy.recover.unknownOutcomeSignedBody
                : copy.recover.unknownOutcomePendingBody
              : step.receiptless === 'executed'
                ? copy.recover.recoveryLandedBody
                : step.receiptless === 'never'
                  ? copy.recover.notProcessedBody
                  : step.replaced
                    ? copy.recover.replacedCancelledBody
                    : copy.recover.unknownOutcomeBody}
            <br />
            {/* Normally the hash that actually MINED (Codex #1547 r5) —
                for a replaced transaction that is the replacement, not
                the original the wallet dropped. On the receipt-less
                cards no mined hash is knowable, so the link is the
                stored SUBMISSION and is labelled as such (Codex #1547
                r6). When the wallet never returned a hash at ALL there
                is nothing to link (Codex #1547 r8) — say so instead of
                rendering a dead explorer URL. */}
            {step.txHash === null
              ? copy.recover.noTxLink
              : txLink(
                  step.txHash,
                  step.owner,
                  step.receiptless
                    ? copy.recover.viewOriginalTx
                    : copy.recover.viewTx,
                )}
            <br />
            {step.pending ? (
              // NO plain "start over" on the pending variant (Codex
              // #1547 r5): the transaction may have mined, and a fresh
              // flow would read the incremented nonce + the remaining
              // surplus and allow a SECOND unintended recovery. The
              // only action is re-reading this transaction's receipt;
              // a resolved receipt (any outcome) is what unlocks a
              // fresh form, by landing on another card.
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: 8 }}
                  disabled={reconciling}
                  onClick={() => void reconcilePending(step.txHash, step.ctx)}
                >
                  {reconciling
                    ? copy.recover.reconciling
                    : copy.recover.reconcile}
                </button>
                {reconcileError ? (
                  <>
                    <br />
                    {reconcileError}
                  </>
                ) : null}
              </>
            ) : step.receiptless === 'executed' ? (
              // TERMINAL LOCK (Codex #1547 r7): the recovery counter
              // proved an attempt was PROCESSED, but not how much of
              // the surplus it moved — so this card must not offer the
              // plain "start over" the other terminal variants do. A
              // fresh flow here would read the remaining surplus and
              // let a second, unintended recovery be signed over it.
              //
              // The way out is honest rather than absent: a two-step
              // acknowledge-then-reset. The first press only states
              // the user has checked their wallet; the second, shown
              // with copy spelling out that the processed attempt
              // already consumed its signature and that this begins a
              // SEPARATE recovery, is what actually resets. The lock
              // itself is persisted, so a reload lands right back here.
              <>
                {copy.recover.executedLockNote}
                <br />
                {executedAcked ? (
                  <>
                    {copy.recover.executedAckPrompt}
                    <br />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ marginTop: 8 }}
                      onClick={resetToFreshForm}
                    >
                      {copy.recover.executedAckConfirm}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ marginTop: 8 }}
                    onClick={() => setExecutedAcked(true)}
                  >
                    {copy.recover.executedAck}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                onClick={resetToFreshForm}
              >
                {copy.recover.startOver}
              </button>
            )}
          </span>
        </div>
      ) : oracleState === 'probing' || accountKind === 'probing' ? (
        // Both availability probes run in parallel and both fail
        // closed, so one "checking" line covers them (Codex #1547 r6).
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {copy.recover.checkingAvailability}
          </p>
        </section>
      ) : oracleState === 'unset' ? (
        // CONFIRMED absent on this network — a permanent property, so
        // no retry is offered (Codex #1547 r6).
        <div className="banner banner-warn" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.unavailableTitle}</strong>
            <br />
            {copy.recover.unavailableBody}
          </span>
        </div>
      ) : oracleState === 'unreachable' ? (
        // The probe THREW (Codex #1547 r6) — still fails closed, but a
        // passing RPC failure must not read as "recovery will never
        // work here", and must be recoverable without a page reload.
        // A bounded auto-retry runs behind this card; the button is
        // the manual way out once that budget is spent.
        <div className="banner banner-warn" role="alert">
          <TriangleAlert aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.unavailableUnreachableTitle}</strong>
            <br />
            {copy.recover.unavailableUnreachableBody}
            <br />
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: 8 }}
              onClick={() => {
                // A deliberate retry refills the auto-retry budget too.
                oracleAutoRetriesRef.current = 0;
                setOracleAttempt((n) => n + 1);
              }}
            >
              {copy.recover.retryCheck}
            </button>
          </span>
        </div>
      ) : sanctions.flagged ? (
        // The connected wallet ITSELF is flagged (Codex #1547 r1) —
        // recovery is a fund-moving surface, so don't render a form
        // whose submit is doomed; the live pre-sign re-screen backs
        // this gate up for the cache window.
        <div className="banner banner-warn" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.unavailableTitle}</strong>
            <br />
            {copy.recover.sanctionedBlockedBody}
          </span>
        </div>
      ) : accountKind === 'contract' ? (
        // Smart-contract account (Codex #1547 r6): the facet recovers
        // the signer from the acknowledgement with ECDSA and requires
        // it to EQUAL msg.sender, which a contract account can never
        // satisfy — so the form would end in a guaranteed revert after
        // the user typed CONFIRM and approved a transaction. Block it
        // here instead. Ordered AFTER the sanctions gate: a flagged
        // wallet's blocked state is the more consequential fact.
        <div className="banner banner-warn" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.contractWalletTitle}</strong>
            <br />
            {copy.recover.contractWalletBody}
          </span>
        </div>
      ) : step.kind === 'review' || reviewBusy ? (
        <section className="card">
          <div className="card-title">
            <ShieldAlert aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.recover.reviewTitle}</h2>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {/* COMPLETE addresses on the review card (Codex #1547 r2):
                short forms hide the middle, exactly where an address-
                poisoning lookalike (matching prefix + suffix) differs.
                What the signature commits to is shown in full here;
                short forms stay fine elsewhere.

                Every symbol and address span is bidi-ISOLATED and
                forced LTR (Codex #1547 r3): the token symbol is
                attacker-controlled Unicode, and a bidi override left
                in a neighboring string can visually REORDER the
                address characters — a lookalike then reads as the
                real address. The sanitizer strips those controls at
                lookup time; the isolation here is defense in depth.

                Amount rendered with exactAmountString, not
                formatTokenAmount (Codex #1547 r3): the display
                formatter rounds to ~4 significant digits, so the user
                could sign for MORE base units than the card shows.
                The review must be lossless. */}
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewToken}:</span>{' '}
              <span style={{ unicodeBidi: 'isolate', direction: 'ltr' }}>
                {activeLookup?.symbol ?? ''}
              </span>{' '}
              <span
                className="mono"
                style={{
                  overflowWrap: 'anywhere',
                  unicodeBidi: 'isolate',
                  direction: 'ltr',
                }}
              >
                {tokenInput}
              </span>
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewSource}:</span>{' '}
              <span
                className="mono"
                style={{
                  overflowWrap: 'anywhere',
                  unicodeBidi: 'isolate',
                  direction: 'ltr',
                }}
              >
                {sourceInput}
              </span>
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewAmount}:</span>{' '}
              {amountWei !== null && activeLookup
                ? exactAmountString(amountWei, activeLookup.decimals)
                : ''}{' '}
              <span style={{ unicodeBidi: 'isolate', direction: 'ltr' }}>
                {activeLookup?.symbol ?? ''}
              </span>
            </p>
            <div className="banner banner-warn" role="note">
              <TriangleAlert aria-hidden />
              <span className="banner-body">
                {copy.recover.reviewWarnSanctions}{' '}
                {copy.recover.reviewWarnOwnership}
              </span>
            </div>
            {/* The EXACT declaration the signature attests to (Codex
                #1547 r1) — rendered verbatim from the module constant
                whose keccak256 is verified against the on-chain hash
                right before signing. Contract-fixed English; never
                translated (see RECOVERY_ACK_TEXT). */}
            <p className="muted" style={{ margin: 0 }}>
              {copy.recover.ackTextIntro}
            </p>
            <blockquote
              className="muted"
              style={{
                margin: 0,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              {RECOVERY_ACK_TEXT}
            </blockquote>
            {/* A reading aid beside the signed bytes, for locales that
                aren't the one those bytes are written in. The
                declaration's hash must equal the on-chain value, so the
                signed text cannot be translated — but rendering ONLY
                English left a non-English reader attesting, in a
                language they may not read, that they had understood
                what they were attesting to (Codex #1563 r8). Shown
                only when the reader's own bundle really carries it —
                see ownLocaleResource — and labelled so which of the
                two is authoritative is never ambiguous. */}
            {localizedAckText !== null && localizedAckLabel !== null && (
              <>
                <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                  {localizedAckLabel}
                </p>
                <blockquote
                  className="muted"
                  style={{
                    margin: 0,
                    padding: '8px 12px',
                    border: '1px dashed var(--border)',
                    borderRadius: 8,
                    fontSize: '0.9em',
                  }}
                >
                  {localizedAckText}
                </blockquote>
              </>
            )}
            {/* The declaration asserts the user has READ the Advanced
                User Guide section on stuck-token recovery — so link it
                right here (Codex #1547 r5). Attesting to having read
                something the app never surfaced is not a real
                acknowledgement. New tab: a same-tab navigation would
                destroy the reviewed form state mid-flow. */}
            <p className="muted" style={{ margin: 0 }}>
              <a
                href={ADVANCED_USER_GUIDE_STUCK_TOKENS_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                {copy.recover.guideLinkLabel}
              </a>
            </p>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-confirm">{copy.recover.confirmPrompt}</label>
              <input
                id="recover-confirm"
                className="input"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={CONFIRM_WORD}
                spellCheck={false}
                autoComplete="off"
                disabled={reviewBusy}
              />
            </div>
            <div className="cluster">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={reviewBusy}
                onClick={() => {
                  setConfirmInput('');
                  setStep({ kind: 'form' });
                }}
              >
                {copy.common.back}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  reviewBusy ||
                  confirmInput.trim().toUpperCase() !== CONFIRM_WORD
                }
                onClick={() => void signAndSubmit()}
              >
                {step.kind === 'signing'
                  ? copy.recover.signing
                  : step.kind === 'submitting'
                    ? copy.recover.submitting
                    : copy.recover.sign}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="card-title">
            <ShieldAlert aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.recover.formTitle}</h2>
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-token">{copy.recover.tokenLabel}</label>
              <input
                id="recover-token"
                className="input"
                placeholder="0x…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value.trim())}
                spellCheck={false}
                autoComplete="off"
              />
              {isZeroAddressInput(tokenInput) ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.errZeroAddress}
                </p>
              ) : lookupFailed ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.tokenLookupFailed}
                </p>
              ) : activeLookup ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.tokenMeta(
                    activeLookup.symbol,
                    String(activeLookup.decimals),
                  )}
                  {' · '}
                  {/* exactAmountString (Codex #1547 r3): the surplus is
                      the cap the user types against — a ~4-significant-
                      digit display that rounds UP would invite an
                      amount the chain rejects. */}
                  {copy.recover.maxRecoverable(
                    exactAmountString(activeLookup.surplus, activeLookup.decimals),
                  )}
                </p>
              ) : null}
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-source">{copy.recover.sourceLabel}</label>
              <input
                id="recover-source"
                className="input"
                placeholder="0x…"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value.trim())}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {isZeroAddressInput(sourceInput)
                  ? copy.recover.errZeroAddress
                  : copy.recover.sourceHint}
              </p>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="recover-amount">{copy.recover.amountLabel}</label>
              <input
                id="recover-amount"
                className="input"
                inputMode="decimal"
                placeholder={activeLookup?.rawUnits ? '0' : '0.0'}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value.trim())}
                autoComplete="off"
              />
              {activeLookup?.rawUnits ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.rawUnitsNote}
                </p>
              ) : null}
              {tooManyDecimals && activeLookup ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.errTooManyDecimals(
                    String(activeLookup.decimals),
                  )}
                </p>
              ) : null}
              {amountWei !== null &&
              activeLookup &&
              amountWei > activeLookup.surplus ? (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {copy.recover.overMax}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canReview}
              onClick={() => {
                setConfirmInput('');
                setError(null);
                setStep({ kind: 'review' });
              }}
            >
              {copy.recover.review}
            </button>
          </div>
        </section>
      )}

      {/* Standing warning — visible alongside the form and review. */}
      {oracleState === 'ready' &&
      accountKind === 'eoa' &&
      address &&
      onSupportedChain &&
      !sanctions.flagged &&
      (step.kind === 'form' || step.kind === 'review' || reviewBusy) ? (
        <div className="banner banner-warn" role="note">
          <TriangleAlert aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.warningTitle}</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {copy.recover.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {/* Degraded-state honesty (Codex #1547 r8): this browser refused
          to store the safety record, so a reload or a closed tab loses
          the app's ability to pick the attempt back up. Non-blocking —
          the flow ran anyway — but the user has to know, because the
          correct next move is "check your wallet before retrying",
          not "try again". Rendered alongside whatever card is showing,
          so it is visible on both the review and the pending card. */}
      {persistFailed ? (
        <div className="banner banner-warn" role="alert">
          <TriangleAlert aria-hidden />
          <span className="banner-body">{copy.recover.persistFailedWarning}</span>
        </div>
      ) : null}

      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">
            <strong>{copy.recover.errTitle}</strong>
            <br />
            {error}
          </span>
        </div>
      ) : null}
    </div>
  );
}
