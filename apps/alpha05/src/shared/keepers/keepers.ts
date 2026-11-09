/**
 * ACC-34 — the wallet's keeper permissions on this network: the master
 * switch, the keepers it approved (at most five) and the actions each may
 * drive, read in one block, and the one change a step sends.
 *
 * Nothing acts until the wallet turns the master switch on. A loan step
 * (`requireKeeperFor`) also needs the loan or offer itself to name the keeper
 * (set where the loan or offer is shown); an account step
 * (`requireKeeperForPrincipal`: the signed fill, the auto-roll and the lock)
 * needs only the switch and the action, so the receipt says so. Which keeper
 * this app runs on a network is the deployment record's, never a guess.
 */
import { getAddress, type Abi, type PublicClient } from 'viem';
import { ProfileFacetABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { CopyKey } from '../copy/useCopy';

type Hex = `0x${string}`;

export const PROFILE_ABI = ProfileFacetABI as Abi;

/** `LibVaipakam.MAX_APPROVED_KEEPERS`. */
export const MAX_KEEPERS = 5;

/** Whose side an action drives. */
export type ActionSide = 'lender' | 'borrower' | 'account';

/** Where an action reaches: `loan` only on a loan or offer that names the
 *  keeper, `account` across the wallet once the switch is on. */
export type ActionScope = 'loan' | 'account';

/** Every action bit the protocol defines (`KEEPER_ACTION_*`), in bit order,
 *  with whose side it drives, where it reaches and the line that explains
 *  it. Bit 4 was retired by the protocol and granting it is refused, so it
 *  is not here. */
export const KEEPER_ACTIONS: readonly { bit: number; side: ActionSide; scope: ActionScope; key: CopyKey }[] = [
  { bit: 1 << 0, side: 'lender', scope: 'loan', key: 'keepers.actCompleteSale' },
  { bit: 1 << 1, side: 'borrower', scope: 'loan', key: 'keepers.actCompleteOffset' },
  { bit: 1 << 2, side: 'lender', scope: 'loan', key: 'keepers.actStartSale' },
  { bit: 1 << 3, side: 'borrower', scope: 'loan', key: 'keepers.actStartPreclose' },
  // The protocol checks this bit on the borrower side only; the lender
  // consents to an extension through its own per-loan limits instead.
  { bit: 1 << 5, side: 'borrower', scope: 'loan', key: 'keepers.actExtend' },
  { bit: 1 << 6, side: 'lender', scope: 'account', key: 'keepers.actSignedFill' },
  { bit: 1 << 7, side: 'lender', scope: 'account', key: 'keepers.actAutoRoll' },
  { bit: 1 << 8, side: 'account', scope: 'account', key: 'keepers.actLock' },
];

/** The bits that reach across the account without a loan naming the keeper. */
export const ACCOUNT_ACTIONS = KEEPER_ACTIONS.filter((a) => a.scope === 'account').reduce((m, a) => m | a.bit, 0);

/** `KEEPER_ACTION_ALL`: every defined bit. */
export const ALL_ACTIONS = KEEPER_ACTIONS.reduce((m, a) => m | a.bit, 0);

export interface KeeperGrant {
  keeper: Hex;
  actions: number;
}

export interface KeeperSettings {
  access: boolean;
  keepers: KeeperGrant[];
  blockNumber: bigint;
}

export async function readKeeperSettings(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<KeeperSettings> {
  const block = blockNumber ?? (await c.getBlockNumber({ cacheTime: 0 }));
  const at = { blockNumber: block };
  const read = <T>(functionName: string, args: readonly unknown[]) => c.readContract({ address: diamond, abi: PROFILE_ABI, functionName, args, ...at }) as Promise<T>;
  const [access, list] = await Promise.all([read<boolean>('getKeeperAccess', [account]), read<readonly Hex[]>('getApprovedKeepers', [account])]);
  const keepers = await Promise.all(list.map(async (k) => ({ keeper: getAddress(k), actions: Number(await read<number>('getKeeperActions', [account, k])) })));
  return { access, keepers, blockNumber: block };
}

/** The keeper this app runs on `chainId`, from the deployment record; null
 *  where the record names none. */
export function networkKeeper(chainId: number): Hex | null {
  const k = (getDeployment(chainId) as { keeperAddress?: unknown } | undefined)?.keeperAddress;
  return typeof k === 'string' && /^0x[0-9a-fA-F]{40}$/.test(k) ? getAddress(k) : null;
}

/** The change a step sends. */
export type KeeperChange =
  | { kind: 'access'; on: boolean }
  | { kind: 'approve'; keeper: Hex; actions: number }
  | { kind: 'actions'; keeper: Hex; actions: number }
  | { kind: 'revoke'; keeper: Hex };

export function changeCall(c: KeeperChange): { functionName: string; args: readonly unknown[] } {
  switch (c.kind) {
    case 'access':
      return { functionName: 'setKeeperAccess', args: [c.on] };
    case 'approve':
      return { functionName: 'approveKeeper', args: [c.keeper, c.actions] };
    case 'actions':
      return { functionName: 'setKeeperActions', args: [c.keeper, c.actions] };
    case 'revoke':
      return { functionName: 'revokeKeeper', args: [c.keeper] };
  }
}

export const CHANGE_SIGNATURES: Readonly<Record<KeeperChange['kind'], string>> = {
  access: 'setKeeperAccess(bool)',
  approve: 'approveKeeper(address,uint16)',
  actions: 'setKeeperActions(address,uint16)',
  revoke: 'revokeKeeper(address)',
};

function grantOf(s: KeeperSettings, keeper: Hex): KeeperGrant | null {
  return s.keepers.find((k) => k.keeper.toLowerCase() === keeper.toLowerCase()) ?? null;
}

/** Whether a change gives a keeper more than it has now: switching access
 *  on, a new keeper, or an action it did not hold. Only such a change asks
 *  for the Terms; taking a permission away never does. */
export function widens(c: KeeperChange, s: KeeperSettings): boolean {
  if (c.kind === 'access') return c.on;
  if (c.kind === 'approve') return true;
  if (c.kind === 'revoke') return false;
  const held = grantOf(s, c.keeper)?.actions ?? 0;
  return (c.actions & ~held) !== 0;
}

/** Why a change cannot be sent on `s`, as a copy key; null when it can. */
export function changeRefusal(c: KeeperChange, s: KeeperSettings): CopyKey | null {
  switch (c.kind) {
    case 'access':
      return s.access === c.on ? 'keepers.already' : null;
    case 'approve':
      if (c.actions === 0 || (c.actions & ~ALL_ACTIONS) !== 0) return 'keepers.pickAction';
      if (grantOf(s, c.keeper)) return 'keepers.alreadyApproved';
      return s.keepers.length >= MAX_KEEPERS ? 'keepers.full' : null;
    case 'actions': {
      const g = grantOf(s, c.keeper);
      if (!g) return 'keepers.notApproved';
      if (c.actions === 0 || (c.actions & ~ALL_ACTIONS) !== 0) return 'keepers.pickAction';
      return g.actions === c.actions ? 'keepers.already' : null;
    }
    case 'revoke':
      return grantOf(s, c.keeper) ? null : 'keepers.notApproved';
  }
}

/** Whether a re-read moved anything the change's receipt states. */
export function changeMoved(c: KeeperChange, a: KeeperSettings, b: KeeperSettings): boolean {
  if (a.access !== b.access) return true;
  if (c.kind === 'access') return false;
  if (c.kind === 'approve' && a.keepers.length !== b.keepers.length) return true;
  return (grantOf(a, c.keeper)?.actions ?? 0) !== (grantOf(b, c.keeper)?.actions ?? 0);
}

/** The actions a mask holds, in bit order. */
export function actionsIn(mask: number): (typeof KEEPER_ACTIONS)[number][] {
  return KEEPER_ACTIONS.filter((a) => (mask & a.bit) !== 0);
}

/** Whether the change's effect reads back at `after`. */
export function changeLanded(c: KeeperChange, after: KeeperSettings): boolean {
  switch (c.kind) {
    case 'access':
      return after.access === c.on;
    case 'approve':
    case 'actions':
      return grantOf(after, c.keeper)?.actions === c.actions;
    case 'revoke':
      return grantOf(after, c.keeper) === null;
  }
}
