/**
 * WHAT A COMPLETED REFINANCE PROVABLY DID — the pure halves of
 * `live-refinance.mjs`'s three outcome claims (#2422, narrowed in the
 * #2431 re-cut). Everything here reads ONE receipt or values pinned to ONE
 * block; nothing models fees, settlement amounts or other parties' state.
 *
 *   - `scanForReplacement`: the loan opened from this run's request, found
 *     by a state scan — its limit stated as UNKNOWN, never as "none";
 *   - `lienCarried`: the collateral lien released on the old loan and live on
 *     the replacement with the same asset, type, tokenId and amount;
 *   - `collateralMovedOut`: no collateral-token transfer out of the
 *     borrower's vault in the accept receipt;
 *   - `requestStateOf`: one request-state rule for the preflight and the
 *     failure ledger;
 *   - `checkRoleNonces`: each role's nonce reconciliation, recorded only when
 *     its own read succeeds.
 *
 * Pure; `refinanceOutcome.test.mjs` pins each helper, the lien and the
 * receipt against the real loan 22 → loan 23 accept (block 47711162).
 */

const lc = (a) => String(a).toLowerCase();
const topicAddress = (t) => (typeof t === 'string' && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);

// ---------------------------------------------------------------------
// The replacement loan, by state scan.
// ---------------------------------------------------------------------

/**
 * Scan loan ids upward from `startId` for the loan whose `offerId` is
 * `requestId`. Loan ids are sequential and an unused id reads back with
 * `id == 0`, so reaching that EMPTY ID is the only thing that establishes
 * "no such loan" (returns null).
 *
 * Exhausting `cap` ids without reaching it establishes nothing: the
 * replacement could sit past the cap. That THROWS — the caller reports the
 * entry as UNKNOWN with its event-lookup remedy — rather than returning the
 * same null an honest "none" returns (#2422 r8). Two loans carrying the
 * request also throw.
 *
 * @param {{ readLoan: (id: bigint) => Promise<{ id: bigint, offerId: bigint }>,
 *           startId: bigint, requestId: bigint, cap: number }} a
 */
export async function scanForReplacement({ readLoan, startId, requestId, cap }) {
  let match = null;
  let id = startId;
  for (let n = 0; n < cap; n++, id++) {
    const l = await readLoan(id);
    if (l.id === 0n) return match;
    if (l.offerId === requestId) {
      if (match) throw new Error(`two loans (#${match.id}, #${l.id}) carry request #${requestId}`);
      match = l;
    }
  }
  throw new Error(
    `the replacement scan read ${cap} loan ids (#${startId}–#${id - 1n}) without reaching an empty id — ` +
      `a loan carrying request #${requestId} may lie past the cap${match ? ` (one was found at #${match.id}; a second may too)` : ''}`,
  );
}

// ---------------------------------------------------------------------
// The collateral lien carried over (claim 3).
// ---------------------------------------------------------------------

/**
 * `getLoanCollateralLien` at the accept block: the OLD loan's lien released,
 * and the REPLACEMENT's live with the same asset, asset type, tokenId and
 * amount as the old loan's collateral. Returns readable mismatch lines;
 * empty ⇔ the lien was carried.
 *
 * @param {{ oldAfter: object, newAfter: object,
 *           expected: { asset: string, assetType: number|bigint, tokenId: bigint, amount: bigint } }} a
 */
export function lienCarried({ oldAfter, newAfter, expected }) {
  const out = [];
  if (oldAfter.released !== true) out.push(`old loan lien: released ${oldAfter.released}, expected true`);
  if (newAfter.released !== false) out.push(`replacement lien: released ${newAfter.released}, expected false (a live lien)`);
  if (lc(newAfter.asset) !== lc(expected.asset)) out.push(`replacement lien: asset ${newAfter.asset}, expected ${expected.asset}`);
  if (Number(newAfter.assetType) !== Number(expected.assetType)) out.push(`replacement lien: assetType ${newAfter.assetType}, expected ${expected.assetType}`);
  if (BigInt(newAfter.tokenId) !== BigInt(expected.tokenId)) out.push(`replacement lien: tokenId ${newAfter.tokenId}, expected ${expected.tokenId}`);
  if (BigInt(newAfter.amount) !== BigInt(expected.amount)) out.push(`replacement lien: amount ${newAfter.amount}, expected ${expected.amount}`);
  return out;
}

// ---------------------------------------------------------------------
// Collateral leaving the borrower's vault, from the accept receipt alone.
// ---------------------------------------------------------------------

/** keccak256 of the three token-movement events this drive watches. */
export const TOPIC = {
  /** Transfer(address,address,uint256) — ERC-20 (3 topics) and ERC-721 (4). */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** TransferSingle(address,address,address,uint256,uint256) — ERC-1155. */
  transferSingle: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  /** TransferBatch(address,address,address,uint256[],uint256[]) — ERC-1155. */
  transferBatch: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
};

/**
 * Every movement of `token` OUT of `from` in `logs` (one receipt's logs), by
 * the event the asset type emits: ERC-20 (assetType 0) and ERC-721 (1) a
 * `Transfer` with `from` as its first indexed address; ERC-1155 (2) a
 * `TransferSingle` / `TransferBatch` with `from` as its SECOND indexed
 * address (the first is the operator). Returns readable lines; empty ⇔ none.
 */
export function collateralMovedOut({ logs, token, from, assetType }) {
  const type = Number(assetType);
  if (![0, 1, 2].includes(type)) throw new Error(`collateralMovedOut: unknown asset type ${assetType}`);
  const out = [];
  for (const l of logs) {
    if (lc(l.address) !== lc(token)) continue;
    const t0 = lc(l.topics?.[0]);
    if (type !== 2 && t0 === TOPIC.transfer && topicAddress(l.topics[1]) === lc(from)) {
      out.push(`${type === 1 ? 'ERC-721' : 'ERC-20'} Transfer from ${from} to ${topicAddress(l.topics[2])}`);
    }
    if (type === 2 && (t0 === TOPIC.transferSingle || t0 === TOPIC.transferBatch) && topicAddress(l.topics[2]) === lc(from)) {
      out.push(`ERC-1155 ${t0 === TOPIC.transferSingle ? 'TransferSingle' : 'TransferBatch'} from ${from} to ${topicAddress(l.topics[3])}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// The request's state, and each role's nonce reconciliation.
// ---------------------------------------------------------------------

/**
 * A refinance request's state from its on-chain reads (#2422 r13) — one rule
 * for the preflight's "no open request" condition and the failure ledger:
 * cancelled (`isOfferCancelled`) outranks everything, then accepted, then
 * expired (`expiresAt != 0 && expiresAt <= block time`, the contract's own
 * expiry test), else open. A cancelled request that has not expired yet is
 * NOT open — the preflight used to count it as one.
 */
export function requestStateOf({ offer, cancelled, blockTs }) {
  if (cancelled) return 'cancelled';
  if (offer.accepted) return 'accepted';
  const exp = BigInt(offer.expiresAt);
  if (exp !== 0n && exp <= BigInt(blockTs)) return 'expired';
  return 'open';
}

/**
 * Read `role`'s latest and pending nonces and record `<role>Nonces` against
 * the consumed plan transactions — ONLY when that read succeeds (#2422 r9).
 * A read that throws records nothing: the check stays NOT RUN, so the
 * write-discipline claim cannot print as verified on the other role's
 * evidence alone. Returns what happened, for the transcript.
 */
export async function checkRoleNonces({ role, readNonces, baseline, hashed, allowed, record }) {
  let latest;
  let pending;
  try {
    ({ latest, pending } = await readNonces());
  } catch (e) {
    return { recorded: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 120) };
  }
  const mined = Number(latest) - Number(baseline);
  const queued = Number(pending) - Number(latest);
  const ok = mined === Number(hashed) && Number(hashed) === Number(allowed) && queued === 0;
  const observed = `mined +${mined}, pending +${queued}, allowed ${allowed}, hashed ${hashed}`;
  record(`${role}Nonces`, ok, observed);
  return { recorded: true, ok, observed };
}
