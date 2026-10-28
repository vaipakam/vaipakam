/**
 * The bindings `wrangler.jsonc` declares, typed. Every field is optional on
 * purpose: a binding a deployment lacks must read as "not configured", never
 * as a crash, and the handler says which one is missing.
 */
import type { RateLimitBinding } from '@vaipakam/lib/rateLimit';

/** A Secrets Store binding: the value is read per request, never at load. */
export interface SecretBinding {
  get(): Promise<string>;
}

export interface Env {
  /** CSV of exact origins whose pages may call the proxy. */
  FRONTEND_ORIGIN?: string;
  /** The per-caller budget (one slot per HTTP request). */
  RPC_CALLER_RATELIMIT?: RateLimitBinding;
  /** One upstream URL per served chain, named by `RPC_PROXY_CHAINS`. */
  [secret: `RPC_PROXY_${string}`]: SecretBinding | undefined;
}
