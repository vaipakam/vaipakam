import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { L as Link } from "../components/L";
import {
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { useWalletClient } from "wagmi";
import { parseEther } from "viem";
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from "@vaipakam/contracts/abis";
import { SimulationPreview } from "../components/app/SimulationPreview";
import {
  Coins,
  Wallet,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Info,
  Gift,
  TrendingUp,
  ShieldCheck,
} from "lucide-react";
import { useWallet } from "../context/WalletContext";
import {
  useDiamondContract,
  useDiamondPublicClient,
  useReadChain,
  useCanWrite,
} from "../contracts/useDiamond";
import { useUserVPFI } from "../hooks/useUserVPFI";
import {
  useVPFIDiscountTier,
  useVPFIDiscountConsent,
  useVaultVPFIBalance,
  useVpfiTierTable,
  formatVpfiUnits,
} from "../hooks/useVPFIDiscount";
import { usePermit2Signing } from "../hooks/usePermit2Signing";
import { getCanonicalVPFIChain } from "../contracts/config";
import { decodeContractError } from "@vaipakam/lib/decodeContractError";
import { formatNumber } from "../lib/format";
import { beginStep } from "../lib/journeyLog";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
import { SanctionsBanner } from "../components/app/SanctionsBanner";
import { CardInfo } from "../components/CardInfo";
import { VPFIPanel } from "../components/app/VPFIPanel";
import { StakingRewardsClaim } from "../components/app/StakingRewardsClaim";
import { useVPFIToken } from "../hooks/useVPFIToken";
import { useStakingApr } from "../hooks/useStakingApr";
import { useMode } from "../context/ModeContext";
import "./Dashboard.css";

/**
 * Linear state machine for the deposit / unstake vault flow.
 *
 * - `idle`              - Input stage; the user has not submitted anything yet.
 * - `approving-deposit` - ERC20 `approve` tx to the diamond is pending.
 * - `depositing`        - `depositVPFIToVault` tx is pending.
 * - `unstaking`         - A `withdrawVPFIFromVault` tx is pending.
 * - `success`           - The last tx confirmed; banner is shown.
 */
type VaultStep =
  | "idle"
  | "approving-deposit"
  | "depositing"
  | "unstaking"
  | "success";

interface FlowBannerProps {
  /** Current flow state; the banner only renders when `step === 'success'`. */
  step: VaultStep;
  /** Hash of the last confirmed transaction to deep-link in the explorer. */
  txHash: string | null;
  /** Chain-specific explorer base URL (`/tx/<hash>` is appended). */
  blockExplorer: string;
  /** Dismiss handler that clears both the banner and the recorded hash. */
  onReset: () => void;
}

/** Success confirmation banner shown after a deposit / unstake tx confirms. */
function FlowBanner({ step, txHash, blockExplorer, onReset }: FlowBannerProps) {
  if (step !== "success") return null;
  return (
    <div
      className="card"
      style={{
        marginBottom: 20,
        borderColor: "var(--accent-green)",
        background: "rgba(16, 185, 129, 0.06)",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <CheckCircle size={22} style={{ color: "var(--accent-green)" }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Transaction confirmed
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {txHash && (
              <a
                href={`${blockExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--brand)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                View on explorer <ExternalLink size={12} />
              </a>
            )}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onReset}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * VPFI vault + fee-discount surface. Lets a holder:
 *
 *   - **Deposit** VPFI into their personal vault on the lending chain to
 *     unlock the borrower/lender fee discount tier. Always an explicit
 *     user action.
 *   - **Unstake** VPFI back out of the vault to their wallet.
 *
 * It also surfaces the connected wallet's current discount tier, staking
 * rewards, and a VPFI transparency panel. Per-step pending states are
 * surfaced via the {@link VaultStep} state machine so the button labels and
 * disable logic stay consistent across the flow.
 */
const VPFI_APPROVE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]) as unknown as Abi;

export default function VPFIVaultAndDiscounts() {
  const { t } = useTranslation();
  const {
    address,
    activeChain,
    isCorrectChain,
    switchToDefaultChain,
  } = useWallet();
  const { data: walletClient } = useWalletClient();
  const publicClient = useDiamondPublicClient();

  const readChain = useReadChain();
  const diamond = useDiamondContract();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
  // Combined wallet+override guard: a write is safe only when the wallet's
  // chain actually matches the dashboard's view-chain override (if any).
  // Using isCorrectChain alone lets clicks fire while useDiamondContract()
  // has silently fallen back to a read-only provider.
  const canWrite = useCanWrite();
  const canonical = getCanonicalVPFIChain();
  const { snapshot: userVpfi, reload: reloadUserVpfi } = useUserVPFI(address);
  const { snapshot: vpfiSnapshot } = useVPFIToken();
  // Live staking APR — single read of `getStakingAPRBps`. Interpolated
  // into i18n strings via `{{apr}}` so copy never falsely advertises
  // 5% when governance has changed the rate via `setStakingApr`.
  const { aprPct } = useStakingApr();
  const { balance: vaultBal, reload: reloadVault } =
    useVaultVPFIBalance(address);
  const { mode } = useMode();
  const isAdvanced = mode === 'advanced';
  // Discount-tier + consent reads back the connected wallet's current
  // tier so `<DiscountStatusCard>` can render below. Was on the
  // Dashboard previously; moved here so the tier-thresholds reference
  // is co-located with the buying decision.
  const { data: discountTier } = useVPFIDiscountTier(address);
  const { enabled: consentEnabled } = useVPFIDiscountConsent();

  const [depositInput, setDepositInput] = useState<string>("");
  const [unstakeInput, setUnstakeInput] = useState<string>("");
  const [step, setStep] = useState<VaultStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Re-entry guard for the deposit flow. `step` alone can't prevent a
  // double-click: between the click and the first `setStep` call the handler
  // is already awaiting an `allowance()` RPC read (can take seconds), and
  // React state updates don't reflect back into the closed-over value until
  // the next render. A ref flips synchronously so a second click during
  // that window no-ops instead of firing a second approve tx.
  const depositInFlight = useRef(false);
  // `walletVpfi === null` means the snapshot hasn't loaded yet — distinct
  // from a resolved balance of 0. Downstream UI uses the null to show "—"
  // instead of a phantom zero while the fetch is in flight.
  const walletVpfi = userVpfi ? userVpfi.balance : null;
  const tokenAddr = userVpfi?.token ?? null;
  const tokenRegistered = !!userVpfi?.registered;

  const handleDeposit = async () => {
    if (depositInFlight.current) return;
    if (
      !canWrite ||
      !address ||
      !walletClient ||
      !publicClient ||
      !activeChain ||
      !tokenAddr ||
      !tokenRegistered
    )
      return;
    setError(null);
    setTxHash(null);
    const raw = (depositInput ?? "").trim();
    if (!raw) {
      setError("Enter a VPFI amount to deposit.");
      return;
    }
    let depositWei: bigint;
    try {
      depositWei = parseEther(raw);
    } catch {
      setError("Invalid VPFI amount.");
      return;
    }
    if (depositWei === 0n) {
      setError("Deposit amount must be greater than zero.");
      return;
    }

    // Latch the in-flight flag and flip the visible step immediately, so the
    // button renders as disabled during the allowance check — not only after
    // the approve tx is submitted.
    depositInFlight.current = true;
    setStep("approving-deposit");
    const s = beginStep({
      area: "vpfi-buy",
      flow: "depositVPFIToVault",
      step: "submit",
    });
    try {
      // Approve diamond on the VPFI token first. Uses a minimal ERC20 iface
      // since the VPFI token lives outside the diamond ABI.
      const diamondAddr = activeChain.diamondAddress;
      if (!diamondAddr) {
        setError(
          `The Vaipakam Diamond is not yet deployed on ${activeChain.name}.`,
        );
        setStep("idle");
        return;
      }
      // Permit2 single-tx path: sign an EIP-712 PermitTransferFrom and
      // let the diamond pull via Permit2 in the same tx as the deposit.
      // On any failure (wallet lacks EIP-712 v4, no Permit2 allowance
      // on the VPFI token, user cancels), fall through to the classic
      // approve+deposit sequence below.
      if (permit2CanSign) {
        try {
          setStep("depositing");
          const { permit, signature } = await permit2Sign({
            token: tokenAddr as Address,
            amount: depositWei,
            spender: diamondAddr as Address,
          });
          const tx = await (
            diamond as unknown as {
              depositVPFIToVaultWithPermit: (
                amount: bigint,
                permit: unknown,
                signature: Hex,
              ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
            }
          ).depositVPFIToVaultWithPermit(depositWei, permit, signature);
          setTxHash(tx.hash);
          await tx.wait();
          setStep("success");
          s.success({ note: `deposited ${depositWei} via Permit2` });
          setDepositInput("");
          await Promise.all([reloadUserVpfi(), reloadVault()]);
          return;
        } catch (permitErr) {
          console.debug(
            "[BuyVPFI] Permit2 deposit failed, falling back to classic:",
            permitErr,
          );
          // fall through to classic approve+deposit
        }
      }

      const currentAllowance = (await publicClient.readContract({
        address: tokenAddr as Address,
        abi: VPFI_APPROVE_ABI,
        functionName: "allowance",
        args: [address as Address, diamondAddr as Address],
      })) as bigint;
      if (currentAllowance < depositWei) {
        // Approve exactly the deposit amount. Users were uncomfortable
        // with wallets surfacing an "unlimited spend" prompt even though
        // the spender is our own Diamond — so we trade one extra approval
        // per deposit for a clearer wallet UX. A future deposit that fits
        // within the still-unconsumed allowance skips the approve leg.
        setStep("approving-deposit");
        const approveHash = await walletClient.writeContract({
          address: tokenAddr as Address,
          abi: VPFI_APPROVE_ABI,
          functionName: "approve",
          args: [diamondAddr as Address, depositWei],
          account: walletClient.account!,
          chain: walletClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setStep("depositing");
      const tx = await (
        diamond as unknown as {
          depositVPFIToVault: (
            amount: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).depositVPFIToVault(depositWei);
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      s.success({ note: `deposited ${depositWei}` });
      setDepositInput("");
      await Promise.all([reloadUserVpfi(), reloadVault()]);
    } catch (err) {
      setError(decodeContractError(err, "Deposit failed"));
      setStep("idle");
      s.failure(err);
    } finally {
      depositInFlight.current = false;
    }
  };

  // Re-entry guard for the unstake flow. Same rationale as depositInFlight:
  // `step` state alone can't block a rapid double-click before the first
  // setStep propagates.
  const unstakeInFlight = useRef(false);

  const handleUnstake = async () => {
    if (unstakeInFlight.current) return;
    if (!canWrite || !address || !walletClient || !activeChain || !tokenRegistered)
      return;
    setError(null);
    setTxHash(null);
    const raw = (unstakeInput ?? "").trim();
    if (!raw) {
      setError("Enter a VPFI amount to unstake.");
      return;
    }
    let unstakeWei: bigint;
    try {
      unstakeWei = parseEther(raw);
    } catch {
      setError("Invalid VPFI amount.");
      return;
    }
    if (unstakeWei === 0n) {
      setError("Unstake amount must be greater than zero.");
      return;
    }
    if (vaultBal != null && unstakeWei > vaultBal) {
      setError("Unstake amount exceeds your vault balance.");
      return;
    }

    unstakeInFlight.current = true;
    setStep("unstaking");
    const s = beginStep({
      area: "vpfi-buy",
      flow: "withdrawVPFIFromVault",
      step: "submit",
    });
    try {
      const tx = await (
        diamond as unknown as {
          withdrawVPFIFromVault: (
            amount: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).withdrawVPFIFromVault(unstakeWei);
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      s.success({ note: `unstaked ${unstakeWei}` });
      setUnstakeInput("");
      await Promise.all([reloadUserVpfi(), reloadVault()]);
    } catch (err) {
      setError(decodeContractError(err, "Unstake failed"));
      setStep("idle");
      s.failure(err);
    } finally {
      unstakeInFlight.current = false;
    }
  };

  if (!address) {
    // Pre-connect — render a marketing block (what VPFI buys you)
    // instead of the empty "connect wallet" placeholder. Read-only
    // protocol stats live on the public Analytics page; here the
    // pitch is the user's *own* benefit (yield-fee discount on
    // lending, initiation-fee rebate on borrowing, ETH→VPFI buy at
    // a fixed protocol rate). Once the wallet connects, the buy
    // surface below renders as before.
    return (
      <div className="buy-vpfi" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="page-header">
          <h1 className="page-title">{t('buyVpfi.title')}</h1>
          <p className="page-subtitle">{t('buyVpfi.preconnect.tagline')}</p>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div
            className="card-title"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <Gift size={16} />
            {t('buyVpfi.preconnect.discountTitle')}
          </div>
          <p>{t('buyVpfi.preconnect.discountBody')}</p>
          <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
            <li>{t('buyVpfi.preconnect.discountBullet1')}</li>
            <li>{t('buyVpfi.preconnect.discountBullet2')}</li>
          </ul>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div
            className="card-title"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <TrendingUp size={16} />
            {t('buyVpfi.preconnect.stakingTitle')}
          </div>
          <p>{t('buyVpfi.preconnect.stakingBody')}</p>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div
            className="card-title"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <ShieldCheck size={16} />
            {t('buyVpfi.preconnect.howTitle')}
          </div>
          <p>{t('buyVpfi.preconnect.howBody')}</p>
          <p style={{ marginTop: 12, opacity: 0.75, fontSize: '0.85rem' }}>
            {t('buyVpfi.preconnect.analyticsHint')}{' '}
            <Link to="/analytics" style={{ color: 'var(--brand)' }}>
              {t('buyVpfi.preconnect.analyticsLink')}
            </Link>
            .
          </p>
        </div>

        <div
          className="empty-state"
          style={{ marginTop: 24, minHeight: 'auto' }}
        >
          <div className="empty-state-icon">
            <Wallet size={24} />
          </div>
          <h3>{t('buyVpfi.connectTitle')}</h3>
          <p>{t('buyVpfi.connectBody')}</p>
        </div>
      </div>
    );
  }

  // Spec §62, §124: Buy VPFI works from any supported chain, but the user's
  // current network must actually have a Vaipakam Diamond deployed — otherwise
  // we'd be reading fixed-rate / cap config from a fallback-chain Diamond and
  // writing transactions to an incompatible network. Surface this explicitly
  // instead of silently falling back.
  if (!isCorrectChain) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div className="empty-state-icon">
          <AlertTriangle size={28} />
        </div>
        <h3>{t('buyVpfi.unsupportedNetwork')}</h3>
        <p style={{ maxWidth: 520 }}>{t('buyVpfi.unsupportedNetworkBody')}</p>
        <button
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          onClick={() => {
            void switchToDefaultChain();
          }}
        >
          {t('nav.switchNetwork')}
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="page-header">
        <h1 className="page-title">
          <Coins
            size={22}
            style={{ verticalAlign: "middle", marginRight: 8 }}
          />
          {t('appNav.buyVpfi')}
          <CardInfo id="buy-vpfi.overview" />
        </h1>
        <p className="page-subtitle">{t('buyVpfi.pageSubtitle')}</p>
      </div>

      {address && (
        <SanctionsBanner
          address={address as `0x${string}`}
          label={t('banners.sanctionsLabelWallet')}
        />
      )}

      <FlowBanner
        step={step}
        txHash={txHash}
        blockExplorer={activeChain?.blockExplorer ?? canonical.blockExplorer}
        onReset={() => {
          setStep("idle");
          setTxHash(null);
        }}
      />

      {/* Discount status card moved to the Dashboard so users see
          their tier / vault VPFI / consent status on landing without
          navigating to the public Buy VPFI page. The component itself
          is exported below and consumed by Dashboard. */}

      {error && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderColor: "var(--accent-red, #ef4444)",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AlertTriangle
              size={18}
              style={{ color: "var(--accent-red, #ef4444)" }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Transaction failed</div>
              <p className="stat-label" style={{ margin: "4px 0 0" }}>
                {error}
              </p>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexShrink: 0,
              }}
            >
              <ReportIssueLink variant="inline" />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setError(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live VPFI discount-tier status. Surfaces tier table + current
          tier the moment a user hits the buy page so they can size
          their purchase against the next tier threshold without
          context-switching. Renders only when a wallet is connected
          — for disconnected users the page already explains buying;
          showing "Inactive · below Tier 1" with a 0 vault balance
          would read as a problem rather than a not-yet state. */}
      {address && (
        <DiscountStatusCard
          tier={discountTier?.tier ?? 0}
          vaultVpfi={vaultBal}
          discountBps={discountTier?.discountBps ?? 0}
          consentEnabled={consentEnabled}
        />
      )}

      {/* Step 1 — deposit to vault on the lending chain (always explicit).
           `id="step-2"` is kept as the deep-link anchor for the VPFI
           dropdown's Stake item. */}
      <div id="step-2" className="card" style={{ marginBottom: 20 }}>
        <StepHeader
          index={1}
          title={t('buyVpfi.step2Title')}
          cardHelpId="buy-vpfi.deposit"
          cardHelpParams={{ apr: aprPct }}
        />
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid rgba(59, 130, 246, 0.25)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <Info
            size={18}
            style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2 }}
          />
          <p className="stat-label" style={{ margin: 0 }}>
            {t('buyVpfi.step2Info', { apr: aprPct })}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <div className="stat-value">
              {walletVpfi == null ? "—" : formatAmount(walletVpfi)}
            </div>
            <div className="stat-label">Wallet VPFI balance</div>
          </div>
          <Stat
            label={`Vault VPFI balance (${activeChain?.name ?? readChain.name})`}
            value={
              vaultBal == null ? "—" : formatAmount(formatVpfiUnits(vaultBal))
            }
          />
        </div>

        {!tokenRegistered ? (
          <p className="stat-label" style={{ margin: 0 }}>
            VPFI is not yet registered with the diamond on{" "}
            {activeChain?.name ?? readChain.name}. Admin must call{" "}
            <span className="mono">setVPFIToken</span> before deposits are
            possible.
          </p>
        ) : (
          <DepositCard
            value={depositInput}
            onChange={setDepositInput}
            walletBalance={walletVpfi ?? 0}
            pending={step === "approving-deposit" || step === "depositing"}
            step={step}
            onDeposit={handleDeposit}
            previewTx={(() => {
              // Phase 8b.2 preview: encode the classic-path
              // `depositVPFIToVault(amount)` calldata. Even when the
              // submit handler picks the Permit2 single-sig variant,
              // the underlying state change Blockaid scans (VPFI from
              // wallet → vault) is identical, and the classic path
              // does not require a yet-to-be-signed permit / signature
              // pair to render meaningful preview output.
              const raw = (depositInput ?? "").trim();
              if (!raw || !activeChain?.diamondAddress) return null;
              let amountWei: bigint;
              try {
                amountWei = parseEther(raw);
              } catch {
                return null;
              }
              if (amountWei === 0n) return null;
              return {
                to: activeChain.diamondAddress as Address,
                data: encodeFunctionData({
                  abi: DIAMOND_ABI,
                  functionName: "depositVPFIToVault",
                  args: [amountWei],
                }) as Hex,
                value: 0n,
              };
            })()}
          />
        )}
      </div>

      {/* Staking-rewards claim card — sits right after Step 2 (Deposit/
          Stake) since the rewards literally accrue from what gets
          deposited there. Always renders (even at zero pending) so the
          program is visible to fresh users; the chrome flips green +
          "available" copy only when there's something to claim, otherwise
          stays neutral with informational copy that promotes the program. */}
      <StakingRewardsClaim
        address={address ?? null}
        chainId={activeChain?.chainId}
        blockExplorer={activeChain?.blockExplorer ?? readChain.blockExplorer}
        variant="card"
      />

      {/* Unstake — pull VPFI back out of vault into the wallet. Pairs with
          Step 2 (Deposit): same token, same chain, opposite direction.
          No approve leg because the Diamond owns the vault and debits
          itself on `withdrawVPFIFromVault`. Reducing the vault balance
          may drop the borrower's discount tier — surface that in the
          explainer instead of blocking the action. */}
      {tokenRegistered && (
        // `id="step-3"` is kept as the deep-link anchor for the VPFI
        // dropdown's Unstake item.
        <div id="step-3" className="card" style={{ marginBottom: 20 }}>
          <StepHeader
            index={2}
            title={t('buyVpfi.step3Title')}
            cardHelpId="buy-vpfi.unstake"
          />
          <UnstakeCard
            value={unstakeInput}
            onChange={setUnstakeInput}
            vaultBalance={vaultBal}
            pending={step === "unstaking"}
            step={step}
            onUnstake={handleUnstake}
          />
        </div>
      )}

      {/* VPFI transparency panel — wallet/vault balances, on-chain
          token+minter+treasury addresses, and the user's recent VPFI
          transfer history (paginated, 10 rows per page). Lifted from the
          Dashboard so it sits near the buy/deposit/unstake controls. */}
      <VPFIPanel
        vpfi={vpfiSnapshot}
        userVpfi={userVpfi}
        vaultVpfiWei={vaultBal}
        networkName={activeChain?.name ?? readChain.name}
        networkChainId={activeChain?.chainId ?? readChain.chainId}
        blockExplorer={activeChain?.blockExplorer ?? readChain.blockExplorer}
        isCanonicalVPFI={activeChain?.isCanonicalVPFI ?? readChain.isCanonicalVPFI}
        isAdvanced={isAdvanced}
      />
    </div>
  );
}

interface StepHeaderProps {
  /** Step number displayed in the circled badge (1-indexed). */
  index: number;
  /** Step's large heading. */
  title: string;
  /** Supporting copy below the title. Optional — when omitted, only the
   *  title row renders (used by Step 2 where an Info callout below the
   *  header carries the supporting copy instead). */
  subtitle?: string;
  /** Optional CardInfo registry id to render the (i) tip next to title. */
  cardHelpId?: string;
  /** Optional interpolation params forwarded to CardInfo → i18next.
   *  Used by Step 2 to inject the live staking APR into the deposit-
   *  step help tooltip (`{{apr}}` placeholder). */
  cardHelpParams?: Record<string, unknown>;
}

/** Numbered-step header used as the card title for each stage in the flow. */
function StepHeader({ index, title, subtitle, cardHelpId, cardHelpParams }: StepHeaderProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "var(--brand)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {index}
        </span>
        <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
          {cardHelpId && <CardInfo id={cardHelpId} params={cardHelpParams} />}
        </div>
      </div>
      {subtitle && (
        <p className="stat-label" style={{ margin: 0, paddingLeft: 36 }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

interface StatProps {
  /** Caption shown below the value. */
  label: string;
  /** Pre-formatted display value (caller controls units / precision).
   *  Accepts ReactNode so callers can embed inline elements
   *  (e.g. a CoinGecko deep-link on the asset symbol — see T-038). */
  value: React.ReactNode;
}

/** Compact stat block used inside the buy / deposit cards. */
function Stat({ label, value }: StatProps) {
  return (
    <div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

interface DiscountStatusCardProps {
  /** Current on-chain tier 0..4 for the connected wallet. */
  tier: number;
  /** Vault VPFI balance (18-dec) on the active chain; null = not loaded yet. */
  vaultVpfi: bigint | null;
  /** Discount bps associated with the current tier (e.g. 1000 = 10%). */
  discountBps: number;
  /** Platform-level consent flag; null while loading, false = opted out. */
  consentEnabled: boolean | null;
}

/**
 * Surfaces the borrower's active VPFI fee-discount status directly on the Buy
 * page so the user can see, before buying, (a) the tier they sit in today,
 * (b) what the next tier requires, (c) whether the platform-level consent
 * switch is on, and (d) that vault-held VPFI doubles as staked (5% APR).
 *
 * Spec: TokenomicsTechSpec.md §6 (tier table, consent, liquid assets only)
 * and §8a (vault = staked). Consent is read-only here — the toggle itself
 * lives on the Dashboard per spec.
 */
export function DiscountStatusCard({
  tier,
  vaultVpfi,
  discountBps,
  consentEnabled,
}: DiscountStatusCardProps) {
  const { t } = useTranslation();
  // Live staking APR for the help-tooltip interpolation. Pulled here
  // (not from a parent prop) so this component stays self-contained
  // — it's mounted on both the Dashboard and historically on Buy VPFI.
  const { aprPct } = useStakingApr();
  // Live tier table — derived from on-chain `getVpfiTierThresholds` /
  // `getVpfiTierDiscountBps` so governance changes flow through to the
  // displayed thresholds and discounts without a frontend redeploy.
  const tierTable = useVpfiTierTable();
  const vaultUnits = formatVpfiUnits(vaultVpfi);
  const nextTier = tierTable.find((tt) => tt.tier === tier + 1) ?? null;
  const gapToNext = nextTier ? Math.max(0, nextTier.minVpfi - vaultUnits) : 0;
  const currentTierRow =
    tier > 0 ? (tierTable.find((tt) => tt.tier === tier) ?? null) : null;

  let qualificationLabel: string;
  let qualificationColor: string;
  if (consentEnabled === false) {
    qualificationLabel = t('buyVpfiCards.inactiveOff');
    qualificationColor = "var(--accent-yellow)";
  } else if (tier === 0) {
    qualificationLabel = t('buyVpfiCards.inactiveBelowTier1', {
      tier1Min: tierTable[0]?.minVpfi ?? 100,
    });
    qualificationColor = "var(--text-secondary)";
  } else {
    qualificationLabel = t('buyVpfiCards.activeTier', { tier, pct: discountBps / 100 });
    qualificationColor = "var(--accent-green)";
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        {t('buyVpfiCards.discountStatusTitle')}
        <CardInfo id="buy-vpfi.discount-status" params={{ apr: aprPct }} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div>
          <div className="stat-label">{t('buyVpfiCards.currentTier')}</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {tier === 0 ? "—" : t('buyVpfiCards.tierN', { tier })}
          </div>
          <div className="stat-label" style={{ fontSize: 11 }}>
            {currentTierRow ? currentTierRow.discountLabel : t('buyVpfiCards.noDiscountYet')}
          </div>
        </div>
        <div>
          <div className="stat-label">{t('buyVpfiCards.vaultVpfi')} </div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {vaultVpfi == null ? "—" : vaultUnits.toFixed(4)}
          </div>
          <div className="stat-label" style={{ fontSize: 11 }}>
            {t('buyVpfiCards.vaultCountsAsStaked', { apr: aprPct })}
          </div>
        </div>
        <div>
          <div className="stat-label">{t('buyVpfiCards.statusLabel')}</div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: qualificationColor,
            }}
          >
            {qualificationLabel}
          </div>
          <div className="stat-label" style={{ fontSize: 11 }}>
            {consentEnabled === false ? (
              // The consent toggle lives on the Dashboard now (it
              // moved off the Buy VPFI page in the same release that
              // dropped the inline staking-rewards mirror — see the
              // Dashboard's `<VPFIDiscountConsentCard>`). The inline
              // <dashboardLink> placeholder lets the i18n string
              // stay one sentence with the link inline rather than
              // a tacked-on "(see Dashboard)" suffix.
              <Trans
                i18nKey="buyVpfiCards.enableSharedConsent"
                components={{
                  dashboardLink: (
                    <Link
                      to=""
                      style={{ color: 'var(--brand)', textDecoration: 'underline' }}
                    />
                  ),
                }}
              />
            ) : (
              t('buyVpfiCards.liquidLendingOnly')
            )}
          </div>
        </div>
      </div>

      {nextTier && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 10,
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "rgba(59, 130, 246, 0.05)",
            alignItems: "flex-start",
          }}
        >
          <Info
            size={16}
            style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2 }}
          />
          <div className="stat-label" style={{ margin: 0, fontSize: 12 }}>
            {gapToNext > 0 ? (
              t('buyVpfiCards.depositMore', {
                amount: gapToNext.toFixed(2),
                tier: nextTier.label,
                discount: nextTier.discountLabel,
              })
            ) : (
              t('buyVpfiCards.depositGapAchieved', { tier: nextTier.label })
            )}
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>{t('buyVpfiCards.tierColTier')}</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>
                {t('buyVpfiCards.tierColVault')}
              </th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>{t('buyVpfiCards.tierColDiscount')}</th>
            </tr>
          </thead>
          <tbody>
            {tierTable.map((row) => {
              const active = row.tier === tier;
              return (
                <tr
                  key={row.tier}
                  style={{
                    background: active ? "rgba(16, 185, 129, 0.08)" : undefined,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <td style={{ padding: "6px 8px" }}>{row.label}</td>
                  <td style={{ padding: "6px 8px" }}>
                    {row.maxVpfi == null
                      ? `> ${formatNumber(row.minVpfi - 0.000001, { maximumFractionDigits: 0 })}`
                      : `${formatNumber(row.minVpfi)} – ${formatNumber(row.maxVpfi, { maximumFractionDigits: 0 })}`}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{row.discountLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface DepositCardProps {
  /** Raw deposit amount input. */
  value: string;
  /** Setter for the deposit amount input. */
  onChange: (v: string) => void;
  /** User's current VPFI wallet balance (already normalized to units). */
  walletBalance: number;
  /** True while either the approve or deposit tx is pending. */
  pending: boolean;
  /** Current outer-flow step — drives the button label. */
  step: VaultStep;
  /** Submit handler wired to approve-then-deposit. */
  onDeposit: () => void;
  /** Phase 8b.2 — pending tx for the inline Blockaid preview, or
   *  null when the deposit input is empty / invalid. */
  previewTx: { to: Address; data: Hex; value: bigint } | null;
}

/**
 * Deposit card: ERC20 approve + `depositVPFIToVault`. Rendered only after
 * the diamond has `vpfiToken` set — the outer component gates on that.
 */
function DepositCard({
  value,
  onChange,
  walletBalance,
  pending,
  step,
  onDeposit,
  previewTx,
}: DepositCardProps) {
  const { t } = useTranslation();
  const inFlow = step === "approving-deposit" || step === "depositing";
  const rawInput = value.trim();
  const inputEmpty = rawInput === "";
  // Parse-as-number for the comparison; anything that doesn't parse is
  // treated as not-yet-valid and falls through to the `inputEmpty` branch.
  const parsedInput = rawInput === "" ? NaN : Number(rawInput);
  const inputInvalid = !Number.isFinite(parsedInput) || parsedInput <= 0;
  const exceedsBalance = !inputInvalid && parsedInput > walletBalance;
  const disableReason = inputEmpty
    ? "Enter amount of VPFI to transfer to Vault"
    : inputInvalid
      ? "Enter a valid VPFI amount"
      : exceedsBalance
        ? `Amount exceeds your wallet VPFI balance (${formatAmount(walletBalance)} VPFI)`
        : null;
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label className="stat-label" style={{ margin: 0, fontWeight: 500 }}>
          {t('buyVpfiCards.depositAmount')}
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onChange(walletBalance.toString())}
          disabled={walletBalance === 0}
        >
          {t('buyVpfiCards.useMaxVpfi', { amount: formatAmount(walletBalance) })}
        </button>
      </div>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="form-input"
        style={{ marginBottom: 12 }}
      />

      {/* Two-step progress indicator. Activates once the user clicks
          Deposit, so the "why am I seeing two MetaMask prompts?" question
          answers itself visually — Step 1 approves the Diamond to pull VPFI
          from the wallet, Step 2 moves the approved amount into vault. */}
      <DepositStepTrail step={step} />

      {/* Two-prompt explainer. Shown whenever a deposit could trigger the
          approve + deposit pair — which, with exact-amount approvals, is
          every deposit unless a previous allowance still covers the new
          amount. Hidden only when the flow is already in progress or the
          wallet has no VPFI to deposit. */}
      {!inFlow && walletBalance > 0 && (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid rgba(59, 130, 246, 0.25)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
          }}
        >
          <Info
            size={16}
            style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2 }}
          />
          <p
            className="stat-label"
            style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}
          >
            The deposit may need <strong>approval</strong> so the Diamond can
            pull VPFI from your wallet. Expect{" "}
            <strong>two MetaMask prompts</strong> — one to approve the exact
            amount you're about to deposit, then one to move it into your
            vault. If a previous approval still covers this amount, the
            approval step is skipped.
          </p>
        </div>
      )}

      {exceedsBalance && !inFlow && (
        <p
          className="stat-label"
          style={{ margin: "-4px 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          Amount exceeds your wallet VPFI balance of{" "}
          {formatAmount(walletBalance)} VPFI.
        </p>
      )}

      {/* Phase 8b.2 transaction-preview surface for the deposit step.
          Hidden once the action is mid-flight — Blockaid only adds
          value at the review-before-sign moment. */}
      {!inFlow && !exceedsBalance && (
        <SimulationPreview tx={previewTx} />
      )}

      <button
        className="btn btn-primary"
        onClick={onDeposit}
        disabled={
          pending ||
          walletBalance === 0 ||
          inputEmpty ||
          inputInvalid ||
          exceedsBalance
        }
        data-tooltip={disableReason ?? undefined}
      >
        {step === "approving-deposit"
          ? t('buyVpfi.approvingVpfi')
          : step === "depositing"
            ? t('buyVpfi.depositing')
            : t('buyVpfi.depositToVault')}
      </button>
    </div>
  );
}

interface UnstakeCardProps {
  /** Raw unstake amount input. */
  value: string;
  /** Setter for the unstake amount input. */
  onChange: (v: string) => void;
  /** Current vault VPFI balance (18-dec); null while loading. */
  vaultBalance: bigint | null;
  /** True while the `withdrawVPFIFromVault` tx is pending. */
  pending: boolean;
  /** Current outer-flow step — drives the button label. */
  step: VaultStep;
  /** Submit handler wired to the withdraw tx. */
  onUnstake: () => void;
}

/**
 * Unstake card — pulls VPFI out of the per-user vault back to the user's
 * wallet via `withdrawVPFIFromVault`. No ERC20 approval is required (the
 * Diamond already controls the vault), so it's a single tx unlike the
 * deposit flow. Intentionally mirrors {@link DepositCard}'s layout so the
 * two read as a symmetric pair.
 */
function UnstakeCard({
  value,
  onChange,
  vaultBalance,
  pending,
  step,
  onUnstake,
}: UnstakeCardProps) {
  const { t } = useTranslation();
  // Live staking APR for the unstake-warning copy. Single read.
  const { aprPct } = useStakingApr();
  const vaultBalanceUnits = formatVpfiUnits(vaultBalance);
  const rawInput = value.trim();
  const inputEmpty = rawInput === "";
  const parsedInput = rawInput === "" ? NaN : Number(rawInput);
  const inputInvalid = !Number.isFinite(parsedInput) || parsedInput <= 0;
  const exceedsBalance = !inputInvalid && parsedInput > vaultBalanceUnits;
  const balanceZero = vaultBalance == null || vaultBalance === 0n;
  const disableReason = balanceZero
    ? "Your vault VPFI balance is 0 — deposit VPFI first."
    : inputEmpty
      ? "Enter amount of VPFI to unstake from Vault"
      : inputInvalid
        ? "Enter a valid VPFI amount"
        : exceedsBalance
          ? `Amount exceeds your vault VPFI balance (${formatAmount(vaultBalanceUnits)} VPFI)`
          : null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label className="stat-label" style={{ margin: 0, fontWeight: 500 }}>
          {t('buyVpfiCards.unstakeAmount')}
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onChange(vaultBalanceUnits.toString())}
          disabled={balanceZero || pending}
        >
          {t('buyVpfiCards.useMaxVpfi', { amount: formatAmount(vaultBalanceUnits) })}
        </button>
      </div>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="form-input"
        style={{ marginBottom: 12 }}
        disabled={pending}
      />

      {exceedsBalance && !pending && (
        <p
          className="stat-label"
          style={{ margin: "-4px 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          {t('buyVpfiCards.exceedsVaultBalance', { balance: formatAmount(vaultBalanceUnits) })}
        </p>
      )}

      <div
        className="alert alert-warning"
        role="alert"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          background: "rgba(245, 158, 11, 0.06)",
          border: "1px solid rgba(245, 158, 11, 0.25)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
        }}
      >
        <AlertTriangle
          size={16}
          style={{
            color: "var(--accent-orange)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <p
          // className="stat-label"
          style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}
        >
          {t('buyVpfiCards.unstakeWarning', { apr: aprPct })}
        </p>
      </div>

      <button
        className="btn btn-primary"
        onClick={onUnstake}
        disabled={
          pending || balanceZero || inputEmpty || inputInvalid || exceedsBalance
        }
        data-tooltip={disableReason ?? undefined}
      >
        {step === "unstaking" ? t('buyVpfi.unstaking') : t('buyVpfi.unstakeToWallet')}
      </button>
    </div>
  );
}

/**
 * Two-dot progress strip for the approve → deposit flow. Renders nothing in
 * idle / success states and lights each step as the flow advances so the
 * user understands which MetaMask prompt they're being asked to sign.
 */
function DepositStepTrail({ step }: { step: VaultStep }) {
  if (step !== "approving-deposit" && step !== "depositing") return null;
  const approveDone = step === "depositing";
  const approveActive = step === "approving-deposit";
  const depositActive = step === "depositing";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        marginBottom: 12,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-primary)",
        fontSize: 12,
      }}
    >
      <DepositStep
        label="Approve"
        sublabel="1-time, in MetaMask"
        status={approveDone ? "done" : approveActive ? "active" : "pending"}
      />
      <div
        style={{
          flex: 1,
          height: 2,
          background: approveDone ? "var(--brand)" : "var(--border)",
          borderRadius: 1,
        }}
      />
      <DepositStep
        label="Deposit"
        sublabel="into your vault"
        status={depositActive ? "active" : approveDone ? "active" : "pending"}
      />
    </div>
  );
}

function DepositStep({
  label,
  sublabel,
  status,
}: {
  label: string;
  sublabel: string;
  status: "pending" | "active" | "done";
}) {
  const dotBg =
    status === "done"
      ? "var(--brand)"
      : status === "active"
        ? "var(--brand)"
        : "var(--bg-card)";
  const dotBorder = status === "pending" ? "var(--border)" : "var(--brand)";
  const textColor =
    status === "pending" ? "var(--text-tertiary)" : "var(--text-primary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: dotBg,
          border: `2px solid ${dotBorder}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "background 0.2s ease, border-color 0.2s ease",
        }}
      >
        {status === "done" && (
          <CheckCircle size={12} style={{ color: "#fff" }} />
        )}
        {status === "active" && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#fff",
              animation: "spin 1s linear infinite",
            }}
          />
        )}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: textColor, lineHeight: 1.1 }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--text-tertiary)",
            lineHeight: 1.1,
            marginTop: 2,
          }}
        >
          {sublabel}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact numeric formatter used across the Buy/Deposit UI.
 * - ≥ 1M → `x.xxM`
 * - ≥ 1k → `x.xxK`
 * - ≥ 1  → up to 4 decimals, trailing zeros trimmed
 * - < 1  → up to 6 decimals, trailing zeros trimmed
 * - NaN / 0 → `'0'`
 */
function formatAmount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toFixed(6).replace(/\.?0+$/, "");
}
