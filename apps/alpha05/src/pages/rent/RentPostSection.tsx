import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { useTokenMeta } from '../../shared/reads/tokens';
import type { OwnRead } from '../../shared/reads/useOwnRead';
import type { ListDraft } from '../../shared/rent/listModel';
import { ListForRent, RENT_LIST_KEY } from '../../shared/rent/ListForRent';
import { RentListForm, type RentFormSide } from '../../shared/rent/RentListForm';
import { RENT_REQUEST_KEY, RequestToRent } from '../../shared/rent/RequestToRent';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import type { TermsState } from '../../shared/terms/terms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';

type Served = { chain: SupportedChain; own: OwnStateClient } | null;

/** The store key each side's form, draft and flow live under. */
export const RENT_POST_KEY: Readonly<Record<RentFormSide, string>> = { list: RENT_LIST_KEY, request: RENT_REQUEST_KEY };

const SECTION_KEYS = {
  list: { title: 'rentPage.listTitle', lead: 'rentPage.listLead', button: 'rentPage.listButton', asker: 'rentList.title' },
  request: { title: 'rentPage.requestTitle', lead: 'rentPage.requestLead', button: 'rentPage.requestButton', asker: 'rentRequest.title' },
} as const;

/** Whether a side's form or review is open, from the app's store. */
export function useRentPostOpen(side: RentFormSide): boolean {
  const key = RENT_POST_KEY[side];
  const [composing] = useStoredValue<boolean>(`${key}:composing`);
  const [draft] = useStoredValue<ListDraft>(`${key}:draft`);
  return composing === true || draft !== null;
}

interface RentPostSectionProps {
  side: RentFormSide;
  served: Served;
  terms: Pick<OwnRead<TermsState>, 'data' | 'state'>;
  /** The other side's form or review is open: this side offers no button. */
  otherOpen: boolean;
}

/**
 * One way to post a rental on Rent: an owner's listing (NFT-01) or a
 * renter's request (NFT-02). The section offers its button, then its form,
 * then the Terms prompt when a newer version is in force (a rental is new
 * exposure, OFF-35), then the review and its flow. The form, the confirmed
 * draft and the flow are kept in the app's store under the side's own key,
 * so a navigation away and back reopens the same step.
 */
export function RentPostSection({ side, served, terms, otherOpen }: RentPostSectionProps) {
  const { text } = useCopy();
  const key = RENT_POST_KEY[side];
  const words = SECTION_KEYS[side];
  const chain = served?.chain ?? null;
  const own = served?.own ?? null;
  const termsGate = useTermsGate(`${key}.terms`, chain, own);
  const [composing, setComposing] = useStoredValue<boolean>(`${key}:composing`);
  const [draft, setDraft] = useStoredValue<ListDraft>(`${key}:draft`);
  const [pendingDraft, setPendingDraft] = useStoredValue<ListDraft>(`${key}:pending`);
  const [, setTyped] = useStoredValue<unknown>(`${key}:input`);
  const meta = useTokenMeta(draft ? [draft.nft, draft.payment] : []).data;
  const termsOpen = termsGate.session !== null;
  const open = composing === true || draft !== null;

  const review = (next: ListDraft) => {
    if (terms.data?.kind === 'needed') {
      setPendingDraft(next);
      termsGate.start(terms.data);
      return;
    }
    setDraft(next);
  };
  const close = (posted: boolean) => {
    setDraft(null);
    setComposing(null);
    if (posted) setTyped(null);
  };

  return (
    <section className="home-section" aria-labelledby={`rent-${side}-title`} data-testid={`rent-${side}`}>
      <h2 id={`rent-${side}-title`}>{text(words.title)}</h2>
      {served && !open && (
        <>
          <p className="tier-b">{text(words.lead)}</p>
          <p>
            <button type="button" className="btn" disabled={otherOpen || termsOpen || terms.state !== 'ready'} onClick={() => setComposing(true)} data-testid={`rent-${side}-open`}>
              {text(words.button)}
            </button>
          </p>
        </>
      )}
      {served && composing === true && draft === null && !termsOpen && (
        <RentListForm side={side} formKey={key} chain={served.chain} own={served.own} onReview={review} onCancel={() => setComposing(null)} />
      )}
      {termsOpen && termsGate.session && served && (
        <TermsPrompt
          asker={text(words.asker)}
          gate={termsGate}
          session={termsGate.session}
          chain={served.chain}
          own={served.own}
          onAccepted={() => {
            termsGate.end();
            if (pendingDraft !== null) setDraft(pendingDraft);
            setPendingDraft(null);
          }}
          onClose={() => {
            setPendingDraft(null);
            termsGate.end();
          }}
        />
      )}
      {draft !== null &&
        served &&
        (side === 'list' ? (
          <ListForRent draft={draft} chain={served.chain} own={served.own} meta={meta} terms={terms.data} onEdit={() => setDraft(null)} onClose={close} />
        ) : (
          <RequestToRent draft={draft} chain={served.chain} own={served.own} meta={meta} terms={terms.data} onEdit={() => setDraft(null)} onClose={close} />
        ))}
    </section>
  );
}
