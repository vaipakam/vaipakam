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
import { formatTokenAmount, shortAddress } from '../lib/format';

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

type Step =
  | { kind: 'form' }
  | { kind: 'review' }
  /** Pre-sign checks + the wallet signature prompt are in flight —
   *  review controls stay rendered but locked (Codex #1547 r1). */
  | { kind: 'signing' }
  | { kind: 'submitting' }
  | { kind: 'success'; txHash: Hex; amount: bigint; symbol: string; decimals: number }
  | { kind: 'banned'; txHash: Hex; declaredSource: string };

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
  const inFlightRef = useRef(false);

  // Fail-safe availability probe: `recoverStuckERC20` HARD-REQUIRES
  // the sanctions oracle (it reverts SanctionsOracleUnavailable when
  // unset — the outcome can't be adjudicated without screening the
  // declared source). Never let the user sign into that: with the
  // oracle unset, unanswerable, OR the probe failing, the flow renders
  // a blocked state instead of the form (per the WebsiteReadme
  // recovery spec). null = probing.
  const [oracleReady, setOracleReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!publicClient || !walletChain) {
      setOracleReady(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ready = await probeSanctionsOracle(
          publicClient,
          walletChain.diamondAddress,
        );
        if (!cancelled) setOracleReady(ready);
      } catch {
        if (!cancelled) setOracleReady(false); // fail-safe: blocked
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, walletChain]);

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
    try {
      const v = parseUnits(amountInput, activeLookup.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
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
        const symbol = symRes === null ? shortAddress(token) : (symRes as string);
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
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
      setStep({ kind: 'signing' });
      const abortToReview = (message: string) => {
        setStep({ kind: 'review' });
        setError(message);
      };

      // (a) Live oracle answerability — the mount-time probe may be
      // minutes stale; re-run the same two-step check now, fail-safe.
      let oracleLive = false;
      try {
        oracleLive = await probeSanctionsOracle(publicClient, diamond);
      } catch {
        oracleLive = false;
      }
      if (!oracleLive) {
        abortToReview(copy.recover.unavailableBody);
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

      setStep({ kind: 'submitting' });
      const txHash = await walletClient.writeContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'recoverStuckERC20',
        args: [token, declaredSource, amount, deadline, signature],
        chain: walletClient.chain,
        account: address,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      // waitForTransactionReceipt resolves on REVERTED receipts too
      // (Codex #1547 r1) — decoding events out of one would misread
      // "no event" as a missing outcome. Fail loud first.
      if (receipt.status !== 'success') {
        throw new Error(copy.recover.errTxReverted);
      }

      // The contract deliberately does NOT revert on the sanctioned-
      // source path — read the outcome from the emitted event.
      let outcome: Step | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: DIAMOND_ABI_VIEM,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'StuckERC20Recovered') {
            outcome = {
              kind: 'success',
              txHash,
              amount,
              symbol: snapshot.symbol,
              decimals: snapshot.decimals,
            };
            break;
          }
          if (decoded.eventName === 'VaultBannedFromRecoveryAttempt') {
            outcome = { kind: 'banned', txHash, declaredSource };
            break;
          }
        } catch {
          // Some other event on the diamond — skip.
        }
      }
      if (outcome) {
        // Own-receipt floor (Codex #1547 r1): a recovery moves vault
        // balances (and a ban flips sanctions-derived state) — push the
        // standard invalidation set to this and every other tab. The
        // banned outcome additionally carries the sanctions root so the
        // flagged-state banners refresh without waiting out the cache.
        publishReceiptInvalidation(
          queryClient,
          outcome.kind === 'banned' ? ['sanctions'] : [],
        );
        setStep(outcome);
      } else {
        setStep({ kind: 'review' });
        setError(copy.recover.errOutcomeMissing);
      }
    } catch (err) {
      setStep({ kind: 'review' });
      setError(captureTxError(err));
    } finally {
      inFlightRef.current = false;
    }
  }

  const explorerTx = (txHash: Hex) =>
    `${walletChain?.blockExplorer}/tx/${txHash}`;

  // The review card stays mounted through 'signing' and 'submitting'
  // with every control locked (Codex #1547 r1) — unmounting it would
  // lose the user's context mid-wallet-prompt, and an enabled Back
  // button could fork the UI away from an in-flight signature.
  const reviewBusy = step.kind === 'signing' || step.kind === 'submitting';

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
      ) : oracleReady === null ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            {copy.recover.checkingAvailability}
          </p>
        </section>
      ) : oracleReady === false ? (
        <div className="banner banner-warn" role="alert">
          <Lock aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.unavailableTitle}</strong>
            <br />
            {copy.recover.unavailableBody}
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
      ) : step.kind === 'success' ? (
        <div className="banner banner-info" role="status">
          <CircleCheck aria-hidden />
          <span className="banner-body">
            <strong>{copy.recover.successTitle}</strong>
            <br />
            {copy.recover.successBody(
              formatTokenAmount(step.amount, step.decimals),
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
      ) : step.kind === 'review' || reviewBusy ? (
        <section className="card">
          <div className="card-title">
            <ShieldAlert aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.recover.reviewTitle}</h2>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewToken}:</span>{' '}
              {activeLookup?.symbol ?? ''} ({shortAddress(tokenInput)})
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewSource}:</span>{' '}
              {shortAddress(sourceInput)}
            </p>
            <p style={{ margin: 0 }}>
              <span className="muted">{copy.recover.reviewAmount}:</span>{' '}
              {amountWei !== null && activeLookup
                ? formatTokenAmount(amountWei, activeLookup.decimals)
                : ''}{' '}
              {activeLookup?.symbol ?? ''}
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
                  {copy.recover.maxRecoverable(
                    formatTokenAmount(activeLookup.surplus, activeLookup.decimals),
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
      {oracleReady === true &&
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
