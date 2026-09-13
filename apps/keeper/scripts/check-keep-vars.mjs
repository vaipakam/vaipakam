#!/usr/bin/env node
/**
 * check-keep-vars — every Worker holding operator-managed vars declares that
 * a deploy will not delete them.
 *
 * WHY THIS EXISTS (#1995). Wrangler treats the config file as the source of
 * truth for environment configuration: on deploy it DELETES every var that is
 * not in the file before setting the ones that are. So any value managed only
 * in the Cloudflare dashboard is wiped by an ordinary deploy — for the keeper
 * that is `HF_SCALE`, the `LIQ_*` confidence thresholds,
 * `SPLIT_MIN_IMPROVEMENT_BPS` and `PARTIAL_LIQ_MIN_HF_BPS`; for the agent,
 * `RECIPIENT_VALIDATING_TOKENS` and `OPENSEA_OFFERS_MAX_PAGES`. Losing them
 * reverts liquidation behaviour to defaults silently, at the moment it starts
 * mattering.
 *
 * The original defence required `--keep-vars` on every invocation, and
 * `check-deploy-invocations.mjs` searched the tree for invocations lacking it.
 * That predicate is unbounded — a deploy can be spelled through a package
 * script, a manifest alias, a Makefile variable, a sourced helper, a shell
 * function or alias, a matrix expression, a reusable-workflow input, a Windows
 * shim, `eval`, or a marketplace action — and #1995 answered 242 review
 * findings enumerating them without reaching the end.
 *
 * `keep_vars` is the bounded question instead: wrangler reads it on BOTH the
 * deploy path (`props.keepVars || config.keep_vars`) and for `versions
 * upload`, so declaring it makes every spelling safe at once, including the
 * ones nobody has written yet. This file asserts the declaration.
 *
 * THE TREE-WIDE SCANNER IS RETIRED, and this file is now the whole defence.
 * #1995 (2026-08-31) kept `check-deploy-invocations.mjs` as defence in depth
 * on top of the declaration. The thirteen days that followed showed what that
 * cost: fourteen open issues (#2110, #2112–#2119, #2121–#2124, #2126), every
 * one an edge of the same predicate — a folded YAML scalar's offsets, a
 * settable `.RECIPEPREFIX`, a PowerShell here-string, a case-varied variable
 * name, an upper-case file extension, a semicolon after an assignment — and
 * four of them FALSE REPORTS that redden a correct tree. Each was a
 * constructed example; none named a file in this repository. Reading
 * arbitrary text and deciding whether it will run a command requires the
 * execution model of every interpreter it might be, and 23,800 lines of
 * scanner and fixtures did not get there. Deleting the predicate is the fix
 * the record asks for, the same move as #2066 (a declaration heuristic
 * deleted after six rounds) and #2149 (a speculative branch deleted at round
 * 13). Thirteen days is a short observation window and the reader should
 * weigh it as one; what argues for the retirement is the SHAPE of the
 * findings, not their elapsed time.
 *
 * ONE THING THE SCANNER CAUGHT IS KEPT, in bounded form. It rejected a deploy
 * or `versions upload` pointed by `--config` at a different configuration
 * file, since the canonical config's declaration is then not the one wrangler
 * loads. That coverage is real, and is preserved below as an assertion over
 * FILES rather than over commands — see the long note above `SKIP_BASENAMES`,
 * which is where the rule and the reasoning for its shape live.
 *
 * WHAT IT STILL ACCEPTS, stated rather than implied, because a defence that
 * has shrunk should say what it no longer covers:
 *
 *   - A deploy that OVERRIDES the declaration on the command line. Whether
 *     wrangler honours a negating spelling such as `--no-keep-vars` against a
 *     config that sets the key has not been verified here, and the retired
 *     scanner did not look for it either — it searched for a MISSING flag, and
 *     went quiet entirely once a Worker declared `keep_vars`. So this is an
 *     exposure the retirement inherits, not one it creates.
 *   - A configuration GENERATED OR REWRITTEN at deploy time. This is coverage
 *     the retirement REMOVES, not an inherited gap, and an earlier revision of
 *     this header said the opposite. Review disproved it by naming three of
 *     the deleted scanner's own fixtures (#2171 r3, P1): `a config ABSENT from
 *     the checkout falls back to the directory`, `a config REWRITTEN before the
 *     deploy is not read from the checkout`, and `an explicit selector does not
 *     borrow the package config`. The scanner did not read a generated file
 *     either — it FELL BACK to judging the command on its own terms and
 *     reported, which is a defence a file scan structurally cannot offer. So
 *     this one wants the owner's acceptance rather than a note.
 *   - A checked-in wrangler config named outside the `wrangler*` convention.
 *     See THE ONE MISS in the note below for why recognising it would cost
 *     false reports.
 *
 * WHY IT RUNS UNCONDITIONALLY, and does not live only in the keeper's Vitest
 * suite. The Workers it checks span `apps/` and `ops/`, while the only CI job
 * running that suite is path-gated to `apps/(app|indexer|keeper)` — so an
 * agent-only or ops-only change could remove the key with the invariant
 * skipped, which is precisely the change it exists to catch (Codex #1995 r22).
 * Same reasoning as `check-d1-name-consistency`, and it takes the same shape:
 * node builtins only, so the job needs no install step.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Overridable so the invariant can be exercised against a COPIED tree. The
// suite proving this check fails when the key is removed must not remove the
// key from the real configs to do it: a crash or a kill between the write and
// the restore would leave the developer's worktree in exactly the unsafe state
// this check exists to prevent, and JavaScript cleanup does not run after
// process termination (Codex #1995 r23). Same override the deploy guard has
// carried since it was written, for the same reason.
const REPO_ROOT = (
  process.env.CHECK_KEEP_VARS_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
).replace(/\/$/, '');

/**
 * Workers whose config declares plain-text `vars`, so a deploy can wipe them.
 *
 * THIS LIST NO LONGER GATES THE `keep_vars` REQUIREMENT — every wrangler
 * config declares it, `apps/app` and `apps/www` included, for the reasons in
 * the note above `SKIP_BASENAMES`. What the list still does is narrower and
 * worth keeping: it names the Workers that have something to LOSE, which is what
 * the per-Worker mutation fixtures exercise and what the `vars`-block
 * staleness assertion below is about. A Worker absent from it is still
 * required to preserve; it simply has nothing at stake yet.
 */
const VAR_CARRYING_WORKERS = [
  'apps/agent',
  'apps/keeper',
  'apps/indexer',
  'ops/mesh-watcher',
  'ops/offchain-data-warm',
];

import { parseJsonc } from './lib/jsonc.mjs';

function readJsonc(relPath) {
  return parseJsonc(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
}

const problems = [];

/**
 * THE PRELIMINARY VALIDATION PASS THAT USED TO SIT HERE IS GONE (#2171 r5).
 *
 * It walked `apps/*` and `ops/*` one level down for a canonical
 * `wrangler.json(c)` and required `keep_vars` on any that declared `vars`.
 * Once the whole-tree walk below became unconditional, every assertion it made
 * was a duplicate — and duplicates do not stay in step: the Pages exemption
 * was added to the walk and NOT to this pass, so a valid Pages project
 * declaring `vars` (a field wrangler does support for Pages) was rejected for
 * lacking a field wrangler refuses to accept from Pages. No version of that
 * file could pass, which is the same impossible state the exemption exists to
 * prevent, reintroduced by the copy.
 *
 * Its one non-duplicate contribution — telling you to add a newly
 * var-carrying Worker to `VAR_CARRYING_WORKERS` so the mutation fixtures cover
 * it — now lives in the single pass below, where it cannot drift from the rule
 * it accompanies. Two passes over the same question is how the first bug got
 * in; one pass is the fix.
 */
/**
 * EVERY config in the tree that NAMES a var-carrying Worker, not only the
 * canonical one in that Worker's own directory.
 *
 * A deploy or `versions upload` can be pointed at a different configuration
 * file (`--config unsafe.jsonc`), and the canonical config's declaration is
 * then not the one wrangler loads. The retired command scanner caught that
 * case, and only that case, out of everything it attempted — Codex raised it
 * as a P1 on #2171 and was right: retiring the scanner without this would have
 * traded away real coverage while the pull request claimed it traded away
 * none.
 *
 * The answer is NOT to restore command parsing. The bounded form of the same
 * assertion is about FILES: any configuration that names a var-carrying Worker
 * must declare preservation, whichever command happens to select it. That
 * needs no execution model, no notion of which text is a command, and no
 * knowledge of how a deploy is spelled.
 *
 * AND IT SCOPES BY NOTHING AT ALL. The first attempt tried to decide WHICH
 * configs mattered — those whose top-level `name` matched a var-carrying
 * Worker and which carried a `compatibility_date`, under `apps/` or `ops/`.
 * Review returned SIX P1s against that predicate in one round (#2171 r2), and
 * every one was a different way for a deploy to reach a protected Worker
 * through a config the predicate had excluded: `--name` overrides the stored
 * name; `--compatibility-date` supplies the date the config lacks; `--env
 * staging` merges an `env.staging.name`; `--config configs/www.jsonc` reaches
 * outside both roots; a sixth Worker's alternate config is not in the derived
 * name set. Answering those needs wrangler's CLI-and-config merge semantics —
 * the same unbounded inference, moved from shell text into JSON, and the
 * exact mistake this pull request exists to stop repeating.
 *
 * So there is no scoping question left to get wrong: **every wrangler config
 * in the tracked tree declares preservation**, whatever it names, wherever it
 * sits, whether or not that Worker has vars today. A config is identified by
 * WRANGLER'S OWN FILENAME CONVENTION (`wrangler*.json`/`.jsonc`/`.toml`),
 * which is a total test on a string, not a judgement about content.
 *
 * TWO EXCEPTIONS, and both come from wrangler's own rules rather than from a
 * judgement this file makes — see the code for each:
 *
 *   - A NAMED ENVIRONMENT is not separately required to declare the key.
 *     `keep_vars` is top-level-only; wrangler rejects it inside `env.<name>`
 *     and reads the top-level value after environment selection.
 *   - A PAGES CONFIG is exempt, keyed on `pages_build_output_dir`. Wrangler
 *     refuses `keep_vars` for Pages outright, so requiring it would leave no
 *     version of the file that satisfies both this check and the tool.
 *
 * An intermediate revision of this file required the key in every `env.<name>`
 * block, and said so right here, on the reasoning that inheritance "could not
 * be verified". Review established that it is top-level-only (#2171 r3), the
 * code changed, and this paragraph did not — which is how a maintainer ends up
 * restoring an unsupported field on the strength of the design note (#2171
 * r4). The rule is stated once per exception, beside the code that applies it.
 *
 * The cost is that two Workers with no `vars` at all — `apps/app`, `apps/www`
 * — now declare the key as well. That is the point rather than a side effect:
 * classifying them was the thing that kept going wrong, and a Worker that
 * later grows a dashboard value is already safe. It costs them the same trade
 * the others already accept — a deploy can no longer REMOVE a var, which
 * becomes a deliberate dashboard action.
 *
 * THE ONE MISS, and it is one rather than six: a wrangler config checked in
 * under a name that does not begin `wrangler`. `--config` accepts any path,
 * so such a file is reachable and this check will not see it. Recognising it
 * would mean classifying arbitrary JSON by its contents, which is where the
 * false reports come from — the first draft of the round-one rule turned the
 * tree red on `ops/mesh-watcher/package.json` because it shares the Worker's
 * name. The convention is therefore stated as a rule for contributors:
 * a wrangler config is named `wrangler*.jsonc`.
 */

/**
 * Directories skipped by BASENAME — each unambiguously vendored or generated,
 * anywhere it appears.
 *
 * `lib` was in this list and had to come out (#2171 r3, P1). It is a real
 * directory name in this repo twice: `contracts/lib` is vendored submodules,
 * but `packages/lib` is OUR code — so skipping the basename hid
 * `packages/lib/wrangler.*.jsonc` from a check whose whole claim is "any depth,
 * any directory". A skip list keyed on a name that a source directory can also
 * have is not a skip list, it is a hole.
 */
const SKIP_BASENAMES = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  '.turbo',
  '.next',
  'coverage',
  'test-results',
  'playwright-report',
  'dist',
  'build',
]);

/**
 * Directories skipped by EXACT PATH, because their names are ambiguous.
 *
 * These hold vendored submodules and build artifacts; each is named in full so
 * a same-named directory of ours elsewhere stays in scope.
 */
const SKIP_PATHS = new Set(['contracts/lib', 'contracts/out', 'contracts/cache']);

/** Wrangler's own config filename convention — a total test on the name. */
const CONFIG_NAME = /^wrangler[^/]*\.(jsonc|json|toml)$/;

function walkConfigs(rel, out) {
  let entries;
  try {
    entries = readdirSync(rel ? join(REPO_ROOT, rel) : REPO_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_BASENAMES.has(e.name) && !SKIP_PATHS.has(child)) walkConfigs(child, out);
    } else if (CONFIG_NAME.test(e.name)) {
      out.push(child);
    }
  }
}

const configs = [];
walkConfigs('', configs);
configs.sort();

/** Configs the deployment tool refuses the declaration for — counted apart. */
const exempt = [];

if (configs.length === 0) {
  problems.push(
    'no wrangler config was found anywhere in the tree, which cannot be right ' +
      '— the walk is\n    broken, or every config was renamed out of the ' +
      '`wrangler*` convention.',
  );
}

for (const rel of configs) {
  if (rel.endsWith('.toml')) {
    // REFUSED RATHER THAN PARSED. Wrangler accepts a TOML config; deciding
    // whether a `keep_vars = true` line is top-level, and not inside a table
    // or a multiline string, is a grammar this file deliberately does not
    // carry — the class of reasoning the retired scanner failed at. No TOML
    // config exists in the tree, so the rule costs nothing and converts a
    // silent miss into a loud instruction.
    problems.push(
      `${rel} is a TOML wrangler config, and this check reads JSON/JSONC ` +
        `only.\n    Convert it to JSONC so its \`keep_vars\` can be asserted, ` +
        `or extend this check to\n    read TOML. It will not guess at the ` +
        `grammar.`,
    );
    continue;
  }
  let cfg;
  try {
    cfg = readJsonc(rel);
  } catch (err) {
    problems.push(`${rel} could not be read or parsed: ${err.message}`);
    continue;
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    problems.push(`${rel} is not a JSON object, so it cannot declare \`keep_vars\`.`);
    continue;
  }
  // PAGES CONFIGS ARE EXEMPT, and the exemption is structural rather than a
  // name list: wrangler selects Pages mode on `pages_build_output_dir`, and a
  // Pages config that declares `keep_vars` is REJECTED outright
  // ("Configuration file for Pages projects does not support keep_vars").
  // Requiring it there would make CI and wrangler demand opposite things, with
  // no version of the file that satisfies both (#2171 r3, P2). Pages does not
  // use the Worker deploy behaviour this guard exists for.
  if (typeof cfg.pages_build_output_dir === 'string') {
    exempt.push(rel);
    continue;
  }
  // The list's only remaining job: a Worker that has values to lose should be
  // in VAR_CARRYING_WORKERS, or its per-Worker mutation fixture never runs.
  //
  // SCOPED TO A CANONICAL CONFIG, and that is load-bearing rather than tidy.
  // Entries in `VAR_CARRYING_WORKERS` are DIRECTORIES, and the pass below
  // reads `<entry>/wrangler.jsonc` for each. Deriving the entry from any
  // config's parent directory therefore produced an instruction that could not
  // be followed: `configs/wrangler.agent.jsonc` — a perfectly valid alternate
  // config declaring both `vars` and `keep_vars` — was reported as the Worker
  // `configs`, and adding `configs` to the list would then fail the later pass
  // for want of `configs/wrangler.jsonc` (#2171 r6). A false report on correct
  // input, with a remedy that makes it worse, is the exact failure this whole
  // change argues against, so the advisory now fires only where its remedy is
  // guaranteed to work: a config that IS `<dir>/wrangler.json(c)`.
  const canonical = /^(.+)\/wrangler\.jsonc?$/.exec(rel);
  if (
    canonical &&
    typeof cfg.vars === 'object' &&
    cfg.vars !== null &&
    !VAR_CARRYING_WORKERS.includes(canonical[1])
  ) {
    problems.push(
      `${rel} declares \`vars\` but \`${canonical[1]}\` is not in ` +
        `VAR_CARRYING_WORKERS.\n    The preservation rule already covers it; ` +
        `what is missing is the per-Worker mutation\n    fixture that proves ` +
        `the check fails when this config loses the key. Add the directory.`,
    );
  }
  if (cfg.keep_vars !== true) {
    problems.push(
      `${rel} does not declare \`"keep_vars": true\`.\n    EVERY wrangler ` +
        `config declares it, whatever Worker it names and whether or not that ` +
        `Worker\n    has vars today — a deploy can select any config and can ` +
        `override the Worker name on\n    the command line, so which config ` +
        `is "the" one is not decidable from here.`,
    );
  }
  // NAMED ENVIRONMENTS ARE NOT ASSERTED, and the previous revision was wrong
  // to assert them. It required `env.<name>.keep_vars` on the reasoning that
  // inheritance "could not be verified here" — but `keep_vars` is a
  // TOP-LEVEL-ONLY field, and wrangler rejects it inside an environment
  // ("Unexpected fields found in env.<name> field: keep_vars"). Deployment
  // reads the top-level value after environment selection, so the top-level
  // requirement above already covers `--env` (#2171 r3, P2). Being unable to
  // verify something is a reason to go and find out, not a licence to demand
  // the conservative-looking thing — here the conservative-looking thing was
  // an unsupported field that would have emitted a validation warning on
  // every deploy.
}

for (const dir of VAR_CARRYING_WORKERS) {
  const rel = `${dir}/wrangler.jsonc`;
  let cfg;
  try {
    cfg = readJsonc(rel);
  } catch (err) {
    problems.push(`${rel} could not be read or parsed: ${err.message}`);
    continue;
  }
  if (cfg.keep_vars !== true) {
    problems.push(
      `${rel} does not declare \`"keep_vars": true\`. A deploy of this Worker ` +
        `would DELETE every var\n    managed in the dashboard rather than in ` +
        `this file.`,
    );
  }
  // The LIST is pinned as well as the key. If a Worker's `vars` block goes
  // away, that is a decision to make — drop it from this list, or find out why
  // — not an assertion to leave passing for a Worker the rule no longer
  // describes.
  if (typeof cfg.vars !== 'object' || cfg.vars === null) {
    problems.push(
      `${rel} has no \`vars\` block, so this list is stale. Either the Worker ` +
        `stopped carrying\n    operator-managed values (remove it from ` +
        `VAR_CARRYING_WORKERS) or the block was lost.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\n[check-keep-vars] ${problems.length} problem(s):\n\n` +
      problems.map((p) => `  - ${p}`).join('\n\n') +
      `\n\nWrangler deletes vars absent from the config before setting the ` +
      `ones present, so every\nwrangler config must declare ` +
      `\`"keep_vars": true\`. It is read for both \`deploy\` and\n` +
      `\`versions upload\`, which is what makes the declaration cover every ` +
      `way a deploy can be\nspelled — and it is required on EVERY config ` +
      `because which one a deploy loads, and which\nWorker it targets, are ` +
      `command-line decisions this check cannot see.\n`,
  );
  process.exit(1);
}

// ASSERTED AND EXEMPT ARE COUNTED APART. The single total said every config
// "declares preservation" while silently including the Pages ones, which
// declare nothing and cannot — an operator reading the line for verification
// would have been told something untrue about a file this check never asserted
// (#2171 r6). A count is a claim.
console.log(
  `[check-keep-vars] OK — ${configs.length - exempt.length} wrangler ` +
    `config(s) declare preservation` +
    (exempt.length
      ? `, and ${exempt.length} Pages config(s) are exempt because the tool ` +
        `refuses the key there (${exempt.join(', ')})`
      : '') +
    `; ${VAR_CARRYING_WORKERS.length} of the Workers they cover carry ` +
    `dashboard-managed vars today.`,
);
