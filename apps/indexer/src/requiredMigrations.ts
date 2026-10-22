/**
 * Every D1 migration this build was written against — the schema gate
 * (schemaGate.ts) holds scheduled work until ALL of them are recorded in
 * `d1_migrations`, and the deploy wrapper (scripts/deploy-shared-d1.mjs)
 * refuses to publish until they are.
 *
 * The list is the shared database's, so it lives in the shared package
 * (`packages/lib/src/sharedD1Migrations.json`, #2410) where the keeper and the
 * agent read the same one. `scripts/check-schema-gate.mjs` (part of this
 * Worker's `typecheck`) fails CI unless it equals this Worker's `migrations/`
 * directory exactly, so adding a migration here without listing it is a red
 * check, not a gate that lets new code run ahead of its schema.
 */
export { SHARED_D1_MIGRATIONS as REQUIRED_D1_MIGRATIONS } from '@vaipakam/lib/d1SchemaGate';
