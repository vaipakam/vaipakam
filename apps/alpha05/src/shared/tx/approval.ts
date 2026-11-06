/**
 * Setting an ERC-20 allowance to an exact value, as one rule every flow that
 * approves a token uses (RB-FUNDS). The ALLOWANCE IS THE TRUTH: each step is
 * judged by reading the allowance back after it, at the block its receipt
 * mined in, never by the receipt's status. A step the wallet cancelled or
 * replaced, one whose receipt could not be read, or one that reverted all
 * show up the same way, as an allowance that is not the value asked for,
 * and are reported with what the allowance reads now and the hash of any
 * step whose outcome is still open.
 *
 * Some tokens refuse to move a non-zero allowance to another non-zero value.
 * Whether this token does is asked of the token itself (a dry run of the
 * direct approval) rather than assumed, so the extra step to zero is taken,
 * and counted as a prompt, only for a token that needs it.
 */

type Hex = `0x${string}`;

export interface AllowanceIo {
  /** The allowance now, or at `block` when given (a receipt's block). */
  read: (block?: bigint) => Promise<bigint>;
  /** Whether the token would accept `approve(amount)` from the wallet now. */
  accepts: (amount: bigint) => Promise<boolean>;
  /** Ask the wallet to approve `amount`; resolves with the hash. Throws when
   *  the wallet refuses (nothing was sent). */
  send: (amount: bigint) => Promise<Hex>;
  /** Wait for a sent step; resolves with the block it mined in. Throws when
   *  the receipt cannot be read. */
  wait: (hash: Hex) => Promise<bigint>;
  /** Told before each wallet prompt, so the page can say which it is. */
  onStep?: (amount: bigint, index: number, of: number) => void;
}

export type AllowanceResult =
  | { ok: true }
  | {
      ok: false;
      /** Why it stopped: the wallet refused a prompt, a step did not leave
       *  the allowance at its value, or (with `expect`) the allowance was
       *  not the value this flow left, so nothing was touched. */
      why: 'refused' | 'not-set' | 'changed';
      /** How many steps were sent before it stopped. */
      sent: number;
      /** The allowance as last read; null when it could not be read. */
      now: bigint | null;
      /** The last value a step of this call verifiably set (the step to
       *  zero ahead of a failed one); null when none did. A clean-up may
       *  overwrite only this value, never one something else set. */
      last: bigint | null;
      /** A sent step whose outcome is not known (its receipt and the
       *  allowance after it could not be read). */
      pending: Hex | null;
      /** The wallet's or the chain's own words, when there are any. */
      reason: string | null;
    };

/** The steps that take `now` to `target` for this token: one, or two when
 *  the token refuses a non-zero to non-zero change. */
export async function allowanceSteps(io: Pick<AllowanceIo, 'accepts'>, now: bigint, target: bigint): Promise<bigint[]> {
  if (now === target) return [];
  if (now !== 0n && target !== 0n && !(await io.accepts(target))) return [0n, target];
  return [target];
}

/**
 * Sets the allowance to `target`. With `expect`, nothing is sent unless the
 * allowance reads exactly that first (a clean-up never overwrites an
 * authorization something else made in between).
 */
export async function setAllowance(io: AllowanceIo, target: bigint, expect?: bigint): Promise<AllowanceResult> {
  let now: bigint | null;
  try {
    now = await io.read();
  } catch (e) {
    return { ok: false, why: 'not-set', sent: 0, now: null, last: null, pending: null, reason: (e as Error).message };
  }
  if (expect !== undefined && now !== expect) return { ok: false, why: 'changed', sent: 0, now, last: null, pending: null, reason: null };
  const steps = await allowanceSteps(io, now, target);
  let last: bigint | null = null;
  for (const [i, amount] of steps.entries()) {
    io.onStep?.(amount, i, steps.length);
    let hash: Hex;
    try {
      hash = await io.send(amount);
    } catch (e) {
      return { ok: false, why: 'refused', sent: i, now, last, pending: null, reason: (e as Error).message };
    }
    const block = await io.wait(hash).catch(() => undefined);
    const after = await io.read(block).catch(() => null);
    if (after !== amount) {
      // Without a receipt the step may still land: its hash stays open.
      return { ok: false, why: 'not-set', sent: i + 1, now: after, last, pending: block === undefined || after === null ? hash : null, reason: null };
    }
    now = after;
    last = amount;
  }
  return { ok: true };
}
