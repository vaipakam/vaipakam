/** #1672 — the query cache reports its settled errors to a driver, and only to one. */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  QUERY_PROBE_BINDING,
  QUERY_PROBE_VERSION,
  attachQueryStateProbe,
  queryProbeErrorChain,
  type QueryProbeEvent,
} from "./queryStateProbe";

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });

function driver() {
  const events: QueryProbeEvent[] = [];
  return {
    events,
    host: { [QUERY_PROBE_BINDING]: (e: QueryProbeEvent) => events.push(e) },
  };
}

describe("attachQueryStateProbe", () => {
  it("is inert when no driver installed a report", async () => {
    const c = client();
    const host = {};
    const off = attachQueryStateProbe(c, host);
    await c
      .fetchQuery({
        queryKey: ["x"],
        queryFn: () => Promise.reject(new Error("down")),
      })
      .catch(() => {});
    expect(host).toEqual({});
    expect(c.getQueryCache().hasListeners()).toBe(false);
    off();
  });

  it("announces itself, so a driver can tell an old build from a clean page", () => {
    const { events, host } = driver();
    attachQueryStateProbe(client(), host);
    expect(events).toEqual([{ v: QUERY_PROBE_VERSION, kind: "armed" }]);
  });

  it("reports a read once, after its retries are spent", async () => {
    const { events, host } = driver();
    const c = client();
    attachQueryStateProbe(c, host);
    let calls = 0;
    await c
      .fetchQuery({
        queryKey: ["loan", 7n],
        // wagmi hashes its bigint-carrying keys this way; the default cannot.
        queryKeyHashFn: (k) =>
          JSON.stringify(k, (_k, v: unknown) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        queryFn: () => {
          calls += 1;
          return Promise.reject(
            Object.assign(new Error("long text with https://rpc/KEY"), {
              shortMessage: "HTTP request failed.",
              name: "HttpRequestError",
            }),
          );
        },
      })
      .catch(() => {});
    expect(calls).toBe(2);
    const settled = events.filter((e) => e.kind === "settled-error");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      queryKey: '["loan","7"]',
      failureCount: 2,
      hadData: false,
      error: [{ name: "HttpRequestError", message: "HTTP request failed." }],
    });
    // The long message, which can carry the RPC URL, never leaves the page.
    expect(JSON.stringify(settled)).not.toContain("KEY");
  });

  it("reports nothing for a read whose retry was served", async () => {
    const { events, host } = driver();
    const c = client();
    attachQueryStateProbe(c, host);
    let calls = 0;
    await c.fetchQuery({
      queryKey: ["flaky"],
      queryFn: () =>
        ++calls === 1 ? Promise.reject(new Error("429")) : Promise.resolve(1),
    });
    expect(events.filter((e) => e.kind === "settled-error")).toEqual([]);
  });

  it("says when a background refetch failed over data still on screen", async () => {
    const { events, host } = driver();
    const c = client();
    attachQueryStateProbe(c, host);
    let up = true;
    const queryFn = () =>
      up ? Promise.resolve(1) : Promise.reject(new Error("down"));
    await c.fetchQuery({ queryKey: ["k"], queryFn });
    up = false;
    await c
      .fetchQuery({ queryKey: ["k"], queryFn, staleTime: 0 })
      .catch(() => {});
    const settled = events.filter((e) => e.kind === "settled-error");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ hadData: true });
  });

  it("survives a report that throws or rejects", async () => {
    const c = client();
    const host = {
      [QUERY_PROBE_BINDING]: (e: QueryProbeEvent) => {
        if (e.kind === "armed") throw new Error("gone");
        return Promise.reject(new Error("gone"));
      },
    };
    attachQueryStateProbe(c, host);
    await expect(
      c.fetchQuery({
        queryKey: ["y"],
        queryFn: () => Promise.reject(new Error("down")),
      }),
    ).rejects.toThrow("down");
  });

  it("stops reporting once detached", async () => {
    const { events, host } = driver();
    const c = client();
    attachQueryStateProbe(c, host)();
    await c
      .fetchQuery({
        queryKey: ["z"],
        queryFn: () => Promise.reject(new Error("down")),
      })
      .catch(() => {});
    expect(events.filter((e) => e.kind === "settled-error")).toEqual([]);
  });
});

describe("queryProbeErrorChain", () => {
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
    expect(queryProbeErrorChain(outer)).toEqual([
      {
        name: "ContractFunctionExecutionError",
        message: "The contract function reverted.",
      },
      {
        name: "RpcRequestError",
        code: 3,
        data: "0x08c379a0",
        message: "execution reverted",
      },
    ]);
  });

  it("stops on a cycle and on a non-object", () => {
    const self: Record<string, unknown> = { name: "Loop" };
    self.cause = self;
    expect(queryProbeErrorChain(self)).toEqual([{ name: "Loop" }]);
    expect(queryProbeErrorChain("plain")).toEqual([{ message: "plain" }]);
    expect(queryProbeErrorChain(undefined)).toEqual([]);
  });
});
