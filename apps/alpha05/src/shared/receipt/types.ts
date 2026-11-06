/**
 * RB-CONFIDENCE — the receipt shown before signing and the finish card
 * shown after, every time. A row states what the protocol will do with the
 * user's funds; a row the app cannot substantiate is rendered as
 * `unknown`, never omitted and never guessed (RB-FUNDS).
 */
import type { MeasuredOutcome } from '../tx/outcome';

export type ReceiptValue =
  | { kind: 'amount'; asset: `0x${string}`; amount: bigint }
  | { kind: 'text'; text: string }
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
  consequences: readonly string[];
  /** The wallet prompts this flow needs (RB-CLICKS: one where possible). */
  prompts: number;
  /** When the receipt's inputs were last re-read (RB-REVIEW). */
  readAt: number;
}

export interface FinishCard {
  receipt: Receipt;
  outcome: MeasuredOutcome;
  /** The next action the position now has, if any. */
  next: { label: string; to: string } | null;
}
