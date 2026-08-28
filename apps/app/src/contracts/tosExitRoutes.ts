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
  // Aliases that redirect INTO the above.
  '/loans',
  '/dashboard',
  '/manage',
  '/claim',
  // NOT covered by '/claim' above: the boundary match stops at '/', so a
  // hyphenated sibling is a different route. The test caught this exact
  // comment claiming otherwise.
  '/claim-center',
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
  const path = pathname.replace(/\/+$/, '') || '/';
  return EXIT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
