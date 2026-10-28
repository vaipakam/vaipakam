/**
 * Holds `e2e/COVERAGE.md` to its shape (#2143): every row inside a table
 * with no more cells than its columns, every cell within the cap,
 * every link into `e2e/COVERAGE-NOTES.md` landing, every notes section
 * linked. The rule and its reasons are in `e2e/lib/coverageMatrix.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoverageMatrix } from '../e2e/lib/coverageMatrix';

const e2e = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'e2e');
const problems = checkCoverageMatrix(
  readFileSync(resolve(e2e, 'COVERAGE.md'), 'utf8'),
  readFileSync(resolve(e2e, 'COVERAGE-NOTES.md'), 'utf8'),
);
if (problems.length > 0) {
  for (const p of problems) {
    console.error(`[check-coverage-matrix] COVERAGE.md${p.line ? `:${p.line}` : ''} — ${p.message}`);
  }
  process.exit(1);
}
console.log('[check-coverage-matrix] OK — every matrix row within its table and the cap, and every notes link lands.');
