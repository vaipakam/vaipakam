/**
 * Multicall3's canonical deterministic-deployment address, and why every
 * `multicall()` in this Worker must be given it explicitly.
 *
 * EVERY keeper client is built as `createPublicClient({ transport: http(rpc) })`
 * with **no `chain`** — verified tree-wide: zero `chain:` properties across
 * `apps/{keeper,agent,indexer}/src`. viem resolves Multicall3 from
 * `chain.contracts.multicall3`, so on a chainless client `multicall()` throws
 *
 *     client chain not configured. multicallAddress is required.
 *
 * **before issuing a single request.** Not a runtime RPC failure — a local
 * rejection, every time, on every chain.
 *
 * That is dangerous here specifically because both call sites CATCH it and fall
 * back to serial reads. The pass still completes and still logs its completion
 * marker, so the batching silently never happens and the only trace is an error
 * line that reads like a transient RPC blip:
 *
 * - `rewardBudgetRemit` — caught at #1924 r37; the batched closure probe was
 *   entering its catch path on every call, so every ambiguous day reported as
 *   UNKNOWN and operators would have had to clear the window by hand each run.
 * - `liquidator` — caught at #1946. Its comment says Multicall3 batching with a
 *   serial fallback "so a chain without Multicall3 (rare on production EVM)
 *   still gets scanned, just slower". The rare path was the ONLY path: every
 *   active loan cost its own subrequest, against a 50-per-invocation ceiling.
 *   A prime suspect for #1896.
 *
 * The constant lives here rather than beside either call site because it was
 * fixed once and then reintroduced next door. A third `multicall()` that
 * forgets it fails the same silent way, so make this the obvious thing to
 * reach for.
 *
 * Passing the address is deliberate in preference to attaching a chain object:
 * the chainless clients are a tree-wide design choice, and changing that is a
 * much larger change than this defect warrants.
 */
export const MULTICALL3_ADDRESS =
  '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
