/**
 * A statement a page adds to every receipt signed inside it, for a context
 * the flow itself does not know (#3769: a borrow made for someone else).
 * The flows stay as they are; `ActionFlow` appends the addendum to the
 * receipt it shows and freezes, so what the reader confirmed includes it.
 * An addendum is a consequence, never a binding row: it states what the
 * app knows that the chain does not enforce.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Receipt, ReceiptText } from "./types";

const AddendumContext = createContext<readonly ReceiptText[]>([]);

export function ReceiptAddendum({
  lines,
  children,
}: {
  lines: readonly ReceiptText[];
  children: ReactNode;
}) {
  const outer = useContext(AddendumContext);
  return (
    <AddendumContext.Provider
      value={lines.length === 0 ? outer : [...outer, ...lines]}
    >
      {children}
    </AddendumContext.Provider>
  );
}

export function useReceiptAddendum(): readonly ReceiptText[] {
  return useContext(AddendumContext);
}

/** The receipt with the addendum's lines first among its consequences. */
export function withAddendum(
  receipt: Receipt | null,
  lines: readonly ReceiptText[],
): Receipt | null {
  if (receipt === null || lines.length === 0) return receipt;
  return { ...receipt, consequences: [...lines, ...receipt.consequences] };
}
