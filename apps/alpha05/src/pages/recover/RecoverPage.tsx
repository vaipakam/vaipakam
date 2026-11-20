import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { parseTokenId } from '../../shared/nft/nft';
import { useAssetStandard } from '../../shared/nft/useStandard';
import { parsePasted } from '../../shared/offers/assets';
import { tokenAmount, useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { AdoptAsset, useAdoptHeld } from '../../shared/recover/AdoptAsset';
import { adoptStops, banLifted, barredBy, disownStops, readRecoverFacts, type RecoverFacts, type RecoverSubject } from '../../shared/recover/adopt';
import { DISOWN_KEY, DisownAsset } from '../../shared/recover/DisownAsset';
import { subjectName } from '../../shared/recover/recoverReceipt';
import { FrozenNotice, useFrozenState } from '../../shared/sanctions/FrozenNotice';
import { holdsFlow, useStoredValue, useTxEntry } from '../../shared/tx/txStore';
import { FormField } from '../../shared/ui/FormField';
import { Notice } from '../../shared/ui/Notice';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { EscapeNotice } from '../../shared/vault/EscapeNotice';
import { UnrecognisedItems } from '../../shared/vault/UnrecognisedItems';
import { arrivalKey } from '../../shared/vault/unrecognised';

type Hex = `0x${string}`;

/**
 * Recover (ACC-25, ACC-26, ACC-27, NFT-33, LN-57): an asset that reached the
 * connected wallet's own vault outside the protocol. The reader names the
 * asset (and the token, for an NFT; the standard is the one its contract
 * claims, never chosen), and the page states the protocol's figure for
 * what of it sits in the vault uncounted, then offers to adopt it or to
 * disown it, each from its own panel, saying what stops either. A link
 * from the Vault page fills in the asset only. While the protocol is
 * paused the page also states the pause's escape route, which withdraws
 * from the Vault page.
 */
export function RecoverPage() {
  const { text } = useCopy();
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const chain = connected ? getSupportedChain(chainId) : null;
  const own = useOwnStateClient();
  const ready = chain !== null && own !== null;
  return (
    <main className="page recover" aria-labelledby="recover-title">
      <h1 id="recover-title">{text('recover.title')}</h1>
      <p className="tier-b">{text('recover.lead')}</p>
      <WhyLink summaryKey="recover.whySummary" detailKey="recover.why" />
      {!connected && <p className="tier-b">{text('recover.connectPrompt')}</p>}
      {connected && chain === null && <p className="tier-b">{text('positions.unsupportedChain')}</p>}
      {ready && <RecoverBody chain={chain} own={own} />}
    </main>
  );
}

function RecoverBody({ chain, own }: { chain: SupportedChain; own: OwnStateClient }) {
  const { text } = useCopy();
  const frozen = useFrozenState(chain.diamondAddress, own.account);
  const [params, setParams] = useSearchParams();
  const asset = parsePasted(params.get('asset') ?? '');
  const idParam = params.get('id');
  const standard = useAssetStandard(asset);
  const tokenId = idParam === null ? null : parseTokenId(idParam);
  const subject: RecoverSubject | null =
    asset === null || standard.data === null
      ? null
      : standard.data === 'erc20'
        ? { standard: 'erc20', asset, tokenId: 0n }
        : tokenId === null
          ? null
          : { standard: standard.data, asset, tokenId };
  const pick = (a: Hex, id: bigint | null) => {
    const next: Record<string, string> = { asset: a };
    if (id !== null) next.id = id.toString();
    setParams(next, { replace: true });
  };
  return (
    <>
      <FrozenNotice state={frozen} />
      <EscapeNotice chain={chain} account={own.account} />
      <p className="tier-b">
        {text('recover.vaultLead')} <Link to="/vault">{text('recover.vaultLink')}</Link>
      </p>
      <UnrecognisedItems
        chain={chain}
        account={own.account}
        open
        testId="recover-unrecognised"
        action={(i) => (
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => pick(i.asset, i.tokenId)} data-testid={`recover-pick-${arrivalKey(i)}`}>
              {text('unrecognised.pick')}
            </button>
          </div>
        )}
      />
      <p className="tier-b">{text('unrecognised.pickLead')}</p>
      <LookupForm key={`${asset ?? ''}:${idParam ?? ''}`} initialAsset={asset} initialId={idParam} onPick={pick} />
      {asset !== null && standard.state === 'failed' && standard.data === null && (
        <p className="tier-a" data-testid="recover-standard-failed">
          {text('recover.standardUnread')}
        </p>
      )}
      {asset !== null && standard.data !== null && standard.data !== 'erc20' && tokenId === null && (
        <p className="tier-b" data-testid="recover-need-id">
          {text('recover.needTokenId')}
        </p>
      )}
      {subject !== null && <SubjectCard key={`${subject.asset}:${subject.tokenId}`} chain={chain} own={own} subject={subject} />}
    </>
  );
}

/** The asset to look up, and the token id when its contract is an NFT
 *  collection. Typing never reads the chain; looking up does. */
function LookupForm({ initialAsset, initialId, onPick }: { initialAsset: Hex | null; initialId: string | null; onPick: (a: Hex, id: bigint | null) => void }) {
  const { text } = useCopy();
  const [assetText, setAssetText] = useState(initialAsset ?? '');
  const [idText, setIdText] = useState(initialId ?? '');
  const [asked, setAsked] = useState(false);
  const asset = parsePasted(assetText);
  const id = idText.trim() === '' ? null : parseTokenId(idText);
  const assetError = asset === null ? text(assetText.trim() === '' ? 'recover.assetEmpty' : 'recover.assetInvalid') : null;
  const idError = idText.trim() !== '' && id === null ? text('vaultDeposit.tokenIdInvalid') : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (asset !== null && idError === null) onPick(asset, id);
  };
  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="recover-lookup">
      <h2>{text('recover.lookupTitle')}</h2>
      <FormField label={text('recover.assetLabel')} hint={text('recover.assetHint')} error={asked ? assetError : null}>
        {({ id: inputId, describedBy, invalid }) => (
          <input
            id={inputId}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={assetText}
            onChange={(e) => setAssetText(e.target.value)}
            data-testid="recover-asset"
          />
        )}
      </FormField>
      <FormField label={text('recover.tokenIdLabel')} hint={text('recover.tokenIdHint')} error={idError}>
        {({ id: inputId, describedBy, invalid }) => (
          <input
            id={inputId}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={idText}
            onChange={(e) => setIdText(e.target.value)}
            data-testid="recover-token-id"
          />
        )}
      </FormField>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="recover-look-up">
          {text('recover.lookUp')}
        </button>
      </div>
    </form>
  );
}

/** One asset: the protocol's figure for what of it sits uncounted, what
 *  stops adopting or disowning it, and the two panels. */
function SubjectCard({ chain, own, subject }: { chain: SupportedChain; own: OwnStateClient; subject: RecoverSubject }) {
  const copy = useCopy();
  const { text, format } = copy;
  const diamond = chain.diamondAddress;
  const facts = useOwnRead(
    ['recover', 'facts', diamond, subject.standard, subject.asset, subject.tokenId.toString()],
    (c) => readRecoverFacts(c, diamond, own.account, subject),
    {
      perBlock: true,
    },
  );
  const meta = useTokenMeta([subject.asset]).data;
  const adopt = useAdoptHeld();
  const disownEntry = useTxEntry(DISOWN_KEY);
  const [disownFor, setDisownFor] = useStoredValue<RecoverSubject>(`${DISOWN_KEY}:subject`);
  const f = facts.data;
  const name = subjectName(subject, meta, copy);
  const amount = (v: bigint) => (subject.standard === 'erc20' ? tokenAmount(v, subject.asset, meta, format) : v.toString());
  const sameAs = (s: RecoverSubject | null) =>
    s !== null && s.standard === subject.standard && s.asset.toLowerCase() === subject.asset.toLowerCase() && s.tokenId === subject.tokenId;
  const adoptOpen = sameAs(adopt.subject);
  const disownOpen = sameAs(disownFor);
  const busy = adopt.inFlight || holdsFlow(disownEntry.phase);
  return (
    <section className="home-section" aria-labelledby="recover-subject" data-testid="recover-subject" data-standard={subject.standard}>
      <h2 id="recover-subject">{name}</h2>
      <p className="vault-asset-address">
        <code>{subject.asset}</code>
      </p>
      <OwnStamp reads={[facts]} />
      {f === null && facts.state !== 'failed' && <p className="tier-b">{text('recover.reading')}</p>}
      {f === null && facts.state === 'failed' && (
        <p className="tier-a" data-testid="recover-failed">
          {format('recover.failed', { reason: facts.error ?? '' })}
        </p>
      )}
      {f !== null && <Figure facts={f} amount={amount} />}
      {f !== null && barredBy(f) !== null && (
        <div data-testid="recover-barred">
          <Notice tone="danger" tier="A">
            {format('recover.barredNotice', { source: barredBy(f) as Hex })}
          </Notice>
        </div>
      )}
      {f !== null && banLifted(f) !== null && (
        <p className="tier-a" data-testid="recover-ban-lifted">
          {format('recover.banLiftedNotice', { source: banLifted(f) as Hex })}
        </p>
      )}
      {f !== null && !adoptOpen && !disownOpen && <Actions facts={f} busy={busy} onAdopt={() => adopt.open(subject)} onDisown={() => setDisownFor(subject)} />}
      {f !== null && adoptOpen && <AdoptAsset chain={chain} own={own} facts={f} onClose={() => adopt.open(null)} />}
      {disownOpen && <DisownAsset chain={chain} own={own} subject={subject} onClose={() => setDisownFor(null)} />}
    </section>
  );
}

/** The protocol's figure for what sits uncounted, in words. */
function Figure({ facts: f, amount }: { facts: RecoverFacts; amount: (v: bigint) => string }) {
  const { text, format } = useCopy();
  if (f.vault === null)
    return (
      <p className="tier-a" data-testid="recover-figure" data-state="noVault">
        {text('recover.noVault')}
      </p>
    );
  if (f.untracked === null)
    return (
      <p className="tier-a" data-testid="recover-figure" data-state="unread">
        {text('recover.untrackedUnread')}
      </p>
    );
  if (f.untracked === 0n)
    return (
      <p className="tier-b" data-testid="recover-figure" data-state="none">
        {text(f.subject.standard === 'erc721' ? 'recover.nftNotUntracked' : 'recover.nothingUntracked')}
      </p>
    );
  return (
    <p className="tier-a" data-testid="recover-figure" data-state="untracked">
      {f.subject.standard === 'erc721' ? text('recover.nftUntracked') : format('recover.untracked', { amount: amount(f.untracked) })}
    </p>
  );
}

/** What stops adopting and disowning, or the buttons that open them. */
function Actions({ facts: f, busy, onAdopt, onDisown }: { facts: RecoverFacts; busy: boolean; onAdopt: () => void; onDisown: () => void }) {
  const copy = useCopy();
  const { text } = copy;
  const adoptStop = adoptStops(f, copy);
  const disownStop = disownStops(f, copy);
  if (f.vault === null || f.untracked === null || f.untracked === 0n) return null;
  return (
    <>
      {adoptStop.length > 0 && (
        <p className="tier-a" data-testid="recover-adopt-stop">
          {adoptStop[0]}
        </p>
      )}
      {busy && <p className="tier-b">{text('recover.busy')}</p>}
      <div className="form-actions">
        {adoptStop.length === 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onAdopt} data-testid="recover-adopt-open">
            {text('recover.adoptOpen')}
          </button>
        )}
        {disownStop.length === 0 && (
          <button type="button" className="btn" disabled={busy} onClick={onDisown} data-testid="recover-disown-open">
            {text('recover.disownOpen')}
          </button>
        )}
      </div>
      <p className="tier-b">{text('recover.disownNote')}</p>
    </>
  );
}
