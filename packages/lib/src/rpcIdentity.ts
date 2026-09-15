/**
 * Is the endpoint we are about to trust actually the chain we think it is?
 *
 * #1415 — a mis-pointed RPC secret (wrong `network=` slug, swapped URLs)
 * fails in the ONE shape that produces zero signal: a different network whose
 * head sits below our cursor reads as "caught up" — no error, no log, no
 * cursor movement (the July 2026 outage's silent phase). So `eth_chainId` is
 * verified once per isolate per (chainId, rpc) pair before anything reads
 * state.
 *
 * A TRANSPORT FAILURE IS NOT A VERDICT, and it is not license to proceed
 * either (Codex #1527 r1 P1): an unverified endpoint could be the mis-pointed
 * one. It stays uncached and is re-probed next pass.
 *
 * **Shared because it is a precondition of trusting a chain read, and more
 * than one Worker does that** (#2213 r14 `4013761179`). It lived in the
 * indexer, which calls it before every scan; the agent's reminder lane then
 * became authoritative about whether a loan is still running — deciding
 * whether to send a message that cannot be taken back — and asked no such
 * question. An `RPC_*` secret swapped to a foreign network with plausible
 * state at the same address could certify a foreign loan as active. One
 * check, both callers.
 */

/**
 * What the probe concluded. `transport` is "no answer", never "fine".
 *
 * `probed` says whether a request was actually issued, because the caller has
 * an outbound-request budget and this function answers from cache most of the
 * time (#2213 r16 `4014095543`). A caller charging for the call rather than
 * for the request invents one per chain per tick — which is the same
 * "charged for something that did not happen" this PR has now corrected in
 * four places.
 */
export type RpcIdentityVerdict =
  | { ok: true; probed: boolean }
  | { ok: false; reason: 'transport' }
  | { ok: false; reason: 'mismatch'; reported: number };

/**
 * Pairs confirmed in THIS isolate.
 *
 * Only a success is cached: a chain id does not change under a URL, so one
 * probe per isolate is enough, while caching a failure would pin a transient
 * one for the isolate's life.
 */
const verified = new Set<string>();

/**
 * Has this pair ALREADY been verified in this isolate?
 *
 * Exposed so a caller with a request budget can find out what the probe will
 * cost BEFORE spending it (#2213 r24 `4015538606`). Charging first and
 * deciding afterwards means a chain that cannot be admitted still burns the
 * request, and the chain behind it — whose probe is warm and which could have
 * afforded the whole pass — is refused for the request the first one wasted.
 */
export function isRpcIdentityVerified(chainId: number, rpc: string): boolean {
  return verified.has(`${chainId}:${rpc}`);
}

/** Test seam — an isolate's memory is otherwise unobservable. */
export function _resetRpcIdentityCache(): void {
  verified.clear();
}

export async function verifyRpcChainIdentity(
  client: { getChainId: () => Promise<number> },
  chainId: number,
  rpc: string,
  /** Log prefix of the caller, so an operator can see which lane refused. */
  lane: string,
): Promise<RpcIdentityVerdict> {
  const key = `${chainId}:${rpc}`;
  if (verified.has(key)) return { ok: true, probed: false };
  let reported: number;
  try {
    reported = await client.getChainId();
  } catch {
    return { ok: false, reason: 'transport' }; // no verdict — re-probe next pass
  }
  if (reported !== chainId) {
    // Deliberately NO fragment of the RPC URL here — not even the host.
    // Some providers put the generated credential in the HOSTNAME itself
    // (Codex #1527 r1 P2), so any slice of the URL risks turning this
    // diagnostic into a key leak. The expected chain id alone names the
    // mis-pointed `RPC_*` secret unambiguously.
    console.error(
      `[${lane}] RPC for chain ${chainId} answered eth_chainId=${reported} — ` +
        `mis-pointed RPC_* secret for this chain; refusing to use it until it is fixed`,
    );
    return { ok: false, reason: 'mismatch', reported };
  }
  verified.add(key);
  return { ok: true, probed: true };
}
