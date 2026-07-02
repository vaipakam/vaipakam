# Alpha01 — Naive-First Connected App (`alpha01.vaipakam.com`)

**Status:** draft (E1 — Issue #864)  
**Epic:** #863  
**Companion docs:**

- [`BasicUserUXSimplification.md`](./BasicUserUXSimplification.md) — product principles (PR #827)
- [`BasicUserJourneyMap.md`](../TestScopes/BasicUserJourneyMap.md) — testable journeys + PF IDs
- [`ProjectDetailsREADME.md`](../FunctionalSpecs/ProjectDetailsREADME.md) — protocol behaviour oracle
- [`TokenomicsTechSpec.md`](../TokenomicsTechSpec.md) — VPFI copy constraints

## 1. Why this doc exists

`apps/defi` (`defi.vaipakam.com`) accumulated every protocol feature on a single
dashboard. It is correct for power users but hostile to first-time borrowers and
lenders: dense home screen, 12+ sidebar destinations, protocol jargon above the
fold, and wide data tables that do not work on mobile.

We will **not** refactor `apps/defi`. It stays frozen as a reference and remains
live until cutover. The replacement product is a greenfield app:

| Item | Value |
| --- | --- |
| App path | `apps/alpha01` |
| Package name | `@vaipakam/alpha01` |
| Public URL | `alpha01.vaipakam.com` |
| Cloudflare Worker | `vaipakam-alpha01` |
| Retirement target | `apps/defi` after feature parity + operator sign-off |

This plan defines architecture, information architecture, copy tiers, scout
findings, phased PR stack, and verification gates (CDP + Playwright).

---

## 2. Product principles

### 2.1 Naive-first, not naive-only

Ship **Basic mode** first (intent wizards, plain language, one primary action per
screen). **Advanced mode** follows in waves for DEX-exposed users — people who
know APR, allowances, and health factors but are not protocol engineers.

### 2.2 Intent-first entry

After wallet connect, the home screen shows four jobs (not stats + forms):

| Job | Wording | Route |
| --- | --- | --- |
| Borrow | Borrow assets | `/borrow` |
| Lend | Earn by lending | `/lend` |
| NFT | Rent or lend an NFT | `/rent` |
| Manage | My positions | `/positions` |

### 2.3 Progressive disclosure

Every write flow uses the same five steps from
`BasicUserUXSimplification.md`:

1. Intent  
2. Minimal inputs  
3. Eligibility checklist (fixable items)  
4. Review receipt  
5. Confirmation + **one** next action  

### 2.4 Review receipt (trust surface)

All modes share one component shape:

| Field | Meaning |
| --- | --- |
| You receive | Asset or right gained |
| You lock | Collateral, prepay, NFT, VPFI in custody |
| You may owe | Repayment, interest, rental fees |
| You can lose | Collateral / rights in adverse cases |
| Fees | Protocol fees **separate from** network gas |
| When this ends | Claim, repayment, default, expiry |

Advanced mode adds a collapsible **Technical details** block (LTV, HF, oracle
class, liquidity class) — never on the Basic receipt by default.

### 2.5 Copy ladder

| Tier | Audience | Example |
| --- | --- | --- |
| **Basic** | First-time DeFi | "You lock collateral. If you don't repay on time, the lender can take it." |
| **Advanced** | DEX-exposed | "Initial LTV 70%. Health factor must stay above 1.5." |
| **Internal** | Support / docs only | Matcher share, keeper bitmask, tier cache |

### 2.6 VPFI posture (retail)

Per `TokenomicsTechSpec.md` and Basic UX plan: VPFI is **optional fee utility**.
Never block borrow/lend/rent. Home may show a single optional card; vault lives
under **More**.

### 2.7 Themes

Light and dark from day one. Reuse `@vaipakam/lib` cross-domain theme cookie
(`vaipakam_theme` on `.vaipakam.com`) so preference follows users across
`www`, `defi`, and `alpha01` during the transition period.

### 2.8 Mobile-first

- Bottom navigation on viewports &lt; 768px  
- No horizontal loan tables on phone — stacked **position cards**  
- Touch targets ≥ 44px; primary CTA sticky on wizard steps  
- CDP review viewports: **390×844** (phone), **1280×800** (desktop)  

---

## 3. Basic vs Advanced mode

Single `ModeContext` (`basic` | `advanced`), persisted in `localStorage`
(`vaipakam.alpha01.uiMode`). Toggle in header + Settings. **Same routes** in
both modes — mode changes density and vocabulary, not the route tree.

| Dimension | Basic | Advanced |
| --- | --- | --- |
| Home | Four intent cards + position summary | + portfolio metrics, shortcuts |
| Forms | Wizards, defaults, symbol pickers | + bounds, partial repay, collateral add/withdraw |
| Loan page | Role, health plain label, one primary CTA | + HF/LTV numbers, secondary protocol actions |
| Nav (More) | Claims, Help, Settings | + Keepers, Risk access, Allowances, Diagnostics link-out |
| Jargon | Banned on first screen | DEX-familiar terms allowed with tooltips |

**Non-goals for Advanced v1:** Protocol Console, analytics dashboard, NFT
verifier — link to existing public tools or defer to a later wave.

---

## 4. Information architecture

### 4.1 Routes (alpha01 only)

| Path | Basic | Advanced extras |
| --- | --- | --- |
| `/` | Intent home | Portfolio strip |
| `/borrow/*` | Guided borrow wizard | Range/bounds panel |
| `/lend/*` | Guided lend wizard | Offer construction details |
| `/rent/*` | NFT rental wizard | Rental prepay/buffer details |
| `/positions` | Active loans/offers list | Filters by role/status |
| `/positions/:loanId` | Command center | Technical risk panel |
| `/claims` | Simplified claim center | Reward breakdown |
| `/more` | Help, theme, mode, links | Advanced tool links |
| `/settings` | Wallet, chain, legal | Keeper prefs (later) |

Locale prefix `/en/...` optional in P0; i18n keys from day one (English only
until `I18nPlan` wave).

### 4.2 Navigation chrome

**Mobile:** bottom bar — Home · Borrow · Lend · Positions · More  
**Desktop:** same IA; optional left rail (icons + labels), content max-width
~720px for wizards, ~1100px for position lists.

---

## 5. Codebase scout (read-only on `apps/defi`)

### 5.1 Reuse directly (no fork)

| Package / asset | Use in alpha01 |
| --- | --- |
| `@vaipakam/contracts` | ABIs, `deployments.json`, `getDeployment(chainId)` |
| `@vaipakam/lib` | `address`, `multicall`, `decodeContractError`, `crossDomainPref` (theme) |
| `@vaipakam/ui` | `TokenIcon`, `InfoTip`, `ChainPicker`, `CopyableAddress` |
| Workers (unchanged) | `VITE_INDEXER_ORIGIN`, `VITE_AGENT_ORIGIN` — same env shape as defi |

### 5.2 Reimplement fresh in `packages/defi-client` (reference defi, do not import)

Extract protocol orchestration by **reading** these defi paths and rewriting
clean APIs:

| defi reference | defi-client module | Notes |
| --- | --- | --- |
| `src/contracts/useDiamond.ts` | `diamondClient.ts` | viem read/write wrapper, chain resolve |
| `src/lib/wagmiConfig.ts` + `src/contracts/config.ts` | `chains.ts` | Single chain registry |
| `src/hooks/useAcceptTermsSigning.ts` | `terms.ts` | Required before accept/create |
| `src/hooks/useLiquidityPreflight.ts` | `preflight/liquidity.ts` | ERC-20 collateral gate |
| `src/hooks/useRiskAccessPreflight.ts` | `preflight/riskAccess.ts` | Tier gates |
| `src/hooks/useSanctionsCheck.ts` | `preflight/sanctions.ts` | Retail oracle |
| `src/lib/offerSchema.ts` | `offers/schema.ts` | createOffer / acceptOffer shapes |
| `src/hooks/useIndexedActiveOffers.ts` | `indexer/offers.ts` | Indexer-first reads |
| `src/hooks/useLoan.ts`, `useDashboardLoans*` | `indexer/loans.ts` | Position hydration |
| `ClaimCenter.tsx` flows | `flows/claim.ts` | claimAsLender / claimAsBorrower |
| `LoanDetails.tsx` repay | `flows/repay.ts` | repayLoan |

**Hard rule:** `apps/alpha01` and `packages/defi-client` MUST NOT import from
`apps/defi` (enforced via ESLint `no-restricted-imports` in alpha01).

### 5.3 Explicitly out of scope for naive v1

Features that stay on `defi.vaipakam.com` until Advanced waves or permanent
link-out:

- Auto-lend / standing intents (dashboard forms on defi home today)
- Protocol Console / admin knobs public dashboard
- Swap-to-repay, internal match liquidation UI
- Preclose offset / refinance / early-withdrawal wizards
- Public analytics + NFT verifier (link from More)
- Diagnostics drawer (optional P5)
- Realtime WS push (polling + indexer sufficient for v1)

### 5.4 Deploy pattern (from `apps/defi`)

Mirror `apps/defi/wrangler.jsonc`:

```jsonc
{
  "name": "vaipakam-alpha01",
  "assets": { "not_found_handling": "single-page-application" },
  "compatibility_date": "2026-04-23",
  "compatibility_flags": ["nodejs_compat"]
}
```

Env vars: copy `apps/defi/.env.example` subset (RPC URLs, `VITE_DEFAULT_CHAIN_ID`,
`VITE_WALLETCONNECT_PROJECT_ID`, indexer/agent origins). No defi-specific flags
unless needed later.

### 5.5 pnpm workspace

`pnpm-workspace.yaml` already includes `apps/*` — adding `apps/alpha01` requires
no workspace file change.

---

## 6. Target repo layout

```
apps/alpha01/
  package.json
  wrangler.jsonc
  vite.config.ts
  index.html
  .env.example
  src/
    main.tsx
    App.tsx
    routes/
    layouts/MobileShell.tsx
    pages/          # thin route targets
    flows/          # borrow/, lend/, rent/ wizards
    components/
      ReviewReceipt.tsx
      EligibilityChecklist.tsx
      IntentHome.tsx
      PositionCard.tsx
    context/
      ThemeContext.tsx      # wraps @vaipakam/lib cookie pattern
      ModeContext.tsx
      ChainContext.tsx
      WalletContext.tsx
    i18n/
      en.json
    styles/
      tokens.css            # light/dark CSS variables
      global.css

packages/defi-client/
  package.json
  src/
    index.ts
    diamondClient.ts
    chains.ts
    indexer/
    preflight/
    flows/
    types/
```

---

## 7. Verification gates

### 7.1 Per-PR (implementation PRs P0+)

| Gate | When |
| --- | --- |
| `pnpm --filter @vaipakam/alpha01 exec tsc -b --noEmit` | Every PR |
| Vitest unit tests (receipt, checklist, mode copy) | P1+ |
| **CDP review** on port 9221 | End of P0, P1, P2, P3 — 390px + 1280px, light + dark |
| Playwright journey smoke | P2+ (B1), P3+ (L1/M1) |

CDP checklist template:

1. `list_pages` shows `alpha01` dev URL (not `about:blank` alone)  
2. Intent home: four cards visible, no auto-lend form on home  
3. Wizard: eligibility + receipt before sign  
4. Mobile: no horizontal scroll on primary flows  
5. Theme toggle: contrast OK on receipt card  

### 7.2 Release discipline

Each behaviour-changing PR carries:

- `docs/ReleaseNotes/unreleased/<ID>-<slug>.md`
- Functional spec touch only when **intended retail behaviour** changes (most
  alpha01 PRs are UI-only)

---

## 8. Journey coverage map

| Phase | Journeys | Issues |
| --- | --- | --- |
| P1 | Components only | #866 |
| P2 | **B1** borrow from lender offer | #867 |
| P3 | **L1** fund borrower offer, **M1** manage/repay/claim | #868 |
| P4 | B2, N1, claims polish | TBD |
| P5 | Advanced panels on B1/L1/M1 | TBD |
| P6 | Advanced tools (keepers, risk access, …) | TBD |
| Cutover | Redirect `defi.vaipakam.com` → alpha01 (operator decision) | TBD |

---

## 9. PR plan DAG

Merge order is strict. Each PR references its GitHub issue and includes
`Closes #<n>`.

```
E1 (#864)  Design doc only ─────────────────────────────┐
                                                        ▼
P0 (#865)  Scaffold alpha01 + themes + mobile shell ────┤
                                                        ▼
P1 (#866)  ReviewReceipt + Checklist + Mode + home ───┤
                                                        ▼
P2 (#867)  Journey B1 + defi-client core ─────────────┤
                                                        ▼
P3 (#868)  Journeys L1 + M1 ──────────────────────────┘
```

### PR E1 — Design doc (this file)

- **Files:** `docs/DesignsAndPlans/Alpha01NaiveFrontendPlan.md`, release fragment  
- **Issues:** Closes #864  
- **Verify:** `git diff --check`, handbook review  

### PR P0 — Scaffold

- **Scope:** `apps/alpha01` Vite app, wrangler, theme tokens, `MobileShell`,
  wagmi/connectkit bootstrap, placeholder intent home, `.env.example`  
- **Issues:** Closes #865  
- **Verify:** tsc, CDP shell screenshots  
- **Non-goals:** No on-chain writes  

### PR P1 — Shared UX primitives

- **Scope:** `ReviewReceipt`, `EligibilityChecklist`, `ModeContext`, intent home
  cards, `packages/defi-client` package scaffold (types only)  
- **Issues:** Closes #866  
- **Verify:** Vitest + CDP  

### PR P2 — Journey B1

- **Scope:** `packages/defi-client` implement accept/repay/claim; borrow wizard;
  position command center; indexer offer matching  
- **PF IDs:** PF-001, PF-002, PF-003, PF-004, PF-023, PF-090, PF-024, PF-110,
  PF-113  
- **Issues:** Closes #867  
- **Verify:** Playwright B1 smoke + CDP + targeted hooks tests  

### PR P3 — Journeys L1 + M1

- **Scope:** Lend wizard (fund borrower offer), positions list, lender claim path  
- **PF IDs:** L1 set in `BasicUserJourneyMap.md`  
- **Issues:** Closes #868  
- **Verify:** Playwright + CDP  

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Worker name collision | Use `vaipakam-alpha01`, not `vaipakam` |
| Duplicating defi hook bugs | Indexer-first reads; parity tests against PF IDs |
| Scope creep into defi parity | Journey map gates each phase; explicit non-goals §5.3 |
| ABI drift | `@vaipakam/contracts` only; run export script on contract changes |
| Mobile regressions | CDP 390px mandatory at phase gates |
| Advanced mode delays power users | Keep defi live; link from alpha01 More |

---

## 11. Open decisions (resolve during P0/P1)

1. **i18n:** English-only P0–P3, or wire `react-i18next` keys immediately?  
   *Recommendation:* keys from day one, one locale file.  
2. **ConnectKit vs minimal wallet button:**  
   *Recommendation:* ConnectKit (proven mobile deep-link config in defi `main.tsx`).  
3. **alpha01 local dev port:** `5175` to avoid clash with defi `5174`.  
4. **Cutover:** hard redirect vs banner on defi — operator call after P3 green.

---

## 12. Acceptance criteria (epic #863)

- [ ] This design doc merged  
- [ ] `alpha01.vaipakam.com` serves scaffold (P0)  
- [ ] B1 completable on mobile in Basic mode, light + dark (P2)  
- [ ] L1 + M1 acceptance checks pass (P3)  
- [ ] Zero edits under `apps/defi` across the epic  
- [ ] `packages/defi-client` exists with no `apps/defi` imports