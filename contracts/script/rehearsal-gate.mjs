#!/usr/bin/env node
/**
 * rehearsal-gate.mjs — the gate a real fresh deploy passes before its first
 * broadcast (#3896; deploy rehearsal design sections 8 and 18).
 *
 *   check --network <testnet|mainnet> --chain <slug> --plan <file>
 *         --input-digest <hex> [--verdicts <dir>] [--now <unix>]
 *         [--without-rehearsal <reason>]
 *       Accepts when a rehearsal verdict under <dir> (default: every run under
 *       `contracts/deployments/.forge-test/rehearsal/`) passed, and its commit,
 *       tree digest, input digest, plan digest, network and chain set equal the
 *       present ones, the chain is in that set, and its forks were taken less
 *       than {@link MAX_AGE_HOURS} hours ago. Otherwise it prints, for the
 *       newest verdict found, every value that differs, and refuses.
 *
 *       The present values are worked out here, the same way the rehearsal
 *       records them: the commit and tree digest from `rehearsal-tree.mjs`,
 *       the plan digest as the plan file's SHA-256, the chain set from the
 *       plan's `chains` line. The input digest is passed in: the deploy script
 *       computes it right after it loads `.env`, before it derives anything,
 *       which is the point at which the rehearsal driver computes its own.
 *       The plan's `# desired <file> sha256 <hex>` line is checked too, so a
 *       desired-state file changed after the plan was made is refused.
 *
 *       `--without-rehearsal <reason>` is the emergency override. It needs a
 *       reason with words in it; it still prints what differs, and its result
 *       carries the reason so the deploy can write it into the phase marker
 *       and the chain's history record.
 *
 *       On acceptance it prints one JSON line: the verdict's path and SHA-256
 *       (or the override), what was compared, and when.
 *
 * The verdict is a local file. This gate guards against mistakes (a deploy
 * from another commit, other inputs, another plan, a stale rehearsal), not
 * against someone who means to skip it, and its refusal says so.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, treeDigest } from './rehearsal-tree.mjs';

const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');

/**
 * How old a rehearsal's forks may be. Fixed by the design (section 25 item 5,
 * settled 2026-11-22): it changes by a change to the design, never by a flag,
 * so a verdict's own `maxAgeHours` is not read.
 */
export const MAX_AGE_HOURS = 24;

/** Where the rehearsal driver writes each run (`rehearse.sh`, VAIPAKAM_REHEARSAL_ROOT). */
export const DEFAULT_VERDICTS = join(CONTRACTS_DIR, 'deployments', '.forge-test', 'rehearsal');

export const NOT_A_LOCK =
  'The verdict is a local file: this gate guards against deploying something other than what was rehearsed, not against someone who means to skip it.';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * What a plan file says about itself: its digest, its chain set, and the
 * desired-state file it was made from with that file's hash.
 */
export function readPlan(text) {
  const lines = text.split('\n');
  let chains = null;
  let desired = null;
  for (const raw of lines) {
    const line = raw.trim();
    const d = /^#\s*desired\s+(\S+)\s+sha256\s+([0-9a-f]{64})\s*$/.exec(line);
    if (d && !desired) desired = { path: d[1], sha256: d[2] };
    if (!line || line.startsWith('#')) continue;
    const words = line.split(/\s+/);
    if (words[0] === 'chains' && !chains) chains = words.slice(1);
  }
  return { planDigest: sha256(text), chains, desired };
}

/**
 * Every value in which `verdict` differs from `present`, as one sentence
 * each. Empty means the verdict covers this deploy.
 */
export function differences(verdict, present, nowSec) {
  const out = [];
  if (verdict.kind !== 'vaipakam-deploy-rehearsal-verdict') return ['it is not a rehearsal verdict'];
  if (verdict.result !== 'pass') out.push(`the rehearsal did not pass (result ${verdict.result || 'none'}${verdict.failedStage ? `, at ${verdict.failedStage}` : ''})`);
  if (verdict.network !== present.network) out.push(`network: rehearsed ${verdict.network || 'none'}, deploying ${present.network}`);
  for (const k of ['commit', 'treeDigest', 'inputDigest', 'planDigest']) {
    if (!verdict[k] || verdict[k] !== present[k]) out.push(`${k}: rehearsed ${verdict[k] || 'none'}, now ${present[k]}`);
  }
  const rehearsed = Array.isArray(verdict.chains) ? [...verdict.chains].sort() : [];
  const now = [...present.chains].sort();
  if (rehearsed.join(' ') !== now.join(' ')) out.push(`chain set: rehearsed ${rehearsed.join(' ') || 'none'}, the plan names ${now.join(' ')}`);
  if (!present.chains.includes(present.chain)) out.push(`${present.chain} is not in the plan's chain set (${now.join(' ')})`);
  const taken = Number(verdict.forkTakenAt);
  if (!Number.isFinite(taken) || taken <= 0) out.push('the verdict records no fork time');
  else if (taken > nowSec + 300) out.push('the verdict says its forks were taken in the future');
  else if (nowSec - taken >= MAX_AGE_HOURS * 3600) {
    out.push(`the forks are ${((nowSec - taken) / 3600).toFixed(1)} hours old; a verdict is valid for ${MAX_AGE_HOURS} hours`);
  }
  return out;
}

/** Every `verdict.json` one level under `dir` (one per rehearsal run), newest first. */
export function findVerdicts(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name, 'verdict.json');
    if (!existsSync(f)) continue;
    const text = readFileSync(f);
    let verdict;
    try {
      verdict = JSON.parse(text.toString('utf8'));
    } catch {
      continue;
    }
    out.push({ path: f, sha256: sha256(text), verdict, mtime: statSync(f).mtimeMs });
  }
  return out.sort((a, b) => (Number(b.verdict.forkTakenAt) || 0) - (Number(a.verdict.forkTakenAt) || 0) || b.mtime - a.mtime);
}

/**
 * The gate's decision: the first verdict with no difference, else a refusal
 * naming the differences of the newest one (the run the operator most likely
 * meant). An override accepts, carrying its reason and what differed.
 */
export function decide(found, present, nowSec, override) {
  const match = found.find((f) => differences(f.verdict, present, nowSec).length === 0);
  if (match) return { ok: true, verdict: match };
  const newest = found[0];
  const diffs = newest ? differences(newest.verdict, present, nowSec) : ['no rehearsal verdict was found'];
  if (override !== undefined) {
    if (!/[A-Za-z]{3,}/.test(String(override).trim())) return { ok: false, newest, diffs, badOverride: true };
    return { ok: true, override: String(override).trim(), newest, diffs };
  }
  return { ok: false, newest, diffs };
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), now = Math.floor(Date.now() / 1000)) {
  const [cmd, ...args] = argv;
  if (cmd !== 'check') {
    console.error('usage: rehearsal-gate.mjs check --network <n> --chain <slug> --plan <file> --input-digest <hex> [--verdicts <dir>] [--now <unix>] [--without-rehearsal <reason>]');
    return 2;
  }
  const network = option(args, '--network');
  const chain = option(args, '--chain');
  const planFile = option(args, '--plan');
  const inputDigest = option(args, '--input-digest');
  const verdicts = resolve(option(args, '--verdicts') ?? DEFAULT_VERDICTS);
  const nowSec = option(args, '--now') ? Number(option(args, '--now')) : now;
  const overrideAt = args.indexOf('--without-rehearsal');
  const override = overrideAt >= 0 ? (args[overrideAt + 1] ?? '') : undefined;

  if (!network || !chain || !/^[0-9a-f]{64}$/.test(inputDigest ?? '')) {
    console.error('  ✗ rehearsal gate: --network, --chain and --input-digest are required (the deploy script supplies them)');
    return 2;
  }
  // Without a plan there is nothing to compare; only the override can pass.
  let plan = null;
  const planProblems = [];
  if (!planFile) planProblems.push('no plan was named: pass --plan <the plan file the rehearsal ran>');
  else if (!existsSync(planFile)) planProblems.push(`the plan file ${planFile} does not exist`);
  else {
    plan = readPlan(readFileSync(planFile, 'utf8'));
    if (!plan.chains) planProblems.push(`the plan ${planFile} has no chains line`);
    if (!plan.desired) planProblems.push(`the plan ${planFile} names no desired-state file`);
    else {
      const p = isAbsolute(plan.desired.path) ? plan.desired.path : join(CONTRACTS_DIR, plan.desired.path);
      if (!existsSync(p)) planProblems.push(`the desired-state file ${plan.desired.path} the plan was made from is missing`);
      else if (sha256(readFileSync(p)) !== plan.desired.sha256) planProblems.push(`the desired-state file ${plan.desired.path} changed since the plan was made`);
    }
  }

  const { commit, digest } = treeDigest();
  const present = { network, chain, commit, treeDigest: digest, inputDigest, planDigest: plan?.planDigest ?? '', chains: plan?.chains ?? [] };
  const result = planProblems.length
    ? override !== undefined && /[A-Za-z]{3,}/.test(String(override).trim())
      ? { ok: true, override: String(override).trim(), diffs: planProblems }
      : { ok: false, diffs: planProblems, badOverride: override !== undefined }
    : decide(findVerdicts(verdicts), present, nowSec, override);

  const rel = (p) => relative(REPO_ROOT, p);
  if (!result.ok) {
    console.error(`  ✗ rehearsal gate: no green rehearsal covers this deploy of ${chain}.`);
    if (result.newest) console.error(`    newest verdict: ${rel(result.newest.path)}`);
    for (const d of result.diffs) console.error(`    - ${d}`);
    if (result.badOverride) console.error('    --without-rehearsal needs a reason in words, which is written into the phase marker and the history record.');
    console.error('    Rehearse this commit, inputs and plan (script/rehearse.sh), or, in an emergency, pass --without-rehearsal "<reason>".');
    console.error(`    ${NOT_A_LOCK}`);
    return 1;
  }
  const at = new Date(nowSec * 1000).toISOString();
  if (result.override !== undefined) {
    console.error(`  ! rehearsal gate overridden for ${chain}: ${result.override}`);
    for (const d of result.diffs) console.error(`    - not covered: ${d}`);
    console.log(JSON.stringify({ gate: 'overridden', reason: result.override, notCovered: result.diffs, chain, network, commit, treeDigest: digest, inputDigest, planDigest: present.planDigest, checkedAt: at }));
    return 0;
  }
  const v = result.verdict;
  console.error(`  ✓ rehearsal gate: ${rel(v.path)} covers this deploy of ${chain} (forks taken ${new Date(Number(v.verdict.forkTakenAt) * 1000).toISOString()})`);
  console.log(
    JSON.stringify({
      gate: 'passed',
      verdict: rel(v.path),
      verdictSha256: v.sha256,
      chain,
      network,
      commit,
      treeDigest: digest,
      inputDigest,
      planDigest: present.planDigest,
      chains: present.chains,
      forkTakenAt: Number(v.verdict.forkTakenAt),
      checkedAt: at,
    }),
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
