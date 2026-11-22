/**
 * The deploy rehearsal's off-chain stage (#3894, DeployRehearsalDesign §7 and
 * §16): the rules that decide what runs and how a result is read, kept apart
 * from anything that touches a node, a database or the network so each rule
 * is tested on its own (`test/rehearsalPlan.test.ts`).
 *
 * The stage runs once per chain, as a step of the rehearsal driver. It reads
 * only what the driver hands it:
 *
 *   - `VAIPAKAM_REHEARSAL=1`, set only by the driver (the `.env` loader refuses
 *     every `VAIPAKAM_REHEARSAL*` name);
 *   - `VAIPAKAM_REHEARSAL_ROOT`, the run's scratch folder, relative to
 *     `contracts/` and inside `deployments/.forge-test/rehearsal/` — the same
 *     rule the indexer's local database entry applies, imported from it;
 *   - `VAIPAKAM_REHEARSAL_RPC_URL`, this step's fork, on loopback only;
 *   - `VAIPAKAM_REHEARSAL_DESIRED_STATE`, the desired-state file whose
 *     `keeper.armed` lists, per chain slug, the arming flags that chain's
 *     keeper will carry.
 *
 * It never reads a real key: the keeper signs with a key made for the run.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PASS_ARMING_FLAGS, type PassArmingFlag } from '../../src/keeper';
// @ts-expect-error — plain ESM script, no type declarations.
import { rehearsalPaths, rehearsalRoot } from '../../../indexer/scripts/deploy-shared-d1.mjs';

/** What the driver hands one step. */
export interface RehearsalInputs {
  /** The run's scratch folder, absolute. */
  root: string;
  /** The local shared database's folder (`wrangler … --persist-to`). */
  persistTo: string;
  /** The scratch deployments bundle the keeper and indexer read. */
  deploymentsPath: string;
  /** This step's fork. Never written to a log or the report. */
  rpcUrl: string;
  /** The desired-state file, absolute. */
  desiredStatePath: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Read and check the step's inputs. Every refusal names the variable, never
 * its value: the fork URL may carry a provider key in a misconfigured run.
 */
export function readRehearsalInputs(env: Readonly<Record<string, string | undefined>>, opts: { contractsDir?: string } = {}): RehearsalInputs {
  if (env.VAIPAKAM_REHEARSAL !== '1') {
    throw new Error('rehearsal: VAIPAKAM_REHEARSAL is not 1; the off-chain stage runs only as a step of the rehearsal driver');
  }
  const root = rehearsalRoot(env.VAIPAKAM_REHEARSAL_ROOT, opts.contractsDir ? { contractsDir: opts.contractsDir } : {}) as
    | { ok: true; root: string }
    | { ok: false; message: string };
  if (!root.ok) throw new Error(`rehearsal: ${root.message}`);
  const paths = rehearsalPaths(root.root) as { persistTo: string; deploymentsPath: string };

  const rpcUrl = env.VAIPAKAM_REHEARSAL_RPC_URL;
  if (!rpcUrl) throw new Error('rehearsal: VAIPAKAM_REHEARSAL_RPC_URL is not set');
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    throw new Error('rehearsal: VAIPAKAM_REHEARSAL_RPC_URL is not a URL');
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('rehearsal: VAIPAKAM_REHEARSAL_RPC_URL is not on loopback; a rehearsal step drives only a local fork');
  }

  const desiredStatePath = env.VAIPAKAM_REHEARSAL_DESIRED_STATE;
  if (!desiredStatePath) throw new Error('rehearsal: VAIPAKAM_REHEARSAL_DESIRED_STATE is not set');
  if (!existsSync(desiredStatePath)) throw new Error('rehearsal: VAIPAKAM_REHEARSAL_DESIRED_STATE names no file');

  return { root: root.root, persistTo: paths.persistTo, deploymentsPath: paths.deploymentsPath, rpcUrl, desiredStatePath };
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set(PASS_ARMING_FLAGS);

/**
 * The arming flags `keeper.armed[slug]` lists. A chain the file lists no entry
 * for is refused, not read as "nothing armed": an omitted chain and a chain
 * deliberately armed with nothing must read differently, and the second is an
 * empty list. A flag no pass reads is refused by name, so a typo cannot arm
 * nothing in silence. `KEEPER_ENABLED` is not an arming flag here: every step
 * sets it, as the keeper machine does.
 */
export function armedFlagsFor(desired: unknown, slug: string): PassArmingFlag[] {
  const keeper = (desired as { keeper?: unknown } | null)?.keeper;
  const armed = (keeper as { armed?: unknown } | null | undefined)?.armed;
  if (armed === null || typeof armed !== 'object' || Array.isArray(armed)) {
    throw new Error('rehearsal: the desired-state file has no keeper.armed object');
  }
  const list = (armed as Record<string, unknown>)[slug];
  if (list === undefined) throw new Error(`rehearsal: keeper.armed has no entry for ${slug}`);
  if (!Array.isArray(list) || list.some((f) => typeof f !== 'string')) {
    throw new Error(`rehearsal: keeper.armed.${slug} is not a list of flag names`);
  }
  const unknown = (list as string[]).filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) throw new Error(`rehearsal: keeper.armed.${slug} names flags no keeper pass reads: ${unknown.join(', ')}`);
  const dupes = (list as string[]).filter((f, i) => list.indexOf(f) !== i);
  if (dupes.length > 0) throw new Error(`rehearsal: keeper.armed.${slug} lists ${[...new Set(dupes)].join(', ')} more than once`);
  return [...(list as PassArmingFlag[])];
}

/**
 * The SQLite file wrangler keeps the local shared database in, under
 * `--persist-to`. Wrangler names it by a hash and keeps a `metadata.sqlite`
 * beside it, so exactly one other `.sqlite` file must be there; none, or more
 * than one (a second database under the same folder), is refused rather than
 * guessed between.
 */
export function localD1File(persistTo: string): string {
  const dir = join(persistTo, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error('rehearsal: no local shared database under the run folder; run the indexer\'s migrate:rehearsal step first');
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) {
    throw new Error(`rehearsal: expected one local shared database file, found ${files.length}`);
  }
  return join(dir, files[0]);
}

/** How one pass's single tick ended. */
export type PassOutcome =
  | { pass: string; result: 'ran'; ms: number }
  | { pass: string; result: 'not-armed'; ms: number; detail: string }
  | { pass: string; result: 'not-rehearsed'; ms: number; services: string[]; detail: string | null }
  | { pass: string; result: 'failed'; ms: number; detail: string };

/**
 * Read one pass's tick. A pass gates itself (`passIsArmed`) and says so in one
 * line, `[keeper] <name> skipped: <why>`, under the name it is scheduled by;
 * that line, captured from the tick, reads as not armed. Outbound requests are narrowed to the fork, so a pass
 * that tried to reach anything else could not finish what it does in
 * production; it is reported as not rehearsed, naming each service it tried,
 * whether it then threw or carried on. A pass that threw without trying an
 * outside service failed: that is a fault the rehearsal exists to find.
 */
export function classifyPass(
  pass: string,
  ms: number,
  threw: { message: string } | null,
  blockedOrigins: readonly string[],
  logLines: readonly string[] = [],
): PassOutcome {
  const skipPrefix = `[keeper] ${pass} skipped: `;
  const skipped = logLines.find((l) => l.startsWith(skipPrefix));
  if (skipped !== undefined && !threw && blockedOrigins.length === 0) {
    return { pass, result: 'not-armed', ms, detail: skipped.slice(skipPrefix.length) };
  }
  if (blockedOrigins.length > 0) {
    return { pass, result: 'not-rehearsed', ms, services: [...new Set(blockedOrigins)].sort(), detail: threw?.message ?? null };
  }
  if (threw) return { pass, result: 'failed', ms, detail: threw.message };
  return { pass, result: 'ran', ms };
}

/** Whether a stage with these outcomes passes: no pass failed. */
export function stagePassed(outcomes: readonly PassOutcome[]): boolean {
  return outcomes.every((o) => o.result !== 'failed');
}

/** The part of the indexer's `/health/ingest` answer the stage reads. */
interface IngestHealthBody {
  schema?: { state?: string; missing?: string[] };
  chains?: { chainId?: number; deployment?: { diamond?: string; resetPending?: boolean } | null; lastBlock?: number | null }[];
  configured?: { chains?: number[] };
}

/**
 * Whether the indexer's health route reports what the stage requires for this
 * chain (§7: "it must adopt the new Diamond on each chain and report it on its
 * health route"): a 200, the schema current, the chain configured, its adopted
 * Diamond the bundle's with no reset pending, and a cursor. Every unmet
 * requirement is named.
 */
export function healthVerdict(status: number, body: unknown, chainId: number, diamond: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (status !== 200) problems.push(`the health route answered ${status}`);
  const h = (body ?? {}) as IngestHealthBody;
  if (h.schema?.state !== 'current') {
    problems.push(`the schema reads ${h.schema?.state ?? 'nothing'}${h.schema?.missing?.length ? ` (missing ${h.schema.missing.join(', ')})` : ''}`);
  }
  if (!h.configured?.chains?.includes(chainId)) problems.push(`chain ${chainId} is not in the configured set`);
  const row = h.chains?.find((c) => c.chainId === chainId);
  if (!row) problems.push(`chain ${chainId} has no ingest row`);
  else {
    const adopted = row.deployment?.diamond;
    if (!adopted) problems.push(`chain ${chainId} has no adopted Diamond`);
    else if (adopted.toLowerCase() !== diamond.toLowerCase()) problems.push(`chain ${chainId} adopted ${adopted}, not the deployed ${diamond}`);
    if (row.deployment?.resetPending) problems.push(`chain ${chainId} still has a reset pending`);
    if (row.lastBlock === null || row.lastBlock === undefined) problems.push(`chain ${chainId} has no cursor`);
  }
  return { ok: problems.length === 0, problems };
}

/** Replace every occurrence of the fork URL with the variable's name, so no
 *  report or log line written from the stage carries it. */
export function redactUrl(text: string, url: string): string {
  return url ? text.split(url).join('$VAIPAKAM_REHEARSAL_RPC_URL') : text;
}
