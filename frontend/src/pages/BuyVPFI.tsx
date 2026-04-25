import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { parseEther, formatEther } from "viem";
import {
  DIAMOND_ABI_VIEM as DIAMOND_ABI,
  VPFIBuyAdapterABI,
} from "../contracts/abis";
import { SimulationPreview } from "../components/app/SimulationPreview";
import {
  Coins,
  Wallet,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Info,
} from "lucide-react";
import { useWallet } from "../context/WalletContext";
import {
  useDiamondContract,
  useReadChain,
  useCanWrite,
} from "../contracts/useDiamond";
import { useUserVPFI } from "../hooks/useUserVPFI";
import {
  useVPFIDiscount,
  useEscrowVPFIBalance,
  useVPFIDiscountTier,
  useVPFIDiscountConsent,
  VPFI_TIER_TABLE,
  ethWeiToVpfi,
  formatVpfiUnits,
} from "../hooks/useVPFIDiscount";
import { useVPFIBuyBridge } from "../hooks/useVPFIBuyBridge";
import { usePermit2Signing } from "../hooks/usePermit2Signing";
import { getCanonicalVPFIChain, type ChainConfig } from "../contracts/config";
import { decodeContractError } from "../lib/decodeContractError";
import { beginStep } from "../lib/journeyLog";
import { ReportIssueLink } from "../components/app/ReportIssueLink";
import "./Dashboard.css";

/**
 * Linear state machine for the Buy → Deposit flow.
 *
 * - `idle`              - Input stage; the user has not submitted anything yet.
 * - `buying`            - A canonical-chain `buyVPFIWithETH` tx is pending.
 * - `approving-deposit` - ERC20 `approve` tx to the diamond is pending.
 * - `depositing`        - `depositVPFIToEscrow` tx is pending.
 * - `unstaking`         - A `withdrawVPFIFromEscrow` tx is pending.
 * - `success`           - The last tx confirmed; banner is shown.
 */
type Step =
  | "idle"
  | "buying"
  | "approving-deposit"
  | "depositing"
  | "unstaking"
  | "success";

interface FlowBannerProps {
  /** Current flow state; the banner only renders when `step === 'success'`. */
  step: Step;
  /** Hash of the last confirmed transaction to deep-link in the explorer. */
  txHash: string | null;
  /** Chain-specific explorer base URL (`/tx/<hash>` is appended). */
  blockExplorer: string;
  /** Dismiss handler that clears both the banner and the recorded hash. */
  onReset: () => void;
}

interface BridgeLandedInfo {
  /** Delivered VPFI amount in wei-units (null if we don't know the exact
   *  amount — e.g. balance-based detection where we only know it increased). */
  vpfiOut: bigint | null;
  /** Origin-chain tx that kicked off the bridged buy, if known. */
  txHash: string | null;
  /** LayerZero GUID for the outbound message, if known. */
  lzGuid: string | null;
  /** Source of the signal — `'adapter'` means the adapter's `pendingBuys`
   *  poll returned `RESOLVED_SUCCESS`; `'balance'` means we inferred the
   *  arrival by watching the user's VPFI balance (fallback path for when
   *  the adapter status lags behind the OFT delivery). */
  source: "adapter" | "balance";
}

interface BridgeLandedBannerProps {
  /** Resolved landed info; when null, the banner renders nothing. */
  landed: BridgeLandedInfo | null;
  originChain: ChainConfig;
  onDismiss: () => void;
  onAddToWallet: () => void | Promise<void>;
  /** True when the VPFI token address is known and the button should render. */
  canAddToWallet: boolean;
}

/**
 * Prominent confirmation banner that fires once the bridged buy completes
 * and VPFI has landed in the user's wallet. Two independent signals drive
 * it: the adapter's poll resolving to `RESOLVED_SUCCESS`, or — as a
 * fallback — the user's VPFI wallet balance increasing by the expected
 * amount. The latter covers cases where the LZ OFT delivers the tokens
 * before the adapter's status propagates (or the adapter polling misses
 * the transition for an RPC reason).
 */
function BridgeLandedBanner({
  landed,
  originChain,
  onDismiss,
  onAddToWallet,
  canAddToWallet,
}: BridgeLandedBannerProps) {
  if (landed == null) return null;
  return (
    <div
      className="card"
      style={{
        marginBottom: 20,
        borderColor: "var(--accent-green)",
        background: "rgba(16, 185, 129, 0.08)",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <CheckCircle
          size={22}
          style={{ color: "var(--accent-green)", flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {landed.vpfiOut != null
              ? `${formatAmount(formatVpfiUnits(landed.vpfiOut))} VPFI delivered to your wallet on ${originChain.name}`
              : `VPFI delivered to your wallet on ${originChain.name}`}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            Deposit it to your escrow below to unlock the borrower fee discount.
            You can also import the token into MetaMask so your wallet UI tracks
            the balance.
          </p>
          {(landed.txHash || landed.lzGuid) && (
            <p
              className="stat-label"
              style={{
                margin: "8px 0 0",
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              {landed.txHash && (
                <a
                  href={`${originChain.blockExplorer}/tx/${landed.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: "var(--brand)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  Origin tx <ExternalLink size={12} />
                </a>
              )}
              {landed.lzGuid && (
                <a
                  href={`https://layerzeroscan.com/tx/${landed.lzGuid}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: "var(--brand)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  LayerZero trace <ExternalLink size={12} />
                </a>
              )}
            </p>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          {canAddToWallet && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onAddToWallet}
              style={{ gap: 8 }}
            >
              <Wallet size={14} />
              Add VPFI to MetaMask
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** Success confirmation banner shown after a buy or deposit tx confirms. */
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
 * Two-step user flow for acquiring VPFI and funding the escrow that unlocks
 * the borrower fee discount:
 *
 *   1. **Buy** VPFI at the protocol's fixed ETH rate from the user's
 *      preferred supported chain — never a manual chain-switch flow (spec
 *      §8a). On the canonical chain the page calls `buyVPFIWithETH` on the
 *      Diamond directly; on every other supported chain the buy routes
 *      through `VPFIBuyAdapter` + LayerZero and VPFI lands back in the
 *      user's wallet on the same chain they're connected to.
 *   2. **Deposit** VPFI into the user's personal escrow on the *lending*
 *      chain. Always an explicit user action — the protocol never auto-funds
 *      escrow after a buy.
 *
 * Per-step pending states are surfaced via the {@link Step} state machine so
 * the button labels and disable logic stay consistent across the flow.
 */
// Buffer kept aside from the wallet's ETH balance when computing the
// "Use max" amount — covers the gas for the buy tx itself (and, on the
// bridged path, the approve leg when the adapter is in WETH mode). Picked
// conservatively for Sepolia / Base Sepolia / mainnet-at-low-gas. The
// user can override by typing a larger number; the on-chain revert is the
// final backstop.
const ETH_GAS_RESERVE_WEI = 5_000_000_000_000_000n; // 0.005 ETH

const VPFI_APPROVE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]) as unknown as Abi;

export default function BuyVPFI() {
  const {
    address,
    activeChain,
    isCorrectChain,
    switchToDefaultChain,
  } = useWallet();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const readChain = useReadChain();
  const diamond = useDiamondContract();
  const { sign: permit2Sign, canSign: permit2CanSign } = usePermit2Signing();
  // Combined wallet+override guard: a write is safe only when the wallet's
  // chain actually matches the dashboard's view-chain override (if any).
  // Using isCorrectChain alone lets clicks fire while useDiamondContract()
  // has silently fallen back to a read-only provider.
  const canWrite = useCanWrite();
  const canonical = getCanonicalVPFIChain();
  // Fixed-rate config (weiPerVpfi, caps, enabled) is stored only on the
  // canonical chain's Diamond, so a user connected to a mirror chain must
  // read from canonical — otherwise `weiPerVpfi` comes back 0 and the
  // bridged-buy card falsely renders "not yet configured on {canonical}".
  const isOnCanonical = readChain.isCanonicalVPFI;
  const {
    config: buyConfig,
    loading: configLoading,
    reload: reloadConfig,
  } = useVPFIDiscount(isOnCanonical ? null : canonical);
  const { snapshot: userVpfi, reload: reloadUserVpfi } = useUserVPFI(address);
  const { balance: escrowBal, reload: reloadEscrow } =
    useEscrowVPFIBalance(address);
  const { data: discountTier } = useVPFIDiscountTier(address);
  const { enabled: consentEnabled } = useVPFIDiscountConsent();
  const bridge = useVPFIBuyBridge(
    activeChain && isCorrectChain ? activeChain : null,
  );

  const [ethInput, setEthInput] = useState<string>("");
  const [depositInput, setDepositInput] = useState<string>("");
  const [unstakeInput, setUnstakeInput] = useState<string>("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Native ETH balance of the connected wallet on the active chain. Drives
  // the "Use max" affordance and the "exceeds balance" warning on both buy
  // cards. Re-read after any confirmed buy/deposit tx (handlers below call
  // `reloadEthBalance`).
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const reloadEthBalance = useCallback(async () => {
    if (!publicClient || !address) {
      setEthBalance(null);
      return;
    }
    try {
      const bal = await publicClient.getBalance({
        address: address as Address,
      });
      setEthBalance(bal);
    } catch {
      setEthBalance(null);
    }
  }, [publicClient, address]);
  useEffect(() => {
    void reloadEthBalance();
  }, [reloadEthBalance]);
  // Re-entry guard for the deposit flow. `step` alone can't prevent a
  // double-click: between the click and the first `setStep` call the handler
  // is already awaiting an `allowance()` RPC read (can take seconds), and
  // React state updates don't reflect back into the closed-over value until
  // the next render. A ref flips synchronously so a second click during
  // that window no-ops instead of firing a second approve tx.
  const depositInFlight = useRef(false);
  // Same guard for the canonical & bridged buy paths. `setStep("buying")`
  // is async so a rapid double-click can fire two `buyVPFIWithETH` txs, and
  // the bridged variant has an async `quote()` before its first setState.
  const buyInFlight = useRef(false);

  // When the bridged buy lands VPFI on the user's wallet, reload downstream
  // balances so the deposit card reflects the newly received amount.
  useEffect(() => {
    if (bridge.state.status === "landed") {
      reloadUserVpfi();
      reloadEscrow();
      void reloadEthBalance();
    }
  }, [bridge.state.status, reloadUserVpfi, reloadEscrow, reloadEthBalance]);
  // `walletVpfi === null` means the snapshot hasn't loaded yet — distinct
  // from a resolved balance of 0. Downstream UI uses the null to show "—"
  // instead of a phantom zero while the fetch is in flight.
  const walletVpfi = userVpfi ? userVpfi.balance : null;
  const tokenAddr = userVpfi?.token ?? null;
  const tokenRegistered = !!userVpfi?.registered;

  // --- Bridged-buy arrival detection ---
  //
  // We can't rely solely on `bridge.state.status === 'landed'` to show the
  // confirmation banner: that transition requires the adapter's
  // `pendingBuys(requestId)` to flip to `RESOLVED_SUCCESS`, which can lag
  // the actual OFT delivery (or be missed entirely by the poll loop under
  // RPC flake). As a backup signal, we snapshot the user's VPFI balance at
  // submit time plus the expected delivery amount, poll userVpfi while
  // pending, and fire a "balance-detected" landing when the wallet crosses
  // the threshold. Both signals surface through the same banner.
  interface BridgedExpectation {
    expectedVpfi: bigint; // wei-scaled VPFI we told the bridge to deliver
    baselineBalanceUnits: number; // wallet VPFI (display units) pre-submit
  }
  const [bridgedExpectation, setBridgedExpectation] =
    useState<BridgedExpectation | null>(null);
  const [balanceDetectedLanding, setBalanceDetectedLanding] =
    useState<BridgeLandedInfo | null>(null);

  // Poll userVpfi while the bridge is pending so balance-based detection
  // has fresh data to compare against. Otherwise balance only refreshes
  // on tab revisit / manual reload, and we'd miss the arrival.
  useEffect(() => {
    if (bridge.state.status !== "pending") return;
    const id = setInterval(() => void reloadUserVpfi(), 20_000);
    return () => clearInterval(id);
  }, [bridge.state.status, reloadUserVpfi]);

  // Balance-arrival detection. Fires once per bridged buy; clears with
  // the expectation when the user dismisses or starts a new buy.
  useEffect(() => {
    if (!bridgedExpectation || balanceDetectedLanding || walletVpfi == null) {
      return;
    }
    const expectedUnits = Number(bridgedExpectation.expectedVpfi) / 1e18;
    // Require at least 95% of expected to arrive (guards against bridge
    // fees / rounding that nibble a bit off the delivered amount).
    const threshold =
      bridgedExpectation.baselineBalanceUnits + expectedUnits * 0.95;
    if (walletVpfi >= threshold) {
      setBalanceDetectedLanding({
        vpfiOut: bridgedExpectation.expectedVpfi,
        txHash: bridge.state.txHash,
        lzGuid: bridge.state.lzGuid,
        source: "balance",
      });
      void reloadEscrow();
      void reloadEthBalance();
      // Stop the pending / countdown status strip now that we've
      // confirmed arrival via balance — otherwise the "VPFI is on its
      // way back to your wallet" banner keeps showing alongside the
      // delivered-confirmation banner until the adapter poll catches up
      // (which may never happen if the poll has drifted). We already
      // captured `txHash` / `lzGuid` above, so resetting the bridge
      // state here doesn't drop any info the landed banner needs.
      if (bridge.state.status === "pending") {
        bridge.reset();
      }
    }
  }, [
    walletVpfi,
    bridgedExpectation,
    balanceDetectedLanding,
    bridge,
    reloadEscrow,
    reloadEthBalance,
  ]);

  // Unified landed info driving the confirmation banner. Prefer the
  // adapter-resolved signal (exact `vpfiOut` decoded from event) when
  // present, fall back to the balance-detected path otherwise.
  const landedInfo: BridgeLandedInfo | null =
    bridge.state.status === "landed"
      ? {
          vpfiOut: bridge.state.vpfiOut,
          txHash: bridge.state.txHash,
          lzGuid: bridge.state.lzGuid,
          source: "adapter",
        }
      : balanceDetectedLanding;

  const dismissLandedBanner = useCallback(() => {
    setBalanceDetectedLanding(null);
    setBridgedExpectation(null);
    if (bridge.state.status === "landed") bridge.reset();
  }, [bridge]);

  // Quote — how much VPFI the user gets for the entered ETH at the fixed rate.
  const quote = useMemo(() => {
    if (!buyConfig || buyConfig.weiPerVpfi === 0n) return null;
    const raw = (ethInput ?? "").trim();
    if (!raw) return null;
    let ethWei: bigint;
    try {
      ethWei = parseEther(raw);
    } catch {
      return null;
    }
    if (ethWei === 0n) return null;
    const vpfi = ethWeiToVpfi(ethWei, buyConfig.weiPerVpfi);
    return { ethWei, vpfi };
  }, [ethInput, buyConfig]);

  const capExceeded = (() => {
    if (!buyConfig || !quote) return false;
    if (quote.vpfi > buyConfig.globalHeadroom) return true;
    if (quote.vpfi > buyConfig.walletHeadroom) return true;
    return false;
  })();

  const handleBuy = async () => {
    if (buyInFlight.current) return;
    if (!canWrite || !quote) return;
    buyInFlight.current = true;
    setError(null);
    setTxHash(null);
    setStep("buying");
    const s = beginStep({
      area: "vpfi-buy",
      flow: "buyVPFIWithETH",
      step: "submit",
    });
    try {
      const tx = await (
        diamond as unknown as {
          buyVPFIWithETH: (opts: {
            value: bigint;
          }) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).buyVPFIWithETH({ value: quote.ethWei });
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      s.success({ note: `bought ${quote.vpfi} VPFI for ${quote.ethWei} wei` });
      setEthInput("");
      await Promise.all([
        reloadConfig(),
        reloadUserVpfi(),
        reloadEscrow(),
        reloadEthBalance(),
      ]);
    } catch (err) {
      setError(decodeContractError(err, "Buy failed"));
      setStep("idle");
      s.failure(err);
    } finally {
      buyInFlight.current = false;
    }
  };

  // Wraps bridge.buy to add the same re-entry guard we apply on the
  // canonical-chain path. The bridge hook's internal state transitions
  // happen across async awaits, so leaving the button enabled during that
  // window can fire two LayerZero sends.
  const handleBridgedBuy = async () => {
    if (buyInFlight.current) return;
    if (!quote) return;
    buyInFlight.current = true;
    // Capture the baseline balance + expected delivery so we can detect
    // arrival by a wallet-balance increase even if the adapter poll
    // misses the transition.
    setBalanceDetectedLanding(null);
    setBridgedExpectation({
      expectedVpfi: quote.vpfi,
      baselineBalanceUnits: walletVpfi ?? 0,
    });
    try {
      await bridge.buy(quote.ethWei, quote.vpfi);
    } finally {
      buyInFlight.current = false;
    }
  };

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
      flow: "depositVPFIToEscrow",
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
              depositVPFIToEscrowWithPermit: (
                amount: bigint,
                permit: unknown,
                signature: Hex,
              ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
            }
          ).depositVPFIToEscrowWithPermit(depositWei, permit, signature);
          setTxHash(tx.hash);
          await tx.wait();
          setStep("success");
          s.success({ note: `deposited ${depositWei} via Permit2` });
          setDepositInput("");
          await Promise.all([
            reloadUserVpfi(),
            reloadEscrow(),
            reloadEthBalance(),
          ]);
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
          depositVPFIToEscrow: (
            amount: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).depositVPFIToEscrow(depositWei);
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      s.success({ note: `deposited ${depositWei}` });
      setDepositInput("");
      await Promise.all([reloadUserVpfi(), reloadEscrow(), reloadEthBalance()]);
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
    if (escrowBal != null && unstakeWei > escrowBal) {
      setError("Unstake amount exceeds your escrow balance.");
      return;
    }

    unstakeInFlight.current = true;
    setStep("unstaking");
    const s = beginStep({
      area: "vpfi-buy",
      flow: "withdrawVPFIFromEscrow",
      step: "submit",
    });
    try {
      const tx = await (
        diamond as unknown as {
          withdrawVPFIFromEscrow: (
            amount: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).withdrawVPFIFromEscrow(unstakeWei);
      setTxHash(tx.hash);
      await tx.wait();
      setStep("success");
      s.success({ note: `unstaked ${unstakeWei}` });
      setUnstakeInput("");
      await Promise.all([reloadUserVpfi(), reloadEscrow(), reloadEthBalance()]);
    } catch (err) {
      setError(decodeContractError(err, "Unstake failed"));
      setStep("idle");
      s.failure(err);
    } finally {
      unstakeInFlight.current = false;
    }
  };

  // Ask the connected wallet (MetaMask et al) to track the VPFI ERC-20 so
  // the user can see their balance in the wallet UI without manually
  // importing the token. wallet_watchAsset is an EIP-747 standard request —
  // MetaMask, Rabby, and most other injected wallets support it; others
  // simply reject the request, which we swallow as a user-cancelled action.
  const handleAddVPFIToWallet = async () => {
    if (!tokenAddr) return;
    const eth = (
      window as unknown as {
        ethereum?: {
          request: (args: {
            method: string;
            params: Record<string, unknown>;
          }) => Promise<unknown>;
        };
      }
    ).ethereum;
    if (!eth?.request) return;
    const step = beginStep({
      area: "vpfi-buy",
      flow: "watchAsset",
      step: "submit",
    });
    try {
      await eth.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: tokenAddr,
            symbol: "VPFI",
            decimals: 18,
          },
        },
      });
      step.success({ note: `tracked ${tokenAddr}` });
    } catch (err) {
      // User dismissed the prompt or the wallet rejected — no surface action.
      step.failure(err);
    }
  };

  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>Connect Your Wallet</h3>
        <p>Connect your wallet to buy VPFI and unlock the tiered discount.</p>
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
        <h3>Unsupported network</h3>
        <p style={{ maxWidth: 520 }}>
          Buy VPFI is available on any supported Vaipakam chain. Your wallet is
          currently on{" "}
          <strong>{activeChain?.name ?? "an unsupported network"}</strong>,
          which does not host a Vaipakam Diamond. Switch to a supported chain to
          continue — no canonical-chain switch is required once you are on any
          supported chain.
        </p>
        <button
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          onClick={() => {
            void switchToDefaultChain();
          }}
        >
          Switch network
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
          Buy VPFI
        </h1>
        <p className="page-subtitle">
          Purchase VPFI at the fixed early-stage rate using ETH and deposit into
          your escrow to unlock the tiered discount on liquid loans.
        </p>
      </div>

      <FlowBanner
        step={step}
        txHash={txHash}
        blockExplorer={activeChain?.blockExplorer ?? canonical.blockExplorer}
        onReset={() => {
          setStep("idle");
          setTxHash(null);
        }}
      />

      {/* Prominent "landed" banner for the bridged buy path. The canonical
          buy's FlowBanner fires on the tx `step === 'success'`; the bridged
          path has no such step (the wait is on the LZ round-trip, not a
          local tx), so it needs its own banner driven by bridge state. */}
      <BridgeLandedBanner
        landed={landedInfo}
        originChain={activeChain ?? readChain}
        onDismiss={dismissLandedBanner}
        onAddToWallet={handleAddVPFIToWallet}
        canAddToWallet={!!tokenRegistered && !!tokenAddr}
      />

      <DiscountStatusCard
        tier={discountTier?.tier ?? 0}
        escrowVpfi={escrowBal}
        discountBps={discountTier?.discountBps ?? 0}
        consentEnabled={consentEnabled}
      />

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

      {/* Step 1 — buy VPFI from the user's preferred chain. Canonical chain
           calls the Diamond directly; every other chain routes through the
           VPFIBuyAdapter + LayerZero round-trip, with VPFI delivered back
           to the user's wallet on the same chain they're connected to. The
           page never asks the user to switch chains (spec §8a). */}
      <div className="card" style={{ marginBottom: 20 }}>
        <StepHeader
          index={1}
          title="Buy VPFI with ETH"
          subtitle={
            isOnCanonical
              ? `Direct on ${canonical.name}. VPFI lands in your wallet on this chain.`
              : bridge.available
                ? `Direct from ${activeChain?.name ?? "this chain"} — any cross-chain routing is handled for you. VPFI lands in your wallet on this chain.`
                : `The buy adapter is being deployed to ${activeChain?.name ?? "this chain"}. You can continue here — no chain switch required.`
          }
        />

        {isOnCanonical ? (
          <BuyCard
            buyConfig={buyConfig}
            configLoading={configLoading}
            ethInput={ethInput}
            setEthInput={setEthInput}
            quote={quote}
            capExceeded={capExceeded}
            ethBalance={ethBalance}
            isBuying={step === "buying"}
            onBuy={handleBuy}
            canonical={canonical}
          />
        ) : bridge.available ? (
          <BridgedBuyCard
            buyConfig={buyConfig}
            configLoading={configLoading}
            ethInput={ethInput}
            setEthInput={setEthInput}
            quote={quote}
            capExceeded={capExceeded}
            ethBalance={ethBalance}
            bridge={bridge}
            onBuy={handleBridgedBuy}
            originChain={activeChain ?? readChain}
            canonical={canonical}
          />
        ) : (
          <div style={{ padding: "12px 0" }}>
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                background: "rgba(59, 130, 246, 0.06)",
                border: "1px solid rgba(59, 130, 246, 0.25)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <Info
                size={18}
                style={{
                  color: "var(--brand)",
                  flexShrink: 0,
                  marginTop: 2,
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Buy adapter rollout pending on{" "}
                  {activeChain?.name ?? "this chain"}
                </div>
                <p className="stat-label" style={{ margin: 0 }}>
                  The fixed-rate buy is being wired up on{" "}
                  {activeChain?.name ?? "this chain"} and will be live shortly.
                  Per spec, the purchase will run directly from this chain — no
                  wallet-level chain switch required. Please check back soon.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Step 2 — deposit to escrow on the lending chain (always explicit) */}
      <div className="card" style={{ marginBottom: 20 }}>
        <StepHeader
          index={2}
          title="Deposit VPFI into your escrow"
          subtitle="Required on every chain — including the canonical one."
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
            Per spec, moving VPFI into escrow is always an explicit user action.
            The protocol never auto-funds escrow after a buy or bridge.
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
            label={`Escrow VPFI balance (${activeChain?.name ?? readChain.name})`}
            value={
              escrowBal == null ? "—" : formatAmount(formatVpfiUnits(escrowBal))
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
              // `depositVPFIToEscrow(amount)` calldata. Even when the
              // submit handler picks the Permit2 single-sig variant,
              // the underlying state change Blockaid scans (VPFI from
              // wallet → escrow) is identical, and the classic path
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
                  functionName: "depositVPFIToEscrow",
                  args: [amountWei],
                }) as Hex,
                value: 0n,
              };
            })()}
          />
        )}
      </div>

      {/* Unstake — pull VPFI back out of escrow into the wallet. Pairs with
          Step 2 (Deposit): same token, same chain, opposite direction.
          No approve leg because the Diamond owns the escrow and debits
          itself on `withdrawVPFIFromEscrow`. Reducing the escrow balance
          may drop the borrower's discount tier — surface that in the
          explainer instead of blocking the action. */}
      {tokenRegistered && (
        <div className="card" style={{ marginBottom: 20 }}>
          <StepHeader
            index={3}
            title="Unstake VPFI from your escrow"
            subtitle={`Transfer VPFI from your escrow back to your wallet on ${activeChain?.name ?? readChain.name}. Reduces your discount tier if it drops your escrow balance below a threshold.`}
          />
          <UnstakeCard
            value={unstakeInput}
            onChange={setUnstakeInput}
            escrowBalance={escrowBal}
            pending={step === "unstaking"}
            step={step}
            onUnstake={handleUnstake}
          />
        </div>
      )}
    </div>
  );
}

interface StepHeaderProps {
  /** Step number displayed in the circled badge (1-indexed). */
  index: number;
  /** Step's large heading. */
  title: string;
  /** Supporting copy below the title. */
  subtitle: string;
}

/** Numbered-step header used as the card title for each stage in the flow. */
function StepHeader({ index, title, subtitle }: StepHeaderProps) {
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
        <div className="card-title" style={{ marginBottom: 0 }}>
          {title}
        </div>
      </div>
      <p className="stat-label" style={{ margin: 0, paddingLeft: 36 }}>
        {subtitle}
      </p>
    </div>
  );
}

interface StatProps {
  /** Caption shown below the value. */
  label: string;
  /** Pre-formatted display value (caller controls units / precision). */
  value: string;
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
  /** Escrow VPFI balance (18-dec) on the active chain; null = not loaded yet. */
  escrowVpfi: bigint | null;
  /** Discount bps associated with the current tier (e.g. 1000 = 10%). */
  discountBps: number;
  /** Platform-level consent flag; null while loading, false = opted out. */
  consentEnabled: boolean | null;
}

/**
 * Surfaces the borrower's active VPFI fee-discount status directly on the Buy
 * page so the user can see, before buying, (a) the tier they sit in today,
 * (b) what the next tier requires, (c) whether the platform-level consent
 * switch is on, and (d) that escrow-held VPFI doubles as staked (5% APR).
 *
 * Spec: TokenomicsTechSpec.md §6 (tier table, consent, liquid assets only)
 * and §8a (escrow = staked). Consent is read-only here — the toggle itself
 * lives on the Dashboard per spec.
 */
function DiscountStatusCard({
  tier,
  escrowVpfi,
  discountBps,
  consentEnabled,
}: DiscountStatusCardProps) {
  const escrowUnits = formatVpfiUnits(escrowVpfi);
  const nextTier = VPFI_TIER_TABLE.find((t) => t.tier === tier + 1) ?? null;
  const gapToNext = nextTier ? Math.max(0, nextTier.minVpfi - escrowUnits) : 0;
  const currentTierRow =
    tier > 0 ? (VPFI_TIER_TABLE.find((t) => t.tier === tier) ?? null) : null;

  let qualificationLabel: string;
  let qualificationColor: string;
  if (consentEnabled === false) {
    qualificationLabel = "Inactive · discount consent OFF";
    qualificationColor = "var(--accent-yellow)";
  } else if (tier === 0) {
    qualificationLabel = "Inactive · below Tier 1 (100 VPFI in escrow)";
    qualificationColor = "var(--text-secondary)";
  } else {
    qualificationLabel = `Active · Tier ${tier} discount (${discountBps / 100}%)`;
    qualificationColor = "var(--accent-green)";
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title" style={{ marginBottom: 12 }}>
        Your VPFI discount status
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
          <div className="stat-label">Current tier</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {tier === 0 ? "—" : `Tier ${tier}`}
          </div>
          <div className="stat-label" style={{ fontSize: 11 }}>
            {currentTierRow ? currentTierRow.discountLabel : "No discount yet"}
          </div>
        </div>
        <div>
          <div className="stat-label">Escrow VPFI </div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {escrowVpfi == null ? "—" : escrowUnits.toFixed(4)}
          </div>
          <div className="stat-label" style={{ fontSize: 11 }}>
            Escrow VPFI counts as staked (5% APR)
          </div>
        </div>
        <div>
          <div className="stat-label">Status</div>
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
              <>
                Enable the shared discount consent on{" "}
                <Link to="/app" style={{ color: "var(--brand)" }}>
                  Dashboard
                </Link>
                .
              </>
            ) : (
              "Liquid lending assets only."
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
              <>
                Deposit <strong>{gapToNext.toFixed(2)} more VPFI</strong> into
                escrow to reach <strong>{nextTier.label}</strong> (
                {nextTier.discountLabel}).
              </>
            ) : (
              <>
                Your escrow balance qualifies for{" "}
                <strong>{nextTier.label}</strong> on your next loan. Ensure the
                discount consent is enabled on Dashboard.
              </>
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
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Tier</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>
                Escrow VPFI
              </th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Discount</th>
            </tr>
          </thead>
          <tbody>
            {VPFI_TIER_TABLE.map((row) => {
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
                      ? `> ${(row.minVpfi - 0.000001).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      : `${row.minVpfi.toLocaleString()} – ${row.maxVpfi.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
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

interface BuyCardProps {
  /** On-chain buy config (rate, caps, enabled flag); null while loading. */
  buyConfig: ReturnType<typeof useVPFIDiscount>["config"];
  /** True while the initial config fetch is in flight. */
  configLoading: boolean;
  /** ETH amount the user has typed (raw input string). */
  ethInput: string;
  /** Setter for `ethInput` — keeps the raw string to preserve leading zeros. */
  setEthInput: (v: string) => void;
  /** Live quote derived from `ethInput`; null when input is empty or invalid. */
  quote: { ethWei: bigint; vpfi: bigint } | null;
  /** True when the quote would exceed the global or per-wallet cap. */
  capExceeded: boolean;
  /** Wallet's native ETH balance (18-dec); null while loading. Drives the
   *  "Use max" button and the "exceeds balance" warning. */
  ethBalance: bigint | null;
  /** True while the `buyVPFIWithETH` tx is pending. */
  isBuying: boolean;
  /** Submit handler for the Buy button. */
  onBuy: () => void;
  /** Canonical chain metadata (used only for user-facing copy). */
  canonical: ChainConfig;
}

/**
 * Buy card rendered when the wallet is connected to the canonical chain.
 * Renders placeholder/idle states (loading, missing config, paused, unset
 * rate) so the caller doesn't need to branch on those conditions.
 */
function BuyCard({
  buyConfig,
  configLoading,
  ethInput,
  setEthInput,
  quote,
  capExceeded,
  ethBalance,
  isBuying,
  onBuy,
  canonical,
}: BuyCardProps) {
  if (configLoading && !buyConfig) {
    return <p className="stat-label">Loading buy configuration…</p>;
  }
  if (!buyConfig) {
    return (
      <p className="stat-label">
        Unable to load buy config on {canonical.name}. Try reconnecting your
        wallet.
      </p>
    );
  }
  if (buyConfig.weiPerVpfi === 0n) {
    return (
      <p className="stat-label">
        The fixed-rate buy is not yet configured on {canonical.name}. Check back
        after the admin calls <span className="mono">setVPFIBuyRate</span>.
      </p>
    );
  }
  if (!buyConfig.enabled) {
    return (
      <p className="stat-label">
        The fixed-rate buy is currently paused by the admin. Already-owned VPFI
        can still be deposited to escrow and used for the loan discount.
      </p>
    );
  }

  const rateEth = formatEther(buyConfig.weiPerVpfi);
  const maxSpendWei =
    ethBalance != null && ethBalance > ETH_GAS_RESERVE_WEI
      ? ethBalance - ETH_GAS_RESERVE_WEI
      : 0n;
  const maxSpendEth = ethBalance != null ? formatEthTrimmed(maxSpendWei) : null;
  const exceedsBalance =
    ethBalance != null && quote != null && quote.ethWei > maxSpendWei;
  const inputEmpty = ethInput.trim() === "";
  const disableReason = inputEmpty
    ? "Enter amount of ETH to pay to buy VPFI"
    : !quote
      ? "Enter a valid ETH amount"
      : capExceeded
        ? "This amount exceeds the remaining cap"
        : exceedsBalance
          ? `Amount exceeds your wallet ETH balance (${formatEthTrimmed(ethBalance!)} ETH)`
          : null;

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Stat label="Fixed rate" value={`${rateEth} ETH / VPFI`} />
        <Stat
          label="Remaining global early purchase"
          value={formatAmount(formatVpfiUnits(buyConfig.globalHeadroom))}
        />
        <Stat
          label="Your remaining allowance"
          value={formatAmount(formatVpfiUnits(buyConfig.walletHeadroom))}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label className="stat-label" style={{ margin: 0, fontWeight: 500 }}>
          Pay (ETH)
        </label>
        {maxSpendEth && maxSpendWei > 0n && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEthInput(maxSpendEth)}
            disabled={isBuying}
            data-tooltip={`A small gas reserve (${formatEthTrimmed(ETH_GAS_RESERVE_WEI)} ETH) is held back from your balance so the buy tx can still be broadcast.`}
            data-tooltip-placement="below-end"
          >
            Use max {maxSpendEth} ETH
          </button>
        )}
      </div>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={ethInput}
        onChange={(e) => setEthInput(e.target.value)}
        className="form-input"
        style={{ marginBottom: 8 }}
        disabled={isBuying}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "rgba(79, 70, 229, 0.06)",
          borderRadius: 8,
          marginBottom: 12,
        }}
      >
        <span className="stat-label" style={{ margin: 0 }}>
          You receive
        </span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {quote ? `${formatAmount(formatVpfiUnits(quote.vpfi))} VPFI` : "—"}
        </span>
      </div>

      {capExceeded && (
        <p
          className="stat-label"
          style={{ margin: "0 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          This amount exceeds the remaining cap. Reduce the ETH input and try
          again.
        </p>
      )}

      {exceedsBalance && !capExceeded && (
        <p
          className="stat-label"
          style={{ margin: "0 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          Amount exceeds your wallet ETH balance of{" "}
          {formatEthTrimmed(ethBalance!)} ETH (a small gas reserve is kept
          aside).
        </p>
      )}

      {/* Phase 8b.2 transaction-preview surface — required by docs/
          TokenomicsTechSpec.md and docs/WebsiteReadme.md for the Buy
          VPFI flow. Encodes the same `buyVPFIWithETH()` calldata the
          submit handler will sign so the Blockaid scan reflects the
          on-chain action 1:1. */}
      <SimulationPreview
        tx={
          quote && !capExceeded && !exceedsBalance && !inputEmpty
            ? {
                to: canonical.diamondAddress as Address,
                data: encodeFunctionData({
                  abi: DIAMOND_ABI,
                  functionName: "buyVPFIWithETH",
                }) as Hex,
                value: quote.ethWei,
              }
            : null
        }
      />

      <button
        className="btn btn-primary"
        onClick={onBuy}
        disabled={
          !quote || capExceeded || exceedsBalance || isBuying || inputEmpty
        }
        data-tooltip={disableReason ?? undefined}
      >
        {isBuying ? "Buying…" : "Buy VPFI"}
      </button>
    </div>
  );
}

interface BridgedBuyCardProps {
  /** Canonical-chain buy config, read via the active-chain Diamond. Used only
   *  to quote the VPFI amount + display caps for a smoother UX. */
  buyConfig: ReturnType<typeof useVPFIDiscount>["config"];
  configLoading: boolean;
  ethInput: string;
  setEthInput: (v: string) => void;
  quote: { ethWei: bigint; vpfi: bigint } | null;
  capExceeded: boolean;
  /** Wallet's native ETH balance on the origin chain; null while loading. */
  ethBalance: bigint | null;
  bridge: ReturnType<typeof useVPFIBuyBridge>;
  /** Caller-owned submit handler — wraps bridge.buy() with a re-entry guard
   *  so a double-click during the quote/approve/submit window doesn't fire
   *  a second LayerZero send. */
  onBuy: () => void | Promise<void>;
  originChain: ChainConfig;
  canonical: ChainConfig;
}

/**
 * Cross-chain buy card — shown on any non-canonical chain whose VPFIBuyAdapter
 * is deployed. Shares the ETH input + VPFI quote UI with {@link BuyCard} but
 * routes the tx through {@link useVPFIBuyBridge} and renders the extra pending
 * / landed / refunded states unique to the LayerZero round-trip.
 */
function BridgedBuyCard({
  buyConfig,
  configLoading,
  ethInput,
  setEthInput,
  quote,
  capExceeded,
  ethBalance,
  bridge,
  onBuy,
  originChain,
  canonical,
}: BridgedBuyCardProps) {
  const [lzFee, setLzFee] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [mode, setMode] = useState<"native" | "token" | null>(null);

  // Re-quote the LayerZero fee whenever the amount changes. The on-chain
  // quoter doesn't depend on the caller, so debouncing is unnecessary — only
  // the keystroke frequency of the input rate-limits this.
  useEffect(() => {
    let cancelled = false;
    if (!quote) {
      setLzFee(null);
      setQuoteError(null);
      return;
    }
    bridge
      .quote(quote.ethWei, quote.vpfi)
      .then((q) => {
        if (cancelled || !q) return;
        setLzFee(q.lzFee);
        setMode(q.mode);
        setQuoteError(null);
      })
      .catch((err) => {
        if (!cancelled) setQuoteError(decodeContractError(err, "Quote failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [quote, bridge]);

  if (configLoading && !buyConfig) {
    return <p className="stat-label">Loading buy configuration…</p>;
  }
  if (!buyConfig) {
    return (
      <p className="stat-label">
        Unable to load buy config. Reconnect your wallet and try again.
      </p>
    );
  }
  if (buyConfig.weiPerVpfi === 0n) {
    return (
      <p className="stat-label">
        The fixed-rate buy is not yet configured on {canonical.name}. Check back
        after the admin calls <span className="mono">setVPFIBuyRate</span>.
      </p>
    );
  }
  if (!buyConfig.enabled) {
    return (
      <p className="stat-label">
        The fixed-rate buy is currently paused. Already-owned VPFI can still be
        deposited to escrow and used for the loan discount.
      </p>
    );
  }

  const rateEth = formatEther(buyConfig.weiPerVpfi);
  const s = bridge.state;
  const submitting =
    s.status === "quoting" ||
    s.status === "approving" ||
    s.status === "submitting";
  const pending = s.status === "pending";
  const inputDisabled = submitting || pending;
  // For the native-ETH payment mode we can compute a safe "Use max":
  // reserve gas + the current LayerZero fee (paid as native). In token
  // mode the user is paying an ERC20 (e.g. WETH) so the ETH balance isn't
  // the limiting resource for the buy amount — skip the max button to
  // avoid misleading the user.
  const reserveWei = ETH_GAS_RESERVE_WEI + (lzFee ?? 0n);
  const maxSpendWei =
    mode === "native" && ethBalance != null && ethBalance > reserveWei
      ? ethBalance - reserveWei
      : 0n;
  const maxSpendEth =
    mode === "native" && ethBalance != null
      ? formatEthTrimmed(maxSpendWei)
      : null;
  // Native mode: the user pays ethWei + lzFee as msg.value.
  // Token  mode: msg.value is only the lzFee (ethWei comes from the ERC20).
  const totalNativeWei =
    quote == null
      ? 0n
      : mode === "token"
        ? (lzFee ?? 0n)
        : quote.ethWei + (lzFee ?? 0n);
  const exceedsBalance =
    ethBalance != null && quote != null && totalNativeWei > ethBalance;
  const inputEmpty = ethInput.trim() === "";
  const disableReason = inputEmpty
    ? "Enter amount of ETH to pay to buy VPFI"
    : !quote
      ? "Enter a valid ETH amount"
      : capExceeded
        ? "This amount exceeds the remaining cap"
        : lzFee == null
          ? "Estimating LayerZero fee…"
          : exceedsBalance
            ? `Amount plus LayerZero fee exceeds your wallet balance (${formatEthTrimmed(ethBalance!)} ETH)`
            : null;

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Stat label="Fixed rate" value={`${rateEth} ETH / VPFI`} />
        <Stat
          label="Remaining global supply"
          value={formatAmount(formatVpfiUnits(buyConfig.globalHeadroom))}
        />
        <Stat
          label="Your remaining allowance"
          value={formatAmount(formatVpfiUnits(buyConfig.walletHeadroom))}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label className="stat-label" style={{ margin: 0, fontWeight: 500 }}>
          Pay ({mode === "token" ? "tokens" : "ETH"})
        </label>
        {maxSpendEth && maxSpendWei > 0n && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEthInput(maxSpendEth)}
            disabled={inputDisabled}
            data-tooltip={`Reserves ${formatEthTrimmed(ETH_GAS_RESERVE_WEI)} ETH for gas${
              lzFee != null && lzFee > 0n
                ? ` and ${formatEthTrimmed(lzFee)} ETH for the LayerZero fee`
                : ""
            }.`}
            data-tooltip-placement="below-end"
          >
            Use max {maxSpendEth} ETH
          </button>
        )}
      </div>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={ethInput}
        onChange={(e) => setEthInput(e.target.value)}
        className="form-input"
        style={{ marginBottom: 8 }}
        disabled={inputDisabled}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "rgba(79, 70, 229, 0.06)",
          borderRadius: 8,
          marginBottom: 8,
        }}
      >
        <span className="stat-label" style={{ margin: 0 }}>
          You receive on {originChain.name}
        </span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {quote ? `${formatAmount(formatVpfiUnits(quote.vpfi))} VPFI` : "—"}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          marginBottom: 12,
        }}
        data-tooltip="LayerZero fee is to bridge Tokens to and from different Chain"
        data-tooltip-placement="below"
      >
        <span className="stat-label" style={{ margin: 0, cursor: "help" }}>
          LayerZero fee
        </span>
        <span className="mono" style={{ fontWeight: 500, cursor: "help" }}>
          {lzFee == null
            ? quote
              ? "estimating…"
              : "—"
            : `${formatEther(lzFee)} ETH`}
        </span>
      </div>

      {capExceeded && (
        <p
          className="stat-label"
          style={{ margin: "0 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          This amount exceeds the remaining cap. Reduce the ETH input and try
          again.
        </p>
      )}
      {exceedsBalance && !capExceeded && mode === "native" && (
        <p
          className="stat-label"
          style={{ margin: "0 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          Amount plus LayerZero fee exceeds your wallet ETH balance of{" "}
          {formatEthTrimmed(ethBalance!)} ETH.
        </p>
      )}
      {quoteError && (
        <p
          className="stat-label"
          style={{ margin: "0 0 8px", color: "var(--accent-red, #ef4444)" }}
        >
          {quoteError}
        </p>
      )}

      <BridgedStatus
        bridge={bridge}
        originChain={originChain}
        canonical={canonical}
      />

      {/* Phase 8b.2 transaction-preview surface for the bridged-buy
          path. Encodes `VPFIBuyAdapter.buy(ethWei, minVpfiOut)` against
          the origin chain's adapter — the same calldata the submit
          handler signs (with `value = ethWei + lzFee`). */}
      <SimulationPreview
        tx={
          quote &&
          lzFee != null &&
          !capExceeded &&
          !exceedsBalance &&
          !inputEmpty &&
          originChain.vpfiBuyAdapter
            ? {
                to: originChain.vpfiBuyAdapter as Address,
                data: encodeFunctionData({
                  abi: VPFIBuyAdapterABI as Abi,
                  functionName: "buy",
                  args: [quote.ethWei, quote.vpfi],
                }) as Hex,
                value: quote.ethWei + lzFee,
              }
            : null
        }
      />

      <button
        className="btn btn-primary"
        onClick={onBuy}
        disabled={
          !quote ||
          capExceeded ||
          submitting ||
          pending ||
          lzFee == null ||
          exceedsBalance ||
          inputEmpty
        }
        data-tooltip={disableReason ?? undefined}
        style={{ marginTop: 12 }}
      >
        {s.status === "quoting"
          ? "Estimating fee…"
          : s.status === "approving"
            ? "Approving…"
            : s.status === "submitting"
              ? "Submitting…"
              : pending
                ? "Bridging…"
                : "Buy VPFI"}
      </button>
    </div>
  );
}

interface BridgedStatusProps {
  bridge: ReturnType<typeof useVPFIBuyBridge>;
  originChain: ChainConfig;
  canonical: ChainConfig;
}

/** Expected happy-path window for a LayerZero round-trip (3 min). Drives
 *  the countdown shown during the "pending" state; after this expires the
 *  copy shifts to "taking longer than usual". */
const BRIDGE_EXPECTED_MS = 3 * 60 * 1000;
/** Elapsed-time threshold after which the manual `reclaimTimedOutBuy`
 *  button is surfaced. Well past the 3 min happy path so the user doesn't
 *  see a reclaim option they can't actually use — on-chain the adapter
 *  only accepts reclaim after its refund window has elapsed. */
const BRIDGE_RECLAIM_AFTER_MS = 15 * 60 * 1000;

/** Format a millisecond duration as `m:ss`. */
function formatMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

/**
 * Status strip for a bridged buy — renders only when a request is in flight
 * or recently resolved. Covers the five async outcomes (pending, landed,
 * refunded, timed-out, error) and exposes `reset` so the user can start a
 * follow-up purchase without a page reload.
 */
function BridgedStatus({ bridge, originChain, canonical }: BridgedStatusProps) {
  const s = bridge.state;
  // Track when the request entered the `pending` state to drive the
  // live countdown. Written during render (allowed for refs) to avoid
  // the setState-in-effect cascading-render anti-pattern.
  const pendingStartedAtRef = useRef<number | null>(null);
  if (s.status === "pending" && pendingStartedAtRef.current === null) {
    pendingStartedAtRef.current = Date.now();
  } else if (s.status !== "pending" && pendingStartedAtRef.current !== null) {
    pendingStartedAtRef.current = null;
  }

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [reclaiming, setReclaiming] = useState(false);

  useEffect(() => {
    if (s.status !== "pending") return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.status]);

  if (s.status === "idle" || s.status === "quoting") return null;

  const elapsedMs =
    pendingStartedAtRef.current !== null
      ? Math.max(0, nowMs - pendingStartedAtRef.current)
      : 0;
  const remainingMs = Math.max(0, BRIDGE_EXPECTED_MS - elapsedMs);
  const overdue = s.status === "pending" && elapsedMs > BRIDGE_EXPECTED_MS;
  const canReclaim =
    s.status === "pending" &&
    s.requestId != null &&
    elapsedMs > BRIDGE_RECLAIM_AFTER_MS;

  const handleReclaim = async () => {
    if (!s.requestId) return;
    setReclaiming(true);
    try {
      // `bridge.reclaim` swallows errors internally and transitions state
      // to `error` / `timed-out`, so we don't need a try/catch here.
      await bridge.reclaim(s.requestId);
    } finally {
      setReclaiming(false);
    }
  };

  if (
    s.status === "pending" ||
    s.status === "approving" ||
    s.status === "submitting"
  ) {
    return (
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          background: "rgba(59, 130, 246, 0.08)",
          border: "1px solid rgba(59, 130, 246, 0.3)",
          borderRadius: 8,
          padding: 12,
          marginTop: 12,
        }}
      >
        <Info
          size={18}
          style={{
            color: "var(--brand)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontWeight: 600,
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span>
              {s.status === "pending"
                ? "VPFI is on its way back to your wallet"
                : "Submitting to LayerZero…"}
            </span>
            {s.status === "pending" && (
              <span
                className="mono"
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 700,
                  padding: "2px 10px",
                  borderRadius: 999,
                  background: overdue
                    ? "rgba(245, 158, 11, 0.15)"
                    : "rgba(59, 130, 246, 0.15)",
                  color: overdue ? "var(--accent-orange)" : "var(--brand)",
                }}
                data-tooltip={
                  overdue
                    ? `LayerZero delivery has exceeded the typical 3 min window. Elapsed: ${formatMmSs(elapsedMs)}.`
                    : `Estimated time until VPFI lands in your wallet.`
                }
              >
                {overdue
                  ? `overdue · ${formatMmSs(elapsedMs)}`
                  : formatMmSs(remainingMs)}
              </span>
            )}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {s.status === "pending"
              ? overdue
                ? `Buy accepted on ${originChain.name}. LayerZero delivery is taking longer than the typical 3 min — this can happen under heavy cross-chain traffic. We're still watching for the ${canonical.name}-side delivery, and the page will update automatically when VPFI arrives.`
                : `Buy accepted on ${originChain.name}. Waiting for ${canonical.name} to process and bridge VPFI back — typically 1–3 minutes.`
              : "Confirm the transaction in your wallet."}
          </p>
          {s.txHash && (
            <p className="stat-label" style={{ margin: "6px 0 0" }}>
              <a
                href={`${originChain.blockExplorer}/tx/${s.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--brand)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                Origin tx <ExternalLink size={12} />
              </a>
              {s.lzGuid && (
                <>
                  {"  ·  "}
                  <a
                    href={`https://layerzeroscan.com/tx/${s.lzGuid}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "var(--brand)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    LayerZero trace <ExternalLink size={12} />
                  </a>
                </>
              )}
            </p>
          )}
          {canReclaim && (
            <div style={{ marginTop: 10 }}>
              <p
                className="stat-label"
                style={{
                  margin: "0 0 8px",
                  color: "var(--accent-orange)",
                  fontWeight: 500,
                }}
              >
                The bridge has been pending for over{" "}
                {Math.floor(BRIDGE_RECLAIM_AFTER_MS / 60_000)} minutes. If
                LayerZero is stuck, you can reclaim your funds on{" "}
                {originChain.name}.
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleReclaim}
                disabled={reclaiming}
                data-tooltip="Calls reclaimTimedOutBuy on the adapter. The tx will revert if the refund window hasn't elapsed yet — safe to retry later if so."
                data-tooltip-placement="below-start"
              >
                {reclaiming ? "Reclaiming…" : "Reclaim funds"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // The "landed" success case is rendered by the top-of-page
  // <BridgeLandedBanner /> instead of here, so the confirmation is
  // prominent, includes the Add-to-MetaMask affordance, and matches the
  // canonical buy path's banner position. No inline banner in this card.

  if (
    s.status === "refunded" ||
    s.status === "timed-out" ||
    s.status === "error"
  ) {
    return (
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          background: "rgba(239, 68, 68, 0.08)",
          border: "1px solid rgba(239, 68, 68, 0.3)",
          borderRadius: 8,
          padding: 12,
          marginTop: 12,
        }}
      >
        <AlertTriangle
          size={18}
          style={{
            color: "var(--accent-red, #ef4444)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {s.status === "refunded"
              ? `Refunded by ${canonical.name}`
              : s.status === "timed-out"
                ? "Buy timed out — funds returned"
                : "Buy failed"}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {s.refundReason ?? s.error ?? "Please try again."}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={bridge.reset}>
          Dismiss
        </button>
      </div>
    );
  }

  return null;
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
  step: Step;
  /** Submit handler wired to approve-then-deposit. */
  onDeposit: () => void;
  /** Phase 8b.2 — pending tx for the inline Blockaid preview, or
   *  null when the deposit input is empty / invalid. */
  previewTx: { to: Address; data: Hex; value: bigint } | null;
}

/**
 * Deposit card: ERC20 approve + `depositVPFIToEscrow`. Rendered only after
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
  const inFlow = step === "approving-deposit" || step === "depositing";
  const rawInput = value.trim();
  const inputEmpty = rawInput === "";
  // Parse-as-number for the comparison; anything that doesn't parse is
  // treated as not-yet-valid and falls through to the `inputEmpty` branch.
  const parsedInput = rawInput === "" ? NaN : Number(rawInput);
  const inputInvalid = !Number.isFinite(parsedInput) || parsedInput <= 0;
  const exceedsBalance = !inputInvalid && parsedInput > walletBalance;
  const disableReason = inputEmpty
    ? "Enter amount of VPFI to transfer to Escrow"
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
          VPFI amount to deposit
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onChange(walletBalance.toString())}
          disabled={walletBalance === 0}
        >
          Use max ({formatAmount(walletBalance)} VPFI)
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
          from the wallet, Step 2 moves the approved amount into escrow. */}
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
            escrow. If a previous approval still covers this amount, the
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
          ? "Approving VPFI…"
          : step === "depositing"
            ? "Depositing…"
            : "Deposit to escrow"}
      </button>
    </div>
  );
}

interface UnstakeCardProps {
  /** Raw unstake amount input. */
  value: string;
  /** Setter for the unstake amount input. */
  onChange: (v: string) => void;
  /** Current escrow VPFI balance (18-dec); null while loading. */
  escrowBalance: bigint | null;
  /** True while the `withdrawVPFIFromEscrow` tx is pending. */
  pending: boolean;
  /** Current outer-flow step — drives the button label. */
  step: Step;
  /** Submit handler wired to the withdraw tx. */
  onUnstake: () => void;
}

/**
 * Unstake card — pulls VPFI out of the per-user escrow back to the user's
 * wallet via `withdrawVPFIFromEscrow`. No ERC20 approval is required (the
 * Diamond already controls the escrow), so it's a single tx unlike the
 * deposit flow. Intentionally mirrors {@link DepositCard}'s layout so the
 * two read as a symmetric pair.
 */
function UnstakeCard({
  value,
  onChange,
  escrowBalance,
  pending,
  step,
  onUnstake,
}: UnstakeCardProps) {
  const escrowBalanceUnits = formatVpfiUnits(escrowBalance);
  const rawInput = value.trim();
  const inputEmpty = rawInput === "";
  const parsedInput = rawInput === "" ? NaN : Number(rawInput);
  const inputInvalid = !Number.isFinite(parsedInput) || parsedInput <= 0;
  const exceedsBalance = !inputInvalid && parsedInput > escrowBalanceUnits;
  const balanceZero = escrowBalance == null || escrowBalance === 0n;
  const disableReason = balanceZero
    ? "Your escrow VPFI balance is 0 — deposit VPFI first."
    : inputEmpty
      ? "Enter amount of VPFI to unstake from Escrow"
      : inputInvalid
        ? "Enter a valid VPFI amount"
        : exceedsBalance
          ? `Amount exceeds your escrow VPFI balance (${formatAmount(escrowBalanceUnits)} VPFI)`
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
          VPFI amount to unstake
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onChange(escrowBalanceUnits.toString())}
          disabled={balanceZero || pending}
        >
          Use max ({formatAmount(escrowBalanceUnits)} VPFI)
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
          Amount exceeds your escrow VPFI balance of{" "}
          {formatAmount(escrowBalanceUnits)} VPFI.
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
          Escrow VPFI counts toward your borrower fee discount tier and earns 5%
          APR. Unstaking moves tokens back to your wallet — if the remaining
          escrow balance drops below a tier threshold your discount drops with
          it on the next loan.
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
        {step === "unstaking" ? "Unstaking…" : "Unstake to wallet"}
      </button>
    </div>
  );
}

/**
 * Two-dot progress strip for the approve → deposit flow. Renders nothing in
 * idle / success states and lights each step as the flow advances so the
 * user understands which MetaMask prompt they're being asked to sign.
 */
function DepositStepTrail({ step }: { step: Step }) {
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
        sublabel="into your escrow"
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

/**
 * ETH-amount formatter that produces a string safe to pass back into
 * `parseEther()`. Uses `formatEther` to get the full 18-dec representation,
 * then trims to at most 6 decimals and strips trailing zeros so "Use max"
 * buttons render "0.01234" instead of "0.012340000000000000". Integer
 * values render without a decimal point.
 */
function formatEthTrimmed(wei: bigint): string {
  const full = formatEther(wei);
  const [int, frac = ""] = full.split(".");
  if (!frac) return int;
  const trimmed = frac.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}
