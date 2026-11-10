import { Link, useSearchParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { AddressBookSection, useAddressBook } from '../../shared/address/AddressBook';
import { useKnownAddresses } from '../../shared/address/knownAddresses';
import { ProveControl } from '../../shared/address/ProveControl';
import { useCopy } from '../../shared/copy/useCopy';
import { DestinationsSection } from '../../shared/protection/Destinations';
import { readDestinationFacts } from '../../shared/protection/destinations';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { OwnStamp } from '../../shared/ui/OwnStamp';

type Hex = `0x${string}`;
const NO_BOOK_ACCOUNT = '0x0000000000000000000000000000000000000000' as Hex;

/**
 * Protection (ACC-41, #3415, RB-ADDRESS-GUARD): where the connected wallet's
 * protected payouts may go, and the saved addresses a destination is chosen
 * from. A link with `?prove=` opens the signing side of an address proof,
 * for the wallet that holds the address, whoever is connected. Protected
 * mode itself and locking stay on the Vault page.
 */
export function ProtectionPage() {
  const { text } = useCopy();
  const [params] = useSearchParams();
  const prove = params.get('prove');
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const chain = connected ? getSupportedChain(chainId) : null;
  const own = useOwnStateClient();
  const ready = chain !== null && own !== null;
  const diamond = chain?.diamondAddress ?? NO_BOOK_ACCOUNT;
  const facts = useOwnRead(['protection', 'destinations', diamond], (c) => readDestinationFacts(c, diamond, own!.account), { enabled: ready });
  const book = useAddressBook(chain?.chainId ?? 0, own?.account ?? NO_BOOK_ACCOUNT);
  const known = useKnownAddresses({
    chainId: chain?.chainId ?? 0,
    chainName: chain?.name ?? '',
    diamond,
    account: own?.account ?? NO_BOOK_ACCOUNT,
    book,
    enabled: ready,
  });
  return (
    <main className="page protection" aria-labelledby="protection-title">
      <h1 id="protection-title">{text('protection.title')}</h1>
      <p className="tier-b">{text('protection.lead')}</p>
      {prove !== null && <ProveControl code={prove} />}
      {!connected && <p className="tier-b">{text('protection.connectPrompt')}</p>}
      {connected && chain === null && <p className="tier-b">{text('positions.unsupportedChain')}</p>}
      {ready && (
        <>
          <OwnStamp reads={[facts]} />
          <DestinationsSection chain={chain} own={own} facts={facts} book={book} />
          <AddressBookSection chain={chain} own={own} known={known} />
          <p className="tier-b">
            <Link to="/vault">{text('protection.backToVault')}</Link>
          </p>
          <p className="tier-b">{text('protection.later')}</p>
        </>
      )}
    </main>
  );
}
