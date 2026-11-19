#!/usr/bin/env node
/**
 * check-loan-accrual-writer.mjs — a loan's interest accrual is restarted, and
 * its settled interest written, only through their two writers (#3779).
 *
 * Whether an interest period is short is read from one figure: the interest
 * the current accrual segment has accrued through the period's boundary, less
 * the interest already settled on that segment
 * (`LibPeriodicInterest.periodShortfall`). That reading is right only if every
 * restart of the segment charged what had accrued and carried what was paid
 * ahead. So `interestAccrualStart` is written only by
 * `LibInterestLedger.restartAccrual`, the one restart writer, and
 * `interestSettled` only by that writer, by the ledger's scaling of it when a
 * partial internal match clears principal that pays no interest
 * (`reducePrincipalUnpaidSlice`), and by `LibInterestPayment.book`, the one
 * booking of interest paid on an open loan. Any other write in src/ fails
 * this check, and a listed site that no longer writes fails too.
 *
 * It uses the loan-terms writer check's AST walk (same artifacts, same rules
 * for what a write is), on these two fields and without counting whole-record
 * writes, which that check already holds to origination.
 *
 * CLI: node contracts/script/check-loan-accrual-writer.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { termWriteSites, verdict as termsVerdict } from './check-loan-terms-writer.mjs';

export const FIELDS = new Set(['interestAccrualStart', 'interestSettled']);

/** The library that holds the restart writer. */
export const HOME = 'src/libraries/LibInterestLedger.sol';

/** The one other site that may write either field, and why. */
export const ALLOWED = [
  {
    site: 'src/libraries/LibInterestPayment.sol:LibInterestPayment.book',
    writes: 1,
    reason:
      'The one booking of interest paid on an open loan adds what arrived to the settled interest; the accrual is not restarted.',
  },
];

/** Every write to a stored loan's accrual start or settled interest in src/ outside {HOME}. Pure. */
export function accrualWriteSites(units, { sourceText = () => undefined } = {}) {
  return termWriteSites(units, { home: HOME, sourceText, fields: FIELDS, wholeRecord: false });
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  return termsVerdict(sites, allowed).map((p) =>
    p
      .replace(
        "to a loan's principal or rate outside LibInterestLedger",
        "to a loan's accrual start or settled interest outside LibInterestLedger",
      )
      .replace('use reducePrincipal / writeOffPrincipal / setRate', 'use LibInterestLedger.restartAccrual or LibInterestPayment.book')
      .replace('writes neither field any more', 'no longer writes the accrual start or settled interest'),
  );
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-loan-accrual-writer: unknown argument ${argv[i]}`);
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
  const sites = accrualWriteSites(units, {
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
  console.log(`  ✓ a loan's accrual is restarted only by LibInterestLedger.restartAccrual, and its settled interest written only in LibInterestLedger and by LibInterestPayment.book`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
