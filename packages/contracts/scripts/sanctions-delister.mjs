#!/usr/bin/env node
/**
 * #2443 — the SANCTIONS DELISTER: one unattended run of the delisting side of
 * the OFAC → `SanctionsList` update, signed by the timelock's PROPOSER key and
 * limited to what that key may do.
 *
 * Delisting is the one change no unattended key may make by itself (owner
 * decisions D-A to D-F, 2026-10-18, recorded in
 * docs/DesignsAndPlans/SanctionsDelistingTimelockDesign.md): this bot only
 * PROPOSES a delisting to the `SanctionsDelistingTimelock`, the Safe may veto
 * it during the waiting window, and it executes only while RedStone's
 * Sanctions Oracle, read after the window, does not flag the address. Each
 * run, for every configured chain with a timelock recorded:
 *
 *   1. reads the timelock, the list and every pending proposal (cheap; no
 *      download);
 *   2. only when there is publication work — a delisting the list declares
 *      outstanding that no proposal covers and that could be proposed now,
 *      one of this key's proposals left behind by a newer publication, or a
 *      proposal ready to execute — downloads OFAC's two exports of the
 *      publication ONCE for every chain: the SDN Advanced XML (the file the
 *      list records by hash) and the plain SDN.XML (ofac-sdn-plain.mjs). A
 *      chain is re-checked against them when its state changes, and at least
 *      once a day while the work lasts, so an hourly timer does not download
 *      150 MB an hour for a delisting the Safe vetoed. Only a conclusive
 *      reading of a chain this run left untouched is remembered: a failed
 *      download, OFAC publishing between the two downloads, or any send at
 *      all (inclusion is not finality) leaves the next run to read the files
 *      again;
 *   3. moves every pending proposal on as far as it can go:
 *        - discards one whose proposer the owner removed (anyone may);
 *        - withdraws one of ITS OWN that can no longer execute: an address
 *          vetoed, flagged by RedStone, already delisted by other means, or
 *          no longer delisted by OFAC's newer file;
 *        - reconfirms one of its own onto a newer publication once every
 *          address in it is still a delisting there (the window is kept);
 *        - after the window, on the cross-chain RedStone route, requests the
 *          clearance on the timelock's chain, then, once the attestor has
 *          read RedStone, sends the reply it owes on the attestor's chain;
 *        - executes it once `readiness` reports ready;
 *      requesting and executing wait while the list is mid-update or while
 *      OFAC serves a newer publication than the list records;
 *   4. proposes the rest: the publication's delistings that BOTH files
 *      support (absent from the advanced file by the diff tool's witness
 *      rule, and absent from the plain file), minus addresses already
 *      proposed, vetoed by the Safe, or flagged by RedStone now, within what
 *      the list declares outstanding;
 *   5. reports once: the journal always, the ops Telegram chat when something
 *      was sent, failed, or needs a person (repeated once a day while it
 *      lasts), and last-run.json. A state file that cannot be written (a
 *      full disk) is named in that report and fails the unit; it never
 *      stops the report.
 *
 * Which chains run: every chain in `SERVICE_CHAINS` whose RPC is set
 * (`RPC_<CHAIN>`, the keeper's names) and whose `sanctionsDelistingTimelock`
 * and `sanctionsList` this release's deployments.json records. A configured
 * chain with no timelock still serves as the attestor chain of another's
 * cross-chain route, and the key's roles on its recorded list are checked
 * all the same. No address is ever configured by hand; the attestor and its
 * chain are read from the timelock itself.
 *
 * What it refuses, and leaves for a person: a key that is not a proposer
 * ALONE — the timelock's owner, or the adder, remover or owner of the list
 * recorded on ANY configured chain, a timelock chain or an attestor host
 * alike, checked before the key is used there at all; a timelock recorded
 * for one list that serves another; an RPC that serves a different chain,
 * whether a timelock's or an attestor's. Publication work is refused, while
 * the rest of the run goes on, for a file the list does not record, a
 * delisting the advanced file still witnesses, a count that disagrees with
 * what the list declares outstanding, two OFAC files that disagree, and a
 * digital-currency value either file carries that is not a readable address
 * (any may be a damaged copy of an address being delisted). An address only
 * one file supports, or that RedStone flags, is left for the Safe and named
 * in the report. It never lists, never delists by itself, never lifts a veto.
 *
 * Which oracle answered is stated, never assumed. On a test network, where
 * RedStone has no deployment, the clearance may be read from
 * `TestnetSanctionsOracleStandIn`, which flags only what its owner flags.
 * Every run asks the oracle it reads whether it is that stand-in, when it last
 * updated and, for the stand-in, who owns it and whether a transfer is
 * pending, and each note, action and report line names the answer: "the testnet stand-in for RedStone" when the oracle itself says so,
 * and "the clearance oracle" otherwise (see {@link identifyOracle},
 * {@link clearanceOracleName}). No run names an oracle RedStone: this release
 * runs on test networks only, where RedStone has no deployment, so nothing it
 * could read would establish it. The attestor chain's own report says the
 * same of the oracle it reads.
 *
 * Configuration is environment only, one file for every chain
 * (ops/sanctions/sanctions-delister.env.example):
 *   SANCTIONS_DELISTER_PRIVATE_KEY  the proposer key; nothing else may hold it
 *   RPC_<CHAIN>                     one per chain (carries an API key)
 *   TG_OPS_BOT_TOKEN, TG_OPS_CHAT_ID  the ops-internal bot; optional
 *   SANCTIONS_DELISTER_STATE_DIR    defaults to $STATE_DIRECTORY (systemd)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbi, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isEntryPoint } from './entry-point.mjs';
import {
  OFAC_SDN_ADVANCED_URL,
  assertDelistingsWitnessed,
  diffSets,
  downloadToFile,
  parseSdnAdvancedFile,
  readCurrentFromChain,
  samePublication,
  sanctionsListAbi,
} from './ofac-sanctions-diff.mjs';
import { OFAC_SDN_PLAIN_URL, parseSdnPlainFile, plainWitness } from './ofac-sdn-plain.mjs';
import {
  MAINNET_RPC_ENVS,
  SERVICE_CHAINS,
  chainClients,
  configuredChains,
  createSendQueues,
  keepPublication,
  loadDeployments,
  notifyOps,
  privateKeySecret,
  readPrivateKey,
  redact,
  sendTransaction,
  writeStateFile,
} from './sanctions-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = 'sanctions delister';

export const DEFAULT_KEEP_FILES = 14;
/** A chain with outstanding delistings is re-checked at least this often. */
export const RE_EVALUATE_MS = 24 * 60 * 60_000;
/** A condition that needs a person is alerted when it starts, then this often. */
export const ALERT_REPEAT_MS = 24 * 60 * 60_000;
/** The most addresses one proposal may carry (the timelock's MAX_BATCH). */
export const MAX_BATCH = 100;
/** Fee margin over a CCIP quote; the contracts refund what is not used. */
export const FEE_MARGIN_BPS = 1_000n;
/** Below this the key is reported as running out of gas money. */
export const LOW_BALANCE_WEI = 5_000_000_000_000_000n;
/** How far before a request the attestor's chain is searched for the reply,
 *  to allow for the two chains' clocks disagreeing. */
const CLOCK_SKEW_S = 600n;

/** The timelock's enums, by position. */
export const ROUTE = Object.freeze(['Unavailable', 'Local', 'CrossChain']);
const CROSS_CHAIN = ROUTE.indexOf('CrossChain');
const LOCAL = ROUTE.indexOf('Local');
const STATUS_PENDING = 1;

/** The compiled ABIs — never hand-typed. */
export function timelockAbi() {
  return JSON.parse(readFileSync(join(HERE, '..', 'src', 'abis', 'SanctionsDelistingTimelock.json'), 'utf8'));
}
export function attestorAbi() {
  return JSON.parse(readFileSync(join(HERE, '..', 'src', 'abis', 'SanctionsClearanceAttestor.json'), 'utf8'));
}
export function standInAbi() {
  return JSON.parse(readFileSync(join(HERE, '..', 'src', 'abis', 'TestnetSanctionsOracleStandIn.json'), 'utf8'));
}
/** RedStone's oracle has no compiled ABI here; this is the one read both it
 *  and the stand-in answer, as the contracts call it (`ISanctionsList`). */
const ORACLE_ABI = parseAbi(['function isSanctioned(address) view returns (bool)']);

/** How a report names the testnet stand-in. */
export const STAND_IN_NAME = 'the testnet stand-in for RedStone';

/** What {@link identifyOracle} can establish about an oracle: the stand-in,
 *  on its own answer, or nothing. There is deliberately no RedStone value —
 *  see {@link identifyOracle}. */
export const ORACLE_IDENTITY = Object.freeze({ STAND_IN: 'stand-in', UNKNOWN: 'unknown' });

/**
 * The name every note, action and report line gives the oracle a chain's
 * clearance is read from, from what this run established about it
 * (`snap.clearanceOracle.identity`, see {@link identifyOracle}) — never a
 * name the run did not establish.
 */
export function clearanceOracleName(snap) {
  const identity = snap?.clearanceOracle?.identity;
  if (identity === ORACLE_IDENTITY.STAND_IN) return STAND_IN_NAME;
  return 'the clearance oracle';
}

/**
 * Who controls the stand-in, from its owner and pending owner read this run
 * (see {@link identifyOracle}) — never an assumed admin. `flags` and `stale`
 * describe it in a report line; `refresh` is the step that re-publishes it,
 * or null when nobody can, and then `blocked` says what moves it on instead.
 */
export function standInControl(o) {
  const pending = o.pendingOwner && !/^0x0{40}$/i.test(o.pendingOwner) ? `; an ownership transfer to ${o.pendingOwner} is pending, and that account controls it once it accepts` : '';
  const pendingUnknown = o.pendingOwner === null ? '; whether an ownership transfer is pending could not be read' : '';
  if (o.owner === null || o.owner === undefined) {
    return {
      flags: `its owner could not be read this run, so who controls its flags is not known${pendingUnknown}`,
      stale: 'it goes stale unless its owner re-publishes it',
      refresh: 'its owner (not read this run) re-publishes it with markUpdated',
      blocked: null,
    };
  }
  if (/^0x0{40}$/i.test(o.owner)) {
    return {
      flags: 'it has no owner (ownership renounced), so its flags can no longer change',
      stale: 'nobody can re-publish it, so once stale it stays stale',
      refresh: null,
      blocked: "its ownership was renounced, so nobody can re-publish it; only a new clearance source on the timelock moves this on",
    };
  }
  return {
    flags: `it flags only what its owner ${o.owner} flags${pending}${pendingUnknown}`,
    stale: 'it goes stale unless its owner re-publishes it',
    refresh: `its owner ${o.owner} re-publishes it with markUpdated`,
    blocked: null,
  };
}

/** A chain time in seconds as an ISO string. Never throws: a report is
 *  written whatever a chain returned, so a value no date can hold reads as
 *  unreadable instead of aborting the run. */
const isoAt = (seconds) => {
  const at = new Date(Number(seconds) * 1000);
  return Number.isNaN(at.getTime()) ? `an unreadable time (${seconds})` : at.toISOString();
};

/**
 * Why a matured proposal reads `OracleStale`, and what — if anything — moves
 * it on, from what this run observed. On the local route the timelock judged
 * the oracle's freshness at this block, so the oracle itself is stale. On the
 * cross-chain route it judged the update time the attestor's ANSWER carried,
 * which is older than the oracle may be now: the oracle's current update
 * time decides whether it needs refreshing at all, or only a new request,
 * which this bot sends once the current one expires. Only the stand-in is
 * refreshed by anyone here: its owner as read this run, with `markUpdated`
 * ({@link standInControl}).
 */
function staleWhy(snap, p, who) {
  const o = snap.clearanceOracle ?? {};
  const control = o.identity === ORACLE_IDENTITY.STAND_IN ? standInControl(o) : null;
  const refresh = control?.refresh ?? null;
  const blocked = control?.blocked ?? 'nothing here can move it on until it updates';
  const wait = refresh ? `; ${refresh}` : `; ${blocked}`;
  const current = o.updatedAt === null || o.updatedAt === undefined ? null : BigInt(o.updatedAt);
  if (snap.route !== CROSS_CHAIN) {
    return `${who}${current !== null ? ` was last updated ${isoAt(current)},` : ' is'} older than the timelock accepts${wait}`;
  }
  const answered = BigInt(p.clearance?.oracleUpdatedAt ?? 0n);
  const head = `its clearance answer carries ${answered > 0n ? `an update time of ${isoAt(answered)}` : 'no readable update time'} for ${who}, older than the timelock accepts`;
  const next = 'the next clearance request, which this bot sends once this one expires';
  if (current === null) {
    return `${head}; the current update time of ${who} could not be read${o.detail ? ` (${o.detail})` : ''}, so whether it has updated since is not known${refresh ? `; if it has not, ${refresh}` : control?.blocked ? `; if it has not, ${control.blocked}` : ''}, and ${next}, carries whatever it holds then`;
  }
  const maxAge = snap.oracleMaxAge === null || snap.oracleMaxAge === undefined ? null : BigInt(snap.oracleMaxAge);
  // The timelock's own rule: stale once its clock passes updatedAt + maxAge.
  if (maxAge !== null && BigInt(snap.now) <= current + maxAge) {
    return `${head}; ${who} has updated since (${isoAt(current)}), and ${next}, carries that`;
  }
  return `${head}; ${who} itself was last updated ${isoAt(current)}, also too old${refresh ? `: ${refresh}, and ${next}, carries the new time` : `; ${blocked}`}`;
}

/** selector → error name, for reading `readiness`'s reason. */
export function errorNames(abi) {
  const names = new Map();
  for (const e of abi) if (e.type === 'error') names.set(toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`), e.name);
  return names;
}

const lower = (a) => a.toLowerCase();
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && lower(a) === lower(b);

// ── The pure core ─────────────────────────────────────────────────────

/**
 * What decides whether a chain's publication work can be skipped this run:
 * every value a propose or a reconfirm depends on, and where every pending
 * proposal stands. A proposal moving to a new stage — out of its window,
 * requested, answered, ready — changes it, so each step that advances a
 * proposal is taken on a reading of OFAC's files made in that same state. A
 * change in any of them, or a day passing, means the chain is checked
 * against OFAC's files again.
 */
export function fingerprint(snap) {
  const l = snap.list;
  return [l.sourceHash, l.publicationDate, l.version, l.pendingDelistings, snap.reservedDelistings, snap.proposalCount, snap.route, snap.timelockIsRemover, snap.proposals.map((p) => `${p.id}:${stage(snap, p)}`).join(',')].join('|');
}

/** The reasons a snapshot rules out acting at all, as a refusal message.
 *  The key's roles on the list are not here: they are checked on every chain
 *  the key is used on, before any use (see {@link listRoleRefusal}). */
export function refusal(snap) {
  if (!sameAddress(snap.timelockList, snap.list.address)) {
    return `the recorded timelock serves list ${snap.timelockList}, not the recorded list ${snap.list.address} — fix the release's deployments.json`;
  }
  const r = snap.roles;
  if (!r.proposer) return 'the signing key is not a proposer of this timelock — the owner appoints it with setProposer';
  if (r.timelockOwner) return "the signing key is also the timelock's owner — an unattended key must be the proposer alone; move ownership before it runs again";
  return null;
}

/**
 * Why the key may not be used on a chain, given its roles on the list
 * recorded there, or null. The key must be a proposer and nothing else, so a
 * stolen copy can do no more than propose into a window the Safe may veto. A
 * role on a list is a power over that chain's screening whatever this service
 * does there, so it is checked on EVERY chain the key is used on — a timelock
 * chain and a chain that only hosts an attestor alike — in one place, the
 * client lookup ({@link createClientLookup}), before any read or send.
 */
export function listRoleRefusal({ adder, remover, owner }) {
  const extra = [adder && "the list's adder", remover && "the list's remover", owner && "the list's owner"].filter(Boolean);
  if (!extra.length) return null;
  return `the signing key is also ${extra.join(' and ')} on this chain — an unattended key must be a proposer alone; remove the extra role before it runs again`;
}

/**
 * Whether a chain's state calls for OFAC's files, and the cache allows it.
 * Three things need them: a new proposal that could land, one of this key's
 * proposals left behind by a newer publication, and any proposal with a step
 * that moves it toward a delisting — a clearance to request, an answer to
 * relay, an execution — since each is taken only on a reading of the files
 * made in this same state (see {@link planChain}).
 */
export function wantsPublication(snap, key, cached, nowMs) {
  if (refusal(snap) || !publicationGate(snap)) return false;
  if (!canPropose(snap) && ownStale(snap, key).length === 0 && !snap.proposals.some((p) => ADVANCING.has(stage(snap, p)))) return false;
  return !freshCache(snap, cached, nowMs);
}

/** A cache entry that still describes this chain's state. An entry stamped
 *  in the future (the host clock was corrected backwards) is stale, so a
 *  clock error can never stretch the re-read window. */
function freshCache(snap, cached, nowMs) {
  if (!cached || typeof cached !== 'object' || cached.fingerprint !== fingerprint(snap)) return false;
  const age = nowMs - cached.at;
  return age >= 0 && age < RE_EVALUATE_MS;
}

/** Publication-derived actions read the FINALIZED list; they wait while the
 *  latest block shows a newer version, as the adder does. */
function publicationGate(snap) {
  return BigInt(snap.list.latestVersion) === BigInt(snap.list.version);
}

/** Whether a proposal names the publication the list records: hash AND
 *  date, the pair `execute` compares (PublicationChanged otherwise). */
function proposalOfListPublication(snap, p) {
  return samePublication({ date: p.publicationDate, hash: p.sourceHash }, { date: snap.list.publicationDate, hash: snap.list.sourceHash });
}

/**
 * Where a pending proposal stands, as far as the next step goes: its
 * proposer removed, an address already delisted another way (`readiness`
 * does not check that; the removal inside `execute` does), under an older
 * publication, in its window, ready, or the reason `readiness` gives — with
 * the relay's state when that reason is an unanswered clearance.
 */
function stage(snap, p) {
  if (!p.proposerAppointed) return 'unappointed';
  if (p.unlisted.length) return 'unlisted';
  if (!proposalOfListPublication(snap, p)) return 'stale';
  if (BigInt(snap.now) < BigInt(p.eta)) return 'window';
  const next = p.ready ? 'ready' : p.reason === 'ClearanceNotAnswered' ? `${p.reason}:${p.relay?.status ?? 'unknown'}` : String(p.reason);
  if (!ADVANCING.has(next)) return next;
  // Two things close every step toward a delisting, whatever the proposal:
  // a timelock that is no longer a remover can complete none (`readiness`
  // does not check the list's own authorization, so this is the one place
  // that does; revoking it is the owner's one-call shutdown of the route),
  // and a cross-chain request, a paid CCIP message, with no proven way back
  // for its answer would be paid for again at every expiry.
  if (!snap.timelockIsRemover) return `${next}:closed`;
  if (NEEDS_REQUEST.has(next) && snap.route === CROSS_CHAIN && !snap.relayPath?.ok) return `${next}:no-relay`;
  return next;
}

/** The readiness reasons whose next step is a (paid) clearance request. */
const NEEDS_REQUEST = new Set(['ClearanceNotRequested', 'ClearanceExpired']);

/** The stages with a step that moves a proposal toward a delisting:
 *  executing, requesting the clearance, relaying RedStone's answer. */
const ADVANCING = new Set(['ready', 'ClearanceNotRequested', 'ClearanceExpired', 'ClearanceNotAnswered:owed']);

/** The delistings the list declares outstanding that no proposal reserves. */
function freeDelistings(snap) {
  return snap.list.pendingDelistings - snap.reservedDelistings;
}

/** Whether a new proposal could land on this chain now: the timelock may
 *  delist, a RedStone check is configured, the list is final, and part of
 *  its outstanding delistings is unreserved. */
function canPropose(snap) {
  return Boolean(snap.timelockIsRemover) && snap.route !== 0 && publicationGate(snap) && freeDelistings(snap) > 0;
}

/** This key's pending proposals left behind by a newer publication. */
function ownStale(snap, key) {
  return snap.proposals.filter((p) => sameAddress(p.proposer, key) && p.proposerAppointed && p.unlisted.length === 0 && !proposalOfListPublication(snap, p));
}

/**
 * One chain's reading of the publication: the delistings both OFAC files
 * support. `publication` is `{ advanced: {parsed, sourceHash}, plain:
 * {parsed} }`, `{ error }` when loading failed, or null when it was not
 * loaded. Returns `{ status: 'ready', removals, absent, stillMentioned }`, or
 * `{ status, reason }` with status `not-loaded`, `mismatch` (OFAC serves a
 * newer publication than the list records, which the adder will record) or
 * `refused` (the files or the counts do not support an unattended delisting,
 * or the run could not tell). Only `ready` lets a proposal be made or moved
 * toward a delisting. `transient` travels with an outcome that may change
 * with no change on the chain (a failed download, OFAC publishing between the
 * two downloads, a stale copy): it is never cached, and the next run reads
 * the files again.
 */
export function evaluatePublication(snap, publication) {
  if (!publication) return { status: 'not-loaded', reason: 'OFAC files not loaded this run' };
  if (publication.error) return { status: 'refused', transient: true, reason: publication.error };
  const { advanced, plain } = publication;
  const served = Number(advanced.parsed.publicationDate);
  const recorded = Number(snap.list.publicationDate);
  if (lower(advanced.sourceHash) !== lower(snap.list.sourceHash)) {
    const what = `the list records publication ${recorded} (${snap.list.sourceHash.slice(0, 18)}…) and OFAC served ${served} (${advanced.sourceHash.slice(0, 18)}…) to this run`;
    if (served < recorded) return { status: 'refused', transient: true, reason: `${what}, an older copy than the list's; the next run downloads again` };
    if (served === recorded) {
      // A same-day reissue: the adder applies it only after the owner
      // authorizes a rollback (checkPublicationOrder), so it will not
      // resolve by itself.
      return { status: 'refused', reason: `${what}, a different file under the list's own date — a same-day reissue, which the adder applies only with the owner's authorizePublicationRollback; a person must reconcile it` };
    }
    return { status: 'mismatch', reason: `${what}, a newer publication; proposals wait for the adder to record it` };
  }
  if (served !== recorded) {
    return { status: 'refused', reason: `the list records date ${recorded} for this file, which is dated ${served} — a person must reconcile the list's record` };
  }
  if (Number(plain.parsed.publicationDate) !== served) {
    return { status: 'refused', transient: true, reason: `the plain SDN file is publication ${plain.parsed.publicationDate} but the advanced file is ${served} — OFAC published between the two downloads; the next run downloads both again` };
  }
  try {
    const { remove } = diffSets(advanced.parsed.addresses, snap.list.addresses);
    assertDelistingsWitnessed(advanced.parsed, remove);
    if (remove.length !== snap.list.pendingDelistings) {
      throw new Error(`the publication calls for ${remove.length} delisting(s) but the list declares ${snap.list.pendingDelistings} outstanding — a person must reconcile the list with the file`);
    }
    const { absent, stillMentioned } = plainWitness(plain.parsed, advanced.parsed, remove);
    return { status: 'ready', removals: remove, absent, stillMentioned };
  } catch (e) {
    return { status: 'refused', reason: String(e?.message ?? e) };
  }
}

/** The addresses {@link planChain} needs per-address facts for: only when a
 *  new proposal could land, since only a proposal reads them. */
export function factsWanted(snap, evaluation) {
  return evaluation.status === 'ready' && canPropose(snap) ? evaluation.absent : [];
}

/**
 * One chain's plan: the actions to send, the notes a reader needs, and the
 * items left for a person (`review`). PURE. `facts` maps each address of
 * {@link factsWanted} to `{ vetoed, proposalOf, flagged }` (`flagged` null
 * when RedStone could not be read); `factsError` says why they could not be
 * read at all, which proposes nothing and changes nothing else. Every action
 * is independent of the others: a withdrawal's freed share is used by the
 * NEXT run, so a failed send never leaves a later one built on a state that
 * did not happen.
 *
 * THE RULE for moving a proposal toward a delisting — requesting its
 * clearance, relaying RedStone's answer, executing it — whoever proposed it:
 * the step is taken only on a conclusive (`ready`) reading of OFAC's files
 * made in this chain state, and only when that reading supports delisting
 * EVERY address the proposal names. The contract checks a proposal's
 * publication hash and date, the outstanding count, vetoes and RedStone; it
 * never checks the addresses against OFAC's files, so this is the one place
 * that does. Anything short of a conclusive reading — a failed or stale
 * download, files that disagree, a newer publication the list has not
 * recorded, a list mid-update — and the step waits.
 */
export function planChain(snap, key, evaluation, facts = new Map(), { factsError = null } = {}) {
  const actions = [];
  const notes = [];
  const review = [];
  const route = ROUTE[snap.route] ?? `route ${snap.route}`;
  const who = clearanceOracleName(snap);
  const gate = publicationGate(snap);
  if (!gate) notes.push(`the list is at version ${snap.list.latestVersion} but the finalized block shows ${snap.list.version}; proposing, reconfirming, requesting, relaying and executing wait for it to be final`);
  const ready = evaluation.status === 'ready';
  const absent = new Set(ready ? evaluation.absent.map(lower) : []);
  const date = snap.list.publicationDate;
  /** Why this reading cannot move proposals on, or null when it can. */
  const waitReason = !gate ? 'the list is mid-update' : ready ? null : evaluation.reason;
  let waitedOnReading = false;

  for (const p of snap.proposals) {
    const mine = sameAddress(p.proposer, key);
    const tag = `proposal ${p.id}`;
    const at = stage(snap, p);
    if (at === 'unappointed') {
      actions.push({ kind: 'discard', id: p.id, why: `its proposer ${p.proposer} was removed` });
      continue;
    }
    if (at === 'unlisted') {
      const gone = `${p.unlisted.join(', ')} ${p.unlisted.length === 1 ? 'is' : 'are'} no longer listed (delisted another way)`;
      if (mine) actions.push({ kind: 'withdraw', id: p.id, why: gone });
      else {
        notes.push(`${tag} (another proposer's) cannot execute: ${gone}`);
        review.push(`${tag} (another proposer's) cannot execute because ${gone}; it holds back ${p.accounts.length} of the outstanding delistings until its proposer withdraws it or the owner removes that proposer.`);
      }
      continue;
    }
    // Every address the reading supports delisting, or those it does not.
    const unsupported = ready ? p.accounts.filter((a) => !absent.has(lower(a))) : [];
    if (at === 'stale') {
      if (!mine) notes.push(`${tag} (another proposer's) names an older publication; only its proposer may reconfirm it`);
      else if (waitReason) {
        notes.push(`${tag} names an older publication; reconfirming waits: ${waitReason}`);
        waitedOnReading ||= gate;
      } else if (unsupported.length === 0) actions.push({ kind: 'reconfirm', id: p.id, sourceHash: snap.list.sourceHash, publicationDate: date });
      else {
        actions.push({ kind: 'withdraw', id: p.id, why: `OFAC's publication ${date} no longer supports delisting ${unsupported.join(', ')}` });
        review.push(`${tag} was withdrawn: publication ${date} no longer supports delisting ${unsupported.join(', ')}.`);
      }
      continue;
    }
    if (at === 'window') {
      notes.push(`${tag} (${p.accounts.length} address(es)) is in its window until ${isoAt(p.eta)}`);
      continue;
    }
    if (ADVANCING.has(at)) {
      const step = p.ready ? 'executing' : at === 'ClearanceNotAnswered:owed' ? `relaying the answer from ${who}` : 'requesting the clearance';
      if (waitReason) {
        notes.push(`${tag}: ${step} waits: ${waitReason}`);
        waitedOnReading ||= gate;
        continue;
      }
      if (unsupported.length) {
        const why = `publication ${date} does not support delisting ${unsupported.join(', ')} (OFAC still lists it, or SDN.XML still mentions it)`;
        if (mine) {
          actions.push({ kind: 'withdraw', id: p.id, why });
          review.push(`${tag} was withdrawn: ${why}.`);
        } else {
          notes.push(`${tag} (another proposer's) is not moved on: ${why}`);
          review.push(`${tag} (another proposer's) names ${unsupported.join(', ')}, which publication ${date} does not support delisting; this bot will not move it on, but anyone may — the Safe should veto it.`);
        }
        continue;
      }
      if (p.ready) actions.push({ kind: 'execute', id: p.id });
      else if (at === 'ClearanceNotAnswered:owed') {
        const r = p.relay;
        actions.push({ kind: 'reply', id: p.id, oracle: who, sourceChainId: r.sourceChainId, attestor: r.attestor, messageId: r.messageId, payload: r.payload });
        if (r.balance !== undefined && BigInt(r.balance) < LOW_BALANCE_WEI) {
          review.push(`the delister key holds ${formatEther(r.balance)} of native gas on chain ${r.sourceChainId}, where it pays the reply's CCIP fee — top it up.`);
        }
      } else actions.push({ kind: 'request', id: p.id, oracle: who });
      continue;
    }
    if (at.endsWith(':closed')) {
      notes.push(`${tag} is not moved on: the timelock is not a remover of the list, so it cannot complete any proposal`);
      continue;
    }
    if (at.endsWith(':no-relay')) {
      const why = `its clearance is not requested, because the answer from ${who} could not be relayed back: ${snap.relayPath?.detail ?? 'the way back was not checked'}`;
      notes.push(`${tag}: ${why}`);
      review.push(`${tag}: ${why}. A request costs a CCIP fee, so none is sent until the attestor's chain is reachable from here.`);
      continue;
    }
    switch (p.reason) {
      case 'ClearanceNotAnswered': {
        const r = p.relay ?? { status: 'unknown', detail: 'no relay reading' };
        if (r.status === 'in-flight') notes.push(`${tag}: its clearance request is on its way to the attestor`);
        else if (r.status === 'sent') notes.push(`${tag}: the answer from ${who} is on its way back`);
        else {
          notes.push(`${tag}: its clearance answer cannot be relayed: ${r.detail}`);
          review.push(`${tag}: the clearance answer cannot be relayed: ${r.detail}.`);
        }
        break;
      }
      case 'Vetoed':
      case 'ExceedsPendingDelistings':
      case 'ClearanceFlagged':
      case 'StillSanctioned': {
        const why = {
          Vetoed: 'the Safe vetoed an address in it',
          ExceedsPendingDelistings: 'the list now declares fewer delistings outstanding than it names',
          ClearanceFlagged: `${who} flags an address in it`,
          StillSanctioned: `${who} flags an address in it`,
        }[p.reason];
        if (mine) actions.push({ kind: 'withdraw', id: p.id, why });
        else notes.push(`${tag} (another proposer's) cannot execute: ${why}`);
        if (p.reason === 'ClearanceFlagged' || p.reason === 'StillSanctioned') review.push(`${tag}: ${why} (${p.accounts.join(', ')}); it is left for the Safe.`);
        break;
      }
      case 'OracleStale': {
        const why = staleWhy(snap, p, who);
        notes.push(`${tag} is matured but not executable: ${why}`);
        review.push(`${tag} is matured but not executable: ${why}.`);
        break;
      }
      case 'AdditionsOutstanding':
        // The adder applies a publication's additions on its next run.
        notes.push(`${tag} waits for the list's outstanding additions to be applied`);
        break;
      default:
        // A stale or unreadable RedStone, a route switched off, or a reason
        // this release does not know: nothing here can move it on.
        notes.push(`${tag} is matured but not executable: ${p.reason ?? 'unknown reason'}`);
        review.push(`${tag} is matured but not executable: ${p.reason ?? 'unknown reason'}.`);
    }
  }

  // New proposals.
  const free = freeDelistings(snap);
  if (!snap.timelockIsRemover) {
    notes.push('the timelock is not a remover of the list, so the automated route is closed; the owner appoints it with setRemover');
  } else if (snap.route === 0) {
    if (snap.list.pendingDelistings > 0) notes.push(`no clearance check is configured (clearance route Unavailable), so automated delisting is closed; ${snap.list.pendingDelistings} delisting(s) await the Safe`);
  } else if (gate && ready) {
    for (const a of evaluation.stillMentioned) review.push(`${a}: the advanced file delists it but SDN.XML still mentions it, so it is not proposed; it is left for the Safe.`);
    if (free > 0 && factsError) {
      notes.push(`nothing proposed: the candidates' veto state and their reading by ${who} could not be read: ${factsError}`);
      review.push(`no delisting was proposed: the candidates' veto state and their reading by ${who} could not be read (${factsError}).`);
    } else if (free > 0) {
      const candidates = [];
      for (const a of evaluation.absent) {
        const f = facts.get(lower(a));
        if (!f) continue;
        if (f.proposalOf && f.proposalOf !== 0n && f.proposalOf !== 0) continue;
        if (f.vetoed) notes.push(`${a} is vetoed by the Safe and is not proposed`);
        else if (f.flagged === null) notes.push(`${a}: ${who} could not be read, so it is not proposed this run`);
        else if (f.flagged) review.push(`${a}: OFAC delisted it but ${who} flags it, so it is not proposed; it is left for the Safe.`);
        else candidates.push(a);
      }
      const take = candidates.slice(0, free);
      for (let i = 0; i < take.length; i += MAX_BATCH) {
        actions.push({ kind: 'propose', accounts: take.slice(i, i + MAX_BATCH), sourceHash: snap.list.sourceHash, publicationDate: date });
      }
    }
  } else if (gate && !ready && evaluation.status !== 'not-loaded' && free > 0) {
    notes.push(`nothing proposed: ${evaluation.reason}`);
    waitedOnReading = true;
  }
  // A reading a person must fix, once per chain, when anything waited on it.
  if (waitedOnReading && evaluation.status === 'refused' && !evaluation.transient) review.push(`publication work refused: ${evaluation.reason}`);
  if (snap.balance !== undefined && BigInt(snap.balance) < LOW_BALANCE_WEI) {
    review.push(`the delister key holds ${formatEther(snap.balance)} of native gas here; it pays every transaction and the CCIP fees — top it up.`);
  }
  return { route, actions, notes, review };
}

function formatEther(wei) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

/** A one-line description of an action, for the report. */
export function describeAction(a) {
  switch (a.kind) {
    case 'propose':
      return `propose ${a.accounts.length} delisting(s) (${a.accounts.join(', ')}) under publication ${a.publicationDate}`;
    case 'reconfirm':
      return `reconfirm proposal ${a.id} onto publication ${a.publicationDate}`;
    case 'withdraw':
      return `withdraw proposal ${a.id}: ${a.why}`;
    case 'discard':
      return `discard proposal ${a.id}: ${a.why}`;
    case 'execute':
      return `execute proposal ${a.id}`;
    case 'request':
      return `request the clearance from ${a.oracle ?? 'the clearance oracle'} for proposal ${a.id}`;
    case 'reply':
      return `relay the answer from ${a.oracle ?? 'the clearance oracle'} for proposal ${a.id} from chain ${a.sourceChainId}`;
    default:
      return a.kind;
  }
}

/**
 * One run across every configured chain, with every effect injected:
 *   chains: `[{ slug, name, id, skipped?, effects }]`, `effects` being
 *     readSnapshot()                → the chain's snapshot (see chainEffects)
 *     readFacts(addresses, snap)    → Map(lowercase → { vetoed, proposalOf, flagged })
 *     send(action, { onSubmitted }) → { hash, blockNumber }
 *   and, for a skipped chain (no timelock) that records a list, only
 *     vetKey()                      → resolves once the key is shown to hold
 *                                     no role on that list, rejects otherwise
 *   key: the signing address;
 *   loadPublication(): the parsed OFAC files, called at most once and only
 *     when some chain needs them;
 *   cache: `{ [chainId]: { fingerprint, at, status, outcome } }` from the
 *     last runs;
 *   nowMs: the run's clock.
 * Returns `{ report, cache }`: the report, and the cache to keep. The cache
 * only ever saves a download: a chain is cached only after a CONCLUSIVE
 * reading of the files (nothing transient) in a run that sent nothing on that
 * chain, and a cached entry is used only while the chain's state is unchanged.
 */
export async function runDelister({ chains, key, loadPublication, cache = {}, nowMs = Date.now(), redactError = (m) => m }) {
  const read = await Promise.all(
    chains.map(async (c) => {
      try {
        // A chain with no timelock is still checked for the key's roles on
        // its list: the key may relay from it, and the bound on a stolen key
        // is what it holds on every chain, not where this service acts.
        if (c.skipped) {
          await c.effects?.vetKey?.();
          return { c };
        }
        return { c, snap: await c.effects.readSnapshot() };
      } catch (e) {
        return { c, error: redactError(String(e?.message ?? e)) };
      }
    }),
  );
  // Which chains need OFAC's files this run, decided once: the same answer
  // decides whether they are loaded and whether a failed load left that
  // chain's work undone.
  const wants = new Map(read.map((r) => [r.c.id, Boolean(r.snap && wantsPublication(r.snap, key, cache[r.c.id], nowMs))]));
  const needed = [...wants.values()].some(Boolean);
  let publication = null;
  let publicationReport = { loaded: false };
  if (needed) {
    try {
      publication = await loadPublication();
      publicationReport = { loaded: true, advanced: publication.advanced.source, plain: publication.plain.source };
    } catch (e) {
      const reason = redactError(String(e?.message ?? e));
      publication = { error: `the OFAC files could not be loaded: ${reason}` };
      publicationReport = { loaded: false, error: reason };
    }
  }
  // A configured chain with no timelock may still host another chain's
  // clearance attestor; say so rather than calling it idle, and say which
  // oracle that attestor reads, as each timelock chain's snapshot found it.
  const attestorFor = new Map();
  for (const { c, snap } of read) {
    if (snap?.route !== CROSS_CHAIN) continue;
    const id = Number(snap.clearanceSourceChainId);
    const hosted = attestorFor.get(id) ?? new Map();
    const key = String(snap.clearanceAttestor).toLowerCase();
    const entry = hosted.get(key) ?? { attestor: snap.clearanceAttestor, for: [], clearanceOracle: null };
    entry.for.push(c.name);
    const o = oracleReport(snap);
    // Keep the most that any reading established: an identified oracle over
    // one a failed read left unknown.
    if (!entry.clearanceOracle || (entry.clearanceOracle.identity === ORACLE_IDENTITY.UNKNOWN && o.identity !== ORACLE_IDENTITY.UNKNOWN)) entry.clearanceOracle = o;
    hosted.set(key, entry);
    attestorFor.set(id, hosted);
  }
  const nextCache = { ...cache };
  // One timelock chain's run, after its snapshot was read. `sent` is the
  // caller's, so whatever stops this, every send already made is reported.
  const runChain = async (c, snap, head, sent) => {
    const refused = refusal(snap);
    if (refused) return [c.slug, { ...head, status: 'refused', error: refused, actions: [] }];
    const cached = cache[c.id];
    const fresh = freshCache(snap, cached, nowMs);
    let evaluation = evaluatePublication(snap, publication);
    // Unchanged since a conclusive reading: that reading already did what
    // it allowed, and nothing it did not allow moves on without a new one.
    if (evaluation.status === 'not-loaded' && fresh) {
      evaluation = { ...evaluation, reason: `nothing changed since OFAC's files were last read at ${new Date(cached.at).toISOString()} (${cached.outcome})` };
    }
    let facts = new Map();
    let factsError = null;
    const wanted = factsWanted(snap, evaluation);
    if (wanted.length) {
      try {
        facts = await c.effects.readFacts(wanted, snap);
      } catch (e) {
        factsError = redactError(String(e?.message ?? e));
      }
    }
    const plan = planChain(snap, key, evaluation, facts, { factsError });
    for (const action of plan.actions) {
      const entry = { action: describeAction(action), kind: action.kind, id: action.id?.toString(), tx: null, state: 'submitting' };
      sent.push(entry);
      try {
        const included = await c.effects.send(action, {
          onSubmitted: (hash) => {
            entry.tx = hash;
            entry.state = 'submitted';
          },
        });
        Object.assign(entry, { tx: included.hash, blockNumber: included.blockNumber?.toString(), state: 'included' });
      } catch (e) {
        Object.assign(entry, { state: sendState(entry, e), error: redactError(String(e?.message ?? e)) });
      }
    }
    // Remember the chain's state only when this run read OFAC's files
    // conclusively (nothing transient, the candidates' state read) AND left
    // the chain as it found it. Any send changes the state or may have: a
    // landed one moves the fingerprint, but inclusion is not finality, and
    // one reorganised out would return the chain to exactly the state
    // cached here, so it would not be retried until the cache expired. So
    // a run that sent anything is never cached; the next run reads again.
    if (evaluation.status !== 'not-loaded' && !evaluation.transient && !factsError && sent.length === 0) {
      nextCache[c.id] = {
        fingerprint: fingerprint(snap),
        at: nowMs,
        status: evaluation.status,
        outcome: evaluation.status === 'ready' ? `checked publication ${snap.list.publicationDate}` : evaluation.reason,
      };
    }
    const notes = [...plan.notes];
    if (evaluation.status === 'not-loaded' && fresh) {
      notes.push(`last checked against OFAC's files at ${new Date(cached.at).toISOString()} (${cached.outcome}); unchanged since`);
    }
    const failed = sent.filter((e) => e.state !== 'included');
    // Work this chain needed that a failure put off, as opposed to work
    // that waits by design (a window, RedStone's answer, the adder
    // recording a newer publication: `mismatch`). Either kind is retried
    // next run; only this kind makes the run a failure, so the unit's own
    // status shows it. A chain that needed OFAC's files and got no
    // conclusive reading of them (`refused`: a failed download, files that
    // disagree, a stale copy, counts that differ) is this kind.
    const deferred = [];
    if (wants.get(c.id) && evaluation.status === 'refused') deferred.push(`this chain needed OFAC's files and has no conclusive reading of them: ${evaluation.reason}`);
    if (factsError) deferred.push(`the candidates' veto state and their reading by ${clearanceOracleName(snap)} could not be read: ${factsError}`);
    return [
      c.slug,
      {
        ...head,
        status: failed.length || deferred.length ? 'partial' : 'ok',
        route: plan.route,
        clearanceOracle: oracleReport(snap),
        list: listReport(head, snap),
        reservedDelistings: snap.reservedDelistings,
        publication: evaluation.status,
        actions: sent,
        deferred,
        notes,
        review: plan.review,
      },
    ];
  };
  const results = await Promise.all(
    read.map(async ({ c, snap, error }) => {
      const head = { name: c.name, chainId: c.id, timelock: c.timelock ?? null, list: c.list ?? null };
      if (c.skipped) {
        const attestors = [...(attestorFor.get(c.id)?.values() ?? [])];
        const names = attestors.flatMap((a) => a.for);
        if (error) {
          const relays = names.length ? `; it hosts the clearance attestor for ${names.join(', ')}, and no answer is relayed from here until this is fixed` : '';
          return [c.slug, { ...head, status: 'refused', error: `${error}${relays}`, actions: [], ...(attestors.length && { attestors }) }];
        }
        const reason = names.length ? `no timelock is recorded here; it hosts the clearance attestor for ${names.join(', ')}, whose answers are relayed from here` : c.skipped;
        return [c.slug, { ...head, status: 'skipped', reason, ...(attestors.length && { attestors }) }];
      }
      if (error) return [c.slug, { ...head, status: 'refused', error, actions: [] }];
      // Everything a chain's run sent is reported, whatever stops it: an
      // unexpected error becomes this chain's own report, with its sends so
      // far, never a rejection of the whole run that would lose them.
      const sent = [];
      try {
        return await runChain(c, snap, head, sent);
      } catch (e) {
        const reason = redactError(String(e?.message ?? e));
        return [
          c.slug,
          {
            ...head,
            status: 'partial',
            // Read defensively: this report must not throw in its turn.
            route: ROUTE[snap?.route] ?? `route ${snap?.route}`,
            clearanceOracle: oracleReport(snap),
            list: listReport(head, snap),
            reservedDelistings: snap?.reservedDelistings,
            actions: sent,
            deferred: [`this chain's run stopped on an unexpected error${sent.length ? ' after the sends listed' : ', before sending anything'}: ${reason}`],
            notes: [],
            review: [],
          },
        ];
      }
    }),
  );
  const byChain = Object.fromEntries(results);
  const statuses = Object.values(byChain).map((r) => r.status);
  // With no timelock anywhere there is nothing this service can do, which
  // is a deployment to finish, not a quiet run: the unit fails and says so.
  const idle = chains.every((c) => c.skipped);
  return {
    report: {
      status: idle ? 'refused' : statuses.some((s) => s === 'refused' || s === 'partial') ? 'failed' : 'ok',
      ...(idle && { error: 'no configured chain has a SanctionsDelistingTimelock recorded in this release' }),
      publication: publicationReport,
      chains: byChain,
    },
    cache: nextCache,
  };
}

/** A chain report's view of the oracle its clearance is read from, or null
 *  when the route reads none (Unavailable). */
function oracleReport(snap) {
  if (!snap || snap.route === 0) return null;
  const o = snap.clearanceOracle ?? {};
  return {
    address: o.address ?? null,
    identity: o.identity ?? ORACLE_IDENTITY.UNKNOWN,
    name: clearanceOracleName(snap),
    // A number while exact (every time the source rule accepts is), else the
    // digits as text, so the report never states a rounded value.
    updatedAt: o.updatedAt === null || o.updatedAt === undefined ? null : Number.isSafeInteger(Number(o.updatedAt)) ? Number(o.updatedAt) : String(o.updatedAt),
    // The stand-in's owner and pending owner as read this run (null when
    // unreadable); absent for an oracle that is not the stand-in.
    ...(o.identity === ORACLE_IDENTITY.STAND_IN && { owner: o.owner ?? null, pendingOwner: o.pendingOwner ?? null }),
    ...(o.detail && { detail: o.detail }),
  };
}

/** The line a person reads about the oracle a clearance is read from: what
 *  it is, when it last updated, and — for the stand-in — what it is not. */
function oracleLine(o) {
  const at = o.address ? ` at ${o.address}` : '';
  const when = o.updatedAt ? isoAt(o.updatedAt) : 'unknown';
  if (o.identity === ORACLE_IDENTITY.STAND_IN) {
    const c = standInControl(o);
    return `clearance read from ${o.name}${at}: NOT RedStone — ${c.flags}; last published ${when}, and ${c.stale}.`;
  }
  return `clearance oracle not identified this run${at}${o.detail ? ` (${o.detail})` : ''}${o.updatedAt ? `; it reports a last update of ${when}` : ''}.`;
}

/** A chain report's view of its list. */
function listReport(head, snap) {
  const l = snap?.list;
  return { ...(head.list && { address: head.list }), publicationDate: l?.publicationDate, pendingAdditions: l?.pendingAdditions, pendingDelistings: l?.pendingDelistings };
}

/** A failed send's report state, from what the send is known to have done
 *  (sanctions-service SEND_OUTCOMES): nothing signed, refused by the node,
 *  included and reverted, or — knowing none of those — unknown. */
function sendState(entry, e) {
  if (!entry.tx) return 'failed';
  if (e?.sendOutcome === 'refused') return 'rejected';
  if (e?.sendOutcome === 'reverted') return 'reverted';
  return 'unknown';
}

/** The lines a person reads for one chain. */
export function summarizeChain(c) {
  const hosted = (c.attestors ?? []).map((a) => `attestor ${a.attestor} (for ${a.for.join(', ')}): ${oracleLine(a.clearanceOracle)}`);
  if (c.status === 'skipped') return [`skipped: ${c.reason}`, ...hosted].join('\n  ');
  if (c.status === 'refused') return [`REFUSED, nothing sent: ${c.error}`, ...hosted].join('\n  ');
  const lines = [`route ${c.route}; ${c.list?.pendingDelistings ?? 0} delisting(s) outstanding, ${c.reservedDelistings ?? 0} proposed.`];
  if (c.clearanceOracle) lines.push(oracleLine(c.clearanceOracle));
  const word = {
    included: 'included',
    failed: 'FAILED, not sent',
    rejected: 'signed, but the node refused it; not broadcast',
    reverted: 'included, but REVERTED; it changed nothing',
    unknown: 'signed and broadcast attempted, outcome unknown — check it',
    submitted: 'signed and broadcast attempted, no receipt seen',
  };
  for (const e of c.actions ?? []) lines.push(`${e.action}: ${e.tx ? `${e.tx} — ` : ''}${word[e.state] ?? e.state}${e.error ? ` (${e.error})` : ''}`);
  for (const d of c.deferred ?? []) lines.push(`NOT DONE, retried next run: ${d}`);
  for (const n of c.notes ?? []) lines.push(n);
  for (const r of c.review ?? []) lines.push(`NEEDS A PERSON: ${r}`);
  return lines.join('\n  ');
}

/** The summary a person reads, in the journal and the chat. */
export function summarize(report) {
  const lines = [];
  if (report.error) lines.push(`REFUSED, nothing sent: ${report.error}.`);
  const p = report.publication;
  if (p?.loaded) lines.push(`OFAC ${p.advanced.publicationId}: advanced ${p.advanced.sha256.slice(0, 18)}…, plain ${p.plain.sha256.slice(0, 18)}…`);
  else if (p?.error) lines.push(`OFAC files could not be loaded: ${p.error}`);
  for (const [slug, c] of Object.entries(report.chains)) lines.push(`${c.name ?? slug}: ${summarizeChain(c)}`);
  for (const u of report.stateNotSaved ?? []) lines.push(`STATE NOT SAVED: ${u.file}: ${u.error} (the next run repeats work; no decision depends on it)`);
  return lines.join('\n');
}

/**
 * Whether a run's outcome calls for the ops chat, and the digest that
 * identifies it: anything sent or failed, a refusal, or an item for a person.
 * The digest leaves out what changes every run without changing the
 * situation, so a standing condition is alerted when it starts and then once
 * every {@link ALERT_REPEAT_MS}.
 */
export function alertDigest(report) {
  const parts = [];
  if (report.error) parts.push(`run refused: ${report.error}`);
  if (report.publication?.error) parts.push(`publication: ${report.publication.error}`);
  for (const [slug, c] of Object.entries(report.chains)) {
    if (c.status === 'refused') parts.push(`${slug} refused: ${c.error}`);
    for (const e of c.actions ?? []) parts.push(`${slug} ${e.action} ${e.state} ${e.tx ?? ''}`);
    for (const d of c.deferred ?? []) parts.push(`${slug} not done: ${d}`);
    for (const r of c.review ?? []) parts.push(`${slug} review: ${r}`);
  }
  for (const u of report.stateNotSaved ?? []) parts.push(`state not saved: ${u.file}`);
  if (parts.length === 0) return null;
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function shouldAlert(digest, last, nowMs) {
  if (!digest) return false;
  return !last || last.digest !== digest || nowMs - last.at >= ALERT_REPEAT_MS;
}

// ── Configuration and effects ─────────────────────────────────────────

/** Read and check the configuration; throws naming every missing setting. */
export function readConfig(env) {
  const missing = [];
  if (!env.SANCTIONS_DELISTER_PRIVATE_KEY) missing.push('SANCTIONS_DELISTER_PRIVATE_KEY');
  const chains = configuredChains(env);
  if (chains.length === 0) missing.push(`an RPC for at least one chain (${SERVICE_CHAINS.map((c) => c.rpcEnv).join(', ')})`);
  const stateDir = env.SANCTIONS_DELISTER_STATE_DIR || env.STATE_DIRECTORY;
  if (!stateDir) missing.push('SANCTIONS_DELISTER_STATE_DIR (or systemd StateDirectory=)');
  if (missing.length) throw new Error(`not configured: ${missing.join(', ')}`);
  const privateKey = readPrivateKey('SANCTIONS_DELISTER_PRIVATE_KEY', env.SANCTIONS_DELISTER_PRIVATE_KEY);
  return {
    chains,
    ignoredMainnetRpcs: MAINNET_RPC_ENVS.filter((k) => env[k]),
    privateKey,
    stateDir: stateDir.split(':')[0],
    tgToken: env.TG_OPS_BOT_TOKEN || '',
    tgChatId: env.TG_OPS_CHAT_ID || '',
  };
}

/**
 * Each configured chain with the timelock and list this release records for
 * it, or the reason it is skipped. A skipped chain keeps its list, so the
 * key's roles on it are still checked. Addresses come only from
 * deployments.json.
 */
export function planChains(chains, deployments) {
  return chains.map((c) => {
    const d = deployments[String(c.id)] ?? {};
    const list = d.sanctionsList ? { list: getAddress(d.sanctionsList) } : {};
    if (!d.sanctionsDelistingTimelock || !d.sanctionsList) {
      return { ...c, ...list, skipped: `no ${d.sanctionsList ? 'SanctionsDelistingTimelock' : 'SanctionsList'} is recorded for chain ${c.id} in this release's deployments.json — deploy it, export deployments, merge, and install that commit` };
    }
    return { ...c, ...list, timelock: getAddress(d.sanctionsDelistingTimelock) };
  });
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A JSON object from the state directory, or `{}` when it is missing,
 *  unreadable or not an object — every one of them is a cache, never a
 *  source of truth, so a damaged file costs work and never stops a run. */
export function readState(stateDir, name) {
  try {
    const v = JSON.parse(readFileSync(join(stateDir, name), 'utf8'));
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/** The relay cache, each half an object whatever the file held. */
export function readRelayCache(stateDir) {
  const r = readState(stateDir, 'relay.json');
  return { messageIds: isRecord(r.messageIds) ? r.messageIds : {}, payloads: isRecord(r.payloads) ? r.payloads : {} };
}

/** The first block number whose timestamp is >= `ts`, searching [lo, hi]. */
async function firstBlockAtOrAfter(client, ts, lo, hi) {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (b.timestamp < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** `getLogs` over [from, to] in chunks, halving the chunk when the provider
 *  refuses a range (public RPCs allow as few as 200 blocks, some plans 10);
 *  stops at the first chunk with a match. */
async function findLogs(client, params, from, to) {
  let chunk = 10_000n;
  for (let start = from; start <= to; ) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    let logs;
    try {
      logs = await client.getLogs({ ...params, fromBlock: start, toBlock: end });
    } catch (e) {
      if (chunk > 1n) {
        chunk /= 2n;
        continue;
      }
      throw e;
    }
    if (logs.length) return logs;
    start = end + 1n;
  }
  return [];
}

/**
 * `clientFor(chainId)`: the clients of a configured chain, or null when no
 * RPC is configured for it. THE one way to reach a chain — the timelock's
 * own and an attestor's alike, for reads as well as sends — so what it checks
 * holds for every use. Checked once per run, before the clients are handed
 * out: the RPC serves that chain, and `vet(chainId, clients)` finds nothing
 * wrong (it returns a refusal message, or null; see {@link listRoleKeyVet}).
 * A failed check is remembered for the run, so every later use of that chain
 * fails with the same reason.
 */
export function createClientLookup(clientsByChain, vet = async () => null) {
  const checked = new Map();
  return (chainId) => {
    const id = Number(chainId);
    if (!checked.has(id)) {
      checked.set(
        id,
        (async () => {
          const cc = clientsByChain.get(id);
          if (!cc) return null;
          const served = await cc.client.getChainId();
          if (served !== id) throw new Error(`the RPC configured for chain ${id} serves chain ${served}`);
          const why = await vet(id, cc);
          if (why) throw new Error(why);
          return cc;
        })(),
      );
    }
    return checked.get(id);
  };
}

/**
 * The lookup's vet for this service: on a chain whose list this release
 * records, the key's adder, remover and owner roles there, judged by
 * {@link listRoleRefusal}. A list that cannot be read refuses too — the key
 * is not used on a chain where its roles are unknown.
 */
export function listRoleKeyVet({ listByChain, key, abi }) {
  return async (chainId, { client }) => {
    const at = listByChain.get(Number(chainId));
    if (!at) return null;
    try {
      const read = (functionName, args = []) => client.readContract({ address: at, abi, functionName, args });
      const [adder, remover, owner] = await Promise.all([read('isAdder', [key]), read('isRemover', [key]), read('owner')]);
      return listRoleRefusal({ adder, remover, owner: sameAddress(owner, key) });
    } catch (e) {
      return `the key's roles on list ${at} could not be read, so the key is not used on this chain: ${e?.shortMessage ?? e?.message ?? e}`;
    }
  };
}

/**
 * What `address`, the oracle a clearance is read from, is and when it last
 * updated, asked on the chain it lives on (`client`). `identity` is
 * `stand-in` only when the contract answers `isTestnetStandIn()` with true,
 * and `unknown` otherwise, with `detail` stating what happened — an answer of
 * false, or a call that returned no answer (a revert, an RPC failure, no
 * contract there) — and inferring nothing from it.
 *
 * Nothing is ever identified as RedStone. Its oracle carries no marker of its
 * own, so naming it would mean inferring it from a call that did not answer,
 * and an RPC failure can look like a revert — which would call the stand-in
 * RedStone. This release runs on test networks only (`SERVICE_CHAINS`), where
 * RedStone has no deployment, so no oracle it reads is RedStone; a mainnet
 * release (#2443) must establish RedStone positively, from the address it is
 * recorded under, rather than revive an inference.
 *
 * `updatedAt` is its `getLastUpdateBlockTimestamp()` now, judged by the
 * contracts' own rule (`LibOracleFreshness.lastUpdate`): null — unknown —
 * when it is unreadable, zero, or later than its chain's latest block, and
 * null too when that block cannot be read to judge it.
 *
 * For the stand-in, `owner` and `pendingOwner` are read now too (null when
 * unreadable): whoever holds them controls its flags and its freshness, and
 * a report names them rather than assuming the chain's admin still does
 * ({@link standInControl}).
 */
export async function identifyOracle(client, address, abi) {
  const at = getAddress(address);
  const read = (functionName) => client.readContract({ address: at, abi, functionName }).then((value) => ({ value }), (error) => ({ error }));
  const [marker, freshness, block, owner, pendingOwner] = await Promise.all([
    read('isTestnetStandIn'),
    read('getLastUpdateBlockTimestamp'),
    client.getBlock().then((b) => b, () => null),
    read('owner'),
    read('pendingOwner'),
  ]);
  const ts = freshness.error || freshness.value === undefined || freshness.value === null ? 0n : BigInt(freshness.value);
  const updatedAt = ts === 0n || !block || ts > BigInt(block.timestamp) ? null : ts;
  const addressOrNull = (r) => {
    try {
      return 'error' in r ? null : getAddress(r.value);
    } catch {
      return null;
    }
  };
  if (marker.value === true) {
    return { address: at, identity: ORACLE_IDENTITY.STAND_IN, updatedAt, owner: addressOrNull(owner), pendingOwner: addressOrNull(pendingOwner) };
  }
  const detail =
    'error' in marker
      ? `asking ${at} whether it is the testnet stand-in returned no answer: ${marker.error?.shortMessage ?? marker.error?.message ?? marker.error}`
      : `${at} answers isTestnetStandIn() with ${marker.value}, so it is not the stand-in; nothing this run read says what it is`;
  return { address: at, identity: ORACLE_IDENTITY.UNKNOWN, updatedAt, detail };
}

/** `fn` over `items`, at most `n` at a time, results in order. */
async function mapLimited(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}
/** Concurrent reads per chain: enough to be quick, few enough for a
 *  free-tier RPC's rate limit. */
const READ_CONCURRENCY = 8;

/**
 * The real effects of one timelock chain. `clientFor` reaches every
 * configured chain (see {@link createClientLookup}), so a cross-chain route
 * can read and send on its attestor's chain; `queues` serialises every send
 * per chain; `relayCache` remembers request message ids and owed replies
 * between runs, keyed by the timelock so a new deploy never reads an old
 * one's entries.
 */
function chainEffects({ c, account, clientFor, queues, relayCache, abis }) {
  const { tl, list, att, standIn: standInDef, errors } = abis;
  const own = async () => (await clientFor(c.id)) ?? Promise.reject(new Error(`no RPC is configured for chain ${c.id}`));
  const requestKey = (requestId) => `${c.id}:${lower(c.timelock)}:${requestId}`;

  async function requestMessageId(client, id, requestId, requestedAt) {
    const k = requestKey(requestId);
    if (relayCache.messageIds[k]) return relayCache.messageIds[k];
    const latest = await client.getBlockNumber();
    const from = await firstBlockAtOrAfter(client, BigInt(requestedAt), 0n, latest);
    const to = await firstBlockAtOrAfter(client, BigInt(requestedAt) + 1n, from, from + 20_000n > latest ? latest : from + 20_000n);
    const event = tl.find((e) => e.type === 'event' && e.name === 'ClearanceRequested');
    const logs = await client.getLogs({ address: c.timelock, event, args: { id: BigInt(id), requestId: BigInt(requestId) }, fromBlock: from, toBlock: to > from ? to : from, strict: true });
    if (!logs.length) return null;
    relayCache.messageIds[k] = logs[0].args.messageId;
    return logs[0].args.messageId;
  }

  /** Whether the clearance answer could come back from here: the attestor's
   *  chain has an RPC that serves that chain, and the attestor answers on
   *  it. Read once per run on a cross-chain route; a clearance request (a
   *  paid CCIP message) is sent only when it holds. Also identifies the
   *  oracle the attestor reads (`oracle`, see {@link identifyOracle}). */
  async function relayPath(sourceChainId, attestor) {
    try {
      const src = await clientFor(sourceChainId);
      if (!src) return { ok: false, detail: `no RPC is configured for chain ${sourceChainId}, where its attestor runs` };
      const oracle = await src.client.readContract({ address: attestor, abi: att, functionName: 'oracle' });
      return { ok: true, oracle: await identifyOracle(src.client, oracle, standInDef) };
    } catch (e) {
      // An unreadable attestor, an RPC serving another chain, or a key that
      // holds a role on that chain's list (createClientLookup) all land here.
      return { ok: false, detail: `chain ${sourceChainId}, where its attestor runs, cannot be used from here: ${e?.shortMessage ?? e?.message ?? e}` };
    }
  }

  async function relayState(client, p, sourceChainId, attestor) {
    const src = await clientFor(sourceChainId);
    if (!src) return { status: 'unknown', detail: `no RPC is configured for chain ${sourceChainId}, where its attestor runs` };
    const messageId = await requestMessageId(client, p.id, p.clearance.requestId, p.clearance.requestedAt);
    if (!messageId) return { status: 'unknown', detail: `the ClearanceRequested event for request ${p.clearance.requestId} was not found` };
    const [, payloadHash, , sent] = await src.client.readContract({ address: attestor, abi: att, functionName: 'replyOf', args: [messageId] });
    if (/^0x0+$/.test(payloadHash)) return { status: 'in-flight', messageId };
    if (sent) return { status: 'sent', messageId };
    let payload = relayCache.payloads[messageId];
    if (!payload || keccak256(payload) !== payloadHash) {
      const latest = await src.client.getBlockNumber();
      const floor = BigInt(p.clearance.requestedAt) - CLOCK_SKEW_S;
      const from = await firstBlockAtOrAfter(src.client, floor > 0n ? floor : 0n, 0n, latest);
      const event = att.find((e) => e.type === 'event' && e.name === 'ClearanceRead');
      const logs = await findLogs(src.client, { address: attestor, event, args: { requestMessageId: messageId }, strict: true }, from, latest);
      payload = logs[0]?.args.payload;
      if (!payload || keccak256(payload) !== payloadHash) return { status: 'unknown', detail: `the attestor owes a reply for ${messageId} but its ClearanceRead event was not found or does not match` };
      relayCache.payloads[messageId] = payload;
    }
    const balance = await src.client.getBalance({ address: account.address });
    return { status: 'owed', messageId, payload, sourceChainId: Number(sourceChainId), attestor, balance };
  }

  return {
    async readSnapshot() {
      const { client } = await own();
      const readTl = (functionName, args = []) => client.readContract({ address: c.timelock, abi: tl, functionName, args });
      const current = await readCurrentFromChain(client, c.list, list, BigInt(c.id));
      const [latestVersion, block, tlList, owner, isProposer, route, reserved, count, sourceChainId, attestor, oracleMaxAge, tlIsRemover, balance] = await Promise.all([
        client.readContract({ address: c.list, abi: list, functionName: 'listVersion' }),
        client.getBlock(),
        readTl('list'),
        readTl('owner'),
        readTl('isProposer', [account.address]),
        readTl('clearanceRoute'),
        readTl('reservedDelistings'),
        readTl('proposalCount'),
        readTl('clearanceSourceChainId'),
        readTl('clearanceAttestor'),
        readTl('oracleMaxAge'),
        client.readContract({ address: c.list, abi: list, functionName: 'isRemover', args: [c.timelock] }),
        client.getBalance({ address: account.address }),
      ]);
      const crossChain = Number(route) === CROSS_CHAIN ? await relayPath(sourceChainId, attestor) : null;
      // The oracle the clearance is read from, read once: the report names
      // it, and readFacts asks the same address.
      let clearanceOracle = null;
      if (crossChain) clearanceOracle = crossChain.oracle ?? { address: null, identity: ORACLE_IDENTITY.UNKNOWN, updatedAt: null, detail: crossChain.detail };
      else if (Number(route) === LOCAL) {
        try {
          const secondary = await client.readContract({ address: c.list, abi: list, functionName: 'secondary' });
          clearanceOracle = await identifyOracle(client, secondary, standInDef);
        } catch (e) {
          clearanceOracle = { address: null, identity: ORACLE_IDENTITY.UNKNOWN, updatedAt: null, detail: `the list's secondary oracle could not be read: ${e?.shortMessage ?? e?.message ?? e}` };
        }
      }
      // The timelock keeps no index of pending proposals, so every one ever
      // made is read; delistings are rare, so the count stays small.
      const proposals = [];
      for (let id = 1n; id <= count; id++) {
        const p = await readTl('getProposal', [id]);
        if (Number(p.status) !== STATUS_PENDING) continue;
        const [proposerAppointed, [ready, reasonSel], cl, listed] = await Promise.all([
          readTl('isProposer', [p.proposer]),
          readTl('readiness', [id]),
          readTl('clearanceOf', [id]),
          mapLimited(p.accounts, READ_CONCURRENCY, (a) => client.readContract({ address: c.list, abi: list, functionName: 'listedByOwnList', args: [a] })),
        ]);
        const [requestId, requestedAt, oracleUpdatedAt, epoch, state] = cl;
        const entry = {
          id,
          proposer: getAddress(p.proposer),
          proposerAppointed,
          sourceHash: p.sourceHash,
          publicationDate: Number(p.publicationDate),
          eta: p.eta,
          accounts: p.accounts.map((a) => getAddress(a)),
          unlisted: p.accounts.filter((_, i) => !listed[i]).map((a) => getAddress(a)),
          ready,
          reason: ready ? null : (errors.get(reasonSel) ?? reasonSel),
          clearance: { requestId, requestedAt, oracleUpdatedAt, epoch, state: Number(state) },
        };
        if (entry.reason === 'ClearanceNotAnswered') {
          try {
            entry.relay = await relayState(client, entry, sourceChainId, attestor);
          } catch (e) {
            entry.relay = { status: 'unknown', detail: `reading the attestor failed: ${e?.shortMessage ?? e?.message ?? e}` };
          }
        }
        proposals.push(entry);
      }
      return {
        chainId: c.id,
        timelock: c.timelock,
        timelockList: getAddress(tlList),
        timelockIsRemover: tlIsRemover,
        // The key's roles on the list were checked before this chain's
        // clients were handed out (createClientLookup).
        roles: { proposer: isProposer, timelockOwner: sameAddress(owner, account.address) },
        route: Number(route),
        clearanceSourceChainId: sourceChainId,
        clearanceAttestor: attestor,
        relayPath: crossChain,
        clearanceOracle,
        oracleMaxAge: Number(oracleMaxAge),
        reservedDelistings: Number(reserved),
        proposalCount: Number(count),
        now: block.timestamp,
        balance,
        list: {
          address: c.list,
          version: current.version,
          latestVersion,
          sourceHash: current.recordedHash,
          publicationDate: current.recordedDate,
          pendingAdditions: current.recordedPendingAdditions,
          pendingDelistings: current.recordedPendingDelistings,
          addresses: current.addresses,
        },
        proposals,
      };
    },

    /** Each candidate's veto and proposal on this timelock, and whether the
     *  clearance oracle flags it — the oracle the snapshot identified and
     *  the report names, so the name and the reading are one address.
     *  Throws when the timelock cannot be read, or the list's own secondary
     *  could not be on a local route: no proposal is built on a partial
     *  reading. */
    async readFacts(addresses, snap) {
      const { client } = await own();
      const readTl = (functionName, args = []) => client.readContract({ address: c.timelock, abi: tl, functionName, args });
      const known = snap.clearanceOracle?.address ?? null;
      let oracleClient = null;
      if (snap.route === LOCAL) {
        if (!known) throw new Error(snap.clearanceOracle?.detail ?? "the list's secondary oracle was not read");
        oracleClient = client;
      } else if (snap.route === CROSS_CHAIN && known) {
        try {
          oracleClient = (await clientFor(snap.clearanceSourceChainId))?.client ?? null;
        } catch {
          // The attestor's chain unusable: every candidate is skipped this run.
        }
      }
      const oracle = oracleClient ? known : null;
      const rows = await mapLimited(addresses, READ_CONCURRENCY, async (a) => {
        const [vetoed, proposalOf] = await Promise.all([readTl('vetoed', [a]), readTl('proposalOf', [a])]);
        let flagged = null;
        if (oracle) {
          try {
            flagged = await oracleClient.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'isSanctioned', args: [a] });
          } catch {
            flagged = null;
          }
        }
        return [lower(a), { vetoed, proposalOf, flagged }];
      });
      return new Map(rows);
    },

    async send(action, { onSubmitted }) {
      const label = describeAction(action);
      if (action.kind === 'reply') {
        const src = await clientFor(action.sourceChainId);
        if (!src) throw new Error(`no RPC is configured for chain ${action.sourceChainId}`);
        const fee = await src.client.readContract({ address: action.attestor, abi: att, functionName: 'quoteReply', args: [action.messageId, action.payload] });
        const data = encodeFunctionData({ abi: att, functionName: 'sendReply', args: [action.messageId, action.payload] });
        const value = fee + (fee * FEE_MARGIN_BPS) / 10_000n;
        return queues.run(action.sourceChainId, () => sendTransaction({ client: src.client, wallet: src.wallet, account, to: action.attestor, data, value, onSubmitted, label }));
      }
      const { client, wallet } = await own();
      let data;
      let value = 0n;
      switch (action.kind) {
        case 'propose':
          data = encodeFunctionData({ abi: tl, functionName: 'propose', args: [action.accounts, action.sourceHash, action.publicationDate] });
          break;
        case 'reconfirm':
          data = encodeFunctionData({ abi: tl, functionName: 'reconfirm', args: [action.id, action.sourceHash, action.publicationDate] });
          break;
        case 'withdraw':
          data = encodeFunctionData({ abi: tl, functionName: 'cancel', args: [action.id] });
          break;
        case 'discard':
          data = encodeFunctionData({ abi: tl, functionName: 'discard', args: [action.id] });
          break;
        case 'execute':
          data = encodeFunctionData({ abi: tl, functionName: 'execute', args: [action.id] });
          break;
        case 'request': {
          const fee = await client.readContract({ address: c.timelock, abi: tl, functionName: 'quoteClearanceRequest', args: [action.id] });
          value = fee + (fee * FEE_MARGIN_BPS) / 10_000n;
          data = encodeFunctionData({ abi: tl, functionName: 'requestClearance', args: [action.id] });
          break;
        }
        default:
          throw new Error(`unknown action ${action.kind}`);
      }
      const included = await queues.run(c.id, () => sendTransaction({ client, wallet, account, to: c.timelock, data, value, onSubmitted, label }));
      if (action.kind === 'request') {
        // Remember the request's message id from the receipt the send already
        // returned, so the relay need not search for it — no second read
        // that could fail after the request is known to be included.
        for (const log of included.logs ?? []) {
          if (!sameAddress(log.address, c.timelock)) continue;
          try {
            const ev = decodeEventLog({ abi: tl, data: log.data, topics: log.topics });
            if (ev.eventName === 'ClearanceRequested') relayCache.messageIds[requestKey(ev.args.requestId)] = ev.args.messageId;
          } catch {}
        }
      }
      console.log(`${c.name}: ${label}: included in ${included.hash} (block ${included.blockNumber})`);
      return included;
    },
  };
}

/**
 * `--check`: prove an installed release can run, without configuration or
 * network — its modules load, the compiled ABIs are present, and both
 * parsers read their committed fixtures. install.sh runs it before switching
 * `current` to a new release.
 */
async function check() {
  for (const [name, abi, fn] of [['SanctionsDelistingTimelock', timelockAbi(), 'propose'], ['SanctionsClearanceAttestor', attestorAbi(), 'sendReply'], ['SanctionsList', sanctionsListAbi(), 'listedByOwnList'], ['TestnetSanctionsOracleStandIn', standInAbi(), 'isTestnetStandIn']]) {
    if (!abi.some((e) => e.name === fn)) throw new Error(`the ${name} ABI has no ${fn}`);
  }
  const { parsed: adv } = await parseSdnAdvancedFile(new URL('./fixtures/sdn_advanced.sample.xml', import.meta.url));
  const { parsed: plain } = await parseSdnPlainFile(new URL('./fixtures/sdn_plain.sample.xml', import.meta.url));
  plainWitness(plain, adv, []);
  console.log(`sanctions-delister: release ok (fixtures ${adv.publicationId}, ${adv.addresses.length} addresses in both files)`);
}

async function main() {
  if (process.argv.includes('--check')) return check();
  const cfg = readConfig(process.env);
  const secrets = [...cfg.chains.map((c) => c.rpc), privateKeySecret(cfg.privateKey), cfg.tgToken];
  const clean = (m) => redact(m, secrets);
  if (!cfg.tgToken || !cfg.tgChatId) console.log('TG_OPS_BOT_TOKEN / TG_OPS_CHAT_ID unset: this run reports to the journal only.');
  if (cfg.ignoredMainnetRpcs.length) console.log(`ignored ${cfg.ignoredMainnetRpcs.join(', ')}: the delister runs on testnets only until a hardened mainnet host is decided (#2443).`);
  mkdirSync(cfg.stateDir, { recursive: true });
  const nowMs = Date.now();
  const lastAlert = readState(cfg.stateDir, 'last-alert.json');

  // Every outcome leaves through here: the caches (`saves`), the journal,
  // the chat when it calls for a person and has not been sent recently, and
  // last-run.json. No state write throws (writeStateFile): one that fails is
  // named in the report, the chat and last-run.json, and fails the unit, but
  // never stops the report of what the run did — an unknown broadcast's hash
  // is in that report. The unit fails when any chain failed, an alert was not
  // delivered or a state file was not written. Everything that leaves is
  // redacted once more here, whatever each step already did.
  const finish = async (rawReport, saves = {}) => {
    const stateNotSaved = [];
    const save = (file, value) => {
      const error = writeStateFile(cfg.stateDir, file, value);
      if (error) stateNotSaved.push({ file, error: clean(error) });
    };
    for (const [file, value] of Object.entries(saves)) save(file, value);
    const report = JSON.parse(clean(JSON.stringify({ ...rawReport, ...(stateNotSaved.length && { stateNotSaved: [...stateNotSaved] }) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v))));
    const text = clean(summarize(report));
    console.log(text);
    const digest = alertDigest(report);
    let delivery = { skipped: true, reason: digest ? 'already alerted' : 'nothing to alert' };
    if (shouldAlert(digest, lastAlert, nowMs)) {
      delivery = await notifyOps({ label: LABEL, token: cfg.tgToken, chatId: cfg.tgChatId, text });
      if (delivery.delivered) save('last-alert.json', { digest, at: nowMs });
    }
    const before = report.stateNotSaved?.length ?? 0;
    save('last-run.json', { at: new Date(nowMs).toISOString(), ...report, ...(stateNotSaved.length > before && { stateNotSaved }), alert: delivery });
    // The two records written after the report reach the journal here.
    for (const u of stateNotSaved.slice(before)) console.error(`STATE NOT SAVED: ${u.file}: ${u.error}`);
    const problems = [];
    if (report.status !== 'ok') problems.push(`the run finished as "${report.status}"`);
    if (delivery.delivered === false) problems.push(`its ops alert was not delivered: ${delivery.reason}`);
    if (stateNotSaved.length) problems.push(`${stateNotSaved.map((u) => u.file).join(', ')} not written`);
    if (problems.length) throw new Error(problems.join('; '));
  };

  const plan = planChains(cfg.chains, loadDeployments());
  const account = privateKeyToAccount(cfg.privateKey);
  const tl = timelockAbi();
  const abis = { tl, list: sanctionsListAbi(), att: attestorAbi(), standIn: standInAbi(), errors: errorNames(tl) };
  const vet = listRoleKeyVet({ listByChain: new Map(plan.filter((c) => c.list).map((c) => [c.id, c.list])), key: account.address, abi: abis.list });
  const clientFor = createClientLookup(new Map(cfg.chains.map((c) => [c.id, chainClients(c, account)])), vet);
  const queues = createSendQueues();
  const relayCache = readRelayCache(cfg.stateDir);
  const cache = readState(cfg.stateDir, 'evaluations.json');
  // The relay cache only ever holds what the chain vouched for (a message id
  // from the timelock's own event, a payload matching the attestor's hash),
  // so it is kept on every path.
  let result;
  try {
    result = await runDelister({
      key: account.address,
      cache,
      nowMs,
      redactError: clean,
      chains: plan.map((c) => {
        if (!c.skipped) return { ...c, effects: chainEffects({ c, account, clientFor, queues, relayCache, abis }) };
        return c.list ? { ...c, effects: { vetKey: () => clientFor(c.id) } } : c;
      }),
      loadPublication: async () => {
        const adv = join(cfg.stateDir, 'download.xml');
        const plain = join(cfg.stateDir, 'download-plain.xml');
        await downloadToFile(OFAC_SDN_ADVANCED_URL, adv);
        await downloadToFile(OFAC_SDN_PLAIN_URL, plain);
        const a = await parseSdnAdvancedFile(adv);
        const p = await parseSdnPlainFile(plain);
        const aFile = keepPublication(adv, cfg.stateDir, a.parsed.publicationDate, a.sourceHash, DEFAULT_KEEP_FILES);
        const pFile = keepPublication(plain, cfg.stateDir, p.parsed.publicationDate, p.sourceHash, DEFAULT_KEEP_FILES, 'sdn-plain');
        return {
          advanced: { parsed: a.parsed, sourceHash: a.sourceHash, source: { file: aFile, sha256: a.sourceHash, publicationId: a.parsed.publicationId, evmAddressCount: a.parsed.addresses.length } },
          plain: { parsed: p.parsed, sourceHash: p.sourceHash, source: { file: pFile, sha256: p.sourceHash, publicationDate: p.parsed.publicationDate, evmAddressCount: p.parsed.addresses.length } },
        };
      },
    });
  } catch (e) {
    const failed = { status: 'refused', error: clean(e.message), chains: {} };
    return finish(failed, { 'relay.json': relayCache });
  }
  await finish(result.report, { 'evaluations.json': result.cache, 'relay.json': relayCache });
}

if (isEntryPoint(import.meta)) {
  main().catch((e) => {
    console.error(`sanctions-delister: ${redact(e.message, [...SERVICE_CHAINS.map((c) => process.env[c.rpcEnv]), privateKeySecret(process.env.SANCTIONS_DELISTER_PRIVATE_KEY), process.env.TG_OPS_BOT_TOKEN])}`);
    process.exit(1);
  });
}
