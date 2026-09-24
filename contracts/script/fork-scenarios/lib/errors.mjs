/**
 * Custom-error decoding for fork scenarios.
 *
 * The Diamond reverts with typed custom errors rather than strings, and a
 * bare `eth_call` failure surfaces only the 4-byte selector. This builds a
 * selector -> signature index from every committed facet ABI so a refusal
 * can be reported by NAME — which matters here, because several of the
 * behaviours under test ARE refusals (`IlliquidLoanNoRiskMath`,
 * `SanctionedAddress`, `NoEnabledSwapRoute`), and a scenario that cannot
 * name the refusal cannot tell an expected one from a defect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import { RPC_URL } from './chain.mjs';

const ABI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/src/abis',
);

/** selector -> `ErrorName(type,type)` across the whole exported surface. */
export const ERROR_INDEX = (() => {
  const index = {};
  for (const file of fs.readdirSync(ABI_DIR).filter((f) => f.endsWith('.json'))) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(ABI_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (entry.type !== 'error') continue;
      const sig = `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(',')})`;
      try {
        index[toFunctionSelector(sig)] = sig;
      } catch {
        /* unencodable signature — skip */
      }
    }
  }
  return index;
})();

/**
 * Simulate a call and report either its raw return data or the NAME of the
 * custom error it reverted with. Used as a pre-flight before every state
 * change so a scenario records *why* the protocol refused.
 */
export async function simulate(to, abi, functionName, args, from) {
  const data = encodeFunctionData({ abi, functionName, args });
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, from, data }, 'latest'],
    }),
  });
  const json = await res.json();
  if (!json.error) return { ok: true, result: json.result };
  const payload = json.error?.data?.data ?? json.error?.data ?? '';
  const selector = typeof payload === 'string' && payload.startsWith('0x') ? payload.slice(0, 10) : null;
  return {
    ok: false,
    selector,
    name: selector ? (ERROR_INDEX[selector] ?? `UNKNOWN ${selector}`) : String(json.error.message).slice(0, 160),
  };
}
