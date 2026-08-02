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
 *   RPC_URL=... DIAMOND=0x... CHAIN_ID=8453 \
 *     node apps/indexer/scripts/backfill-recycle-days.mjs --to <lastDay> \
 *     > restore/d1/recycle_day_backfill.sql
 *
 *   wrangler d1 execute vaipakam-archive \
 *     --file=restore/d1/recycle_day_backfill.sql --remote
 */
import process from 'node:process';
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

if (!RPC_URL) die('RPC_URL is required');
if (!DIAMOND) die('DIAMOND is required');
if (!Number.isFinite(CHAIN_ID) || CHAIN_ID <= 0) die('CHAIN_ID is required');
if (!Number.isFinite(TO) || TO < FROM) die('--to <lastDay> is required');

const client = createPublicClient({ transport: http(RPC_URL) });

const read = (functionName, args = []) =>
  client.readContract({ address: DIAMOND, abi: ABI, functionName, args });

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

  for (let day = FROM; day <= TO; day++) {
    let m;
    try {
      m = await read('getRecycleDayMetrics', [BigInt(day)]);
    } catch (err) {
      die(`day ${day}: ${err} — refusing to emit a partial backfill`);
    }
    const [stamped, floor, budget, drawdown, local, mirror] = m;
    if (!stamped) {
      // No pool was ever recorded for this day, so there is nothing to
      // preserve. Emitting a zero row would invent a finalized day.
      skipped++;
      continue;
    }
    rows.push(
      `INSERT INTO recycle_day_backfill (chain_id, day_id, stamped, ` +
        `schedule_floor, recycled_budget, fresh_drawdown, absorbed_local, ` +
        `absorbed_mirror, armed, armed_from_day, recorded_at) VALUES (` +
        `${CHAIN_ID}, ${day}, 1, ${q(floor)}, ${q(budget)}, ${q(drawdown)}, ` +
        `${q(local)}, ${q(mirror)}, ${isArmed(day, armedFromDay) ? 1 : 0}, ` +
        `${armedFromDay}, ${recordedAt}) ` +
        `ON CONFLICT (chain_id, day_id) DO NOTHING;`,
    );
  }

  // ON CONFLICT DO NOTHING, deliberately: re-running after a demotion
  // yields DIFFERENT figures, and the first capture is the one taken while
  // the inputs were still intact. An idempotent re-run must not overwrite
  // it. Correcting a row is a conscious manual act, not a side effect of
  // running this twice.
  console.log(`-- recycle_day_backfill: chain ${CHAIN_ID}, days ${FROM}..${TO}`);
  console.log(`-- armedFromDay=${armedFromDay} (0 = never armed)`);
  console.log(`-- ${rows.length} finalized day(s); ${skipped} unstamped, skipped`);
  for (const r of rows) console.log(r);

  console.error(
    `backfill-recycle-days: ${rows.length} row(s), ${skipped} unstamped skipped, ` +
      `armedFromDay=${armedFromDay}`,
  );
}

main().catch((err) => die(String(err)));
