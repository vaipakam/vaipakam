import { Link } from 'react-router-dom';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';

interface Intent {
  id: string;
  to: string;
  title: CopyKey;
  line: CopyKey;
}

/** ACC-05 and OFF-44's entry: the first choice is a job, never a protocol
 *  term. Each card opens the guided page for that job; renting covers both
 *  sides of an NFT rental, so the owner's card carries its side. */
const INTENTS: readonly Intent[] = [
  { id: 'borrow', to: '/borrow', title: 'home.intentBorrow', line: 'home.intentBorrowB' },
  { id: 'lend', to: '/lend', title: 'home.intentLend', line: 'home.intentLendB' },
  { id: 'rent', to: '/rent', title: 'home.intentRent', line: 'home.intentRentB' },
  { id: 'rent-out', to: '/rent?side=owner', title: 'home.intentRentOut', line: 'home.intentRentOutB' },
  { id: 'manage', to: '/positions', title: 'home.intentManage', line: 'home.intentManageB' },
];

export function IntentChooser() {
  const { text } = useCopy();
  return (
    <section className="home-section" aria-labelledby="home-intent">
      <h2 id="home-intent">{text('home.intentTitle')}</h2>
      <WhyLink summaryKey="home.intentSummary" detailKey="home.intentWhy" />
      <ul className="intents">
        {INTENTS.map((i) => (
          <li key={i.id}>
            <Link className="intent" to={i.to} data-intent={i.id}>
              <span className="intent-title">{text(i.title)}</span>
              <span className="intent-line">{text(i.line)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
