import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { erc20Abi, type Log } from "viem";
import { useConfig } from "wagmi";
import { writeContract } from "wagmi/actions";
import type { OwnStateClient } from "../../chain/ownRail";
import type { SupportedChain } from "../../chain/chains";
import { useCopy } from "../copy/useCopy";
import { refusalFromError, StatedRefusal } from "../eligibility/refusal";
import { WhyLink } from "../help/WhyLink";
import {
  MAX_1155_QUANTITY,
  parseQuantity,
  parseTokenId,
  quantityMoved,
  tokenMoved,
  type Standard,
} from "../nft/nft";
import { useAssetStandard } from "../nft/useStandard";
import { moved, legVerdict } from "../offers/acceptOutcome";
import { parsePasted, suggestedCollateral } from "../offers/assets";
import { readVault } from "../offers/reads";
import { parseAmount } from "../post/postModel";
import {
  assetName,
  exactTokenAmount,
  tokenAmount,
  useTokenMeta,
  type TokenMetaMap,
} from "../reads/tokens";
import { useOwnRead } from "../reads/useOwnRead";
import { allowanceSteps } from "../tx/approval";
import { allowanceMoved, approvalFlow } from "../tx/approvalFlow";
import { cleanUpLeg } from "../tx/cleanUp";
import { nftApproval } from "../tx/nftApproval";
import { operatorApproval } from "../tx/operatorApproval";
import type { LegOutcome } from "../tx/outcome";
import { askThrough } from "../tx/simulate";
import {
  holdsFlow,
  useStoredValue,
  useTxEntry,
  useTxNote,
} from "../tx/txStore";
import { useMounted, useReviewRefresh } from "../tx/useReviewRefresh";
import { useTrackedTx } from "../tx/useTrackedTx";
import { ActionFlow, reviewIdentity, type Recheck } from "../ui/ActionFlow";
import { FormField } from "../ui/FormField";
import { Notice } from "../ui/Notice";
import { readTerms, type TermsState } from "../terms/terms";
import { shortAddress } from "../ui/format";
import {
  depositBlockers,
  depositCall,
  depositChanged,
  deposited,
  depositPromptCount,
  readDepositReview,
  type DepositDraft,
  type DepositReview,
} from "./deposit";
import { depositName, depositReceipt } from "./depositReceipt";

type Hex = `0x${string}`;

/** The store key the deposit flow keeps its state under. */
export const DEPOSIT_KEY = "vault.deposit";

/** Whether the deposit is open (the form, or a draft under review or in
 *  flight), so the page keeps the panel on screen until it is closed, and
 *  whether a transaction is under way (past the review), which the page
 *  never interrupts. */
export function useDepositHeld(flowKey: string = DEPOSIT_KEY): {
  held: boolean;
  inFlight: boolean;
  setOpen: (v: boolean | null) => void;
} {
  const entry = useTxEntry(flowKey);
  const [open, setOpen] = useStoredValue<boolean>(`${flowKey}:open`);
  return {
    held: open === true || holdsFlow(entry.phase),
    inFlight: holdsFlow(entry.phase),
    setOpen,
  };
}

interface DepositProps {
  chain: SupportedChain;
  own: OwnStateClient;
  onClose: () => void;
  /** Called when the last check before signing finds an unaccepted Terms
   *  version, so the page reads the Terms again and opens its gate. */
  onTermsDue?: () => void;
  /** The store key this flow keeps its state under, so a second page that
   *  hosts the deposit (Rewards, for VPFI) never shares a draft with the
   *  Vault page's. */
  flowKey?: string;
  /** A fixed ERC-20 the deposit is for (Rewards: the VPFI token): the asset
   *  choice is not offered. */
  asset?: Hex;
  /** The form's heading, when the host names the deposit itself. */
  title?: string;
}

/**
 * ACC-22 — deposit one asset into my vault, outside any loan. The reader
 * chooses the asset (a suggested token or test collection, or a pasted
 * address, whose standard its contract claims) and the amount, token id or
 * quantity; the review states what leaves the wallet, into which vault, the
 * approval and every consequence. The wallet approves exactly what the
 * deposit needs (an ERC-20 amount, one ERC-721 token, or an ERC-1155
 * collection for this deposit alone, taken back after it), the deposit is
 * sent only after the protocol's dry run passes with the approval in place,
 * and an approval it made is put back if the deposit does not go through.
 * The finish card states what the protocol credited and what left the
 * wallet, from the transaction's own logs.
 */
export function DepositVault(props: DepositProps) {
  const flowKey = props.flowKey ?? DEPOSIT_KEY;
  const entry = useTxEntry(flowKey);
  const [draft, setDraft] = useStoredValue<DepositDraft>(`${flowKey}:draft`);
  if (draft === null && !holdsFlow(entry.phase))
    return <DepositForm {...props} onChosen={setDraft} />;
  if (draft === null) return null;
  return (
    <DepositFlow
      {...props}
      draft={draft}
      onChange={() => setDraft(null)}
      onClose={() => (setDraft(null), props.onClose())}
    />
  );
}

const OTHER = "other";

/** The form: the asset, then what of it, checked against the wallet's
 *  holding as it is typed. */
function DepositForm({
  chain,
  own,
  onClose,
  onChosen,
  flowKey = DEPOSIT_KEY,
  asset: fixed,
  title,
}: DepositProps & { onChosen: (d: DepositDraft) => void }) {
  const { text, format } = useCopy();
  const selectId = useId();
  const [asset, setAsset] = useStoredValue<string>(`${flowKey}:asset`);
  const [other, setOther] = useState(false);
  const [pasted, setPasted] = useState("");
  const [amountInput, setAmountInput] = useStoredValue<string>(
    `${flowKey}:amount`,
  );
  const [idInput, setIdInput] = useStoredValue<string>(`${flowKey}:tokenId`);
  const [asked, setAsked] = useState(false);
  const suggested = suggestedCollateral(chain);
  const chosen = (fixed ?? asset ?? null) as Hex | null;
  // A fixed asset is an ERC-20 the host names, so its standard is not asked.
  const std = useAssetStandard(fixed === undefined ? chosen : null);
  const standard: Standard | null =
    fixed !== undefined
      ? "erc20"
      : std.state === "ready"
        ? (std.data ?? null)
        : null;
  const meta = useTokenMeta(
    chosen
      ? [chosen, ...suggested.map((s) => s.address)]
      : suggested.map((s) => s.address),
  ).data;
  const decimals = chosen
    ? (meta?.[chosen.toLowerCase()]?.decimals ?? null)
    : null;
  const balance = useErc20Balance(own, standard === "erc20" ? chosen : null);

  const typedAmount = amountInput ?? "";
  const typedId = idInput ?? "";
  const tokenId = standard === "erc20" ? 0n : parseTokenId(typedId);
  const amount = (() => {
    if (standard === "erc721") return { ok: true as const, value: 1n };
    if (standard === "erc1155") {
      const q = parseQuantity(typedAmount);
      return q === null
        ? {
            ok: false as const,
            error: typedAmount.trim() === "" ? "empty" : "invalid",
          }
        : { ok: true as const, value: q };
    }
    if (decimals === null) return null;
    return parseAmount(typedAmount, decimals);
  })();
  const symbol = chosen
    ? (meta?.[chosen.toLowerCase()]?.symbol ?? shortAddress(chosen))
    : "";

  const amountError = (() => {
    if (standard === "erc721" || standard === null) return null;
    if (standard === "erc20" && decimals === null)
      return text("vaultDeposit.decimalsUnread");
    if (!amount || amount.ok) {
      if (
        standard === "erc20" &&
        amount?.ok &&
        typeof balance === "bigint" &&
        amount.value > balance
      )
        return format("vaultDeposit.amountOver", {
          balance: tokenAmount(balance, chosen!, meta, format),
        });
      return null;
    }
    if (amount.error === "empty" || amount.error === "zero")
      return text("vaultDeposit.amountZero");
    if (standard === "erc1155")
      return format("vaultDeposit.quantityInvalid", {
        max: MAX_1155_QUANTITY.toString(),
      });
    if (amount.error === "invalid") return text("request.errInvalid");
    return format("request.errDecimals", {
      symbol,
      decimals: String(decimals),
    });
  })();
  const idError =
    standard !== null && standard !== "erc20" && tokenId === null
      ? text("vaultDeposit.tokenIdInvalid")
      : null;
  const ready =
    chosen !== null &&
    standard !== null &&
    amount?.ok === true &&
    amountError === null &&
    idError === null &&
    tokenId !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && amount?.ok && chosen && standard && tokenId !== null)
      onChosen({ standard, asset: chosen, tokenId, amount: amount.value });
  };

  const close = () => {
    setAsset(null);
    setAmountInput(null);
    setIdInput(null);
    onClose();
  };

  const invalidPaste =
    other && pasted.trim() !== "" && parsePasted(pasted) === null;
  const name = chosen ? assetName(chosen, meta) : "";

  return (
    <form
      className="partial-form"
      onSubmit={submit}
      noValidate
      data-testid="vault-deposit-form"
    >
      <h3>{title ?? text("vaultDeposit.formTitle")}</h3>
      {fixed === undefined && (
        <div className="asset-choice">
          <label htmlFor={selectId}>{text("vaultDeposit.pickAsset")}</label>
          <select
            id={selectId}
            value={other ? OTHER : (chosen ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              setAmountInput(null);
              setIdInput(null);
              if (v === OTHER) {
                setOther(true);
                setAsset(parsePasted(pasted));
              } else {
                setOther(false);
                setAsset(v === "" ? null : v);
              }
            }}
            data-testid="vault-deposit-asset"
          >
            <option value="">{text("borrow.pickChoose")}</option>
            {suggested.map((c) => (
              <option key={c.address} value={c.address}>
                {assetName(c.address, meta)}
                {c.nft
                  ? ` (${text("borrow.testNftBadge")})`
                  : c.test
                    ? ` (${text("borrow.testBadge")})`
                    : ""}
              </option>
            ))}
            <option value={OTHER}>{text("borrow.pickOther")}</option>
          </select>
          {other && (
            <FormField
              label={text("borrow.pasteLabel")}
              error={invalidPaste ? text("borrow.pasteInvalid") : null}
              hint={text("borrow.noScreening")}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={pasted}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setAsset(parsePasted(e.target.value));
                  }}
                  data-testid="vault-deposit-paste"
                />
              )}
            </FormField>
          )}
          {chosen !== null && std.state === "failed" && (
            <Notice tone="warn" tier="A">
              {format("borrow.standardFailed", {
                asset: name,
                reason: std.error ?? "no answer",
              })}
            </Notice>
          )}
          {chosen !== null && standard !== null && standard !== "erc20" && (
            <p className="tier-b" data-asset-standard={standard}>
              {format(
                standard === "erc721"
                  ? "vaultDeposit.is721"
                  : "vaultDeposit.is1155",
                { asset: name },
              )}
            </p>
          )}
        </div>
      )}
      {standard !== null && standard !== "erc20" && (
        <FormField
          label={text("vaultDeposit.tokenIdLabel")}
          hint={text("vaultDeposit.tokenIdHint")}
          error={asked || typedId !== "" ? idError : null}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={typedId}
              onChange={(e) => setIdInput(e.target.value)}
              data-testid="vault-deposit-token-id"
            />
          )}
        </FormField>
      )}
      {(standard === "erc20" || standard === "erc1155") && (
        <FormField
          label={
            standard === "erc20"
              ? format("vaultDeposit.amountLabel", { symbol })
              : text("vaultDeposit.quantityLabel")
          }
          hint={
            standard === "erc20"
              ? typeof balance === "bigint"
                ? format("vaultDeposit.amountHint", {
                    balance: tokenAmount(balance, chosen!, meta, format),
                  })
                : text("vaultDeposit.amountHintUnread")
              : text("vaultDeposit.quantityHint")
          }
          error={
            (standard === "erc20" && decimals === null) ||
            asked ||
            (typedAmount !== "" &&
              amountError !== text("vaultDeposit.amountZero"))
              ? amountError
              : null
          }
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              inputMode={standard === "erc20" ? "decimal" : "numeric"}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={typedAmount}
              disabled={standard === "erc20" && decimals === null}
              onChange={(e) => setAmountInput(e.target.value)}
              data-testid="vault-deposit-amount"
            />
          )}
        </FormField>
      )}
      <p className="tier-b">{text("vaultDeposit.formNote")}</p>
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={chosen === null || standard === null}
          data-testid="vault-deposit-review"
        >
          {text("vaultDeposit.review")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={close}
          data-testid="vault-deposit-cancel"
        >
          {text("flow.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The wallet's balance of an ERC-20, read again each block while the form
 *  is open, so a balance that grows (a faucet in another tab) lifts the
 *  form's refusal by itself: undefined while reading, null when unread. */
function useErc20Balance(
  own: OwnStateClient,
  asset: Hex | null,
): bigint | null | undefined {
  const read = useOwnRead(
    ["vault", "depositBalance", asset],
    (c) =>
      c.readContract({
        address: asset!,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [own.account],
      }),
    {
      enabled: asset !== null,
      perBlock: true,
    },
  );
  if (
    asset === null ||
    read.state === "reading" ||
    read.state === "no-identity"
  )
    return undefined;
  return read.state === "failed" ? null : read.data;
}

/** The review and the transaction, for one draft. */
function DepositFlow({
  chain,
  own,
  draft,
  onChange,
  onClose,
  onTermsDue,
  flowKey = DEPOSIT_KEY,
}: DepositProps & { draft: DepositDraft; onChange: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const meta = useTokenMeta([draft.asset]).data;
  const [review, setReview] = useStoredValue<DepositReview>(
    `${flowKey}:review`,
  );
  const [, setAsset] = useStoredValue<string>(`${flowKey}:asset`);
  const [, setAmountInput] = useStoredValue<string>(`${flowKey}:amount`);
  const [, setIdInput] = useStoredValue<string>(`${flowKey}:tokenId`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<
    | {
        kind: "erc20";
        token: Hex;
        prior: bigint;
        amount: bigint;
        since: bigint | null;
      }
    | {
        kind: "erc721";
        token: Hex;
        tokenId: bigint;
        prior: Hex | null;
        since: bigint;
      }
    | null
  >(null);
  /** An ERC-1155 operator approval granted for this deposit alone: taken
   *  back on every ending, the deposit's success included. */
  const grantLeft = useRef<{
    token: Hex;
    tokenId: bigint;
    since: bigint;
  } | null>(null);
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const exact = (asset: Hex, v: bigint) =>
    exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({
    own,
    config,
    chainId: chain.chainId,
    diamond,
    copy,
    exactAmount: exact,
    setStep,
  });
  const tokenApproval = (asset: Hex, tokenId: bigint) =>
    nftApproval(
      {
        own,
        config,
        chainId: chain.chainId,
        diamond,
        copy,
        tokenName: format("asset.nft", {
          asset: assetName(asset, meta),
          id: String(tokenId),
        }),
        setStep,
      },
      asset,
      tokenId,
    );
  const operator = (
    asset: Hex,
    tokenId: bigint,
    say?: (what: string) => void,
  ) =>
    operatorApproval(
      {
        own,
        config,
        chainId: chain.chainId,
        diamond,
        copy,
        collection: assetName(asset, meta),
        setStep: (what) => (what === null || !say ? setStep(what) : say(what)),
      },
      asset,
      tokenId,
    );
  const say = (what: string) =>
    setStep(
      format("accept.stepOf", {
        n: String(++counter.current.n),
        total: String(counter.current.total),
        what,
      }),
    );

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error("no deposit under review");
      const r = review;
      const d = r.draft;
      counter.current = { n: 0, total: depositPromptCount(r) };
      approvalLeft.current = null;
      grantLeft.current = null;

      // 1. The approval, read again first so a change since the review stops
      //    before any prompt, and a stop puts back exactly what was there.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      const h = r.holding;
      if (h.kind === "erc721") {
        const ap = tokenApproval(d.asset, d.tokenId);
        const now = await ap.read();
        const needed = !(
          now.approvedForAll ||
          (now.approved !== null &&
            now.approved.toLowerCase() === diamond.toLowerCase())
        );
        if ((needed ? 1 : 0) !== h.approvalSteps) throw allowanceMoved(copy);
        if (needed) {
          say(
            format("nftApproval.step", {
              token: format("asset.nft", {
                asset: assetName(d.asset, meta),
                id: String(d.tokenId),
              }),
            }),
          );
          const since = await ap.approve(now.approved);
          approvalLeft.current = {
            kind: "erc721",
            token: d.asset,
            tokenId: d.tokenId,
            prior: now.approved,
            since,
          };
          putItBack = () => ap.putBack(now.approved, since);
        }
      } else if (h.kind === "erc1155") {
        const ap = operator(d.asset, d.tokenId, say);
        const now = await ap.read();
        if ((now.approvedForAll ? 0 : 2) !== h.approvalSteps)
          throw allowanceMoved(copy);
        if (!now.approvedForAll) {
          say(
            format("operatorApproval.step", {
              collection: assetName(d.asset, meta),
            }),
          );
          const since = await ap.grant();
          grantLeft.current = { token: d.asset, tokenId: d.tokenId, since };
          putItBack = () => {
            grantLeft.current = null;
            return ap.revoke(since);
          };
        }
      } else {
        const io = allowanceIo(d.asset, (v, i, of) =>
          say(
            of === 2 && i === 0
              ? text("approval.stepZero")
              : format("approval.step", { amount: exact(d.asset, v) }),
          ),
        );
        const prior = await readAllowance(d.asset);
        if (prior !== h.allowance) throw allowanceMoved(copy);
        const steps =
          prior >= d.amount ? [] : await allowanceSteps(io, prior, d.amount);
        if (steps.length !== h.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          const since = await approveExactly(io, d.asset, d.amount, prior);
          approvalLeft.current = {
            kind: "erc20",
            token: d.asset,
            prior,
            amount: d.amount,
            since,
          };
          putItBack = () => putBack(d.asset, prior, d.amount, since);
        }
      }

      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null)
          throw new StatedRefusal({
            code: "DepositStopped",
            reason,
            reopensAt: null,
            remedy: null,
          });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({
          code: "DepositStopped",
          reason: `${reason} ${after.sentence}`,
          reopensAt: null,
          remedy: null,
        });
      };

      // 2. The dry run with the approval in place: the protocol's verdict on
      //    the whole deposit, the full-arrival check included.
      const call = depositCall(d);
      const dry = await askThrough(own, (c) =>
        c.simulateContract({ address: diamond, ...call, account }),
      );
      if (dry.kind === "reverted")
        return stop(
          format("vaultDeposit.dryRunRefused", {
            reason: refusalFromError(dry.error).reason,
          }),
        );
      if (dry.kind === "unreadable")
        return stop(format("flow.unreadable", { reason: dry.reason }));

      // 3. The deposit.
      say(text("vaultDeposit.stepSend"));
      try {
        return await writeContract(config, {
          address: diamond,
          ...call,
          chainId: chain.chainId,
          account,
        });
      } catch (e) {
        return stop(
          format("repay.stoppedAfterApproval", {
            reason: refusalFromError(e).reason,
          }),
        );
      }
    },
    // A sent deposit that did not take effect used none of the approval.
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      if (left.kind === "erc721") {
        const after = await tokenApproval(left.token, left.tokenId).putBack(
          left.prior,
          left.since,
        );
        return cleanUpLeg(after, text("nftApproval.legBack"));
      }
      const after = await putBack(
        left.token,
        left.prior,
        left.amount,
        left.since,
      );
      return cleanUpLeg(
        after,
        format("approval.legBack", { amount: exact(left.token, left.prior) }),
      );
    },
    release: async () => {
      const left = grantLeft.current;
      grantLeft.current = null;
      if (!left) return null;
      const after = await operator(left.token, left.tokenId, say).revoke(
        left.since,
      );
      return cleanUpLeg(
        after,
        format("operatorApproval.leg", {
          collection: assetName(left.token, meta),
        }),
      );
    },
    held: () =>
      grantLeft.current
        ? format("operatorApproval.pendingNote", {
            collection: assetName(grantLeft.current.token, meta),
          })
        : null,
    measure: async (receipt, at) =>
      review
        ? measure(
            review,
            receipt.logs,
            await at
              .read((c, b) => readVault(c, diamond, account, b))
              .catch(() => null),
          )
        : [],
  });

  /** What the deposit credited and what left the wallet, from its own logs. */
  const measure = (
    r: DepositReview,
    logs: readonly Log[],
    vault: Hex | null,
  ): LegOutcome[] => {
    const d = r.draft;
    const legs: LegOutcome[] = [];
    // A deposit that took effect used the approval it made (an ERC-721
    // transfer clears its own approval).
    approvalLeft.current = null;
    const name = depositName(r, meta, copy);
    const credited = deposited(logs, diamond, account, d);
    const creditLabel = format("vaultDeposit.legCredited", {
      what:
        d.standard === "erc20"
          ? tokenAmount(credited ?? d.amount, d.asset, meta, format)
          : name,
    });
    const want = d.standard === "erc721" ? 1n : d.amount;
    if (credited === null)
      legs.push({
        status: "not-done",
        label: creditLabel,
        reason: text("vaultDeposit.notCredited"),
      });
    else if (credited === want)
      legs.push({ status: "done", label: creditLabel });
    else
      legs.push({
        status: "not-done",
        label: creditLabel,
        reason: format("vaultDeposit.creditedOther", {
          amount: credited.toString(),
          expected: want.toString(),
        }),
      });

    const movedLabel = format("vaultDeposit.legMoved", {
      what:
        d.standard === "erc20"
          ? tokenAmount(d.amount, d.asset, meta, format)
          : name,
    });
    if (vault === null)
      legs.push({
        status: "unknown",
        label: movedLabel,
        reason: text("accept.vaultUnknown"),
      });
    else if (d.standard === "erc721")
      legs.push(
        tokenMoved(logs, d.asset, d.tokenId, account, vault)
          ? { status: "done", label: movedLabel }
          : {
              status: "not-done",
              label: movedLabel,
              reason: text("vaultDeposit.notMoved"),
            },
      );
    else if (d.standard === "erc1155") {
      const units = quantityMoved(logs, d.asset, d.tokenId, account, vault);
      legs.push(
        units === d.amount
          ? { status: "done", label: movedLabel }
          : {
              status: units === 0n ? "not-done" : "unknown",
              label: movedLabel,
              reason: format("vaultDeposit.movedOther", {
                amount: units.toString(),
                expected: d.amount.toString(),
              }),
            },
      );
    } else {
      const got = moved(logs, d.asset, account, vault);
      const lv = legVerdict(got, d.amount);
      legs.push(
        lv === "done"
          ? { status: "done", label: movedLabel }
          : {
              status: lv,
              label: movedLabel,
              reason: format("vaultDeposit.movedOther", {
                amount: exact(d.asset, got),
                expected: exact(d.asset, d.amount),
              }),
            },
      );
    }
    if (r.vault === null && vault !== null)
      legs.push({
        status: "done",
        label: format("vault.legCreated", { vault: shortAddress(vault) }),
      });
    return legs;
  };

  const mounted = useMounted();
  const sameDraft = (a: DepositDraft, b: DepositDraft) =>
    a.standard === b.standard &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.tokenId === b.tokenId &&
    a.amount === b.amount;
  const read = (who: string) => readDepositReview(own, diamond, draft, who);
  const load = async () => {
    try {
      const next = await read(identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview =
    tx.phase.kind === "review" &&
    review !== null &&
    sameDraft(review.draft, draft);
  useReviewRefresh<DepositReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) =>
      readDepositReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => sameDraft(a.draft, b.draft),
    changed: (before, next) => depositChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const open = tx.phase.kind === "idle" || tx.phase.kind === "review";
    if (!open) return;
    if (tx.phase.kind === "idle" && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (
      review === null ||
      !sameDraft(review.draft, draft) ||
      review.identity !== identity
    ) {
      setReview(null);
      let live = true;
      read(identity).then(
        (next) => {
          if (!live) return;
          setLoadError(null);
          setReview(next);
        },
        (e: unknown) => {
          if (live) setLoadError(refusalFromError(e).reason);
        },
      );
      return () => {
        live = false;
      };
    }
    // Opened once per draft; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shortText = (r: DepositReview) => (short: bigint) =>
    r.draft.standard === "erc20"
      ? format("vaultDeposit.short", {
          amount: tokenAmount(short, r.draft.asset, meta, format),
        })
      : format("vaultDeposit.shortUnits", { count: short.toString() });

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: "unreadable", reason: text("flow.reading") };
    let next: DepositReview;
    let nowTerms: TermsState;
    try {
      // ACC-15: the Terms are read again right before signing, so a wallet
      // switched to while the form was open, or a version published since,
      // is never signed for without acceptance.
      [next, nowTerms] = await Promise.all([
        readDepositReview(own, diamond, review.draft, review.identity),
        own.read((c) => readTerms(c, diamond, account)).then((x) => x.value),
      ]);
    } catch (e) {
      return { kind: "unreadable", reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === "needed") {
      onTermsDue?.();
      return {
        kind: "refused",
        refusal: {
          code: "TermsNotAccepted",
          reason: text("vaultDeposit.termsNewer"),
          reopensAt: null,
          remedy: null,
        },
      };
    }
    const what = depositChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: "changed", what };
    const blockers = depositBlockers(next, account, copy, shortText(next));
    if (blockers.length > 0)
      return {
        kind: "refused",
        refusal: {
          code: "DepositBlocked",
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: "ok" };
  };

  const change = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChange();
  };

  const blockers = review
    ? depositBlockers(review, account, copy, shortText(review))
    : [];
  const gate = review
    ? {
        ready: blockers.length === 0,
        node: (
          <div className="repay-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            <WhyLink
              summaryKey="vaultDeposit.whySummary"
              detailKey="vaultDeposit.why"
            />
            <button
              type="button"
              className="btn btn-link"
              onClick={change}
              data-testid="vault-deposit-change"
            >
              {text("vaultDeposit.change")}
            </button>
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = (meta as TokenMetaMap | null)?.[a.toLowerCase()];
    return m && m.decimals !== null
      ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals }
      : null;
  };

  const close = () => {
    setReview(null);
    setAsset(null);
    setAmountInput(null);
    setIdInput(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="vault-deposit-panel">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format("flow.unreadable", { reason: loadError })}{" "}
          <button type="button" className="btn" onClick={() => void load()}>
            {text("consent.retry")}
          </button>
        </Notice>
      )}
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? depositReceipt(review, meta, copy) : null}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
