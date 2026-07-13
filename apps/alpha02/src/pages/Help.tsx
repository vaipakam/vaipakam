/**
 * Help — short plain-language answers to the questions naive users
 * actually ask, plus the risk-disclosures section the consent
 * checkbox links to (#1030) and build info for testers. Deep-dive
 * docs stay on the marketing site; this page is deliberately small.
 */
import { useEffect } from 'react';
import { copy } from '../content/copy';
import { useProtocolFees, bpsToPercentText } from '../data/fees';
import { supportMailto } from '../data/support';
import { formatDate } from '../lib/format';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Where are my assets held?',
    a: 'In your own Vaipakam Vault — an on-chain account that only your wallet controls. Vaipakam never pools user funds and cannot spend them for you.',
  },
  {
    q: 'What happens if I don’t repay a loan?',
    a: 'After the due date plus a grace period, the lender can receive your locked collateral. If the collateral has a live market price, it can also be sold automatically when its value falls too far — repaying on time avoids both.',
  },
  {
    q: 'Is the interest I see guaranteed when I lend?',
    a: 'No. It is what you earn if the borrower repays on time. If they default, your recovery depends on the collateral they locked — the review screen spells this out before you sign.',
  },
  {
    q: 'What is an NFT rental?',
    a: 'The NFT stays locked in its owner’s vault; the renter gets temporary use rights, never ownership. Rental fees are prepaid, with a small refundable buffer.',
  },
  {
    q: 'Do I need VPFI?',
    a: 'No. VPFI is optional — holding it in your vault can reduce protocol fees on eligible loans. It never reduces network gas, and you never need it to borrow, lend, or rent.',
  },
  // UX-049 — the Help page lagged the shipped features; these cover
  // Basic/Advanced modes, alert setup, Claims, wrong-network, and the
  // NFT verifier.
  {
    q: 'What’s the difference between Basic and Advanced mode?',
    a: 'Basic keeps the guided Borrow, Lend, and NFT-rental journeys front and centre. Advanced additionally reveals the power surfaces — the Offer Book, the Rate Desk order book, VPFI discounts, and your full activity history. Switch any time from the mode toggle in the navigation; it never moves your positions.',
  },
  {
    q: 'How do I get alerts before a deadline or liquidation?',
    a: 'On the alerts card you can link Telegram (and enable browser push) to be warned as a loan nears its due date or a position’s health drops. Linking is a one-time signature; sending yourself a test alert confirms the channel actually works before you rely on it.',
  },
  {
    q: 'What is the Claim Center for?',
    a: 'When a loan you’re part of settles — a repayment you’re owed, or collateral from a default — the funds wait for you to claim them. The Claims page lists exactly what’s claimable and for which position, verified against the protocol’s own record, so nothing is stranded.',
  },
  {
    q: 'It says I’m on the wrong network — what do I do?',
    a: 'Offers, your vault, and the faucet are all per-network. If your wallet is on a chain Vaipakam isn’t deployed to, a banner offers a one-click switch to a supported network; the app never acts on an unsupported chain.',
  },
  {
    q: 'How do I check a position NFT before buying it off-platform?',
    a: 'The NFT verifier (in the navigation) reads any Vaipakam position NFT straight from the chain and shows its real loan terms and status — so you can confirm what a listing actually represents before you trust a secondary-market sale.',
  },
];

export function Help() {
  const buildHash = import.meta.env.VITE_BUILD_HASH as string | undefined;
  const buildTime = import.meta.env.VITE_BUILD_TIME as string | undefined;
  // UX-044 — the footer shows a readable date, not the raw ISO stamp;
  // the full string stays available in the diagnostics drawer. Falls
  // back to the raw value if it doesn't parse (never hides the build).
  const buildDateText = (() => {
    if (!buildTime) return null;
    const ms = Date.parse(buildTime);
    return Number.isFinite(ms) ? formatDate(Math.floor(ms / 1000)) : buildTime;
  })();
  const fees = useProtocolFees();

  // The consent checkbox links here as /help#risks — the router
  // doesn't scroll to hashes on its own. getElementById, not
  // querySelector: the fragment is user-controlled and an invalid
  // selector (/help#1, encoded chars) would throw during mount.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* malformed escape — use the raw fragment */
    }
    document.getElementById(id)?.scrollIntoView();
  }, []);

  // Fee numbers come from the live protocol config — governance can
  // retune them and this answer must track the deployed values.
  const feeFaq = {
    q: 'What fees does Vaipakam charge?',
    a: `${copy.fees.borrowerLIF(bpsToPercentText(fees.loanInitiationFeeBps))} ${copy.fees.lenderYieldFee(bpsToPercentText(fees.treasuryFeeBps))} ${copy.fees.lateFee} Network gas is separate and goes to the blockchain, not to Vaipakam.`,
  };
  const faq = [...FAQ, feeFaq];

  return (
    <div>
      <h1 className="page-title">Help</h1>
      {/* The exact platform disclaimer the spec mandates (§29) —
          wording is load-bearing, don't paraphrase. */}
      <p className="page-lede">
        Quick answers in plain language. {copy.help.disclaimer}
      </p>

      <div className="stack">
        {/* The consent checkbox's "Risk Disclosures" link lands here. */}
        <section id="risks" className="card">
          <h3>{copy.help.risksTitle}</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {copy.help.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        {faq.map((item) => (
          <section key={item.q} className="card">
            <h3>{item.q}</h3>
            <p style={{ margin: 0 }}>{item.a}</p>
          </section>
        ))}
        {/* #1040 phase 1 — human escalation path. The in-app sender
            lives in the Support panel (it holds the health details a
            good report needs); this section points there and offers
            the direct mail route. */}
        <section id="contact" className="card">
          <h3>{copy.support.helpTitle}</h3>
          <p style={{ marginTop: 0 }}>{copy.support.helpBody}</p>
          <a className="btn btn-secondary" href={supportMailto({})}>
            {copy.support.mailButton}
          </a>
        </section>
      </div>

      <p className="muted" style={{ marginTop: 24 }}>
        Build {buildHash ?? 'dev'}
        {buildDateText ? ` · ${buildDateText}` : ''}
      </p>
    </div>
  );
}
