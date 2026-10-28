/**
 * Vaipakam read-only RPC proxy Worker (#1724). The handler and the rules it
 * applies are in `proxy.ts`; what it forwards is in
 * `@vaipakam/lib/rpcProxyPolicy`.
 */
import type { Env } from './env';
import { handle } from './proxy';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
} satisfies ExportedHandler<Env>;
