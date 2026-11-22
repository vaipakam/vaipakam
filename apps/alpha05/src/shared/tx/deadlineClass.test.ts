/**
 * #3770 — every step that carries a deadline names its class in the one
 * table (`@vaipakam/lib/txDeadline`'s `TX_STEPS`), and a step whose call
 * carries a live price (a slippage floor, a quote, a route or a stated
 * minimum) is classed `live-price`, so a contract wallet's longer approval
 * window can never reach it. Read from the sources, so a new call site is
 * held without anyone listing it here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stepClass, TX_STEPS } from '@vaipakam/lib/txDeadline';

const SRC = path.resolve(__dirname, '../..');

/** Builders and names whose presence means the call carries a live price. */
const LIVE_PRICE_MARKERS = [/\bdirectSaleCall\b/, /\btakeoverCall\b/, /\binstantRequest\b/, /\bslippage\w*/i, /\bminOut\w*/i, /\bminAmountOut\b/, /\bswapToRepay\w*Call\b/, /\boffset\w*Call\b/, /\bhandover\w*Call\b/];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const USE = /\b(?:chainValidUntil|readValidUntil|stepWindow)\([^,()]*(?:\([^()]*\))?[^,()]*,\s*'(\w+)'/g;

const uses = sources(SRC)
  .filter((f) => !f.endsWith(path.join('tx', 'deadline.ts')))
  .map((f) => {
    const text = fs.readFileSync(f, 'utf8');
    return { file: path.relative(SRC, f), text, steps: [...text.matchAll(USE)].map((m) => m[1]!) };
  })
  .filter((u) => u.steps.length > 0);

describe('#3770: each deadline names its step class', () => {
  it('finds the call sites', () => expect(uses.length).toBeGreaterThan(10));
  it('names only steps the table declares', () => {
    for (const u of uses) for (const s of u.steps) expect(Object.keys(TX_STEPS), `${u.file}: ${s}`).toContain(s);
  });
  it('classes every step whose call carries a live price as live-price', () => {
    for (const u of uses) {
      if (!LIVE_PRICE_MARKERS.some((m) => m.test(u.text))) continue;
      for (const s of u.steps) expect(stepClass(s), `${u.file}: ${s}`).toEqual({ kind: 'short', why: 'live-price' });
    }
  });
});
