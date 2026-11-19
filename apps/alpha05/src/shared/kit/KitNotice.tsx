/**
 * #3773 — the kit hand-off on the page the user continued to. The page
 * keeps its own form and review; this states where the visit came from,
 * which integrator the user's request or acceptance will name, what that
 * does on this action, and lets the user remove the integrator or stop using
 * the link. `useKitUse` gives the page the integrator to sign in and the
 * lines its review adds, so what the user confirms states the integrator
 * that the signed terms carry.
 */
import type { KitAction } from '@vaipakam/lend-kit';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { useStoredValue } from '../tx/txStore';
import { Notice } from '../ui/Notice';
import { KIT_HANDOFF_KEY, type KitHandoff } from './kit';
import { borrowerShareLine, entryLine, kitWhat, kitWho, ruleLine, useIntegratorEntry, useIntegratorShare, useKitMeta } from './kitStatements';

type Hex = `0x${string}`;

export interface KitUse {
  /** The hand-off for this page on this network, else null. */
  handoff: KitHandoff | null;
  /** The integrator to sign into the user's request or acceptance. */
  integrator: Hex | null;
  /** What the review adds about that integrator. */
  lines: string[];
}

/** The hand-off as it applies to a page for `action` on `chain`. A rental
 *  names no integrator (it pays no initiation fee), so a rent page signs
 *  none in. */
export function useKitUse(action: KitAction, chain: SupportedChain | null, account: Hex | null): KitUse {
  const { format } = useCopy();
  const [handoff] = useStoredValue<KitHandoff>(KIT_HANDOFF_KEY);
  const applies = handoff !== null && handoff.request.action === action && chain !== null && handoff.request.chainId === chain.chainId;
  const named = applies && action !== 'rent' ? handoff.integrator : null;
  const entry = useIntegratorEntry(named !== null ? chain : null, named);
  const share = useIntegratorShare(action === 'borrow' && named !== null ? chain : null, named, account);
  if (!applies) return { handoff: null, integrator: null, lines: [] };
  if (named === null) return { handoff, integrator: null, lines: [] };
  const who = kitWho(named, entry.data, format);
  const lines = action === 'borrow' ? [borrowerShareLine(who, share, format)] : [format('kit.reviewAttribution', { who })];
  return { handoff, integrator: named, lines };
}

/** The hand-off's notice on a page for `action`. */
export function KitNotice({ action, chain }: { action: KitAction; chain: SupportedChain | null }) {
  const { text, format } = useCopy();
  const [handoff, setHandoff] = useStoredValue<KitHandoff>(KIT_HANDOFF_KEY);
  const mine = handoff !== null && handoff.request.action === action ? handoff : null;
  const linkChain = mine ? getSupportedChain(mine.request.chainId) : null;
  const meta = useKitMeta(linkChain, mine?.request ?? null);
  const named = mine && action !== 'rent' ? mine.integrator : null;
  const entry = useIntegratorEntry(named !== null ? linkChain : null, named);
  if (!mine) return null;
  const r = mine.request;
  const close = (
    <button type="button" className="btn" onClick={() => setHandoff(null)} data-testid="kit-close">
      {text('kit.close')}
    </button>
  );
  if (chain === null || r.chainId !== chain.chainId) {
    return (
      <div data-testid="kit-notice" data-state="other-network">
        <Notice tone="warn" tier="A">
          {format('kit.otherNetwork', { chain: linkChain?.name ?? String(r.chainId) })}
        </Notice>
        {close}
      </div>
    );
  }
  const entryText = named !== null ? entryLine(entry, format) : null;
  return (
    <div data-testid="kit-notice" data-state="here">
      <Notice tone="info" tier="A">
        {format('kit.banner', { what: kitWhat(r, meta.data, format) })}
      </Notice>
      {named !== null && (
        <div data-testid="kit-integrator" data-integrator={named}>
          <p className="tier-a">{format('kit.bannerNamed', { who: kitWho(named, entry.data, format) })}</p>
          {entryText !== null && <p className="tier-a">{entryText}</p>}
          <p className="tier-a">{ruleLine(r, format)}</p>
          {action === 'borrow' && <p className="tier-a">{text('kit.bannerNow')}</p>}
          {action === 'lend' && <p className="tier-a">{text('kit.bannerAutoLend')}</p>}
          <button type="button" className="btn" onClick={() => setHandoff({ ...mine, integrator: null })} data-testid="kit-drop">
            {text('kit.drop')}
          </button>
        </div>
      )}
      {action !== 'rent' && named === null && r.integrator !== undefined && (
        <div data-testid="kit-dropped">
          <p className="tier-a">{text('kit.dropped')}</p>
          <button type="button" className="btn" onClick={() => setHandoff({ ...mine, integrator: r.integrator! })} data-testid="kit-restore">
            {text('kit.restore')}
          </button>
        </div>
      )}
      {action === 'rent' && r.integrator !== undefined && <p className="tier-a">{ruleLine(r, format)}</p>}
      {close}
    </div>
  );
}
