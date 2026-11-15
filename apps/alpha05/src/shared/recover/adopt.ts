/**
 * ACC-24, ACC-25, ACC-26, NFT-33 — an asset that reached the wallet's own
 * vault outside the protocol (a plain transfer, a mint that skipped the
 * vault's hooks) is not counted as the wallet's, so it raises nothing and
 * cannot be withdrawn. The owner can adopt it: declare where it came from,
 * sign the protocol's acknowledgement, and have it credited to the counted
 * holding (`VaultDepositoryFacet.adoptUntracked`). Nothing moves: the asset
 * is already in the vault, and it leaves later only through an ordinary
 * withdrawal (with protected mode's delay where the account runs it). Or
 * the owner can disown it (`disownUntracked`), a public record that it is
 * not claimed, which moves and credits nothing.
 *
 * What the adoption stands on, read through the wallet's connection at one
 * block: the wallet's vault, the protocol's figure for what of this asset
 * sits there uncounted (`untrackedHolding`), whether an earlier adoption's
 * declared source barred the vault (`vaultBannedSource`), the wallet's own
 * standing with the sanctions screen, whether a replacement retired the
 * wallet (a replaced wallet lost every right over its account, adoption
 * included, while it may still disown), the account's code (the protocol
 * recovers the signer with plain ECDSA, so a contract account cannot sign
 * the acknowledgement; a person's own account, delegated or not, can), the
 * protocol pause (adoption is closed while paused; disowning is not), the
 * sanctions screen itself, and whether the acknowledgement the protocol
 * binds is the text this app shows.
 *
 * The declared source is screened the way the protocol screens it, by the
 * screen's own `isSanctioned`, and fail-closed: no screen set, or a screen
 * that cannot answer, refuses the adoption. A source the screen flags makes
 * the adoption credit nothing and bar the vault until the source is
 * de-listed (the protocol records it rather than reverting, so the bar
 * holds). The app states that and does not send such an adoption; if the
 * screen flags the source only after the review, the transaction's record
 * says which happened.
 */
import { parseAbi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, ProfileFacetABI, VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { isEoaStyle } from '../claims/rewards';
import { ASSET_TYPE } from '../nft/nft';
import { readProtection, type Protection } from '../protection/payout';
import { answerOrNull } from '../reads/answer';
import { frozenState, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import { ADOPTION_ACK_HASH, adoptAmount, subjectTokenId, type AdoptDraft, type RecoverSubject } from './adoption';

export * from './adoption';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const PROFILE = ProfileFacetABI as Abi;
const SCREEN = parseAbi(['function isSanctioned(address addr) view returns (bool)']);
const ZERO = '0x0000000000000000000000000000000000000000';

/** How the sanctions screen answers for an address: no screen set, the
 *  screen cannot answer, or its answer; null when unread. */
export type ScreenRead = 'unset' | 'unavailable' | 'flagged' | 'clean';

/** The facts the page and both actions stand on, at one block. */
export interface RecoverFacts {
  subject: RecoverSubject;
  block: bigint;
  /** The wallet's vault; null when it has none. */
  vault: Hex | null;
  /** The protocol's figure for what of this asset sits in the vault
   *  uncounted; null when unread. */
  untracked: bigint | null;
  /** The source an earlier adoption declared that barred this vault; null
   *  when none; 'unread' when the view gave no answer. */
  bannedSource: Hex | null | 'unread';
  frozen: FrozenState;
  /** The account's protected mode (whether a replacement retired it, and
   *  whether the mode is on); null when unread. */
  protection: Protection | null;
  /** Whether the wallet is a person's own account (no code, or an EIP-7702
   *  delegation), which can sign the acknowledgement; null when unread. */
  eoaStyle: boolean | null;
  /** The protocol pause; null when unread. */
  paused: boolean | null;
  /** Whether a sanctions screen is set on this network; null when unread. */
  screenSet: boolean | null;
  /** Whether the acknowledgement the protocol binds is this app's text;
   *  null when unread. */
  ackMatches: boolean | null;
  /** The wallet's next adoption nonce; null when unread. */
  nonce: bigint | null;
  readAt: number;
}

export async function readRecoverFacts(c: PublicClient, diamond: Hex, account: Hex, subject: RecoverSubject): Promise<RecoverFacts> {
  const block = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const kind = ASSET_TYPE[subject.standard];
  const id = subjectTokenId(subject);
  const [vault, untracked, banned, posture, protection, code, paused, oracle, ackHash, nonce] = await Promise.all([
    c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at }) as Promise<Hex>,
    read<bigint>(DEPOSITORY, 'untrackedHolding', [account, kind, subject.asset, id]),
    read<Hex>(DEPOSITORY, 'vaultBannedSource', [account]),
    readSanctionsPosture(c, diamond, account, block),
    readProtection(c, diamond, account, block),
    c.getCode({ address: account, blockNumber: block }),
    read<boolean>(ADMIN, 'paused'),
    read<Hex>(PROFILE, 'getSanctionsOracle'),
    read<Hex>(DEPOSITORY, 'adoptionAckTextHash'),
    read<bigint>(DEPOSITORY, 'adoptionNonce', [account]),
  ]);
  return {
    subject,
    block,
    vault: vault.toLowerCase() === ZERO ? null : vault,
    untracked,
    bannedSource: banned === null ? 'unread' : banned.toLowerCase() === ZERO ? null : banned,
    frozen: frozenState(posture),
    protection,
    eoaStyle: isEoaStyle(code),
    paused,
    screenSet: oracle === null ? null : oracle.toLowerCase() !== ZERO,
    ackMatches: ackHash === null ? null : ackHash.toLowerCase() === ADOPTION_ACK_HASH.toLowerCase(),
    nonce,
    readAt: Date.now(),
  };
}

/** The screen's answer for `source` at `block`, asked the way the protocol
 *  asks it: the screen's own `isSanctioned`, with no screen set or a screen
 *  that reverts both refusing. A source that fails to answer at all is
 *  thrown, so the own rail tries its next one. */
export async function readSourceScreen(c: PublicClient, diamond: Hex, source: Hex, block?: bigint): Promise<ScreenRead> {
  const at = block === undefined ? {} : { blockNumber: block };
  const oracle = await answerOrNull(c.readContract({ address: diamond, abi: PROFILE, functionName: 'getSanctionsOracle', ...at }) as Promise<Hex>);
  if (oracle === null) return 'unavailable';
  if (oracle.toLowerCase() === ZERO) return 'unset';
  const flagged = await answerOrNull(c.readContract({ address: oracle, abi: SCREEN, functionName: 'isSanctioned', args: [source], ...at }) as Promise<boolean>);
  if (flagged === null) return 'unavailable';
  return flagged ? 'flagged' : 'clean';
}

/** Whether the wallet's vault is barred by an earlier adoption's source. */
export const isBarred = (f: Pick<RecoverFacts, 'bannedSource'>): boolean => f.bannedSource !== null && f.bannedSource !== 'unread';

/** What stops this wallet adopting this asset, in words, most fundamental
 *  first (empty when nothing the page reads does). The amount and the
 *  declared source are the review's, not the page's. */
export function adoptStops(f: RecoverFacts, copy: Copy): string[] {
  const { text } = copy;
  if (f.vault === null) return [text('recover.noVault')];
  if (f.protection === null) return [text('recover.modeUnread')];
  if (f.protection.retired) return [text('recover.retired')];
  if (f.eoaStyle === false) return [text('recover.contractAccount')];
  if (f.bannedSource === 'unread') return [text('recover.banUnread')];
  if (isBarred(f)) return [text('recover.barred')];
  if (f.frozen === 'flagged') return [text('recover.flagged')];
  if (f.frozen === 'unknown' || f.frozen === 'outage') return [text('recover.selfScreenUnread')];
  if (f.screenSet === false) return [text('recover.screenUnset')];
  if (f.screenSet === null) return [text('recover.screenUnread')];
  if (f.paused === null) return [text('recover.pauseUnread')];
  if (f.paused) return [text('recover.paused')];
  if (f.ackMatches === null) return [text('recover.ackUnread')];
  if (!f.ackMatches) return [text('recover.ackMismatch')];
  if (f.untracked === null) return [text('recover.untrackedUnread')];
  if (f.untracked === 0n) return [text(f.subject.standard === 'erc721' ? 'recover.nftNotUntracked' : 'recover.nothingUntracked')];
  if (f.nonce === null) return [text('recover.nonceUnread')];
  return [];
}

/** What stops this wallet disowning this asset (empty when nothing does).
 *  Disowning needs only a vault: a replaced wallet and a barred vault may
 *  still disown. */
export function disownStops(f: RecoverFacts, copy: Copy): string[] {
  const { text } = copy;
  if (f.vault === null) return [text('recover.noVault')];
  if (f.untracked === null) return [text('recover.untrackedUnread')];
  if (f.untracked === 0n) return [text(f.subject.standard === 'erc721' ? 'recover.nftNotUntracked' : 'recover.nothingUntracked')];
  return [];
}

export interface AdoptReview {
  identity: string;
  draft: AdoptDraft;
  facts: RecoverFacts;
  /** The screen's answer for the declared source, at the facts' block. */
  sourceScreen: ScreenRead;
  readAt: number;
}

export async function readAdoptReview(own: OwnStateClient, diamond: Hex, draft: AdoptDraft, identity: string): Promise<AdoptReview> {
  const { facts, sourceScreen } = await own
    .read(async (c: PublicClient) => {
      const facts = await readRecoverFacts(c, diamond, own.account, draft.subject);
      const sourceScreen = await readSourceScreen(c, diamond, draft.source, facts.block);
      return { facts, sourceScreen };
    })
    .then((x) => x.value);
  return { identity, draft, facts, sourceScreen, readAt: facts.readAt };
}

/** What stops the review, in words (empty when nothing does). */
export function adoptBlockers(r: AdoptReview, copy: Copy, amountText: (v: bigint) => string): string[] {
  const { text, format } = copy;
  const stops = adoptStops(r.facts, copy);
  if (stops.length > 0) return stops;
  const want = adoptAmount(r.draft);
  if (r.facts.untracked !== null && want > r.facts.untracked) return [format('recover.overUntracked', { untracked: amountText(r.facts.untracked) })];
  if (r.sourceScreen === 'unset') return [text('recover.screenUnset')];
  if (r.sourceScreen === 'unavailable') return [text('recover.sourceUnavailable')];
  if (r.sourceScreen === 'flagged') return [text('recover.sourceFlagged')];
  return [];
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function adoptChanged(a: AdoptReview, b: AdoptReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const fa = a.facts;
  const fb = b.facts;
  if ((fa.vault ?? '').toLowerCase() !== (fb.vault ?? '').toLowerCase()) return text('vaultWithdraw.changedVault');
  if (fa.untracked !== fb.untracked) return text('recover.changedUntracked');
  if (a.sourceScreen !== b.sourceScreen) return text('recover.changedScreen');
  const stopped = (r: AdoptReview) => adoptStops(r.facts, { text, format: () => '' }).join('|');
  if (stopped(a) !== stopped(b)) return text('repay.changedVerdict');
  if ((fa.protection?.enabled ?? null) !== (fb.protection?.enabled ?? null)) return text('payout.changed');
  return null;
}

/** The call an adoption sends, with the wallet's signature. */
export function adoptCall(d: AdoptDraft, deadline: bigint, signature: Hex) {
  return {
    abi: DEPOSITORY,
    functionName: 'adoptUntracked' as const,
    args: [ASSET_TYPE[d.subject.standard], d.subject.asset, subjectTokenId(d.subject), adoptAmount(d), d.source, deadline, signature] as const,
  };
}

/** The call a disowning sends. */
export function disownCall(s: RecoverSubject) {
  return { abi: DEPOSITORY, functionName: 'disownUntracked' as const, args: [ASSET_TYPE[s.standard], s.asset, subjectTokenId(s)] as const };
}

/** What the transaction's record says an adoption did for `account` and
 *  this asset: credited (with the amount), barred the vault (with the
 *  source), or neither. */
export type AdoptRecord = { kind: 'adopted'; amount: bigint; source: Hex } | { kind: 'barred'; source: Hex } | { kind: 'none' };

export function adoptRecorded(logs: readonly Log[], diamond: Hex, account: Hex, s: RecoverSubject): AdoptRecord {
  const ours = (e: { address: string; args: unknown }) => {
    const a = e.args as { account?: Hex; asset?: Hex; tokenId?: bigint };
    return (
      e.address.toLowerCase() === diamond.toLowerCase() &&
      a.account?.toLowerCase() === account.toLowerCase() &&
      a.asset?.toLowerCase() === s.asset.toLowerCase() &&
      a.tokenId === subjectTokenId(s)
    );
  };
  for (const e of parseEventLogs({ abi: DEPOSITORY, logs: logs as Log[], eventName: 'VaultBannedFromAdoption', strict: false })) {
    const a = e.args as { declaredSource?: Hex };
    if (ours(e) && a.declaredSource) return { kind: 'barred', source: a.declaredSource };
  }
  for (const e of parseEventLogs({ abi: DEPOSITORY, logs: logs as Log[], eventName: 'UntrackedAdopted', strict: false })) {
    const a = e.args as { kind?: number | bigint; amount?: bigint; declaredSource?: Hex };
    if (ours(e) && Number(a.kind) === ASSET_TYPE[s.standard] && a.amount !== undefined && a.declaredSource)
      return { kind: 'adopted', amount: a.amount, source: a.declaredSource };
  }
  return { kind: 'none' };
}

/** What the transaction's record says a disowning observed: the amount it
 *  recorded as disowned, or null when it records none for this asset. */
export function disownRecorded(logs: readonly Log[], diamond: Hex, account: Hex, s: RecoverSubject): bigint | null {
  for (const e of parseEventLogs({ abi: DEPOSITORY, logs: logs as Log[], eventName: 'UntrackedDisowned', strict: false })) {
    const a = e.args as { account?: Hex; asset?: Hex; tokenId?: bigint; observedAmount?: bigint };
    if (e.address.toLowerCase() !== diamond.toLowerCase()) continue;
    if (a.account?.toLowerCase() !== account.toLowerCase() || a.asset?.toLowerCase() !== s.asset.toLowerCase()) continue;
    if (a.tokenId !== subjectTokenId(s)) continue;
    if (a.observedAmount !== undefined) return a.observedAmount;
  }
  return null;
}
