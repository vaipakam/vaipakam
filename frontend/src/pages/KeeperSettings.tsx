import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract, useDiamondRead } from "../contracts/useDiamond";
import { beginStep } from "../lib/journeyLog";
import { ErrorAlert } from "../components/app/ErrorAlert";

const MAX_KEEPERS = 5;

/**
 * Keeper Whitelist management. Per README §3 lines 176–179, keepers are
 * role-scoped delegated managers: approving a keeper delegates only the
 * approver's side of a loan (lender-entitled vs borrower-entitled actions).
 * Keepers CANNOT claim — claim rights are bound to the Vaipakam position
 * NFT owner. Mutual approval is NOT required. Each user may whitelist up
 * to 5 keepers. Liquidation remains permissionless. Advanced-mode only.
 */
export default function KeeperSettings() {
  const { address, isCorrectChain } = useWallet();
  const { mode } = useMode();
  const diamondRw = useDiamondContract();
  const diamondRo = useDiamondRead();
  const [optIn, setOptIn] = useState<boolean>(false);
  const [keepers, setKeepers] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const refresh = useCallback(async () => {
    if (!address) return;
    // Query each view independently. Older Diamond deployments that haven't
    // had the keeper facet cut in revert with `FunctionDoesNotExist()`
    // (selector 0xa9ad62f8); we detect that and switch to a "not supported"
    // state instead of surfacing a raw RPC error.
    const isMissingSelector = (e: unknown) => {
      const msg = String(
        (e as { data?: string; message?: string })?.data ??
          (e as Error)?.message ??
          "",
      );
      return (
        msg.includes("0xa9ad62f8") ||
        /function does not exist|functionnotfound/i.test(msg)
      );
    };
    let missing = false;
    try {
      const en = await diamondRo.getKeeperAccess(address);
      setOptIn(en as boolean);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else setErr((e as Error).message);
    }
    try {
      const list = await diamondRo.getApprovedKeepers(address);
      setKeepers([...(list as string[])]);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else setErr((e as Error).message);
    }
    if (missing) {
      setSupported(false);
      setOptIn(false);
      setKeepers([]);
    } else {
      setSupported(true);
    }
  }, [address, diamondRo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggleOptIn() {
    const step = beginStep({
      area: "profile",
      flow: "setKeeperAccess",
      step: "submit",
      wallet: address ?? undefined,
    });
    setBusy(true);
    setErr(null);
    try {
      const tx = await diamondRw.setKeeperAccess(!optIn);
      await tx.wait();
      step.success();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!ethers.isAddress(input)) {
      setErr("Invalid address");
      return;
    }
    const step = beginStep({
      area: "profile",
      flow: "approveKeeper",
      step: "submit",
      wallet: address ?? undefined,
    });
    setBusy(true);
    setErr(null);
    try {
      const tx = await diamondRw.approveKeeper(input);
      await tx.wait();
      step.success({ note: input });
      setInput("");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(keeper: string) {
    const step = beginStep({
      area: "profile",
      flow: "revokeKeeper",
      step: "submit",
      wallet: address ?? undefined,
    });
    setBusy(true);
    setErr(null);
    try {
      const tx = await diamondRw.revokeKeeper(keeper);
      await tx.wait();
      step.success({ note: keeper });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      step.failure(e);
    } finally {
      setBusy(false);
    }
  }

  if (mode !== "advanced") {
    return (
      <div className="page-container">
        <h1>Keeper Whitelist</h1>
        <p style={{ maxWidth: 720 }}>
          Keeper management is an advanced feature. Switch to{" "}
          <strong>Advanced</strong> using the mode toggle in the top bar to
          delegate role-scoped execution of your loan actions to trusted keeper
          addresses.
        </p>
      </div>
    );
  }
  if (!address) {
    return (
      <div className="page-container">
        <p>Connect your wallet to manage keepers.</p>
      </div>
    );
  }
  if (!isCorrectChain) {
    return (
      <div className="page-container">
        <p>Switch to Sepolia to manage keepers.</p>
      </div>
    );
  }

  const full = keepers.length >= MAX_KEEPERS;

  return (
    <div className="page-container">
      <h1>Keeper Whitelist</h1>
      <p style={{ maxWidth: 720 }}>
        Keepers are <strong>delegated managers</strong> of your role. Approving
        a keeper delegates only <strong>your side</strong> of a loan to them —
        a lender's keeper can act on lender-entitled actions (e.g. completing a
        loan sale); a borrower's keeper can act on borrower-entitled actions
        (e.g. completing an offset). Mutual approval across lender and borrower
        is <strong>not</strong> required. Liquidations remain permissionless.
        You may whitelist up to {MAX_KEEPERS} keeper addresses.
      </p>

      <div
        className="alert alert-warning"
        style={{ maxWidth: 720, margin: "1rem 0" }}
      >
        <strong>Keepers cannot claim assets.</strong> Claiming collateral or
        principal after repayment, liquidation, or default can only be executed
        by the <strong>Vaipakam NFT owner</strong> holding the position NFT.
        Keepers are restricted to role-management actions — they do not inherit
        claim rights.
      </div>

      {!supported && (
        <ErrorAlert
          style={{ margin: "1rem 0" }}
          message="Keeper whitelist is not enabled on the currently deployed Diamond (the keeper facet hasn't been cut in yet). Management is disabled until the deployment includes it."
        />
      )}

      <section
        style={{
          margin: "1.5rem 0",
          padding: "1rem",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <div>
              <strong>Keeper access opt-in</strong>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              Must be enabled on <strong>your side</strong> before any whitelisted
              keeper can execute your role-entitled actions. Each side controls
              its own opt-in independently.
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || !supported}
            onClick={toggleOptIn}
          >
            {optIn ? "Disable" : "Enable"}
          </button>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: "1.1rem" }}>
          Approved keepers ({keepers.length}/{MAX_KEEPERS})
        </h2>
        {keepers.length === 0 && (
          <p style={{ opacity: 0.7 }}>No keepers approved.</p>
        )}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {keepers.map((k) => (
            <li
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "0.5rem 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <code>{k}</code>
              <button
                className="btn btn-sm btn-danger"
                disabled={busy || !supported}
                onClick={() => revoke(k)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            type="text"
            className="form-input"
            placeholder="0xKeeper..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy || full || !supported}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary"
            disabled={busy || full || !input || !supported}
            onClick={approve}
          >
            Approve
          </button>
        </div>
        {full && (
          <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
            Whitelist full. Revoke an entry to add a new keeper.
          </p>
        )}
      </section>

      {err && (
        <div className="app-wallet-error" style={{ marginTop: 12 }}>
          {err}
        </div>
      )}
    </div>
  );
}
