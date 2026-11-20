/**
 * #3773 — what the app says about a kit hand-off: what the link asks for,
 * the integrator it names and the registry's answer for it, and the line a
 * review carries for the integrator signed into the terms. The registry and
 * the share are read from the chain the link names; a failed read is stated
 * as unread, never as "not registered" or "not paid".
 */
import type { KitRequest } from '@vaipakam/lend-kit';
import type { SupportedChain } from '../../chain/chains';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { useChainRead, type ChainRead } from '../reads/chainRead';
import { assetName, readTokenMeta, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';
import { readIntegratorEntry, readIntegratorShare, SHARE_RULE, type IntegratorEntry, type IntegratorShare, type ShareRefusal } from './kit';

type Hex = `0x${string}`;
type Format = CopyAccess['format'];

/** The link's request in words: "borrow against WETH #7", "lend 100 USDC". */
export function kitWhat(r: KitRequest, meta: TokenMetaMap | null, format: Format): string {
  const asset = assetName(r.asset, meta);
  if (r.action === 'lend') return format('kit.whatLend', { amount: tokenAmount(r.amount, r.asset, meta, format, true) });
  if (r.action === 'rent') return format('kit.whatRent', { asset, token: r.tokenId.toString() });
  if (r.tokenId !== undefined) return format('kit.whatBorrowToken', { asset, token: r.tokenId.toString() });
  return format('kit.whatBorrow', { asset });
}

/** The tokens the request names, read on the link's own network. */
export function useKitMeta(chain: SupportedChain | null, r: KitRequest | null): ChainRead<TokenMetaMap> {
  const addresses = r === null ? [] : [r.asset, ...(r.action === 'borrow' && r.lendingAsset ? [r.lendingAsset] : [])].map((a) => a.toLowerCase() as Hex);
  return useChainRead(['kitMeta', ...addresses], (c) => readTokenMeta(c, addresses), {
    immutable: true,
    enabled: chain !== null && addresses.length > 0,
    ...(chain ? { chain } : {}),
  });
}

/** The integrator's registry entry, read on the link's network. */
export function useIntegratorEntry(chain: SupportedChain | null, integrator: Hex | null): ChainRead<IntegratorEntry> {
  return useChainRead(['integratorEntry', integrator], (c, ch) => readIntegratorEntry(c, ch.diamondAddress, integrator!), {
    enabled: chain !== null && integrator !== null,
    ...(chain ? { chain } : {}),
  });
}

/** What the protocol would pay `integrator` on a loan `borrower` opens now. */
export function useIntegratorShare(chain: SupportedChain | null, integrator: Hex | null, borrower: Hex | null): ChainRead<IntegratorShare> {
  return useChainRead(['integratorShare', integrator, borrower], (c, ch) => readIntegratorShare(c, ch.diamondAddress, integrator!, borrower!), {
    enabled: chain !== null && integrator !== null && borrower !== null,
    ...(chain ? { chain } : {}),
  });
}

/** The integrator as a reader meets it: its registered name beside its
 *  address, or the address alone. */
export function kitWho(integrator: Hex, entry: IntegratorEntry | null, format: Format): string {
  return entry && entry.name !== '' ? format('kit.whoNamed', { name: entry.name, address: integrator }) : integrator;
}

/** The registry's answer, stated. */
export function entryLine(entry: ChainRead<IntegratorEntry>, format: Format): string | null {
  if (entry.state === 'reading') return null;
  if (entry.state === 'failed' || entry.data === null) return format('kit.entryUnread', { reason: entry.error ?? '' });
  const e = entry.data;
  if (e.status === 'active') return format('kit.entryActive', { name: e.name });
  if (e.status === 'suspended') return format('kit.entrySuspended', { name: e.name });
  return format('kit.entryNone', {});
}

const RULE_KEY = { 'may-apply': 'kit.ruleMayApply', 'attribution-only': 'kit.ruleAttribution', 'no-fee': 'kit.ruleNoFee' } as const;

/** What naming an integrator does on this action. */
export function ruleLine(r: KitRequest, format: Format): string {
  return format(RULE_KEY[SHARE_RULE[r.action]], {});
}

const WHY: Record<Exclude<ShareRefusal, 'none'>, CopyKey> = {
  'not-named': 'kit.whyNotRegistered',
  'not-registered': 'kit.whyNotRegistered',
  suspended: 'kit.whySuspended',
  flagged: 'kit.whyFlagged',
  'borrower-is-integrator': 'kit.whyYou',
};

/** The line a borrower's review carries for the integrator signed into its
 *  terms: what the protocol would pay it today, or why nothing, or that the
 *  answer could not be read. */
export function borrowerShareLine(who: string, share: ChainRead<IntegratorShare>, format: Format): string {
  if (share.state !== 'ready' || share.data === null) return format('kit.reviewShareUnread', { who, reason: share.error ?? format('kit.stillReading', {}) });
  const s = share.data;
  if (s.refusal === 'none') return format('kit.reviewShare', { who, rate: formatBps(s.rateBps) });
  return format('kit.reviewShareNot', { who, why: format(WHY[s.refusal], {}) });
}
