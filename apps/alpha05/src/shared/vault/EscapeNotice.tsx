import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { readProtection, type Protection } from '../protection/payout';
import { answerOrNull } from '../reads/answer';
import { useOwnRead } from '../reads/useOwnRead';
import { formatSpan, formatUtc } from '../ui/format';
import { useNow } from '../ui/useNow';

type Hex = `0x${string}`;

const ADMIN = AdminFacetABI as Abi;
const PAYOUT = VaultPayoutFacetABI as Abi;

/** The pause and its escape route, as the Vault page states them. */
export interface EscapeFacts {
  paused: boolean | null;
  escapeOpen: boolean | null;
  /** Unix seconds the escape route opens under the pause in force; 0 when
   *  none is scheduled; null when unread. */
  opensAt: number | null;
  protection: Protection | null;
  /** The block's time in unix seconds. */
  chainNow: number;
  readAt: number;
}

export async function readEscapeFacts(c: PublicClient, diamond: Hex, account: Hex): Promise<EscapeFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const read = <T,>(abi: Abi, functionName: string) => answerOrNull(c.readContract({ address: diamond, abi, functionName, ...at }) as Promise<T>);
  const [paused, escapeOpen, opensAt, protection] = await Promise.all([
    read<boolean>(ADMIN, 'paused'),
    read<boolean>(PAYOUT, 'isEscapeOpen'),
    read<bigint>(PAYOUT, 'escapeOpensAt'),
    readProtection(c, diamond, account, block.number),
  ]);
  return { paused, escapeOpen, opensAt: opensAt === null ? null : Number(opensAt), protection, chainNow: Number(block.timestamp), readAt: Date.now() };
}

/** Which sentence the notice states; null when the protocol is not paused. */
export type EscapeState = 'unread' | 'routeUnread' | 'noRoute' | 'opensAt' | 'opening' | 'openPlain' | 'openProtected' | 'openModeUnread';

export function escapeState(f: EscapeFacts | null, now: number | null): EscapeState | null {
  if (f === null) return 'unread';
  if (f.paused === false) return null;
  if (f.paused === null) return 'unread';
  if (f.escapeOpen === null) return 'routeUnread';
  if (f.escapeOpen) return f.protection === null ? 'openModeUnread' : f.protection.enabled ? 'openProtected' : 'openPlain';
  if (f.opensAt === null) return 'routeUnread';
  if (f.opensAt === 0) return 'noRoute';
  return now !== null && now >= f.opensAt ? 'opening' : 'opensAt';
}

/**
 * ACC-30 / ACC-31 — the Vault page's pause notice. While the protocol is
 * paused, withdrawals are closed; once the pause has run its escape period,
 * its escape route opens: a wallet without protected mode then withdraws
 * what is its own and free straight to itself (the Withdraw button routes
 * there), and a protected account's withdrawals keep queueing for its delay.
 * The notice states which applies, and before the route opens, when it
 * opens, from the protocol's own `escapeOpensAt` and the chain's clock. An
 * automatic pause, or a protocol not yet launched, schedules no route, and
 * the notice says none is scheduled. Nothing shows when the protocol is not
 * paused.
 */
export function EscapeNotice({ chain, account }: { chain: SupportedChain; account: Hex }) {
  const { text, format } = useCopy();
  const diamond = chain.diamondAddress;
  const facts = useOwnRead(['vault', 'escape', diamond, account], (c) => readEscapeFacts(c, diamond, account), { perBlock: true });
  const nowMs = useNow(1000);
  const f = facts.data;
  const now = f ? f.chainNow + Math.max(0, Math.floor((nowMs - f.readAt) / 1000)) : null;
  const state = facts.state === 'reading' || facts.state === 'no-identity' ? null : escapeState(f, now);
  if (state === null) return null;
  const sentence =
    state === 'opensAt' && f !== null && f.opensAt !== null && now !== null
      ? format('vaultEscape.opensAt', { at: formatUtc(f.opensAt), left: formatSpan(f.opensAt - now) })
      : text(`vaultEscape.${state}` as const);
  return (
    <section className="home-section" aria-labelledby="vault-escape" data-testid="vault-escape" data-state={state}>
      <h2 id="vault-escape">{text('vaultEscape.title')}</h2>
      <p className="tier-a">{sentence}</p>
      <p className="tier-b">{text('vaultEscape.stillOpen')}</p>
      <WhyLink summaryKey="vaultEscape.whySummary" detailKey="vaultEscape.why" />
    </section>
  );
}
