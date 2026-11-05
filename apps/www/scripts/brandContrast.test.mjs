/**
 * The shared brand palette (packages/lib/src/brand/tokens.css, owner
 * decision 2026-11-05) rendered on the website's own surfaces: every text
 * pair below is at or above 4.5:1 (WCAG AA, normal text) in BOTH themes.
 * The connected app pins the same palette against ITS surfaces
 * (apps/alpha05/src/styles/contrast.test.ts); this is the website's half,
 * because a brand token retuned for one surface set can fail on the other.
 * Both files are read, so a retuned colour is checked rather than
 * remembered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SHEETS = [
  readFileSync(new URL('../../../packages/lib/src/brand/tokens.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8'),
];

/** The six-digit hex tokens of the first block each sheet opens with `selector`,
 *  merged across the sheets; a token defined in both files is refused, since
 *  the website must not shadow a shared brand token. */
function block(selectors) {
  const out = {};
  for (const [i, css] of SHEETS.entries()) {
    const start = css.indexOf(selectors[i]);
    assert.ok(start >= 0, `${selectors[i]} block in sheet ${i}`);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      assert.equal(out[m[1]], undefined, `--${m[1]} defined in both files`);
      out[m[1]] = m[2].toLowerCase();
    }
  }
  return out;
}

function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [text token, background token] pairs the website's stylesheets render. */
const TEXT_PAIRS = [
  ['text-on-brand', 'brand-fill'], // .btn-primary, the active guide and FAQ tabs, the consent switch
  ['brand', 'bg-primary'], // links, the active nav item, section eyebrows on the page
  ['brand', 'bg-secondary'], // the same on the alternating landing sections
  ['brand', 'bg-card'], // the same on a card
  ['brand', 'brand-soft'], // the eyebrow label and the ghost button's hover tint
  ['brand-soft-text', 'brand-soft'],
  ['text-primary', 'bg-primary'],
  ['text-primary', 'bg-card'],
  ['text-secondary', 'bg-primary'],
  ['text-secondary', 'bg-card'],
];

/** The shared file keys its themes on `:root[data-theme=…]`; the website's
 *  own tokens on `[data-theme=…]`. Both match the attribute on <html>. */
const THEMES = {
  light: ["\n:root,\n:root[data-theme='light']", "\n:root,\n[data-theme='light']"],
  dark: [":root[data-theme='dark']", "\n[data-theme='dark']"],
};

test('computes the WCAG ratio', () => {
  assert.ok(Math.abs(contrast('#ffffff', '#000000') - 21) < 0.05);
  assert.ok(contrast('#ffffff', '#818cf8') < 4.5);
});

for (const [name, selectors] of Object.entries(THEMES)) {
  test(`keeps every rendered text pair at or above 4.5:1 in the ${name} theme`, () => {
    const tokens = block(selectors);
    for (const [text, bg] of TEXT_PAIRS) {
      assert.ok(tokens[text], `--${text} in ${name}`);
      assert.ok(tokens[bg], `--${bg} in ${name}`);
      const ratio = contrast(tokens[text], tokens[bg]);
      assert.ok(ratio >= 4.5, `--${text} on --${bg} in ${name}: ${ratio.toFixed(2)}:1`);
    }
  });
}

/** Every stylesheet the website ships, read from disk so a new component
 *  is covered without being listed. */
function componentSheets() {
  const root = new URL('../src/', import.meta.url);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.css')) out.push([path.pathname.slice(root.pathname.length), readFileSync(path, 'utf8')]);
    }
  };
  walk(root);
  return out;
}

/** A `var(--brand…, <literal>)` is a second colour the palette never
 *  defined, shown wherever the token is missing (the consent banner's icon
 *  shipped the old indigo that way after the palette moved), and the old
 *  indigo literals are the brand colour this palette replaced. Neither
 *  belongs in a stylesheet: a surface takes its colour from the shared
 *  tokens, or mixes one from --brand. */
test('no stylesheet carries a brand-token fallback or the retired indigo', () => {
  const offenders = [];
  for (const [file, css] of componentSheets()) {
    for (const m of css.matchAll(/var\(\s*--brand[\w-]*\s*,[^)]*\)/g)) offenders.push(`${file}: ${m[0]}`);
    for (const m of css.matchAll(/rgba?\(\s*99\s*,\s*102\s*,\s*241\b|#(?:6366f1|4f46e5|4338ca|3730a3|312e81|818cf8|a5b4fc|c7d2fe|e0e7ff|eef2ff)\b/gi)) offenders.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});
