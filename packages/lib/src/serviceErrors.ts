/**
 * The service error record and the request reference on the service side
 * (#3922, TroubleshootingPictureDesign §3 and §4.6).
 *
 * `withRequestReference` wraps a Worker's whole `fetch`, so every route gets
 * the same treatment from one place:
 *
 *   1. The reference is the app's own when the request carries a well-formed
 *      one, else a new one (`requestReference.ts` says which requests carry
 *      one).
 *   2. Every response returns it in `x-request-ref`, exposed to the browser
 *      wherever the response is readable cross-origin at all.
 *   3. A failed or refused request (status 400 and up, or a throw, which
 *      becomes a 500 here instead of the platform's bare error page) writes
 *      one log line naming the reference, and one row in `service_errors`.
 *      A successful request writes nothing.
 *
 * What the row holds: the service, the method, the route as a PATTERN, the
 * status, the reference and where it came from, the build and the time. It
 * holds no wallet, no address of any kind and no network address of the
 * caller. The route is reduced to a pattern because a path can carry an
 * address (`/loans/by-participant/0x…`); the query string is never read.
 *
 * Which failures get a row: every 5xx, and a 4xx only when the request came
 * from one of the app's own origins. A scanner probing for paths gets 404s
 * from anywhere, and those would otherwise crowd out the failures a user
 * actually saw. An origin header can be forged, so the record is also capped
 * per service: at most `SERVICE_ERROR_HOURLY_CAP` rows an hour and
 * `SERVICE_ERROR_DAILY_CAP` a UTC day. The hour's counter keeps counting past
 * either cap, so the record says how many it did not keep. The caps bound the
 * table whatever a caller sends: two services, 300 rows a day, 90 days is at
 * most 54,000 rows (about 11 MB), well inside the nightly backup's ceiling.
 *
 * The write happens after the response is sent (`waitUntil`) and never
 * changes the response. A database without the table (the previous schema)
 * makes the write fail, which is logged and nothing else.
 *
 * Kept 90 days by default; the indexer's scheduled run prunes
 * (`pruneServiceErrors`). No public route serves the record.
 */
import { isListedOrigin } from './originAllowList';
import { redactedError } from './errorDescription';
import { buildValue } from './buildHistory';
import {
  REQUEST_REF_HEADER,
  isRequestReference,
  newRequestReference,
} from './requestReference';

/** The services that keep this record, so a typo cannot start a new one. */
export const SERVICE_ERROR_SERVICES = ['indexer', 'agent'] as const;
export type ServiceErrorService = (typeof SERVICE_ERROR_SERVICES)[number];

/** Rows kept per service per hour; failures past it are counted, not kept. */
export const SERVICE_ERROR_HOURLY_CAP = 25;

/** Rows kept per service per UTC day, so a whole day of forged refusals
 *  cannot fill the record either. */
export const SERVICE_ERROR_DAILY_CAP = 300;

/** Default retention, and the bounds an operator's setting is held to. */
export const SERVICE_ERROR_RETENTION_DAYS = 90;
export const SERVICE_ERROR_RETENTION_MIN_DAYS = 7;
export const SERVICE_ERROR_RETENTION_MAX_DAYS = 400;

/** Path segments a route pattern keeps before it stops. */
const MAX_ROUTE_SEGMENTS = 8;

/** A word a route literal can contribute: lower case letters, digits, `-`
 *  and `_`, never all digits and never hex-shaped, so a kept word can never be
 *  read as an id or an address (and the restore can check the same shape). */
const ROUTE_WORD = /^(?![0-9]+$)(?!(?:0x)?[0-9a-f]+$)[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The route as a pattern. A segment survives only when it is, exactly, one of
 * `routeWords`: the words the service's own routing code names (each service
 * keeps them in `src/routeWords.json`, and a test re-derives that list from
 * the source with `extractRouteWords`, so it cannot fall behind). Every other
 * segment becomes a placeholder by its shape: `:n` for digits, `:hex` for a
 * hex value, `:x` for anything else. So a path segment the caller chose (an
 * address, an id, a name, a token) never reaches the log or the record,
 * whether or not the route exists. A word missing from the list only makes
 * the pattern less specific; it never lets a value through.
 */
export function routePattern(pathname: string, routeWords: ReadonlySet<string>): string {
  const segments = pathname.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (const raw of segments.slice(0, MAX_ROUTE_SEGMENTS)) {
    if (routeWords.has(raw)) out.push(raw);
    else if (/^[0-9]+$/.test(raw)) out.push(':n');
    else if (/^(0x)?[0-9a-f]+$/i.test(raw)) out.push(':hex');
    else out.push(':x');
  }
  if (segments.length > MAX_ROUTE_SEGMENTS) out.push(':more');
  return '/' + out.join('/');
}

/**
 * The route words a service's source names: every word of every path literal
 * (a quoted string starting with `/`) and every path regex (`/^\/...`) in the
 * given sources. Run by each service's test against its own `src/`, compared
 * with its `src/routeWords.json`. Over-inclusion is harmless: a word that
 * appears in the code is not something a caller chose.
 */
export function extractRouteWords(sources: readonly string[]): string[] {
  const words = new Set<string>();
  const add = (path: string) => {
    for (const part of path.replace(/\\/g, '').split('/')) if (ROUTE_WORD.test(part)) words.add(part);
  };
  for (const src of sources) {
    for (const m of src.matchAll(/(['"`])(\/[A-Za-z0-9_\-/.{}$:]*)\1/g)) add(m[2]);
    for (const m of src.matchAll(/\/\^(\\\/(?:[^/\n\\]|\\.)*)\//g)) add(m[1]);
  }
  return [...words].sort();
}

/** One row of the record, as the wrapper writes it. */
export interface ServiceErrorRow {
  service: ServiceErrorService;
  method: string;
  route: string;
  status: number;
  reference: string;
  /** `app` = the request carried it; `service` = the service made it. */
  referenceSource: 'app' | 'service';
  build: string;
  versionId: string | null;
  at: number;
}

interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

/**
 * Write one row, under both caps. One batch: the hour's counter always moves,
 * and the row is kept only while the rows already kept for the service this
 * hour and this UTC day are under their caps (counted from the record itself,
 * through its (service, at) index).
 */
export async function recordServiceError(db: D1Like, row: ServiceErrorRow): Promise<void> {
  const hour = Math.floor(row.at / 3600) * 3600;
  const day = Math.floor(row.at / 86_400) * 86_400;
  await db.batch([
    db
      .prepare(
        `INSERT INTO service_error_hours (service, hour_start, failures) VALUES (?1, ?2, 1)
         ON CONFLICT (service, hour_start) DO UPDATE SET failures = failures + 1`,
      )
      .bind(row.service, hour),
    db
      .prepare(
        `INSERT INTO service_errors
           (service, method, route, status, reference, reference_source, build, version_id, at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
          WHERE (SELECT COUNT(*) FROM service_errors WHERE service = ?1 AND at >= ?10 AND at < ?10 + 3600) < ?11
            AND (SELECT COUNT(*) FROM service_errors WHERE service = ?1 AND at >= ?12 AND at < ?12 + 86400) < ?13`,
      )
      .bind(
        row.service,
        row.method,
        row.route,
        row.status,
        row.reference,
        row.referenceSource,
        row.build,
        row.versionId,
        row.at,
        hour,
        SERVICE_ERROR_HOURLY_CAP,
        day,
        SERVICE_ERROR_DAILY_CAP,
      ),
  ]);
}

/** The retention an operator's setting asks for, held to the bounds; the default when unset or unreadable. */
export function serviceErrorRetentionDays(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  if (!Number.isInteger(n) || (raw ?? '').trim() === '') return SERVICE_ERROR_RETENTION_DAYS;
  return Math.min(SERVICE_ERROR_RETENTION_MAX_DAYS, Math.max(SERVICE_ERROR_RETENTION_MIN_DAYS, n));
}

/** Remove rows and hour counters older than the retention period, and nothing newer. */
export async function pruneServiceErrors(
  db: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } },
  retentionDays: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const cutoff = now - retentionDays * 86_400;
  await db.prepare('DELETE FROM service_errors WHERE at < ?1').bind(cutoff).run();
  await db.prepare('DELETE FROM service_error_hours WHERE hour_start + 3600 <= ?1').bind(cutoff).run();
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RequestReferenceOptions<E> {
  service: ServiceErrorService;
  /** The words the service's routing code names (`routePattern`). */
  routeWords: ReadonlySet<string>;
  /** The database to record into, or null when this build has none. */
  db(env: E): D1Like | null;
  /** The app's origins (`FRONTEND_ORIGIN`), for the 4xx rule. */
  frontendOrigins(env: E): string | undefined;
  /** The CORS origin for the 500 a throw becomes, or null for none. */
  corsOrigin(req: Request, env: E): string | null;
  /** The running version, from the version-metadata binding. */
  version(env: E): { id?: string; tag?: string } | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

/** Wrap a Worker `fetch` with the request reference and the service error record. */
export function withRequestReference<E, C extends ExecutionContextLike>(
  handler: (req: Request, env: E, ctx: C) => Promise<Response>,
  opts: RequestReferenceOptions<E>,
): (req: Request, env: E, ctx: C) => Promise<Response> {
  const log = opts.log ?? ((line: string) => console.warn(line)); // eslint-disable-line no-console
  return async (req, env, ctx) => {
    const sent = req.headers.get(REQUEST_REF_HEADER);
    const fromApp = isRequestReference(sent);
    const reference = fromApp ? sent : newRequestReference();

    let res: Response;
    try {
      res = await handler(req, env, ctx);
    } catch (err) {
      log(`[${opts.service}] request ${reference} threw: ${redactedError(err)}`);
      const origin = opts.corsOrigin(req, env);
      res = new Response('internal error', {
        status: 500,
        headers: origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {},
      });
    }

    // A WebSocket upgrade cannot be rebuilt, and carries nothing to show.
    if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;

    res = withReferenceHeader(res, reference);

    if (req.method !== 'OPTIONS' && res.status >= 400) {
      const route = routePattern(new URL(req.url).pathname, opts.routeWords);
      log(`[${opts.service}] request ${reference} ${req.method} ${route} -> ${res.status}`);
      const db = opts.db(env);
      const fromAppOrigin = isListedOrigin(req.headers.get('Origin'), opts.frontendOrigins(env));
      if (db && (res.status >= 500 || fromAppOrigin)) {
        const version = opts.version(env);
        const row: ServiceErrorRow = {
          service: opts.service,
          method: req.method.toUpperCase().slice(0, 8),
          route,
          status: res.status,
          reference,
          referenceSource: fromApp ? 'app' : 'service',
          build: buildValue(version?.tag),
          versionId: version?.id ?? null,
          at: Math.floor((opts.now?.() ?? Date.now()) / 1000),
        };
        const write = recordServiceError(db, row).catch((err) => {
          log(`[${opts.service}] service error record for ${reference} not written: ${redactedError(err)}`);
        });
        try {
          ctx.waitUntil(write);
        } catch {
          /* no execution context (a test caller): the write still runs */
        }
      }
    }
    return res;
  };
}

/**
 * The response with the reference header, exposed to the browser when the
 * response is readable cross-origin. A response whose headers are immutable
 * (one passed through from an upstream `fetch`) is copied first.
 */
function withReferenceHeader(res: Response, reference: string): Response {
  let out = res;
  try {
    out.headers.set(REQUEST_REF_HEADER, reference);
  } catch {
    out = new Response(res.body, res);
    out.headers.set(REQUEST_REF_HEADER, reference);
  }
  if (out.headers.has('Access-Control-Allow-Origin')) {
    const exposed = out.headers.get('Access-Control-Expose-Headers');
    const list = (exposed ?? '').split(',').map((s) => s.trim().toLowerCase());
    if (!list.includes(REQUEST_REF_HEADER) && !list.includes('*')) {
      out.headers.set('Access-Control-Expose-Headers', exposed ? `${exposed}, ${REQUEST_REF_HEADER}` : REQUEST_REF_HEADER);
    }
  }
  return out;
}
