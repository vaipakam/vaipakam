# @vaipakam/alpha02 — the naive-user-first connected app

alpha02 is a ground-up redesign of the Vaipakam connected app for
people who have used a wallet and maybe a DEX, but are not DeFi
experts. It will serve at **alpha02.vaipakam.com** and is intended to
replace `apps/defi` (frozen; retired after cutover). It shares no code
with `apps/alpha` (an earlier static mock) and does not touch
`apps/defi`.

## Product rules (load-bearing — read before adding a screen)

Derived from `docs/DesignsAndPlans/BasicUserUXSimplification.md`,
`docs/TestScopes/BasicUserJourneyMap.md`, and the
`docs/FindingsAndFixes/Findings20260702-NaiveUserBrowserAudit.md`
findings:

1. **Intent first.** The home screen asks what the user wants to do
   (Borrow / Lend / Rent an NFT / Manage). Every flow starts from an
   intent, not a protocol form.
2. **One review receipt everywhere.** Every write shows the same six
   rows before signing: You receive / You lock / You may owe / You can
   lose / Fees / When this ends (`components/ReviewReceipt.tsx`).
   Protocol fees and network gas are always separate concepts.
3. **Problems are fixable checklist items** — never opaque failures
   (`components/Checklist.tsx` + `components/useEligibility.tsx`).
4. **Honest empty states.** "Nothing here" is only said when the data
   source positively returned zero. A failed load shows an
   "unavailable" state (`data/hooks.ts` — `null` = unavailable,
   `[]` = truly empty).
5. **Basic/Advanced is one mode value** (`app/ModeContext.tsx`),
   default Basic, persisted. Advanced reveals controls in place —
   no duplicate page trees, no navigation on switch.
6. **Light/dark themes** via CSS tokens only (`styles/tokens.css`);
   components never hardcode a color. `app/ThemeContext.tsx` +
   pre-paint inline script in `index.html`.
7. **Mobile first.** Bottom tab bar under 720px, sidebar above.
   Touch targets ≥ 44px.
8. **No dead ends.** Route aliases redirect; everything else lands on
   the in-shell NotFound page (`App.tsx`).
9. **All user-facing wording lives in `content/copy.ts`** and follows
   the Basic-mode wording rules documented at the top of that file
   (no jargon, yield never guaranteed, VPFI optional, errors as next
   steps).

## Wiring

- Chains come from `@vaipakam/contracts` `deployments.json` — a chain
  is supported iff its Diamond is in the bundle (`chain/chains.ts`).
- Wallet: wagmi v2 + viem + ConnectKit (`chain/wagmi.ts`), mirroring
  apps/defi's connector decisions (see that file's header before
  changing connector behaviour).
- Reads: the indexer worker (`data/indexer.ts`, react-query hooks in
  `data/hooks.ts`) — treated as a cache; on-chain log-scan fallback is
  a known follow-up. Token metadata/balances always read on-chain.
- Writes: explicit named calls through the Diamond
  (`contracts/diamond.ts`): `createOffer` (guided Borrow/Lend),
  `repayLoan`, `claimAsLender`, `claimAsBorrower`. The
  `lib/offerSchema.ts` payload mapping is copied verbatim from
  apps/defi — do not re-derive it.

## Status / follow-ups

Wired end-to-end: shell, themes, modes, wallet connect + chain gating,
home, guided borrow/lend (post offer with allowance handling),
positions list + loan detail with repay/claim, Claim Center, Offer
Book (browse), VPFI education page, settings, help, not-found.

Next milestones (in rough order):

1. Accept-offer path (guided "use an existing offer" in Borrow/Lend —
   `acceptOffer` + terms/signature plumbing from apps/defi).
2. NFT rental flows (post + rent, ERC-4907; `pages/Rent.tsx` is
   education-only today).
3. VPFI vault deposit/withdraw + live tier/consent state.
4. On-chain fallback reads when the indexer is unavailable.
5. Health-factor / liquidation-price display on loan details for
   liquid collateral (RiskFacet reads).
6. Cancel-offer action on the Positions page.
7. Sanctions banner + ToS gate parity, i18n catalog extraction from
   `content/copy.ts`, Playwright journeys (B1, L1, M1, C1 first).
8. Promote `lib/offerSchema.ts` (and other pure logic shared with
   apps/defi) into `packages/lib` instead of keeping copies.

## Commands

```bash
pnpm --filter @vaipakam/alpha02 dev        # local dev
pnpm --filter @vaipakam/alpha02 typecheck  # tsc -b --noEmit
pnpm --filter @vaipakam/alpha02 build      # tsc + vite build
pnpm --filter @vaipakam/alpha02 deploy     # build + wrangler deploy
```
