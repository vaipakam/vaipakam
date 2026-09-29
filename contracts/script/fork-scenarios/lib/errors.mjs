/**
 * Custom-error decoding for a SIMULATED call.
 *
 * The Diamond reverts with typed custom errors rather than strings, and a
 * bare `eth_call` failure surfaces only the 4-byte selector. Several of the
 * behaviours under test ARE refusals (`IlliquidLoanNoRiskMath`,
 * `SanctionedAddress`, `NoEnabledSwapRoute`), so a scenario that cannot name
 * the refusal cannot tell an expected one from a defect.
 *
 * The selector table itself lives in `selectors.mjs`, because `chain.mjs`'s
 * `tx()` needs the same lookup for a SENT transaction and cannot import this
 * module without a cycle.
 */
import { RPC_URL } from './chain.mjs';
import { encodeFunctionData } from 'viem';
import { ERROR_INDEX, describeRevertData, nameSelector } from './selectors.mjs';

export { ERROR_INDEX };

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
    // Prefer the fully-decoded form — `OfferTermsMismatch(1)` names the
    // field that disagreed, where the bare signature does not.
    name: selector
      ? (describeRevertData(payload) ?? nameSelector(selector) ?? `UNKNOWN ${selector}`)
      : String(json.error.message).slice(0, 160),
  };
}
