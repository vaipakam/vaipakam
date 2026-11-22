#!/usr/bin/env node
/**
 * The gas suite's budget check (#3915, RefactorRulesDesign §5.1).
 *
 * `forge test --match-path "test/gas/*"` measures one isolated transaction per
 * user action and writes `out-gas-suite/<action>.json` (gas, slots written,
 * slots read, facet calls, events). This compares each with its row in
 * `contracts/gas-suite/budgets.json`:
 *
 *   - above its budget: a finding. A warning until the refactor pass ends
 *     (budgets.json `"blocking": false`), a failure after;
 *   - well below its budget (under `lowerAt` of it, default 80%): a note
 *     asking for a lower budget, so a budget tracks the code and does not
 *     leave room for a regression to hide in;
 *   - an action with no budget, or a budget with no measurement: a finding.
 *
 * Against `--base <budgets.json of the base commit>` it also refuses, always,
 * a budget RAISED without a changed reason: a raise is a decision, and the
 * row says why it was taken.
 *
 * Instant borrow is measured with 1, 2, 4 and 8 sources, and with one
 * skipped source before one fill (a skip refused early and one refused
 * late). Every instant-borrow figure here counts each price-guard read at the
 * guard's full read budget (`instantBorrow.guardReadGas`), since the suite's
 * guard is a mock. The largest count whose gas stays within
 * `instantBorrow.headroom` (80%) of the smallest transaction gas limit among
 * the networks listed is computed here, and must equal the file's
 * `instantBorrow.maxSources`.
 *
 * The source rule (design ruling 2026-11-22, instant borrow source cap): for
 * a fill bound b and a list of up to L sources, the first fill, plus (b - 1)
 * further fills, plus (L - b) skips, must stay within the headroom of the
 * smallest network limit. It is checked for the bound the deploy sets
 * (`instantBorrow.deployBound`), the code's default and the top of the range
 * governance may set, as the suite reads them from the code
 * (`out-gas-suite/config/instant.json`). A bound that breaks it is a finding.
 *
 * Measurements whose action starts with `_` are the suite's own probes (the
 * isolation demonstration) and are ignored.
 *
 * CLI: node contracts/script/check-gas-budgets.mjs [--dir out-gas-suite] [--budgets <file>] [--base <file>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const BUDGETS_FILE = join(CONTRACTS_DIR, 'gas-suite', 'budgets.json');
export const MEASURE_DIR = join(CONTRACTS_DIR, 'out-gas-suite');
const MIN_REASON = 20;

/** Every measurement in `dir`, by action, probes left out. */
export function readMeasurements(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    out[m.action ?? f.slice(0, -5)] = m;
  }
  const cfg = join(dir, 'config', 'instant.json');
  // Not an action: kept under a key no action can take.
  if (existsSync(cfg)) Object.defineProperty(out, '__instantConfig', { value: JSON.parse(readFileSync(cfg, 'utf8')), enumerable: false });
  return out;
}

/** An instant-borrow figure with every guard read at the guard's full read budget. */
export function fullGas(ib, m) {
  return m.gas + (m.guardReads ?? 0) * (ib.guardReadGas ?? 0);
}

/** The largest measured source count within the headroom of the smallest network limit. */
export function largestInstantCount(budgets, measured) {
  const ib = budgets.instantBorrow;
  if (!ib) return undefined;
  const limit = Math.min(...Object.values(ib.networkTxGasLimits ?? {}).map((x) => x.gas));
  const cap = Math.floor(limit * (ib.headroom ?? 0.8));
  let best = 0;
  for (const n of ib.sources ?? []) {
    const m = measured[`${ib.actionPrefix}${n}`];
    if (m && fullGas(ib, m) <= cap && n > best) best = n;
  }
  return { limit, cap, best };
}

/**
 * The source rule's terms from the measurements: the first fill, the dearest
 * further fill between two measured counts, and the dearest skip. Undefined
 * when a measurement it needs is missing.
 */
export function instantCosts(ib, measured) {
  const at = (n) => measured[`${ib.actionPrefix}${n}`];
  const counts = (ib.sources ?? []).filter((n) => at(n)).sort((a, b) => a - b);
  if (!counts.length || counts[0] !== 1 || counts.length < 2) return undefined;
  const first = fullGas(ib, at(1));
  let perFill = 0;
  for (let i = 1; i < counts.length; i++) {
    const [a, b] = [counts[i - 1], counts[i]];
    perFill = Math.max(perFill, Math.ceil((fullGas(ib, at(b)) - fullGas(ib, at(a))) / (b - a)));
  }
  const skips = (ib.skipActions ?? []).map((k) => measured[k]);
  if (!skips.length || skips.some((m) => !m)) return undefined;
  const skip = Math.max(0, ...skips.map((m) => fullGas(ib, m) - first));
  return { first, perFill, skip };
}

/** The source rule for a bound `b` and a list of up to `listMax` sources. */
export function sourceRuleCost(costs, b, listMax) {
  return costs.first + (b - 1) * costs.perFill + Math.max(0, listMax - b) * costs.skip;
}

/**
 * Compare. Returns `{ findings, notes, refusals }`: findings warn or fail by
 * `blocking`; refusals always fail; notes never do.
 */
export function compareBudgets(budgets, measured, base) {
  const findings = [];
  const notes = [];
  const refusals = [];
  const rows = budgets.actions ?? {};
  const lowerAt = budgets.lowerAt ?? 0.8;
  for (const [action, row] of Object.entries(rows)) {
    if (!Number.isInteger(row.gas) || row.gas <= 0) refusals.push(`${action}: budget gas must be a positive whole number`);
    if (typeof row.reason !== 'string' || row.reason.trim().length < MIN_REASON) refusals.push(`${action}: budget needs a reason of at least ${MIN_REASON} characters`);
    const m = measured[action];
    if (!m) {
      findings.push(`${action}: has a budget but no measurement (renamed or no longer measured?)`);
      continue;
    }
    if (m.gas > row.gas) findings.push(`${action}: ${m.gas} gas, over its budget of ${row.gas} by ${m.gas - row.gas}`);
    else if (m.gas < row.gas * lowerAt) notes.push(`${action}: ${m.gas} gas, under ${Math.round(lowerAt * 100)}% of its budget of ${row.gas}: lower the budget`);
    const b = base?.actions?.[action];
    if (b && Number.isInteger(row.gas) && row.gas > b.gas && row.reason === b.reason) {
      refusals.push(`${action}: budget raised from ${b.gas} to ${row.gas} without a changed reason`);
    }
  }
  for (const action of Object.keys(measured)) if (!rows[action]) findings.push(`${action}: measured but has no budget`);
  const ib = largestInstantCount(budgets, measured);
  if (ib) {
    if (!Number.isFinite(ib.limit)) refusals.push('instantBorrow: networkTxGasLimits lists no network');
    else if (ib.best !== budgets.instantBorrow.maxSources) {
      findings.push(`instantBorrow: the largest source count within ${ib.cap} gas (${Math.round((budgets.instantBorrow.headroom ?? 0.8) * 100)}% of ${ib.limit}) is ${ib.best}, but maxSources says ${budgets.instantBorrow.maxSources}`);
    }
  }
  if (ib && Number.isFinite(ib.limit)) {
    const ibCfg = budgets.instantBorrow;
    const costs = instantCosts(ibCfg, measured);
    const cfg = measured.__instantConfig;
    if (!costs) findings.push('instantBorrow: the source rule needs instant borrow at 1 and at least one more count, and every skip in skipActions');
    else if (!cfg) findings.push('instantBorrow: the source rule needs the code\'s fill bounds (out-gas-suite/config/instant.json)');
    else {
      const bounds = [['the deploy setting', ibCfg.deployBound], ['the code default', cfg.defaultBound], ['the top of the governance range', cfg.topBound]];
      for (const [what, b] of bounds) {
        if (!Number.isInteger(b)) {
          refusals.push(`instantBorrow: ${what} is not a whole number`);
          continue;
        }
        const cost = sourceRuleCost(costs, b, cfg.maxSources);
        if (cost > ib.cap) {
          findings.push(`instantBorrow: a bound of ${b} (${what}) with a list of ${cfg.maxSources} needs ${cost} gas (first ${costs.first}, ${b - 1} more at ${costs.perFill}, ${Math.max(0, cfg.maxSources - b)} skips at ${costs.skip}), over ${ib.cap}`);
        }
      }
    }
  }
  return { findings, notes, refusals };
}

export function main(argv = process.argv.slice(2)) {
  let dir = MEASURE_DIR;
  let budgetsPath = BUDGETS_FILE;
  let basePath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === '--budgets' && argv[i + 1]) budgetsPath = argv[++i];
    else if (argv[i] === '--base' && argv[i + 1]) basePath = argv[++i];
    else {
      console.error(`check-gas-budgets: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const base = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : undefined;
  const measured = readMeasurements(dir);
  if (!Object.keys(measured).length) {
    console.error(`  ✗ no measurements in ${relative(process.cwd(), dir)}: run forge test --match-path "test/gas/*" first`);
    return 1;
  }
  const { findings, notes, refusals } = compareBudgets(budgets, measured, base);
  for (const [a, m] of Object.entries(measured).sort()) {
    console.log(`  ${a.padEnd(34)} ${String(m.gas).padStart(9)} gas  ${String(m.slotsWritten).padStart(3)} written  ${String(m.slotsRead).padStart(3)} read  ${String(m.facetCalls).padStart(2)} facet calls  ${String(m.events).padStart(2)} events  (budget ${budgets.actions?.[a]?.gas ?? '—'})`);
  }
  const ib = largestInstantCount(budgets, measured);
  if (ib && Number.isFinite(ib.limit)) {
    console.log(`  instant borrow: up to ${ib.best} sources within ${ib.cap} gas, guard reads at their full budget`);
    const c = instantCosts(budgets.instantBorrow, measured);
    if (c) console.log(`  instant borrow: first fill ${c.first}, each further fill ${c.perFill}, each skip ${c.skip}`);
  }
  for (const n of notes) console.log(`  · ${n}`);
  for (const r of refusals) console.error(`  ✗ ${r}`);
  const mark = budgets.blocking ? '✗' : '⚠';
  for (const f of findings) (budgets.blocking ? console.error : console.log)(`  ${mark} ${f}`);
  if (refusals.length || (budgets.blocking && findings.length)) return 1;
  if (findings.length) console.log(`  ⚠ ${findings.length} gas finding(s): a warning until the refactor pass ends (gas-suite/budgets.json "blocking": false)`);
  else console.log('  ✓ gas budgets: every action within its budget');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
