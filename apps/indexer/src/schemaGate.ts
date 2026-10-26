/**
 * The indexer's D1 schema gate — scheduled work runs only against the schema
 * this build was written for.
 *
 * The gate itself, its migration list and the reasons for both live in the
 * shared package (`@vaipakam/lib/d1SchemaGate`, #2410), because the keeper
 * and the agent bind the same database and ask the same question. This module
 * is the indexer's own instance and wording.
 *
 * WHY A GATE AND NOT ONLY A DEPLOY ORDER. The indexer's deploy applies
 * migrations, verifies them and only then publishes; the keeper's and agent's
 * deploys verify before publishing (scripts/deploy-shared-d1.mjs). But the
 * indexer also auto-deploys on every merge through Cloudflare Workers Builds,
 * whose deploy command is dashboard configuration this repository cannot see
 * or pin. If that route publishes without migrating, the new code meets the
 * old schema — and #1149 is what that looks like: every scan failed `no such
 * column`, the fail-closed cursor held, and the stall was opaque until
 * someone read the logs. #2214 closed the same class for ONE table with a
 * per-feature probe; every later migration would need its own.
 *
 * Scheduled ingest and maintenance decline the tick with a log line naming
 * what is missing, instead of running code against a schema it was not
 * written for. Nothing advances and nothing half-writes, and ingest resumes
 * by itself on the first tick after the migrations land — no redeploy, no
 * manual cursor repair.
 *
 * WHAT IT DOES NOT COVER: HTTP. Every `fetch()` handler — the reads, and the
 * POST writes (`/signed-offers` and the `/hooks/chain-event` webhook) — runs against whatever schema the database
 * has, so a handler that reads or writes a new column must tolerate the
 * previous schema itself (or ship after its migration). The shared module
 * states the rest.
 */
import {
  createSchemaGate,
  schemaDeclineNotice as sharedDeclineNotice,
  type SchemaCheck,
} from '@vaipakam/lib/d1SchemaGate';

export { createSchemaGate, type SchemaCheck };

/** The Worker's gate. One per isolate (module scope is per isolate). */
export const schemaGate = createSchemaGate();

/** The log line a declined pass prints — one wording for every entry point. */
export function schemaDeclineNotice(
  where: string,
  check: Exclude<SchemaCheck, { state: 'current' }>,
): string {
  return sharedDeclineNotice('indexer', where, check);
}
