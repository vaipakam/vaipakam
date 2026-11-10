/**
 * #3415 — every address the connected wallet already uses, as ONE list for
 * every address box (RB-ADDRESS-GUARD). A look-alike is refused only if the
 * address it imitates is in the list, so each box reads the same sources:
 * the wallet itself, the saved addresses and the proofs still waiting, this
 * network's own keeper, and, from the chain at one block, the account's
 * payout destinations, the destinations still waiting, its secondary
 * signers, the wallets asked to become one, and its approved keepers.
 *
 * Until every source has answered, a look-alike of an address not yet read
 * cannot be ruled out, so the list says it is incomplete and no box lets
 * an address be used: the reader is told the check is still reading, or
 * could not be made, instead of a box that looks checked when it is not.
 */
import { getAddress, type Abi, type PublicClient } from 'viem';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { keeperName } from '../keepers/keeperReceipt';
import { networkKeeper, PROFILE_ABI } from '../keepers/keepers';
import { PROTECTED } from '../protection/safety';
import { isContractAnswer } from '../reads/answer';
import { useOwnRead } from '../reads/useOwnRead';
import type { AddressBook } from './book';
import { mergeKnown, type KnownAddress, type KnownAddresses } from './lookalike';

type Hex = `0x${string}`;

/** The addresses the account uses on-chain, each list null when the
 *  contract gave no answer for it (so the whole list is incomplete). */
export interface UsedAddresses {
  destinations: readonly Hex[] | null;
  pending: readonly Hex[] | null;
  signers: readonly Hex[] | null;
  /** Wallets asked to become a signer, accepted or not. */
  nominees: readonly Hex[] | null;
  keepers: readonly Hex[] | null;
}

/** The saved book's entries and waiting proofs as known addresses. */
export function bookKnown(book: AddressBook): KnownAddress[] {
  return [
    ...book.entries.map((e) => ({ address: e.address, source: 'book' as const, label: e.label })),
    ...book.pending.map((p) => ({ address: p.challenge.destination, source: 'pending' as const, label: p.label })),
  ];
}

/**
 * Read the account's on-chain addresses at one block. A Diamond without
 * the protected-account feature routes none of its reads, so it answers
 * that no address is there (an empty list); any other refusal leaves that
 * list unread. A source that fails is thrown, so the own rail tries the
 * next one.
 */
export async function readUsedAddresses(c: PublicClient, diamond: Hex, account: Hex): Promise<UsedAddresses> {
  const blockNumber = await c.getBlockNumber({ cacheTime: 0 });
  const list = async <T>(abi: Abi, functionName: string, pick: (raw: T) => readonly Hex[]): Promise<readonly Hex[] | null> => {
    try {
      const raw = (await c.readContract({ address: diamond, abi, functionName, args: [account], blockNumber })) as T;
      return pick(raw).map((a) => getAddress(a));
    } catch (e) {
      if (!isContractAnswer(e)) throw e;
      return refusalFromError(e).code === 'FunctionDoesNotExist' ? [] : null;
    }
  };
  const [destinations, pending, signers, nominees, keepers] = await Promise.all([
    list<readonly Hex[]>(PROTECTED, 'getAllowlist', (r) => r),
    list<readonly [readonly Hex[], readonly bigint[]]>(PROTECTED, 'getPendingAllowlistAdditions', (r) => r[0]),
    list<readonly Hex[]>(PROTECTED, 'getProtectedSigners', (r) => r),
    list<readonly [readonly Hex[], readonly bigint[], readonly boolean[]]>(PROTECTED, 'getPendingSignerAdditions', (r) => r[0]),
    list<readonly Hex[]>(PROFILE_ABI, 'getApprovedKeepers', (r) => r),
  ]);
  return { destinations, pending, signers, nominees, keepers };
}

/** Merge every source into one list, the most specific first: the wallet
 *  itself, then its saved names, then the network keeper's name. */
export function knownAddresses(
  own: Hex,
  book: AddressBook,
  network: { address: Hex; label: string } | null,
  used: UsedAddresses | null,
  read: 'reading' | 'failed' | 'ready',
): KnownAddresses {
  const of = (xs: readonly Hex[] | null | undefined, source: KnownAddress['source']) =>
    (xs ?? []).map((address) => ({ address, source, label: null }) as KnownAddress);
  const list = mergeKnown(
    [{ address: own, source: 'own', label: null }],
    bookKnown(book),
    network === null ? [] : [{ address: network.address, source: 'keeper', label: network.label }],
    of(used?.destinations, 'destination'),
    of(used?.pending, 'pending'),
    of(used?.signers, 'signer'),
    of(used?.nominees, 'signer'),
    of(used?.keepers, 'keeper'),
  );
  const answered =
    used !== null && used.destinations !== null && used.pending !== null && used.signers !== null && used.nominees !== null && used.keepers !== null;
  const state = read === 'ready' && answered ? 'complete' : read === 'reading' && used === null ? 'reading' : 'failed';
  return { list, state };
}

/** The known addresses for `account` on the connected network. */
export function useKnownAddresses({
  chainId,
  chainName,
  diamond,
  account,
  book,
  enabled = true,
}: {
  chainId: number;
  chainName: string;
  diamond: Hex;
  account: Hex;
  book: AddressBook;
  enabled?: boolean;
}): KnownAddresses {
  const copy = useCopy();
  const used = useOwnRead(['address', 'used', diamond], (c) => readUsedAddresses(c, diamond, account), { enabled });
  const net = networkKeeper(chainId);
  const network = net === null ? null : { address: net, label: keeperName(net, net, chainName, copy) };
  const state = used.state === 'ready' ? 'ready' : used.state === 'failed' ? 'failed' : 'reading';
  return knownAddresses(account, book, network, used.data, state);
}
