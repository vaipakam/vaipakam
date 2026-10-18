#!/usr/bin/env node
/**
 * #2443 — the SANCTIONS ADDER: one unattended run of the OFAC → `SanctionsList`
 * update, signed by the list's ADDER key and limited to what that key may do.
 *
 * The list splits its signers by direction (owner decision 2026-10-18, "Bot
 * adds, Safe removes"): the adder may only list addresses or record a
 * publication; delisting needs the remover, a multisig. This runner is the
 * adder half, run once a day by a systemd timer on an always-on machine
 * (ops/sanctions-adder/). Each run:
 *
 *   1. downloads Treasury's SDN Advanced XML to the state directory and keeps
 *      it, named by publication date and hash, as the record of what was
 *      parsed — the remover's later run needs the SAME bytes;
 *   2. parses it in pieces with the diff tool's parser (never the whole file
 *      in memory), and reads the current list at the finalized block;
 *   3. builds the update in ADDER-ONLY mode: every addition, in batches, and
 *      for a new publication its delistings DECLARED outstanding on-chain but
 *      not applied — the list then says which publication it follows and what
 *      of it awaits the remover;
 *   4. simulates and sends each call in order, waiting for each to be
 *      included, then for the last to be final and every one still in its
 *      block — only then is the run "applied";
 *   5. reports: the journal always, the ops Telegram chat when configured,
 *      and last-run.json, which also records whether the alert was
 *      delivered. A run that stops part-way names what it already sent.
 *      Outstanding delistings are reported on every run until the remover
 *      has applied them, since each is a compliance action someone owes.
 *
 * What it refuses, and leaves for a person: every refusal the diff tool makes
 * (a malformed or moved record, an unwitnessed delisting, too many
 * delistings, an older or conflicting publication), a list that moved past
 * the finalized block, a key that is not the list's adder, and any chain the
 * Diamond's testnet rule does not name — the mainnet adder host is not
 * decided (#2443). It never delists and never rolls back.
 *
 * Configuration is environment only (ops/sanctions-adder/adder.env.example):
 *   SANCTIONS_ADDER_RPC_URL      RPC for the list's chain (carries an API key)
 *   SANCTIONS_ADDER_CHAIN_ID     that chain's id, checked against the RPC
 *   SANCTIONS_LIST_ADDRESS       the deployed SanctionsList
 *   SANCTIONS_ADDER_PRIVATE_KEY  the adder key; nothing else may hold it
 *   SANCTIONS_ADDER_STATE_DIR    where publications and the last report go
 *                                (default: $STATE_DIRECTORY, set by systemd)
 *   SANCTIONS_ADDER_KEEP_FILES   publications kept on disk (default 14)
 *   SANCTIONS_ADDER_MAX_REMOVE   delistings a publication may declare (default 10)
 *   TG_OPS_BOT_TOKEN, TG_OPS_CHAT_ID  the ops-internal bot; optional
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_MAX_REMOVE,
  OFAC_SDN_ADVANCED_URL,
  buildUpdate,
  downloadToFile,
  parseSdnAdvancedFile,
  parseUintArg,
  readCurrentFromChain,
  sanctionsListAbi,
} from './ofac-sanctions-diff.mjs';

/**
 * The chains this runner may sign on: the same set as the contracts'
 * `TestnetChains.isTestnet`. A mainnet adder needs a hardened host, which is
 * not decided (#2443), so a mainnet id is refused rather than configured.
 */
export const ADDER_TESTNET_CHAIN_IDS = Object.freeze([84532n, 11155111n, 421614n, 11155420n, 80002n, 97n, 31337n]);

export const DEFAULT_KEEP_FILES = 14;

/** secp256k1's group order: a private key must be in [1, n). */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** How long a run waits for its last transaction to become final. */
export const FINALITY_TIMEOUT_MS = 40 * 60_000;

/** Keep the downloaded publication under a name that says what it is, and
 *  prune the oldest so at most `keep` publications stay on disk. */
export function keepPublication(file, dir, publicationDate, hash, keep) {
  const name = `sdn-${publicationDate}-${hash.slice(2, 14)}.xml`;
  const kept = join(dir, name);
  renameSync(file, kept);
  const files = readdirSync(dir)
    .filter((f) => /^sdn-\d{8}-[0-9a-f]{12}\.xml$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) if (f !== name) rmSync(join(dir, f), { force: true });
  return kept;
}

/**
 * One run, with every effect injected so the rule is testable:
 *   fetchSource()   → path of the freshly downloaded publication
 *   readCurrent()   → the list at the finalized block (readCurrentFromChain)
 *   latestVersion() → `listVersion` at the latest block
 *   isAdder()       → whether the signing key is the list's adder
 *   send(call, { onSubmitted })
 *                   → simulates, sends and waits for one call to be INCLUDED;
 *                     calls `onSubmitted(hash)` as soon as it is broadcast, and
 *                     returns { hash, blockNumber, blockHash }
 *   confirmFinal(entries)
 *                   → waits until every included call is FINAL and still in
 *                     the block it was included in; throws otherwise
 *
 * `progress` (an array the caller passes in and keeps) receives one entry per
 * call as it is broadcast, and each entry's `state` moves from `submitted` to
 * `included` to `final`. The caller reads it after a failure, so a run that
 * stops part-way says what it already sent and what may still land, rather
 * than reporting a refusal as if nothing had happened.
 *
 * Returns the run's report; throws on any refusal, before anything is sent
 * if the refusal is the tool's.
 */
export async function runAdder({ fetchSource, readCurrent, latestVersion, isAdder, send, confirmFinal = async () => {}, progress = [], stateDir, keepFiles = DEFAULT_KEEP_FILES, maxRemove = DEFAULT_MAX_REMOVE, abi = sanctionsListAbi() }) {
  const downloaded = await fetchSource();
  const { parsed, sourceHash, byteLength } = await parseSdnAdvancedFile(downloaded);
  const file = keepPublication(downloaded, stateDir, parsed.publicationDate, sourceHash, keepFiles);
  const current = await readCurrent();
  // The update is computed from the finalized state and sent at the latest
  // block. If the list has moved in between — another update not yet final —
  // the calls would be built on a stale version; wait for it to finalize.
  const latest = await latestVersion();
  if (BigInt(latest) !== BigInt(current.version)) {
    throw new Error(`the list is at version ${latest} but the finalized block shows ${current.version}; an update is not yet final — the next run retries`);
  }
  if (!(await isAdder())) throw new Error('the signing key is not an adder of this SanctionsList — the owner appoints it with setAdder');
  const update = buildUpdate({
    parsed,
    sourceHash,
    current: current.addresses,
    currentVersion: current.version,
    recordedDate: current.recordedDate,
    recordedHash: current.recordedHash,
    recordedPendingAdditions: current.recordedPendingAdditions,
    recordedPendingDelistings: current.recordedPendingDelistings,
    signers: 'adder',
    maxRemove,
    abi,
  });
  for (const call of update.calls) {
    const entry = { expectedVersion: call.expectedVersion.toString(), add: call.add, additionsLeft: call.additionsLeft, delistingsLeft: call.delistingsLeft, tx: null, state: 'submitting' };
    progress.push(entry);
    const included = await send(call, {
      onSubmitted: (hash) => {
        entry.tx = hash;
        entry.state = 'submitted';
      },
    });
    Object.assign(entry, { tx: included.hash, blockNumber: included.blockNumber?.toString(), blockHash: included.blockHash, state: 'included' });
  }
  if (progress.length) {
    await confirmFinal(progress);
    for (const entry of progress) entry.state = 'final';
  }
  const last = update.calls[update.calls.length - 1];
  return {
    status: progress.length ? 'applied' : 'up-to-date',
    source: { file, sha256: sourceHash, bytes: byteLength, publicationId: parsed.publicationId, publicationDate: parsed.publicationDate, evmAddressCount: parsed.addresses.length },
    list: { atVersion: current.version.toString(), finalizedBlock: current.blockNumber?.toString(), count: current.addresses.length },
    publicationOrder: update.order,
    added: update.add,
    sent: progress,
    // What the list will show outstanding once these calls land: the last
    // call's declaration, or — with nothing sent — what it records now.
    pendingAdditions: last ? last.additionsLeft : Number(current.recordedPendingAdditions),
    pendingDelistings: last ? last.delistingsLeft : Number(current.recordedPendingDelistings),
    delistingsForRemover: update.withheldRemovals,
    malformedValues: parsed.malformed,
  };
}

/**
 * The report for a run that threw, built from what it had already sent. A
 * run that sent nothing is `refused`; one that broadcast anything is
 * `stopped`, and says per transaction whether it is final, included but not
 * yet final, or broadcast with no receipt seen (it may still land).
 */
export function failureReport(reason, progress) {
  const sent = progress.filter((e) => e.tx);
  return { status: sent.length ? 'stopped' : 'refused', error: reason, sent };
}

/** The text a person reads for a failed run. */
export function summarizeFailure(report) {
  if (report.status === 'refused') return `REFUSED, nothing sent: ${report.error}`;
  const word = { final: 'final', included: 'included, NOT yet final', submitted: 'broadcast, no receipt yet — it may still land' };
  const lines = [`STOPPED after broadcasting ${report.sent.length} transaction(s); later calls were not sent. ${report.error}`];
  for (const e of report.sent) lines.push(`  applyUpdate at version ${e.expectedVersion} (+${e.add.length}): ${e.tx} — ${word[e.state] ?? e.state}`);
  lines.push('Check these on-chain before the next run; it rebuilds from the finalized list either way.');
  return lines.join('\n');
}

/** The one-paragraph summary a person reads, in the journal and the chat. */
export function summarize(report) {
  const s = report.source;
  const lines = [`OFAC ${s.publicationId} (sha256 ${s.sha256.slice(0, 18)}…): ${s.evmAddressCount} EVM addresses.`];
  if (report.status === 'applied') {
    lines.push(`Listed ${report.added.length} new address(es) in ${report.sent.length} transaction(s), all final: ${report.sent.map((c) => c.tx).join(', ')}.`);
  } else lines.push(`The list already follows this publication; nothing sent.`);
  if (report.pendingDelistings > 0) {
    lines.push(
      `${report.pendingDelistings} delisting(s) await the remover (the Safe)${report.delistingsForRemover.length ? `: ${report.delistingsForRemover.join(', ')}` : ''}. ` +
        `Confirm each against OFAC's Recent Actions notice, then run ofac-sanctions-diff.mjs --xml ${report.source.file} --confirm-delist … and send its remover calls from the Safe.`,
    );
  }
  if (report.malformedValues.length) lines.push(`${report.malformedValues.length} malformed digital-currency value(s) need review: ${report.malformedValues.map((m) => JSON.stringify(m.value)).join(', ')}.`);
  return lines.join('\n');
}

/**
 * Post to the ops-internal Telegram chat. Never throws and never prints the
 * token. Returns `{ skipped: true }` when the chat is not configured,
 * `{ delivered: true }` on success, and `{ delivered: false, reason }`
 * otherwise, so the caller can record and surface a failed delivery.
 */
export async function notifyOps({ token, chatId, text, fetchImpl = fetch }) {
  if (!token || !chatId) return { skipped: true };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `[sanctions adder] ${text}`, disable_web_page_preview: true }),
    });
    return res.ok ? { delivered: true } : { delivered: false, reason: `Telegram answered HTTP ${res.status}` };
  } catch (e) {
    return { delivered: false, reason: `Telegram unreachable: ${redact(e?.message ?? e, [token])}` };
  }
}

/**
 * `text` with every secret in `secrets` replaced. An RPC URL carries its
 * provider's API key, and viem puts the URL in its HTTP errors — which this
 * runner prints to the journal and posts to the ops chat.
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('<redacted>');
    // The same URL may be printed without its query string or trailing slash.
    try {
      const u = new URL(secret);
      for (const variant of [`${u.origin}${u.pathname}`, u.pathname.length > 1 ? u.pathname : null, u.search || null]) {
        if (variant) out = out.split(variant).join('<redacted>');
      }
    } catch {}
  }
  return out;
}

/** Read and check the configuration; throws naming every missing setting. */
export function readConfig(env) {
  const missing = ['SANCTIONS_ADDER_RPC_URL', 'SANCTIONS_ADDER_CHAIN_ID', 'SANCTIONS_LIST_ADDRESS', 'SANCTIONS_ADDER_PRIVATE_KEY'].filter((k) => !env[k]);
  const stateDir = env.SANCTIONS_ADDER_STATE_DIR || env.STATE_DIRECTORY;
  if (!stateDir) missing.push('SANCTIONS_ADDER_STATE_DIR (or systemd StateDirectory=)');
  if (missing.length) throw new Error(`not configured: ${missing.join(', ')}`);
  const chainId = parseUintArg('SANCTIONS_ADDER_CHAIN_ID', env.SANCTIONS_ADDER_CHAIN_ID, { min: 1n });
  if (!ADDER_TESTNET_CHAIN_IDS.includes(chainId)) {
    throw new Error(`chain ${chainId} refused: the adder runs on testnets only until a hardened mainnet host is decided (#2443)`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.SANCTIONS_ADDER_PRIVATE_KEY)) throw new Error('SANCTIONS_ADDER_PRIVATE_KEY is not a 32-byte hex key');
  const scalar = BigInt(env.SANCTIONS_ADDER_PRIVATE_KEY);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) throw new Error('SANCTIONS_ADDER_PRIVATE_KEY is not a valid secp256k1 key (zero, or not below the curve order)');
  return {
    rpc: env.SANCTIONS_ADDER_RPC_URL,
    chainId,
    list: getAddress(env.SANCTIONS_LIST_ADDRESS),
    privateKey: env.SANCTIONS_ADDER_PRIVATE_KEY,
    // Colon-separated by systemd when several are configured; ours is one.
    stateDir: stateDir.split(':')[0],
    keepFiles: env.SANCTIONS_ADDER_KEEP_FILES ? Number(parseUintArg('SANCTIONS_ADDER_KEEP_FILES', env.SANCTIONS_ADDER_KEEP_FILES, { min: 1n, max: 1000n })) : DEFAULT_KEEP_FILES,
    maxRemove: env.SANCTIONS_ADDER_MAX_REMOVE ? Number(parseUintArg('SANCTIONS_ADDER_MAX_REMOVE', env.SANCTIONS_ADDER_MAX_REMOVE, { max: 1_000_000n })) : DEFAULT_MAX_REMOVE,
    tgToken: env.TG_OPS_BOT_TOKEN || '',
    tgChatId: env.TG_OPS_CHAT_ID || '',
  };
}

/**
 * `--check`: prove an installed release can run, without configuration or
 * network — its modules load, the compiled ABI is present, and the streaming
 * parser reads the committed fixture. install.sh runs it before switching
 * `current` to a new release.
 */
async function check() {
  const abi = sanctionsListAbi();
  if (!abi.some((e) => e.name === 'applyUpdate')) throw new Error('the SanctionsList ABI has no applyUpdate');
  const fixture = new URL('./fixtures/sdn_advanced.sample.xml', import.meta.url);
  const { parsed } = await parseSdnAdvancedFile(fixture);
  if (parsed.addresses.length === 0) throw new Error('the fixture parsed to no addresses');
  console.log(`sanctions-adder: release ok (fixture ${parsed.publicationId}, ${parsed.addresses.length} addresses)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.argv.includes('--check')) return check();
  // Settings that cannot be read leave nowhere to report but the journal:
  // there is no state directory or chat to trust yet.
  const cfg = readConfig(process.env);
  const secrets = [cfg.rpc, cfg.privateKey, cfg.tgToken];
  if (!cfg.tgToken || !cfg.tgChatId) console.log('TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset: this run reports to the journal only.');
  mkdirSync(cfg.stateDir, { recursive: true });

  // EVERY outcome leaves through here: the journal, the chat when the
  // outcome calls for it, and last-run.json — written after the chat, so it
  // records whether the alert was delivered. A failed delivery also fails
  // the unit, so it shows in `systemctl --failed` rather than nowhere.
  const finish = async (report, text, alert) => {
    console.log(text);
    const delivery = alert ? await notifyOps({ token: cfg.tgToken, chatId: cfg.tgChatId, text }) : { skipped: true, reason: 'nothing to alert' };
    writeFileSync(join(cfg.stateDir, 'last-run.json'), `${JSON.stringify({ at: new Date().toISOString(), ...report, alert: delivery }, null, 2)}\n`);
    if (delivery.delivered === false) throw new Error(`the run finished as "${report.status}", but its ops alert was not delivered: ${delivery.reason}`);
  };

  const progress = [];
  let report;
  try {
    const abi = sanctionsListAbi();
    const account = privateKeyToAccount(cfg.privateKey);
    const chain = defineChain({
      id: Number(cfg.chainId),
      name: `chain ${cfg.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    });
    const client = createPublicClient({ chain, transport: http(cfg.rpc) });
    const wallet = createWalletClient({ account, chain, transport: http(cfg.rpc) });
    report = await runAdder({
      stateDir: cfg.stateDir,
      keepFiles: cfg.keepFiles,
      maxRemove: cfg.maxRemove,
      abi,
      progress,
      fetchSource: async () => {
        const part = join(cfg.stateDir, 'download.xml');
        await downloadToFile(OFAC_SDN_ADVANCED_URL, part);
        return part;
      },
      readCurrent: () => readCurrentFromChain(client, cfg.list, abi, cfg.chainId),
      latestVersion: () => client.readContract({ address: cfg.list, abi, functionName: 'listVersion' }),
      isAdder: () => client.readContract({ address: cfg.list, abi, functionName: 'isAdder', args: [account.address] }),
      send: async (call, { onSubmitted }) => {
        // Simulated first: a call the contract would refuse is reported with
        // its revert reason instead of spending gas.
        await client.call({ account: account.address, to: cfg.list, data: call.calldata });
        const hash = await wallet.sendTransaction({ to: cfg.list, data: call.calldata });
        onSubmitted(hash);
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
        if (receipt.status !== 'success') throw new Error(`applyUpdate at version ${call.expectedVersion} reverted in ${hash}`);
        console.log(`applyUpdate at version ${call.expectedVersion}: +${call.add.length}, included in ${hash} (block ${receipt.blockNumber})`);
        return { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
      },
      // "Applied" means final: wait for the finalized block to pass the last
      // inclusion, then check every transaction is still in the block it was
      // included in. A reorg that dropped one stops the run as such.
      confirmFinal: async (entries) => {
        const highest = entries.reduce((m, e) => (BigInt(e.blockNumber) > m ? BigInt(e.blockNumber) : m), 0n);
        const deadline = Date.now() + FINALITY_TIMEOUT_MS;
        for (;;) {
          const finalized = await client.getBlock({ blockTag: 'finalized' });
          if (finalized.number >= highest) break;
          if (Date.now() > deadline) throw new Error(`not final after ${FINALITY_TIMEOUT_MS / 60_000} minutes (finalized block ${finalized.number}, needed ${highest})`);
          await sleep(15_000);
        }
        for (const e of entries) {
          const receipt = await client.getTransactionReceipt({ hash: e.tx }).catch(() => null);
          if (!receipt || receipt.blockHash !== e.blockHash || receipt.status !== 'success') {
            throw new Error(`${e.tx} is no longer in block ${e.blockNumber} at finality — it was reorganized out`);
          }
        }
      },
    });
  } catch (e) {
    // The full message (viem's carries the request details), with the RPC
    // URL, the key and the bot token removed before it is written anywhere.
    const failed = failureReport(redact(e.message, secrets), progress);
    await finish(failed, summarizeFailure(failed), true);
    throw new Error(failed.error);
  }
  await finish(report, summarize(report), report.status === 'applied' || report.pendingDelistings > 0 || report.malformedValues.length > 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`sanctions-adder: ${redact(e.message, [process.env.SANCTIONS_ADDER_RPC_URL, process.env.SANCTIONS_ADDER_PRIVATE_KEY])}`);
    process.exit(1);
  });
}
