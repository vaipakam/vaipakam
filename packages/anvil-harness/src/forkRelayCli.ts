/**
 * The deploy rehearsal's relay command (#3892 wiring, design
 * `DeployRehearsalDesign.md` §15): what `contracts/script/rehearse.sh` runs
 * for a plan's `relay` steps. The driver runs each step as its own process,
 * so the relay is installed once and every later step rejoins it from the
 * run's scratch folder.
 *
 *   install --state <dir> --env-file <file> <slug>=<url>@<forkBlock> ...
 *       Find every lane between the forks, refuse any ramp version the
 *       stand-in was not built for, install the stand-in on each destination,
 *       and save the relay (its key is made here, for this run only).
 *   deliver --state <dir> <from-slug> <to-slug>
 *       Deliver every message the source sent toward the destination since
 *       the fork began and not yet delivered, in send order. A delivery that
 *       fails fails the step. Each delivered message is appended to the
 *       run's message log.
 *   report --state <dir>
 *       The report's section for the relay: the lanes, every delivered
 *       message (id, fee, gas limit, gas used) and what is not rehearsed.
 *
 * Each fork's chain id is read from the fork; its CCIP selector comes from
 * the deploy scripts' chain list (`contracts/script/deploy-plan.mjs`), and
 * its router from the env file's `CCIP_ROUTER_<PREFIX>`, the value the
 * deploy itself wires. Run with `tsx`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { compileForkRelay, FORK_RELAY_LIMITS, ForkCcipRelay, type ForkEnd, type ForkRelayedMessage, type SavedForkRelay } from './forkRelay';
import { assertLoopbackUrl } from './rpc';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_PLAN = path.resolve(HERE, '../../../contracts/script/deploy-plan.mjs');

/** One chain of the deploy scripts' list (`deploy-plan.mjs` CHAINS). */
export interface KnownChain {
  chainId: number;
  prefix: string;
  ccipSelector: string;
}

/** A fork named on the install command line: `<slug>=<url>@<forkBlock>`. */
export interface ForkArg {
  name: string;
  url: string;
  forkBlock: bigint;
}

export function parseForkArg(arg: string): ForkArg {
  const m = /^([a-z0-9-]+)=(\S+)@(\d+)$/.exec(arg);
  if (!m) throw new Error(`relay: "${arg}" is not <slug>=<url>@<forkBlock>`);
  assertLoopbackUrl(m[2]);
  return { name: m[1], url: m[2], forkBlock: BigInt(m[3]) };
}

/** `KEY=VALUE` lines of an env file; quotes stripped, comments skipped. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.set(m[1], v);
  }
  return out;
}

/**
 * The relay's view of one fork: the chain the fork says it is must be the one
 * the slug names, the selector is the deploy scripts', the router the env
 * file's, and messages are read from the first block after the fork point.
 */
export function forkEnd(fork: ForkArg, chainId: number, chains: Record<string, KnownChain>, env: Map<string, string>): ForkEnd {
  const known = chains[fork.name];
  if (!known) throw new Error(`relay: ${fork.name} is not a chain the deploy scripts know`);
  if (known.chainId !== chainId) throw new Error(`relay: the fork named ${fork.name} answers chain id ${chainId}, not ${known.chainId}`);
  const key = `CCIP_ROUTER_${known.prefix}`;
  const router = env.get(key);
  if (!router || !/^0x[0-9a-fA-F]{40}$/.test(router)) throw new Error(`relay: the env file sets no address for ${key}, the router the deploy wires on ${fork.name}`);
  return { name: fork.name, url: fork.url, chainId, chainSelector: known.ccipSelector, router: router as Address, fromBlock: fork.forkBlock + 1n };
}

const relayFile = (state: string) => path.join(state, 'relay.json');
const messagesFile = (state: string) => path.join(state, 'messages.jsonl');

function readSaved(state: string): SavedForkRelay {
  const f = relayFile(state);
  if (!fs.existsSync(f)) throw new Error(`relay: no relay installed for this run (${f}); the driver installs it before the first relay step`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as SavedForkRelay;
}

const jsonRow = (m: ForkRelayedMessage) => JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** The relay's section of the rehearsal report, from the saved lanes and the message log. */
export function reportSection(saved: SavedForkRelay, messageLines: string[]): string {
  const out = ['## Cross-chain relay', ''];
  out.push('| Lane | On-ramp | Off-ramp (stand-in installed) | Other off-ramps listed, not used |', '| --- | --- | --- | --- |');
  for (const l of saved.lanes) {
    const others = l.otherOffRamps.map((o) => `${o.address} (${o.version})`).join(', ') || 'none';
    out.push(`| ${l.from} → ${l.to} | ${l.onRamp} | ${l.offRamp} | ${others} |`);
  }
  out.push('');
  const rows = messageLines.filter(Boolean).map((l) => JSON.parse(l) as Record<string, string | boolean>);
  if (rows.length === 0) out.push('No message was delivered.');
  else {
    out.push('| Message | Lane | Fee (fee token) | Gas limit | Gas used | Receiver called | Source tx | Destination tx |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      out.push(`| ${r.messageId} | ${r.from} → ${r.to} | ${r.fee} (${r.feeToken}) | ${r.gasLimit} | ${r.gasUsed} | ${r.receiverCalled ? 'yes' : 'no'} | ${r.sourceTx} | ${r.destinationTx} |`);
    }
  }
  out.push('', 'Not rehearsed:', ...FORK_RELAY_LIMITS.map((x) => `- ${x}`), '');
  return out.join('\n');
}

async function loadChains(): Promise<Record<string, KnownChain>> {
  const mod = (await import(pathToFileURL(DEPLOY_PLAN).href)) as { CHAINS: Record<string, KnownChain> };
  return mod.CHAINS;
}

function option(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`relay: ${name} is required`);
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const args = [...rest];
  const state = path.resolve(option(args, '--state'));
  if (cmd === 'install') {
    const env = parseEnvFile(fs.readFileSync(option(args, '--env-file'), 'utf8'));
    if (args.length < 2) throw new Error('relay: install needs at least two forks');
    const chains = await loadChains();
    const ends: ForkEnd[] = [];
    for (const a of args) {
      const fork = parseForkArg(a);
      const chainId = await createPublicClient({ transport: http(fork.url) }).getChainId();
      ends.push(forkEnd(fork, chainId, chains, env));
    }
    compileForkRelay();
    const relay = await ForkCcipRelay.install(ends, generatePrivateKey());
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(relayFile(state), JSON.stringify(relay.saved(), null, 2), { mode: 0o600 });
    fs.writeFileSync(messagesFile(state), '');
    for (const l of relay.saved().lanes) console.log(`relay: lane ${l.from} -> ${l.to}: on-ramp ${l.onRamp}, off-ramp ${l.offRamp} (stand-in installed)`);
    return 0;
  }
  if (cmd === 'deliver') {
    const [from, to] = args;
    if (!from || !to || args.length !== 2) throw new Error('relay: deliver takes <from-slug> <to-slug>');
    const saved = readSaved(state);
    const id = (name: string) => {
      const e = saved.ends.find((x) => x.name === name);
      if (!e) throw new Error(`relay: ${name} is not one of this run's forks`);
      return e.chainId;
    };
    const relay = await ForkCcipRelay.attach(saved);
    const delivered = await relay.deliver(id(from), id(to));
    for (const m of delivered) {
      fs.appendFileSync(messagesFile(state), `${jsonRow(m)}\n`);
      console.log(`relay: delivered ${m.messageId} ${from} -> ${to}: fee ${m.fee}, gas limit ${m.gasLimit}, gas used ${m.gasUsed} (tx ${m.destinationTx as Hex})`);
    }
    if (delivered.length === 0) console.log(`relay: nothing pending from ${from} to ${to}`);
    return 0;
  }
  if (cmd === 'report') {
    const lines = fs.existsSync(messagesFile(state)) ? fs.readFileSync(messagesFile(state), 'utf8').split('\n') : [];
    process.stdout.write(reportSection(readSaved(state), lines));
    return 0;
  }
  throw new Error(`relay: unknown command "${cmd ?? ''}" (install, deliver or report)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
