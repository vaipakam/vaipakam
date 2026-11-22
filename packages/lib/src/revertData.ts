/**
 * Reading a revert out of the error shapes ethers, viem and injected wallets
 * throw: the raw revert bytes, the decoded custom-error name and the 4-byte
 * selector. Nothing here names or explains an error; that is
 * `decodeContractError`, which reads the error catalogue. This module imports
 * nothing, so a plain Node consumer (the e2e driver) can use it without loading
 * the catalogue's JSON.
 */

export interface DecodableError {
  reason?: string;
  shortMessage?: string;
  message?: string;
  data?: string | { message?: string; data?: string };
  info?: { error?: { data?: string; message?: string } };
  error?: { data?: string; message?: string };
  revert?: { data?: string; name?: string; args?: unknown[] };
}

/** Revert bytes in a SINGLE error node's STRUCTURED fields (no cause
 *  traversal, no message text). These are what the provider or wallet
 *  reported as the error, and are read as reported. */
function structuredRevertData(e: DecodableError): string | undefined {
  const candidates: unknown[] = [
    typeof e.data === 'string' ? e.data : undefined,
    typeof e.data === 'object' ? e.data?.data : undefined,
    e.info?.error?.data,
    e.error?.data,
    e.revert?.data,
    // viem's ContractFunctionRevertedError keeps the raw revert bytes on
    // `.raw` (its decoded name lives on `.data.errorName`, handled by
    // extractRevertName).
    (e as { raw?: unknown }).raw,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('0x') && c.length >= 10) return c;
  }
  return undefined;
}

/**
 * A node's text with viem's ANNOTATIONS removed (#2336).
 *
 * viem builds `message` from `shortMessage`, its `metaMessages` annotations
 * and `details`, and its execution errors (`CallExecutionError`,
 * `EstimateGasExecutionError`, …) and `RpcRequestError` write the REQUEST into
 * those annotations — `data:` followed by the calldata, `Request body: {…}` —
 * whose selector-plus-whole-words shape is exactly what the scan below
 * accepts. Scanning them returned the call's own selector as its revert.
 *
 * The boundary is structural: annotations are the library's notes about the
 * call, not the error, so they are never scanned. What the provider or wallet
 * reported — its message text, `details` (viem copies the provider's message
 * there verbatim), and structured data — is read as reported. The decoder
 * deliberately does NOT try to recognise a provider that repeats the request
 * inside its own report: matching reported bytes against the request cannot
 * tell such an echo from a real revert whose selector equals the called
 * function's, so it would trade one misreading for another (#2338 r1–r4).
 */
function reportedText(e: DecodableError): string {
  const details = (e as { details?: unknown }).details;
  let text = [e.message, e.shortMessage, details]
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
  const meta = (e as { metaMessages?: unknown }).metaMessages;
  if (Array.isArray(meta)) {
    // Longest first, so a short annotation that also occurs inside a longer
    // one (viem's `' '` spacer, a bare label) cannot break the longer one's
    // removal; blank entries are spacers, not content. Each removal leaves a
    // line break so the text either side cannot fuse into one hex token.
    const lines = meta
      .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
      .sort((a, b) => b.length - a.length);
    for (const line of lines) text = text.split(line).join('\n');
  }
  return text;
}

/** Revert bytes quoted in a SINGLE node's reported text — some wallets / RPCs
 *  embed them there (e.g. `... data: 0x08c379a0...`). Accepts ONLY a clean
 *  4-byte selector (10 chars) or a full ABI-encoded revert payload (10 chars +
 *  multiples of 64 hex chars), which rules out a 40-char address (mistaken for
 *  the revert selector by the old `slice(0, 10)`) or a 64-char tx hash. */
function messageRevertData(e: DecodableError): string | undefined {
  const matches = reportedText(e).match(/0x[0-9a-fA-F]+/g) ?? [];
  for (const m of matches) {
    const len = m.length - 2; // strip 0x
    if (len === 8) return m; // bare 4-byte selector
    if (len >= 8 && (len - 8) % 64 === 0) return m; // selector + N abi-encoded args
  }
  return undefined;
}

/** The first `pick` hit along the `cause` chain. Bounded depth guards a
 *  cyclic graph. */
function firstAlongCauses(
  err: unknown,
  pick: (e: DecodableError) => string | undefined,
): string | undefined {
  let node: unknown = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 6; depth++) {
    const found = pick(node as DecodableError);
    if (found) return found;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Extracts the raw revert data (hex string starting with 0x) from the tangle
 *  of shapes ethers/injected wallets surface. Walks the viem `cause` chain:
 *  the real revert is usually wrapped several layers deep
 *  (ContractFunctionExecutionError → ContractFunctionRevertedError), so the
 *  top-level object has no `data` while a nested cause does.
 *
 *  Two passes, in this order (#2336): STRUCTURED fields on every node first,
 *  and only then reported message text, never viem's annotations
 *  ({@link reportedText}). A single per-node pass let an
 *  outer wrapper's text answer before the structured bytes one cause deeper
 *  were reached. */
export function extractRevertData(err: unknown): string | undefined {
  return firstAlongCauses(err, structuredRevertData) ?? firstAlongCauses(err, messageRevertData);
}

/**
 * The DECODED custom-error name (not raw bytes), walked out of the error
 * graph: viem stashes it on `ContractFunctionRevertedError.data.errorName`
 * in the `cause` chain, and some libraries expose it as `err.revert.name`.
 * Skips the generic `Error` / `Panic` shapes (their human text lives in the
 * base message).
 */
export function extractRevertName(err: unknown): string | undefined {
  let node: unknown = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 6; depth++) {
    const n = node as {
      revert?: { name?: unknown };
      data?: { errorName?: unknown };
      cause?: unknown;
    };
    const name =
      typeof n.revert?.name === 'string'
        ? n.revert.name
        : typeof n.data?.errorName === 'string'
          ? n.data.errorName
          : undefined;
    if (name && name !== 'Error' && name !== 'Panic') return name;
    node = n.cause;
  }
  return undefined;
}

/** Returns the 4-byte selector of a revert (0x + 8 hex chars) if present. */
export function extractRevertSelector(err: unknown): string | undefined {
  const data = extractRevertData(err);
  if (!data) return undefined;
  return data.slice(0, 10).toLowerCase();
}

