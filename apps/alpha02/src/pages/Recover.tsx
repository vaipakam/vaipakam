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
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Lock, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  hashDomain,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
  decodeEventLog,
  TransactionNotFoundError,
  type Hex,
  type PublicClient,
} from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { publishReceiptInvalidation } from '../chain/receiptSync';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  assertWalletNotSanctionedLive,
  useSanctionsCheck,
} from '../data/sanctions';
import { captureTxError } from '../lib/errors';
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

/**
 * The canonical recovery declaration — byte-for-byte the string whose
 * keccak256 is VaultFactoryFacet's RECOVERY_ACK_TEXT_HASH (the
 * concatenated literal at VaultFactoryFacet.sol ~line 717). Shown
 * verbatim on the review card so the user reads EXACTLY what the
 * signature commits to, and re-hashed against the live on-chain value
 * before every signature (Codex #1547 r1) — a mismatch blocks signing.
 *
 * DELIBERATELY NOT in the copy catalog: translating or rewording it
 * would break the hash equality, so it must stay contract-fixed
 * English in every locale.
 */
const RECOVERY_ACK_TEXT =
  // Segment boundaries mirror the Solidity literal one-for-one so a
  // side-by-side diff against the contract is trivial. ASCII
  // apostrophe ("protocol's"), NOT the typographic one the rest of
  // the catalog uses — the hash is byte-sensitive.
  'I am declaring that the source address belongs to a wallet I' +
  ' control or authorized. If the source is later determined to' +
  ' be on the sanctions list, my vault will be locked under the' +
  " protocol's sanctions policy until the address is de-listed." +
  ' I have read and understood the Advanced User Guide section' +
  ' on stuck-token recovery.';

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
  txHash: Hex;
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

/** Parse + VALIDATE a stored record. Anything malformed (hand-edited
 *  storage, a shape from an older build) reads as absent — a bad
 *  record must never become a rendered card or a bigint conversion
 *  that throws during render. */
function readPendingRecovery(
  chainId: number,
  account: string,
): PendingRecoveryRecord | null {
  const raw = pendingRecoveryStore.read(chainId, account.toLowerCase());
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.txHash !== 'string' || !HEX32.test(r.txHash)) return null;
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
      txHash: r.txHash as Hex,
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

function writePendingRecovery(
  chainId: number,
  account: string,
  record: PendingRecoveryRecord,
): void {
  pendingRecoveryStore.write(
    chainId,
    account.toLowerCase(),
    JSON.stringify(record),
  );
}

function clearPendingRecovery(chainId: number, account: string): void {
  pendingRecoveryStore.write(chainId, account.toLowerCase(), null);
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

type Step =
  | { kind: 'form' }
  | { kind: 'review' }
  /** Pre-sign checks + the wallet signature prompt are in flight —
   *  review controls stay rendered but locked (Codex #1547 r1). */
  | { kind: 'signing' }
  | { kind: 'submitting' }
  | { kind: 'success'; txHash: Hex; amount: bigint; symbol: string; decimals: number }
  | { kind: 'banned'; txHash: Hex; declaredSource: string }
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
      txHash: Hex;
      pending?: boolean;
      replaced?: boolean;
      receiptless?: 'executed' | 'never';
      ctx?: SubmittedContext;
    };

/**
 * The outcome event a mined receipt carries, or null when none of the
 * two recovery outcomes is present. Shared by the submit path and the
 * reconcile action (Codex #1547 r5) so both adjudicate identically.
 *
 * The contract deliberately does NOT revert on the sanctioned-source
 * path (the ban-state writes must persist), so the outcome lives in
 * the logs, not in the receipt status.
 */
function decodeRecoveryOutcome(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[],
  diamond: string,
): 'recovered' | 'banned' | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: DIAMOND_ABI_VIEM,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'StuckERC20Recovered') return 'recovered';
      if (decoded.eventName === 'VaultBannedFromRecoveryAttempt') return 'banned';
    } catch {
      // Some other event on the diamond — skip.
    }
  }
  return null;
}

export function Recover() {
  const { address, onSupportedChain, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const sanctions = useSanctionsCheck();

  const [tokenInput, setTokenInput] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
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
  useEffect(() => {
    genRef.current += 1; // invalidate any in-flight signAndSubmit (Codex #1547 r3)
    setTokenInput('');
    setSourceInput('');
    setAmountInput('');
    setConfirmInput('');
    setError(null);
    setReconcileError(null);
    setExecutedAcked(false);
    oracleAutoRetriesRef.current = 0;
    const chainId = walletChain?.chainId;
    const stored =
      address && chainId !== undefined
        ? readPendingRecovery(chainId, address)
        : null;
    if (stored === null) {
      setStep({ kind: 'form' });
      return;
    }
    const ctx: SubmittedContext = {
      declaredSource: stored.declaredSource,
      amount: BigInt(stored.amount),
      symbol: stored.symbol,
      decimals: stored.decimals,
      recoveryNonce: BigInt(stored.recoveryNonce),
      ...(stored.deadline === undefined
        ? {}
        : { deadline: BigInt(stored.deadline) }),
    };
    // A record marked `settled: 'executed'` rehydrates as the TERMINAL
    // locked card, not as a pending one (Codex #1547 r7) — the verdict
    // "an attempt was processed" must survive a reload, or refreshing
    // the page would hand the user a fresh form over a recovery that
    // may have moved only part of the surplus.
    setStep(
      stored.settled === 'executed'
        ? {
            kind: 'unknownOutcome',
            txHash: stored.txHash,
            receiptless: 'executed',
            ctx,
          }
        : { kind: 'unknownOutcome', txHash: stored.txHash, pending: true, ctx },
    );
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
  const [accountKind, setAccountKind] = useState<
    'probing' | 'eoa' | 'contract'
  >('probing');
  useEffect(() => {
    if (!publicClient || !address) {
      setAccountKind('probing');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const code = await publicClient.getCode({ address });
        // viem answers `undefined` for an account with no code; some
        // nodes answer the empty-bytes literal instead.
        const isContract = code !== undefined && code !== '0x' && code !== '0x0';
        if (!cancelled) setAccountKind(isContract ? 'contract' : 'eoa');
      } catch {
        if (!cancelled) setAccountKind('eoa'); // fail OPEN
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address]);

  // Live token meta + the unsolicited-surplus cap for the entered
  // token: surplus = max(0, balanceOf(vault) − protocol-tracked).
  const [lookup, setLookup] = useState<TokenLookup | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  const validToken = isAddress(tokenInput);
  const validSource = isAddress(sourceInput);

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
        const [symRes, decRes, vault] = await Promise.all([
          publicClient
            .readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: 'symbol',
              blockNumber,
            })
            .catch(() => null),
          publicClient
            .readContract({
              address: token,
              abi: ERC20_META_ABI,
              functionName: 'decimals',
              blockNumber,
            })
            .catch(() => null),
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
    // Set once writeContract RETURNS a hash (Codex #1547 r4): from that
    // moment the tx is broadcast and may mine even if the receipt wait
    // (or anything after it) throws — the catch below must not bounce
    // back to review with the sign button re-armed.
    let submittedTxHash: Hex | null = null;
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
      const token = snapshot.token as `0x${string}`;
      const declaredSource = sourceInput as `0x${string}`;
      const amount = amountWei;

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
      // must not reach the wallet prompt. Throws the user-facing
      // message when flagged (surfaces via captureTxError below).
      await assertWalletNotSanctionedLive(publicClient, diamond, address);

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

      const signature = await walletClient.signTypedData({
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

      if (genRef.current !== gen) return; // Codex #1547 r3
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
      submittedCtx = {
        declaredSource,
        amount,
        symbol: snapshot.symbol,
        decimals: snapshot.decimals,
        recoveryNonce: nonce,
        deadline,
      };
      // PERSIST the broadcast the moment it exists (Codex #1547 r6) —
      // before any await that could be interrupted by a reload, an
      // account switch, or a closed tab. Written under the identity
      // that broadcast it (not the current one), and deliberately NOT
      // generation-guarded: the transaction is real regardless of who
      // is connected by the time this line runs.
      writePendingRecovery(walletChain.chainId, address, {
        txHash,
        declaredSource,
        amount: amount.toString(),
        symbol: snapshot.symbol,
        decimals: snapshot.decimals,
        recoveryNonce: nonce.toString(),
        // The signed expiry travels with the record (Codex #1547 r7) —
        // a later reconcile can only call an absent transaction dead
        // once chain time is past it.
        deadline: deadline.toString(),
      });
      const forgetPending = () =>
        clearPendingRecovery(walletChain.chainId, address);
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
          // because only 'cancelled' / 'replaced' license the definite
          // "nothing was recovered" copy. A 'repriced' replacement
          // carries the SAME calldata, destination and value per viem,
          // so it is still the recovery transaction and an
          // event-less success receipt on it is an unreadable outcome.
          replacement.reason = event.reason;
          // Keep the post-broadcast marker on the hash that is actually
          // live, so a later throw parks the pending card on it.
          submittedTxHash = event.transaction.hash;
          // Re-point the PERSISTED record at the live hash too (Codex
          // #1547 r6) — a receipt lookup after a reload then resolves
          // directly instead of falling back to the nonce comparison.
          writePendingRecovery(walletChain.chainId, address, {
            txHash: event.transaction.hash,
            declaredSource,
            amount: amount.toString(),
            symbol: snapshot.symbol,
            decimals: snapshot.decimals,
            recoveryNonce: nonce.toString(),
            deadline: deadline.toString(),
          });
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
        submittedTxHash = null;
        forgetPending(); // settled: nothing to rehydrate (Codex #1547 r6)
        throw new Error(copy.recover.errTxReverted);
      }

      // The contract deliberately does NOT revert on the sanctioned-
      // source path — read the outcome from the emitted event.
      const decodedOutcome = decodeRecoveryOutcome(receipt.logs, diamond);
      const outcome: Step | null =
        decodedOutcome === 'recovered'
          ? {
              kind: 'success',
              txHash: minedHash,
              amount,
              symbol: snapshot.symbol,
              decimals: snapshot.decimals,
            }
          : decodedOutcome === 'banned'
            ? { kind: 'banned', txHash: minedHash, declaredSource }
            : null;
      // The receipt was READ, so this transaction's fate is settled
      // whichever branch runs below — drop the persisted record
      // (Codex #1547 r6) so a later mount doesn't rehydrate a pending
      // card over an outcome the user has already been shown. In
      // particular the fork spec's happy path must leave nothing
      // behind for the next run.
      forgetPending();
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
        // A CANCELLED (or wholesale replaced) transaction with no
        // recovery event is not an unreadable outcome (Codex #1547
        // r5) — it is a definite "nothing was recovered": the wallet
        // took the nonce and whatever mined did something else. Say
        // that, and link the transaction that actually mined.
        //
        // A REPRICED replacement is the opposite (Codex #1547 r7):
        // viem defines it as the same calldata, destination and value
        // re-sent at a higher fee, so the transaction that mined IS
        // this recovery. An event-less success receipt on it means the
        // outcome couldn't be read — the plain unknown-outcome card —
        // never "nothing happened".
        setStep({
          kind: 'unknownOutcome',
          txHash: minedHash,
          replaced:
            replacement.reason === 'cancelled' ||
            replacement.reason === 'replaced',
        });
      }
    } catch (err) {
      // Post-broadcast failure (Codex #1547 r4): writeContract already
      // RETURNED a hash, so the tx is in the mempool and may still mine
      // — returning to review would re-arm the sign button over a
      // recovery that may yet complete. Invalidate (state may move any
      // moment) and park on the terminal unknown-outcome card instead;
      // the `pending` flag picks the "submitted but unconfirmed" body.
      // The invalidation publishes even for a stale generation (same
      // rule as the decoded outcomes); only the step commit is
      // identity-bound.
      if (submittedTxHash !== null) {
        publishReceiptInvalidation(queryClient);
        if (genRef.current !== gen) return;
        // Carry the submitted context (Codex #1547 r5) so the pending
        // card's reconcile action can render a full success/banned
        // card once the receipt becomes readable.
        setStep({
          kind: 'unknownOutcome',
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
  async function reconcilePending(txHash: Hex, ctx?: SubmittedContext) {
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
    const forgetPending = () => clearPendingRecovery(chainId, account);
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
      const receipt = await publicClient
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);
      if (receipt === null) {
        await reconcileWithoutReceipt(txHash, ctx, {
          gen,
          chainId,
          account,
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
        decoded === 'banned' ? ['sanctions'] : [],
      );
      forgetPending();
      if (genRef.current !== gen) return;
      const minedHash = receipt.transactionHash;
      if (receipt.status !== 'success') {
        // Definitive: the transaction mined and REVERTED — nothing
        // moved and the on-chain recovery nonce is untouched, so a
        // retry is safe. Same landing the submit path gives a reverted
        // receipt: back to review with the reason.
        setStep({ kind: 'review' });
        setError(copy.recover.errTxReverted);
        return;
      }
      if (decoded === 'recovered' && ctx) {
        setStep({
          kind: 'success',
          txHash: minedHash,
          amount: ctx.amount,
          symbol: ctx.symbol,
          decimals: ctx.decimals,
        });
        return;
      }
      if (decoded === 'banned' && ctx) {
        setStep({
          kind: 'banned',
          txHash: minedHash,
          declaredSource: ctx.declaredSource,
        });
        return;
      }
      // Receipt read but no outcome event decoded — the NON-pending
      // unknown-outcome card, which does offer a fresh start because
      // the transaction's fate is now settled.
      setStep({ kind: 'unknownOutcome', txHash: minedHash });
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
    txHash: Hex,
    ctx: SubmittedContext | undefined,
    scope: {
      gen: number;
      chainId: number;
      account: `0x${string}`;
      forgetPending: () => void;
    },
  ) {
    const { gen, chainId, account, forgetPending } = scope;
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
      writePendingRecovery(chainId, account, {
        txHash,
        declaredSource: ctx.declaredSource,
        amount: ctx.amount.toString(),
        symbol: ctx.symbol,
        decimals: ctx.decimals,
        recoveryNonce: ctx.recoveryNonce.toString(),
        ...(ctx.deadline === undefined
          ? {}
          : { deadline: ctx.deadline.toString() }),
        settled: 'executed',
      });
      publishReceiptInvalidation(queryClient, ['sanctions']);
      if (genRef.current !== gen) return;
      setStep({ kind: 'unknownOutcome', txHash, receiptless: 'executed', ctx });
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
    const presence = await publicClient
      .getTransaction({ hash: txHash })
      .then((tx) =>
        tx.blockNumber === null ? ('queued' as const) : ('unreadable' as const),
      )
      .catch((err: unknown) =>
        isTransactionNotFound(err) ? ('absent' as const) : ('unreadable' as const),
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
    setStep({ kind: 'unknownOutcome', txHash, receiptless: 'never' });
  }

  const explorerTx = (txHash: Hex) =>
    `${walletChain?.blockExplorer}/tx/${txHash}`;

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
   *  account/chain effect resets to. Every caller has either already
   *  dropped the persisted record or is explicitly discarding it, so
   *  the clear is unconditional here: no reload may resurrect a card
   *  the user has deliberately left (Codex #1547 r6/r7). */
  const resetToFreshForm = () => {
    if (address && walletChain) {
      clearPendingRecovery(walletChain.chainId, address);
    }
    setTokenInput('');
    setSourceInput('');
    setAmountInput('');
    setConfirmInput('');
    setError(null);
    setReconcileError(null);
    setExecutedAcked(false);
    setStep({ kind: 'form' });
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
                was recovered. */}
            {copy.recover.successBody(
              exactAmountString(step.amount, step.decimals),
              step.symbol,
            )}
            <br />
            <a href={explorerTx(step.txHash)} target="_blank" rel="noreferrer noopener">
              {copy.recover.viewTx}
            </a>
          </span>
        </div>
      ) : step.kind === 'banned' ? (
        <div className="banner banner-danger" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.bannedTitle}</strong>
            <br />
            {copy.recover.bannedBody(shortAddress(step.declaredSource))}{' '}
            {copy.recover.bannedAutoUnlock}
            <br />
            <a href={explorerTx(step.txHash)} target="_blank" rel="noreferrer noopener">
              {copy.recover.viewTx}
            </a>
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
                ? copy.recover.unknownOutcomePendingTitle
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
              ? copy.recover.unknownOutcomePendingBody
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
                r6). */}
            <a href={explorerTx(step.txHash)} target="_blank" rel="noreferrer noopener">
              {step.receiptless
                ? copy.recover.viewOriginalTx
                : copy.recover.viewTx}
            </a>
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
              {lookupFailed ? (
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
                {copy.recover.sourceHint}
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
