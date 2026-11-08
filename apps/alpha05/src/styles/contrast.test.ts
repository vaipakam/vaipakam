import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * RB-A11Y pinned to the token file: every text pair below is >= 4.5:1 (WCAG
 * AA, normal text) in BOTH themes. The test reads tokens.css itself, so a
 * retuned colour is checked rather than remembered. Codex on #3179 found an
 * earlier dark filled control at 2.98:1 (white on a light indigo); the
 * `--brand-fill` token exists because of it. The navy/green retune that
 * followed (owner decision 2026-11-05) and the return to indigo (owner
 * decision 2026-11-08) both passed through this same test.
 */
/** The app's surface and text tokens, and the shared brand palette the app
 *  imports before them (packages/lib/src/brand/tokens.css). A pair may span
 *  the two files, so both are read and merged per theme. */
const SHEETS = [
  readFileSync(new URL('../../../../packages/lib/src/brand/tokens.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./tokens.css', import.meta.url), 'utf8'),
];

function block(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const css of SHEETS) {
    const start = css.indexOf(selector);
    expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      expect(out[m[1]], `--${m[1]} defined in both files`).toBeUndefined();
      out[m[1]] = m[2].toLowerCase();
    }
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [text token, background token] pairs the components actually render. */
const TEXT_PAIRS: readonly [string, string][] = [
  ['text-on-brand', 'brand-fill'], // .btn-primary and the pressed mode segment
  ['brand', 'surface-page'], // links and the active nav item on the page
  ['brand', 'surface-raised'], // the same on a card
  ['brand-soft-text', 'brand-soft'], // soft brand chips
  ['text-strong', 'surface-page'],
  ['text-body', 'surface-page'],
  ['text-muted', 'surface-page'],
  ['text-strong', 'surface-raised'],
  ['text-body', 'surface-raised'],
  ['text-muted', 'surface-raised'],
  ['ok', 'ok-soft'],
  ['warn', 'warn-soft'],
  ['danger', 'danger-soft'],
  ['info', 'info-soft'],
];

describe('tokens.css contrast (RB-A11Y)', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#818cf8')).toBeLessThan(4.5);
  });
  for (const theme of ["\n:root,\n:root[data-theme='light']", ":root[data-theme='dark']"]) {
    const name = theme.includes('dark') ? 'dark' : 'light';
    it(`keeps every rendered text pair at or above 4.5:1 in the ${name} theme`, () => {
      const tokens = block(theme);
      for (const [text, bg] of TEXT_PAIRS) {
        expect(tokens[text], `--${text} in ${name}`).toBeDefined();
        expect(tokens[bg], `--${bg} in ${name}`).toBeDefined();
        const ratio = contrast(tokens[text]!, tokens[bg]!);
        expect(ratio, `--${text} on --${bg} in ${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
