#!/usr/bin/env node
/**
 * check-loan-start-term-writer.mjs — a loan's start and term are written only
 * by the steps that ask the Terms rule (#3734).
 *
 * A wallet that takes on a new loan term must have accepted the Terms in
 * force. A new term is written as a new `startTime` and `durationDays` on the
 * stored loan, so every site that writes either field must be a step that
 * asks `LibTerms.requireCurrent` for the wallets taking the term on. Today
 * there are three, each listed below with the wallets it asks for. Any other
 * write in src/ fails this check, so a new way to extend or re-originate a
 * loan cannot ship without the rule, and a listed site that no longer writes
 * fails too.
 *
 * It uses the loan-terms writer check's AST walk (same artifacts, same rules
 * for what a write is), on these two fields and without counting whole-record
 * writes, which that check already holds to origination. There is no home
 * library: every writer is listed.
 *
 * CLI: node contracts/script/check-loan-start-term-writer.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { termWriteSites, verdict as termsVerdict } from './check-loan-terms-writer.mjs';

export const FIELDS = new Set(['startTime', 'durationDays']);

/** The library that holds the rule; it must be among the compiled sources. */
export const RULE = 'src/libraries/LibTerms.sol';

/** The sites that may write a loan's start or term, and whom each asks. */
export const ALLOWED = [
  {
    site: 'src/facets/LoanFacet.sol:LoanFacet._copyFinancialFields',
    writes: 2,
    reason:
      'Origination, reached only from initiateLoan, which asks the rule for the offer maker (unless the offer is a lender-sale vehicle) and the acceptor first.',
  },
  {
    site: 'src/facets/AutoLifecycleFacet.sol:AutoLifecycleFacet.extendLoanInPlace',
    writes: 2,
    reason:
      'The in-place extension asks the rule for the wallets that manage the lender and the borrower positions at that moment, before it writes.',
  },
  {
    site: 'src/facets/PrecloseFacet.sol:PrecloseFacet.transferObligationViaOffer',
    writes: 2,
    reason:
      'The obligation handover re-originates the term for the incoming borrower, whom LibLoan.migrateBorrowerPosition checks in the same transaction (a refusal unwinds the write).',
  },
];

/** Every write to a stored loan's start or term in src/. Pure. */
export function startTermWriteSites(units, { sourceText = () => undefined } = {}) {
  return termWriteSites(units, { home: '', sourceText, fields: FIELDS, wholeRecord: false });
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  return termsVerdict(sites, allowed).map((p) =>
    p
      .replace(
        "to a loan's principal or rate outside LibInterestLedger",
        "to a loan's start or term outside the steps that ask the Terms rule",
      )
      .replace(
        'use reducePrincipal / writeOffPrincipal / setRate',
        'ask LibTerms.requireCurrent for every wallet taking the term on, then list the site with its reason',
      )
      .replace('writes neither field any more', 'no longer writes the start or term'),
  );
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-loan-start-term-writer: unknown argument ${argv[i]}`);
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
  if (!units.some((u) => u.absolutePath === RULE)) {
    console.error(`  ✗ ${RULE} is not among the compiled sources — the check would see nothing`);
    return 1;
  }
  const sites = startTermWriteSites(units, {
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
  console.log(`  ✓ a loan's start and term are written only by the steps that ask the Terms rule (${sites.size} listed, ${total} writes)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
