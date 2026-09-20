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
 * cost: seventeen open issues (#2104, #2106, #2108, #2110, #2112–#2119,
 * #2121–#2124, #2126), every one an edge of the same predicate — a folded YAML
 * scalar's offsets, a settable `.RECIPEPREFIX`, a PowerShell here-string, a
 * case-varied variable name, an upper-case file extension, a semicolon after
 * an assignment, a Make prerequisite declared after the target it feeds, a
 * non-shell step body classified as shell — and five of them FALSE REPORTS
 * that redden a correct tree. Each was a constructed example; none named a
 * file in this repository. Reading arbitrary text and deciding whether it
 * will run a command requires the execution model of every interpreter it
 * might be, and 23,800 lines of scanner and fixtures did not get there.
 * Deleting the predicate is the fix the record asks for, the same move as
 * #2066 (a declaration heuristic deleted after six rounds) and #2149 (a
 * speculative branch deleted at round 13). Thirteen days is a short
 * observation window and the reader should weigh it as one; what argues for
 * the retirement is the SHAPE of the findings, not their elapsed time.
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
 *   - A checked-in Worker config named outside the `wrangler*` convention
 *     that ALSO omits `compatibility_date` (deployed with the date supplied as
 *     `--compatibility-date`), or that is TOML. The convention gap itself is
 *     now CLOSED — see THE SECOND IDENTIFICATION below — and these are its
 *     narrower residues, named rather than implied because a defence that has
 *     grown should be as exact about its edge as one that has shrunk. The TOML
 *     residue is a deliberate trade, argued beside the code that declines it.
 *
 * THE SECOND IDENTIFICATION (closes the #2171 r8 removal). A config is
 * recognised by EITHER of two total tests, and everything either one finds
 * goes through the single requirement pass below:
 *
 *   1. WRANGLER'S FILENAME CONVENTION — `wrangler*.json`/`.jsonc`/`.toml`.
 *   2. WRANGLER'S OWN REQUIRED WORKER FIELD — a top-level string
 *      `compatibility_date`. `--config` accepts any path, so a deployable
 *      config checked in as `configs/agent-staging.jsonc` is reachable, and
 *      the retired scanner did cover it: its deleted fixture `a config
 *      selected through an argv array is the one consulted` seeded
 *      `apps/agent/unsafe.jsonc` and asserted the deploy was refused.
 *
 * Neither test needs an execution model, a notion of which text is a command,
 * or wrangler's CLI-and-config merge semantics — the three things that made
 * the retired predicate unbounded. Test 2 is a shape test for ONE key that
 * wrangler invented and nothing else in this tree carries. The earlier draft
 * that turned the tree red on `ops/mesh-watcher/package.json` keyed on `name`,
 * a field every manifest has; `name` + `main` would repeat that for the same
 * reason, which is why the discriminator is the field no manifest has.
 *
 * The REMEDY for a config found by test 2 is the same as for any other —
 * declare the key — NOT a demand that it be renamed. The safety property is
 * the declaration. The filename is a convention, and a guard that exists to
 * stop vars being wiped is the wrong place to enforce one.
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
 * A CONFIG NAMED OUTSIDE THE CONVENTION IS NO LONGER MISSED. It was, and the
 * previous revision of this note explained why recognising it would cost false
 * reports: classifying arbitrary JSON by its contents is what turned the
 * round-one tree red on `ops/mesh-watcher/package.json`. That reasoning was
 * right about the rule it was describing — which keyed on `name` — and wrong
 * as a general claim about content. Keying on `compatibility_date` instead is
 * a test for a field wrangler invented, which no manifest, tsconfig or lockfile
 * carries; the walk below applies it as a second identification, and
 * everything it finds is asserted by the same pass as everything else.
 *
 * What is left is a residue rather than the gap: a config that carries neither
 * the name nor the field, deployed with `--compatibility-date` supplying what
 * the file omits. That one is listed with the accepted cases at the top, where
 * the things this check does not cover are stated together.
 *
 * The convention remains a rule for contributors — a wrangler config is named
 * `wrangler*.jsonc` — but it is now a tidiness rule rather than the thing
 * safety rests on.
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

/** Files the second identification may read — the extensions wrangler loads. */
const CANDIDATE_NAME = /\.(jsonc|json|toml)$/;

/**
 * The field the second identification keys on.
 *
 * Wrangler requires `compatibility_date` for a Worker and invented the name;
 * no manifest, tsconfig, lockfile or ABI in this tree carries it. That is what
 * makes reading content safe HERE and unsafe in the round-one draft, which
 * keyed on `name` and turned the tree red on a package manifest.
 */
const WORKER_FIELD = 'compatibility_date';

function walkConfigs(rel, named, candidates) {
  let entries;
  try {
    entries = readdirSync(rel ? join(REPO_ROOT, rel) : REPO_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_BASENAMES.has(e.name) && !SKIP_PATHS.has(child)) {
        walkConfigs(child, named, candidates);
      }
    } else if (CONFIG_NAME.test(e.name)) {
      named.push(child);
    } else if (CANDIDATE_NAME.test(e.name)) {
      candidates.push(child);
    }
  }
}

const named = [];
const candidates = [];
walkConfigs('', named, candidates);

/**
 * How each config was identified, so a report can say WHY a file is asserted.
 *
 * Discovery by content is a RECOGNISER, not an assertion: a candidate that
 * cannot be read, does not parse, or is not a JSON object is simply not a
 * config, and is passed over in silence. Treating an unparseable `.json`
 * somewhere in the tree as a problem would make this check fail on files it
 * has no business judging — the opposite of the bounded shape the header
 * argues for. A file named `wrangler*` keeps the stricter treatment it already
 * had: there, a parse failure IS reported, because the name is a claim.
 */
const discovery = new Map(named.map((rel) => [rel, 'name']));

for (const rel of candidates) {
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  // Cheap reject first: most of the tree's JSON is ABIs and lockfiles, and
  // only the few files mentioning the field are worth parsing.
  if (!text.includes(WORKER_FIELD)) continue;
  // TOML IS NOT IDENTIFIED BY CONTENT, deliberately. The JSON test is a shape
  // test on a parsed object — a top-level key of type string. The TOML
  // equivalent needs the grammar this file refuses to carry, and the only
  // thing available without it is a raw substring, which would report a `.toml`
  // that merely MENTIONS the field in a comment. That is the loose inference
  // the retired scanner was made of, and buying one narrow case with a new
  // false-report class is the trade #1995 says not to make. A `wrangler*.toml`
  // is still refused by name below, where the name is a claim about the file.
  if (rel.endsWith('.toml')) continue;
  let cfg;
  try {
    cfg = parseJsonc(text);
  } catch {
    continue;
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
  if (typeof cfg[WORKER_FIELD] !== 'string') continue;
  discovery.set(rel, 'content');
}

const configs = [...discovery.keys()].sort();

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
  // THE "ADD IT TO VAR_CARRYING_WORKERS" ADVISORY THAT SAT HERE IS DELETED,
  // and the reason is worth more than the advisory was.
  //
  // It never asserted the property this file exists for — the preservation
  // rule above already covers every config, listed Worker or not. All it did
  // was suggest adding a newly var-carrying Worker to the list so its
  // per-Worker MUTATION FIXTURE would run. A convenience about test coverage.
  //
  // It cost two consecutive review rounds, both defects introduced by the
  // previous round's fix, and both of the same shape: the advisory named a
  // remedy the later pass could not honour. First it derived the Worker from
  // any config's parent directory, so `configs/wrangler.agent.jsonc` was
  // reported as the Worker `configs` (#2171 r6). Scoping it to a canonical
  // config was supposed to close that — the fix was described, in this file
  // and in the pull request, as having a CLOSURE PROPERTY: its domain matched
  // the shape its consumer required. That was FALSE. The scoping regex admits
  // `wrangler.json` as well as `.jsonc`, while the consuming pass is
  // hard-coded to `.jsonc`, so a Worker using the other accepted extension got
  // an instruction that ends in ENOENT (#2171 r7).
  //
  // Two rounds, two remedies-that-break-something, and a confident claim of
  // convergence that did not hold. The lesson is not "handle the second
  // extension": it is that a hint which must stay in step with a separate
  // pass's file-naming is a duplicate by another name, and duplicates here
  // have drifted every single time. What is lost is stated plainly rather than
  // papered over: a NEW var-carrying Worker will be required to declare
  // `keep_vars` like every other config, but will not automatically get a
  // per-Worker mutation fixture until someone adds it to the list. The paired
  // suite still asserts that this list and the suite's copy agree, so the
  // omission surfaces the moment anyone touches either.
  if (cfg.keep_vars !== true) {
    problems.push(
      `${rel} does not declare \`"keep_vars": true\`.\n    EVERY wrangler ` +
        `config declares it, whatever Worker it names and whether or not that ` +
        `Worker\n    has vars today — a deploy can select any config and can ` +
        `override the Worker name on\n    the command line, so which config ` +
        `is "the" one is not decidable from here.` +
        (discovery.get(rel) === 'content'
          ? `\n    This file is not named \`wrangler*\`, and is asserted ` +
            `because it carries a top-level\n    \`${WORKER_FIELD}\` — the ` +
            `field wrangler requires of a Worker config. \`--config\` ` +
            `accepts\n    any path, so the name does not decide whether a ` +
            `deploy can load it. Declare the key;\n    renaming it is a ` +
            `tidiness choice, not what makes it safe.`
          : ''),
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

// Derived AFTER the requirement pass, because `exempt` is filled by it and a
// Pages config found by content declares nothing — counting it among the
// asserted ones would make the summary line claim something untrue about a
// file this check deliberately skipped (#2171 r6, the same defect in the
// exempt total).
const exemptSet = new Set(exempt);
const assertedByContent = configs.filter(
  (rel) => discovery.get(rel) === 'content' && !exemptSet.has(rel),
);

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
    // COUNTED APART for the same reason the exempt ones are: the two
    // identifications answer different questions, and a reader verifying the
    // line should be able to tell how many files are here because of their
    // name and how many because of what they contain.
    (assertedByContent.length
      ? ` (${assertedByContent.length} of them identified by a top-level ` +
        `\`${WORKER_FIELD}\` rather than by filename: ` +
        `${assertedByContent.join(', ')})`
      : '') +
    (exempt.length
      ? `, and ${exempt.length} Pages config(s) are exempt because the tool ` +
        `refuses the key there (${exempt.join(', ')})`
      : '') +
    `; ${VAR_CARRYING_WORKERS.length} of the Workers they cover carry ` +
    `dashboard-managed vars today.`,
);
