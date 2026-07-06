/**
 * VPFI fee discounts — optional utility, never a prerequisite
 * (Journey V1).
 *
 * Availability decides the page state FIRST (audit F-20260702-003):
 * if the Diamond has no VPFI token registered on the active chain,
 * the unavailable explanation leads and no deposit controls render.
 *
 * When available and connected, the page shows the tracked vault
 * balance, the ACTIVE (effective) discount vs the balance-implied raw
 * tier — with a plain "warming up" note when they differ, since the
 * fee path applies a 30-day average behind a minimum-history gate —
 * the platform-level consent toggle, and deposit/withdraw with the
 * standard review receipt before signing.
 */
import { useMemo, useState } from 'react';
import { CircleCheck, Coins, LoaderCircle } from 'lucide-react';
import { useModal } from 'connectkit';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData, parseUnits } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { assertWalletNotSanctionedLive, useSanctionsCheck } from '../data/sanctions';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { readVpfiTokenLive, useVpfi, useVpfiTierTable, VPFI_DECIMALS } from '../data/vpfi';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { SimulationPreview } from '../components/SimulationPreview';
import type { TxSimInput } from '../contracts/useTxSimulation';
import { ensureAllowance } from '../contracts/erc20';
import { exactAmountString, formatBpsAsPercent, formatTokenAmount } from '../lib/format';
import { isPositiveDecimal, submitErrorText } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { ReviewReceipt, type ReceiptData } from '../components/ReviewReceipt';

type VaultAction = 'deposit' | 'withdraw';

export function Vpfi() {
  const { readChain, address, isConnected, onSupportedChain, walletChain } =
    useActiveChain();
  const { setOpen } = useModal();
  const vpfi = useVpfi();
  const { write } = useDiamondWrite();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();

  const tierRows = useVpfiTierTable();
  // Deposits (and consent writes) revert for flagged wallets — block
  // BEFORE the approval tx, same gate as the offer flows. Held pending
  // while the check loads.
  const sanctions = useSanctionsCheck();
  const sanctionsClear = sanctions.ready && !sanctions.flagged;
  const [action, setAction] = useState<VaultAction>('deposit');
  const [amount, setAmount] = useState('');
  const [reviewing, setReviewing] = useState(false);
  // #1037 — which prompt the in-flight action is on (null = idle).
  const [phase, setPhase] = useState<null | 'pending' | 'approving' | 'submitting'>(null);
  const busy = phase !== null;
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [watched, setWatched] = useState(false);

  const snapshot = vpfi.data;

  const amountWei = useMemo(() => {
    if (!isPositiveDecimal(amount)) return null;
    try {
      return parseUnits(amount, VPFI_DECIMALS);
    } catch {
      return null;
    }
  }, [amount]);

  // Withdrawals above the FREE balance revert (encumbered VPFI backs
  // active loans) — the Max button and over-max check must use free.
  const maxWei =
    action === 'deposit'
      ? (snapshot?.walletBalance ?? 0n)
      : (snapshot?.freeBalance ?? 0n);
  const overMax = amountWei !== null && amountWei > maxWei;

  const receipt = useMemo((): ReceiptData | null => {
    if (!amountWei || overMax) return null;
    const amtStr = `${formatTokenAmount(amountWei, VPFI_DECIMALS)} VPFI`;
    if (action === 'deposit') {
      return {
        youReceive: 'Nothing now — a growing fee discount on eligible loans over time.',
        youLock: `${amtStr} moves from your wallet into your Vaipakam Vault.`,
        youMayOwe: 'Nothing.',
        youCanLose: 'Nothing — free VPFI in your vault stays withdrawable.',
        fees: 'No Vaipakam fee on deposits.',
        whenThisEnds: 'Withdraw your free VPFI whenever you like.',
      };
    }
    return {
      youReceive: `${amtStr} back in your wallet.`,
      youLock: 'Nothing.',
      youMayOwe: 'Nothing.',
      youCanLose: `Future fee discounts — ${copy.vpfi.withdrawWarning}`,
      fees: 'No Vaipakam fee on withdrawals.',
      whenThisEnds: 'Immediately — your remaining balance keeps earning discount history.',
    };
  }, [action, amountWei, overMax]);

  // #1028 item 2 — advisory pre-sign dry run of the exact vault
  // action calldata. Deposits approve first, so the zero-allowance
  // revert at preview time is the expected benign case.
  const simTx = useMemo((): TxSimInput | null => {
    if (!walletChain || !amountWei || overMax) return null;
    return {
      to: walletChain.diamondAddress,
      data: encodeFunctionData({
        abi: DIAMOND_ABI_VIEM,
        functionName:
          action === 'deposit' ? 'depositVPFIToVault' : 'withdrawVPFIFromVault',
        args: [amountWei],
      }),
      value: 0n,
      allowAllowanceRevert: action === 'deposit',
    };
  }, [walletChain, action, amountWei, overMax]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['vpfi'] });
  }

  async function runVaultAction() {
    // #1028 — kill switch: deposits only (opening exposure). The
    // withdraw path is a close-out and is structurally unkillable.
    if (action === 'deposit' && flowDisabled('vpfi-deposit')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!amountWei || !address || !walletChain || !walletClient || !publicClient || !snapshot?.token)
      return;
    setPhase('pending');
    setError(null);
    try {
      // The page gates on a CACHED sanctions read — re-screen live
      // before any approval/write (deposit AND withdraw are Tier-1).
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      if (action === 'deposit') {
        // depositVPFIToVault pulls the LIVE s.vpfiToken — if governance
        // rotated the token after the cached snapshot, approving the
        // stale address mines a useless approval and the deposit
        // reverts. Re-read live (fail closed) and force a re-review.
        const liveToken = await readVpfiTokenLive(
          publicClient,
          walletChain.diamondAddress,
          copy.vpfi.tokenCheckRetry,
        );
        if (liveToken.toLowerCase() !== snapshot.token.toLowerCase()) {
          refresh();
          throw new Error(copy.vpfi.tokenChanged);
        }
        // The Max/over-max gates use the CACHED snapshot balance —
        // re-read live so funds moved after review fail before the
        // approval can mine.
        await assertErc20BalanceLive({
          publicClient,
          token: snapshot.token,
          owner: address,
          amount: amountWei,
          symbol: 'VPFI',
        });
        await ensureAllowance({
          onPrompt: () => setPhase('approving'),
          publicClient,
          walletClient,
          token: snapshot.token,
          owner: address,
          spender: walletChain.diamondAddress,
          amount: amountWei,
        });
        setPhase('submitting');
        await write('depositVPFIToVault', [amountWei]);
        setDone('Deposit confirmed. Your discount history starts building from now.');
      } else {
        setPhase('submitting');
        await write('withdrawVPFIFromVault', [amountWei]);
        setDone('Withdrawal confirmed. The VPFI is back in your wallet.');
      }
      setAmount('');
      setReviewing(false);
      refresh();
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setPhase(null);
    }
  }

  async function toggleConsent() {
    if (!snapshot) return;
    setPhase('pending');
    setError(null);
    try {
      // Tier-1 write — re-screen live (the page gate is a cached read;
      // the setter itself doesn't re-read sanctions).
      if (address && walletChain && publicClient) {
        await assertWalletNotSanctionedLive(
          publicClient,
          walletChain.diamondAddress,
          address,
        );
      }
      const turningOff = snapshot.consent;
      const next = !snapshot.consent;
      await write('setVPFIDiscountConsent', [next]);
      // Read-after-write honesty: the tx is MINED, so `next` IS the
      // chain state — but public testnet RPCs can serve pre-tx state
      // for several seconds, and an immediate invalidate would refetch
      // the OLD consent and leave the checkbox visually unchanged
      // (looking like the click did nothing, inviting a second tx).
      // Patch the cache with the mined value; the periodic refetch
      // reconciles once the RPC catches up.
      queryClient.setQueryData(
        ['vpfi', readChain.chainId, address?.toLowerCase()],
        (old: typeof snapshot | undefined) =>
          old ? { ...old, consent: next } : old,
      );
      if (turningOff) {
        // Per VPFIDiscountFacet: consent-off is only PUSHED to
        // mirror-chain tier caches by a following pokeMyTier() —
        // without it, mirrors can keep applying discounts the user
        // just opted out of. Best-effort: the opt-out itself already
        // succeeded, and any later balance mutation also pushes.
        try {
          await write('pokeMyTier', []);
        } catch {
          setError(
            'Your opt-out is saved on this network, but syncing it to other networks didn’t go through — it will sync with your next VPFI action, or try toggling again.',
          );
        }
      }
      // Deliberately NO immediate invalidate here: it would refetch
      // through the (possibly lagging) RPC and could overwrite the
      // patched consent with pre-tx state. The 30s interval and the
      // per-block live sync reconcile shortly, when the RPC is caught
      // up. (Vault deposits/withdrawals keep the immediate refresh —
      // their figures come with a done-banner, so a briefly-stale
      // balance doesn't read as "the click did nothing".)
    } catch (err) {
      setError(submitErrorText(err));
    } finally {
      setPhase(null);
    }
  }

  const education = (
    <section className="card">
      <h3>How the discount works</h3>
      <p>
        Hold VPFI in your Vaipakam Vault and the protocol fee on eligible loans
        shrinks. The discount uses your average holding over the last 30 days —
        topping up today grows your discount gradually, not instantly.
      </p>
      <dl className="receipt" style={{ margin: 0 }}>
        {tierRows.map((t) => (
          <div key={t.held} className="receipt-row">
            <dt>{t.held}</dt>
            <dd>{t.discount} off eligible protocol fees</dd>
          </div>
        ))}
      </dl>
      <p className="muted" style={{ marginTop: 12 }}>
        {copy.vpfi.noGasDiscount} {copy.vpfi.withdrawWarning} Vaipakam does not
        sell VPFI and pays no holding yield — you acquire it on the open
        market.
      </p>
    </section>
  );

  // ---- Page states -------------------------------------------------
  if (vpfi.isLoading) {
    return (
      <div>
        <h1 className="page-title">{copy.vpfi.title}</h1>
        <p className="page-lede">{copy.vpfi.optional}</p>
        <p className="muted">
          <LoaderCircle className="spin" aria-hidden size={16} /> Checking VPFI
          availability on {readChain.name}…
        </p>
      </div>
    );
  }

  if (!snapshot?.registered) {
    // Honesty rule: "not available on this chain" only when the chain
    // POSITIVELY said so; a failed read gets a couldn't-check state.
    const body = vpfi.isError
      ? `We couldn’t check VPFI availability on ${readChain.name} right now. Please try again in a moment.`
      : copy.vpfi.notOnThisChain(readChain.name);
    return (
      <div className="stack">
        <div>
          <h1 className="page-title">{copy.vpfi.title}</h1>
          <p className="page-lede">{copy.vpfi.optional}</p>
        </div>
        <div className="banner banner-info">
          <Coins aria-hidden />
          <span className="banner-body">{body}</span>
        </div>
        {education}
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.vpfi.title}</h1>
        <p className="page-lede">{copy.vpfi.optional}</p>
      </div>

      {!isConnected ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p className="muted">{copy.wallet.connectFirst}</p>
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            {copy.wallet.connect}
          </button>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="card-title">
              <Coins aria-hidden />
              <h2 style={{ margin: 0 }}>Your discount status</h2>
            </div>
            <dl className="receipt" style={{ margin: 0 }}>
              <div className="receipt-row">
                <dt>In your vault</dt>
                <dd>{formatTokenAmount(snapshot.vaultBalance, VPFI_DECIMALS)} VPFI</dd>
              </div>
              <div className="receipt-row">
                <dt>Active discount</dt>
                <dd>
                  {snapshot.consent && snapshot.effectiveBps > 0
                    ? `${formatBpsAsPercent(snapshot.effectiveBps)} off eligible protocol fees`
                    : 'None right now'}
                </dd>
              </div>
              {snapshot.rawTier > snapshot.effectiveTier ? (
                <div className="receipt-row">
                  <dt>Warming up</dt>
                  <dd>
                    Your balance qualifies for
                    {tierRows[snapshot.rawTier - 1]
                      ? ` ${tierRows[snapshot.rawTier - 1].discount} off`
                      : ' a higher tier'}
                    {snapshot.effectiveBps > 0
                      ? ` (currently ${formatBpsAsPercent(snapshot.effectiveBps)})`
                      : ''}
                    , but discounts use your 30-day average — keep the balance
                    and your active discount catches up.
                  </dd>
                </div>
              ) : null}
            </dl>
            {/* wallet_watchAsset — offered only once the user actually
                HOLDS VPFI somewhere (wallet or vault); before that the
                button would just add a zero-balance line to MetaMask.
                Rejecting the wallet prompt is not an error. */}
            {snapshot.token &&
            walletClient &&
            (snapshot.walletBalance > 0n || snapshot.vaultBalance > 0n) ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 12 }}
                onClick={() => {
                  void walletClient
                    .watchAsset({
                      type: 'ERC20',
                      options: {
                        address: snapshot.token!,
                        symbol: 'VPFI',
                        decimals: VPFI_DECIMALS,
                      },
                    })
                    .then(() => setWatched(true))
                    .catch(() => {});
                }}
              >
                {watched ? copy.vpfi.addedToWallet : copy.vpfi.addToWallet}
              </button>
            ) : null}
            <label
              className="cluster"
              style={{ marginTop: 16, fontSize: '0.9rem', alignItems: 'flex-start' }}
            >
              <input
                type="checkbox"
                checked={snapshot.consent}
                disabled={busy || !onSupportedChain || !sanctionsClear}
                onChange={() => void toggleConsent()}
                style={{ marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>
                Use my vaulted VPFI for fee discounts. Without this, holding
                VPFI gives no discount.
              </span>
            </label>
          </section>

          <section className="card">
            <div className="segmented" role="radiogroup" aria-label="Vault action">
              {(['deposit', 'withdraw'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={action === a}
                  className={action === a ? 'active' : ''}
                  onClick={() => {
                    setAction(a);
                    setReviewing(false);
                    setError(null);
                    setDone(null);
                  }}
                >
                  {a === 'deposit' ? 'Deposit' : 'Withdraw'}
                </button>
              ))}
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="vpfi-amount">
                {action === 'deposit'
                  ? 'VPFI to move into your vault'
                  : 'VPFI to take back to your wallet'}
              </label>
              <div className="cluster">
                <input
                  id="vpfi-amount"
                  className={`input ${overMax ? 'input-invalid' : ''}`}
                  style={{ flex: 1 }}
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value.trim());
                    setReviewing(false);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setAmount(exactAmountString(maxWei, VPFI_DECIMALS));
                    setReviewing(false);
                  }}
                >
                  Max
                </button>
              </div>
              <span className="field-hint">
                {action === 'deposit'
                  ? `In your wallet: ${formatTokenAmount(snapshot.walletBalance, VPFI_DECIMALS)} VPFI`
                  : `Withdrawable now: ${formatTokenAmount(snapshot.freeBalance, VPFI_DECIMALS)} VPFI of ${formatTokenAmount(snapshot.vaultBalance, VPFI_DECIMALS)} in your vault`}
                {overMax ? ' — that’s more than you have.' : ''}
              </span>
            </div>

            {reviewing && receipt ? (
              <div style={{ marginTop: 8 }}>
                <ReviewReceipt data={receipt} />
                <SimulationPreview tx={simTx} />
              </div>
            ) : null}

            {action === 'deposit' && flowDisabled('vpfi-deposit') ? (
              <div className="banner banner-warn" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{copy.killSwitch.disabled}</span>
              </div>
            ) : null}

            {done ? (
              <div className="banner banner-info" role="status" style={{ marginTop: 16 }}>
                <CircleCheck aria-hidden />
                <span className="banner-body">{done}</span>
              </div>
            ) : null}
            {error ? (
              <div className="banner banner-danger" role="alert" style={{ marginTop: 16 }}>
                <span className="banner-body">{error}</span>
              </div>
            ) : null}

            {!reviewing ? (
              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{ marginTop: 8 }}
                disabled={!amountWei || overMax}
                onClick={() => {
                  setDone(null);
                  setReviewing(true);
                }}
              >
                Review {action}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{ marginTop: 16 }}
                disabled={
                  busy ||
                  !onSupportedChain ||
                  !sanctionsClear ||
                  (action === 'deposit' && flowDisabled('vpfi-deposit')) ||
                  // clients hydrate async after connect — without this
                  // the click lands in runVaultAction's early return
                  // and silently does nothing.
                  !walletClient ||
                  !publicClient ||
                  !amountWei ||
                  overMax
                }
                onClick={() => void runVaultAction()}
              >
                {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
                {phase !== null
                  ? phase === 'approving'
                    ? 'Approving VPFI…'
                    : phase === 'submitting'
                      ? 'Submitting…'
                      : 'Waiting for wallet…'
                  : action === 'deposit'
                    ? 'Deposit VPFI'
                    : 'Withdraw VPFI'}
              </button>
            )}
          </section>
        </>
      )}

      {education}
    </div>
  );
}
