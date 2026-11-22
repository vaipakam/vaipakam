/**
 * Outbound requests during the rehearsal's off-chain stage (#3894), narrowed
 * to the step's fork. Every keeper pass reaches the network through the
 * global `fetch` (viem's HTTP transport resolves it per request, and so do
 * the aggregator, alert and price clients), so replacing it for the stage is
 * the one place every request passes. A request to any other origin is
 * refused with an error and recorded, so the pass that tried it is reported
 * as not rehearsed, naming the service, instead of reaching it.
 *
 * Only the ORIGIN is recorded: a path or query may carry a provider key.
 */
export interface NarrowedFetch {
  /** The origins refused since the last `take`, in order, and forget them. */
  take(): string[];
  /** Put the original `fetch` back. */
  restore(): void;
}

export function narrowFetchTo(allowedUrl: string): NarrowedFetch {
  const allowed = new URL(allowedUrl).origin;
  const original = globalThis.fetch;
  let blocked: string[] = [];
  const narrowed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string;
    try {
      origin = new URL(href).origin;
    } catch {
      origin = '(unparsable URL)';
    }
    if (origin !== allowed) {
      blocked.push(origin);
      throw new Error(`rehearsal: outbound request to ${origin} refused; only the fork is reachable in a rehearsal`);
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = narrowed;
  return {
    take() {
      const out = blocked;
      blocked = [];
      return out;
    },
    restore() {
      if (globalThis.fetch === narrowed) globalThis.fetch = original;
    },
  };
}

/**
 * The console lines a pass writes while it runs, captured for the report and
 * still printed. Lines are joined as the console would join its arguments.
 */
export async function captureConsole<T>(run: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; lines: string[] }> {
  const lines: string[] = [];
  const methods = ['log', 'warn', 'error', 'info'] as const;
  const saved = methods.map((m) => console[m]);
  methods.forEach((m, i) => {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map(describeArg).join(' '));
      saved[i].apply(console, args);
    };
  });
  try {
    return { value: await run(), error: undefined, lines };
  } catch (error) {
    return { value: undefined, error, lines };
  } finally {
    methods.forEach((m, i) => {
      console[m] = saved[i];
    });
  }
}

function describeArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(a);
  } catch {
    return String(a);
  }
}
