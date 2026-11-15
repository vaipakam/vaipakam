/**
 * The `cloudflare:workers` module as the unit tests see it. The runtime
 * module exists only inside workerd; the tests run in Node and never build
 * the Durable Object through it (they drive `TelegramStateStore` over a
 * SQLite fake, `sqliteDo.ts`), so only the base class has to resolve.
 */
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
