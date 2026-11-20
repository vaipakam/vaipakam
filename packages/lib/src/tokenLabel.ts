/**
 * The one cleaning rule for a token's self-reported name or symbol, wherever
 * a surface shows it or exports it (the statements card, the public feed, the
 * connected app, alpha05).
 *
 * A token's `name()` and `symbol()` are written by whoever deployed the
 * token, so they are hostile input. The rule:
 *
 *  - Control and format characters are removed: C0/C1 controls, DEL, the
 *    bidi marks, embeddings, overrides and isolates, zero-width characters
 *    and the other Unicode "format" (Cf) characters. A bidi override beside
 *    an address can visually reorder it, and a zero-width character makes
 *    two different labels look the same.
 *  - Runs of whitespace (line breaks and tabs included) become one space,
 *    and the ends are trimmed, so a label is always one line.
 *  - The length is capped, counted in code points, so a paragraph-sized
 *    "symbol" cannot push the address beside it off the screen.
 *  - The result is plain text. A surface renders it as text and never as a
 *    link or markup, whatever it looks like (`https://…`, `<a>`, `[x](y)`):
 *    callers must not linkify it.
 *  - For an export (CSV or spreadsheet), `tokenLabelForExport` also makes a
 *    leading `=`, `+`, `-` or `@` harmless by prefixing an apostrophe, so a
 *    spreadsheet opening the file reads the label as text, never a formula.
 *
 * An empty result means the token gave nothing usable; the caller shows its
 * own fallback (usually the shortened address), never the raw value.
 */

/** Longest symbol kept, in code points. */
export const TOKEN_SYMBOL_MAX = 20;
/** Longest name kept, in code points. */
export const TOKEN_NAME_MAX = 40;

export type TokenLabelKind = 'symbol' | 'name';

// Cc (controls, C0 + DEL + C1) and Cf (format: bidi marks, embeddings,
// overrides, isolates, zero-width characters, soft hyphen, BOM, tag
// characters …). Whitespace controls are folded to a space first.
const STRIPPED = /[\p{Cc}\p{Cf}]/gu;
// Control characters that separate words: folded to a space before the
// strip, so "USD\nC" reads "USD C" rather than "USDC".
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
// Every remaining run of Unicode white space.
const WHITESPACE = /\s+/gu;
// Characters a spreadsheet reads as the start of a formula.
const FORMULA_LEAD = /^[=+\-@]/;

function capFor(kind: TokenLabelKind): number {
  return kind === 'symbol' ? TOKEN_SYMBOL_MAX : TOKEN_NAME_MAX;
}

/**
 * Clean a token's name or symbol for display. Returns plain text, one line,
 * at most the kind's cap in code points; '' when nothing usable is left.
 * Accepts anything (a failed read may hand back a non-string) and returns ''
 * for a non-string.
 */
export function cleanTokenLabel(raw: unknown, kind: TokenLabelKind = 'symbol'): string {
  if (typeof raw !== 'string') return '';
  const oneLine = raw.normalize('NFC').replace(BREAKS, ' ').replace(STRIPPED, '').replace(WHITESPACE, ' ').trim();
  const capped = Array.from(oneLine).slice(0, capFor(kind)).join('').trim();
  return capped;
}

/**
 * Clean a token's name or symbol for an export (CSV, spreadsheet): the
 * display rule, then a leading `=`, `+`, `-` or `@` is made harmless with a
 * leading apostrophe. CSV quoting is the exporter's job; this makes the
 * cell's text safe, not the file's syntax.
 */
export function tokenLabelForExport(raw: unknown, kind: TokenLabelKind = 'symbol'): string {
  const clean = cleanTokenLabel(raw, kind);
  return FORMULA_LEAD.test(clean) ? `'${clean}` : clean;
}
