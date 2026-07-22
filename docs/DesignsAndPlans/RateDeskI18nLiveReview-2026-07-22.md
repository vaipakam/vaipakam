# Rate Desk i18n — live translation-quality review (2026-07-22)

**Scope.** The 23 `copy.desk.*` keys extracted in PR #1403 (the advanced
Rate-Desk hardcoded-string burn-down), reviewed across all 9 shipping
non-English locales — `zh, ta, de, fr, es, ar, ja, ko, hi`.

**Purpose.** This is a *meaning* review, not a parity check. Key/placeholder
parity was already enforced mechanically at merge (`i18n:template` +
`check-hardcoded-strings`). Here we ask the question the machine can't:
**does each translation carry the intended meaning in the platform's
context, or is it a literal word-swap that a real user in that language
would find wrong, ambiguous, or unnatural?** Anything flagged 🔴 or ⚠️
is a candidate for a follow-up wording fix; 🔵 marks a deliberate
code-switch posture to *confirm*, not a defect.

**Intended-behaviour source.** Meanings below are grounded in
`docs/FunctionalSpecs/ProjectDetailsREADME.md` (order-book / signed-offer /
fill / match semantics) and `docs/FunctionalSpecs/TokenomicsTechSpec.md`
(bps rate, Loan Initiation Fee, settlement) — the code-free intended-behaviour
spec, never the contract code.

---

## Live-deploy verification (post-#1403 production deploy)

Per the CLAUDE.md live-review DoD, this change ships to a deployed `apps/*`
surface (alpha02.vaipakam.com) and gets a live review after the production
deploy.

- **Production carries #1403 — confirmed at the asset level.** The deployed
  English catalog chunk (`/assets/copy-*.js`) contains every new desk source
  string sampled — `quoted mid`, `Loading recent fills`, `bps stored on-chain`,
  `partial repay OK`, `Reading the offer…`, `loan asset` — plus the
  `loanStatus` map keys (`fallback_pending`, `internal_matched`) and the
  templated placeholders (`mid {{rate}}`, `spread {{spread}}`). The reviewed
  code is live; the per-locale JSON bundles ship in the same immutable build.
- **Browser walkthrough limitation (be honest).** The visual per-language
  render walk could **not** be driven from this review sandbox: Chromium page
  navigation to `alpha02.vaipakam.com` returns `net::ERR_CONNECTION_RESET` on
  both direct egress and via the agent proxy (the sandbox gateway resets
  Chromium's TLS; `curl` succeeds because it is an allow-listed tool path).
  This is exactly the class the `e2e/live/README.md` `LIVE_PROXY_SETUP`
  undici-shim exists for. **Action for the operator:** run the committed
  browser drive (or the scratch capture `live-desk-i18n-capture.mjs`) from an
  operator machine / a `LIVE_PROXY_SETUP`-shimmed run to eyeball each locale's
  desk rendering — the semantic findings below are the checklist to eyeball
  against.

The translation-quality findings themselves do **not** depend on the browser
render — they are a review of the shipped bundle text against intended meaning,
which is exactly what this document exists to capture so the wording can be
altered.

---

## Intended meaning of each string (the "as intended" anchor)

| Key | English | What it must convey |
| --- | --- | --- |
| `lastFillTitle` | `{{bps}} bps · loan #{{loanId}}` | Tooltip on the last-fill header: the **rate (bps)** of the most-recently executed loan and its **loan number**. |
| `tapeLoading` | `Loading recent fills…` | The **tape** (time-and-sales feed of recently *executed* loans) is loading. "fills" = executed trades. |
| `tapeRowTitle` | `{{bps}} bps · loan #{{loanId}} · {{status}}` | Per tape row: rate, loan number, lifecycle status. |
| `ladderMidTitle` | `{{bps}} bps quoted mid` | Tooltip on the ladder mid row: the **quoted midpoint** rate (between best bid and best ask). |
| `ladderMid` | `mid {{rate}}` | Mid-row body: "midpoint = rate". |
| `ladderSpread` | ` · spread {{spread}}` | Appended: the **bid–ask spread**. Leading space + `·` preserved (concatenated). |
| `loanStatus.active` | `active` | Raw indexer lifecycle word — loan is live. |
| `loanStatus.repaid` | `repaid` | Loan fully repaid. |
| `loanStatus.defaulted` | `defaulted` | Grace period expired without repayment. |
| `loanStatus.liquidated` | `liquidated` | Collateral liquidated (HF/time path). |
| `loanStatus.settled` | `settled` | Terminal settlement complete. |
| `loanStatus.fallback_pending` | `settling` | Settlement in progress (fallback path). |
| `loanStatus.internal_matched` | `matched` | Two offers matched into a loan. |
| `match.pairTitle` | `{{rate}} bps · offers #{{lenderId}} × #{{borrowerId}}` | Crossable-band strip tooltip: the match rate and the **two orders** (lender × borrower) that would cross. "offers" = standing orders. |
| `signed.close` / `orders.close` | `Close` | Dismiss a panel. |
| `ticket.legLoanAsset` | `loan asset` | Order-ticket leg label: the **principal / loan** asset. |
| `ticket.legCollateral` | `collateral` | Order-ticket leg label: the **collateral** asset. |
| `orders.readingValues` | `Reading the offer’s live values…` | Loading state while reading an offer's **live on-chain values** for amend. |
| `orders.rateUnit` | `bps stored on-chain` | Helper: the amend rate field is in **bps, as stored on-chain**. |
| `positions.daysLeft` | `{{days}}d left` | Compact chip: days remaining until due. |
| `positions.daysOverdue` | `{{days}}d overdue` | Compact chip: days past due. |
| `positions.partialRepayOk` | ` · partial repay OK` | The loan **permits partial repayment**. Leading space + `·` preserved. |

Verdict legend: ✅ idiomatic & correct · ⚠️ acceptable but improvable ·
🔴 should alter (wrong / ambiguous / misleading) · 🔵 intentional code-switch
(confirm posture).

---

## 中文 — Simplified Chinese (`zh`)

Overall: **high quality**, idiomatic finance Chinese throughout. `成交`
(executed trade) for "fill", `价差` for "spread", `报价中间价` for "quoted mid"
are all the correct market terms.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `正在加载最近成交…` | ✅ | `成交` is the exact term for executed fills. |
| ladderMidTitle | `{{bps}} bps 报价中间价` | ✅ | Correct. |
| ladderMid | `中间价 {{rate}}` | ✅ | |
| ladderSpread | ` · 价差 {{spread}}` | ✅ | Exact term. |
| loanStatus.* | 活跃/已还款/已违约/已清算/已结算/结算中/已匹配 | ✅ | All correct; `已结算`(settled) vs `结算中`(settling) cleanly distinguished. |
| match.pairTitle | `{{rate}} bps · 报价 #… × #…` | ⚠️ | `报价` = "quote". Fine, but confirm "offer/order" is rendered consistently across the app (elsewhere it may be `订单`/`挂单`). Consistency, not correctness. |
| ticket.legCollateral | `抵押品` | ✅ | Exact. |
| positions.daysLeft / daysOverdue | `剩 {{days}} 天` / `逾期 {{days}} 天` | ✅ | `逾期` is the precise term for "overdue". |
| partialRepayOk | ` · 支持部分还款` | ✅ | Natural. |

**Alterations:** none required. Optional: verify `offer` term consistency
(`报价` vs `订单`) app-wide.

---

## தமிழ் — Tamil (`ta`)

Overall: correct and readable, but two term choices risk **misreading** and
should get a native-speaker second look.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `சமீபத்திய நிறைவேற்றங்களை ஏற்றுகிறது…` | ⚠️ | `நிறைவேற்றம்` = "execution/fulfilment" — abstract for a trade *fill*; understandable, no better common Tamil term exists. Leave unless a native reviewer prefers `நிறைவேற்றப்பட்ட கடன்கள்`. |
| match.pairTitle | `{{rate}} bps · சலுகைகள் #… × #…` | 🔴 | **`சலுகை` most commonly means "concession / discount / privilege", not a trading "offer/order".** Risks reading as "discounts". Recommend a term for standing orders/offers (or transliteration `ஆஃபர்கள்`) and align with how `offer` is translated elsewhere in the ta bundle. |
| orders.readingValues | `சலுகையின் நேரடி மதிப்புகளைப் படிக்கிறது…` | 🔴 | Same `சலுகை` = offer issue as above. Fix together. |
| orders.rateUnit | `சங்கிலியில் bps ஆக சேமிக்கப்பட்டது` | 🔴 | `சங்கிலியில்` = "in the (physical) chain". "On-chain" is not a physical chain — reads oddly. Recommend `ஆன்-செயின்` (translit) or `பிளாக்செயினில்`. |
| ladderMidTitle / ladderMid | `மேற்கோள் நடுவிகிதம்` / `நடு {{rate}}` | ⚠️ | Coined `நடுவிகிதம்` (mid-rate) / terse `நடு` (middle) — understandable but non-standard; native review to confirm the coinage reads as "midpoint rate". |
| ladderSpread | ` · ஸ்ப்ரெட் {{spread}}` | ⚠️ | Transliteration — honest (no common Tamil term). OK. |
| loanStatus.defaulted / liquidated | `தவறியது` / `கலைக்கப்பட்டது` | ⚠️ | `தவறியது` = "missed/erred" (soft for *defaulted*); `கலைக்கப்பட்டது` = "dissolved" (borderline for *liquidated*). Terse status words — acceptable, but confirm with a native reviewer. |
| ticket.legCollateral | `பிணையம்` | ✅ | Correct. |
| positions.daysOverdue | `{{days}} நாள் தாமதம்` | ✅ | `தாமதம்` = delay; reads fine as overdue. |
| partialRepayOk | ` · பகுதி திருப்பிச் செலுத்தல் சரி` | ✅ | Correct. |

**Alterations (priority):** (1) `சலுகை` → a proper "offer/order" term in
`match.pairTitle` + `orders.readingValues`; (2) `சங்கிலியில்` → on-chain
transliteration in `orders.rateUnit`; (3) native review of the mid/spread
coinages and the defaulted/liquidated status words.

---

## Deutsch — German (`de`)

Overall: **high quality**. `Ausführungen` for "fills" is exactly right.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `Letzte Ausführungen werden geladen…` | ✅ | `Ausführung` = order execution. Perfect. |
| ladderMidTitle | `{{bps}} bps quotierte Mitte` | ⚠️ | Understandable, but the standard German market term for mid price is **`Mittelkurs`**. Prefer `quotierter Mittelkurs`. |
| ladderMid | `Mitte {{rate}}` | ⚠️ | `Mitte` alone = "middle". Consider `Mittelkurs` (or leave terse). |
| loanStatus.* | aktiv/zurückgezahlt/ausgefallen/liquidiert/abgewickelt/wird abgewickelt/gematcht | ✅ | `ausgefallen`(defaulted) is the exact term. `gematcht` is a trading-UI Anglicism — fine; `zugeordnet` if a more formal register is wanted. |
| match.pairTitle | `… · Angebote #… × #…` | ✅ | `Angebot` = offer. Correct. |
| ticket.legCollateral | `Sicherheit` | ✅ | Correct. |
| positions.daysLeft / daysOverdue | `{{days}} T übrig` / `{{days}} T überfällig` | ⚠️ | **`T` is not a normal German abbreviation for `Tag`.** Prefer `Tg.`, or the same `d` the source uses, or spell `Tage`. `überfällig` itself is correct. |
| partialRepayOk | ` · Teilrückzahlung möglich` | ✅ | Perfect. |

**Alterations:** (1) `Mitte`/`quotierte Mitte` → `Mittelkurs`/`quotierter
Mittelkurs`; (2) day abbreviation `T` → `Tg.`/`d`/`Tage`.

---

## Français — French (`fr`)

Overall: high quality; one non-idiomatic term for "mid".

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `Chargement des exécutions récentes…` | ✅ | `exécution` = order execution. Good. |
| ladderMidTitle | `{{bps}} bps milieu coté` | 🔴 | `milieu` = "middle" spatially; **not** the French market term for a mid price. Use **`cours moyen`** (or `point médian`): `cours moyen coté`. |
| ladderMid | `milieu {{rate}}` | 🔴 | Same — `milieu` reads as physical middle. Prefer `moyen {{rate}}` / `cours moyen`. |
| ladderSpread | ` · spread {{spread}}` | ✅ | `spread` is standard in French trading. |
| loanStatus.* | actif/remboursé/en défaut/liquidé/réglé/en cours de règlement/apparié | ✅ | `apparié`(matched) is idiomatic. All correct. |
| match.pairTitle | `… · offres #… × #…` | ✅ | Correct. |
| ticket.legCollateral | `garantie` | ✅ | Correct. |
| positions.daysLeft / daysOverdue | `{{days}} j restants` / `{{days}} j de retard` | ✅ | `j` is the standard French day abbreviation. Good. |
| partialRepayOk | ` · remboursement partiel possible` | ✅ | Perfect. |

**Alterations:** `milieu` → `cours moyen` (both `ladderMidTitle` and
`ladderMid`).

---

## Español — Spanish (`es`)

Overall: high quality; one Anglicism and a slightly loose "mid".

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `Cargando ejecuciones recientes…` | ✅ | `ejecución` = order execution. Good. |
| ladderMidTitle | `{{bps}} bps medio cotizado` | ⚠️ | `medio` can read as "half/average"; **`punto medio cotizado`** is clearer for a midpoint. |
| ladderMid | `medio {{rate}}` | ⚠️ | Same; consider `pto. medio {{rate}}`. |
| loanStatus.defaulted | `en default` | 🔴 | **Anglicism.** Spanish uses **`en mora`** or `impagado`/`incumplido`. Recommend `en mora`. |
| loanStatus.settled / settling | `saldado` / `saldándose` | ✅ | Correct. |
| match.pairTitle | `… · ofertas #… × #…` | ✅ | Correct. |
| ticket.legCollateral | `garantía` | ✅ | Correct. |
| positions.daysLeft / daysOverdue | `{{days}} d restantes` / `{{days}} d de retraso` | ✅ | Good. |
| partialRepayOk | ` · reembolso parcial permitido` | ✅ | Good. |

**Alterations:** (1) `en default` → `en mora`; (2) optional `medio` →
`punto medio`.

---

## العربية — Arabic (`ar`, RTL)

Overall: **very high quality**, precise finance Arabic. `متعثر`(defaulted),
`مُصفّى`(liquidated), `تسوية`(settlement), `مطابقة`(matched) are all exact.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `جارٍ تحميل عمليات التنفيذ الأخيرة…` | ✅ | "recent executions". Clear. |
| ladderMidTitle | `{{bps}} bps متوسط السعر المعروض` | ✅ | "quoted mid price". Good. |
| ladderMid | `الوسط {{rate}}` | ⚠️ | `الوسط` = "the middle/center"; the title uses `متوسط` (mid/average). Prefer `متوسط` here too for consistency. |
| ladderSpread | ` · الفارق {{spread}}` | ✅ | `الفارق` (the gap/difference) reads well as spread. |
| loanStatus.* | نشط/مسدد/متعثر/مُصفّى/مُسوّى/قيد التسوية/مُطابَق | ✅ | Excellent, exact terms. |
| match.pairTitle | `… · عروض #… × #…` | ✅ | `عروض` = offers. Correct. |
| ticket.legCollateral | `الضمان` | ✅ | Correct. |
| positions.daysLeft / daysOverdue | `{{days}} يوم متبقٍ` / `{{days}} يوم تأخير` | ⚠️ | Number–noun agreement is imperfect: Arabic uses `أيام` (plural) for 3–10 and `يوم` (singular) for 11+; a fixed `يوم` can't be grammatically correct for every count. A known compact-chip compromise (i18next has no easy Arabic count-form here without CLDR plurals) — acceptable, note for a future plural pass. |
| partialRepayOk | ` · السداد الجزئي متاح` | ✅ | "partial repayment available". Good. |

**Alterations:** (1) `الوسط` → `متوسط` in `ladderMid` for consistency; (2)
optional future: Arabic plural forms for the day chips (needs CLDR plural
wiring — a `days` param currently sidesteps plural machinery by design).

---

## 日本語 — Japanese (`ja`)

Overall: **excellent, professional finance Japanese.** `約定`(fill),
`仲値`(mid), `気配`(quote) are the precise market terms — the best of the set.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `直近約定を読み込み中…` | ✅ | `約定`(yakujō) is *the* term for a trade fill. Excellent. |
| ladderMidTitle | `{{bps}} bps 気配仲値` | ✅ | `気配仲値` = quoted mid. Professional. |
| ladderMid | `仲値 {{rate}}` | ✅ | Exact. |
| ladderSpread | ` · スプレッド {{spread}}` | ✅ | Standard. |
| loanStatus.* | アクティブ/返済済み/デフォルト/清算済み/決済済み/決済中/マッチ済み | ✅ | Correct; `清算`(liquidated) vs `決済`(settled) distinction holds. |
| match.pairTitle | `… · オファー #… × #…` | ✅ | Correct. |
| ticket.legCollateral | `担保` | ✅ | Exact. |
| positions.daysLeft | `残り {{days}}日` | ✅ | Natural. |
| positions.daysOverdue | `{{days}}日 超過` | ⚠️ | `超過` = "exceeded/over". The precise finance term for overdue is **`延滞`** (delinquency). Prefer `{{days}}日 延滞`. |
| partialRepayOk | ` · 一部返済可` | ✅ | Concise and correct. |

**Alterations:** `超過` → `延滞` in `positions.daysOverdue`.

---

## 한국어 — Korean (`ko`)

Overall: high quality **where translated**; `loanStatus.*` is intentionally
kept English (code-switch), matching the ko `loanState` posture.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| tapeLoading | `최근 체결 불러오는 중…` | ✅ | `체결`(chegyeol) = trade execution/fill. Exact term. |
| ladderMidTitle | `{{bps}} bps 호가 중간값` | ✅ | `호가`(quote) `중간값`(mid). Professional. |
| ladderMid | `중간값 {{rate}}` | ✅ | Good. |
| loanStatus.* | active/repaid/defaulted/liquidated/settled/settling/matched (all English) | 🔵 | **Deliberate code-switch** — ko `loanState` badges are English, so the tape tooltip status matches. *Confirm this is the desired end-state for the desk tooltip* (it is consistent with the app's ko posture). Korean equivalents exist (진행중/상환완료/부도/청산/정산 등) if you later decide to localize statuses. |
| match.pairTitle | `… · 오퍼 #… × #…` | ✅ | `오퍼` = offer. Good. |
| ticket.legCollateral | `담보` | ✅ | Exact. |
| positions.daysLeft / daysOverdue | `{{days}}일 남음` / `{{days}}일 연체` | ✅ | `연체`(overdue/delinquency) is exact. |
| partialRepayOk | ` · 부분 상환 가능` | ✅ | Good. |

**Alterations:** none required. **Decision to confirm:** English
`loanStatus.*` in the Korean tape tooltip (intentional, per ko posture).

---

## हिन्दी — Hindi (`hi`)

Overall: **heavily code-switched by design** — Hindi retains far more English
than any other locale (jargon *and* some basic UI vocab stay English). This
matches the app's established hi posture, but several items are worth a
deliberate confirm because they are basic vocabulary a Hindi user would
usually expect localized.

| Key | Shipped | Verdict | Note |
| --- | --- | --- | --- |
| lastFillTitle / tapeRowTitle | `… loan #…` | 🔵 | `loan` kept English — consistent with hi keeping loan/offer/fills English. |
| tapeLoading | `हाल के fills लोड हो रहे हैं…` | 🔵 | `fills` + `लोड` English; natural Hinglish. OK per posture. |
| ladderMidTitle | `{{bps}} bps quoted mid` | 🔵→⚠️ | **100% English** — a Hindi user sees "150 bps quoted mid". Most English-heavy string in the set. Confirm intended; at minimum consider a Hindi gloss for "quoted mid". |
| ladderMid / ladderSpread | `mid {{rate}}` / ` · spread {{spread}}` | 🔵 | English jargon retained. Consistent with the desk's jargon-stays-English rule. |
| loanStatus.* | active/repaid/…/matched (all English) | 🔵 | Deliberate — matches hi `loanState` (English). Confirm desired. |
| match.pairTitle | `{{rate}} bps · offers #… × #…` | 🔵 | `offers` English. Per posture. |
| signed.close / orders.close | `Close` | ⚠️ | **`Close` kept English** while every other locale localized it. Hindi has the common `बंद करें`. Basic UI verb — recommend localizing unless there's a reason to keep it English. |
| ticket.legLoanAsset / legCollateral | `loan asset` / `collateral` | 🔵 | English. Per posture (though `संपार्श्विक`/`गिरवी` exist for collateral). |
| orders.readingValues | `offer के live values पढ़े जा रहे हैं…` | 🔵 | Hinglish. OK. |
| orders.rateUnit | `bps में on-chain संग्रहीत` | 🔵 | Hinglish; `संग्रहीत`(stored) localized. OK. |
| positions.daysLeft / daysOverdue | `{{days}}d शेष` / `{{days}}d अतिदेय` | ✅ | `अतिदेय`(overdue) is the correct Hindi finance term — good. |
| partialRepayOk | ` · partial repay OK` | ⚠️ | **100% English.** Every other locale localized this. Consider `· आंशिक चुकौती संभव` unless kept English on purpose. |

**Alterations (all posture-dependent):** (1) localize `Close` → `बंद करें`;
(2) localize `partial repay OK` → `आंशिक चुकौती संभव`; (3) decide whether
`ladderMidTitle` should carry a Hindi gloss rather than be fully English.
None are *wrong* — they're a question of **how much English the hi desk
should retain**, which is the one cross-cutting decision this locale needs.

---

## Consolidated action list

**Should alter (semantic risk / wrong term) — 🔴**

1. **ta** `match.pairTitle` + `orders.readingValues`: `சலுகை` → proper
   "offer/order" term (currently reads as "discount/concession").
2. **ta** `orders.rateUnit`: `சங்கிலியில்` → on-chain translit
   (`ஆன்-செயின்`) — currently "in the physical chain".
3. **fr** `ladderMidTitle` + `ladderMid`: `milieu` → `cours moyen` (French
   market term for mid price).
4. **es** `loanStatus.defaulted`: `en default` (Anglicism) → `en mora`.

**Improve (acceptable but not idiomatic) — ⚠️**

5. **de** `ladderMidTitle`/`ladderMid`: `Mitte` → `Mittelkurs`.
6. **de** `positions.daysLeft`/`daysOverdue`: day abbrev `T` → `Tg.`/`d`.
7. **ja** `positions.daysOverdue`: `超過` → `延滞`.
8. **ar** `ladderMid`: `الوسط` → `متوسط` (consistency with the title).
9. **es** `ladderMidTitle`/`ladderMid`: `medio` → `punto medio` (optional).
10. **ta** native review of mid/spread coinages + defaulted/liquidated status.

**Posture decisions to confirm (not defects) — 🔵**

11. **ko** — English `loanStatus.*` in the tape tooltip (consistent with ko
    `loanState`; confirm desired for the desk).
12. **hi** — the locale retains the most English of the set; specifically
    decide on `Close`, `partial repay OK`, and the fully-English
    `ladderMidTitle`. Localize the basic-vocab ones (`Close`,
    `partial repay OK`) unless there's a reason to keep them English.

**Cross-cutting**

13. **zh / ta / etc.** — verify the word chosen for "offer/order"
    (`报价`/`சலுகை`/`Angebote`/`ofertas`/…) is consistent with how `offer`
    is rendered elsewhere in each bundle, so the desk doesn't introduce a
    second term for the same concept.

**Arabic plural (future):** the `{{days}}` day chips use a `days` param that
deliberately sidesteps CLDR plurals; Arabic (and others) would benefit from a
future plural pass if these chips get more prominence.

---

## Next step

These are wording refinements, not regressions — the extraction itself is
correct and live. Fold the 🔴 items (and any 🔵 posture decisions the user
makes) into a follow-up i18n wording PR, per-locale, re-running
`pnpm i18n:template` parity + the detector. The operator browser walk
(blocked in this sandbox) should eyeball each locale's desk against the
table above when convenient.
