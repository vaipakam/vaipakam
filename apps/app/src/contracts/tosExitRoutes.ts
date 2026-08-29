/**
 * Routes the Terms gate must never withhold (#1961, review round 1 P1).
 *
 * The first cut of the gate wrapped the whole `<Outlet />`, which held
 * `/positions`, `/claims` and `/vpfi` behind acceptance — the only
 * routes exposing `repayLoan` / `repayPartial`, `claimAsBorrower` /
 * `claimAsLender`, and the VPFI vault withdrawal. So a user who declined
 * new terms, or merely could not have them read for them, could not
 * close a position or take their assets out.
 *
 * That is not a UX wrinkle. It contradicted this feature's own stated
 * promise — the gate's footnote and the release note both say repaying,
 * claiming and withdrawing are never blocked — and it is the failure
 * mode that turns a legal control into a lock on somebody else's money.
 * A gate on new business is legitimate; a gate on the exit is not.
 *
 * So the exit stays open, always: whatever the terms say, whatever the
 * network says, whatever this app failed to read. The gate applies to
 * routes that let a user take on NEW exposure.
 *
 * Aliases are listed too, because an alias renders a `<Navigate>` INSIDE
 * the gate — hold the alias and the redirect never runs, so exempting
 * only the canonical path would leave `/loans/7` gated on its way to an
 * ungated `/positions/7`.
 */

/** Exact paths, and prefixes for the parameterised ones. */
const EXIT_PREFIXES = [
  '/positions', // list + /positions/:loanId — repay, preclose, close-outs
  '/claims', // claimAsBorrower / claimAsLender
  '/vpfi', // withdrawVPFIFromVault
  '/vault', // the user's own asset vault
  '/recover', // stuck-token recovery: retrieving assets, by definition
  // Review round 5 P1: `/desk` hosts `OpenOrdersPanel`, the ONLY place a
  // live signed order can be cancelled. Gating it left a user who
  // declined new Terms unable to revoke a standing order that anyone
  // holding the signed row could still fill — the gate creating the
  // exposure it was meant to withhold. `cancelSignedOffer` being on the
  // write allowlist is no help if the button is behind the gate.
  //
  // Exempting it is safe BECAUSE the enforcement moved to the writes:
  // the desk's order-CREATING controls are refused by
  // `tosWriteGate.ts` whatever route they are pressed from. That is the
  // division of labour this pair now has — the route list decides what
  // a held user can SEE, the write list decides what they can DO.
  '/desk',
  // Review round 7 P2: `/settings` hosts `ApprovalsCard`, whose
  // `revokeAllowance` is a direct ERC-20 transaction — it never reaches
  // the Diamond write allowlist, so gating the route removed the only
  // one-click way to withdraw a standing spending authorisation from
  // the Diamond. Same shape as the desk's cancel: an exit the
  // enforcement layer cannot see, hidden by the affordance layer.
  //
  // `/settings` also carries the language picker, which is the other
  // reason a held user needs it.
  '/settings',
  // READ-ONLY surfaces (review round 11 P2). Not exits — nothing here
  // gets a user out of anything — but nothing here takes on exposure
  // either: `/help` is the explainer, `/activity` is the user's own
  // history, `/nft` verifies a position token. None makes a single
  // write, Diamond or otherwise, which the module docstring's own rule
  // makes the test: the gate applies to routes that let a user take on
  // NEW exposure.
  //
  // Withholding them was a plain contradiction of the functional spec
  // this PR itself edited — "only surfaces that exist to create new
  // exposure become unreachable" — and the practical cost lands
  // exactly wrong: a user asking what the terms mean, or checking what
  // they already agreed to, gets a page that will not open. The write
  // gate still covers anything these pages might grow later.
  '/help',
  '/activity',
  '/nft',
  // #1960 — the data-rights page. Read-only in the Diamond sense (it
  // touches browser storage, never the chain), and gating it would be
  // the sharpest version of the trap this list exists to prevent: a
  // Terms prompt standing between somebody and the controls for
  // exporting or erasing their own data. A right that can be withheld
  // pending acceptance of new terms is not one.
  '/data-rights',
  // ...and `/activity`'s own alias (review round 13 P2). An alias
  // renders its `<Navigate>` INSIDE the gate, so exempting only the
  // canonical path leaves the alias held and the redirect never runs.
  // The same trap the alias block below exists for — I exempted three
  // routes without checking whether any had one.
  '/history',
  // Aliases that redirect INTO the above.
  '/loans',
  '/dashboard',
  '/manage',
  '/claim',
  // NOT covered by '/claim' above: the boundary match stops at '/', so a
  // hyphenated sibling is a different route. The test caught this exact
  // comment claiming otherwise.
  '/claim-center',
  '/trade', // alias of /desk
  '/terminal', // alias of /desk
  '/vpfi-vault',
  '/vault-assets',
  '/app/loans',
] as const;

/**
 * True when this path must render regardless of the Terms verdict.
 *
 * Prefix matching is bounded at a segment boundary so `/vaults-of-x`
 * cannot inherit `/vault`'s exemption — a gate that can be widened by
 * naming a route carefully is not a gate.
 */
export function isExitRoute(pathname: string): boolean {
  // Lower-cased first: React Router matches route declarations
  // case-insensitively, so `/POSITIONS/7` renders the same page. A
  // case-sensitive exemption would block repayment for anyone whose
  // bookmark or inbound link differs in case — the exit trap this
  // module exists to prevent, reintroduced by a string comparison
  // (review round 3 P2).
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  return EXIT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
