import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import {
  parseUnits,
  formatUnits,
  isAddress,
  zeroAddress,
  maxUint256,
} from 'viem';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import {
  useDiamondContract,
  useDiamondRead,
  useCanWrite,
} from '../../contracts/useDiamond';
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
 *      EXCEPTION: for an ALREADY-ACTIVE intent whose terms are being
 *      tightened, step 3 runs BEFORE step 2 — the intent is already
 *      fillable, so updating the terms first prevents the keeper from
 *      filling under the old looser terms between txs (see step `2 & 3`).
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
// Mirror `LibVaipakam.MAX_APPROVED_KEEPERS` — used to pre-flight a full
// keeper whitelist before recording any consent / grant side effects.
const MAX_APPROVED_KEEPERS = 5;

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

/** Fresh account-level snapshot returned by `reloadAccount` — so the
 *  enable flow can base skip/gate decisions on a just-read value rather
 *  than possibly-stale React state (TOCTOU). */
type AccountSnapshot = {
  adminLendEnabled: boolean;
  fillPathEnabled: boolean;
  consent: boolean;
  keeperAccess: boolean;
  keeperActions: number | null;
  approvedKeepersCount: number;
  /** #799 (Codex #811 r4) — global delegated-keeper pause. While ON, both
   *  auto-roll and keeper-restricted fills are suspended (open intents stay
   *  fillable by any solver). */
  keepersPaused: boolean;
};

/** Fresh pair-level snapshot returned by `reloadPair`. */
type PairSnapshot = {
  view: IntentView;
  capital: bigint;
  livePrincipal: bigint;
  decimals: number;
};

type ParsedForm = {
  maxExposure: bigint;
  minFill: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
};

/** True when an on-chain intent already matches the form's terms (so the
 *  enable flow can skip the register step). Pure so it can run against
 *  either the cached view (for the memo) or a freshly-read snapshot. */
function intentMatchesParsed(
  view: IntentView | null,
  p: ParsedForm,
  requiresKeeperAuth: boolean,
): boolean {
  if (!view?.active) return false;
  return (
    view.maxExposure === p.maxExposure &&
    view.minFillAmount === p.minFill &&
    view.minRateBps === p.minRateBps &&
    Number(view.maxInitLtvBps) === p.maxInitLtvBps &&
    Number(view.maxDurationDays) === p.maxDurationDays &&
    view.requiresKeeperAuth === requiresKeeperAuth
  );
}

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

interface AutoLendIntentCardProps {
  /**
   * #755 — pair handed in by the multi-intent list's "Manage" deep-link.
   * When it changes, the card selects this pair and prefills that intent's
   * bounds/capital, so resume/edit/fund runs the card's correct ordered
   * enable sequence. Optional & default-undefined → unchanged standalone
   * behaviour (the internal AssetPickers stay the source of truth).
   */
  selectedPair?: { lendingAsset: string; collateralAsset: string } | null;
  /**
   * Bumped on every "Manage" click so re-selecting the SAME pair re-applies
   * (and re-prefills) — the pair addresses alone wouldn't change.
   */
  selectedPairNonce?: number;
  /**
   * #755 — fired after a successful intent mutation (enable/resume, pause,
   * withdraw/stop) so a parent overview (the multi-intent list) can
   * invalidate its cached read and reflect the new state.
   */
  onIntentChanged?: () => void;
  /**
   * #755 — reports the card's busy (tx-in-flight) state to the parent so it
   * can disable the multi-intent list's "Manage" deep-links: retargeting the
   * form mid-write would show one pair while a tx for another is still
   * signing/pending.
   */
  onBusyChange?: (busy: boolean) => void;
}

export default function AutoLendIntentCard({
  selectedPair,
  selectedPairNonce,
  onIntentChanged,
  onBusyChange,
}: AutoLendIntentCardProps = {}) {
  const { t } = useTranslation();
  const { address, activeChain, isCorrectChain, chainId } = useWallet();
  const diamond = useDiamondContract();
  const diamondRo = useDiamondRead();
  // True only when state-changing calls can actually settle (wallet
  // connected, correct chain, AND no read-only view-chain override) —
  // the documented guard for write surfaces, stronger than isCorrectChain.
  const canWrite = useCanWrite();

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  // tx-in-flight. Declared up here so the Manage-retarget guard below can
  // read it; a `busyRef` mirror lets the nonce effect read it without making
  // it a dependency.
  const [busy, setBusy] = useState<boolean>(false);
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  // #755 — apply a "Manage" deep-linked pair via React's render-time
  // "adjust state when a prop changes" pattern (NOT an effect — that would
  // cost a wasted commit and trip the set-state-in-effect lint). Gated on a
  // nonce so it fires once per Manage click, including re-selecting the same
  // pair; standalone usage passes no nonce, so this never runs there.
  const [appliedPairNonce, setAppliedPairNonce] = useState(selectedPairNonce);
  if (selectedPairNonce !== appliedPairNonce) {
    setAppliedPairNonce(selectedPairNonce);
    // Self-gate the retarget while a tx is in flight: the parent disables the
    // external Manage buttons via onBusyChange, but a click queued in the
    // render/effect gap could still reach here — applying it would show a
    // different pair than the one being signed/awaited. Consume the nonce
    // (drop the slipped-through click) without retargeting.
    if (!busy && selectedPair?.lendingAsset && selectedPair?.collateralAsset) {
      setForm((f) => ({
        ...f,
        lendingAsset: selectedPair.lendingAsset,
        collateralAsset: selectedPair.collateralAsset,
        // Drop any unsubmitted top-up carried from the previously-edited
        // pair — bounds get re-prefilled from on-chain, but `fundAmount`
        // has no prefill, so a stale value would otherwise fund the newly
        // managed intent on the next Enable/Update.
        fundAmount: '',
      }));
    }
  }
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
  // Aggregate LIVE principal already out from this intent — also consumes
  // maxExposure, so funding headroom must account for it (not just idle
  // capital). Pair-scoped.
  const [livePrincipal, setLivePrincipal] = useState<bigint | null>(null);
  const [keeperActions, setKeeperActions] = useState<number | null>(null);
  const [keeperAccess, setKeeperAccess] = useState<boolean | null>(null);
  // #799 (Codex #811 r4) — global delegated-keeper pause; suspends auto-roll
  // and keeper-restricted fills while ON.
  const [keepersPaused, setKeepersPaused] = useState<boolean | null>(null);
  // How many keepers the wallet has approved — to pre-flight a full
  // whitelist before recording any consent / master-switch side effects.
  const [approvedKeepersCount, setApprovedKeepersCount] = useState<number | null>(null);
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

  // #755 — surface tx-in-flight to the parent so the multi-intent list can
  // disable "Manage" while a write is pending (post-await notify, so no
  // synchronous setState in this effect's body). `busy` is declared above.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // True when the account-level read failed TRANSIENTLY (facets are cut on
  // this chain). Keeps the card visible with a retry instead of hiding it
  // — distinct from a missing-facet deploy where the card stays hidden.
  const [accountLoadFailed, setAccountLoadFailed] = useState<boolean>(false);

  // Keeper EOA published for THIS chain (operator-set in addresses.json).
  // Absent => delegation step is hidden (auto-FILL still works; auto-ROLL
  // needs the grant, so the card explains it's unavailable here).
  const keeperAddress = useMemo<string | null>(() => {
    if (chainId == null) return null;
    return getDeployment(chainId)?.keeperAddress ?? null;
  }, [chainId]);

  // VPFI token on this chain — rejected as the LENDING asset by
  // `setLenderIntent`, so the form blocks it up front (the asset picker
  // also accepts pasted addresses).
  const vpfiToken = useMemo<string | null>(() => {
    if (chainId == null) return null;
    return getDeployment(chainId)?.vpfiToken ?? null;
  }, [chainId]);

  const lendingErc20 = useERC20(form.lendingAsset || null);

  // `${chainId}:${wallet}:${lend}:${coll}` the loaded intent/capital
  // belong to — render gates on it so no prior pair's, wallet's, OR
  // chain's data shows after a switch (avoids a synchronous reset-in-
  // effect; everything below is set post-await).
  const [loadedPairKey, setLoadedPairKey] = useState<string>('');
  // chain+wallet+pair the form was last prefilled from, so prefill runs once.
  // Wallet+pair the form was last prefilled from — a ref (not state) so
  // it isn't a `reloadPair` dependency: stamping it must NOT recreate the
  // callback and trigger a redundant re-fetch.
  const prefilledKeyRef = useRef<string>('');

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
  const reloadAccount = useCallback(async (): Promise<AccountSnapshot | null> => {
    if (!address || !diamondRo) return null;
    try {
      const ro = diamondRo as unknown as {
        getAutoLendEnabled: () => Promise<boolean>;
        isLenderIntentEnabled: () => Promise<boolean>;
        getPartialFillEnabled: () => Promise<boolean>;
        getAutoLendConsent: (u: string) => Promise<boolean>;
        getKeeperAccess: (u: string) => Promise<boolean>;
        getKeeperActions: (u: string, k: string) => Promise<bigint | number>;
        getApprovedKeepers: (u: string) => Promise<string[]>;
        keepersPaused: () => Promise<boolean>;
      };
      const [adminLend, intentEnabled, partialFill, c, kAccess, acts, keepers, paused] =
        await Promise.all([
          ro.getAutoLendEnabled(),
          ro.isLenderIntentEnabled(),
          ro.getPartialFillEnabled(),
          ro.getAutoLendConsent(address),
          ro.getKeeperAccess(address),
          keeperAddress
            ? ro.getKeeperActions(address, keeperAddress)
            : Promise.resolve(null),
          ro.getApprovedKeepers(address),
          ro.keepersPaused(),
        ]);
      // Stale-resolve guard: if a wallet/chain switch happened while this
      // read was in flight, drop it — otherwise a slower response for the
      // PREVIOUS identity could land after the new one and overwrite
      // `loadedAccountKey` with the old key, wedging `accountLoaded` false
      // for the connected wallet with no scheduled re-read.
      const capturedAccountKey = `${chainId ?? ''}:${address}`;
      if (idKeyRef.current !== capturedAccountKey) return null;

      const snap: AccountSnapshot = {
        adminLendEnabled: Boolean(adminLend),
        // matchIntent rejects when EITHER the partial-fill gate OR the
        // lender-intent gate is off (it checks partial-fill first), so
        // fills are only really possible when BOTH are enabled.
        fillPathEnabled: Boolean(intentEnabled) && Boolean(partialFill),
        consent: Boolean(c),
        keeperAccess: Boolean(kAccess),
        keeperActions: acts === null ? null : Number(acts),
        approvedKeepersCount: Array.isArray(keepers) ? keepers.length : 0,
        keepersPaused: Boolean(paused),
      };
      setAdminLendEnabled(snap.adminLendEnabled);
      setFillPathEnabled(snap.fillPathEnabled);
      setConsent(snap.consent);
      setKeeperAccess(snap.keeperAccess);
      setKeeperActions(snap.keeperActions);
      setApprovedKeepersCount(snap.approvedKeepersCount);
      setKeepersPaused(snap.keepersPaused);
      // Stamp the chain+wallet these reads belong to; skip decisions
      // trust them only while this still equals the live id.
      setLoadedAccountKey(capturedAccountKey);
      setAccountLoadFailed(false);
      return snap;
    } catch (e) {
      // Distinguish a missing facet (old deploy — card stays hidden, no
      // point retrying) from a TRANSIENT RPC failure on a chain where the
      // facets ARE cut (offer a retry so a one-off blip doesn't hide
      // auto-lend until a full page refresh).
      const msg = String(
        (e as { data?: string; message?: string })?.data ??
          (e as Error)?.message ??
          '',
      );
      const missingFacet =
        msg.includes('0xa9ad62f8') ||
        /function does not exist|functionnotfound/i.test(msg);
      setAccountLoadFailed(!missingFacet);
      return null;
    }
  }, [address, chainId, diamondRo, keeperAddress]);

  // Pair-scoped reads — intent struct + funded capital + lending-token
  // decimals, all in one pass so prefill formats with the right decimals.
  // Folds the prefill in (post-await) so there's no derived-state effect.
  const reloadPair = useCallback(async (): Promise<PairSnapshot | null> => {
    const lendingAsset = form.lendingAsset;
    const collateralAsset = form.collateralAsset;
    if (!address || !diamondRo || !lendingAsset || !collateralAsset) return null;
    // No ERC20 handle yet => can't read decimals; fail closed (leave the
    // pair unloaded) rather than parse amounts at a default 18 decimals.
    if (!lendingErc20) return null;
    const key = `${chainId ?? ''}:${address}:${lendingAsset}:${collateralAsset}`;
    try {
      const ro = diamondRo as unknown as {
        getLenderIntent: (o: string, l: string, c: string) => Promise<IntentView>;
        getLenderIntentCapital: (
          o: string,
          l: string,
          c: string,
        ) => Promise<bigint>;
        getLenderIntentLivePrincipal: (
          o: string,
          l: string,
          c: string,
        ) => Promise<bigint>;
      };
      // A legitimate 0-decimals token must stay 0. A non-finite or reverting
      // read must FAIL the whole pair load (throw, not default to 18) —
      // otherwise a 6-dec token hit by a transient failure would parse
      // amounts at 18 decimals and try to approve/fund 1e12x the intended
      // size. The throw is caught below and leaves the pair unloaded.
      const decimalsP = (
        lendingErc20 as unknown as { decimals: () => Promise<number> }
      )
        .decimals()
        .then((d) => {
          const n = Number(d);
          if (!Number.isFinite(n)) throw new Error('bad decimals');
          return n;
        });
      const [iv, cap, live, dec] = await Promise.all([
        ro.getLenderIntent(address, lendingAsset, collateralAsset),
        ro.getLenderIntentCapital(address, lendingAsset, collateralAsset),
        ro.getLenderIntentLivePrincipal(address, lendingAsset, collateralAsset),
        decimalsP,
      ]);
      // Stale-resolve guard for the WHOLE write set: if the live
      // chain+wallet+pair no longer matches what this read was issued for
      // (the user switched mid-flight), drop the result entirely — a newer
      // `reloadPair` owns the current state. Without this, a late response
      // for pair A could overwrite B's intent/capital and stamp A's
      // `loadedPairKey`, leaving `pairLoaded` false for B with no re-fetch.
      const liveForm = formRef.current;
      const liveFullKey = `${idKeyRef.current}:${liveForm.lendingAsset}:${liveForm.collateralAsset}`;
      if (liveFullKey !== key) return null;

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
      setLivePrincipal(BigInt(live));
      setLoadedPairKey(key);
      // Prefill once per (chain, wallet, pair) from a stored intent so
      // editing shows current on-chain terms; also prefill an INACTIVE
      // intent that still has reserved capital (a paused intent) so
      // "Enable to resume" keeps the prior bounds without manual re-entry.
      const hasStoredTerms = view.active || BigInt(cap) > 0n;
      if (hasStoredTerms && prefilledKeyRef.current !== key) {
        prefilledKeyRef.current = key;
        setForm((f) => {
          // Inner belt-and-suspenders guard: if the live form already moved
          // to a different pair (the outer formRef guard can lag a render),
          // don't overwrite the new pair's editable bounds.
          if (
            f.lendingAsset !== lendingAsset ||
            f.collateralAsset !== collateralAsset
          ) {
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
      return { view, capital: BigInt(cap), livePrincipal: BigInt(live), decimals: dec };
    } catch {
      // FAIL CLOSED on every catch (#625): clear `loadedPairKey` (only if
      // this read still owns the current pair) so `pairLoaded` goes FALSE
      // and Enable/validation can't reuse possibly-stale capital /
      // live-principal — even after a prior successful load for this same
      // pair (a keeper fill or another tab may have moved on-chain usage
      // since). A fresh successful read re-stamps it.
      const liveForm = formRef.current;
      const liveFullKey = `${idKeyRef.current}:${liveForm.lendingAsset}:${liveForm.collateralAsset}`;
      if (liveFullKey === key) {
        setLoadedPairKey('');
        setIntent(null);
        setCapital(null);
        setLivePrincipal(null);
      }
      return null;
    }
  }, [
    address,
    chainId,
    diamondRo,
    form.lendingAsset,
    form.collateralAsset,
    lendingErc20,
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
  // #755 — on a "Manage" (re-)click, force a fresh prefill from on-chain
  // even when the pair is unchanged: clear the once-per-pair prefill stamp
  // and re-read. Without this, re-managing the same pair leaves any unsaved
  // edits to bounds/funding in the form (reloadPair wouldn't re-run and the
  // stamp wouldn't clear) instead of resetting to the row's current terms.
  // Ref write + post-await reads belong in an effect, not render. Keyed only
  // on the nonce; standalone usage passes none, so this never runs there.
  useEffect(() => {
    if (selectedPairNonce === undefined) return;
    // Same busy-gate as the render-time apply above: don't re-prefill (which
    // resets the once-per-pair stamp + re-reads) while a tx is in flight.
    if (busyRef.current) return;
    prefilledKeyRef.current = '';
    void reloadPair();
    // reloadPair is intentionally excluded — see the keyed-on-nonce note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPairNonce]);

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
  const livePrincipalView = pairLoaded ? livePrincipal : null;
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
    // Both legs must be real, non-zero addresses — a pasted zero/garbage
    // address would otherwise pass the non-empty check and only revert at
    // `setLenderIntent` AFTER consent + keeper grants were written.
    if (
      !isAddress(form.lendingAsset) ||
      !isAddress(form.collateralAsset) ||
      form.lendingAsset === zeroAddress ||
      form.collateralAsset === zeroAddress
    )
      return t('autoLend.errBadAddress');
    if (form.lendingAsset.toLowerCase() === form.collateralAsset.toLowerCase())
      return t('autoLend.errSamePair');
    // VPFI may not be the LENDING asset (the facet rejects it) — catch it
    // up front so the flow never records consent/grants for a doomed pair.
    if (vpfiToken && form.lendingAsset.toLowerCase() === vpfiToken.toLowerCase())
      return t('autoLend.errVpfiLending');
    if (!parsed.ok) return t('autoLend.errAmount');
    // Token amounts are uint256 on-chain — reject anything over the ceiling
    // before the multi-tx flow so an out-of-range value can't ABI-fail at
    // setLenderIntent/fundLenderIntent after consent + grants were written.
    if (
      parsed.maxExposure > maxUint256 ||
      parsed.minFill > maxUint256 ||
      parsed.fund > maxUint256
    )
      return t('autoLend.errAmount');
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
    // Only guard a NEW top-up against the cap — don't retroactively block
    // updates. The check fires solely when funding (`fund > 0`): the new
    // top-up plus what's already committed (idle reserved + live principal,
    // both of which consume maxExposure in matchIntent) must fit the cap,
    // so we never pull capital that can never be lent. A fund-less update
    // (e.g. LOWERING the cap to stop further exposure — a valid risk
    // reduction even when current capital exceeds the new cap) is allowed.
    if (
      parsed.fund > 0n &&
      (capitalView ?? 0n) + (livePrincipalView ?? 0n) + parsed.fund >
        parsed.maxExposure
    )
      return t('autoLend.errFundOverExposure');
    // A keeper-only intent on a chain with no published keeper can never
    // be filled (no solver can hold the signed-fill grant) — block it.
    if (form.requiresKeeperAuth && !keeperAddress)
      return t('autoLend.errKeeperOnlyNoKeeper');
    // Pre-flight a FULL keeper whitelist: if a keeper must be approved
    // (not already on the list) but the wallet is at the cap, approveKeeper
    // would revert AFTER consent + master-switch were written. Block first.
    if (
      keeperAddress &&
      keeperActions === 0 &&
      (approvedKeepersCount ?? 0) >= MAX_APPROVED_KEEPERS
    )
      return t('autoLend.errKeeperListFull');
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
    livePrincipalView,
    vpfiToken,
    keeperAddress,
    keeperAccess,
    keeperActions,
    approvedKeepersCount,
    riskConsentGiven,
    ackKeeperMasterGiven,
    t,
  ]);

  const dw = diamond as unknown as Record<string, (...a: unknown[]) => Promise<WriteTx>>;

  // ── Enable sequence (resumable) ──────────────────────────────────
  const handleEnable = async () => {
    // Gate on fresh, wallet-correct reads so a stale wallet/asset/pair
    // can't drive a skip decision, misscale amounts, or act on a pair
    // whose intent/capital hasn't loaded yet.
    if (
      !address ||
      !diamond ||
      !canWrite ||
      !parsed.ok ||
      !accountLoaded ||
      !decimalsReady ||
      !pairLoaded
    )
      return;
    if (validation) {
      setError(validation);
      return;
    }
    if (!parsed.ok) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { lendingAsset, collateralAsset } = form;

      // Re-read fresh account + pair state IMMEDIATELY before acting, so
      // every skip / gate decision below uses on-chain truth rather than
      // possibly-stale cached React state (a keeper fill, an admin switch
      // flip, a consent revoke in another tab — TOCTOU). Fail closed if
      // either read fails: better to make the user retry than to skip a
      // required authorization or over-fund against stale usage.
      const [acct, pair] = await Promise.all([reloadAccount(), reloadPair()]);
      if (!acct || !pair) {
        setError(t('autoLend.errLoadFailed'));
        return;
      }

      // Consent kill-switch gate (FRESH): when consent isn't recorded and
      // the admin switch is down, the consent-first step can't run, so
      // abort before any tx (registering a paused intent would relist its
      // reserved capital with the marker unset).
      if (!acct.consent && !acct.adminLendEnabled) {
        setNotice(t('autoLend.noticeConsentBlocked'));
        return;
      }
      // Whitelist-full preflight (FRESH): block before any tx when the
      // keeper must be approved but the wallet is at the cap.
      if (
        keeperAddress &&
        acct.keeperActions === 0 &&
        acct.approvedKeepersCount >= MAX_APPROVED_KEEPERS
      ) {
        setError(t('autoLend.errKeeperListFull'));
        return;
      }
      // Funding headroom re-check (FRESH): idle reserved + live principal +
      // new top-up must fit the cap.
      if (
        parsed.fund > 0n &&
        pair.capital + pair.livePrincipal + parsed.fund > parsed.maxExposure
      ) {
        setError(t('autoLend.errFundOverExposure'));
        return;
      }

      // 1. Consent marker FIRST (fresh: skip only if actually recorded).
      if (!acct.consent) {
        setStep(t('autoLend.stepConsent'));
        const tx = await dw.setAutoLendConsent(true);
        await tx.wait();
        setConsent(true);
      }

      // Hoisted master-switch ack gate: re-check against the FRESH
      // keeperAccess (validation may have run while cached keeperAccess was
      // true, so the warning checkbox never showed and the ack is unset).
      // Flipping the global switch on without it would silently reactivate
      // every keeper the wallet approved — block here, independent of
      // step ordering.
      if (keeperAddress && !acct.keeperAccess && !ackKeeperMasterGiven) {
        setError(t('autoLend.errAckKeeperMaster'));
        return;
      }

      const needsRegister = !intentMatchesParsed(
        pair.view,
        parsed,
        form.requiresKeeperAuth,
      );

      // Keeper delegation (keeper access + grant). Skip decisions use the
      // FRESH grant state.
      const runDelegate = async () => {
        if (!keeperAddress) return;
        if (!acct.keeperAccess) {
          setStep(t('autoLend.stepKeeperAccess'));
          const tx = await dw.setKeeperAccess(true);
          await tx.wait();
          setKeeperAccess(true);
        }
        const current = acct.keeperActions ?? 0;
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
      };

      // Register / update the standing intent (skip if the FRESH on-chain
      // intent already matches the form).
      const runRegister = async () => {
        if (!needsRegister) return;
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
        // #755 — registration changed the intent's visibility/terms already;
        // refresh the overview NOW so a later step (approve/fund) failing
        // can't leave the list on its 30s-stale Active/Paused/terms view.
        onIntentChanged?.();
      };

      // 2 & 3. Order the delegate / register steps by intent state:
      //  - ACTIVE + mismatched (the user is e.g. TIGHTENING rate/LTV/term):
      //    UPDATE TERMS FIRST, then delegate. The intent is already
      //    fillable, so enabling the keeper before the update would let it
      //    fill under the OLD looser terms in the inter-tx window.
      //  - otherwise (a PAUSED/inactive relist, or no register needed):
      //    DELEGATE FIRST, then register — so re-listing reserved capital
      //    never outruns the grant.
      if (pair.view.active && needsRegister) {
        await runRegister();
        await runDelegate();
      } else {
        await runDelegate();
        await runRegister();
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
        // Re-read the pair and RE-APPLY the headroom check AFTER the
        // approval and immediately before funding — another tab funding, or
        // an auto-roll compounding proceeds (including during the approval
        // tx), could have raised capital/live-principal since the initial
        // read. fundLenderIntent does not enforce maxExposure, so this is
        // the last guard against pulling idle capital the cap would reject.
        const freshPair = await reloadPair();
        if (!freshPair) {
          setError(t('autoLend.errLoadFailed'));
          return;
        }
        if (
          freshPair.capital + freshPair.livePrincipal + parsed.fund >
          parsed.maxExposure
        ) {
          setError(t('autoLend.errFundOverExposure'));
          return;
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
      // #755 — fire on mutation success BEFORE the local refresh reads, so a
      // transient post-write read failure can't skip the overview invalidation.
      onIntentChanged?.();
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
    if (!address || !diamond || !canWrite) return;
    const { lendingAsset, collateralAsset } = form;
    if (!lendingAsset || !collateralAsset) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setStep(t('autoLend.stepCancel'));
      const tx = await dw.cancelLenderIntent(lendingAsset, collateralAsset);
      await tx.wait();
      // NB: we do NOT clear `autoLendConsent` here. It's a WALLET-level
      // marker (not per pair); cancelling this one intent de-lists it
      // (which is what actually stops its fills), while clearing the
      // global marker would mislabel the lender's OTHER active intents as
      // "paused" even though the keeper can still fill them.
      setNotice(t('autoLend.noticePaused'));
      onIntentChanged?.(); // #755 — fire on success, before the refresh reads.
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
    if (!address || !diamond || !canWrite) return;
    const { lendingAsset, collateralAsset } = form;
    if (!lendingAsset || !collateralAsset) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Re-read fresh: the cached view may say "inactive" while the same
      // pair was re-enabled in another tab. Decide cancel/withdraw on the
      // FRESH intent so a full stop never leaves an active intent behind
      // (which a later auto-roll could re-lien and relist). Fail closed.
      const pair = await reloadPair();
      if (!pair) {
        setError(t('autoLend.errLoadFailed'));
        return;
      }
      // Cancel (de-list) FIRST so no keeper can match the intent during
      // the withdraw signature window — then pull the now-un-fillable
      // capital (the contract's withdraw path stays usable after cancel).
      if (pair.view.active) {
        setStep(t('autoLend.stepCancel'));
        const tx = await dw.cancelLenderIntent(lendingAsset, collateralAsset);
        await tx.wait();
        // #755 — the intent is de-listed/paused as of this mined tx; refresh
        // the overview NOW so a later withdraw failing can't leave the row
        // showing Active/fillable on the list's 30s cache.
        onIntentChanged?.();
      }
      // Re-read capital AFTER the cancel mined: a keeper could have
      // auto-rolled a just-repaid loan and re-liened its proceeds between
      // the initial read and the cancel, so `pair.capital` may understate
      // the un-lent balance. Withdraw the CURRENT amount so a full stop
      // doesn't strand the rolled capital. (Once cancelled the intent is
      // de-listed, so no further roll can relist it.) FAIL CLOSED if the
      // re-read fails: do NOT fall back to the stale pre-cancel snapshot
      // (that could withdraw less than the now-liened balance and strand
      // rolled capital under a "stopped" notice). The intent is already
      // cancelled, so the user just retries Withdraw & stop.
      const afterCancel = await reloadPair();
      if (!afterCancel) {
        setError(t('autoLend.errLoadFailed'));
        return;
      }
      if (afterCancel.capital > 0n) {
        setStep(t('autoLend.stepWithdraw'));
        const tx = await dw.withdrawLenderIntentCapital(
          lendingAsset,
          collateralAsset,
          afterCancel.capital,
        );
        await tx.wait();
      }
      // NB: like Pause, we do NOT clear the wallet-level `autoLendConsent`
      // marker here — it governs every pair, and the lender may have other
      // active intents. Cancelling this intent above is what stops its fills.
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
      onIntentChanged?.(); // #755 — fire on success, before the refresh reads.
      await Promise.all([reloadAccount(), reloadPair()]);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
      await Promise.all([reloadAccount(), reloadPair()]).catch(() => {});
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // ── Global revoke of the wallet-level auto-lend consent marker ────
  // Pause/Stop are per-pair and deliberately leave the global marker, so
  // this is the single place that clears it — preserving the policy that
  // a user can always revoke their own consent. Does NOT touch any
  // intent or capital; the per-pair Stop handles those.
  const handleRevokeConsent = async () => {
    // Gate on accountLoaded so the action acts on THIS wallet's freshly
    // read consent, not a previous account's stale `consent === true`.
    if (!address || !diamond || !canWrite || !accountLoaded) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    setStep(t('autoLend.stepConsent'));
    try {
      const tx = await dw.setAutoLendConsent(false);
      await tx.wait();
      setConsent(false);
      setNotice(t('autoLend.noticeConsentRevoked'));
      await reloadAccount();
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
      await reloadAccount().catch(() => {});
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  if (!address) return null;
  // Hide the card entirely on deploys where the facet set isn't cut yet —
  // but NOT when a transient account-read failure left the sentinels null
  // (we keep the card visible with a retry in that case).
  if (
    adminLendEnabled == null &&
    fillPathEnabled == null &&
    consent == null &&
    !accountLoadFailed
  ) {
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

          {/* #799 — persistent best-effort disclosure: keeper fills and
              auto-roll are NOT guaranteed. It stays visible at enablement and
              while enabled (not just a one-shot banner) so a lender never reads
              a registered intent as a promise that capital will be deployed or
              rolled. */}
          <div className="alert alert-warning" role="note" style={{ marginBottom: 10 }}>
            <AlertTriangle size={14} />
            <div>{t('autoLend.bestEffortNotice')}</div>
          </div>

          {/* #799 (Codex #811 r4) — global delegated-keeper pause. While ON,
              auto-roll and keeper-restricted fills are suspended (open intents
              stay fillable by any solver), so surface it as its own banner.
              Gated on `accountLoaded` (Codex #811 r5) so a stale `true` from a
              previous chain/account snapshot can't render after a context switch
              or a failed reload. */}
          {keepersPaused === true && accountLoaded && (
            <div className="alert alert-warning" role="alert" style={{ marginBottom: 10 }}>
              <AlertTriangle size={14} />
              <div>{t('autoLend.keepersPausedNotice')}</div>
            </div>
          )}

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
                {/* An ACTIVE intent is fillable regardless of the consent
                    marker (matchIntent never checks it), so a revoked
                    marker is NOT "paused" — say only the marker is off and
                    point to Withdraw & stop for an actual stop. */}
                {consent === false && ` — ${t('autoLend.consentRevokedTag')}`}
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
                !canWrite ||
                validation != null ||
                !accountLoaded ||
                !decimalsReady ||
                !pairLoaded
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
                disabled={busy || !canWrite}
              >
                {t('autoLend.actionPause')}
              </button>
            )}
            {(isActive || (capitalView ?? 0n) > 0n) && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleWithdrawAndStop}
                disabled={busy || !canWrite}
              >
                {t('autoLend.actionStop')}
              </button>
            )}
            {/* Global consent revoke — the only path to clear the
                wallet-level marker (Pause/Stop stay per-pair). Shown only
                once the account is loaded for the CURRENT wallet, so a
                stale-render of a previous wallet's consent can't drive it. */}
            {consent === true && accountLoaded && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleRevokeConsent}
                disabled={busy || !canWrite}
                title={t('autoLend.revokeConsentHint')}
              >
                {t('autoLend.actionRevokeConsent')}
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

          {/* Account-read failure notice — distinct from a missing-facet
              deploy (which hides the card); a transient blip keeps the card
              up with the retry below. */}
          {accountLoadFailed && !accountLoaded && (
            <div className="alert alert-warning" role="status" style={{ marginTop: 10 }}>
              <AlertTriangle size={14} />
              <div>{t('autoLend.errLoadFailed')}</div>
            </div>
          )}

          {/* Retry affordance — a read failure clears the loaded keys
              (fail-closed) without rescheduling the load effects, so offer
              an explicit re-fetch (calls the stable reload callbacks
              directly) when the pair OR the account state didn't load. */}
          {!busy &&
            ((!!form.lendingAsset && !!form.collateralAsset && !pairLoaded) ||
              (accountLoadFailed && !accountLoaded)) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => {
                  void Promise.all([reloadAccount(), reloadPair()]);
                }}
              >
                {t('autoLend.actionRetry')}
              </button>
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
