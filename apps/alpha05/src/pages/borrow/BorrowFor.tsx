import { useState } from "react";
import { useCopy, type CopyKey } from "../../shared/copy/useCopy";
import { checkForWhom } from "../../shared/loans/borrowFor";

type Hex = `0x${string}`;

const WHY_KEY: Readonly<Record<"invalid" | "zero" | "self", CopyKey>> = {
  invalid: "borrowFor.invalid",
  zero: "borrowFor.zero",
  self: "borrowFor.self",
};

/**
 * #3769 — the Borrow page's "Borrow for someone" choice: an address the
 * borrower enters for the person who will use the money and repay. It only
 * changes what the review states; the loan, its collateral and its borrower
 * position are the borrower's own.
 */
export function BorrowFor({
  account,
  value,
  onChange,
}: {
  account: Hex | null;
  value: Hex | null;
  onChange: (next: Hex | null) => void;
}) {
  const { text } = useCopy();
  const [open, setOpen] = useState(value !== null);
  const [typed, setTyped] = useState<string>(value ?? "");
  const check = checkForWhom(typed, account);
  const set = (raw: string) => {
    setTyped(raw);
    const r = checkForWhom(raw, account);
    onChange(r.ok ? r.address : null);
  };
  return (
    <fieldset className="choice-group" data-testid="borrow-for">
      <legend>{text("borrowFor.title")}</legend>
      <label className="choice">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => {
            setOpen(e.target.checked);
            if (!e.target.checked) {
              setTyped("");
              onChange(null);
            }
          }}
          data-testid="borrow-for-opt"
        />
        <span>{text("borrowFor.option")}</span>
      </label>
      {open && (
        <>
          <p className="tier-b">{text("borrowFor.lead")}</p>
          <label htmlFor="borrow-for-address">
            {text("borrowFor.addressLabel")}
          </label>
          <input
            id="borrow-for-address"
            type="text"
            value={typed}
            onChange={(e) => set(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="borrow-for-address"
          />
          {!check.ok && check.why !== "empty" && (
            <p className="tier-a" data-testid="borrow-for-refused">
              {text(WHY_KEY[check.why])}
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
