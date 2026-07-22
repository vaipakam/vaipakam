/**
 * Order ticket (#1129 §3) — post a limit-rate offer into the selected
 * (pair, tenor) market without leaving the desk.
 *
 * Reuses the guided flow's battle-tested payload path verbatim:
 * `toCreateOfferPayload` (the role-asymmetric floor/ceiling mapping)
 * + the same Permit2-first / classic-approve submit sequence as
 * OfferFlow.submitPost. The desk adds the terminal-only surface on
 * top: expiry presets (GTC / 24h / 7d / custom → `expiresAt`) and
 * fill-mode chips (Partial default / AON / IOC). AON forces a
 * single-value amount (`amount == amountMax`); IOC requires an expiry
 * — both enforced in the form before any transaction.
 *
 * Kill switch: the ticket is a position-OPENING flow → gated on
 * `flowDisabled('post-offer')`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { useModal } from 'connectkit';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData } from 'viem';
import { copy } from '../../content/copy';
import { useActiveChain } from '../../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../../contracts/diamond';
import {
  disablePermit2ForSession,
  usePermit2Signing,
} from '../../contracts/usePermit2Signing';
import { useTxSimulation, type TxSimInput } from '../../contracts/useTxSimulation';
import { SimulationPreview } from '../SimulationPreview';
import { CollateralPrecheck } from '../CollateralPrecheck';
import { ConsentLabel } from '../ConsentLabel';
import {
  ensureAllowance,
  useTokenBalance,
  useTokenMeta,
} from '../../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
} from '../../contracts/preflights';
import { assertWalletNotSanctionedLive } from '../../data/sanctions';
import { readAllowance } from '../../lib/submitProgress';
import { flowDisabled } from '../../lib/killSwitch';
import { captureTxError, isPlainDecimal, isPositiveDecimal } from '../../lib/errors';
import {
  initialOfferForm,
  toCreateOfferPayload,
  validateOfferForm,
  type CreateOfferPayload,
  type OfferFormState,
  type OfferSide,
} from '../../lib/offerSchema';
import { readLiveProtocolFees, useProtocolFees } from '../../data/fees';
import {
  needsSecurityCheck,
  useTokenSecurity,
} from '../../data/tokenSecurity';
import {
  exactAmountString,
  formatDurationDays,
  formatTokenAmount,
  shortAddress,
} from '../../lib/format';
import type { DeskPair } from '../../data/desk';
import { indexerConfigured, postSignedOffer } from '../../data/indexer';
import { useSignedOfferSigning } from '../../contracts/useSignedOfferSigning';
import {
  collapseForSignedPost,
  randomSignedOfferNonce,
  wireFromCreatePayload,
} from '../../lib/signedOffer';

/** LibVaipakam.FillMode (#125): Partial default, Aon, Ioc. */
const FILL_PARTIAL = 0;
const FILL_AON = 1;
const FILL_IOC = 2;

type ExpiryPreset = 'gtc' | '24h' | '7d' | 'custom';

/** #1131 slice D — how the ticket posts. 'onchain' (the default —
 *  createOffer, escrow now) vs 'gasless' (ONE EIP-712 signature posted
 *  to the indexer's signed book; escrow happens at fill). */
type PostMode = 'onchain' | 'gasless';

/** Gasless GTC signature-deadline policy: a GTT order's signature dies
 *  WITH the offer (`deadline = expiresAt` — a signature outliving the
 *  advertised expiry would be a zombie the maker believes lapsed),
 *  while GTC gets a bounded 7-day deadline rather than the contract's
 *  unbounded `deadline = 0`: an unbounded signature is irrevocable
 *  without a gas-costing on-chain cancel forever, which contradicts
 *  the "posting is free" promise — re-signing after 7 days is free,
 *  so bounding the maker's exposure wins. Anchored to LIVE chain time
 *  at signing (see submitGasless), never the device clock; the
 *  indexer's ingest route enforces a matching (more generous) horizon
 *  cap server-side. */
const GASLESS_GTC_DEADLINE_SECONDS = 7 * 86_400;

const MAX_RATE_PERCENT = 100;

/** Mirrors `LibVaipakam.MAX_OFFER_EXPIRY_HORIZON` (365 days) —
 *  `createOffer` rejects a non-zero `expiresAt` beyond
 *  `block.timestamp + MAX_OFFER_EXPIRY_HORIZON`
 *  (`OfferExpiryAboveCap`), so a custom deadline past the horizon
 *  must never reach the wallet. */
const MAX_OFFER_EXPIRY_HORIZON_SECONDS = 365 * 86_400;

/** Safety margin for the pre-write expiry re-check (Codex #1134
 *  round-4 P2): the deadline must clear chain-now by at least this
 *  much, so the transaction can't land past it while it's in the
 *  mempool. */
const EXPIRY_SUBMIT_MARGIN_SECONDS = 60n;

/** Re-validate a resolved `expiresAt` against LIVE chain time — once
 *  BEFORE any Permit2 signature / classic approval is requested
 *  (Codex #1134 round-5: approval gas must never be spent on an
 *  already-lapsed deadline) and again immediately before the
 *  createOffer / createOfferWithPermit write. The payload is built
 *  (and validated against the DEVICE clock) at the top of submit —
 *  but sanction/fee/pause reads, wallet prompts, and a possible
 *  classic approval transaction all run between that and the write.
 *  A near-future custom deadline can lapse inside those windows, so
 *  without these gates the user pays approval gas and then hits
 *  `OfferExpiryInPast`. Chain-time anchor doctrine: judge on
 *  `block.timestamp` (what the facet judges on), never the device
 *  clock — same anchor the Open orders cancel-cooldown gate uses.
 *  Both bounds are checked (Codex #1134 round-6 P3): the UPPER one
 *  too, because a device clock running AHEAD of the chain passes the
 *  form's device-clock horizon gate while the resolved deadline sits
 *  beyond `block.timestamp + MAX_OFFER_EXPIRY_HORIZON` — the facet
 *  would revert `OfferExpiryAboveCap` after the approval mined. */
/** LIVE chain time (`block.timestamp` of the latest block) — the single
 *  time anchor the chain-time doctrine allows for anything a facet (or a
 *  signed order's on-chain vetting) will judge against `block.timestamp`.
 *  Shared by `assertExpiryStillValidLive` and the gasless GTC signature
 *  deadline (Codex #1145 round-2 P2) — never the device clock. */
async function liveChainTimestamp(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
): Promise<bigint> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  return block.timestamp;
}

async function assertExpiryStillValidLive(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  expiresAt: bigint,
): Promise<void> {
  if (expiresAt === 0n) return; // GTC — nothing to lapse
  const chainNow = await liveChainTimestamp(publicClient);
  if (expiresAt <= chainNow + EXPIRY_SUBMIT_MARGIN_SECONDS) {
    throw new Error(copy.desk.ticket.expiryInvalid);
  }
  if (expiresAt > chainNow + BigInt(MAX_OFFER_EXPIRY_HORIZON_SECONDS)) {
    throw new Error(copy.desk.ticket.expiryTooFar);
  }
}

export function OrderTicket({
  pair,
  days,
  prefill,
}: {
  pair: DeskPair | null;
  days: number;
  /** Ladder-row tap → pre-fill the limit rate. The nonce lets the
   *  same rate be re-applied after the user edited the field. */
  prefill: { rateBps: number; nonce: number } | null;
}) {
  const { address, walletChain, readChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const { setOpen } = useModal();
  const permit2 = usePermit2Signing();
  const queryClient = useQueryClient();
  const fees = useProtocolFees();

  const [side, setSide] = useState<OfferSide>('lender');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [collateralAmount, setCollateralAmount] = useState('');
  const [expiry, setExpiry] = useState<ExpiryPreset>('gtc');
  const [customExpiry, setCustomExpiry] = useState('');
  const [fillMode, setFillMode] = useState<number>(FILL_PARTIAL);
  // #1131 slice D — 'onchain' MUST stay the default: the existing Post
  // order flow (and spec 17's asserts) run it unchanged.
  const [postMode, setPostMode] = useState<PostMode>('onchain');
  const [consent, setConsent] = useState(false);
  // UX-016 — surface a "terms changed, re-confirm" note whenever an
  // edit auto-clears a consent the user had already given (the ticket
  // voids consent on every term/market/keystroke change). Tracked via a
  // ref so the term-change effects can read the live consent value
  // without adding it to their dependency lists.
  const [consentClearedNote, setConsentClearedNote] = useState(false);
  const consentRef = useRef(consent);
  useEffect(() => {
    consentRef.current = consent;
  }, [consent]);
  const clearConsentOnEdit = useCallback(() => {
    if (consentRef.current) setConsentClearedNote(true);
    setConsent(false);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postedHash, setPostedHash] = useState<string | null>(null);
  /** Gasless success is an ORDER HASH (nothing mined). */
  const [gaslessPosted, setGaslessPosted] = useState<string | null>(null);
  /** Advisory only (warn, never block): the maker's vault free balance
   *  doesn't currently cover the signed commitment. */
  const [gaslessFundsWarn, setGaslessFundsWarn] = useState<string | null>(null);
  const lockRef = useRef(false);
  const signedOffer = useSignedOfferSigning();

  // Ladder-row tap → limit rate. Applied on every new tap (nonce).
  useEffect(() => {
    if (prefill === null) return;
    setRate(String(prefill.rateBps / 100));
    clearConsentOnEdit();
    setPostedHash(null);
    setGaslessPosted(null);
  }, [prefill, clearConsentOnEdit]);

  // Any market change voids consent — the deal being consented to
  // changed underneath the ticket. Posting-mode changes void it too:
  // the consent line was read against a different escrow reality.
  useEffect(() => {
    clearConsentOnEdit();
    setPostedHash(null);
    setGaslessPosted(null);
    setGaslessFundsWarn(null);
  }, [pair?.lendingAsset, pair?.collateralAsset, days, side, postMode, clearConsentOnEdit]);

  // The collateral ASSET is fixed to the selected market's — the ticket
  // posts into the (pair, tenor) market shown in the header, and a
  // free-picked asset would post an offer that never appears in the
  // current ladder. A different pair (custom included) is selected in
  // the header, never here; only the collateral AMOUNT is the ticket's.
  const collateralAsset = pair?.collateralAsset ?? '';

  const lendingMeta = useTokenMeta(pair?.lendingAsset);
  const collateralMeta = useTokenMeta(pair?.collateralAsset);

  // UX-027 — the Max chip fills the escrowed leg from the wallet
  // balance: a lender escrows the LENDING asset (the amount field), a
  // borrower locks the COLLATERAL asset. Each side's field is wallet-
  // funded only on its own escrowed leg, so the counter-side amount
  // (a lender's required collateral, a borrower's requested principal)
  // gets no Max — it isn't drawn from this wallet.
  const lendingBalance = useTokenBalance(pair?.lendingAsset);
  const collateralBalance = useTokenBalance(pair?.collateralAsset);

  const killed = flowDisabled('post-offer');

  const selfCollateral =
    pair !== null &&
    pair.lendingAsset.toLowerCase() === pair.collateralAsset.toLowerCase();

  const rateValid = isPlainDecimal(rate) && Number(rate) <= MAX_RATE_PERCENT;
  const fieldsComplete =
    pair !== null &&
    isPositiveDecimal(amount) &&
    rateValid &&
    isPositiveDecimal(collateralAmount) &&
    !selfCollateral;

  const overDurationCap = days > fees.maxOfferDurationDays;

  // ---- expiry --------------------------------------------------------
  // Presets resolve RELATIVE to now at build time; submit re-resolves
  // fresh so a ticket left open doesn't post a stale deadline.
  const resolveExpiresAt = (): bigint | null => {
    const now = Math.floor(Date.now() / 1000);
    switch (expiry) {
      case 'gtc':
        return 0n;
      case '24h':
        return BigInt(now + 86_400);
      case '7d':
        return BigInt(now + 7 * 86_400);
      case 'custom': {
        if (!customExpiry) return null;
        const ts = Math.floor(new Date(customExpiry).getTime() / 1000);
        if (!Number.isFinite(ts) || ts <= now) return null;
        // Upper bound too (Codex #1134 round-3): the contract caps the
        // horizon at one year out. Enforced HERE so both the canPost
        // gate and submit's fresh re-resolution reject it — a ticket
        // left open can drift a deadline INTO validity, never out of
        // the horizon, but the mirror keeps both ends contract-true.
        if (ts > now + MAX_OFFER_EXPIRY_HORIZON_SECONDS) return null;
        return BigInt(ts);
      }
    }
  };
  const expiryOk = expiry !== 'custom' || resolveExpiresAt() !== null;
  /** The custom stamp parses but sits past the contract's one-year
   *  horizon — split out so the inline copy can say WHY the ticket is
   *  held instead of the generic "must be in the future". */
  const customExpiryTooFar = (): boolean => {
    if (expiry !== 'custom' || !customExpiry) return false;
    const ts = Math.floor(new Date(customExpiry).getTime() / 1000);
    return (
      Number.isFinite(ts) &&
      ts > Math.floor(Date.now() / 1000) + MAX_OFFER_EXPIRY_HORIZON_SECONDS
    );
  };
  // IOC requires an expiry (#125) — GTC + IOC is contract-invalid.
  const iocNeedsExpiry = fillMode === FILL_IOC && expiry === 'gtc';

  // #1145 round-2 (Codex P2) — gasless LENDER posts are single-fill
  // only. The matcher requires a constant collateral:principal ratio
  // across a signed range (`SignedOfferRatioNotConstant`), and lender
  // collateral is structurally single-value
  // (`LenderCollateralRangeNotAllowed`), so a ranged lender signed
  // order can never be sliced — posting one would advertise partial
  // depth no keeper can consume. The UI says so honestly: the Partial
  // chip is unavailable in this mode (auto-switched to AON below), and
  // `collapseForSignedPost` in submitGasless enforces the same shape
  // structurally, independent of this state. Borrower gasless posts are
  // single-value already and stay untouched.
  const gaslessLenderSingleFill = postMode === 'gasless' && side === 'lender';
  useEffect(() => {
    if (gaslessLenderSingleFill && fillMode === FILL_PARTIAL) {
      setFillMode(FILL_AON);
    }
  }, [gaslessLenderSingleFill, fillMode]);

  // ---- form + payload -------------------------------------------------
  const form = useMemo(
    (): OfferFormState => ({
      ...initialOfferForm,
      offerType: side,
      lendingAsset: pair?.lendingAsset ?? '',
      amount,
      interestRate: rate,
      collateralAsset,
      collateralAmount,
      durationDays: String(days),
      riskAndTermsConsent: consent,
    }),
    [side, pair, amount, rate, collateralAsset, collateralAmount, days, consent],
  );
  // Validate the duration against the LIVE protocol cap, not the
  // schema's static 365 — a governance-raised cap must not dead-lock
  // posting a longer tenor (submit re-reads the live cap anyway, so
  // this only aligns the canPost gate with what submit enforces).
  // While the fee read is in flight the hook already falls back to
  // the static default.
  const formError = validateOfferForm(form, {
    maxDurationDays: fees.maxOfferDurationDays,
  });

  /** The desk's fill-mode/expiry overrides on the shared payload:
   *  `toCreateOfferPayload` always ships Partial + GTC (the guided
   *  flows have no UI for either); the ticket sets both. AON collapses
   *  the lender side to single-value (`amount == amountMax`) — the
   *  contract requires it, and the borrower payload is single-value
   *  already. */
  const buildPayload = (withConsent: boolean): CreateOfferPayload | null => {
    if (!fieldsComplete) return null;
    const expiresAt = resolveExpiresAt();
    if (expiresAt === null || iocNeedsExpiry) return null;
    try {
      const base = toCreateOfferPayload(
        { ...form, riskAndTermsConsent: withConsent },
        {
          lending: lendingMeta.data?.decimals,
          collateral: collateralMeta.data?.decimals,
        },
      );
      return {
        ...base,
        fillMode,
        expiresAt,
        amount:
          fillMode === FILL_AON && side === 'lender' ? base.amountMax : base.amount,
      };
    } catch {
      return null;
    }
  };

  // Decimals MUST be loaded before any payload is simulated or sent —
  // the builder defaults to 18, and a 6-dec leg would simulate (and
  // post!) a materially different offer.
  const decimalsReady =
    lendingMeta.data?.decimals !== undefined &&
    collateralMeta.data?.decimals !== undefined;

  // ---- advisory pre-sign dry run (consent-gated, like OfferFlow) ------
  // On-chain mode only: gasless posting sends NO transaction, so a
  // "this transaction would…" dry-run footer would preview a write
  // that isn't going to happen.
  const simTx = useMemo((): TxSimInput | null => {
    if (postMode !== 'onchain') return null;
    if (!walletChain || !consent || !decimalsReady) return null;
    const payload = buildPayload(true);
    if (!payload) return null;
    try {
      return {
        to: walletChain.diamondAddress,
        data: encodeFunctionData({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'createOffer',
          args: [payload],
        }),
        value: 0n,
        allowAllowanceRevert: true,
      };
    } catch {
      return null;
    }
    // buildPayload reads only state captured by these deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postMode, walletChain, consent, decimalsReady, form, fillMode, expiry, customExpiry]);
  const preSign = useTxSimulation(simTx);

  // #1112 — early under-collateral warning for the borrow side, consent
  // FORCED true in the read-only preview so the consent gate doesn't
  // mask the collateral/LTV revert while amounts are being edited.
  const precheckTx = useMemo((): TxSimInput | null => {
    if (side !== 'borrower' || !walletChain || !decimalsReady || !fieldsComplete) {
      return null;
    }
    const payload = buildPayload(true);
    if (!payload) return null;
    try {
      return {
        to: walletChain.diamondAddress,
        data: encodeFunctionData({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'createOffer',
          args: [payload],
        }),
        value: 0n,
        allowAllowanceRevert: true,
      };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, walletChain, decimalsReady, fieldsComplete, form, fillMode, expiry, customExpiry]);

  // ---- token security (#1036) — fail closed on blocked/unverified ----
  const lendingSec = useTokenSecurity(readChain.chainId, pair?.lendingAsset);
  const collateralSec = useTokenSecurity(readChain.chainId, pair?.collateralAsset);
  const securityLegs = [
    {
      leg: copy.desk.ticket.legLoanAsset,
      needed:
        pair !== null && needsSecurityCheck(readChain.chainId, pair.lendingAsset),
      verdict: lendingSec.data,
      errored: lendingSec.isError,
    },
    {
      leg: copy.desk.ticket.legCollateral,
      needed:
        pair !== null &&
        needsSecurityCheck(readChain.chainId, pair.collateralAsset),
      verdict: collateralSec.data,
      errored: collateralSec.isError,
    },
  ].filter((l) => l.needed);
  const securityBlocked = securityLegs.filter(
    (l) => l.errored || l.verdict === undefined || l.verdict.kind === 'block',
  );
  const securityOk = securityBlocked.length === 0;

  // Gasless posting additionally needs the order-book service (there
  // is nowhere else to publish the signed row) and the signing wallet.
  const gaslessReady = indexerConfigured() && signedOffer.canSign;

  const canPost =
    fieldsComplete &&
    formError === null &&
    // Explicit consent gate (Codex #1145 round-1 P2 #2). `formError`
    // already encodes it (validateOfferForm rejects consent-false
    // forms), but the GASLESS path has no contract backstop — the fill
    // stamps `creatorRiskAndTermsConsent = true` from the signature —
    // so the button gate must not hinge on a validator's internal
    // check ordering.
    consent &&
    expiryOk &&
    !iocNeedsExpiry &&
    !overDurationCap &&
    decimalsReady &&
    fees.ready &&
    securityOk &&
    Boolean(walletClient) &&
    Boolean(publicClient) &&
    onSupportedChain &&
    !killed &&
    !busy &&
    (postMode === 'onchain' || gaslessReady);

  // ---- submit — same sequence as OfferFlow.submitPost -----------------
  async function submit() {
    if (killed) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (lockRef.current) return; // synchronous re-entrancy lock
    lockRef.current = true;
    setBusy(true);
    setError(null);
    setPostedHash(null);
    try {
      if (!address || !walletChain || !walletClient || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      const payload = buildPayload(consent);
      if (!payload) {
        throw new Error(
          customExpiryTooFar()
            ? copy.desk.ticket.expiryTooFar
            : copy.desk.ticket.expiryInvalid,
        );
      }
      // Re-screen the wallet live before any approval can mine.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // The duration-cap gate above validated against the 5-min-cached
      // fee read — governance lowering maxOfferDurationDays inside that
      // window would let the user mine an approval ahead of an
      // OfferDurationExceedsCap revert. Re-read live before any
      // approval/write (same move as OfferFlow.submitPost).
      const liveFees = await readLiveProtocolFees(
        publicClient,
        walletChain.diamondAddress,
      );
      if (days > liveFees.maxOfferDurationDays) {
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        throw new Error(copy.desk.ticket.overDurationCap(liveFees.maxOfferDurationDays));
      }
      const token = (side === 'lender'
        ? payload.lendingAsset
        : payload.collateralAsset) as `0x${string}`;
      const lockedAmount =
        side === 'lender' ? payload.amountMax : payload.collateralAmount;
      // Paused legs make createOffer revert, and balances are cached
      // reads — re-check all three live before the approval can mine.
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: payload.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: payload.collateralAsset as `0x${string}`,
        }),
        assertErc20BalanceLive({
          publicClient,
          token,
          owner: address,
          amount: lockedAmount,
          symbol:
            side === 'lender'
              ? lendingMeta.data?.symbol
              : collateralMeta.data?.symbol,
        }),
      ]);
      // First look BEFORE any approval/signature work (Codex #1134
      // round-5 P2): the ticket can sit open long enough for a custom
      // deadline to lapse, and the checks below end with either a
      // Permit2 EIP-712 prompt or a classic approval TRANSACTION —
      // gas that must never be spent on an offer the facet will
      // reject with OfferExpiryInPast. The post-approval last looks
      // further down stay: the deadline can also lapse while the
      // approval itself sits in the wallet/mempool.
      await assertExpiryStillValidLive(publicClient, payload.expiresAt);
      // Permit2 first (#1038): one gasless signature replaces the
      // approval transaction — only when a fresh approval would be
      // needed anyway AND the wallet holds a standing token→Permit2
      // approval covering the amount. Signature failure falls to
      // classic; a failed *WithPermit TRANSACTION surfaces (and trips
      // the session breaker so the manual retry routes classic).
      if (permit2.canSign) {
        const [cur, permit2Cur] = await Promise.all([
          readAllowance({
            publicClient,
            token,
            owner: address,
            spender: walletChain.diamondAddress,
          }),
          readAllowance({
            publicClient,
            token,
            owner: address,
            spender: permit2.permit2Address,
          }),
        ]);
        const freshApprovalNeeded = cur === undefined || cur === 0n;
        const permit2Funded =
          permit2Cur !== undefined && permit2Cur >= lockedAmount;
        if (freshApprovalNeeded && permit2Funded) {
          let signed: Awaited<ReturnType<typeof permit2.sign>> | null = null;
          try {
            signed = await permit2.sign({
              token,
              amount: lockedAmount,
              spender: walletChain.diamondAddress,
            });
          } catch {
            signed = null; // wallet declined EIP-712 — classic path
          }
          if (signed) {
            // Last look BEFORE the write (and OUTSIDE the catch below
            // — a lapsed deadline is not a Permit2 failure and must
            // not trip the session breaker).
            await assertExpiryStillValidLive(publicClient, payload.expiresAt);
            try {
              const { hash } = await write('createOfferWithPermit', [
                payload,
                signed.permit,
                signed.signature,
              ]);
              afterPost(hash);
              return;
            } catch (permitErr) {
              disablePermit2ForSession();
              throw permitErr;
            }
          }
        }
      }
      await ensureAllowance({
        publicClient,
        walletClient,
        token,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: lockedAmount,
      });
      // Last look AFTER the (possible) approval mined: the deadline
      // may have lapsed while the approval sat in the wallet/mempool.
      await assertExpiryStillValidLive(publicClient, payload.expiresAt);
      const { hash } = await write('createOffer', [payload]);
      afterPost(hash);
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
      lockRef.current = false;
    }
  }

  function afterPost(hash: string) {
    setPostedHash(hash);
    setConsent(false);
    setConsentClearedNote(false);
    setAmount('');
    void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
    void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
    void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
  }

  // ---- submit — GASLESS path (#1131 slice D): one EIP-712 signature,
  // one POST to the indexer's signed book. No transaction, no
  // approvals, no escrow — the maker's funds move from their VAULT
  // free balance at fill time (`createSignedOfferVault`), which is why
  // the balance preflight below WARNS instead of blocking.
  async function submitGasless() {
    if (killed) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    setGaslessPosted(null);
    setGaslessFundsWarn(null);
    try {
      if (!address || !walletChain || !walletClient || !publicClient) {
        throw new Error(copy.wallet.connectFirst);
      }
      // Consent is LOAD-BEARING on this path, not just a UX gate (Codex
      // #1145 round-1 P2 #2): the signed wire order carries NO consent
      // field — `LibSignedOffer.toCreateOfferParams` stamps
      // `creatorRiskAndTermsConsent = true` at fill ("the signature IS
      // the consent") — so signing without the checkbox would
      // manufacture a consent the maker never gave. The on-chain path
      // has a contract backstop (`RiskAndTermsConsentRequired` reverts
      // a consent-false payload); this guard is the gasless
      // equivalent: the button gate can regress, this must not.
      if (!consent) {
        throw new Error(copy.desk.ticket.gaslessConsentRequired);
      }
      // #1145 round-2 (Codex P2) — a signed LENDER order must be
      // single-value to be consumable: the matcher's constant
      // collateral:principal ratio check (`SignedOfferRatioNotConstant`)
      // rejects every slice of a ranged lender order because lender
      // collateral is single-value by invariant. Collapse here —
      // structurally, not just via the fill-mode chip state — so the
      // signed wire order can never publish unmatchable partial depth.
      const built = buildPayload(consent);
      const payload = built === null ? null : collapseForSignedPost(built);
      if (!payload) {
        throw new Error(
          customExpiryTooFar()
            ? copy.desk.ticket.expiryTooFar
            : copy.desk.ticket.expiryInvalid,
        );
      }
      // A sanctioned signer's order could sit on the book but can never
      // bind on-chain (the fill Tier-1-gates both parties) — refuse to
      // post a structurally dead order.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // Same live duration-cap + paused-asset gates as the on-chain
      // path: the offer MATERIALIZES through createOffer at fill, so
      // an over-cap tenor or paused leg makes every future fill revert
      // — posting it would only be book pollution.
      const liveFees = await readLiveProtocolFees(
        publicClient,
        walletChain.diamondAddress,
      );
      if (days > liveFees.maxOfferDurationDays) {
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        throw new Error(
          copy.desk.ticket.overDurationCap(liveFees.maxOfferDurationDays),
        );
      }
      await Promise.all([
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: payload.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: payload.collateralAsset as `0x${string}`,
        }),
      ]);
      // GTT sanity on chain time — the route rejects a lapsed expiresAt
      // too, but failing here keeps the wallet from signing a dead order.
      await assertExpiryStillValidLive(publicClient, payload.expiresAt);
      // ESCROW-REALITY preflight — WARN, never block: a signed offer
      // escrows NOTHING at signing; the fill pulls the committed leg
      // from the maker's vault FREE balance (lender ⇒ amountMax of the
      // lending asset; borrower ⇒ collateralAmountMax of the
      // collateral). The maker may legitimately intend to fund the
      // vault later, so a shortfall only warns that fills will fail
      // while the funds aren't there. Advisory ⇒ read failures are
      // swallowed (no warning beats a false one).
      const stakeToken = (side === 'lender'
        ? payload.lendingAsset
        : payload.collateralAsset) as `0x${string}`;
      const stakeAmount =
        side === 'lender' ? payload.amountMax : payload.collateralAmountMax;
      try {
        const [tracked, encumbered] = await Promise.all([
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getProtocolTrackedVaultBalance',
            args: [address, stakeToken],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: walletChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getEncumbered',
            args: [address, stakeToken, 0n],
          }) as Promise<bigint>,
        ]);
        const free = tracked > encumbered ? tracked - encumbered : 0n;
        if (free < stakeAmount) {
          const dec =
            side === 'lender'
              ? lendingMeta.data?.decimals
              : collateralMeta.data?.decimals;
          const sym =
            (side === 'lender'
              ? lendingMeta.data?.symbol
              : collateralMeta.data?.symbol) ?? shortAddress(stakeToken);
          setGaslessFundsWarn(
            copy.desk.ticket.gaslessFundsWarn(
              dec !== undefined
                ? formatTokenAmount(stakeAmount, dec)
                : String(stakeAmount),
              sym,
            ),
          );
        }
      } catch {
        // advisory only — see above
      }
      // Nonce + deadline (see randomSignedOfferNonce and
      // GASLESS_GTC_DEADLINE_SECONDS for the two policies).
      //
      //  - GTT: `deadline = expiresAt` — the signature dies with the
      //    advertised expiry. Its chain-time sanity is already enforced
      //    by `assertExpiryStillValidLive` above (both bounds, against
      //    LIVE `block.timestamp`).
      //  - GTC: `chainNow + 7d`, anchored to the LIVE block timestamp
      //    (Codex #1145 round-2 P2) — never the device clock. A device
      //    clock running far AHEAD would otherwise sign an order that
      //    stays fillable until that future wall-time, leaving a
      //    gas-costing on-chain cancel as the maker's only revocation —
      //    exactly the unbounded exposure the 7-day policy exists to
      //    bound. `_vetSignedOffer` judges the deadline against
      //    `block.timestamp`, so chain time is the only honest anchor
      //    (the same doctrine as `assertExpiryStillValidLive`).
      const nonce = randomSignedOfferNonce();
      const deadline =
        payload.expiresAt !== 0n
          ? payload.expiresAt
          : (await liveChainTimestamp(publicClient)) +
            BigInt(GASLESS_GTC_DEADLINE_SECONDS);
      const order = wireFromCreatePayload(payload, address, nonce, deadline);
      const signature = await signedOffer.sign(order);
      const res = await postSignedOffer(
        walletChain.chainId,
        order,
        signature,
      );
      if (res === null) {
        throw new Error(copy.desk.ticket.gaslessUnavailable);
      }
      if (res.kind === 'rejected') {
        throw new Error(copy.desk.ticket.gaslessRejected(res.error));
      }
      setGaslessPosted(res.orderHash);
      setConsent(false);
      setConsentClearedNote(false);
      setAmount('');
      void queryClient.invalidateQueries({ queryKey: ['deskSignedBook'] });
      // A signed post can CREATE a market — /offers/markets unions
      // active signed rows (Codex #1145 r4) — so the pair/tenor chips
      // and counts must refresh now, same as afterPost() on the
      // on-chain path, not on the next 30s poll (Codex #1145 r7 P3).
      void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
      lockRef.current = false;
    }
  }

  const text = copy.desk.ticket;

  // UX-009 — the FIRST unmet gate, in priority order, shown under the
  // disabled Post button. Gates that already render their own inline
  // message (self-collateral, expiry, duration cap, security) return
  // null so the note never duplicates them; a missing wallet is served
  // by the Connect button below instead of a reason line.
  const blockReason: string | null = (() => {
    if (!address || !walletClient || !publicClient) return null; // Connect button
    if (!onSupportedChain) return text.blockNetwork;
    if (killed) return null; // kill-switch banner already shown
    if (!pair) return text.blockNoMarket;
    if (selfCollateral) return null; // inline danger under the field
    if (!isPositiveDecimal(amount)) return text.blockAmount;
    if (!rateValid) return text.blockRate;
    if (!isPositiveDecimal(collateralAmount)) return text.blockCollateral;
    if (!expiryOk || iocNeedsExpiry || overDurationCap) return null; // inline hints
    if (!decimalsReady || !fees.ready) return text.blockLoading;
    if (securityBlocked.length > 0) return null; // security banner above
    if (postMode === 'gasless' && !gaslessReady) return text.blockGaslessService;
    if (!consent) return text.blockConsent;
    return null;
  })();

  // UX-027 — an honest fee/commitment summary before consent: what the
  // escrowed leg is (worded for on-chain escrow vs gasless "at fill"),
  // plus the side's protocol fee (lender yield-fee net rate; borrower
  // one-time LIF on principal). Derived from the same payload the write
  // sends, so the numbers can't drift from the order.
  const feePreview = useMemo((): { commit: string; fee: string } | null => {
    if (!fieldsComplete || !decimalsReady || !fees.ready) return null;
    const payload = buildPayload(false);
    if (!payload) return null;
    const lendDec = lendingMeta.data?.decimals ?? 18;
    const collDec = collateralMeta.data?.decimals ?? 18;
    const lendSym = lendingMeta.data?.symbol ?? '';
    const collSym = collateralMeta.data?.symbol ?? '';
    const gasless = postMode === 'gasless';
    if (side === 'lender') {
      const escrow = formatTokenAmount(payload.amountMax, lendDec);
      const netRate = (
        (Number(rate) * (10000 - fees.treasuryFeeBps)) /
        10000
      ).toFixed(2);
      return {
        commit: gasless
          ? text.commitAtFill(escrow, lendSym)
          : text.escrowNow(escrow, lendSym),
        fee: text.netYield(netRate, String(fees.treasuryFeeBps / 100)),
      };
    }
    const lock = formatTokenAmount(payload.collateralAmountMax, collDec);
    const lifAmt = (payload.amountMax * BigInt(fees.loanInitiationFeeBps)) / 10000n;
    return {
      commit: gasless
        ? text.lockAtFill(lock, collSym)
        : text.lockNow(lock, collSym),
      fee: text.lifNote(
        String(fees.loanInitiationFeeBps / 100),
        formatTokenAmount(lifAmt, lendDec),
        lendSym,
      ),
    };
    // buildPayload reads only state captured by these deps (same
    // pattern as simTx above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fieldsComplete,
    decimalsReady,
    fees.ready,
    fees.treasuryFeeBps,
    fees.loanInitiationFeeBps,
    side,
    rate,
    postMode,
    form,
    fillMode,
    expiry,
    customExpiry,
    lendingMeta.data,
    collateralMeta.data,
    text,
  ]);

  // UX-027 — fill the escrowed-leg field from the wallet balance.
  const fillAmountMax = () => {
    if (lendingBalance.data === undefined || lendingMeta.data === undefined) return;
    setAmount(exactAmountString(lendingBalance.data, lendingMeta.data.decimals));
    clearConsentOnEdit();
  };
  const fillCollateralMax = () => {
    if (collateralBalance.data === undefined || collateralMeta.data === undefined) {
      return;
    }
    setCollateralAmount(
      exactAmountString(collateralBalance.data, collateralMeta.data.decimals),
    );
    clearConsentOnEdit();
  };
  const showAmountMax =
    side === 'lender' &&
    lendingBalance.data !== undefined &&
    lendingMeta.data !== undefined;
  const showCollateralMax =
    side === 'borrower' &&
    collateralBalance.data !== undefined &&
    collateralMeta.data !== undefined;

  return (
    <div className="card">
      <h2 className="card-title">{text.title}</h2>

      <div className="segmented" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={side === 'lender' ? 'active' : ''}
          onClick={() => setSide('lender')}
        >
          {text.sideLend}
        </button>
        <button
          type="button"
          className={side === 'borrower' ? 'active' : ''}
          onClick={() => setSide('borrower')}
        >
          {text.sideBorrow}
        </button>
      </div>

      <div className="field">
        <div className="field-label-row">
          <label htmlFor="desk-amount">
            {side === 'lender' ? text.amountLend : text.amountBorrow}
            {lendingMeta.data ? ` (${lendingMeta.data.symbol})` : ''}
          </label>
          {showAmountMax ? (
            <button
              type="button"
              className="input-max"
              onClick={fillAmountMax}
              title={copy.desk.walletBalanceTitle(exactAmountString(lendingBalance.data!, lendingMeta.data!.decimals), lendingMeta.data!.symbol)}
            >
              {text.max}
            </button>
          ) : null}
        </div>
        <input
          id="desk-amount"
          className="input"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.trim());
            clearConsentOnEdit();
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="desk-rate">
          {side === 'lender' ? text.rateLend : text.rateBorrow}
        </label>
        <input
          id="desk-rate"
          className="input"
          inputMode="decimal"
          placeholder="5.0"
          title={text.rateBpsNote}
          value={rate}
          onChange={(e) => {
            setRate(e.target.value.trim());
            clearConsentOnEdit();
          }}
        />
      </div>

      {/* The collateral ASSET is the selected market's — read-only, so
          the ticket can never post into a pair the ladder isn't
          showing. Switching pairs (custom included) happens in the
          header. */}
      <div className="field">
        <label>{side === 'lender' ? text.collateralRequire : text.collateralLock}</label>
        <p id="desk-collateral-asset" className="muted" style={{ margin: 0 }}>
          {pair
            ? `${collateralMeta.data ? `${collateralMeta.data.symbol} · ` : ''}${shortAddress(pair.collateralAsset)}`
            : copy.desk.statUnknown}
        </p>
        {pair ? (
          <p className="field-hint">{text.collateralFixedNote}</p>
        ) : null}
      </div>
      {selfCollateral ? (
        <p className="field-hint" style={{ color: 'var(--danger)' }}>
          {text.selfCollateral}
        </p>
      ) : null}

      <div className="field">
        <div className="field-label-row">
          <label htmlFor="desk-collateral-amount">
            {text.collateralAmount}
            {collateralMeta.data ? ` (${collateralMeta.data.symbol})` : ''}
          </label>
          {showCollateralMax ? (
            <button
              type="button"
              className="input-max"
              onClick={fillCollateralMax}
              title={copy.desk.walletBalanceTitle(exactAmountString(collateralBalance.data!, collateralMeta.data!.decimals), collateralMeta.data!.symbol)}
            >
              {text.max}
            </button>
          ) : null}
        </div>
        <input
          id="desk-collateral-amount"
          className="input"
          inputMode="decimal"
          placeholder="0.0"
          value={collateralAmount}
          onChange={(e) => {
            setCollateralAmount(e.target.value.trim());
            clearConsentOnEdit();
          }}
        />
      </div>

      <div className="field">
        <label>{text.expiryLabel}</label>
        <div className="desk-chips" role="group" aria-label={text.expiryLabel}>
          {(
            [
              ['gtc', text.expiryGtc],
              ['24h', '24h'],
              ['7d', '7d'],
              ['custom', text.expiryCustom],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`desk-chip${expiry === value ? ' active' : ''}`}
              title={
                value === 'gtc' ? text.expiryGtcTitle : text.expiryGttTitle
              }
              onClick={() => {
                setExpiry(value);
                clearConsentOnEdit();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {expiry === 'custom' ? (
          <input
            className="input"
            type="datetime-local"
            style={{ marginTop: 8 }}
            value={customExpiry}
            onChange={(e) => {
              setCustomExpiry(e.target.value);
              clearConsentOnEdit();
            }}
          />
        ) : null}
        {expiry === 'custom' && customExpiry !== '' && !expiryOk ? (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            {customExpiryTooFar() ? text.expiryTooFar : text.expiryInvalid}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label>{text.fillModeLabel}</label>
        <div className="desk-chips" role="group" aria-label={text.fillModeLabel}>
          {(
            [
              [FILL_PARTIAL, text.fillPartial, text.fillPartialHint],
              [FILL_AON, text.fillAon, text.fillAonHint],
              [FILL_IOC, text.fillIoc, text.fillIocHint],
            ] as const
          ).map(([value, label, hint]) => {
            // Partial is not offerable for gasless lender posts — see
            // gaslessLenderSingleFill above.
            const unavailable =
              value === FILL_PARTIAL && gaslessLenderSingleFill;
            return (
              <button
                key={value}
                type="button"
                className={`desk-chip${fillMode === value ? ' active' : ''}`}
                title={unavailable ? text.gaslessLenderAonNote : hint}
                disabled={unavailable}
                onClick={() => {
                  setFillMode(value);
                  clearConsentOnEdit();
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {iocNeedsExpiry ? (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            {text.iocNeedsExpiry}
          </p>
        ) : null}
        {gaslessLenderSingleFill ? (
          <p className="field-hint">{text.gaslessLenderAonNote}</p>
        ) : null}
      </div>

      {/* #1131 slice D — posting mode. On-chain stays the default; the
          gasless chip only changes HOW the order publishes (signature +
          book POST), never the terms above. */}
      <div className="field">
        <label>{text.modeLabel}</label>
        <div className="desk-chips" role="group" aria-label={text.modeLabel}>
          {(
            [
              ['onchain', text.modeOnchain, text.modeOnchainHint],
              ['gasless', text.modeGasless, text.modeGaslessHint],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              className={`desk-chip${postMode === value ? ' active' : ''}`}
              title={hint}
              onClick={() => setPostMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {postMode === 'gasless' ? (
          <p className="field-hint">
            {indexerConfigured()
              ? text.gaslessEscrowNote
              : text.gaslessNeedsIndexer}
          </p>
        ) : null}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem' }}>
        {text.tenorNote(formatDurationDays(days))}
      </p>
      {overDurationCap && fees.ready ? (
        <p className="field-hint" style={{ color: 'var(--danger)' }}>
          {text.overDurationCap(fees.maxOfferDurationDays)}
        </p>
      ) : null}

      {securityBlocked.length > 0 && fieldsComplete ? (
        <div className="banner banner-warn" role="status" style={{ marginBottom: 8 }}>
          <span className="banner-body">
            {securityBlocked
              .map((l) =>
                l.verdict?.kind === 'block'
                  ? text.securityBlocked(l.leg, l.verdict.reasons.join('; '))
                  : text.securityUnknown(l.leg),
              )
              .join(' ')}
          </span>
        </div>
      ) : null}

      <CollateralPrecheck tx={precheckTx} />

      {/* UX-027 — fee & commitment summary before consent. */}
      {feePreview ? (
        <div className="desk-fee-preview" role="note">
          <p className="desk-fee-preview-title">{text.feePreviewTitle}</p>
          <p>{feePreview.commit}</p>
          <p>{feePreview.fee}</p>
        </div>
      ) : null}

      <label
        className="cluster"
        style={{ alignItems: 'flex-start', gap: 8, margin: '8px 0' }}
      >
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked);
            // Re-ticking clears the "terms changed" note (UX-016).
            if (e.target.checked) setConsentClearedNote(false);
          }}
          style={{ marginTop: 3 }}
        />
        <ConsentLabel />
      </label>
      {/* UX-016 — the auto-untick after a term edit, explained. */}
      {consentClearedNote && !consent ? (
        <p className="field-hint" style={{ color: 'var(--warn)', marginTop: -4 }}>
          {text.consentRecheck}
        </p>
      ) : null}

      <SimulationPreview tx={simTx} result={preSign.result} />

      {killed ? (
        <div className="banner banner-warn" role="alert" style={{ margin: '8px 0' }}>
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}

      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>
      ) : null}
      {postedHash ? (
        <p className="cluster" style={{ alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
          <CircleCheck size={16} aria-hidden />
          <span>
            {text.posted} — {text.postedNext}
          </span>
        </p>
      ) : null}
      {gaslessPosted ? (
        <p className="cluster" style={{ alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
          <CircleCheck size={16} aria-hidden />
          <span>{text.gaslessPosted}</span>
        </p>
      ) : null}
      {gaslessFundsWarn ? (
        <div className="banner banner-warn" role="status" style={{ margin: '8px 0' }}>
          <span className="banner-body">{gaslessFundsWarn}</span>
        </div>
      ) : null}

      {/* UX-009 — a disconnected wallet gets a Connect button here, not
          a dead-disabled Post; the ticket has no wallet affordance
          otherwise. */}
      {!address ? (
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => setOpen(true)}
        >
          {copy.wallet.connect}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!canPost}
          onClick={() =>
            void (postMode === 'gasless' ? submitGasless() : submit())
          }
        >
          {postMode === 'gasless'
            ? busy
              ? text.gaslessPosting
              : text.gaslessPost
            : busy
              ? text.posting
              : text.post}
        </button>
      )}
      {/* UX-009 — the first unmet gate, so the greyed button says why. */}
      {blockReason ? (
        <p className="field-hint" style={{ textAlign: 'center', marginTop: 6 }}>
          {blockReason}
        </p>
      ) : null}
    </div>
  );
}
