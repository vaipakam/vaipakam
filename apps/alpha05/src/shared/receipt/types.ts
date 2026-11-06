/**
 * RB-CONFIDENCE — the receipt shown before signing and the finish card
 * shown after, every time. A row states what the protocol will do with the
 * user's funds; a row the app cannot substantiate is rendered as
 * `unknown`, never omitted and never guessed (RB-FUNDS).
 */
import type { MeasuredOutcome } from '../tx/outcome';

/** Text that embeds amounts, written both ways (RB-FUNDS): `text` with
 *  short figures, `exact` with every digit. A receipt's "Show exact figures"
 *  switches every such text with its amount rows, so no figure in a receipt
 *  is left short. */
export interface FiguredText {
  text: string;
  exact: string;
}

/** A receipt's text: plain, or carrying figures written both ways. */
export type ReceiptText = string | FiguredText;

/** Builds a text twice, with short and with exact figures (`build(exact)`);
 *  a plain string when the two read the same, so nothing was shortened. */
export function figured(build: (exact: boolean) => string): ReceiptText {
  const text = build(false);
  const exact = build(true);
  return exact === text ? text : { text, exact };
}

/** The text a reader sees: the exact version when asked for. */
export function readText(t: ReceiptText, exact: boolean): string {
  return typeof t === 'string' ? t : exact ? t.exact : t.text;
}

/** Whether a text shortened any figure. */
export function textCut(t: ReceiptText): boolean {
  return typeof t !== 'string';
}

/** A receipt value for a text. */
export function textValue(t: ReceiptText): ReceiptValue {
  return typeof t === 'string' ? { kind: 'text', text: t } : { kind: 'text', text: t.text, exact: t.exact };
}

export type ReceiptValue =
  | { kind: 'amount'; asset: `0x${string}`; amount: bigint }
  /** `exact`: the same text with every digit, when `text` shortened a figure. */
  | { kind: 'text'; text: string; exact?: string }
  | { kind: 'time'; unixSeconds: number }
  | { kind: 'unknown'; why: string };

export interface ReceiptRow {
  label: string;
  value: ReceiptValue;
  /** Tier A: the row is a consequence the signature binds. */
  binding: boolean;
  /** RB-ICONS: the row moves money or a token out of the wallet, or lets
   *  the protocol do so (an approval); it carries the money-out icon. */
  movesOut?: boolean;
}

export interface Receipt {
  title: string;
  rows: readonly ReceiptRow[];
  /** Every "You can lose" and every stated unknown, tier A, always shown. */
  consequences: readonly ReceiptText[];
  /** The wallet prompts this flow needs (RB-CLICKS: one where possible). */
  prompts: number;
  /** When the receipt's inputs were last re-read (RB-REVIEW). */
  readAt: number;
}

export interface FinishCard {
  receipt: Receipt;
  outcome: MeasuredOutcome;
  /** The next action the position now has, if any. */
  /** `to` is a page of this app; `href` is another site (the current app),
   *  opened in a new tab. */
  next: { label: string; to: string } | { label: string; href: string } | null;
}
