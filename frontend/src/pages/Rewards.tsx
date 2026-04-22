import { useMemo, useState } from "react";
import {
  Coins,
  TrendingUp,
  Wallet,
  ArrowDown,
  CheckCircle,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { useWallet } from "../context/WalletContext";
import {
  useDiamondContract,
  useReadChain,
  useCanWrite,
} from "../contracts/useDiamond";
import { useRewards, formatVpfi, parseVpfiInput } from "../hooks/useRewards";
import { VPFI_TIER_TABLE } from "../hooks/useVPFIDiscount";
import { decodeContractError } from "../lib/decodeContractError";
import { beginStep } from "../lib/journeyLog";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
import "./Dashboard.css";

// Official LayerZero Superbridge entry — used for the optional
// "Bridge to another chain" CTA after a claim or unstake (WebsiteReadme §97,
// §122). External link; bridging is always opt-in.
const SUPERBRIDGE_URL = "https://layerzero.superbridge.app/";

type Step = "idle" | "claiming" | "unstake-review" | "withdrawing" | "success";

// Tracks which flow produced the most recent success so the success banner
// can tailor copy + show the bridge CTA only for flows that actually land
// VPFI in the user's wallet.
type LastTx = "claim" | "unstake" | null;

/**
 * Pure tier lookup mirroring VPFI_TIER_TABLE bounds. Used to preview the
 * discount tier the user would land in after an unstake, without an extra
 * on-chain call. Stays consistent with VPFIDiscountFacet.getVPFIDiscountTier
 * because the table is the source of truth the on-chain constants are
 * documented against (Tokenomics §6).
 */
function tierForVpfiUnits(balance: number): number {
  for (const t of VPFI_TIER_TABLE) {
    if (balance >= t.minVpfi && (t.maxVpfi === null || balance <= t.maxVpfi)) {
      return t.tier;
    }
  }
  return 0;
}

export default function Rewards() {
  const { address, isCorrectChain, activeChain, switchToDefaultChain } =
    useWallet();
  const diamond = useDiamondContract();
  const readChain = useReadChain();
  const { staking, interaction, loading, error, reload } = useRewards();

  const [withdrawInput, setWithdrawInput] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Amount captured at review-open so that any stray input edits between
  // confirm and submit don't silently change what the user agreed to.
  const [reviewAmount, setReviewAmount] = useState<bigint | null>(null);
  // Which flow produced the current success banner. Only 'claim' and
  // 'unstake' should offer the Bridge CTA (they actually deliver VPFI to
  // the wallet).
  const [lastTx, setLastTx] = useState<LastTx>(null);
  // Exact VPFI actually minted to the wallet on the last successful claim —
  // spec §95 requires the success state to show this, not just a generic
  // "confirmed" message. For a combined claim (staking + interaction), this
  // is the sum that actually settled on-chain.
  const [lastClaimed, setLastClaimed] = useState<bigint>(0n);

  // Source of truth for "can this page submit a write tx right now?" — also
  // ensures the dashboard's view-chain override matches the wallet's actual
  // chain, so a stale override can't leave claim/unstake buttons enabled
  // while useDiamondContract has silently fallen back to a read-only provider.
  const canTx = useCanWrite();

  const pendingStaking = staking?.pending ?? 0n;
  const pendingInteraction = interaction?.previewAmount ?? 0n;

  // Spec §4a: interaction claims block locally until the finalized
  // global denominator has been broadcast into this chain's storage.
  // When preview returns 0 AND the claim-cursor's first day isn't yet
  // finalized, surface that instead of the generic "nothing to claim".
  const interactionWaitingForFinalization =
    !!interaction &&
    !!address &&
    pendingInteraction === 0n &&
    !interaction.finalizedPrefix &&
    interaction.waitingForDay > 0n;

  const stakingPoolPct = useMemo(() => {
    if (!staking || staking.cap === 0n) return 0;
    return Number((staking.paidOut * 10_000n) / staking.cap) / 100;
  }, [staking]);

  const interactionPoolPct = useMemo(() => {
    if (!interaction || interaction.cap === 0n) return 0;
    return Number((interaction.paidOut * 10_000n) / interaction.cap) / 100;
  }, [interaction]);

  /**
   * Combined claim — spec §89-93 call for one `Claim Rewards` CTA that
   * claims both reward streams and reports the total minted on the current
   * chain. Implementation runs the two on-chain calls sequentially because
   * the Diamond exposes them as separate entry points; we track what
   * actually settled so the success banner can show the true total even if
   * only one leg had a pending amount, or if the second leg reverts after
   * the first succeeds.
   */
  async function claimRewards() {
    if (!canTx) return;
    const stakingPending = pendingStaking;
    const interactionClaimable =
      !interactionWaitingForFinalization && pendingInteraction > 0n
        ? pendingInteraction
        : 0n;
    if (stakingPending === 0n && interactionClaimable === 0n) return;

    setTxError(null);
    setTxHash(null);
    setStep("claiming");
    let settled = 0n;
    let lastHash: string | null = null;

    if (stakingPending > 0n) {
      const s = beginStep({
        area: "rewards",
        flow: "claimStakingRewards",
        step: "submit",
      });
      try {
        const d = diamond as unknown as {
          claimStakingRewards: () => Promise<{
            wait: () => Promise<{ hash?: string }>;
            hash: string;
          }>;
        };
        const tx = await d.claimStakingRewards();
        lastHash = tx.hash;
        setTxHash(tx.hash);
        await tx.wait();
        settled += stakingPending;
        s.success({ note: "staking claim confirmed" });
      } catch (err) {
        const decoded = decodeContractError(err) ?? (err as Error)?.message;
        setTxError(decoded ?? "Claim failed");
        s.failure(err);
        if (settled > 0n) {
          setLastClaimed(settled);
          setLastTx("claim");
          setStep("success");
        } else {
          setStep("idle");
        }
        await reload();
        return;
      }
    }

    if (interactionClaimable > 0n) {
      const s = beginStep({
        area: "rewards",
        flow: "claimInteractionRewards",
        step: "submit",
      });
      try {
        const d = diamond as unknown as {
          claimInteractionRewards: () => Promise<{
            wait: () => Promise<{ hash?: string }>;
            hash: string;
          }>;
        };
        const tx = await d.claimInteractionRewards();
        lastHash = tx.hash;
        setTxHash(tx.hash);
        await tx.wait();
        settled += interactionClaimable;
        s.success({ note: "interaction claim confirmed" });
      } catch (err) {
        const decoded = decodeContractError(err) ?? (err as Error)?.message;
        setTxError(
          settled > 0n
            ? `Staking claim settled, but interaction claim failed: ${decoded ?? "unknown error"}`
            : (decoded ?? "Claim failed"),
        );
        s.failure(err);
        if (settled > 0n) {
          setLastClaimed(settled);
          setLastTx("claim");
          setStep("success");
        } else {
          setStep("idle");
        }
        await reload();
        return;
      }
    }

    setLastClaimed(settled);
    setLastTx("claim");
    setTxHash(lastHash);
    setStep("success");
    await reload();
  }

  /**
   * Validates the amount-entry input and moves the user into the review
   * step. Actual withdraw only runs after the user confirms the review
   * (WebsiteReadme §110-116 requires an explicit confirmation step before
   * moving VPFI out of escrow).
   */
  function openUnstakeReview() {
    if (!canTx) return;
    setTxError(null);
    const amount = parseVpfiInput(withdrawInput.trim());
    if (amount === 0n) {
      setTxError("Enter a VPFI amount");
      return;
    }
    if (staking && amount > staking.userStaked) {
      setTxError("Amount exceeds your escrowed VPFI balance.");
      return;
    }
    setReviewAmount(amount);
    setStep("unstake-review");
  }

  async function confirmUnstake() {
    if (!canTx || reviewAmount == null) return;
    setTxError(null);
    setTxHash(null);
    setStep("withdrawing");
    const s = beginStep({
      area: "rewards",
      flow: "withdrawVPFIFromEscrow",
      step: "submit",
    });
    try {
      const d = diamond as unknown as {
        withdrawVPFIFromEscrow: (a: bigint) => Promise<{
          wait: () => Promise<{ hash?: string }>;
          hash: string;
        }>;
      };
      const tx = await d.withdrawVPFIFromEscrow(reviewAmount);
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      setLastTx("unstake");
      setWithdrawInput("");
      setReviewAmount(null);
      s.success({ note: `withdrew ${reviewAmount}` });
      await reload();
    } catch (err) {
      const decoded = decodeContractError(err) ?? (err as Error)?.message;
      setTxError(decoded ?? "Withdraw failed");
      // Fall back to the review step so the user doesn't lose the amount
      // they just confirmed (and can retry or cancel).
      setStep("unstake-review");
      s.failure(err);
    }
  }

  // Spec §101: if the wallet is disconnected or on an unsupported chain,
  // explain that rewards can only be claimed on supported lending chains —
  // don't let the page silently show fallback-chain reward data as if it
  // were the user's.
  if (!address) {
    return (
      <div>
        <h1 style={{ marginBottom: 8 }}>Rewards</h1>
        <div className="card">
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Wallet size={22} style={{ color: "var(--text-secondary)" }} />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Connect your wallet
              </div>
              <p className="stat-label" style={{ margin: 0 }}>
                Rewards can only be claimed on supported lending chains. Connect
                a wallet on a supported chain to view and claim your staking and
                interaction rewards.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!isCorrectChain) {
    return (
      <div>
        <h1 style={{ marginBottom: 8 }}>Rewards</h1>
        <div className="card" style={{ borderColor: "var(--accent-yellow)" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <AlertTriangle
              size={22}
              style={{ color: "var(--accent-yellow)" }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Unsupported network
              </div>
              <p className="stat-label" style={{ margin: "0 0 12px" }}>
                Rewards can only be claimed on supported lending chains. Your
                wallet is currently on{" "}
                <strong>{activeChain?.name ?? "an unsupported network"}</strong>
                , which does not host a Vaipakam Diamond. Switch to a supported
                chain to continue.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void switchToDefaultChain();
                }}
              >
                Switch network
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !staking) {
    return (
      <div>
        <h1>Rewards</h1>
        <p className="stat-label">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1>Rewards</h1>
        <div className="card" style={{ borderColor: "var(--accent-red)" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <AlertTriangle size={22} style={{ color: "var(--accent-red)" }} />
            <div>
              <div style={{ fontWeight: 600 }}>Failed to load rewards</div>
              <p className="stat-label" style={{ margin: 0 }}>
                {error.message}
              </p>
              <div style={{ marginTop: 10 }}>
                <ReportIssueLink variant="button" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 8 }}>Rewards</h1>
        <p className="stat-label" style={{ margin: 0 }}>
          Escrow-held VPFI accrues a 5% APR passively, and every USD of interest
          settled on a loan earns you a daily share of the interaction pool.
        </p>
      </header>

      {step === "success" && txHash && (
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
                {lastTx === "unstake"
                  ? "VPFI unstaked to your wallet"
                  : lastTx === "claim"
                    ? `Claimed ${formatVpfi(lastClaimed).toFixed(6)} VPFI on ${activeChain?.name ?? readChain.name}`
                    : "Transaction confirmed"}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <a
                  href={`${readChain.blockExplorer}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="stat-label"
                  style={{
                    color: "var(--brand)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  View on explorer <ExternalLink size={12} />
                </a>
                {/* Bridge-to-another-chain CTA — spec §97 (claims) and §122
                    (unstake). Opt-in external link to Superbridge; only shown
                    for flows that actually deliver VPFI to the user's wallet
                    on this chain. */}
                {lastTx && (
                  <a
                    href={SUPERBRIDGE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-sm"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    Bridge to another chain <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setStep("idle");
                setLastTx(null);
                setLastClaimed(0n);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {txError && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderColor: "var(--accent-red)",
            background: "rgba(239, 68, 68, 0.06)",
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <AlertTriangle size={22} style={{ color: "var(--accent-red)" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Transaction failed</div>
              <p className="stat-label" style={{ margin: 0 }}>
                {txError}
              </p>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setTxError(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 20,
        }}
      >
        {/* ── Combined Claim Rewards ───────────────────────────────────
             Spec §89-93 require one prominent Claim Rewards CTA that shows
             both reward streams, the total VPFI to be minted, and a
             confirmation that minting happens on the current chain. The
             breakdown stays so users see where the total comes from. */}
        <ClaimRewardsCard
          staking={staking}
          interaction={interaction}
          pendingStaking={pendingStaking}
          pendingInteraction={pendingInteraction}
          interactionWaiting={interactionWaitingForFinalization}
          stakingPoolPct={stakingPoolPct}
          interactionPoolPct={interactionPoolPct}
          canTx={canTx}
          claiming={step === "claiming"}
          chainName={activeChain?.name ?? readChain.name}
          onClaim={claimRewards}
        />

        {/* ── Withdraw VPFI from escrow ────────────────────────────── */}
        <div className="card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <ArrowDown size={20} style={{ color: "var(--brand)" }} />
            <h2 style={{ margin: 0 }}>Withdraw staked VPFI</h2>
          </div>
          <p className="stat-label" style={{ marginTop: 0 }}>
            Move VPFI out of your escrow back to your wallet. Withdrawn VPFI
            stops accruing staking rewards and no longer counts toward your
            discount tier.
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <Wallet size={14} style={{ color: "var(--text-secondary)" }} />
            <div className="stat-label" style={{ margin: 0 }}>
              In escrow:{" "}
              <strong style={{ color: "var(--text-primary)" }}>
                {staking ? formatVpfi(staking.userStaked).toFixed(4) : "—"} VPFI
              </strong>
            </div>
          </div>

          <label className="stat-label" style={{ display: "block" }}>
            Amount (VPFI)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={withdrawInput}
            onChange={(e) => setWithdrawInput(e.target.value)}
            placeholder="0.0"
            className="input"
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setWithdrawInput(
                  staking ? formatVpfi(staking.userStaked).toString() : "0",
                )
              }
              disabled={!staking || staking.userStaked === 0n}
            >
              Max
            </button>
          </div>
          <button
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={
              !canTx ||
              step === "withdrawing" ||
              step === "unstake-review" ||
              !withdrawInput ||
              !staking ||
              staking.userStaked === 0n
            }
            onClick={openUnstakeReview}
          >
            {!staking || staking.userStaked === 0n
              ? "No VPFI in escrow to unstake"
              : step === "withdrawing"
                ? "Unstaking…"
                : "Review unstake"}
          </button>

          {step === "unstake-review" && reviewAmount != null && (
            <UnstakeReview
              amount={reviewAmount}
              userStaked={staking?.userStaked ?? 0n}
              aprBps={staking?.aprBps ?? 0}
              busy={false}
              onCancel={() => {
                setReviewAmount(null);
                setStep("idle");
              }}
              onConfirm={confirmUnstake}
            />
          )}
          {step === "withdrawing" && reviewAmount != null && (
            <UnstakeReview
              amount={reviewAmount}
              userStaked={staking?.userStaked ?? 0n}
              aprBps={staking?.aprBps ?? 0}
              busy={true}
              onCancel={() => {
                /* cannot cancel mid-tx */
              }}
              onConfirm={confirmUnstake}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface ClaimRewardsCardProps {
  staking: ReturnType<typeof useRewards>["staking"];
  interaction: ReturnType<typeof useRewards>["interaction"];
  pendingStaking: bigint;
  pendingInteraction: bigint;
  interactionWaiting: boolean;
  stakingPoolPct: number;
  interactionPoolPct: number;
  canTx: boolean;
  claiming: boolean;
  chainName: string;
  onClaim: () => void;
}

/**
 * Combined Claim Rewards card (WebsiteReadme §89-93). Shows the breakdown
 * of staking + interaction pending amounts, the total VPFI that will be
 * minted, the chain it will land on, and a single prominent claim CTA.
 * Interaction is excluded from the total whenever its day is waiting for
 * the cross-chain denominator broadcast — the card still calls this out
 * so the user understands why the total is lower than the breakdown row
 * suggests.
 */
function ClaimRewardsCard({
  staking,
  interaction,
  pendingStaking,
  pendingInteraction,
  interactionWaiting,
  stakingPoolPct,
  interactionPoolPct,
  canTx,
  claiming,
  chainName,
  onClaim,
}: ClaimRewardsCardProps) {
  const interactionClaimable =
    !interactionWaiting && pendingInteraction > 0n ? pendingInteraction : 0n;
  const totalClaimable = pendingStaking + interactionClaimable;
  const nothingToClaim = totalClaimable === 0n;
  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Coins size={20} style={{ color: "var(--brand)" }} />
        <h2 style={{ margin: 0 }}>Claim Rewards</h2>
      </div>
      <p className="stat-label" style={{ marginTop: 0 }}>
        Minted directly on <strong>{chainName}</strong> — no bridging or chain
        switch required.
      </p>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 12,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 10,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <Coins size={14} style={{ color: "var(--text-secondary)" }} />
              Staking rewards
            </div>
            <div className="stat-label" style={{ fontSize: 11 }}>
              {staking ? `${staking.aprBps / 100}% APR` : "—"} · pool{" "}
              {stakingPoolPct.toFixed(2)}% paid out
            </div>
          </div>
          <div
            className="mono"
            style={{
              fontWeight: 600,
              color:
                pendingStaking > 0n
                  ? "var(--accent-green)"
                  : "var(--text-secondary)",
            }}
          >
            {formatVpfi(pendingStaking).toFixed(6)} VPFI
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <TrendingUp
                size={14}
                style={{ color: "var(--text-secondary)" }}
              />
              Interaction rewards
            </div>
            <div className="stat-label" style={{ fontSize: 11 }}>
              {interaction ? `${interaction.aprBps / 100}% APR` : "—"} · pool{" "}
              {interactionPoolPct.toFixed(2)}% paid out
              {interaction && interaction.previewToDay > 0n && (
                <>
                  {" "}
                  · days {interaction.previewFromDay.toString()}–
                  {interaction.previewToDay.toString()}
                </>
              )}
            </div>
          </div>
          <div
            className="mono"
            style={{
              fontWeight: 600,
              color: interactionWaiting
                ? "var(--accent-yellow)"
                : pendingInteraction > 0n
                  ? "var(--accent-green)"
                  : "var(--text-secondary)",
            }}
          >
            {interactionWaiting
              ? "waiting"
              : `${formatVpfi(pendingInteraction).toFixed(6)} VPFI`}
          </div>
        </div>
      </div>

      {interactionWaiting && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 10,
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "rgba(234, 179, 8, 0.06)",
            alignItems: "flex-start",
          }}
        >
          <AlertTriangle
            size={16}
            style={{
              color: "var(--accent-yellow)",
              flexShrink: 0,
              marginTop: 2,
            }}
          />
          <div className="stat-label" style={{ margin: 0, fontSize: 12 }}>
            Day {interaction!.waitingForDay.toString()} is waiting for the
            cross-chain reward aggregator to finalize and broadcast its global
            denominator into this chain. Interaction rewards unlock
            automatically once the broadcast lands — staking rewards can still
            be claimed now.
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="stat-label" style={{ margin: 0, fontWeight: 600 }}>
          Total to mint
        </span>
        <span
          className="mono"
          style={{
            fontWeight: 700,
            fontSize: 18,
            color:
              totalClaimable > 0n
                ? "var(--accent-green)"
                : "var(--text-secondary)",
          }}
        >
          {formatVpfi(totalClaimable).toFixed(6)} VPFI
        </span>
      </div>

      <button
        className="btn btn-primary"
        style={{ width: "100%" }}
        disabled={!canTx || nothingToClaim || claiming}
        onClick={onClaim}
      >
        {claiming
          ? "Claiming…"
          : nothingToClaim
            ? `No rewards available to claim on ${chainName}`
            : `Claim ${formatVpfi(totalClaimable).toFixed(6)} VPFI`}
      </button>
    </div>
  );
}

interface UnstakeReviewProps {
  /** Amount (18-dec) the user is about to unstake. */
  amount: bigint;
  /** Current escrow balance (18-dec) — used to derive the post-unstake tier. */
  userStaked: bigint;
  /** Staking APR in basis points (e.g. 500 = 5%). */
  aprBps: number;
  /** True while the withdraw tx is in flight; locks the buttons. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Unstake review / confirmation step. Spec (WebsiteReadme §110-116, §120-124)
 * requires showing (1) the amount being unstaked, (2) impact on the current
 * discount tier, (3) impact on future 5% APR staking rewards, plus a generic
 * warning about active loans that rely on escrowed VPFI for fee-discount
 * eligibility. All reads are derived locally from the user's current staked
 * balance and the tier table — no extra on-chain call required.
 */
function UnstakeReview({
  amount,
  userStaked,
  aprBps,
  busy,
  onCancel,
  onConfirm,
}: UnstakeReviewProps) {
  const after = amount >= userStaked ? 0n : userStaked - amount;
  const currentVpfiUnits = formatVpfi(userStaked);
  const afterVpfiUnits = formatVpfi(after);
  const currentTier = tierForVpfiUnits(currentVpfiUnits);
  const afterTier = tierForVpfiUnits(afterVpfiUnits);
  const aprPct = aprBps / 100;
  // Staking APR is a flat rate on the escrow balance, so annual VPFI scales
  // linearly with the post-unstake balance.
  const currentAnnual = (currentVpfiUnits * aprPct) / 100;
  const afterAnnual = (afterVpfiUnits * aprPct) / 100;
  const tierLoss = afterTier < currentTier;
  return (
    <div
      style={{
        marginTop: 14,
        borderTop: "1px solid var(--border)",
        paddingTop: 14,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Review unstake</div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div className="stat-label">Amount</div>
          <div style={{ fontWeight: 600 }}>
            {formatVpfi(amount).toFixed(4)} VPFI
          </div>
        </div>
        <div>
          <div className="stat-label">Escrow after</div>
          <div style={{ fontWeight: 600 }}>
            {afterVpfiUnits.toFixed(4)} VPFI
          </div>
        </div>
        <div>
          <div className="stat-label">Discount tier</div>
          <div
            style={{
              fontWeight: 600,
              color: tierLoss ? "var(--accent-red)" : "var(--text-primary)",
            }}
          >
            Tier {currentTier} → Tier {afterTier}
            {tierLoss && <span style={{ marginLeft: 6 }}>▼</span>}
          </div>
        </div>
        <div>
          <div className="stat-label">Annual staking ({aprPct}% APR)</div>
          <div style={{ fontWeight: 600 }}>
            {currentAnnual.toFixed(4)} → {afterAnnual.toFixed(4)} VPFI/yr
          </div>
        </div>
      </div>

      {tierLoss && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: 10,
            marginBottom: 10,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "rgba(234, 179, 8, 0.06)",
            alignItems: "flex-start",
          }}
        >
          <AlertTriangle
            size={16}
            style={{
              color: "var(--accent-yellow)",
              flexShrink: 0,
              marginTop: 2,
            }}
          />
          <div className="stat-label" style={{ margin: 0, fontSize: 12 }}>
            Your discount tier will drop from Tier {currentTier} to Tier{" "}
            {afterTier} as soon as this unstake confirms. Any active loans that
            currently rely on escrowed VPFI for fee-discount eligibility will
            stop receiving the Tier {currentTier} discount immediately.
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 10,
          marginBottom: 14,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "rgba(239, 68, 68, 0.05)",
          alignItems: "flex-start",
        }}
      >
        <AlertTriangle
          size={16}
          style={{
            color: "var(--accent-red)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div className="stat-label" style={{ margin: 0, fontSize: 12 }}>
          Unstaking is instant and has no lock-up. If you have the shared{" "}
          <strong>Use VPFI for fee discount</strong> consent enabled, future fee
          discounts may be reduced or disabled until you top up escrow.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Unstaking…" : "Confirm unstake"}
        </button>
      </div>
    </div>
  );
}
