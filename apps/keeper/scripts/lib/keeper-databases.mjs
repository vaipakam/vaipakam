/**
 * The keeper's PRIVATE database, by name and pinned id (#2450).
 *
 * Both come from the D1 Worker registry (`PRIVATE_DATABASES`) and are never
 * spelled here. The id is the one the Worker binds and the machine host binds
 * too, never taken from host config (#2497 r4).
 *
 * Until #2560 these lived in `keeper-cutover.mjs`, next to the one-time copy
 * of the five tables that began in the shared database. That copy is done and
 * indexer migration 0064 drops its shared sources, so the copy and its checks
 * are retired and only the names are left.
 */
import { PRIVATE_DATABASES } from '../../../indexer/scripts/lib/d1-workers.mjs';

export const PRIVATE_DB = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').name;
export const PRIVATE_DB_ID = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').id;
