/**
 * #2390 — no app source may reach viem's `parseUnits`.
 *
 * `parseUnits` ROUNDS a value with more fractional digits than the token
 * has (`0.0000009` at six decimals becomes one base unit; `0.6` at zero
 * decimals becomes one whole token). On a typed amount that means the
 * confirmation states one figure and the contract moves another. Every
 * money input therefore parses through `parseExactUnits` /
 * `exactUnitsOrNull` (`lib/format.ts`), which refuse excess precision and
 * let `AmountPrecisionHint` name it.
 *
 * This file is what keeps a NEW form from regressing: it fails when any
 * non-test source under `src/` imports `parseUnits` from viem (under any
 * alias) or calls it through a namespace. The allowlist is for call
 * sites whose input is program-controlled, never typed — each entry says
 * why. Tests are exempt: they build fixtures from literal strings.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Path (relative to src/, forward slashes) → why it may use parseUnits. */
const ALLOWLIST: Record<string, string> = {
  // Mints a fixed whole-unit preset (`units` is a number from the faucet
  // button table, never user text), so there is nothing to round.
  'pages/Faucet.tsx': 'program-controlled whole-unit preset',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** True when `text` imports parseUnits from viem or calls it on a namespace. */
function reachesParseUnits(text: string): boolean {
  const viemImports = text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]viem['"]/g);
  for (const m of viemImports) {
    if (/\bparseUnits\b/.test(m[1])) return true;
  }
  return /\.\s*parseUnits\s*\(/.test(text);
}

describe('exact amount parsing guard (#2390)', () => {
  it('detects the shapes it is meant to refuse', () => {
    expect(reachesParseUnits("import { parseUnits } from 'viem';")).toBe(true);
    expect(reachesParseUnits("import {\n  formatUnits,\n  parseUnits as pu,\n} from 'viem';")).toBe(true);
    expect(reachesParseUnits('const x = viem.parseUnits(a, 6);')).toBe(true);
    expect(reachesParseUnits("import { formatUnits } from 'viem';")).toBe(false);
    // A mention in prose is not a call.
    expect(reachesParseUnits("// viem's parseUnits rounds")).toBe(false);
  });

  it('finds no non-test source using parseUnits outside the allowlist', () => {
    const offenders = sources(SRC)
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .filter((rel) => !(rel in ALLOWLIST))
      .filter((rel) => reachesParseUnits(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlist entry live — a stale entry would silently widen the exemption', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(reachesParseUnits(readFileSync(join(SRC, rel), 'utf8')), rel).toBe(true);
    }
  });
});
