#!/usr/bin/env node
/**
 * Pre-cutover recycling day backfill (#1349 M5).
 *
 * Widening the day-close event changed its topic, so days finalized BEFORE
 * that upgrade cannot supply `freshDrawdown` or `armed`, and the indexer
 * refuses them rather than reading the absent fields as zero. This pass is
 * where those days come from: it recomputes each one from
 * `getRecycleDayMetrics` and emits SQL for `recycle_day_backfill`.
 *
 * ── Run it BEFORE any demotion or role migration ──────────────────────
 *
 * The getter recomputes from `dayCapThreshold18`, and
 * `setBroadcastDayCapThreshold` is a second writer of that slot which can
 * overwrite it for an already-finalized day on a Diamond demoted from the
 * canonical role. After that the recomputation returns a different figure
 * from what the day actually committed, and the original is unrecoverable
 * — those days carry no widened event to fall back on. This is an ordering
 * requirement from the data model, not from the ceremony.
 *
 * ── Why a script and not a Worker route ───────────────────────────────
 *
 * It needs chain reads and has to be sequenced by hand against a role
 * change. The indexer Worker is deliberately read-only and
 * operator-key-free, and adding an admin write path to it for a one-time
 * pass would be a posture change out of proportion to the job. The output
 * is SQL, applied with the same `wrangler d1 execute` the rest of the
 * runbook uses.
 *
 * Usage:
 *   mkdir -p restore/d1
 *   RPC_URL=... DIAMOND=0x... CHAIN_ID=8453 \
 *     OUT=restore/d1/recycle_day_backfill.sql \
 *     node apps/indexer/scripts/backfill-recycle-days.mjs --to <lastDay>
 *
 * (the `mkdir` is not decoration — the shell opens a redirect before node
 *  starts, so a clean checkout fails with "No such file or directory" and
 *  runs no backfill at all)
 *
 * Pass OUT rather than redirecting. A shell redirect TRUNCATES the target
 * before this script runs, so a failed re-run would destroy a previous
 * pre-demotion capture — the one thing here that cannot be recreated. With
 * OUT the script writes a sibling temp file and renames it only after a
 * complete run, so an interrupted or failed pass leaves the prior capture
 * untouched. Without OUT it prints to stdout, which stays useful for
 * inspection but carries no such guarantee.
 *
 *   wrangler d1 execute vaipakam-archive \
 *     --file=restore/d1/recycle_day_backfill.sql --remote
 */
import process from 'node:process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';

const ABI = [
  {
    type: 'function',
    name: 'getRecycleDayMetrics',
    stateMutability: 'view',
    inputs: [{ name: 'dayId', type: 'uint256' }],
    outputs: [
      { name: 'stamped', type: 'bool' },
      { name: 'scheduleFloor', type: 'uint256' },
      { name: 'recycledBudget', type: 'uint256' },
      { name: 'freshDrawdown', type: 'uint256' },
      { name: 'absorbedLocal', type: 'uint256' },
      { name: 'absorbedMirror', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getGovernorCommitState',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'armedFromDay', type: 'uint256' },
      { name: 'outstandingFresh', type: 'uint256' },
      { name: 'outstandingRecycled', type: 'uint256' },
      { name: 'paidOutRecycled', type: 'uint256' },
    ],
  },
];

/**
 * Bumped whenever the COMPUTATION changes — not on comment edits.
 *
 * These rows are non-reproducible and first-write-wins, so two captures
 * taken under the same arming sentinel are otherwise indistinguishable
 * even if a revised script produced one of them (Codex #1513 r4 P2). The
 * schema comment promised this provenance; now it is persisted.
 */
const GENERATOR_REVISION = 'backfill-recycle-days@2';

function die(msg) {
  console.error(`backfill-recycle-days: ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const RPC_URL = process.env.RPC_URL;
const DIAMOND = process.env.DIAMOND;
const CHAIN_ID = Number(process.env.CHAIN_ID);
const FROM = Number(arg('--from') ?? 0);
const TO = Number(arg('--to'));
const OUT = process.env.OUT;

if (!RPC_URL) die('RPC_URL is required');
if (!DIAMOND) die('DIAMOND is required');
if (!Number.isFinite(CHAIN_ID) || CHAIN_ID <= 0) die('CHAIN_ID is required');
// `--from` is validated as strictly as `--to` (Codex #1513 r1 P2). An
// invocation like `--from --to 100` leaves it NaN, every comparison against
// NaN is false, the loop body never runs — and the pass EXITS 0 reporting
// zero rows. A backfill that silently scans nothing while claiming success
// is worse than one that fails, because the operator moves on.
// SAFE integers, and a bounded span (Codex #1513 r4 P2). `Number.isInteger`
// accepts 2^53, where `day++` cannot change the value — the loop then reads
// the same contract day forever, emits nothing (the SQL is buffered until
// the end) and burns RPC quota without bound. A cap also turns a fat-finger
// `--to 99999999` into a refusal rather than a multi-day scan.
const MAX_SCAN_DAYS = 10_000;
if (!Number.isSafeInteger(FROM) || FROM < 0) {
  die('--from must be a non-negative safe integer day');
}
if (!Number.isSafeInteger(TO) || TO < FROM) {
  die('--to <lastDay> is required, a safe integer, and >= --from');
}
if (TO - FROM + 1 > MAX_SCAN_DAYS) {
  die(
    `refusing to scan ${TO - FROM + 1} days (cap ${MAX_SCAN_DAYS}) — that is ` +
      `one RPC round trip per day; narrow the range or raise the cap ` +
      `deliberately`,
  );
}

const client = createPublicClient({ transport: http(RPC_URL) });

/**
 * Every read is PINNED to one block.
 *
 * A serial scan against `latest` resolves each day at whatever block is
 * current when it runs, so a demotion and its first broadcast landing
 * mid-scan capture early days before `dayCapThreshold18` was overwritten
 * and later days after (Codex #1513 r3 P2). The pass still succeeds, and
 * `ON CONFLICT DO NOTHING` then preserves that mixed history as
 * authoritative — a silently half-corrupted record is worse than a failed
 * run, because nothing signals it.
 *
 * One block also makes the capture a coherent snapshot rather than a
 * traversal: `armedFromDay` and every day's figures describe the same
 * chain state.
 */
let PINNED_BLOCK;

const read = (functionName, args = []) =>
  client.readContract({
    address: DIAMOND,
    abi: ABI,
    functionName,
    args,
    blockNumber: PINNED_BLOCK,
  });

/**
 * Arming is resolved ONCE and stamped on every row.
 *
 * `getRecycleDayMetrics` returns figures and no armed bit, and days before
 * `armedFromDay` are every day of the documented initial unarmed
 * deployment — most of what a first backfill covers. Storing them bare
 * would republish unreserved ESTIMATES as net emission, in the flattering
 * direction, which is exactly what the event's `armed` field exists to
 * prevent.
 *
 * The zero sentinel is load-bearing and a bare `day >= armedFromDay` is
 * explicitly forbidden by the spec: `armedFromDay == 0` means NEVER ARMED,
 * not "every day is armed". Getting that backwards would mark the entire
 * pre-arming history as committed.
 */
function isArmed(day, armedFromDay) {
  if (armedFromDay === 0n) return false;
  return BigInt(day) >= armedFromDay;
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

async function main() {
  // CHAIN_ID is only the SQL label — the client follows whatever network
  // RPC_URL points at (Codex #1513 r1 P2). Pair a valid Diamond and RPC for
  // one chain with another chain's id and every read succeeds while the
  // rows are written under the wrong chain. `ON CONFLICT DO NOTHING` then
  // makes that unrepairable by a later correct run: the wrong rows win.
  // Check before reading anything.
  let live;
  try {
    live = await client.getChainId();
  } catch (err) {
    die(`cannot read the chain id from RPC_URL (${err})`);
  }
  if (live !== CHAIN_ID) {
    die(
      `RPC_URL is chain ${live} but CHAIN_ID says ${CHAIN_ID}. Rows would be ` +
        `labelled for a chain they did not come from, and ON CONFLICT DO ` +
        `NOTHING would make that permanent.`,
    );
  }

  try {
    PINNED_BLOCK = await client.getBlockNumber();
  } catch (err) {
    die(`cannot read the head block (${err}); refusing to scan against a moving target`);
  }

  let armedFromDay;
  try {
    [armedFromDay] = await read('getGovernorCommitState');
  } catch (err) {
    // Fail closed. A backfill that cannot establish arming status must not
    // write bare figures — that is the one outcome this pass exists to
    // avoid, and guessing "unarmed" would be a silent claim about history.
    die(`cannot read getGovernorCommitState (${err}); refusing to write rows`);
  }

  const recordedAt = Math.floor(Date.now() / 1000);
  const rows = [];
  let skipped = 0;
  let unstamped = 0;

  for (let day = FROM; day <= TO; day++) {
    let m;
    try {
      m = await read('getRecycleDayMetrics', [BigInt(day)]);
    } catch (err) {
      die(`day ${day}: ${err} — refusing to emit a partial backfill`);
    }
    const [stamped, floor, budget, drawdown, local, mirror] = m;

    // An UNFINALIZED day can still carry absorption, and for a day that
    // predates this indexer's event coverage the getter is the ONLY source
    // for it (Codex #1513 r3 P2). Skipping those lost the attribution
    // permanently — from the daily series and from the component totals.
    // The row is emitted with `stamped = 0` and zeroed pool figures, which
    // is what the read surface already means by "absorption, no pool";
    // it does NOT invent a finalized day.
    if (!stamped) {
      if (local === 0n && mirror === 0n) {
        skipped++;
        continue;
      }
      rows.push(
        `INSERT INTO recycle_day_backfill (chain_id, day_id, stamped, ` +
          `schedule_floor, recycled_budget, fresh_drawdown, absorbed_local, ` +
          `absorbed_mirror, armed, armed_from_day, recorded_at, generator_rev` +
          `) VALUES (` +
          `${CHAIN_ID}, ${day}, 0, '0', '0', '0', ` +
          `${q(local)}, ${q(mirror)}, 0, ` +
          `${armedFromDay}, ${recordedAt}, ${q(GENERATOR_REVISION)}) ` +
          `ON CONFLICT (chain_id, day_id) DO NOTHING;`,
      );
      unstamped++;
      continue;
    }
    rows.push(
      `INSERT INTO recycle_day_backfill (chain_id, day_id, stamped, ` +
        `schedule_floor, recycled_budget, fresh_drawdown, absorbed_local, ` +
        `absorbed_mirror, armed, armed_from_day, recorded_at, generator_rev` +
        `) VALUES (` +
        `${CHAIN_ID}, ${day}, 1, ${q(floor)}, ${q(budget)}, ${q(drawdown)}, ` +
        `${q(local)}, ${q(mirror)}, ${isArmed(day, armedFromDay) ? 1 : 0}, ` +
        `${armedFromDay}, ${recordedAt}, ${q(GENERATOR_REVISION)}) ` +
        `ON CONFLICT (chain_id, day_id) DO NOTHING;`,
    );
  }

  // ON CONFLICT DO NOTHING, deliberately: re-running after a demotion
  // yields DIFFERENT figures, and the first capture is the one taken while
  // the inputs were still intact. An idempotent re-run must not overwrite
  // it. Correcting a row is a conscious manual act, not a side effect of
  // running this twice.
  const out = [
    `-- recycle_day_backfill: chain ${CHAIN_ID}, days ${FROM}..${TO}`,
    `-- armedFromDay=${armedFromDay} (0 = never armed)`,
    `-- ${rows.length - unstamped} finalized, ${unstamped} absorption-only, ${skipped} empty`,
    `-- pinned at block ${PINNED_BLOCK}`,
    `-- generator ${GENERATOR_REVISION}`,
    ...rows,
    '',
  ].join('\n');

  if (OUT) {
    // Temp file + rename: the destination is only replaced by a COMPLETE
    // run. Everything above can still die (a mid-scan RPC failure exits
    // non-zero), and the previous capture is the irreplaceable artifact.
    const tmp = `${OUT}.tmp-${PINNED_BLOCK}`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, out, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, OUT);
  } else {
    process.stdout.write(out);
  }

  console.error(
    `backfill-recycle-days: ${rows.length} row(s) ` +
      `(${rows.length - unstamped} finalized, ${unstamped} absorption-only), ` +
      `${skipped} empty, armedFromDay=${armedFromDay}, block=${PINNED_BLOCK}`,
  );
}

main().catch((err) => die(String(err)));
