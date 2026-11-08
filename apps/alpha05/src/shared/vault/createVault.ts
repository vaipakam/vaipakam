/**
 * ACC-20 — create the wallet's own vault, on its own (a deposit or a first
 * offer also creates it, inside that flow). What the review stands on is read
 * at one block through the wallet's connection: whether a vault already
 * exists, the wallet's standing with the sanctions screen, and the protocol's
 * own dry run. The outcome is the vault address the transaction's record
 * names, never assumed from the call.
 *
 * Nothing moves and no approval is asked: the call only deploys the vault
 * contract the protocol keeps for this wallet alone.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import type { Receipt, ReceiptRow, ReceiptText } from '../receipt/types';
import { frozenState, isFrozenRefusal, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import { askThrough } from '../tx/simulate';
import type { LegOutcome } from '../tx/outcome';
import { shortAddress } from '../ui/format';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const FACTORY = VaultFactoryFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

export interface CreateVaultReview {
  identity: string;
  /** The wallet's vault at the review's block; null when it has none. */
  existing: Hex | null;
  frozen: FrozenState;
  /** The protocol's dry run: null when it passes, its refusal when it
   *  refuses, 'unread' when it could not be run. Not asked once a vault
   *  exists. */
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

/** The call the review stands for: a vault for the connected wallet. */
export function createVaultCall(account: Hex) {
  return { abi: FACTORY, functionName: 'getOrCreateUserVault' as const, args: [account] as const };
}

export async function readCreateVaultReview(own: OwnStateClient, diamond: Hex, identity: string): Promise<CreateVaultReview> {
  const wallet = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const [vault, posture] = await Promise.all([
        c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [wallet], blockNumber: block }) as Promise<Hex>,
        readSanctionsPosture(c, diamond, wallet, block),
      ]);
      return { existing: vault.toLowerCase() === ZERO ? null : vault, frozen: frozenState(posture) };
    })
    .then((x) => x.value);
  let dryRun: CreateVaultReview['dryRun'] = null;
  if (facts.existing === null) {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...createVaultCall(wallet), account: wallet }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return { identity, existing: facts.existing, frozen: facts.frozen, dryRun, readAt: Date.now() };
}

/** What a re-read found changed, in words, or null. */
export function createVaultChanged(a: CreateVaultReview, b: CreateVaultReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if ((a.existing ?? '').toLowerCase() !== (b.existing ?? '').toLowerCase()) return copy.text('vault.changedExists');
  if (a.frozen !== b.frozen) return copy.text('repay.changedVerdict');
  const code = (d: CreateVaultReview['dryRun']) => (d === null ? 'ok' : d === 'unread' ? 'unread' : d.code);
  if (code(a.dryRun) !== code(b.dryRun)) return copy.text('repay.changedVerdict');
  return null;
}

/** What stops the review, in words (empty when nothing does). The screen is
 *  stated first when it flags the wallet: the protocol creates no vault for
 *  a flagged wallet. */
export function createVaultBlockers(r: CreateVaultReview, copy: Copy): string[] {
  if (r.existing !== null) return [copy.text('vault.alreadyExists')];
  if (r.frozen === 'flagged') return [copy.text('vault.createFlagged')];
  if (r.dryRun === 'unread') return [copy.text('vault.dryRunUnread')];
  if (r.dryRun !== null && isFrozenRefusal(r.dryRun)) return [copy.text(r.dryRun.code === 'SanctionsOracleUnavailable' ? 'vault.createOutage' : 'vault.createFlagged')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

export function createVaultReceipt(account: Hex, copy: Copy, readAt: number): Receipt {
  const { text } = copy;
  const rows: ReceiptRow[] = [
    { label: text('vault.rowOwner'), value: { kind: 'text', text: account }, binding: true },
    { label: text('vault.rowMoves'), value: { kind: 'text', text: text('vault.rowMovesNothing') }, binding: true },
  ];
  const consequences: ReceiptText[] = [text('vault.afterOwn'), text('vault.afterAuto')];
  return { title: text('vault.createTitle'), rows, consequences, prompts: 1, readAt };
}

/** The vault the transaction's record says it created for `account`; null
 *  when it names none. */
export function createdVault(logs: readonly Log[], diamond: Hex, account: Hex): Hex | null {
  const events = parseEventLogs({ abi: FACTORY, logs: logs as Log[], eventName: 'UserVaultCreated', strict: false });
  for (const e of events) {
    if (e.address.toLowerCase() !== diamond.toLowerCase()) continue;
    const args = e.args as { user?: Hex; proxy?: Hex };
    if (args.user?.toLowerCase() === account.toLowerCase() && args.proxy) return args.proxy;
  }
  return null;
}

/** RB-CONFIDENCE — the finish card: the vault the record names, or that it
 *  names none (a vault created by another transaction first, in which case
 *  the page's next read shows it). */
export function measureCreateVault(logs: readonly Log[], diamond: Hex, account: Hex, copy: Copy): LegOutcome[] {
  const vault = createdVault(logs, diamond, account);
  if (vault === null) return [{ status: 'not-done', label: copy.text('vault.createTitle'), reason: copy.text('vault.notCreated') }];
  return [{ status: 'done', label: copy.format('vault.legCreated', { vault: shortAddress(vault) }) }];
}
