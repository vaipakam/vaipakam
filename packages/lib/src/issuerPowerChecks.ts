/**
 * #3433 — the issuer-power checks themselves, as pure functions over a small
 * read client, so the keeper machine's pass and (later) the apps run ONE rule.
 *
 * What a check states is a fact about the asset's code at one block, never a
 * verdict (design ruling 2026-11-21, on the owner's 2026-11-15 decision that
 * the contracts stay uncurated):
 *   - 'found': the code has a function with one of the selectors looked for,
 *     or a read showed the state (a proxy pointer set, paused now, a
 *     transfer refused). A found function says only that the code has it,
 *     never that the issuer can use it today (a role may be renounced).
 *   - 'not_found': the checker saw the WHOLE code and the selectors are not
 *     in it, or the read answered no.
 *   - 'unknown': the checker could not tell. The evidence says why.
 *
 * ── The four conditions on the selector heuristic (ruling 2 of 3) ─────
 *
 *  1. Selectors are read as PUSH4 values by walking the opcodes
 *     ({@link scanCode}), so push data is never read as an instruction and a
 *     selector inside data is never a find.
 *  2. The code is followed: EIP-1967 implementation and beacon, EIP-1822,
 *     the older zeppelinos slot, an EIP-1167 minimal proxy's target, an
 *     `implementation()` answer, and every facet an EIP-2535 loupe lists.
 *     Evidence names the implementation and the admin or owner.
 *  3. 'not_found' only when the whole code was seen: no DELEGATECALL in the
 *     asset's code, or a recognised proxy whose implementation (or every
 *     facet) was read. Otherwise the function checks are 'unknown', with the
 *     reason in the evidence.
 *  4. A find carries the selector and the function name as evidence.
 *
 * Nothing here signs or sends: the transfer checks are `eth_call`s.
 */
import { decodeFunctionResult, encodeFunctionData, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { describeFailure } from './errorDescription';
import { ISSUER_CHECKER_VERSION, issuerCheckApplies, issuerChecksRunFor, issuerRunComplete, type IssuerPowerCheckId } from './issuerPowers';

/** The check ids this checker writes: the shared list's checks that run in
 *  this checker version (`conduit_transfer` does not run in version 2). */
export const ISSUER_CHECK_IDS_V2 = issuerChecksRunFor('erc721') as readonly IssuerPowerCheckId[];
export type IssuerCheckIdV2 = IssuerPowerCheckId;

/** The checker version these checks are (the shared list's version). */
export const ISSUER_CHECKER_VERSION_V2 = ISSUER_CHECKER_VERSION;

export type CheckResult = 'found' | 'not_found' | 'unknown';
export type CheckedKind = 'erc20' | 'erc721' | 'erc1155' | 'unknown';

export interface Finding {
  check: IssuerCheckIdV2;
  result: CheckResult;
  /** A short public fact behind the result (at most 300 characters). */
  evidence: string | null;
}

/** What `call` answered: data, or a revert (with the error's name or
 *  selector when there was one). A call the RPC did not answer THROWS. */
export type CallOutcome = { kind: 'returned'; data: Hex } | { kind: 'reverted'; reason: string | null };

/**
 * The reads a check makes, all at one block the client is bound to. A read
 * that the RPC did not answer throws; the check turns it into 'unknown'.
 */
export interface IssuerReadClient {
  getCode(address: Address): Promise<Hex>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex>;
  call(req: { to: Address; data: Hex; from?: Address }): Promise<CallOutcome>;
}

/** A unit a vault holds, for the vault transfer check. */
export interface VaultHolding {
  /** The vault that holds it, which moves it as its owner on every platform
   *  path (a hand-over on default is a vault-to-vault move). */
  holder: Address;
  /** Another vault, which receives it in the simulation. */
  to: Address;
  /** The token id (ERC-721 / ERC-1155); ignored for an ERC-20. */
  tokenId: bigint;
}

export interface AssetCheck {
  kind: CheckedKind;
  /** True when every applicable check is 'found' or 'not_found'. */
  complete: boolean;
  /** Why the run is not complete, at most 300 characters; null when it is. */
  detail: string | null;
  findings: Finding[];
}

export const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_BEACON_SLOT: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const EIP1967_ADMIN_SLOT: Hex = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
/** `keccak256("org.zeppelinos.proxy.implementation")`, the pre-EIP-1967 slot. */
export const ZEPPELINOS_IMPLEMENTATION_SLOT: Hex = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
export const ERC5192_INTERFACE_ID: Hex = '0xb45a3c0e';
export const ERC721_INTERFACE_ID: Hex = '0x80ac58cd';
export const ERC1155_INTERFACE_ID: Hex = '0xd9b67a26';
/** The most loupe facets followed; a diamond with more is 'unknown'. */
export const MAX_FACETS = 64;

/** The function signatures looked for, per function check. A find names
 *  the one matched; the list is what 'not_found' means. */
export const FUNCTION_FAMILIES = {
  pause: ['pause()', 'unpause()'],
  freeze: [
    'blacklist(address)',
    'unBlacklist(address)',
    'addBlackList(address)',
    'addToBlacklist(address)',
    'addToBlockedList(address)',
    'freeze(address)',
    'freezeAccount(address)',
    'freeze(address,bool)',
    'setFrozen(address,bool)',
    'isBlacklisted(address)',
    'isBlackListed(address)',
    'isFrozen(address)',
    'isBlocked(address)',
  ],
  admin_transfer: [
    'forceTransfer(address,address,uint256)',
    'clawback(address,uint256)',
    'clawback(address,address,uint256)',
    'destroyBlackFunds(address)',
    'wipeFrozenAddress(address)',
    'seize(address,address,uint256)',
    'adminTransfer(address,address,uint256)',
    'controllerTransfer(address,address,uint256,bytes,bytes)',
    'controllerRedeem(address,uint256,bytes,bytes)',
  ],
} as const satisfies Record<'pause' | 'freeze' | 'admin_transfer', readonly string[]>;
type FunctionCheck = keyof typeof FUNCTION_FAMILIES;
const FUNCTION_CHECKS = Object.keys(FUNCTION_FAMILIES) as FunctionCheck[];

const SELECTOR_NAMES: ReadonlyMap<string, { check: FunctionCheck; name: string }> = new Map(
  FUNCTION_CHECKS.flatMap((check) => FUNCTION_FAMILIES[check].map((name) => [toFunctionSelector(name), { check, name }] as const)),
);

const ABI: Abi = [
  { type: 'function', name: 'proxiableUUID', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'facetAddresses', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getOwner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'locked', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getTransferValidator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
  {
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    outputs: [],
  },
];

const ZERO = '0x0000000000000000000000000000000000000000';

// ─── Pure helpers ─────────────────────────────────────────────────────

/** The address in a storage word's low 20 bytes; null when zero. */
export function slotAddress(word: Hex): Address | null {
  const hex = word.slice(2).padStart(64, '0');
  const a = `0x${hex.slice(-40)}`.toLowerCase() as Address;
  return BigInt(a) === 0n ? null : a;
}

/** The target of an EIP-1167 minimal proxy, or null. */
export function minimalProxyTarget(code: Hex): Address | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(code.toLowerCase());
  return m === null ? null : (`0x${m[1]}` as Address);
}

/** The PUSH4 values in the code, read by walking the opcodes so push data is
 *  never taken for an instruction, and whether a DELEGATECALL appears. */
export function scanCode(code: Hex): { push4: Set<string>; delegatecall: boolean } {
  const b = code.slice(2).toLowerCase();
  const push4 = new Set<string>();
  let delegatecall = false;
  for (let i = 0; i < b.length; i += 2) {
    const op = parseInt(b.slice(i, i + 2), 16);
    if (op === 0xf4) delegatecall = true;
    else if (op >= 0x60 && op <= 0x7f) {
      if (op === 0x63) push4.add(`0x${b.slice(i + 2, i + 10)}`);
      i += (op - 0x5f) * 2;
    }
  }
  return { push4, delegatecall };
}

/** The first matched signature per function check. */
export function functionsIn(push4: ReadonlySet<string>): Partial<Record<FunctionCheck, { selector: string; name: string }>> {
  const out: Partial<Record<FunctionCheck, { selector: string; name: string }>> = {};
  for (const s of push4) {
    const hit = SELECTOR_NAMES.get(s);
    if (hit !== undefined && out[hit.check] === undefined) out[hit.check] = { selector: s, name: hit.name };
  }
  return out;
}

const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 297)}...` : s);

// ─── Reads ────────────────────────────────────────────────────────────

type Unread = { ok: false; absent: false; why: string };
type Read<T> = { ok: true; value: T } | { ok: false; absent: true; reason: string | null } | Unread;
/** A raw read (code or storage): answered, or unread. */
type RawRead<T> = { ok: true; value: T } | Unread;

/** viem's one-line summary, else a bounded description that never carries
 *  the raw message (an RPC URL in it can carry an API key). */
const why = (err: unknown): string => {
  const m = (err as { shortMessage?: unknown } | null)?.shortMessage;
  return (typeof m === 'string' && m.length > 0 ? m : describeFailure(err)).slice(0, 80);
};

/** A view read: returned and decoded, absent (a revert, or no data back),
 *  or unread (the RPC did not answer). */
async function view<T>(c: IssuerReadClient, to: Address, functionName: string, args: readonly unknown[] = []): Promise<Read<T>> {
  let out: CallOutcome;
  try {
    out = await c.call({ to, data: encodeFunctionData({ abi: ABI, functionName, args } as never) });
  } catch (err) {
    return { ok: false, absent: false, why: why(err) };
  }
  if (out.kind === 'reverted') return { ok: false, absent: true, reason: out.reason };
  if (out.data === '0x') return { ok: false, absent: true, reason: null };
  try {
    return { ok: true, value: decodeFunctionResult({ abi: ABI, functionName, data: out.data } as never) as T };
  } catch {
    // Data that does not decode as the answer is no such function.
    return { ok: false, absent: true, reason: null };
  }
}

async function readCode(c: IssuerReadClient, a: Address): Promise<RawRead<Hex>> {
  try {
    return { ok: true, value: await c.getCode(a) };
  } catch (err) {
    return { ok: false, absent: false, why: why(err) };
  }
}

async function readSlot(c: IssuerReadClient, a: Address, slot: Hex): Promise<RawRead<Address | null>> {
  try {
    return { ok: true, value: slotAddress(await c.getStorageAt(a, slot)) };
  } catch (err) {
    return { ok: false, absent: false, why: why(err) };
  }
}

/** What the asset is, from ERC-165: 'unknown' when it answers neither NFT
 *  interface and the read did not answer. An asset that answers no to both
 *  (or has no ERC-165) is taken for an ERC-20. */
export async function detectKind(c: IssuerReadClient, asset: Address): Promise<CheckedKind> {
  const n721 = await view<boolean>(c, asset, 'supportsInterface', [ERC721_INTERFACE_ID]);
  if (n721.ok && n721.value) return 'erc721';
  const n1155 = await view<boolean>(c, asset, 'supportsInterface', [ERC1155_INTERFACE_ID]);
  if (n1155.ok && n1155.value) return 'erc1155';
  if ((!n721.ok && !n721.absent) || (!n1155.ok && !n1155.absent)) return 'unknown';
  return 'erc20';
}

// ─── The check ────────────────────────────────────────────────────────

/** How the code is reached, as the check followed it. */
interface CodeView {
  /** Every code blob the check read: the asset's, and what it delegates to. */
  codes: Hex[];
  /** Whether the whole code was seen (condition 3). */
  whole: boolean;
  /** Why it was not, when it was not. */
  gap: string | null;
  upgradeable: CheckResult;
  /** Evidence for upgradeable_proxy. */
  proxyEvidence: string | null;
}

async function followCode(c: IssuerReadClient, asset: Address, code: Hex): Promise<CodeView> {
  const v: CodeView = { codes: [code], whole: true, gap: null, upgradeable: 'not_found', proxyEvidence: null };
  const own = scanCode(code);
  const minimal = minimalProxyTarget(code);
  const behind = async (impl: Address, label: string): Promise<void> => {
    const ic = await readCode(c, impl);
    if (ic.ok && ic.value !== '0x') v.codes.push(ic.value);
    else {
      v.whole = false;
      v.gap = ic.ok ? `the ${label} ${impl} holds no code` : `the ${label}'s code was not read (${ic.why})`;
    }
  };
  if (minimal !== null) {
    // EIP-1167: the target is in the code and cannot change.
    v.proxyEvidence = `minimal proxy to fixed code ${minimal}`;
    await behind(minimal, 'minimal proxy target');
    return v;
  }
  const [impl, beacon, admin, zos] = await Promise.all([
    readSlot(c, asset, EIP1967_IMPLEMENTATION_SLOT),
    readSlot(c, asset, EIP1967_BEACON_SLOT),
    readSlot(c, asset, EIP1967_ADMIN_SLOT),
    readSlot(c, asset, ZEPPELINOS_IMPLEMENTATION_SLOT),
  ]);
  const adminNote = admin.ok && admin.value !== null ? `; admin ${admin.value}` : '';
  if (impl.ok && impl.value !== null) {
    const uups = await view<Hex>(c, impl.value, 'proxiableUUID');
    const kind = uups.ok && uups.value.toLowerCase() === EIP1967_IMPLEMENTATION_SLOT ? 'EIP-1822 (UUPS)' : 'EIP-1967';
    v.upgradeable = 'found';
    v.proxyEvidence = `${kind} proxy; implementation ${impl.value}${adminNote}`;
    await behind(impl.value, 'implementation');
    return v;
  }
  if (beacon.ok && beacon.value !== null) {
    v.upgradeable = 'found';
    const bi = await view<Address>(c, beacon.value, 'implementation');
    if (bi.ok) {
      const a = (bi.value as string).toLowerCase() as Address;
      v.proxyEvidence = `beacon proxy; beacon ${beacon.value}; implementation ${a}${adminNote}`;
      await behind(a, 'implementation');
    } else {
      v.proxyEvidence = `beacon proxy; beacon ${beacon.value}${adminNote}`;
      v.whole = false;
      v.gap = `the beacon's implementation was not read`;
    }
    return v;
  }
  if (zos.ok && zos.value !== null) {
    v.upgradeable = 'found';
    v.proxyEvidence = `zeppelinos proxy; implementation ${zos.value}`;
    await behind(zos.value, 'implementation');
    return v;
  }
  const slotsUnread = !impl.ok || !beacon.ok || !zos.ok;
  // A pointer the slots do not hold: an `implementation()` answer, or a
  // diamond's loupe.
  const ia = await view<Address>(c, asset, 'implementation');
  if (ia.ok && (ia.value as string).toLowerCase() !== ZERO) {
    const a = (ia.value as string).toLowerCase() as Address;
    v.upgradeable = own.delegatecall ? 'found' : 'unknown';
    v.proxyEvidence = `answers implementation() with ${a}${adminNote}`;
    if (own.delegatecall) await behind(a, 'implementation');
    return v;
  }
  const fa = await view<readonly Address[]>(c, asset, 'facetAddresses');
  if (fa.ok && fa.value.length > 0) {
    v.upgradeable = 'found';
    v.proxyEvidence = `EIP-2535 diamond with ${fa.value.length} facets`;
    if (fa.value.length > MAX_FACETS) {
      v.whole = false;
      v.gap = `the diamond lists ${fa.value.length} facets, more than the ${MAX_FACETS} followed`;
      return v;
    }
    for (const f of fa.value) await behind((f as string).toLowerCase() as Address, 'facet');
    return v;
  }
  if (own.delegatecall) {
    // Code that delegates somewhere none of the rules above found.
    v.whole = false;
    v.gap = 'the code can delegate to code the checker could not find';
    v.upgradeable = 'unknown';
    v.proxyEvidence = v.gap;
    return v;
  }
  if (slotsUnread || (!ia.ok && !ia.absent) || (!fa.ok && !fa.absent)) {
    v.upgradeable = 'unknown';
    v.proxyEvidence = 'a proxy pointer read did not answer';
  }
  return v;
}

/**
 * Check one asset. `kind` is what the platform records for it ('unknown' to
 * detect it); `holding`, a unit a vault holds, for the vault transfer.
 * Never throws for a read the RPC did not answer: the findings it feeds are
 * 'unknown' and say why.
 */
export async function checkAsset(c: IssuerReadClient, asset: Address, kind: CheckedKind, holding: VaultHolding | null): Promise<AssetCheck> {
  const findings: Finding[] = [];
  const put = (check: IssuerCheckIdV2, result: CheckResult, evidence: string | null) =>
    findings.push({ check, result, evidence: evidence === null ? null : clip(evidence) });
  const done = (k: CheckedKind, detail: string | null): AssetCheck => {
    // Only the checks the shared list runs for this kind are written, and
    // the run is complete when each of them answered (the shared rule).
    const kept = findings.filter((f) => issuerCheckApplies(f.check, k) && issuerChecksRunFor(k).includes(f.check));
    const unknown = kept.filter((f) => f.result === 'unknown').map((f) => f.check);
    const d = detail ?? (unknown.length > 0 ? `unknown: ${unknown.join(', ')}` : null);
    const complete = detail === null && issuerRunComplete(k, new Map(kept.map((f) => [f.check, f.result])));
    return { kind: k, complete, detail: d === null ? null : clip(d), findings: kept };
  };

  const code = await readCode(c, asset);
  if (!code.ok) return done(kind, `the asset's code was not read (${code.why})`);
  if (code.value === '0x') return done(kind, 'the address holds no code');
  const k = kind === 'unknown' ? await detectKind(c, asset) : kind;

  // Upgradeability and the functions behind the code.
  const cv = await followCode(c, asset, code.value);
  const owner = await view<Address>(c, asset, 'owner');
  const ownerNote = owner.ok && (owner.value as string).toLowerCase() !== ZERO ? `; owner ${(owner.value as string).toLowerCase()}` : '';
  put('upgradeable_proxy', cv.upgradeable, cv.proxyEvidence === null ? null : `${cv.proxyEvidence}${ownerNote}`);
  const push4 = new Set<string>();
  for (const blob of cv.codes) for (const s of scanCode(blob).push4) push4.add(s);
  const hits = functionsIn(push4);
  for (const check of FUNCTION_CHECKS) {
    const hit = hits[check];
    if (hit !== undefined) put(check, 'found', `the code has ${hit.name} (selector ${hit.selector})${ownerNote}`);
    else if (cv.whole) put(check, 'not_found', null);
    else put(check, 'unknown', cv.gap);
  }

  // Paused at this block.
  const paused = await view<boolean>(c, asset, 'paused');
  if (paused.ok) put('paused_now', paused.value ? 'found' : 'not_found', paused.value ? 'paused() reads true' : 'paused() reads false');
  else if (paused.absent) put('paused_now', 'not_found', 'no paused() answer');
  else put('paused_now', 'unknown', `paused() did not answer (${paused.why})`);

  // NFT markers.
  if (k === 'erc721' || k === 'erc1155') {
    const tv = await view<Address>(c, asset, 'getTransferValidator');
    if (tv.ok) {
      const a = (tv.value as string).toLowerCase();
      put('transfer_validator', a === ZERO ? 'not_found' : 'found', a === ZERO ? 'getTransferValidator() reads zero' : `transfer validator ${a}`);
    } else if (tv.absent) put('transfer_validator', 'not_found', null);
    else put('transfer_validator', 'unknown', `getTransferValidator() did not answer (${tv.why})`);
    const sb = await view<boolean>(c, asset, 'supportsInterface', [ERC5192_INTERFACE_ID]);
    const lk = holding === null ? null : await view<boolean>(c, asset, 'locked', [holding.tokenId]);
    if ((sb.ok && sb.value) || (lk?.ok && lk.value)) {
      put('soulbound', 'found', sb.ok && sb.value ? 'declares ERC-5192 (soulbound)' : `locked(${holding!.tokenId}) reads true`);
    } else if (sb.ok || sb.absent) put('soulbound', 'not_found', null);
    else put('soulbound', 'unknown', `ERC-5192 support did not answer (${sb.why})`);
  }

  // A vault-to-vault move, called as the holding vault.
  if (holding === null) put('vault_transfer', 'unknown', 'no vault holds a unit of it');
  else {
    const data =
      k === 'erc721'
        ? encodeFunctionData({ abi: ABI, functionName: 'transferFrom', args: [holding.holder, holding.to, holding.tokenId] })
        : k === 'erc1155'
          ? encodeFunctionData({ abi: ABI, functionName: 'safeTransferFrom', args: [holding.holder, holding.to, holding.tokenId, 1n, '0x'] })
          : encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [holding.to, 1n] });
    try {
      const out = await c.call({ to: asset, data, from: holding.holder });
      // An ERC-20 that answers false refused the move as surely as a revert.
      const refusedFalse = k === 'erc20' && out.kind === 'returned' && out.data !== '0x' && BigInt(out.data) === 0n;
      if (out.kind === 'reverted' || refusedFalse) {
        const r = out.kind === 'reverted' ? (out.reason ?? 'no reason given') : 'returned false';
        put('vault_transfer', 'found', `the move from vault ${holding.holder} to vault ${holding.to} was refused: ${r}`);
      } else put('vault_transfer', 'not_found', `the move from vault ${holding.holder} to vault ${holding.to} went through`);
    } catch (err) {
      put('vault_transfer', 'unknown', `the simulation did not answer (${why(err)})`);
    }
  }

  // conduit_transfer (the marketplace conduit the collateral sale uses) is not
  // run by checker version 2: no row carries it, and the shared list names it
  // as not run, so readers show it as not checked (design ruling 2026-11-21).

  return done(k, null);
}
