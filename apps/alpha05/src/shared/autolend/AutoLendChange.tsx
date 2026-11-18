import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import type { TokenMetaMap } from '../reads/tokens';
import type { IntentSummary } from '../offers/intents';
import { useCopy } from '../copy/useCopy';
import { TermsPrompt } from '../terms/TermsPrompt';
import { useTerms } from '../terms/useTerms';
import { useTermsGate } from '../terms/useTermsGate';
import { useStoredValue } from '../tx/txStore';
import { inputFromIntent, type AutoLendDraft, type AutoLendInput } from './autoLend';
import { AutoLendForm } from './AutoLendForm';
import { AutoLendSetup } from './AutoLendSetup';

type Hex = `0x${string}`;

/** The store key one pair's change of limits lives under (the typed form,
 *  the draft, the review and its tracker), so it outlives the page. */
export function changeKeyFor(lending: Hex, collateral: Hex, slot: number): string {
  return `autolend.change.${lending.toLowerCase()}.${collateral.toLowerCase()}.${slot}`;
}

/** Whether a pair's change panel is open, held in the store with the flow. */
export function useChangeOpen(lending: Hex, collateral: Hex, slot: number): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useStoredValue<boolean>(`${changeKeyFor(lending, collateral, slot)}:open`);
  return [open === true, (v) => setOpen(v ? true : null)];
}

interface AutoLendChangeProps {
  intent: IntentSummary;
  /** Starting a stopped Auto-lend again, rather than changing a running one. */
  restart: boolean;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  /** Closed: the step finished or was abandoned. */
  onClose: () => void;
}

/**
 * #3624 part 2b — changes an Auto-lend's limits, or starts a stopped or
 * ended one again: the setup's own form, opened on the recorded limits, and
 * its own review, which the protocol dry-runs from the wallet. The protocol
 * replaces the recorded terms in place (`setLenderIntent` on the same pair),
 * so the review says what that resets: the wait before the next loan starts
 * again, a priority-routing opt-in is switched off, and loans already made
 * keep their own terms. Money may be added in the same transaction. Like a
 * setup, it is new exposure (OFF-35): when newer Terms are in force they are
 * accepted first, through the same prompt, before the review opens.
 */
export function AutoLendChange({ intent, restart, chain, own, meta, onClose }: AutoLendChangeProps) {
  const key = changeKeyFor(intent.lendingAsset, intent.collateralAsset, intent.slot);
  const { text } = useCopy();
  const terms = useTerms();
  const termsGate = useTermsGate(`${key}.terms`, chain, own);
  const [draft, setDraft] = useStoredValue<AutoLendDraft>(`${key}:draft`);
  const [pending, setPending] = useStoredValue<AutoLendDraft>(`${key}:pending`);
  const [, setTyped] = useStoredValue<AutoLendInput>(`${key}:input`);
  const decimals = meta?.[intent.lendingAsset.toLowerCase()]?.decimals ?? null;
  const finish = () => {
    setDraft(null);
    setPending(null);
    setTyped(null);
    onClose();
  };
  const review = (next: AutoLendDraft) => {
    if (terms.data?.kind === 'needed') {
      setPending(next);
      termsGate.start(terms.data);
      return;
    }
    setDraft(next);
  };
  if (termsGate.session !== null) {
    return (
      <TermsPrompt
        asker={text(restart ? 'autoLend.askerStart' : 'autoLend.askerChange')}
        gate={termsGate}
        session={termsGate.session}
        chain={chain}
        own={own}
        onAccepted={() => {
          termsGate.end();
          if (pending !== null) setDraft(pending);
          setPending(null);
        }}
        onClose={() => {
          setPending(null);
          termsGate.end();
        }}
      />
    );
  }
  if (draft !== null) {
    return <AutoLendSetup draft={draft} chain={chain} own={own} meta={meta} terms={terms.data} flowKey={key} onEdit={() => setDraft(null)} onClose={finish} />;
  }
  // The form opens on exact figures, so it waits for the token's decimals;
  // while they are read, or when they cannot be, it says so and can close.
  if (decimals === null) {
    return (
      <div className="card" data-testid="autolend-change-unread">
        <p className="tier-a">{text(meta === null ? 'autoLend.changeReading' : 'autoLend.changeDecimalsUnread')}</p>
        <p className="actions">
          <button type="button" className="btn" onClick={finish}>
            {text('autoLend.cancel')}
          </button>
        </p>
      </div>
    );
  }
  return (
    <AutoLendForm
      chain={chain}
      own={own}
      lending={intent.lendingAsset}
      collateral={intent.collateralAsset}
      meta={meta}
      flowKey={key}
      change={{ initial: inputFromIntent(intent, decimals), restart, slot: intent.slot }}
      onReview={review}
      onCancel={finish}
    />
  );
}
