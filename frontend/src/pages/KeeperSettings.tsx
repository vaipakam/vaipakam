import { useCallback, useEffect, useState } from "react";
import { isAddress } from "viem";
import { useWallet } from "../context/WalletContext";
import { useMode } from "../context/ModeContext";
import { useDiamondContract, useDiamondRead } from "../contracts/useDiamond";
import { beginStep } from "../lib/journeyLog";
import { ErrorAlert } from "../components/app/ErrorAlert";
import { AddressDisplay } from "../components/app/AddressDisplay";

const MAX_KEEPERS = 5;

// Phase 6: action bitmask bits — must mirror LibVaipakam.KEEPER_ACTION_*.
// Adding a bit here without adding it on-chain yields an
// `InvalidKeeperActions` revert.
export const KEEPER_ACTION = {
  COMPLETE_LOAN_SALE: 0x01,
  COMPLETE_OFFSET: 0x02,
  INIT_EARLY_WITHDRAW: 0x04,
  INIT_PRECLOSE: 0x08,
  REFINANCE: 0x10,
} as const;
export const KEEPER_ACTION_ALL =
  KEEPER_ACTION.COMPLETE_LOAN_SALE |
  KEEPER_ACTION.COMPLETE_OFFSET |
  KEEPER_ACTION.INIT_EARLY_WITHDRAW |
  KEEPER_ACTION.INIT_PRECLOSE |
  KEEPER_ACTION.REFINANCE;

type ActionKey = keyof typeof KEEPER_ACTION;

const ACTION_ROWS: Array<{ key: ActionKey; label: string; hint: string }> = [
  {
    key: "INIT_EARLY_WITHDRAW",
    label: "Initiate early withdrawal",
    hint: "Creates the sale offer on the lender side.",
  },
  {
    key: "COMPLETE_LOAN_SALE",
    label: "Complete early withdrawal",
    hint: "Finalises the lender-side sale after a matching borrower accepts.",
  },
  {
    key: "INIT_PRECLOSE",
    label: "Initiate preclose / obligation transfer",
    hint: "Covers direct preclose, Option 2 obligation transfer, Option 3 offset offer creation.",
  },
  {
    key: "COMPLETE_OFFSET",
    label: "Complete offset",
    hint: "Finalises the Option 3 offset flow after a new borrower takes on the obligation.",
  },
  {
    key: "REFINANCE",
    label: "Initiate refinance",
    hint: "Triggers a refinance against a matching borrower offer.",
  },
];

/**
 * Keeper Whitelist management (Phase 6 per-action model). Each whitelisted
 * keeper carries an action bitmask — the caller picks which of the five
 * delegable actions the keeper may drive. Keepers cannot claim or move
 * money (repay / claim / addCollateral stay user-only by design).
 *
 * Per-loan enable is set separately on the Offer Book + Loan Details
 * pages. This page owns the global whitelist and the action bitmask per
 * keeper.
 */
export default function KeeperSettings() {
  const { address, isCorrectChain } = useWallet();
  const { mode } = useMode();
  const diamondRw = useDiamondContract();
  const diamondRo = useDiamondRead();
  const [optIn, setOptIn] = useState<boolean>(false);
  const [keepers, setKeepers] = useState<string[]>([]);
  const [actionsByKeeper, setActionsByKeeper] = useState<Record<string, number>>({});
  const [input, setInput] = useState("");
  const [draftActions, setDraftActions] = useState<number>(KEEPER_ACTION_ALL);
  const [editingKeeper, setEditingKeeper] = useState<string | null>(null);
  const [editActions, setEditActions] = useState<number>(0);
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
    let list: string[] = [];
    try {
      list = [...((await diamondRo.getApprovedKeepers(address)) as string[])];
      setKeepers(list);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else setErr((e as Error).message);
    }
    if (!missing && list.length > 0) {
      const bits: Record<string, number> = {};
      for (const k of list) {
        try {
          const raw = await (
            diamondRo as unknown as {
              getKeeperActions: (a: string, k: string) => Promise<bigint>;
            }
          ).getKeeperActions(address, k);
          bits[k.toLowerCase()] = Number(raw);
        } catch {
          // Fallback: treat unreadable entries as "all actions" to avoid
          // accidentally stripping privileges. The on-chain call will
          // tell the truth at action time either way.
          bits[k.toLowerCase()] = KEEPER_ACTION_ALL;
        }
      }
      setActionsByKeeper(bits);
    } else {
      setActionsByKeeper({});
    }
    if (missing) {
      setSupported(false);
      setOptIn(false);
      setKeepers([]);
      setActionsByKeeper({});
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
    if (!isAddress(input)) {
      setErr("Invalid address");
      return;
    }
    if (draftActions === 0) {
      setErr("Select at least one action.");
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
      const tx = await (
        diamondRw as unknown as {
          approveKeeper: (
            keeper: string,
            actions: number,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).approveKeeper(input, draftActions);
      await tx.wait();
      step.success({ note: `${input} actions=0x${draftActions.toString(16)}` });
      setInput("");
      setDraftActions(KEEPER_ACTION_ALL);
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

  function beginEdit(keeper: string) {
    setEditingKeeper(keeper);
    setEditActions(actionsByKeeper[keeper.toLowerCase()] ?? KEEPER_ACTION_ALL);
  }

  function cancelEdit() {
    setEditingKeeper(null);
    setEditActions(0);
  }

  async function saveEdit() {
    if (!editingKeeper) return;
    if (editActions === 0) {
      setErr("At least one action must remain. Use Revoke to remove the keeper entirely.");
      return;
    }
    const step = beginStep({
      area: "profile",
      flow: "setKeeperActions",
      step: "submit",
      wallet: address ?? undefined,
    });
    setBusy(true);
    setErr(null);
    try {
      const tx = await (
        diamondRw as unknown as {
          setKeeperActions: (
            keeper: string,
            actions: number,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setKeeperActions(editingKeeper, editActions);
      await tx.wait();
      step.success({
        note: `${editingKeeper} actions=0x${editActions.toString(16)}`,
      });
      cancelEdit();
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
        a keeper delegates only <strong>your side</strong> of a loan, and only
        for the specific actions you authorise. A lender's keeper with just
        "Complete early withdrawal" can finish an early-withdraw sale you
        initiated, but cannot start one on your behalf. Liquidations,
        repayments, adding collateral, and claiming stay user-only — keepers
        cannot touch money-out paths. You may whitelist up to {MAX_KEEPERS}{" "}
        keeper addresses.
      </p>

      <div
        className="alert alert-warning"
        style={{ maxWidth: 720, margin: "1rem 0" }}
      >
        <strong>Two additional gates apply per-loan.</strong> Even after you
        approve a keeper here, they can only act on a specific loan when (a)
        your master keeper-access switch below is ON and (b) you've explicitly
        enabled them for that loan on the Offer Book or Loan Details page.
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
              <strong>Master keeper access</strong>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              One-switch emergency brake — disables every whitelisted keeper
              on every loan without touching the allowlist.
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
        {keepers.map((k) => {
          const bits = actionsByKeeper[k.toLowerCase()] ?? 0;
          const isEditing = editingKeeper?.toLowerCase() === k.toLowerCase();
          return (
            <div
              key={k}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid var(--border)",
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
                <span style={{ wordBreak: "break-all", fontFamily: 'var(--font-mono, monospace)' }}>
                  <AddressDisplay address={k} withTooltip />
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-sm btn-secondary"
                    disabled={busy || !supported}
                    onClick={() => (isEditing ? cancelEdit() : beginEdit(k))}
                  >
                    {isEditing ? "Cancel" : "Edit actions"}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy || !supported}
                    onClick={() => revoke(k)}
                  >
                    Revoke
                  </button>
                </div>
              </div>
              {isEditing ? (
                <div style={{ marginTop: 8 }}>
                  <ActionsCheckboxGroup
                    value={editActions}
                    onChange={setEditActions}
                    disabled={busy}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy || editActions === 0}
                      onClick={saveEdit}
                    >
                      Save actions
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  style={{ marginTop: 6, fontSize: "0.85rem", opacity: 0.8 }}
                >
                  Actions:{" "}
                  {bits === 0 ? (
                    <em>none</em>
                  ) : (
                    ACTION_ROWS.filter((r) => (bits & KEEPER_ACTION[r.key]) !== 0)
                      .map((r) => r.label)
                      .join(", ")
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 8px" }}>
            Add keeper
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
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
              disabled={
                busy || full || !input || !supported || draftActions === 0
              }
              onClick={approve}
            >
              Approve
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            <ActionsCheckboxGroup
              value={draftActions}
              onChange={setDraftActions}
              disabled={busy || full || !supported}
            />
          </div>
          {full && (
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              Whitelist full. Revoke an entry to add a new keeper.
            </p>
          )}
        </div>
      </section>

      {err && (
        <div className="app-wallet-error" style={{ marginTop: 12 }}>
          {err}
        </div>
      )}
    </div>
  );
}

interface ActionsCheckboxGroupProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}

function ActionsCheckboxGroup({
  value,
  onChange,
  disabled,
}: ActionsCheckboxGroupProps) {
  const toggle = (bit: number) => {
    const has = (value & bit) !== 0;
    onChange(has ? value & ~bit : value | bit);
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        rowGap: 6,
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "8px 12px",
      }}
    >
      {ACTION_ROWS.map((row) => {
        const bit = KEEPER_ACTION[row.key];
        const checked = (value & bit) !== 0;
        return (
          <label
            key={row.key}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: "0.9rem",
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(bit)}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{row.label}</span>
              <span style={{ display: "block", opacity: 0.75 }}>
                {row.hint}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
