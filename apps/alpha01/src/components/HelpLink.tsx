const BASIC_GUIDE = 'https://www.vaipakam.com/help/basic';

/** Legacy alpha01 anchor ids → real Basic guide section ids. */
export const HELP_ANCHOR_ALIASES: Record<string, string> = {
  'getting-started': 'dashboard.your-vault',
  borrow: 'create-offer.lending-asset:borrower',
  lend: 'offer-book.borrower-offers',
  positions: 'offer-book.your-active-offers',
  claims: 'claim-center.claims',
  'manage-loan': 'loan-details.actions',
  'nft-rental': 'create-offer.nft-details',
  'borrow-after': 'loan-details.actions:borrower',
};

export function resolveHelpAnchor(anchor: string): string {
  return HELP_ANCHOR_ALIASES[anchor] ?? anchor;
}

export function HelpLink({ anchor, label = 'Learn more in the Basic guide' }: { anchor: string; label?: string }) {
  const resolved = resolveHelpAnchor(anchor);
  return (
    <a href={`${BASIC_GUIDE}#${resolved}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.9rem' }}>
      {label}
    </a>
  );
}