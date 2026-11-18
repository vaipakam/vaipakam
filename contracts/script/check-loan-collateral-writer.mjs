#!/usr/bin/env node
/**
 * check-loan-collateral-writer.mjs — a loan's collateral amount has ONE
 * writer after origination (#3710).
 *
 * A lower collateral amount is value leaving the loan's positions, so every
 * change goes through `src/libraries/LibLoanCollateral.sol` (`reduce`, `add`,
 * `set`), which marks the loan's position tokens: their state number goes up,
 * they wait before they can move, and their metadata is flagged for refresh.
 * A write anywhere else would lower the collateral a buyer was shown without
 * that mark, so this check fails on any write to a stored loan's
 * `collateralAmount` in src/ outside that library, unless the site is LISTED
 * below with its reason.
 *
 * It uses the loan-terms writer check's AST walk (same artifacts, same rules
 * for what a write is), on this one field and without counting whole-record
 * writes, which that check already holds to origination.
 *
 * CLI: node contracts/script/check-loan-collateral-writer.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { termWriteSites, verdict as termsVerdict } from './check-loan-terms-writer.mjs';

/** The library every collateral-amount write goes through. */
export const HOME = 'src/libraries/LibLoanCollateral.sol';
export const FIELDS = new Set(['collateralAmount']);

/**
 * The sites outside {HOME} that may write the field, with why. Origination is
 * the only one: the loan record is written before anyone holds a token for it.
 */
export const ALLOWED = [
  {
    site: 'src/facets/LoanFacet.sol:LoanFacet._copyFinancialFields',
    writes: 2,
    reason:
      'Origination writes the loan record before its position tokens exist, so there is no holder or buyer to mark for.',
  },
];

/** Every write to a stored loan's collateral amount in src/ outside {HOME}. Pure. */
export function collateralWriteSites(units, { sourceText = () => undefined } = {}) {
  return termWriteSites(units, { home: HOME, sourceText, fields: FIELDS, wholeRecord: false });
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  return termsVerdict(sites, allowed).map((p) =>
    p
      .replace("to a loan's principal or rate outside LibInterestLedger", "to a loan's collateral amount outside LibLoanCollateral")
      .replace('use reducePrincipal / writeOffPrincipal / setRate', 'use LibLoanCollateral.reduce / add / set')
      .replace('writes neither field any more', 'no longer writes the collateral amount'),
  );
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-loan-collateral-writer: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let build;
  try {
    build = loadBuild(outDir);
  } catch (e) {
    console.error(`  ✗ cannot read ${outDir}: ${e.message} — run check-measured-delivery.mjs first, or pass --out`);
    return 1;
  }
  if (build.problems.length) {
    for (const p of build.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const units = [...build.units.values()];
  if (!units.some((u) => u.absolutePath === HOME)) {
    console.error(`  ✗ ${HOME} is not among the compiled sources — the check would see nothing`);
    return 1;
  }
  const sites = collateralWriteSites(units, {
    sourceText: (p) => {
      try {
        return readFileSync(join(CONTRACTS_DIR, p));
      } catch {
        return undefined;
      }
    },
  });
  const problems = verdict(sites);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const total = [...sites.values()].reduce((n, s) => n + s.writes, 0);
  console.log(`  ✓ a loan's collateral amount is written only through LibLoanCollateral, or at a listed site (${sites.size} listed, ${total} writes)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
