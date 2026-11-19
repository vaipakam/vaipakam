/**
 * A simulation with an approval in place before the wallet gives it.
 *
 * A call that pulls a token from the wallet (`transferFrom`) refuses without
 * an allowance, so a simulation asked before the approval only says "not
 * approved". To show what the call would do once the borrower approves
 * exactly the stated amount, the simulation is asked with that allowance
 * written into the token's storage as a state override (`eth_call`'s third
 * argument). Nothing is sent and nothing on chain changes.
 *
 * The allowance's storage slot depends on how the token was written. The
 * common layouts are tried (a plain `mapping(owner => mapping(spender =>
 * amount))` at a low slot index, and OpenZeppelin's namespaced ERC-20
 * storage), and a candidate is used only after the token's own `allowance`
 * view, asked under that override, answers the amount written. Where no
 * candidate is confirmed the caller states the figure as not known until the
 * approval is given; it never guesses a slot.
 */
import { encodeAbiParameters, erc20Abi, keccak256, numberToHex, pad, type PublicClient, type StateOverride } from 'viem';

type Hex = `0x${string}`;

/** OpenZeppelin v5 `ERC20Storage` location (ERC-7201 "openzeppelin.storage.ERC20"). */
const OZ_ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

/** The storage key of `allowance[owner][spender]` for a mapping at `slot`. */
export function allowanceKey(owner: Hex, spender: Hex, slot: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, slot]));
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
}

/** The mapping slots tried, most common first. */
export function candidateSlots(): bigint[] {
  const plain = Array.from({ length: 12 }, (_, i) => BigInt(i));
  // OZ v5: `_balances` at the base, `_allowances` one after it.
  return [1n, 2n, OZ_ERC20_STORAGE + 1n, ...plain.filter((s) => s !== 1n && s !== 2n), 51n, 52n];
}

/** The override that writes `amount` as the allowance, for one key. */
export function overrideFor(token: Hex, key: Hex, amount: bigint): StateOverride {
  return [{ address: token, stateDiff: [{ slot: key, value: pad(numberToHex(amount), { size: 32 }) }] }];
}

/**
 * An override under which `token.allowance(owner, spender)` reads `amount`,
 * confirmed by the token's own view; null when no candidate layout is
 * confirmed or the reads fail.
 */
export async function findAllowanceOverride(c: PublicClient, token: Hex, owner: Hex, spender: Hex, amount: bigint): Promise<StateOverride | null> {
  // A marker that differs from the amount (and so from a real allowance the
  // caller found short), so a match can only be the override's.
  const marker = amount + 0x5eed5eedn;
  for (const slot of candidateSlots()) {
    const o = overrideFor(token, allowanceKey(owner, spender, slot), marker);
    try {
      const read = (await c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender], stateOverride: o })) as bigint;
      if (read === marker) return overrideFor(token, allowanceKey(owner, spender, slot), amount);
    } catch {
      return null;
    }
  }
  return null;
}
