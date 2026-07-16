#!/usr/bin/env node
/**
 * Notification-coverage guardrail (#1213 / E-11).
 *
 * The in-app notification center is a derived projection of the loan/
 * offer lifecycle (`apps/indexer/src/notifications.ts`). For the inbox
 * to stay complete as the contracts evolve, EVERY contract event tagged
 * `@custom:event-category state-change/loan-mutation` or
 * `state-change/offer-mutation` must either:
 *   (a) appear as a key in `EVENT_NOTIF_MAP` (it produces an inbox row), or
 *   (b) appear as a key in `NOTIF_DELIBERATELY_NOT_HANDLED` with a
 *       one-line reason (consciously not notified — companion / internal /
 *       transient / queued for a follow-up PR).
 *
 * Fails (exit 1) if any enforced event is neither mapped nor allowlisted.
 * This is the notification twin of `check-event-coverage.mjs`: the same
 * "a projection must not silently drift" contract, applied to the inbox
 * instead of the typed loans/offers tables. A new loan/offer event that
 * a dev forgets to notify (or consciously skip) breaks CI here.
 *
 * Run: `node apps/indexer/scripts/check-notification-coverage.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-notification-coverage`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACTS_SRC = join(REPO_ROOT, 'contracts', 'src');
const NOTIFICATIONS_TS = join(
  REPO_ROOT,
  'apps',
  'indexer',
  'src',
  'notifications.ts',
);

/** Recursively collect every `.sol` file under a directory. */
function walkSol(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkSol(p));
    else if (entry.endsWith('.sol')) out.push(p);
  }
  return out;
}

// ── 1. Collect `state-change/{loan,offer}-mutation` events ─────────────
const ENFORCED_CATEGORIES = new Set([
  'state-change/loan-mutation',
  'state-change/offer-mutation',
]);
const stateChangeEvents = new Map(); // name -> { file, category }
const ANNOT_RE =
  /@custom:event-category\s+(state-change\/[a-z-]+)[\s\S]*?\n\s*event\s+([A-Za-z0-9_]+)\s*\(/g;
for (const file of walkSol(CONTRACTS_SRC)) {
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = ANNOT_RE.exec(src)) !== null) {
    const [, category, name] = m;
    if (!ENFORCED_CATEGORIES.has(category)) continue;
    if (!stateChangeEvents.has(name)) {
      stateChangeEvents.set(name, { file: relative(REPO_ROOT, file), category });
    }
  }
}

// ── 2. Collect mapped + allowlisted names from notifications.ts ────────
// Parse the two object literals by scanning their blocks for quoted /
// bare keys — same regex-over-source approach check-event-coverage.mjs
// uses for `log.eventName === '...'`, robust to formatting.
const notifSrc = readFileSync(NOTIFICATIONS_TS, 'utf8');

/** Extract the top-level keys of `export const <name> = { ... }`. */
function extractObjectKeys(src, exportName) {
  const start = src.indexOf(`export const ${exportName}`);
  if (start === -1) return null;
  const braceOpen = src.indexOf('{', start);
  if (braceOpen === -1) return null;
  // Walk to the matching close brace.
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = src.slice(braceOpen + 1, end);
  const keys = new Set();
  // Depth-aware scan: collect an `Ident:` / `'Ident':` property name
  // only at the TOP level of the object body (depth 0), so nested value
  // objects (e.g. `{ kind, recipients }`) and string contents never
  // pollute the key set. Tracks brace/bracket depth and skips string
  // and line-comment spans.
  let d = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      // Skip the string literal.
      const quote = c;
      i++;
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      d++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      d--;
      continue;
    }
    if (d === 0 && /[A-Za-z_]/.test(c)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(body.slice(i));
      if (m) {
        keys.add(m[1]);
        i += m[1].length;
      }
    }
  }
  return keys;
}

const mapped = extractObjectKeys(notifSrc, 'EVENT_NOTIF_MAP');
const allowlisted = extractObjectKeys(notifSrc, 'NOTIF_DELIBERATELY_NOT_HANDLED');
if (!mapped || !allowlisted) {
  console.error(
    '✗ could not parse EVENT_NOTIF_MAP / NOTIF_DELIBERATELY_NOT_HANDLED from notifications.ts',
  );
  process.exit(1);
}

// ── 3. Diff ────────────────────────────────────────────────────────────
const missing = [];
const deadAllowlist = [];
for (const [name, info] of stateChangeEvents) {
  if (mapped.has(name)) continue;
  if (allowlisted.has(name)) continue;
  missing.push({ name, ...info });
}
// An allowlist entry that no longer names a real enforced event — or
// that is ALSO mapped (contradiction) — is stale; keep the list honest.
for (const name of allowlisted) {
  if (!stateChangeEvents.has(name)) {
    deadAllowlist.push(`${name} (no such state-change/{loan,offer}-mutation event)`);
  } else if (mapped.has(name)) {
    deadAllowlist.push(`${name} (also in EVENT_NOTIF_MAP — remove from allowlist)`);
  }
}

// ── 4. Report ──────────────────────────────────────────────────────────
let failed = false;
if (missing.length) {
  failed = true;
  console.error(
    '✗ state-change/{loan,offer}-mutation events with no notification mapping:\n',
  );
  for (const m of missing) console.error(`    ${m.name}   [${m.category}]   ${m.file}`);
  console.error(
    '\n  Add the event to EVENT_NOTIF_MAP in apps/indexer/src/notifications.ts\n' +
      '  (it produces an inbox row), or to NOTIF_DELIBERATELY_NOT_HANDLED with a\n' +
      '  one-line reason (consciously not notified).\n',
  );
}
if (deadAllowlist.length) {
  // Hard failure (Codex #1292 r6): a stale allowlist entry — a typo /
  // removed event, or an event that is BOTH mapped and allowlisted —
  // makes the skip list contradictory, silently undermining the
  // guardrail. Fail so the decision stays explicit and honest.
  failed = true;
  console.error('✗ NOTIF_DELIBERATELY_NOT_HANDLED has stale entries:\n');
  for (const e of deadAllowlist) console.error(`    ${e}`);
  console.error(
    '\n  Remove the stale entry (or, if it was mapped, drop it from the\n' +
      '  allowlist) so the coverage decision is unambiguous.\n',
  );
}
if (!failed) {
  const mappedCount = [...stateChangeEvents].filter(([n]) => mapped.has(n)).length;
  const allowCount = [...stateChangeEvents].filter(([n]) => allowlisted.has(n)).length;
  console.log(
    `✓ notification-coverage OK — ${stateChangeEvents.size} enforced state-change events ` +
      `(${mappedCount} notified, ${allowCount} allowlisted).`,
  );
}
process.exit(failed ? 1 : 0);
