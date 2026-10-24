/** #1672 — the app reports its reads' final outcomes to a driver, and only to one. */
import { QueryClient } from "@tanstack/react-query";
import { createPublicClient, custom, type Transport } from "viem";
import { describe, expect, it } from "vitest";
import {
  READ_PROBE_BINDING,
  READ_PROBE_VERSION,
  attachReadProbe,
  probeTransport,
  readProbeErrorChain,
  type ReadProbeEvent,
} from "./readProbe";

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });

function driver() {
  const events: ReadProbeEvent[] = [];
  return {
    events,
    host: { [READ_PROBE_BINDING]: (e: ReadProbeEvent) => events.push(e) },
  };
}

const kinds = (events: ReadProbeEvent[], kind: ReadProbeEvent["kind"]) =>
  events.filter((e) => e.kind === kind);

describe("probeTransport", () => {
  const provider = (answer: (method: string) => unknown) => ({
    request: async ({ method }: { method: string }) => answer(method),
  });

  it("returns the transport itself when no driver installed a report", () => {
    const t: Transport = custom(provider(() => "0x1"));
    expect(probeTransport(t, 84532, {})).toBe(t);
  });

  it("reports a request once, with its method, after viem's retries", async () => {
    const { events, host } = driver();
    let attempts = 0;
    const t = custom(
      provider(() => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("busy"), { code: -32005 });
        return "0x10";
      }),
      { retryCount: 1, retryDelay: 0 },
    );
    const c = createPublicClient({ transport: probeTransport(t, 84532, host) });
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(attempts, "viem retried the failed attempt").toBe(2);
    const start = kinds(events, "rpc-start");
    const settled = kinds(events, "rpc-settled");
    expect(start).toEqual([
      { v: READ_PROBE_VERSION, kind: "rpc-start", seq: expect.any(Number), chainId: 84532, method: "eth_blockNumber" },
    ]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ ok: true, method: "eth_blockNumber", chainId: 84532 });
    expect((settled[0] as { seq: number }).seq).toBe((start[0] as { seq: number }).seq);
  });

  it("reports a read that finally failed, even where the caller swallows it", async () => {
    const { events, host } = driver();
    const t = custom(
      provider(() => {
        throw Object.assign(new Error("long text with https://rpc/KEY"), { code: -32603 });
      }),
      { retryCount: 0 },
    );
    const c = createPublicClient({ transport: probeTransport(t, 84532, host) });
    // What a hook does when it degrades a failed read into "unavailable".
    const value = await c.getBlockNumber({ cacheTime: 0 }).catch(() => null);
    expect(value).toBeNull();
    const settled = kinds(events, "rpc-settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ ok: false, method: "eth_blockNumber" });
    const chain = (settled[0] as { error: unknown[] }).error;
    expect(chain.length).toBeGreaterThan(0);
    // The long message, which can carry the RPC URL, never leaves the page.
    expect(JSON.stringify(settled)).not.toContain("KEY");
  });

  it("carries neither a request's parameters nor its result", async () => {
    const { events, host } = driver();
    const t = custom(provider(() => "0xdeadbeef"), { retryCount: 0 });
    const c = createPublicClient({ transport: probeTransport(t, 84532, host) });
    await c.request({ method: "eth_getBalance", params: ["0x00000000000000000000000000000000000000aa", "latest"] });
    const text = JSON.stringify(events);
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("00aa");
  });

  it("survives a report that throws or rejects", async () => {
    const host = {
      [READ_PROBE_BINDING]: (e: ReadProbeEvent) => {
        if (e.kind === "rpc-start") throw new Error("gone");
        return Promise.reject(new Error("gone"));
      },
    };
    const t = custom(provider(() => "0x2"), { retryCount: 0 });
    const c = createPublicClient({ transport: probeTransport(t, 84532, host) });
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(2n);
  });
});

describe("attachReadProbe", () => {
  it("is inert when no driver installed a report", async () => {
    const c = client();
    const host = {};
    const off = attachReadProbe(c, host);
    await c
      .fetchQuery({ queryKey: ["x"], queryFn: () => Promise.reject(new Error("down")) })
      .catch(() => {});
    expect(host).toEqual({});
    expect(c.getQueryCache().hasListeners()).toBe(false);
    off();
  });

  it("announces itself, so a driver can tell an old build from a clean page", () => {
    const { events, host } = driver();
    attachReadProbe(client(), host);
    expect(events).toEqual([{ v: READ_PROBE_VERSION, kind: "armed" }]);
  });

  it("says a query is retrying, then settles it once its retries are spent", async () => {
    const { events, host } = driver();
    const c = client();
    attachReadProbe(c, host);
    let calls = 0;
    await c
      .fetchQuery({
        queryKey: ["loan", 7n],
        // wagmi hashes its bigint-carrying keys this way; the default cannot.
        queryKeyHashFn: (k) =>
          JSON.stringify(k, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        queryFn: () => {
          calls += 1;
          return Promise.reject(
            Object.assign(new Error("long text with https://rpc/KEY"), {
              shortMessage: "Could not decode the result.",
              name: "AbiDecodingDataSizeTooSmallError",
            }),
          );
        },
      })
      .catch(() => {});
    expect(calls).toBe(2);
    expect(kinds(events, "query-retrying")).toEqual([
      expect.objectContaining({ queryKey: '["loan","7"]', failureCount: 1 }),
    ]);
    const settled = kinds(events, "query-settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: "error",
      queryKey: '["loan","7"]',
      failureCount: 2,
      hadData: false,
      error: [{ name: "AbiDecodingDataSizeTooSmallError", message: "Could not decode the result." }],
    });
    expect(JSON.stringify(settled)).not.toContain("KEY");
  });

  it("closes a retry that was served, and says nothing of a query that never failed", async () => {
    const { events, host } = driver();
    const c = client();
    attachReadProbe(c, host);
    let calls = 0;
    await c.fetchQuery({
      queryKey: ["flaky"],
      queryFn: () => (++calls === 1 ? Promise.reject(new Error("429")) : Promise.resolve(1)),
    });
    await c.fetchQuery({ queryKey: ["steady"], queryFn: () => Promise.resolve(2) });
    expect(kinds(events, "query-retrying")).toHaveLength(1);
    expect(kinds(events, "query-settled")).toEqual([
      expect.objectContaining({ queryKey: '["flaky"]', outcome: "ok" }),
    ]);
  });

  it("closes a retry the query was cancelled out of", async () => {
    const { events, host } = driver();
    const c = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 50 } } });
    attachReadProbe(c, host);
    const pending = c
      .fetchQuery({ queryKey: ["slow"], queryFn: () => Promise.reject(new Error("down")) })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(kinds(events, "query-retrying")).toHaveLength(1);
    await c.cancelQueries({ queryKey: ["slow"] });
    await pending;
    expect(kinds(events, "query-settled")).toEqual([
      expect.objectContaining({ queryKey: '["slow"]', outcome: "cancelled" }),
    ]);
  });

  it("says when a background refetch failed over data still on screen", async () => {
    const { events, host } = driver();
    const c = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    attachReadProbe(c, host);
    let up = true;
    const queryFn = () => (up ? Promise.resolve(1) : Promise.reject(new Error("down")));
    await c.fetchQuery({ queryKey: ["k"], queryFn });
    up = false;
    await c.fetchQuery({ queryKey: ["k"], queryFn, staleTime: 0 }).catch(() => {});
    const settled = kinds(events, "query-settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "error", hadData: true });
  });

  it("stops reporting once detached", async () => {
    const { events, host } = driver();
    const c = client();
    attachReadProbe(c, host)();
    await c
      .fetchQuery({ queryKey: ["z"], queryFn: () => Promise.reject(new Error("down")) })
      .catch(() => {});
    expect(events.filter((e) => e.kind !== "armed")).toEqual([]);
  });
});

describe("readProbeErrorChain", () => {
  it("walks the cause chain, keeping names, codes and revert data", () => {
    const inner = {
      name: "RpcRequestError",
      code: 3,
      data: "0x08c379a0",
      shortMessage: "execution reverted",
    };
    const outer = {
      name: "ContractFunctionExecutionError",
      shortMessage: "The contract function reverted.",
      cause: inner,
    };
    expect(readProbeErrorChain(outer)).toEqual([
      { name: "ContractFunctionExecutionError", message: "The contract function reverted." },
      { name: "RpcRequestError", code: 3, data: "0x08c379a0", message: "execution reverted" },
    ]);
  });

  it("stops on a cycle and on a non-object", () => {
    const self: Record<string, unknown> = { name: "Loop" };
    self.cause = self;
    expect(readProbeErrorChain(self)).toEqual([{ name: "Loop" }]);
    expect(readProbeErrorChain("plain")).toEqual([{ message: "plain" }]);
    expect(readProbeErrorChain(undefined)).toEqual([]);
  });
});
