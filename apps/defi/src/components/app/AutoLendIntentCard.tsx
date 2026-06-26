import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { parseUnits, formatUnits } from 'viem';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useDiamondContract, useDiamondRead } from '../../contracts/useDiamond';
import { useERC20 } from '../../contracts/useERC20';
import { DEFAULT_CHAIN } from '../../contracts/config';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { autoLifecycleErrorOrRaw } from '../../lib/autoLifecycleErrors';
import { useMarketAnchorRate } from '../../hooks/useMarketAnchorRate';
import { AssetPicker } from './AssetPicker';
import { RiskDisclosures, RiskConsentLabel } from './RiskDisclosures';
import { CardInfo } from '../CardInfo';

/**
 * #625 WI-1 — auto-lend, wired to the standing **LenderIntent** layer.
 *
 * This replaces the legacy auto-lend toggle (which only flipped the
 * `autoLendConsent` marker and relied on the dapp auto-posting
 * fixed-duration point offers). Auto-lend now means: the lender
 * registers a standing intent on a `(lendingAsset, collateralAsset)`
 * pair with their own bounds, funds working capital, and the protocol
 * keeper FILLS matching borrower demand (`OfferMatchFacet.matchIntent`)
 * and, with the dedicated delegation, auto-ROLLS fully-repaid intent
 * loans (`LenderIntentFacet.rollIntentLoan`) — zero-gap redeployment
 * with no manual claim/refund round-trip.
 *
 * The enable sequence is ordered and **resumable** — every step probes
 * its on-chain post-state first, so a sequence interrupted mid-way (a
 * rejected wallet prompt, a dropped tx) resumes from where it stopped
 * on the next click rather than redoing completed steps. The order is
 * security-critical: registration reactivates and re-lists a PAUSED
 * intent's reserved capital into the fill registry, so every
 * authorisation that gates fillability is recorded BEFORE registration:
 *
 *   1. `setAutoLendConsent(true)` — the user-level opt-in marker, FIRST,
 *      so the intent is never fillable with it unset. When the admin
 *      consent kill-switch is down this step can't run; the sequence is
 *      rejected up front (nothing is written on-chain).
 *   2. Keeper delegation (only when the keeper address is published for
 *      this chain): `setKeeperAccess(true)` + `approveKeeper` /
 *      `setKeeperActions` granting AUTO_ROLL (+ SIGNED_FILL when the
 *      intent is keeper-gated) — BEFORE registration relists capital.
 *   3. `setLenderIntent(...)` — register / update (relist) the intent.
 *   4. `fundLenderIntent(...)` LAST — pulls working capital into vault
 *      custody only after every authorisation is in place, so capital
 *      is never parked ahead of a fillable, properly-delegated intent.
 *
 * Registration records the same mandatory risk/terms consent the
 * offer-create flow captures, so the user must tick the risk-disclosure
 * checkbox first (the `riskAndTermsConsent` flag is never hard-coded).
 *
 * **Pause genuinely stops fills.** Because `autoLendConsent` is only a
 * dapp marker with no on-chain enforcement, clearing it would NOT stop
 * the keeper from filling a funded intent. Pause therefore CANCELS the
 * intent (de-lists it from the fill registry) and clears consent; the
 * funded capital stays reserved (re-enable resumes with no re-funding,
 * or withdraw retrieves it).
 *
 * All loaded reads are keyed by the connected wallet (and pair / lending
 * asset) so a wallet or pair switch can never let a previous account's
 * consent / delegation / decimals drive a skip decision for a new one.
 *
 * Two admin kill-switches are surfaced read-only: the consent switch
 * (`getAutoLendEnabled`) gates step 3, and the fill-path switch
 * (`isLenderIntentEnabled`) governs whether the keeper may execute
 * fills yet — an intent can be registered + funded while it's off, and
 * starts filling automatically once governance flips it on.
 */

// Keeper action bits — mirror `LibVaipakam.KEEPER_ACTION_*`.
const KEEPER_ACTION_SIGNED_FILL = 0x40; // 1 << 6
const KEEPER_ACTION_AUTO_ROLL = 0x80; // 1 << 7

/** Ethers-Contract-shaped tx the diamond write handle returns. */
type WriteTx = { wait: () => Promise<unknown> };

/** On-chain `LenderIntent` struct shape (read side). */
type IntentView = {
  active: boolean;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number | bigint;
  maxDurationDays: number | bigint;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
};

type FormState = {
  lendingAsset: string;
  collateralAsset: string;
  maxExposure: string; // lendingAsset units
  fundAmount: string; // lendingAsset units, pulled wallet -> vault on enable
  minFillAmount: string; // lendingAsset units
  minRatePct: string; // % APR floor (=> bps = pct * 100)
  maxInitLtvPct: string; // % (=> bps)
  maxDurationDays: string;
  requiresKeeperAuth: boolean;
};

const DEFAULT_FORM: FormState = {
  lendingAsset: '',
  collateralAsset: '',
  maxExposure: '',
  fundAmount: '',
  minFillAmount: '',
  minRatePct: '',
  maxInitLtvPct: '70',
  maxDurationDays: '30',
  requiresKeeperAuth: false,
};

export default function AutoLendIntentCard() {
  const { t } = useTranslation();
  const { address, activeChain, isCorrectChain, chainId } = useWallet();
  const diamond = useDiamondContract();
  const diamondRo = useDiamondRead();

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  // Latest form, readable inside async resolves to guard against a
  // stale pair switch without threading state through closures. Kept
  // current via an effect (ref writes don't belong in render).
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  // Latest `${chainId}:${wallet}`, so an async prefill resolve can also
  // detect a wallet/chain switch (not just a pair switch) before writing
  // the form. Updated in an effect below once `idKey` is derived.
  const idKeyRef = useRef('');
  const setField = useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) =>
      setForm((f) => ({ ...f, [k]: v })),
    [],
  );

  // ── Read state (per chosen pair) ─────────────────────────────────
  const [adminLendEnabled, setAdminLendEnabled] = useState<boolean | null>(null);
  const [fillPathEnabled, setFillPathEnabled] = useState<boolean | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [intent, setIntent] = useState<IntentView | null>(null);
  const [capital, setCapital] = useState<bigint | null>(null);
  const [keeperActions, setKeeperActions] = useState<number | null>(null);
  const [keeperAccess, setKeeperAccess] = useState<boolean | null>(null);
  const [lendingDecimals, setLendingDecimals] = useState<number>(18);
  // `${chainId}:${lendingAsset}` the decimals were read for — writes are
  // gated until this matches the form so amounts never parse with a
  // previous token's (or chain's) decimals (a 6-dec/18-dec swap, or a
  // same-address token on another chain, would misscale).
  const [decimalsKey, setDecimalsKey] = useState<string>('');
  // `${chainId}:${wallet}` the account-level reads (consent / keeper
  // grant) belong to — trusted only while it still equals the live id.
  const [loadedAccountKey, setLoadedAccountKey] = useState<string>('');

  // Mandatory risk/terms consent + (when enabling the global keeper
  // master switch) an explicit acknowledgement that doing so reactivates
  // every keeper the wallet has approved. Each is stamped with its OWN
  // `${chainId}:${wallet}` key — separate so ticking one never makes the
  // other count as accepted, and a wallet/chain switch makes the new
  // account re-accept each before registration.
  const [riskConsent, setRiskConsent] = useState<boolean>(false);
  const [riskConsentKey, setRiskConsentKey] = useState<string>('');
  const [ackKeeperMaster, setAckKeeperMaster] = useState<boolean>(false);
  const [ackKeeperKey, setAckKeeperKey] = useState<string>('');

  const [busy, setBusy] = useState<boolean>(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Keeper EOA published for THIS chain (operator-set in addresses.json).
  // Absent => delegation step is hidden (auto-FILL still works; auto-ROLL
  // needs the grant, so the card explains it's unavailable here).
  const keeperAddress = useMemo<string | null>(() => {
    if (chainId == null) return null;
    return getDeployment(chainId)?.keeperAddress ?? null;
  }, [chainId]);

  const lendingErc20 = useERC20(form.lendingAsset || null);

  // `${chainId}:${wallet}:${lend}:${coll}` the loaded intent/capital
  // belong to — render gates on it so no prior pair's, wallet's, OR
  // chain's data shows after a switch (avoids a synchronous reset-in-
  // effect; everything below is set post-await).
  const [loadedPairKey, setLoadedPairKey] = useState<string>('');
  // chain+wallet+pair the form was last prefilled from, so prefill runs once.
  const [prefilledKey, setPrefilledKey] = useState<string>('');

  // Identity all stamps are scoped to: a chain switch OR a wallet switch
  // invalidates every loaded read so none can drive a stale skip decision.
  const idKey = `${chainId ?? ''}:${address ?? ''}`;
  const currentPairKey = `${idKey}:${form.lendingAsset}:${form.collateralAsset}`;
  const currentDecimalsKey = `${chainId ?? ''}:${form.lendingAsset}`;
  useEffect(() => {
    idKeyRef.current = idKey;
  }, [idKey]);

  // Account-level reads (independent of the chosen pair). Returns early
  // without touching state when deps are missing — so every setState
  // lands post-await and never trips react-hooks/set-state-in-effect.
  const reloadAccount = useCallback(async () => {
    if (!address || !diamondRo) return;
    try {
      const ro = diamondRo as unknown as {
        getAutoLendEnabled: () => Promise<boolean>;
        isLenderIntentEnabled: () => Promise<boolean>;
        getAutoLendConsent: (u: string) => Promise<boolean>;
        getKeeperAccess: (u: string) => Promise<boolean>;
        getKeeperActions: (u: string, k: string) => Promise<bigint | number>;
      };
      const [adminLend, fillPath, c, kAccess, acts] = await Promise.all([
        ro.getAutoLendEnabled(),
        ro.isLenderIntentEnabled(),
        ro.getAutoLendConsent(address),
        ro.getKeeperAccess(address),
        keeperAddress
          ? ro.getKeeperActions(address, keeperAddress)
          : Promise.resolve(null),
      ]);
      setAdminLendEnabled(Boolean(adminLend));
      setFillPathEnabled(Boolean(fillPath));
      setConsent(Boolean(c));
      setKeeperAccess(Boolean(kAccess));
      setKeeperActions(acts === null ? null : Number(acts));
      // Stamp the chain+wallet these reads belong to; skip decisions
      // trust them only while this still equals the live id.
      setLoadedAccountKey(`${chainId ?? ''}:${address}`);
    } catch {
      // Facet not cut on this (old) deploy — leave loading; card hides.
    }
  }, [address, chainId, diamondRo, keeperAddress]);

  // Pair-scoped reads — intent struct + funded capital + lending-token
  // decimals, all in one pass so prefill formats with the right decimals.
  // Folds the prefill in (post-await) so there's no derived-state effect.
  const reloadPair = useCallback(async () => {
    const lendingAsset = form.lendingAsset;
    const collateralAsset = form.collateralAsset;
    if (!address || !diamondRo || !lendingAsset || !collateralAsset) return;
    const key = `${chainId ?? ''}:${address}:${lendingAsset}:${collateralAsset}`;
    try {
      const ro = diamondRo as unknown as {
        getLenderIntent: (o: string, l: string, c: string) => Promise<IntentView>;
        getLenderIntentCapital: (
          o: string,
          l: string,
          c: string,
        ) => Promise<bigint>;
      };
      const decimalsP = lendingErc20
        ? (lendingErc20 as unknown as { decimals: () => Promise<number> })
            .decimals()
            .then((d) => Number(d) || 18)
            .catch(() => 18)
        : Promise.resolve(18);
      const [iv, cap, dec] = await Promise.all([
        ro.getLenderIntent(address, lendingAsset, collateralAsset),
        ro.getLenderIntentCapital(address, lendingAsset, collateralAsset),
        decimalsP,
      ]);
      const view: IntentView = {
        active: Boolean(iv.active),
        maxExposure: BigInt(iv.maxExposure),
        minRateBps: BigInt(iv.minRateBps),
        maxInitLtvBps: Number(iv.maxInitLtvBps),
        maxDurationDays: Number(iv.maxDurationDays),
        minFillAmount: BigInt(iv.minFillAmount),
        requiresKeeperAuth: Boolean(iv.requiresKeeperAuth),
      };
      setLendingDecimals(dec);
      setDecimalsKey(`${chainId ?? ''}:${lendingAsset}`);
      setIntent(view);
      setCapital(BigInt(cap));
      setLoadedPairKey(key);
      // Prefill the form once per (chain, wallet, pair) from a stored
      // intent, so editing shows current on-chain terms. Also prefill an
      // INACTIVE intent that still has reserved capital (a paused intent)
      // so "Enable to resume" has the prior bounds without manual re-entry.
      // Guard against a stale resolve by re-deriving the FULL live key
      // (chain+wallet+pair via the refs) and only applying / stamping when
      // it still matches the captured `key` — so a wallet/chain/pair switch
      // mid-flight can't write another account's terms, and a stale resolve
      // never marks a pair prefilled without applying it.
      const hasStoredTerms = view.active || BigInt(cap) > 0n;
      if (hasStoredTerms && prefilledKey !== key) {
        const live = formRef.current;
        const liveFullKey = `${idKeyRef.current}:${live.lendingAsset}:${live.collateralAsset}`;
        if (liveFullKey === key) {
          setPrefilledKey(key);
          setForm((f) => ({
            ...f,
            maxExposure: formatUnits(view.maxExposure, dec),
            minFillAmount: formatUnits(view.minFillAmount, dec),
            minRatePct: String(Number(view.minRateBps) / 100),
            maxInitLtvPct: String(Number(view.maxInitLtvBps) / 100),
            maxDurationDays: String(Number(view.maxDurationDays)),
            requiresKeeperAuth: view.requiresKeeperAuth,
          }));
        }
      }
    } catch {
      setLoadedPairKey(key);
      setIntent(null);
      setCapital(null);
    }
  }, [
    address,
    chainId,
    diamondRo,
    form.lendingAsset,
    form.collateralAsset,
    lendingErc20,
    prefilledKey,
  ]);

  useEffect(() => {
    // Data-sync effect: pulls account-level chain state into React state.
    // All writes are post-await; the rule flags the call site regardless,
    // so we opt out here exactly as the other data-loading hooks do.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadAccount();
  }, [reloadAccount]);
  useEffect(() => {
    // Data-sync effect (pair-scoped reads). See note above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadPair();
  }, [reloadPair]);

  // Only treat the loaded intent/capital as belonging to the chosen
  // chain+wallet+pair once `reloadPair` has resolved for it — otherwise
  // hold them as "not yet known" so no prior pair's / wallet's / chain's
  // data leaks into the UI or a skip decision.
  const pairLoaded =
    !!form.lendingAsset &&
    !!form.collateralAsset &&
    loadedPairKey === currentPairKey;
  const intentView = pairLoaded ? intent : null;
  const capitalView = pairLoaded ? capital : null;
  // Account-level reads are trustworthy only while they belong to the
  // connected chain+wallet; decimals only while they belong to the chosen
  // chain+lending-asset. Writes are gated on both so a wallet / chain /
  // asset switch can't drive a stale skip decision or misscale an amount.
  const accountLoaded = !!address && loadedAccountKey === idKey;
  const decimalsReady =
    !!form.lendingAsset && decimalsKey === currentDecimalsKey;
  // Each consent is valid only for the chain+wallet it was given under
  // (separate keys), so a wallet/chain switch forces the new account to
  // re-accept and ticking one never implies the other.
  const riskConsentGiven = riskConsent && riskConsentKey === idKey;
  const ackKeeperMasterGiven = ackKeeperMaster && ackKeeperKey === idKey;

  // ── Derived ──────────────────────────────────────────────────────
  const diamondAddr = useMemo(
    () =>
      (activeChain && isCorrectChain ? activeChain.diamondAddress : null) ??
      DEFAULT_CHAIN.diamondAddress,
    [activeChain, isCorrectChain],
  );

  const desiredKeeperActions = useMemo(
    () =>
      KEEPER_ACTION_AUTO_ROLL |
      (form.requiresKeeperAuth ? KEEPER_ACTION_SIGNED_FILL : 0),
    [form.requiresKeeperAuth],
  );

  const parsed = useMemo(() => {
    try {
      const maxExposure = form.maxExposure
        ? parseUnits(form.maxExposure, lendingDecimals)
        : 0n;
      const minFill = form.minFillAmount
        ? parseUnits(form.minFillAmount, lendingDecimals)
        : 0n;
      const fund = form.fundAmount
        ? parseUnits(form.fundAmount, lendingDecimals)
        : 0n;
      // Percent / term fields go through Number() — reject non-finite
      // (e.g. "abc" -> NaN) and negative values here so the form shows a
      // validation error instead of letting a NaN slip past the range
      // checks (NaN comparisons are all false) or a negative bigint reach
      // the uint256 encoder and fail at the wallet.
      const minRateNum = Number(form.minRatePct || '0');
      const maxLtvNum = Number(form.maxInitLtvPct || '0');
      const durNum = Number(form.maxDurationDays || '0');
      if (
        !Number.isFinite(minRateNum) ||
        !Number.isFinite(maxLtvNum) ||
        !Number.isFinite(durNum) ||
        minRateNum < 0 ||
        maxLtvNum < 0 ||
        durNum < 0
      ) {
        return { ok: false as const };
      }
      const minRateBps = BigInt(Math.round(minRateNum * 100));
      const maxInitLtvBps = Math.round(maxLtvNum * 100);
      const maxDurationDays = Math.round(durNum);
      return { maxExposure, minFill, fund, minRateBps, maxInitLtvBps, maxDurationDays, ok: true as const };
    } catch {
      return { ok: false as const };
    }
  }, [form, lendingDecimals]);

  const validation = useMemo<string | null>(() => {
    if (!form.lendingAsset || !form.collateralAsset)
      return t('autoLend.errPickPair');
    if (form.lendingAsset.toLowerCase() === form.collateralAsset.toLowerCase())
      return t('autoLend.errSamePair');
    if (!parsed.ok) return t('autoLend.errAmount');
    if (parsed.maxExposure <= 0n) return t('autoLend.errExposure');
    if (parsed.minFill <= 0n || parsed.minFill > parsed.maxExposure)
      return t('autoLend.errMinFill');
    if (parsed.maxInitLtvBps <= 0 || parsed.maxInitLtvBps > 10000)
      return t('autoLend.errLtv');
    // Term is a uint32 on-chain (and must be positive); reject 0 and any
    // value past the uint32 ceiling before the multi-tx flow so it can't
    // fail at ABI-encoding after consent + grants are already recorded.
    if (parsed.maxDurationDays <= 0 || parsed.maxDurationDays > 4294967295)
      return t('autoLend.errDuration');
    // Rate floor can't exceed the protocol interest ceiling (100% APR) —
    // the contract rejects it, so catch it before the multi-tx flow.
    if (parsed.minRateBps > 10000n) return t('autoLend.errRateTooHigh');
    if (parsed.fund < 0n) return t('autoLend.errAmount');
    // Cap the TOTAL reserved capital (already-funded + this top-up) at the
    // max exposure — funding beyond it just locks idle capital that can
    // never be lent (exposure caps concurrent live principal).
    if ((capitalView ?? 0n) + parsed.fund > parsed.maxExposure)
      return t('autoLend.errFundOverExposure');
    // A keeper-only intent on a chain with no published keeper can never
    // be filled (no solver can hold the signed-fill grant) — block it.
    if (form.requiresKeeperAuth && !keeperAddress)
      return t('autoLend.errKeeperOnlyNoKeeper');
    // Mandatory risk/terms consent — the registration records it, so the
    // user must accept the disclosures first (never recorded silently).
    if (!riskConsentGiven) return t('autoLend.errRiskConsent');
    // Enabling auto-lend flips the GLOBAL keeper master switch, which
    // reactivates every keeper this wallet has approved — require an
    // explicit acknowledgement when it's currently off.
    if (keeperAddress && keeperAccess === false && !ackKeeperMasterGiven)
      return t('autoLend.errAckKeeperMaster');
    return null;
  }, [
    form,
    parsed,
    capitalView,
    keeperAddress,
    keeperAccess,
    riskConsentGiven,
    ackKeeperMasterGiven,
    t,
  ]);

  // Whether the on-chain intent already matches the form (lets the
  // resumable enable skip step 1).
  const intentMatchesForm = useMemo(() => {
    if (!intentView?.active || !parsed.ok) return false;
    return (
      intentView.maxExposure === parsed.maxExposure &&
      intentView.minFillAmount === parsed.minFill &&
      intentView.minRateBps === parsed.minRateBps &&
      Number(intentView.maxInitLtvBps) === parsed.maxInitLtvBps &&
      Number(intentView.maxDurationDays) === parsed.maxDurationDays &&
      intentView.requiresKeeperAuth === form.requiresKeeperAuth
    );
  }, [intentView, parsed, form.requiresKeeperAuth]);

  const dw = diamond as unknown as Record<string, (...a: unknown[]) => Promise<WriteTx>>;

  // ── Enable sequence (resumable) ──────────────────────────────────
  const handleEnable = async () => {
    // Gate on fresh, wallet-correct reads so a stale wallet/asset can't
    // drive a skip decision or misscale amounts.
    if (!address || !diamond || !parsed.ok || !accountLoaded || !decimalsReady)
      return;
    if (validation) {
      setError(validation);
      return;
    }
    // Consent kill-switch gate — checked BEFORE touching the chain. When
    // consent isn't already recorded and the admin switch is down, the
    // consent-first step below can't run, so abort entirely rather than
    // register an intent that could never be consented (and, for a paused
    // intent, would relist reserved capital). (`adminLendEnabled`/`consent`
    // are trusted because Enable is gated on `accountLoaded`.)
    if (consent === false && adminLendEnabled === false) {
      setNotice(t('autoLend.noticeConsentBlocked'));
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { lendingAsset, collateralAsset } = form;

      // Ordering rationale: consent -> delegate -> register -> fund.
      // Registration (setLenderIntent) reactivates and relists a PAUSED
      // intent's reserved capital into the fill registry, so every
      // authorisation that must be in place before the intent can be
      // filled is done FIRST:
      //   1. consent  — the intent is never fillable with the marker unset.
      //   2. delegate — the keeper holds auto-roll / signed-fill before the
      //                 intent (re)lists, so a failed grant can't leave a
      //                 relisted intent without its intended delegation.
      // then register relists/creates, then fund adds capital last.

      // 1. Consent marker FIRST. The blocked case (admin off + consent
      //    unset) was already rejected at the top, so here consent is
      //    either already true or the admin switch allows setting it.
      if (consent === false) {
        setStep(t('autoLend.stepConsent'));
        const tx = await dw.setAutoLendConsent(true);
        await tx.wait();
        setConsent(true);
      }

      // 2. Keeper delegation (only when a keeper is published here) —
      //    BEFORE registration, so re-listing paused capital never
      //    outruns the grant.
      if (keeperAddress) {
        if (keeperAccess === false) {
          setStep(t('autoLend.stepKeeperAccess'));
          const tx = await dw.setKeeperAccess(true);
          await tx.wait();
          setKeeperAccess(true);
        }
        const current = keeperActions ?? 0;
        if (current === 0) {
          setStep(t('autoLend.stepGrant'));
          const tx = await dw.approveKeeper(keeperAddress, desiredKeeperActions);
          await tx.wait();
          setKeeperActions(desiredKeeperActions);
        } else if ((current & desiredKeeperActions) !== desiredKeeperActions) {
          setStep(t('autoLend.stepGrant'));
          const tx = await dw.setKeeperActions(
            keeperAddress,
            current | desiredKeeperActions,
          );
          await tx.wait();
          setKeeperActions(current | desiredKeeperActions);
        }
      }

      // 3. Register / update the standing intent (skip if unchanged).
      if (!intentMatchesForm) {
        setStep(t('autoLend.stepRegister'));
        const tx = await dw.setLenderIntent(
          lendingAsset,
          collateralAsset,
          parsed.maxExposure,
          parsed.minRateBps,
          parsed.maxInitLtvBps,
          parsed.maxDurationDays,
          parsed.minFill,
          form.requiresKeeperAuth,
          riskConsentGiven, // mandatory risk/terms consent — validated above, never silent
        );
        await tx.wait();
      }

      // 4. Fund LAST — only after every authorisation is in place.
      if (parsed.fund > 0n) {
        if (!lendingErc20) throw new Error(t('autoLend.errNoToken'));
        setStep(t('autoLend.stepApprove'));
        const erc20 = lendingErc20 as unknown as {
          allowance: (o: string, s: string) => Promise<bigint>;
          approve: (s: string, n: bigint) => Promise<WriteTx>;
        };
        const allowance = await erc20.allowance(address, diamondAddr);
        if (allowance < parsed.fund) {
          // Exact-amount approval convention (never MaxUint256).
          const atx = await erc20.approve(diamondAddr, parsed.fund);
          await atx.wait();
        }
        setStep(t('autoLend.stepFund'));
        const tx = await dw.fundLenderIntent(
          lendingAsset,
          collateralAsset,
          parsed.fund,
        );
        await tx.wait();
        setField('fundAmount', '');
      }

      setNotice((n) => n ?? t('autoLend.noticeEnabled'));
      await Promise.all([reloadAccount(), reloadPair()]);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
      // Refresh on-chain state so a retry after a partial failure
      // resumes at the next incomplete step rather than redoing
      // already-committed ones.
      await Promise.all([reloadAccount(), reloadPair()]).catch(() => {});
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // ── Pause — genuinely stop fills by CANCELLING the intent ─────────
  // Clearing `autoLendConsent` alone would not stop fills (it's a dapp
  // marker with no on-chain enforcement; `matchIntent` reads the active
  // intent + capital). Cancelling de-lists the intent from the fill
  // registry; the funded capital stays reserved (re-enable resumes with
  // no re-funding, or Withdraw retrieves it).
  const handlePause = async () => {
    if (!address || !diamond) return;
    const { lendingAsset, collateralAsset } = form;
    if (!lendingAsset || !collateralAsset) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setStep(t('autoLend.stepCancel'));
      const tx = await dw.cancelLenderIntent(lendingAsset, collateralAsset);
      await tx.wait();
      if (consent) {
        setStep(t('autoLend.stepConsent'));
        const tx2 = await dw.setAutoLendConsent(false);
        await tx2.wait();
        setConsent(false);
      }
      setNotice(t('autoLend.noticePaused'));
      await Promise.all([reloadAccount(), reloadPair()]);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
      await Promise.all([reloadAccount(), reloadPair()]).catch(() => {});
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // ── Withdraw all un-lent capital + cancel the intent ─────────────
  const handleWithdrawAndStop = async () => {
    if (!address || !diamond) return;
    const { lendingAsset, collateralAsset } = form;
    if (!lendingAsset || !collateralAsset) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Cancel (de-list) FIRST so no keeper can match the intent during
      // the withdraw signature window — then pull the now-un-fillable
      // capital (the contract's withdraw path stays usable after cancel).
      if (intentView?.active) {
        setStep(t('autoLend.stepCancel'));
        const tx = await dw.cancelLenderIntent(lendingAsset, collateralAsset);
        await tx.wait();
      }
      if ((capitalView ?? 0n) > 0n) {
        setStep(t('autoLend.stepWithdraw'));
        const tx = await dw.withdrawLenderIntentCapital(
          lendingAsset,
          collateralAsset,
          capitalView,
        );
        await tx.wait();
      }
      if (consent) {
        setStep(t('autoLend.stepConsent'));
        const tx = await dw.setAutoLendConsent(false);
        await tx.wait();
        setConsent(false);
      }
      // NOTE: we deliberately do NOT auto-revoke the keeper's
      // SIGNED_FILL / AUTO_ROLL bits here. Those are PRINCIPAL-level
      // (one bitmask per wallet, not per pair), so the same grant backs
      // every standing intent this wallet has — clearing it on a
      // single-pair stop would silently disable fills/rolls for the
      // lender's OTHER active intents. The bits are inert without a
      // funded intent anyway; the notice points the user to Keeper
      // Settings to revoke deliberately if they have no other intents.
      const stoppedKey = keeperAddress
        ? 'autoLend.noticeStoppedKeeper'
        : 'autoLend.noticeStopped';
      setNotice(t(stoppedKey));
      await Promise.all([reloadAccount(), reloadPair()]);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
      await Promise.all([reloadAccount(), reloadPair()]).catch(() => {});
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  if (!address) return null;
  // Hide the card entirely on deploys where the facet set isn't cut yet.
  if (adminLendEnabled == null && fillPathEnabled == null && consent == null) {
    return null;
  }

  const isActive = Boolean(intentView?.active);
  const capitalStr =
    capitalView != null ? formatUnits(capitalView, lendingDecimals) : null;
  const grantSatisfied =
    !keeperAddress ||
    ((keeperActions ?? 0) & desiredKeeperActions) === desiredKeeperActions;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Coins
          size={22}
          style={{
            color: isActive ? 'var(--accent-green)' : 'var(--text-tertiary)',
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ flex: 1 }}>
          <div className="card-title" style={{ marginBottom: 4 }}>
            {t('autoLend.title')}
            <CardInfo id="dashboard.auto-lend-intent" />
          </div>
          <p className="stat-label" style={{ margin: '0 0 10px' }}>
            {t('autoLend.body')}
          </p>

          {/* Fill-path kill-switch — registered intents won't fill yet. */}
          {fillPathEnabled === false && (
            <div className="alert alert-info" role="status" style={{ marginBottom: 10 }}>
              <Info size={14} />
              <div>{t('autoLend.fillPathOff')}</div>
            </div>
          )}

          {/* Active-intent status summary */}
          {isActive && (
            <div className="alert alert-info" role="status" style={{ marginBottom: 10 }}>
              <CheckCircle2 size={14} />
              <div>
                {t('autoLend.activeSummary', {
                  capital: capitalStr ?? '0',
                })}
                {consent === false && ` — ${t('autoLend.pausedTag')}`}
                {keeperAddress && !grantSatisfied && ` — ${t('autoLend.grantMissingTag')}`}
              </div>
            </div>
          )}

          {/* ── Configuration form ── */}
          <div style={{ display: 'grid', gap: 10 }}>
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={form.lendingAsset}
              onChange={(a) => setField('lendingAsset', a)}
              label={t('autoLend.lendingAssetLabel')}
              required
              disabled={busy}
            />
            <AssetPicker
              mode="top"
              chainId={chainId}
              value={form.collateralAsset}
              onChange={(a) => setField('collateralAsset', a)}
              label={t('autoLend.collateralAssetLabel')}
              required
              disabled={busy}
            />

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 140 }}>
                <span className="stat-label">{t('autoLend.maxExposureLabel')}</span>
                <input
                  className="form-input"
                  inputMode="decimal"
                  value={form.maxExposure}
                  onChange={(e) => setField('maxExposure', e.target.value)}
                  placeholder="0.0"
                  disabled={busy}
                />
              </label>
              <label style={{ flex: 1, minWidth: 140 }}>
                <span className="stat-label">{t('autoLend.minFillLabel')}</span>
                <input
                  className="form-input"
                  inputMode="decimal"
                  value={form.minFillAmount}
                  onChange={(e) => setField('minFillAmount', e.target.value)}
                  placeholder="0.0"
                  disabled={busy}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 120 }}>
                <span className="stat-label">{t('autoLend.minRateLabel')}</span>
                <input
                  className="form-input"
                  inputMode="decimal"
                  value={form.minRatePct}
                  onChange={(e) => setField('minRatePct', e.target.value)}
                  placeholder="0.0"
                  disabled={busy}
                />
                {/* Suggested-rate floor — the child mounts the log-index
                    scan only once both legs are chosen, so a bare
                    Dashboard render never triggers it. */}
                {!!form.lendingAsset && !!form.collateralAsset && (
                  <MarketRateFloor
                    lendingAsset={form.lendingAsset}
                    collateralAsset={form.collateralAsset}
                    disabled={busy}
                    onUse={(pct) => setField('minRatePct', pct)}
                  />
                )}
              </label>
              <label style={{ flex: 1, minWidth: 120 }}>
                <span className="stat-label">{t('autoLend.maxLtvLabel')}</span>
                <input
                  className="form-input"
                  inputMode="decimal"
                  value={form.maxInitLtvPct}
                  onChange={(e) => setField('maxInitLtvPct', e.target.value)}
                  placeholder="70"
                  disabled={busy}
                />
              </label>
              <label style={{ flex: 1, minWidth: 120 }}>
                <span className="stat-label">{t('autoLend.maxDurationLabel')}</span>
                <input
                  className="form-input"
                  inputMode="numeric"
                  value={form.maxDurationDays}
                  onChange={(e) => setField('maxDurationDays', e.target.value)}
                  placeholder="30"
                  disabled={busy}
                />
              </label>
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={form.requiresKeeperAuth}
                onChange={(e) => setField('requiresKeeperAuth', e.target.checked)}
                disabled={busy}
              />
              <span className="stat-label">{t('autoLend.requiresKeeperAuthLabel')}</span>
            </label>

            <label>
              <span className="stat-label">{t('autoLend.fundAmountLabel')}</span>
              <input
                className="form-input"
                inputMode="decimal"
                value={form.fundAmount}
                onChange={(e) => setField('fundAmount', e.target.value)}
                placeholder="0.0"
                disabled={busy}
              />
            </label>
          </div>

          {/* Mandatory risk/terms consent — registration records it, so
              the user accepts the disclosures here (same gate the
              offer-create flow uses). Stamped with the chain+wallet it
              was given under so a switch forces re-acceptance. */}
          <div style={{ marginTop: 12 }}>
            <RiskDisclosures />
            <label className="checkbox-row" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={riskConsentGiven}
                onChange={(e) => {
                  setRiskConsent(e.target.checked);
                  setRiskConsentKey(idKey);
                }}
                disabled={busy}
              />
              <span><RiskConsentLabel /></span>
            </label>
          </div>

          {/* Global keeper master-switch acknowledgement — enabling
              auto-lend turns ON keeper access for this wallet, which
              reactivates EVERY keeper it has approved, not just the
              auto-lend keeper. Only shown when the switch is currently
              off (so enabling it would flip it). */}
          {keeperAddress && keeperAccess === false && (
            <label
              className="checkbox-row alert alert-warning"
              style={{ marginTop: 10, alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={ackKeeperMasterGiven}
                onChange={(e) => {
                  setAckKeeperMaster(e.target.checked);
                  setAckKeeperKey(idKey);
                }}
                disabled={busy}
              />
              <span>{t('autoLend.ackKeeperMasterLabel')}</span>
            </label>
          )}

          {/* Keeper-delegation availability note */}
          {!keeperAddress && (
            <div className="alert alert-info" role="status" style={{ marginTop: 10 }}>
              <Info size={14} />
              <div>{t('autoLend.noKeeperHere')}</div>
            </div>
          )}

          {/* Reserved capital after a pause (intent cancelled but capital
              still liened) — give an explicit way to retrieve it. */}
          {!isActive && (capitalView ?? 0n) > 0n && (
            <div className="alert alert-info" role="status" style={{ marginTop: 10 }}>
              <Info size={14} />
              <div>{t('autoLend.reservedCapital', { capital: capitalStr ?? '0' })}</div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleEnable}
              disabled={
                busy ||
                !isCorrectChain ||
                validation != null ||
                !accountLoaded ||
                !decimalsReady
              }
            >
              {busy && step
                ? step
                : isActive
                  ? t('autoLend.actionUpdate')
                  : t('autoLend.actionEnable')}
            </button>
            {isActive && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handlePause}
                disabled={busy}
              >
                {t('autoLend.actionPause')}
              </button>
            )}
            {(isActive || (capitalView ?? 0n) > 0n) && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleWithdrawAndStop}
                disabled={busy}
              >
                {t('autoLend.actionStop')}
              </button>
            )}
          </div>

          {!isCorrectChain && (
            <div className="alert alert-warning" role="status" style={{ marginTop: 10 }}>
              <AlertTriangle size={14} />
              <div>{t('autoLend.wrongChain')}</div>
            </div>
          )}
          {validation && form.lendingAsset && form.collateralAsset && (
            <div className="stat-label" style={{ marginTop: 8 }}>
              {validation}
            </div>
          )}
          {notice && (
            <div className="alert alert-info" role="status" style={{ marginTop: 10 }}>
              <Info size={14} />
              <div>{notice}</div>
            </div>
          )}
          {error && (
            <div className="alert alert-warning" role="status" style={{ marginTop: 10 }}>
              <AlertTriangle size={14} />
              <div>{error}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Suggested-rate floor hint. Lives in a child so `useMarketAnchorRate`
 * (and the `useLogIndex` scan behind it) only mounts once both legs are
 * chosen — a bare Dashboard render never triggers the log-index scan.
 */
function MarketRateFloor({
  lendingAsset,
  collateralAsset,
  disabled,
  onUse,
}: {
  lendingAsset: string;
  collateralAsset: string;
  disabled: boolean;
  onUse: (pct: string) => void;
}) {
  const { t } = useTranslation();
  const anchorBps = useMarketAnchorRate(lendingAsset, collateralAsset);
  if (anchorBps === null) return null;
  const pct = Number(anchorBps) / 100;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      style={{ marginTop: 4 }}
      onClick={() => onUse(String(pct))}
      disabled={disabled}
    >
      {t('autoLend.useMarketRate', { pct: pct.toFixed(2) })}
    </button>
  );
}
