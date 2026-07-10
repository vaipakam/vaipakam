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
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
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
import { formatDurationDays, shortAddress } from '../../lib/format';
import type { DeskPair } from '../../data/desk';

/** LibVaipakam.FillMode (#125): Partial default, Aon, Ioc. */
const FILL_PARTIAL = 0;
const FILL_AON = 1;
const FILL_IOC = 2;

type ExpiryPreset = 'gtc' | '24h' | '7d' | 'custom';

const MAX_RATE_PERCENT = 100;

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
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postedHash, setPostedHash] = useState<string | null>(null);
  const lockRef = useRef(false);

  // Ladder-row tap → limit rate. Applied on every new tap (nonce).
  useEffect(() => {
    if (prefill === null) return;
    setRate(String(prefill.rateBps / 100));
    setConsent(false);
    setPostedHash(null);
  }, [prefill]);

  // Any market change voids consent — the deal being consented to
  // changed underneath the ticket.
  useEffect(() => {
    setConsent(false);
    setPostedHash(null);
  }, [pair?.lendingAsset, pair?.collateralAsset, days, side]);

  // The collateral ASSET is fixed to the selected market's — the ticket
  // posts into the (pair, tenor) market shown in the header, and a
  // free-picked asset would post an offer that never appears in the
  // current ladder. A different pair (custom included) is selected in
  // the header, never here; only the collateral AMOUNT is the ticket's.
  const collateralAsset = pair?.collateralAsset ?? '';

  const lendingMeta = useTokenMeta(pair?.lendingAsset);
  const collateralMeta = useTokenMeta(pair?.collateralAsset);

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
        return BigInt(ts);
      }
    }
  };
  const expiryOk = expiry !== 'custom' || resolveExpiresAt() !== null;
  // IOC requires an expiry (#125) — GTC + IOC is contract-invalid.
  const iocNeedsExpiry = fillMode === FILL_IOC && expiry === 'gtc';

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
  const simTx = useMemo((): TxSimInput | null => {
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
  }, [walletChain, consent, decimalsReady, form, fillMode, expiry, customExpiry]);
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
      leg: 'loan asset',
      needed:
        pair !== null && needsSecurityCheck(readChain.chainId, pair.lendingAsset),
      verdict: lendingSec.data,
      errored: lendingSec.isError,
    },
    {
      leg: 'collateral',
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

  const canPost =
    fieldsComplete &&
    formError === null &&
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
    !busy;

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
      if (!payload) throw new Error(copy.desk.ticket.expiryInvalid);
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
    setAmount('');
    void queryClient.invalidateQueries({ queryKey: ['deskBook'] });
    void queryClient.invalidateQueries({ queryKey: ['deskMarkets'] });
    void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
  }

  const text = copy.desk.ticket;

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
        <label htmlFor="desk-amount">
          {side === 'lender' ? text.amountLend : text.amountBorrow}
          {lendingMeta.data ? ` (${lendingMeta.data.symbol})` : ''}
        </label>
        <input
          id="desk-amount"
          className="input"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.trim());
            setConsent(false);
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
          title="Rates are stored in basis points (1% = 100 bps)"
          value={rate}
          onChange={(e) => {
            setRate(e.target.value.trim());
            setConsent(false);
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
          Collateral can’t be the same token as the loan asset.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="desk-collateral-amount">
          Collateral amount
          {collateralMeta.data ? ` (${collateralMeta.data.symbol})` : ''}
        </label>
        <input
          id="desk-collateral-amount"
          className="input"
          inputMode="decimal"
          placeholder="0.0"
          value={collateralAmount}
          onChange={(e) => {
            setCollateralAmount(e.target.value.trim());
            setConsent(false);
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
                value === 'gtc'
                  ? 'Good-til-cancelled — rests until you cancel it'
                  : 'Good-til-time — lapses on its own at the deadline'
              }
              onClick={() => {
                setExpiry(value);
                setConsent(false);
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
              setConsent(false);
            }}
          />
        ) : null}
        {expiry === 'custom' && customExpiry !== '' && !expiryOk ? (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            {text.expiryInvalid}
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
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              className={`desk-chip${fillMode === value ? ' active' : ''}`}
              title={hint}
              onClick={() => {
                setFillMode(value);
                setConsent(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {iocNeedsExpiry ? (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            {text.iocNeedsExpiry}
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
                  ? text.securityBlocked(l.leg, l.verdict.reasons)
                  : text.securityUnknown(l.leg),
              )
              .join(' ')}
          </span>
        </div>
      ) : null}

      <CollateralPrecheck tx={precheckTx} />

      <label
        className="cluster"
        style={{ alignItems: 'flex-start', gap: 8, margin: '8px 0' }}
      >
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <ConsentLabel />
      </label>

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

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!canPost}
        onClick={() => void submit()}
      >
        {busy ? text.posting : text.post}
      </button>
    </div>
  );
}
