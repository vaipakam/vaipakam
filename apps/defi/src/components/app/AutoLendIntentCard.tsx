import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * on the next click rather than redoing completed steps:
 *
 *   1. `setLenderIntent(...)` — register / update the standing intent.
 *   2. Keeper delegation (only when the keeper address is published for
 *      this chain): `setKeeperAccess(true)` + `approveKeeper` /
 *      `setKeeperActions` granting AUTO_ROLL (+ SIGNED_FILL when the
 *      intent is keeper-gated).
 *   3. `setAutoLendConsent(true)` — the user-level opt-in marker. When
 *      the admin consent kill-switch is down this step can't run; the
 *      sequence then STOPS before funding (the funded intent would be
 *      fillable while the marker is unset, breaking the ordering).
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
  // The lending asset `lendingDecimals` was last read for — writes are
  // gated until this matches the form so amounts never parse with a
  // previous token's decimals (a 6-dec/18-dec swap would misscale).
  const [decimalsAsset, setDecimalsAsset] = useState<string>('');
  // The wallet `reloadAccount` last resolved for — account-level reads
  // (consent / keeper grant) are only trusted while this equals `address`.
  const [loadedAccountAddr, setLoadedAccountAddr] = useState<string>('');

  // Mandatory risk/terms consent — must be ticked before registering,
  // mirroring the offer-create flow (never hard-coded to true).
  const [riskConsent, setRiskConsent] = useState<boolean>(false);

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

  // `${wallet}:${lend}:${coll}` the loaded intent/capital belong to —
  // render gates on it so neither a prior pair's NOR a prior wallet's
  // data shows after a switch (avoids a synchronous reset-in-effect;
  // everything below is set post-await).
  const [loadedPairKey, setLoadedPairKey] = useState<string>('');
  // Wallet+pair the form was last prefilled from, so prefill runs once.
  const [prefilledKey, setPrefilledKey] = useState<string>('');

  const currentPairKey = `${address ?? ''}:${form.lendingAsset}:${form.collateralAsset}`;

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
      // Stamp the wallet these reads belong to; skip decisions trust
      // them only while this still equals the connected wallet.
      setLoadedAccountAddr(address);
    } catch {
      // Facet not cut on this (old) deploy — leave loading; card hides.
    }
  }, [address, diamondRo, keeperAddress]);

  // Pair-scoped reads — intent struct + funded capital + lending-token
  // decimals, all in one pass so prefill formats with the right decimals.
  // Folds the prefill in (post-await) so there's no derived-state effect.
  const reloadPair = useCallback(async () => {
    const lendingAsset = form.lendingAsset;
    const collateralAsset = form.collateralAsset;
    if (!address || !diamondRo || !lendingAsset || !collateralAsset) return;
    const key = `${address}:${lendingAsset}:${collateralAsset}`;
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
      setDecimalsAsset(lendingAsset);
      setIntent(view);
      setCapital(BigInt(cap));
      setLoadedPairKey(key);
      // Prefill the form once per (wallet, pair) from an active intent,
      // so editing shows current on-chain terms.
      if (view.active && prefilledKey !== key) {
        setPrefilledKey(key);
        setForm((f) => {
          // Guard against a stale resolve: if the user switched pairs
          // while this read was in flight, don't overwrite the new
          // pair's editable bounds with this (now-stale) intent's terms.
          if (`${f.lendingAsset}:${f.collateralAsset}` !== `${lendingAsset}:${collateralAsset}`) {
            return f;
          }
          return {
            ...f,
            maxExposure: formatUnits(view.maxExposure, dec),
            minFillAmount: formatUnits(view.minFillAmount, dec),
            minRatePct: String(Number(view.minRateBps) / 100),
            maxInitLtvPct: String(Number(view.maxInitLtvBps) / 100),
            maxDurationDays: String(Number(view.maxDurationDays)),
            requiresKeeperAuth: view.requiresKeeperAuth,
          };
        });
      }
    } catch {
      setLoadedPairKey(key);
      setIntent(null);
      setCapital(null);
    }
  }, [
    address,
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

  // Market anchor (suggested rate floor) for the chosen pair.
  const anchorBps = useMarketAnchorRate(form.lendingAsset, form.collateralAsset);
  const anchorPct = useMemo(
    () => (anchorBps !== null ? Number(anchorBps) / 100 : null),
    [anchorBps],
  );

  // Only treat the loaded intent/capital as belonging to the chosen
  // wallet+pair once `reloadPair` has resolved for it — otherwise hold
  // them as "not yet known" so a prior pair's / wallet's data never
  // leaks into the UI or a skip decision.
  const pairLoaded =
    !!form.lendingAsset &&
    !!form.collateralAsset &&
    loadedPairKey === currentPairKey;
  const intentView = pairLoaded ? intent : null;
  const capitalView = pairLoaded ? capital : null;
  // Account-level reads are trustworthy only while they belong to the
  // connected wallet; decimals only while they belong to the chosen
  // lending asset. Writes are gated on both so a wallet/asset switch
  // can't drive a stale skip decision or misscale an amount.
  const accountLoaded = !!address && loadedAccountAddr === address;
  const decimalsReady = !!form.lendingAsset && decimalsAsset === form.lendingAsset;

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
      const minRateBps = BigInt(Math.round(Number(form.minRatePct || '0') * 100));
      const maxInitLtvBps = Math.round(Number(form.maxInitLtvPct || '0') * 100);
      const maxDurationDays = Math.round(Number(form.maxDurationDays || '0'));
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
    if (parsed.maxDurationDays <= 0) return t('autoLend.errDuration');
    if (parsed.fund > parsed.maxExposure) return t('autoLend.errFundOverExposure');
    // A keeper-only intent on a chain with no published keeper can never
    // be filled (no solver can hold the signed-fill grant) — block it.
    if (form.requiresKeeperAuth && !keeperAddress)
      return t('autoLend.errKeeperOnlyNoKeeper');
    // Mandatory risk/terms consent — the registration records it, so the
    // user must accept the disclosures first (never recorded silently).
    if (!riskConsent) return t('autoLend.errRiskConsent');
    return null;
  }, [form, parsed, keeperAddress, riskConsent, t]);

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
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { lendingAsset, collateralAsset } = form;

      // 1. Register / update the standing intent (skip if unchanged).
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
          riskConsent, // mandatory risk/terms consent — validated above, never silent
        );
        await tx.wait();
      }

      // 2. Keeper delegation (only when a keeper is published here).
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

      // 3. Consent marker (gated by the admin consent kill-switch).
      if (consent === false) {
        if (adminLendEnabled === false) {
          // Can't set consent now. STOP before funding: a funded intent
          // is fillable on-chain regardless of this marker, so funding
          // here would let the keeper fill while the user-level consent
          // is still unset — breaking the register → consent → fund
          // ordering. The intent + grant stay in place; the user can
          // fund once admin re-enables and consent is recorded.
          setNotice(t('autoLend.noticeConsentBlocked'));
          await Promise.all([reloadAccount(), reloadPair()]);
          return;
        }
        setStep(t('autoLend.stepConsent'));
        const tx = await dw.setAutoLendConsent(true);
        await tx.wait();
        setConsent(true);
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
      if ((capitalView ?? 0n) > 0n) {
        setStep(t('autoLend.stepWithdraw'));
        const tx = await dw.withdrawLenderIntentCapital(
          lendingAsset,
          collateralAsset,
          capitalView,
        );
        await tx.wait();
      }
      if (intentView?.active) {
        setStep(t('autoLend.stepCancel'));
        const tx = await dw.cancelLenderIntent(lendingAsset, collateralAsset);
        await tx.wait();
      }
      if (consent) {
        setStep(t('autoLend.stepConsent'));
        const tx = await dw.setAutoLendConsent(false);
        await tx.wait();
        setConsent(false);
      }
      setNotice(t('autoLend.noticeStopped'));
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
                {anchorPct !== null && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    style={{ marginTop: 4 }}
                    onClick={() => setField('minRatePct', String(anchorPct))}
                    disabled={busy}
                  >
                    {t('autoLend.useMarketRate', { pct: anchorPct.toFixed(2) })}
                  </button>
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
              offer-create flow uses). */}
          <div style={{ marginTop: 12 }}>
            <RiskDisclosures />
            <label className="checkbox-row" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={riskConsent}
                onChange={(e) => setRiskConsent(e.target.checked)}
                disabled={busy}
              />
              <span><RiskConsentLabel /></span>
            </label>
          </div>

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
