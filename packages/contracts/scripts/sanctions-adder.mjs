#!/usr/bin/env node
/**
 * #2443 — the SANCTIONS ADDER: one unattended run of the OFAC → `SanctionsList`
 * update, signed by the list's ADDER key and limited to what that key may do.
 *
 * The list splits its signers by direction (owner decision 2026-10-18, "Bot
 * adds, Safe removes"): the adder may only list addresses or record a
 * publication; delisting needs the remover, a multisig. This runner is the
 * adder half, run once a day by a systemd timer on an always-on machine
 * (ops/sanctions/). Each run:
 *
 *   1. downloads Treasury's SDN Advanced XML ONCE to the state directory and
 *      keeps it, named by publication date and hash, as the record of what
 *      was parsed — the remover's later run needs the SAME bytes;
 *   2. parses it once, in pieces (never the whole file in memory), so every
 *      chain is updated from the same publication;
 *   3. for every configured chain, concurrently and independently: reads the
 *      list at the finalized block, builds the update in ADDER-ONLY mode
 *      (every addition, in batches, and for a new publication its delistings
 *      DECLARED outstanding on-chain but not applied), simulates and sends
 *      each call, then waits until the list read at the finalized block
 *      shows every one (see {@link awaitFinality}) — only then is that chain
 *      "applied";
 *   4. reports once: the journal always, the ops Telegram chat when
 *      configured, and last-run.json, with one section per chain and whether
 *      the alert was delivered. A chain that stops part-way names what it
 *      already sent; one chain's failure never stops another's update.
 *      Outstanding delistings are reported on every run until the remover
 *      has applied them, since each is a compliance action someone owes.
 *
 * Which chains run: every chain in `SERVICE_CHAINS` whose RPC is set
 * (`RPC_<CHAIN>`, the keeper's names) and whose `sanctionsList` this release's
 * deployments.json records. The list address is never configured by hand: it
 * comes from the committed, reviewed artifact, as the keeper's Diamond does.
 * A chain with an RPC but no recorded list is reported as skipped.
 *
 * What it refuses, and leaves for a person: every refusal the diff tool makes
 * (a malformed or moved record, an unwitnessed delisting, too many
 * delistings, an older or conflicting publication), a list that moved past
 * the finalized block, a key that is not the list's adder ALONE (also a
 * remover or the owner), and an RPC that
 * serves a different chain. `SERVICE_CHAINS` holds testnets only: the
 * mainnet adder host is not decided (#2443). It never delists and never
 * rolls back.
 *
 * Configuration is environment only, one file for every chain
 * (ops/sanctions/sanctions-adder.env.example):
 *   SANCTIONS_ADDER_PRIVATE_KEY  the adder key; nothing else may hold it
 *   RPC_<CHAIN>                  one per chain to update (carries an API key)
 *   SANCTIONS_ADDER_STATE_DIR    where publications and the last report go
 *                                (default: $STATE_DIRECTORY, set by systemd)
 *   SANCTIONS_ADDER_KEEP_FILES   publications kept on disk (default 14)
 *   SANCTIONS_ADDER_MAX_REMOVE   delistings a publication may declare (default 10)
 *   TG_OPS_BOT_TOKEN, TG_OPS_CHAT_ID  the ops-internal bot; optional
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isEntryPoint } from './entry-point.mjs';
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
import { callAtHash } from './census-grandfathered-custody.mjs';
import {
  MAINNET_RPC_ENVS,
  SERVICE_CHAINS,
  chainClients,
  configuredChains,
  keepPublication,
  loadDeployments,
  notifyOps,
  privateKeySecret,
  readPrivateKey,
  redact,
  sendTransaction,
  sleep,
  writeStateFile,
} from './sanctions-service.mjs';

export const DEFAULT_KEEP_FILES = 14;

/** How long a run waits for its transactions to become final. */
export const FINALITY_TIMEOUT_MS = 40 * 60_000;

/** How often it reads the chain again while it waits. */
export const FINALITY_POLL_MS = 15_000;

/** Download (via `fetchSource`), parse and keep one publication. */
export async function loadPublication({ fetchSource, stateDir, keepFiles = DEFAULT_KEEP_FILES }) {
  const downloaded = await fetchSource();
  const { parsed, sourceHash, byteLength } = await parseSdnAdvancedFile(downloaded);
  const file = keepPublication(downloaded, stateDir, parsed.publicationDate, sourceHash, keepFiles);
  return {
    parsed,
    sourceHash,
    source: { file, sha256: sourceHash, bytes: byteLength, publicationId: parsed.publicationId, publicationDate: parsed.publicationDate, evmAddressCount: parsed.addresses.length },
  };
}

/**
 * The update of ONE chain's list from an already-parsed publication, with
 * every effect injected so the rule is testable:
 *   readCurrent()   → the list at the finalized block (readCurrentFromChain)
 *   listedSince(snapshot, addresses)
 *                   → each address's `listedSinceVersion`, read at that
 *                     snapshot's own block (pinned by its hash), as a Map
 *                     keyed by the lower-cased address
 *   latestVersion() → `listVersion` at the latest block
 *   roles()         → the signing key's roles on the list:
 *                     { adder, remover, owner } (booleans)
 *   send(call, { onSubmitted })
 *                   → simulates, signs and sends one call and waits for it to
 *                     be INCLUDED; calls `onSubmitted(hash)` with the signed
 *                     transaction's hash BEFORE broadcasting it, so a send
 *                     whose outcome is unknown (the connection dropped while
 *                     the node accepted it) is still reported by hash; returns
 *                     { hash, blockNumber, blockHash }
 *   finality        → optional { timeoutMs, pollMs, now, wait } for
 *                     {@link awaitFinality}, which confirms the sent calls
 *                     through `readCurrent` and `listedSince`
 *
 * `progress` (an array the caller passes in and keeps) receives one entry per
 * call before it is broadcast, and each entry's `state` moves from
 * `submitted` (signed, broadcast attempted) to `included` to `final`, or to
 * whatever the finality check could establish instead. The caller reads it
 * after a failure, so a chain that stops part-way says what it already sent
 * and what may still land, rather than reporting a refusal as if nothing had
 * happened. The chain is `applied` only when every entry is `final`.
 *
 * Returns the chain's report; throws on any refusal, before anything is sent
 * if the refusal is the tool's.
 */
export async function runChain({ publication, readCurrent, listedSince, latestVersion, roles, send, finality = {}, progress = [], maxRemove = DEFAULT_MAX_REMOVE, abi = sanctionsListAbi() }) {
  const { parsed, sourceHash } = publication;
  const current = await readCurrent();
  // The update is computed from the finalized state and sent at the latest
  // block. If the list has moved in between — another update not yet final —
  // the calls would be built on a stale version; wait for it to finalize.
  const latest = await latestVersion();
  if (BigInt(latest) !== BigInt(current.version)) {
    throw new Error(`the list is at version ${latest} but the finalized block shows ${current.version}; an update is not yet final — the next run retries`);
  }
  // The key must hold the adder role and nothing more: the runbook's bound on
  // a stolen key (it can list, never delist or appoint) holds only while
  // that is true, so a role granted to it later stops the service.
  const r = await roles();
  if (!r.adder) throw new Error('the signing key is not an adder of this SanctionsList — the owner appoints it with setAdder');
  if (r.remover || r.owner) {
    throw new Error(`the signing key is also the list's ${[r.remover && 'remover', r.owner && 'owner'].filter(Boolean).join(' and ')} — an unattended key must be the adder alone; revoke the extra role (setRemover(key, false), or move ownership) before it runs again`);
  }
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
    let included;
    try {
      included = await send(call, {
        onSubmitted: (hash) => {
          entry.tx = hash;
          entry.state = 'submitted';
        },
      });
    } catch (e) {
      // What the send is known to have done (sanctions-service SEND_OUTCOMES):
      // signed but refused by the node, or included and reverted.
      if (e?.sendOutcome === 'refused') entry.state = 'rejected';
      else if (e?.sendOutcome === 'reverted') entry.state = 'reverted';
      throw e;
    }
    Object.assign(entry, { tx: included.hash, blockNumber: included.blockNumber?.toString(), blockHash: included.blockHash, state: 'included' });
  }
  // What the report states about the list afterwards is read from the
  // finalized list, never from the plan: the snapshot that showed every call
  // final, or — with nothing sent — the one the update was computed from.
  let after = current;
  if (progress.length) {
    let confirmed;
    try {
      confirmed = await awaitFinality({ entries: progress, readCurrent, listedSince, sourceHash, ...finality });
    } catch (e) {
      settleEntries(progress, e?.outcomes);
      throw e;
    }
    settleEntries(progress, confirmed.outcomes);
    after = confirmed.list;
  }
  const summary = (l) => ({ atVersion: l.version.toString(), finalizedBlock: l.blockNumber?.toString(), count: l.addresses.length });
  return {
    status: progress.length ? 'applied' : 'up-to-date',
    list: summary(current),
    ...(progress.length ? { listAfter: summary(after) } : {}),
    publicationOrder: update.order,
    added: update.add,
    sent: progress,
    // What the finalized list declares outstanding after this run.
    pendingAdditions: Number(after.recordedPendingAdditions),
    pendingDelistings: Number(after.recordedPendingDelistings),
    delistingsForRemover: update.withheldRemovals,
  };
}

/** Record on each sent entry what the finality check established. */
function settleEntries(entries, outcomes = []) {
  entries.forEach((entry, i) => {
    const o = outcomes[i];
    if (!o) return;
    entry.state = o.state;
    if (o.finalizedBlock) entry.finalizedBlock = o.finalizedBlock;
  });
}

/**
 * What one list snapshot `s`, read at the finalized block, shows of one sent
 * call. `since` holds, for each address the call added, the version the list
 * records it was listed at (`listedSinceVersion`; 0 when it is not listed),
 * read at the SAME block.
 *
 * The list keeps only one piece of per-update history: the version at which
 * each address was listed. The publication and the outstanding counts are
 * kept for the latest update alone. So what a snapshot can establish depends
 * on how far the list has moved past the call's version `v`:
 *   pending   — not past `v`: the call has not applied yet, here.
 *   final     — exactly at `v + 1`, the call is the latest update: every
 *               address it added is listed at `v + 1`, and the list records
 *               its publication and the outstanding counts it declared. Or
 *               further on, with later updates on top: every address it added
 *               is still recorded as listed at `v + 1`. Either way the update
 *               at the call's version made the call's change.
 *   displaced — exactly at `v + 1` and the latest update is not the call:
 *               another update took its version, and this call can never
 *               apply, since the list takes an update only at the version it
 *               was computed against.
 *   overtaken — further on, and the list no longer records the call's change
 *               at `v + 1`: the call added nothing (so only the publication
 *               and counts the later updates replaced could show it), or one
 *               of its addresses is not recorded at `v + 1` (a later update
 *               delisted it, or another update took the version). Whether it
 *               applied is unknown from the list.
 */
function callOutcome(entry, s, sourceHash, since) {
  const version = BigInt(s.version);
  const at = BigInt(entry.expectedVersion) + 1n;
  if (version < at) return 'pending';
  const addedAtCall = entry.add.every((a) => since.get(a.toLowerCase()) === at);
  if (version > at) return entry.add.length > 0 && addedAtCall ? 'final' : 'overtaken';
  const latestIsCall =
    addedAtCall &&
    String(s.recordedHash).toLowerCase() === String(sourceHash).toLowerCase() &&
    Number(s.recordedPendingAdditions) === Number(entry.additionsLeft) &&
    Number(s.recordedPendingDelistings) === Number(entry.delistingsLeft);
  return latestIsCall ? 'final' : 'displaced';
}

/** Why a snapshot stops the wait at once, for the error it throws. */
const STOPPED = {
  displaced: (e, s) =>
    `the list at finalized block ${s.blockNumber} took version ${BigInt(e.expectedVersion) + 1n} with another update than ${e.tx}, so this call can never apply`,
  overtaken: (e, s) =>
    `the list at finalized block ${s.blockNumber} is at version ${s.version}, past version ${BigInt(e.expectedVersion) + 1n}, and no longer records whether ${e.tx} applied (` +
    (e.add.length ? 'an address it added is not recorded as listed at that version' : 'it added nothing, and later updates replaced the publication it recorded') +
    '): its outcome is unknown',
};

/** What each outcome short of final means, for the error a timeout throws. */
const NOT_FINAL = {
  included: (e) => `(included in block ${e.blockNumber} when sent) is not shown by the finalized list yet; it may still land, or have been reorganized out`,
  unread: () => 'is unknown: the finalized list could not be read',
};

/**
 * Wait until ONE snapshot of the list, read at the finalized block, shows
 * every call in `entries` (runChain's progress entries: `expectedVersion`,
 * `add`, `additionsLeft`, `delistingsLeft`, `tx`), and return
 * `{ outcomes, list }`: per entry `{ state: 'final', finalizedBlock }`, and
 * that snapshot.
 *
 * "Final" is a fact about the list, read the way every update is computed:
 * `readCurrent` takes one snapshot at the finalized block, every read pinned
 * to that block's hash, and `listedSince` reads the calls' addresses at the
 * same hash. A transaction receipt is not consulted. A receipt and the
 * finalized head come from separate RPC calls, which a load-balanced RPC may
 * answer from replicas on different forks; and a reorg can include a
 * transaction again in a block other than the one first seen. The list's own
 * state at one finalized block has neither problem, and it is what the
 * service exists to change.
 *
 * Every poll judges every call against that poll's snapshot alone (see
 * {@link callOutcome}); no verdict is carried from one snapshot to the next,
 * because two polls may be answered by different replicas, and calls each
 * shown by a different snapshot are not shown together by any. Each
 * outcome's `state` is one of:
 *   final     — the snapshot shows the call's change at its version;
 *   displaced — the snapshot's latest update took the call's version and is
 *               not the call, which can never apply;
 *   overtaken — later updates have moved the list on, and it no longer
 *               records whether the call applied;
 *   included  — the snapshot is not past the call's version yet;
 *   unread    — the snapshot could not be read.
 *
 * Throws, with `outcomes` on the error saying what the last poll established
 * for each call: at once when a call is displaced (conclusive) or overtaken
 * (no later snapshot can say more); otherwise at the deadline, when no
 * snapshot has shown every call. A failed read is never a verdict: the next
 * poll reads again.
 */
export async function awaitFinality({ entries, readCurrent, listedSince, sourceHash, timeoutMs = FINALITY_TIMEOUT_MS, pollMs = FINALITY_POLL_MS, now = Date.now, wait = sleep }) {
  const deadline = now() + timeoutMs;
  let outcomes = entries.map(() => ({ state: 'included' }));
  for (;;) {
    let snapshot = null;
    let since;
    try {
      snapshot = await readCurrent();
      // Only the calls the list is past need their addresses read.
      const past = entries.filter((e) => BigInt(snapshot.version) > BigInt(e.expectedVersion)).flatMap((e) => e.add);
      since = past.length ? await listedSince(snapshot, past) : new Map();
    } catch {
      snapshot = null;
    }
    if (snapshot) {
      const finalizedBlock = { number: snapshot.blockNumber?.toString(), hash: snapshot.blockHash };
      outcomes = entries.map((e) => {
        const seen = callOutcome(e, snapshot, sourceHash, since);
        return seen === 'pending' ? { state: 'included' } : { state: seen, finalizedBlock };
      });
      const stop = outcomes.findIndex((o) => o.state === 'displaced' || o.state === 'overtaken');
      if (stop >= 0) throw Object.assign(new Error(STOPPED[outcomes[stop].state](entries[stop], snapshot)), { outcomes });
      if (outcomes.every((o) => o.state === 'final')) return { outcomes, list: snapshot };
    } else {
      // What the last snapshot showed still stands for the report; what it
      // did not show is now unknown.
      outcomes = outcomes.map((o) => (o.state === 'final' ? o : { state: 'unread' }));
    }
    if (now() >= deadline) {
      const open = entries.flatMap((e, i) => (outcomes[i].state === 'final' ? [] : [`${e.tx} ${NOT_FINAL[outcomes[i].state](e)}`]));
      throw Object.assign(new Error(`no finalized list showed every call within ${timeoutMs / 60_000} minutes: ${open.join('; ')}`), { outcomes });
    }
    await wait(pollMs);
  }
}

/**
 * One run across every configured chain. `chains` is
 * `[{ slug, name, id, list, skipped?, effects }]`, where `effects` are
 * {@link runChain}'s injected effects and a chain carrying `skipped` (a
 * reason) is reported without being touched. The publication is loaded once;
 * a failure to load it throws, since no chain can proceed. Each chain then
 * runs concurrently, and a chain that throws is recorded as `refused` or
 * `stopped` (see {@link failureReport}) without affecting the others.
 * `redactError` cleans an error message before it is recorded.
 */
export async function runAdder({ fetchSource, stateDir, keepFiles = DEFAULT_KEEP_FILES, maxRemove = DEFAULT_MAX_REMOVE, abi = sanctionsListAbi(), chains, redactError = (m) => m }) {
  const publication = await loadPublication({ fetchSource, stateDir, keepFiles });
  const results = await Promise.all(
    chains.map(async (c) => {
      const head = { name: c.name, chainId: c.id, listAddress: c.list ?? null };
      if (c.skipped) return [c.slug, { ...head, status: 'skipped', reason: c.skipped }];
      const progress = [];
      try {
        return [c.slug, { ...head, ...(await runChain({ publication, ...c.effects, progress, maxRemove, abi })) }];
      } catch (e) {
        return [c.slug, { ...head, ...failureReport(redactError(String(e?.message ?? e)), progress) }];
      }
    }),
  );
  const byChain = Object.fromEntries(results);
  const statuses = Object.values(byChain).map((r) => r.status);
  return {
    // `ok` only when every chain that ran is applied or up to date; a skipped
    // chain is stated in its section, not counted as a failure.
    status: statuses.some((s) => s === 'refused' || s === 'stopped') ? 'failed' : 'ok',
    source: publication.source,
    malformedValues: publication.parsed.malformed,
    chains: byChain,
  };
}

/** Whether a chain's list still declares part of its publication
 *  outstanding — additions or delistings — which someone owes. */
export function hasOutstanding(c) {
  return c.pendingAdditions > 0 || c.pendingDelistings > 0;
}

/** Whether a run's outcome calls for an ops alert, not just the journal. */
export function needsAlert(report) {
  if (report.status !== 'ok' || report.malformedValues?.length) return true;
  return Object.values(report.chains ?? {}).some((c) => c.status === 'applied' || hasOutstanding(c));
}

/**
 * The report for a chain whose update threw, built from what it had already
 * sent. A chain that sent nothing is `refused`; one that broadcast anything is
 * `stopped`, and says per transaction whether it is final, included but not
 * yet final, included and reverted, or broadcast with no receipt seen (it
 * may still land).
 */
export function failureReport(reason, progress) {
  const sent = progress.filter((e) => e.tx && e.state !== 'rejected');
  return { status: sent.length ? 'stopped' : 'refused', error: reason, sent };
}

/** The lines a person reads for one chain that did not complete. */
export function summarizeFailure(report) {
  if (report.status === 'refused') return `REFUSED, nothing sent: ${report.error}`;
  const word = {
    final: 'final',
    included: 'included, NOT yet final',
    reverted: 'included but REVERTED — it listed nothing',
    submitted: 'signed and broadcast attempted, no receipt seen — it may still land',
    displaced: 'NOT applied — another update took its version in the finalized list, so it can never apply',
    overtaken: 'whether it applied is UNKNOWN — later updates moved the finalized list on, and it no longer records this call',
    unread: 'whether it is final is UNKNOWN — the finalized list could not be read',
  };
  const lines = [`STOPPED after broadcasting ${report.sent.length} transaction(s); later calls were not sent. ${report.error}`];
  for (const e of report.sent) lines.push(`  applyUpdate at version ${e.expectedVersion} (+${e.add.length}): ${e.tx} — ${word[e.state] ?? e.state}`);
  lines.push('  Check these on-chain before the next run; it rebuilds from the finalized list either way.');
  return lines.join('\n');
}

/** The lines a person reads for one chain. */
export function summarizeChain(c, sourceFile) {
  if (c.status === 'skipped') return `skipped: ${c.reason}`;
  if (c.status === 'refused' || c.status === 'stopped') return summarizeFailure(c);
  const lines = [];
  if (c.status === 'applied') {
    const at = c.sent.reduce((m, e) => (e.finalizedBlock && BigInt(e.finalizedBlock.number) > m ? BigInt(e.finalizedBlock.number) : m), 0n);
    lines.push(`listed ${c.added.length} new address(es) in ${c.sent.length} transaction(s), all final (the list at finalized block ${at} shows them): ${c.sent.map((e) => e.tx).join(', ')}.`);
  } else lines.push(c.pendingAdditions > 0 ? 'nothing left to list from this publication; nothing sent.' : 'already follows this publication; nothing sent.');
  if (c.pendingAdditions > 0) {
    // After this run sent every missing address, a non-zero count means the
    // list declares more additions than the publication has: an earlier
    // update overstated it. The adder cannot lower a recorded count, so this
    // needs the owner.
    lines.push(`the list still declares ${c.pendingAdditions} addition(s) outstanding that this publication does not supply — an earlier update overstated the count, and the list will not read as current until a person corrects it.`);
  }
  if (c.pendingDelistings > 0) {
    lines.push(
      `${c.pendingDelistings} delisting(s) await the remover (the Safe)${c.delistingsForRemover.length ? `: ${c.delistingsForRemover.join(', ')}` : ''}. ` +
        `Confirm each against OFAC's Recent Actions notice, then run ofac-sanctions-diff.mjs --xml ${sourceFile} --chain-id ${c.chainId} --list ${c.listAddress} --confirm-delist … and send its remover calls from the Safe.`,
    );
  }
  return lines.join('\n  ');
}

/** The summary a person reads, in the journal and the chat: the
 *  publication, then one section per chain. */
export function summarize(report) {
  const s = report.source;
  const lines = [`OFAC ${s.publicationId} (sha256 ${s.sha256.slice(0, 18)}…): ${s.evmAddressCount} EVM addresses.`];
  for (const [slug, c] of Object.entries(report.chains)) lines.push(`${c.name ?? slug}: ${summarizeChain(c, s.file)}`);
  if (report.malformedValues?.length) lines.push(`${report.malformedValues.length} malformed digital-currency value(s) need review: ${report.malformedValues.map((m) => JSON.stringify(m.value)).join(', ')}.`);
  return lines.join('\n');
}

/** Read and check the configuration; throws naming every missing setting. */
export function readConfig(env) {
  const missing = [];
  if (!env.SANCTIONS_ADDER_PRIVATE_KEY) missing.push('SANCTIONS_ADDER_PRIVATE_KEY');
  const chains = configuredChains(env);
  if (chains.length === 0) missing.push(`an RPC for at least one chain (${SERVICE_CHAINS.map((c) => c.rpcEnv).join(', ')})`);
  const stateDir = env.SANCTIONS_ADDER_STATE_DIR || env.STATE_DIRECTORY;
  if (!stateDir) missing.push('SANCTIONS_ADDER_STATE_DIR (or systemd StateDirectory=)');
  if (missing.length) throw new Error(`not configured: ${missing.join(', ')}`);
  const privateKey = readPrivateKey('SANCTIONS_ADDER_PRIVATE_KEY', env.SANCTIONS_ADDER_PRIVATE_KEY);
  return {
    chains,
    ignoredMainnetRpcs: MAINNET_RPC_ENVS.filter((k) => env[k]),
    privateKey,
    // Colon-separated by systemd when several are configured; ours is one.
    stateDir: stateDir.split(':')[0],
    keepFiles: env.SANCTIONS_ADDER_KEEP_FILES ? Number(parseUintArg('SANCTIONS_ADDER_KEEP_FILES', env.SANCTIONS_ADDER_KEEP_FILES, { min: 1n, max: 1000n })) : DEFAULT_KEEP_FILES,
    maxRemove: env.SANCTIONS_ADDER_MAX_REMOVE ? Number(parseUintArg('SANCTIONS_ADDER_MAX_REMOVE', env.SANCTIONS_ADDER_MAX_REMOVE, { max: 1_000_000n })) : DEFAULT_MAX_REMOVE,
    tgToken: env.TG_OPS_BOT_TOKEN || '',
    tgChatId: env.TG_OPS_CHAT_ID || '',
  };
}

/**
 * Each configured chain with the list this release records for it, or the
 * reason it is skipped. The address comes only from deployments.json — the
 * committed, reviewed artifact — never from configuration.
 */
export function planChains(chains, deployments) {
  return chains.map((c) => {
    const recorded = deployments[String(c.id)]?.sanctionsList;
    if (!recorded) {
      return { ...c, skipped: `no SanctionsList is recorded for chain ${c.id} in this release's deployments.json — deploy one (DeploySanctionsList), export deployments, merge, and install that commit` };
    }
    return { ...c, list: getAddress(recorded) };
  });
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

/** {@link runChain}'s effects for one chain, against its RPC. */
function chainEffects(c, account, abi) {
  const { client, wallet } = chainClients(c, account);
  return {
    // Checks the RPC serves chain `c.id` before reading anything.
    readCurrent: () => readCurrentFromChain(client, c.list, abi, BigInt(c.id)),
    // At the snapshot's own block, by its hash, so a verdict rests on one
    // snapshot. One read at a time: a free-tier RPC refuses a burst.
    listedSince: async (snapshot, addresses) => {
      const block = { hash: snapshot.blockHash, number: snapshot.blockNumber };
      const since = new Map();
      for (const a of addresses) {
        since.set(a.toLowerCase(), BigInt(await callAtHash(client, block, { address: c.list, abi, functionName: 'listedSinceVersion', args: [a] })));
      }
      return since;
    },
    latestVersion: () => client.readContract({ address: c.list, abi, functionName: 'listVersion' }),
    roles: async () => {
      const [adder, remover, owner] = await Promise.all([
        client.readContract({ address: c.list, abi, functionName: 'isAdder', args: [account.address] }),
        client.readContract({ address: c.list, abi, functionName: 'isRemover', args: [account.address] }),
        client.readContract({ address: c.list, abi, functionName: 'owner' }),
      ]);
      return { adder, remover, owner: getAddress(owner) === account.address };
    },
    send: async (call, { onSubmitted }) => {
      const label = `applyUpdate at version ${call.expectedVersion}`;
      const included = await sendTransaction({ client, wallet, account, to: c.list, data: call.calldata, onSubmitted, label });
      console.log(`${c.name}: ${label}: +${call.add.length}, included in ${included.hash} (block ${included.blockNumber})`);
      return included;
    },
  };
}

async function main() {
  if (process.argv.includes('--check')) return check();
  // Settings that cannot be read leave nowhere to report but the journal:
  // there is no state directory or chat to trust yet.
  const cfg = readConfig(process.env);
  const secrets = [...cfg.chains.map((c) => c.rpc), privateKeySecret(cfg.privateKey), cfg.tgToken];
  const clean = (m) => redact(m, secrets);
  if (!cfg.tgToken || !cfg.tgChatId) console.log('TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset: this run reports to the journal only.');
  if (cfg.ignoredMainnetRpcs.length) console.log(`ignored ${cfg.ignoredMainnetRpcs.join(', ')}: the adder runs on testnets only until a hardened mainnet host is decided (#2443).`);
  mkdirSync(cfg.stateDir, { recursive: true });

  // EVERY outcome leaves through here: the journal, the chat when the
  // outcome calls for it, and last-run.json — written after the chat, so it
  // records whether the alert was delivered. The unit fails when any chain
  // failed, the alert was not delivered or last-run.json could not be
  // written, so each shows in `systemctl --failed` rather than nowhere. The
  // write never throws (writeStateFile), so a full disk cannot replace the
  // run's own outcome with its error.
  const finish = async (report, text, alert) => {
    console.log(text);
    const delivery = alert ? await notifyOps({ label: 'sanctions adder', token: cfg.tgToken, chatId: cfg.tgChatId, text }) : { skipped: true, reason: 'nothing to alert' };
    const unsaved = writeStateFile(cfg.stateDir, 'last-run.json', { at: new Date().toISOString(), ...report, alert: delivery });
    const problems = [];
    if (report.status !== 'ok') problems.push(`the run finished as "${report.status}"`);
    if (delivery.delivered === false) problems.push(`its ops alert was not delivered: ${delivery.reason}`);
    if (unsaved) problems.push(`last-run.json was not written: ${clean(unsaved)}`);
    if (problems.length) throw new Error(problems.join('; '));
  };

  const plan = planChains(cfg.chains, loadDeployments());
  if (plan.every((c) => c.skipped)) {
    // Nothing to update: stop before downloading 128 MB for no chain.
    const report = { status: 'refused', error: 'no configured chain has a SanctionsList recorded in this release', chains: Object.fromEntries(plan.map((c) => [c.slug, { name: c.name, chainId: c.id, listAddress: null, status: 'skipped', reason: c.skipped }])) };
    return finish(report, `REFUSED, nothing sent: ${report.error}.\n${plan.map((c) => `${c.name}: skipped: ${c.skipped}`).join('\n')}`, true);
  }

  let report;
  try {
    const abi = sanctionsListAbi();
    const account = privateKeyToAccount(cfg.privateKey);
    report = await runAdder({
      stateDir: cfg.stateDir,
      keepFiles: cfg.keepFiles,
      maxRemove: cfg.maxRemove,
      abi,
      redactError: clean,
      fetchSource: async () => {
        const part = join(cfg.stateDir, 'download.xml');
        await downloadToFile(OFAC_SDN_ADVANCED_URL, part);
        return part;
      },
      chains: plan.map((c) => (c.skipped ? c : { ...c, effects: chainEffects(c, account, abi) })),
    });
  } catch (e) {
    // Only the download, the parse or the setup gets here: each chain's own
    // failure is recorded in its section instead. Nothing has been sent.
    // The message has the RPC URLs, the key and the bot token removed.
    const failed = { status: 'refused', error: clean(e.message), chains: {} };
    return finish(failed, `REFUSED before any chain, nothing sent: ${failed.error}`, true);
  }
  await finish(report, summarize(report), needsAlert(report));
}

if (isEntryPoint(import.meta)) {
  main().catch((e) => {
    console.error(`sanctions-adder: ${redact(e.message, [...SERVICE_CHAINS.map((c) => process.env[c.rpcEnv]), privateKeySecret(process.env.SANCTIONS_ADDER_PRIVATE_KEY), process.env.TG_OPS_BOT_TOKEN])}`);
    process.exit(1);
  });
}
