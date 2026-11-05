/**
 * RB-TIERS — every piece of text on a page is in exactly one tier.
 *
 *   A  consent, funds and consequence: always visible in both modes, no
 *      word budget (the guard exempts it).
 *   B  status and next step: visible, one sentence, within the budget.
 *   C  mechanism and background: lives in the help panel (RB-HELP) and
 *      is never rendered inline.
 *
 * Copy is declared through these three helpers so `scripts/check-word-budget.mjs`
 * can find every string with its tier at typecheck time, and the help
 * panel can render a C entry from the same key its B summary uses.
 */

export type Tier = 'A' | 'B' | 'C';

export interface Copy {
  tier: Tier;
  text: string;
  /** The user-guide anchor a "Why?" link deep-links to (RB-HELP). */
  guide?: string;
}

/** The budget the guard enforces on an inline tier-B sentence. Tier A is
 *  exempt; tier C is never inline. Also read by the guard script. */
export const TIER_B_WORD_BUDGET = 18;

export const A = (text: string, guide?: string): Copy => ({ tier: 'A', text, guide });
export const B = (text: string, guide?: string): Copy => ({ tier: 'B', text, guide });
export const C = (text: string, guide?: string): Copy => ({ tier: 'C', text, guide });

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
