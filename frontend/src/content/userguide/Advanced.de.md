# Vaipakam — Benutzerhandbuch (Advanced-Modus)

Präzise, technisch korrekte Erklärungen zu jeder Karte in der App.
Jeder Abschnitt entspricht einem `(i)`-Info-Symbol neben einem
Karten-Titel.

> **Sie lesen die Advanced-Version.** Sie entspricht dem
> **Advanced**-Modus der App (dichtere Steuerelemente, Diagnose und
> Protokoll-Konfigurationsdetails). Für die einfachere,
> alltagssprachliche Erklärung wechseln Sie die App in den
> **Basic**-Modus — öffnen Sie Einstellungen (Zahnrad-Symbol oben
> rechts) → **Modus** → **Basic**. Die "Mehr erfahren"-Links (i) in
> der App öffnen dann das Basic-Handbuch.

---

## Dashboard

<a id="dashboard.your-escrow"></a>

### Dein Escrow

Ein per-User UUPS-upgradebarer Proxy
(`VaipakamEscrowImplementation` hinter einem `ERC1967Proxy`), der
beim ersten Mal, wenn du an einem Loan teilnimmst, für dich
deployed wird. Ein Escrow pro Adresse pro Chain. Hält ERC-20-,
ERC-721- und ERC-1155-Bestände, die mit deinen Loan-Positionen
verknüpft sind. Es gibt keine Vermischung — Assets anderer Nutzer
sind niemals in diesem Vertrag.

Der Escrow-Proxy ist der kanonische Ort, an dem Collateral,
verliehene Assets und gesperrtes VPFI sitzen. Das Diamond
authentifiziert sich gegen ihn bei jedem Deposit/Withdraw; die
Implementation ist über den Protokolleigentümer mit einem Timelock
upgradebar.

<a id="dashboard.your-loans"></a>

### Deine Loans

Jeder Loan, der das verbundene Wallet auf dieser Chain einbezieht
— egal ob du auf der Lender-Seite, der Borrower-Seite oder beiden
über separate Positionen sitzt. Live aus den View-Selectors des
`LoanFacet` des Diamonds gegen deine Adresse berechnet. Jede Zeile
verlinkt auf die volle Positionsseite mit HF, LTV, aufgelaufenen
Zinsen, der Action-Surface, die durch deine Rolle + den Loan-Status
gegated ist, und der On-Chain-`loanId`, die du in einen
Block-Explorer einfügen kannst.

<a id="dashboard.vpfi-panel"></a>

### VPFI auf dieser Chain

Live-VPFI-Buchhaltung für das verbundene Wallet auf der aktiven
Chain:

- Wallet-Saldo (gelesen aus dem ERC-20).
- Escrow-Saldo (gelesen aus dem per-User-Escrow-Proxy).
- Dein Anteil am zirkulierenden Supply (nach Abzug der
  protokollgehaltenen Bestände).
- Verbleibender mintbarer Cap.

Vaipakam transportiert VPFI cross-chain über LayerZero V2. **Base
ist die kanonische Chain** — `VPFIOFTAdapter` führt dort die
Lock/Release-Semantik aus. Jede andere unterstützte Chain führt
`VPFIMirror` aus, ein reines OFT, das auf eingehenden Paketen
mintet und auf ausgehenden burnt. Der Gesamt-Supply über alle
Chains ist per Konstruktion invariant unter Bridging.

Die DVN-Policy ist **3 required + 2 optional, Threshold 1-aus-2**
nach dem April-2026-Hardening (siehe `CLAUDE.md` "Cross-Chain
Security Policy"). Die Default-1/1-DVN-Konfig wird am Deploy-Gate
abgelehnt.

<a id="dashboard.fee-discount-consent"></a>

### Zustimmung zum Gebühren-Rabatt

Wallet-level Opt-in-Flag
(`VPFIDiscountFacet.toggleVPFIDiscountConsent`), das es dem
Protokoll erlaubt, den rabattierten Anteil einer Gebühr in VPFI
abzurechnen, das bei terminalen Ereignissen aus deinem Escrow
gezogen wird. Standard: aus. Aus bedeutet, dass du 100% jeder
Gebühr im Hauptasset zahlst; an bedeutet, dass der zeitgewichtete
Rabatt gilt.

Tier-Leiter (`VPFI_TIER_TABLE`):

| Tier | Min. Escrow-VPFI | Rabatt |
| ---- | ---------------- | ------ |
| 1    | ≥ 100            | 10%    |
| 2    | ≥ 1.000          | 15%    |
| 3    | ≥ 5.000          | 20%    |
| 4    | > 20.000         | 24%    |

Tier wird gegen den **post-mutation** Escrow-Saldo via
`LibVPFIDiscount.rollupUserDiscount` berechnet, dann zeitgewichtet
über die Lebensdauer jedes Loans. Ein Unstake stempelt die BPS
sofort am neuen niedrigeren Saldo für jeden offenen Loan, an dem
du beteiligt bist, neu (schließt den Gaming-Vektor, bei dem
Pre-Phase-5-Code am Pre-Mutation-Saldo stempelte).

Der Rabatt gilt auf der Lender-Yield-Fee beim Settlement und auf
der Borrower-Loan-Initiation-Fee (ausgezahlt als VPFI-Rebate
zusammen mit `claimAsBorrower`). Siehe `TokenomicsTechSpec.md`
§5.2b und §6.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filter

Client-seitige Filter über die Lender / Borrower-Offer-Listen.
Filter nach Asset-Adresse, Seite, Status und ein paar weiteren
Achsen. Filter wirken sich nicht auf "Deine aktiven Offers" aus —
diese Liste wird immer vollständig angezeigt.

<a id="offer-book.your-active-offers"></a>

### Deine aktiven Offers

Offene Offers (Status = Active, Ablauf noch nicht erreicht), bei
denen `creator == deine Adresse`. Vor der Annahme jederzeit
stornierbar via `OfferFacet.cancelOffer(offerId)`. Die Annahme
schaltet den Offer-Status auf `Accepted` und triggert
`LoanFacet.initiateLoan`, das die zwei Position-NFTs (je einen
für Lender und Borrower) mintet und den Loan im Status `Active`
eröffnet.

<a id="offer-book.lender-offers"></a>

### Lender-Offers

Aktive Offers, bei denen der Creator bereit ist zu verleihen. Die
Annahme erfolgt durch einen Borrower; läuft über
`OfferFacet.acceptOffer` → `LoanFacet.initiateLoan`. Hartes Gate
am Diamond: `MIN_HEALTH_FACTOR = 1.5e18` wird bei der
Initiierung gegen den Collateral-Korb des Borrowers mittels der
LTV/HF-Mathematik des `RiskFacet` durchgesetzt. Der
1%-Treasury-Anteil auf Zinsen (`TREASURY_FEE_BPS = 100`) wird
beim terminalen Settlement abgezogen, nicht im Voraus.

<a id="offer-book.borrower-offers"></a>

### Borrower-Offers

Aktive Offers von Borrowern, die ihr Collateral bereits im Escrow
gesperrt haben. Die Annahme erfolgt durch einen Lender;
finanziert den Loan mit dem Hauptasset und mintet die
Position-NFTs. Gleiches HF ≥ 1.5-Gate bei der Initiierung. Die
fixe APR wird bei der Erstellung in der Offer gesetzt und ist
über die Lebensdauer des Loans unveränderlich — Refinance
erstellt einen neuen Loan.

---

## Offer erstellen

<a id="create-offer.offer-type"></a>

### Offer-Typ

Wählt aus, auf welcher Seite der Offer der Creator steht:

- **Lender** — `OfferFacet.createLenderOffer`. Der Lender stellt
  das Hauptasset und eine Collateral-Spezifikation, die der
  Borrower erfüllen muss.
- **Borrower** — `OfferFacet.createBorrowerOffer`. Der Borrower
  sperrt das Collateral im Voraus; ein Lender akzeptiert und
  finanziert.
- Sub-Typ **Rental** — für ERC-4907 (rentables ERC-721) und
  rentable ERC-1155-NFTs. Läuft über den Rental-Flow statt eines
  Schulden-Loans; der Mieter zahlt
  `duration × dailyFee × (1 + RENTAL_BUFFER_BPS / 1e4)` im Voraus,
  wobei `RENTAL_BUFFER_BPS = 500`.

<a id="create-offer.lending-asset"></a>

### Lending Asset

Spezifiziert `(asset, amount, aprBps, durationDays)` für eine
Schulden-Offer:

- `asset` — ERC-20-Vertragsadresse.
- `amount` — Principal, denominiert in den nativen Decimals des
  Assets.
- `aprBps` — fixe APR in Basis Points (1/10.000). Snapshot bei
  der Annahme; nicht reaktiv.
- `durationDays` — setzt das Gnadenfenster, bevor
  `DefaultedFacet.markDefaulted` aufrufbar ist.

Aufgelaufene Zinsen werden kontinuierlich pro Sekunde von
`loan.startTimestamp` bis zum terminalen Settlement berechnet.

<a id="create-offer.lending-asset:lender"></a>

#### Wenn du der Lender bist

Das Hauptasset und die Menge, die du bereit bist anzubieten, plus
der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird zum
Zeitpunkt der Offer fixiert; die Dauer setzt das Gnadenfenster,
bevor der Loan in Default gehen kann. Läuft über
`OfferFacet.createLenderOffer`; bei der Annahme wandert der
Principal aus deinem Escrow in den Escrow des Borrowers als Teil
von `LoanFacet.initiateLoan`.

<a id="create-offer.lending-asset:borrower"></a>

#### Wenn du der Borrower bist

Das Hauptasset und die Menge, die du vom Lender willst, plus der
Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird zum
Zeitpunkt der Offer fixiert; die Dauer setzt das Gnadenfenster,
bevor der Loan in Default gehen kann. Läuft über
`OfferFacet.createBorrowerOffer`; dein Collateral wird zum
Zeitpunkt der Offer-Erstellung in deinem Escrow gesperrt und
bleibt gesperrt, bis ein Lender akzeptiert und der Loan eröffnet
wird (oder du stornierst).

<a id="create-offer.nft-details"></a>

### NFT-Details

Felder des Rental-Sub-Typs. Spezifiziert den NFT-Vertrag +
Token-ID (und Quantity für ERC-1155), plus `dailyFeeAmount` im
Hauptasset. Bei der Annahme zieht `OfferFacet`
`duration × dailyFeeAmount × (1 + 500 / 10_000)` aus dem Escrow
des Mieters in die Verwahrung; der NFT selbst geht über `setUser`
von ERC-4907 (oder den entsprechenden ERC-1155-Hook) in einen
delegierten Zustand, sodass der Mieter Rechte hat, den NFT aber
selbst nicht übertragen kann.

<a id="create-offer.collateral"></a>

### Collateral

Collateral-Asset-Spezifikation auf der Offer. Zwei
Liquiditätsklassen:

- **Liquid** — Chainlink-Preisfeed registriert + ≥ 1 der 3
  V3-Clone-Factories (Uniswap, PancakeSwap, SushiSwap) gibt einen
  Pool mit ≥ 1 Mio. $ Tiefe am aktuellen Tick zurück (3-V3-Clone
  OR-Logic, Phase 7b.1). LTV/HF-Mathematik gilt; HF-basierte
  Liquidation läuft über `RiskFacet → LibSwap` (4-DEX-Failover:
  0x → 1inch → Uniswap V3 → Balancer V2).
- **Illiquid** — alles, was Obiges nicht erfüllt. On-Chain mit
  $0 bewertet. Keine HF-Mathematik. Im Default vollständige
  Collateral-Übertragung an den Lender. Sowohl Lender als auch
  Borrower müssen bei Offer-Erstellung / -Annahme
  `acceptIlliquidCollateralRisk`, damit die Offer landet.

Sekundärer Preis-Oracle-Quorum (Phase 7b.2): Tellor + API3 + DIA,
Soft-2-aus-N-Entscheidungsregel. Pyth entfernt.

<a id="create-offer.collateral:lender"></a>

#### Wenn du der Lender bist

Wie viel du willst, dass der Borrower sperrt, um den Loan zu
sichern. Liquide ERC-20s (Chainlink-Feed + ≥1 Mio. $
v3-Pool-Tiefe) bekommen LTV/HF-Mathematik; illiquide ERC-20s und
NFTs haben keine On-Chain-Bewertung und erfordern, dass beide
Parteien einem Voll-Collateral-bei-Default-Ergebnis zustimmen.
Das HF ≥ 1.5e18-Gate bei `LoanFacet.initiateLoan` wird gegen den
Collateral-Korb berechnet, den der Borrower bei der Annahme
präsentiert — die Anforderung hier zu dimensionieren setzt direkt
den HF-Spielraum des Borrowers.

<a id="create-offer.collateral:borrower"></a>

#### Wenn du der Borrower bist

Wie viel du bereit bist zu sperren, um den Loan zu sichern.
Liquide ERC-20s (Chainlink-Feed + ≥1 Mio. $ v3-Pool-Tiefe)
bekommen LTV/HF-Mathematik; illiquide ERC-20s und NFTs haben
keine On-Chain-Bewertung und erfordern, dass beide Parteien einem
Voll-Collateral-bei-Default-Ergebnis zustimmen. Dein Collateral
wird zum Zeitpunkt der Offer-Erstellung in deinem Escrow
gesperrt, wenn es eine Borrower-Offer ist; bei einer
Lender-Offer wird dein Collateral zum Zeitpunkt der Annahme
gesperrt. So oder so muss das HF ≥ 1.5e18-Gate bei
`LoanFacet.initiateLoan` mit dem von dir präsentierten Korb
freigegeben werden.

<a id="create-offer.risk-disclosures"></a>

### Risiko-Hinweise

Bestätigungs-Gate vor dem Absenden. Die gleiche Risikofläche
gilt für beide Seiten; die rollen-spezifischen Tabs unten
erklären, wie jedes davon je nach Seite, auf der du die Offer
signierst, anders beißt. Vaipakam ist non-custodial; es gibt
keinen Admin-Key, der eine durchgegangene Transaktion rückgängig
machen kann. Pause-Hebel gibt es nur an LZ-zugewandten Verträgen,
gegated zum Timelock; sie können keine Assets bewegen.

<a id="create-offer.risk-disclosures:lender"></a>

#### Wenn du der Lender bist

- **Smart-Contract-Risiko** — unveränderlicher Code zur Laufzeit;
  geprüft, aber nicht formal verifiziert.
- **Oracle-Risiko** — Chainlink-Veraltung oder Divergenz der
  V3-Pool-Tiefe kann eine HF-basierte Liquidation verzögern, bis
  das Collateral den Principal nicht mehr deckt. Der
  Sekundär-Quorum (Tellor + API3 + DIA, Soft-2-aus-N) fängt grobe
  Drift, aber kleine Schiefe kann die Erholung trotzdem
  schmälern.
- **Liquidations-Slippage** — der 4-DEX-Failover von `LibSwap`
  (0x → 1inch → Uniswap V3 → Balancer V2) routet zur besten
  Ausführung, die er finden kann, kann aber keinen bestimmten
  Preis garantieren. Erholung ist netto nach Slippage und dem
  1%-Treasury-Anteil auf Zinsen.
- **Defaults bei illiquidem Collateral** — Collateral geht zum
  Zeitpunkt von `markDefaulted` vollständig auf dich über. Kein
  Regress, wenn das Asset weniger wert ist als
  `principal + accruedInterest()`.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Wenn du der Borrower bist

- **Smart-Contract-Risiko** — unveränderlicher Code zur Laufzeit;
  Bugs betreffen das gesperrte Collateral.
- **Oracle-Risiko** — Veraltung oder Manipulation kann eine
  HF-basierte Liquidation gegen dich auslösen, wenn der echte
  Marktpreis sicher geblieben wäre. Die HF-Formel reagiert auf
  den Oracle-Output; ein einziger schlechter Tick, der 1.0
  kreuzt, reicht aus.
- **Liquidations-Slippage** — wenn `RiskFacet → LibSwap` auslöst,
  kann der Swap dein Collateral zu Slippage-zerfressenen Preisen
  verkaufen. Der Swap ist permissionless — jeder kann ihn in dem
  Moment auslösen, in dem HF < 1e18.
- **Defaults bei illiquidem Collateral** — `markDefaulted`
  überträgt dein gesamtes Collateral an den Lender. Kein
  Rest-Anspruch — nur ein eventuell ungenutzter VPFI-LIF-Rebate
  via `claimAsBorrower`.

<a id="create-offer.advanced-options"></a>

### Erweiterte Optionen

Weniger gebräuchliche Stellschrauben:

- `expiryTimestamp` — Offer storniert sich danach selbst. Default
  ~7 Tage.
- `useFeeDiscountForThisOffer` — lokales Override des
  Wallet-level-Consents für diese spezifische Offer.
- Rollen-spezifische Optionen, die das OfferFacet pro Seite
  exponiert.

Defaults sind für die meisten Nutzer sinnvoll.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims sind per Design Pull-Style — terminale Ereignisse lassen
Mittel in der Verwahrung von Diamond / Escrow zurück, und der
Halter des Position-NFTs ruft `claimAsLender` / `claimAsBorrower`
auf, um sie zu bewegen. Beide Arten von Claims können
gleichzeitig im selben Wallet sitzen. Die rollen-spezifischen
Tabs unten beschreiben jeden.

Jeder Claim burnt den Position-NFT des Halters atomar. Der NFT
_ist_ das Inhaber-Instrument — ihn vor dem Claimen zu übertragen
gibt dem neuen Halter das Recht zu kassieren.

<a id="claim-center.claims:lender"></a>

#### Wenn du der Lender bist

`ClaimFacet.claimAsLender(loanId)` gibt zurück:

- `principal` zurück in dein Wallet auf dieser Chain.
- `accruedInterest(loan)` minus den 1%-Treasury-Anteil
  (`TREASURY_FEE_BPS = 100`) — der Anteil wird selbst durch
  deinen zeitgewichteten VPFI-Gebühren-Rabatt-Akkumulator (Phase 5) reduziert, wenn die Zustimmung an ist.

Claimable, sobald der Loan einen terminalen Zustand erreicht
(Settled, Defaulted oder Liquidated). Der Lender-Position-NFT
wird in derselben Transaktion geburnt.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

`ClaimFacet.claimAsBorrower(loanId)` gibt je nach Settlement des
Loans zurück:

- **Volle Rückzahlung / Preclose / Refinance** — dein
  Collateral-Korb zurück, plus den zeitgewichteten VPFI-Rebate
  aus der LIF (`s.borrowerLifRebate[loanId].rebateAmount`).
- **HF-Liquidation oder Default** — nur den ungenutzten
  VPFI-LIF-Rebate (der auf diesen terminalen Pfaden null ist,
  sofern nicht ausdrücklich erhalten). Collateral ist bereits
  zum Lender gegangen.

Der Borrower-Position-NFT wird in derselben Transaktion geburnt.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

On-Chain-Ereignisse, die dein Wallet auf der aktiven Chain
betreffen, live aus den Diamond-Logs gespeist (`getLogs` über ein
gleitendes Block-Fenster). Kein Backend-Cache — jedes Laden
re-fetcht. Ereignisse werden nach `transactionHash` gruppiert,
sodass Multi-Event-Txns (z. B. accept + initiate) zusammenbleiben.
Neueste zuerst. Zeigt Offers, Loans, Rückzahlungen, Claims,
Liquidationen, NFT-Mints/-Burns und VPFI-Käufe / -Stakes /
-Unstakes.

---

## VPFI kaufen

<a id="buy-vpfi.overview"></a>

### VPFI kaufen

Zwei Pfade:

- **Kanonisch (Base)** — direkter Aufruf von
  `VPFIBuyFacet.buyVPFIWithETH` am Diamond. Mintet VPFI direkt
  in dein Wallet auf Base.
- **Off-canonical** — `VPFIBuyAdapter.buy()` auf der lokalen Chain
  schickt ein LayerZero-Paket an `VPFIBuyReceiver` auf Base, das
  das Diamond aufruft und das Ergebnis OFT-zurückschickt.
  End-to-End-Latenz ~1 Min auf L2-zu-L2-Paaren. VPFI landet im
  Wallet auf der **Origin**-Chain.

Adapter-Rate-Limits (post-Hardening): 50k VPFI pro Anfrage, 500k
rolling 24h. Über `setRateLimits` (Timelock) anpassbar.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Live-Status:

- Aktuelles Tier (0..4, aus
  `VPFIDiscountFacet.getVPFIDiscountTier`).
- Escrow-VPFI-Saldo + Delta zum nächsten Tier.
- Rabatt-BPS auf dem aktuellen Tier.
- Wallet-level Consent-Flag.

Beachte, dass Escrow-VPFI auch 5% APR über den Staking-Pool
auflaufen lässt — es gibt keine separate "Stake"-Aktion; in den
Escrow einzahlen ist Staken.

<a id="buy-vpfi.buy"></a>

### Schritt 1 — VPFI mit ETH kaufen

Reicht den Kauf ein. Auf kanonischen Chains mintet das Diamond
direkt. Auf Mirror-Chains nimmt der Buy-Adapter die Zahlung,
schickt eine LZ-Nachricht und der Receiver führt den Kauf auf
Base aus + OFT-schickt VPFI zurück. Bridge-Fee + DVN-Kosten
werden live von `useVPFIBuyBridge.quote()` quotiert und im
Formular angezeigt. VPFI wird nicht automatisch in den Escrow
eingezahlt — Schritt 2 ist explizit.

<a id="buy-vpfi.deposit"></a>

### Schritt 2 — VPFI in deinen Escrow einzahlen

`Diamond.depositVPFIToEscrow(amount)`. Auf jeder Chain
erforderlich — auch kanonisch — weil Escrow-Deposit per Spec
immer eine explizite Nutzeraktion ist. Auf Chains mit Permit2
(Phase 8b) bevorzugt die App den Single-Signature-Pfad
(`depositVPFIToEscrowWithPermit2`) gegenüber Approve + Deposit.
Fällt anmutig zurück, wenn Permit2 auf dieser Chain nicht
konfiguriert ist.

<a id="buy-vpfi.unstake"></a>

### Schritt 3 — VPFI aus deinem Escrow unstaken

`Diamond.withdrawVPFIFromEscrow(amount)`. Kein Approve-Schritt —
das Diamond besitzt den Escrow-Proxy und zieht von sich selbst
ab. Der Withdraw-Aufruf triggert
`LibVPFIDiscount.rollupUserDiscount(user, postBalance)`, sodass
der BPS-Akkumulator jedes offenen Loans sofort auf den neuen
(niedrigeren) Saldo neu gestempelt wird. Es gibt kein
Gnadenfenster, in dem das alte Tier noch gilt.

---

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Zwei Streams:

- **Staking-Pool** — Escrow-gehaltenes VPFI läuft kontinuierlich
  zu 5% APR auf. Pro-Sekunde-Verzinsung via
  `RewardFacet.pendingStaking`.
- **Interaktions-Pool** — pro-Tag-pro-rata-Anteil an einer fixen
  täglichen Emission, gewichtet nach deinem Beitrag an gesettleten
  Zinsen zum Loan-Volumen dieses Tages. Tagesfenster
  finalisieren lazy beim ersten Claim nach Fenster-Schluss.

Beide Rewards werden direkt auf der aktiven Chain geminted (kein
LZ-Round-Trip für den Nutzer; Cross-Chain-Reward-Aggregation
findet auf `VaipakamRewardOApp` nur zwischen Protokollverträgen
statt).

<a id="rewards.claim"></a>

### Rewards claimen

`RewardFacet.claimRewards()` — eine Tx, claimed beide Streams.
Staking ist immer verfügbar; Interaktion ist `0n`, bis das
relevante Tagesfenster finalisiert (Lazy-Finalisierung getriggert
durch den nächsten Nicht-Null-Claim oder das nächste Settlement
auf dieser Chain). Die UI sperrt den Button, wenn
`interactionWaitingForFinalization`, damit Nutzer nicht
unter-claimen.

<a id="rewards.withdraw-staked"></a>

### Gestaktes VPFI abheben

Identische Surface zu "Schritt 3 — Unstake" auf der
VPFI-kaufen-Seite — `withdrawVPFIFromEscrow`. Abgehobenes VPFI
verlässt den Staking-Pool sofort (Rewards hören für diesen Betrag
in diesem Block auf aufzulaufen) und verlässt den Rabatt-
Akkumulator sofort (Post-Saldo-Re-Stamp auf jedem offenen Loan).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (diese Seite)

Single-Loan-Ansicht abgeleitet aus
`LoanFacet.getLoanDetails(loanId)` plus Live-HF/LTV aus
`RiskFacet.calculateHealthFactor`. Rendert Konditionen,
Collateral-Risiko, Parteien, die durch
`getLoanActionAvailability(loan, viewerAddress)` gegatete
Action-Surface, und Inline-Keeper-Status aus `useKeeperStatus`.

<a id="loan-details.terms"></a>

### Loan Terms

Unveränderliche Bestandteile des Loans:

- `principal` (Asset + Menge).
- `aprBps` (bei Offer-Erstellung fixiert).
- `durationDays`.
- `startTimestamp`, `endTimestamp` (= `startTimestamp +
durationDays * 1 days`).
- `accruedInterest()` — View-Funktion, berechnet aus `now -
startTimestamp`.

Refinance erstellt eine frische `loanId`, statt diese zu mutieren.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risiko

Live-Risikomathematik via `RiskFacet`. **Health Factor** ist
`(collateralUsdValue × liquidationThresholdBps / 1e4) /
debtUsdValue`, skaliert auf 1e18. HF < 1e18 triggert HF-basierte
Liquidation. **LTV** ist `debtUsdValue / collateralUsdValue`.
Liquidations-Threshold = das LTV, bei dem die Position
liquidierbar wird; hängt von der Volatilitätsklasse des
Collateral-Korbs ab (`VOLATILITY_LTV_THRESHOLD_BPS = 11000` für
den Hochvolatilitäts-Kollaps-Fall).

Illiquides Collateral hat on-chain `usdValue == 0`; HF/LTV
kollabieren auf n/a, und der einzige terminale Pfad ist die
vollständige Übertragung im Default — beide Parteien haben bei
Offer-Erstellung über die Illiquid-Risk-Bestätigung zugestimmt.

<a id="loan-details.collateral-risk:lender"></a>

#### Wenn du der Lender bist

Der Collateral-Korb, der diesen Loan sichert, ist dein Schutz.
HF > 1e18 bedeutet, dass die Position gegenüber dem
Liquidations-Threshold überbesichert ist. Während HF gegen 1e18
driftet, dünnt dein Schutz aus; sobald HF < 1e18, kann jeder
(auch du) `RiskFacet.triggerLiquidation(loanId)` aufrufen, und
`LibSwap` routet das Collateral über den 4-DEX-Failover für dein
Hauptasset. Erholung ist netto nach Slippage.

Bei illiquidem Collateral geht der Korb im Default zum Zeitpunkt
von `markDefaulted` vollständig auf dich über — was es
tatsächlich wert ist, ist dein Problem.

<a id="loan-details.collateral-risk:borrower"></a>

#### Wenn du der Borrower bist

Dein gesperrtes Collateral. Halte HF sicher über 1e18 — übliches
Buffer-Ziel ist ≥ 1.5e18, um Volatilität auszuhalten. Hebel, um
HF anzuheben:

- `addCollateral(loanId, …)` — den Korb aufstocken; nur durch den
  Nutzer.
- Teilrückzahlung via `RepayFacet` — reduziert die Schuld, hebt
  HF.

Sobald HF < 1e18, kann jeder die HF-basierte Liquidation
auslösen; der Swap verkauft dein Collateral zu
Slippage-zerfressenen Preisen, um den Lender zurückzuzahlen. Bei
illiquidem Collateral überträgt der Default dein gesamtes
Collateral an den Lender — nur ein eventuell ungenutzter
VPFI-LIF-Rebate (`s.borrowerLifRebate[loanId].rebateAmount`)
bleibt zum Claimen.

<a id="loan-details.parties"></a>

### Parteien

`(lender, borrower, lenderEscrow, borrowerEscrow,
positionNftLender, positionNftBorrower)`. Jeder NFT ist ein
ERC-721 mit On-Chain-Metadaten; ihn zu übertragen, überträgt das
Recht zu claimen. Die Escrow-Proxies sind pro Adresse
deterministisch (CREATE2) — gleiche Adresse über Deploys hinweg.

<a id="loan-details.actions"></a>

### Aktionen

Action-Surface, pro Rolle gegated durch
`getLoanActionAvailability`. Die rollen-spezifischen Tabs unten
listen die verfügbaren Selectors jeder Seite auf. Deaktivierte
Aktionen zeigen einen Hover-Grund, abgeleitet vom Gate
(`InsufficientHF`, `NotYetExpired`, `LoanLocked` etc.).

Permissionless-Aktionen, die unabhängig von der Rolle für jeden
verfügbar sind:

- `RiskFacet.triggerLiquidation(loanId)` — wenn HF < 1e18.
- `DefaultedFacet.markDefaulted(loanId)` — wenn die Gnadenfrist
  ohne volle Rückzahlung abgelaufen ist.

<a id="loan-details.actions:lender"></a>

#### Wenn du der Lender bist

- `ClaimFacet.claimAsLender(loanId)` — nur terminal. Gibt
  Principal + Zinsen minus dem 1%-Treasury-Anteil zurück (weiter
  reduziert durch deinen zeitgewichteten VPFI-Yield-Fee-Rabatt,
  wenn die Zustimmung an ist). Burnt den Lender-Position-NFT.
- `EarlyWithdrawalFacet.initEarlyWithdrawal(loanId, askPrice)` —
  listet den Lender-NFT zum Verkauf zu `askPrice`. Ein Käufer,
  der `completeEarlyWithdrawal(saleId)` aufruft, übernimmt deine
  Seite; du erhältst den Erlös. Vor Befüllung stornierbar.
- Optional an einen Keeper delegierbar, der das relevante
  Action-Bit hält (`COMPLETE_LOAN_SALE` etc.) — siehe
  Keeper-Einstellungen.

<a id="loan-details.actions:borrower"></a>

#### Wenn du der Borrower bist

- `RepayFacet.repay(loanId, amount)` — vollständig oder
  teilweise. Teilweise reduziert den ausstehenden Saldo und hebt
  HF; vollständig triggert das terminale Settlement, einschließlich
  des zeitgewichteten VPFI-LIF-Rebates via
  `LibVPFIDiscount.settleBorrowerLifProper`.
- `PrecloseFacet.precloseDirect(loanId)` — zahle den ausstehenden
  Saldo jetzt aus deinem Wallet, gib das Collateral frei, settle
  den LIF-Rebate.
- `PrecloseFacet.initOffset(loanId, swapParams)` /
  `completeOffset(loanId)` — verkaufe einen Teil des Collaterals
  via `LibSwap`, zahle aus dem Erlös zurück, gib den Rest zurück.
- `RefinanceFacet`-Flow — poste eine Borrower-Offer für neue
  Konditionen; `completeRefinance(oldLoanId, newOfferId)` tauscht
  Loans atomar, ohne dass das Collateral den Escrow verlässt.
- `ClaimFacet.claimAsBorrower(loanId)` — nur terminal. Gibt das
  Collateral bei voller Rückzahlung zurück, oder den ungenutzten
  VPFI-LIF-Rebate bei Default / Liquidation. Burnt den
  Borrower-Position-NFT.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Listet jede ERC-20 `allowance(wallet, diamondAddress)`, die dein
Wallet dem Diamond auf dieser Chain gewährt hat. Bezogen durch
Scannen einer Kandidaten-Token-Liste gegen
`IERC20.allowance`-View-Calls. Widerruf setzt Allowance auf null
via `IERC20.approve(diamond, 0)`. Gemäß der
Exact-Amount-Approval-Policy verlangt das Protokoll niemals
unbegrenzte Allowances, daher sind Widerrufe meistens wenige.

Hinweis: Permit2-artige Flows (Phase 8b) umgehen die
Per-Asset-Allowance am Diamond, indem sie stattdessen eine
einzige Signatur verwenden, sodass eine saubere Liste hier
zukünftige Deposits nicht ausschließt.

---

## Alerts

<a id="alerts.overview"></a>

### Über Alerts

Off-Chain-Cloudflare-Worker (`hf-watcher`) pollt jeden aktiven
Loan, der dein Wallet betrifft, im 5-Minuten-Takt. Liest
`RiskFacet.calculateHealthFactor` für jeden. Bei einem
Bandenwechsel in unsichere Richtung wird einmal über die
konfigurierten Kanäle ausgelöst. Kein On-Chain-State, kein Gas.
Alerts sind beratend — sie bewegen keine Mittel.

<a id="alerts.threshold-ladder"></a>

### Schwellen-Leiter

Nutzer-konfigurierte Leiter von HF-Bändern. Das Wechseln in eine
gefährlichere Bande löst einmal aus und scharft die nächste
tiefere Schwelle. Wieder über eine Bande hinaus zu kreuzen scharft
sie neu. Defaults: `1.5 → 1.3 → 1.1`. Höhere Zahlen sind für
volatiles Collateral angemessen; der einzige Job der Leiter ist,
dich rauszubekommen, bevor HF < 1e18 die Liquidation triggert.

<a id="alerts.delivery-channels"></a>

### Lieferkanäle

Zwei Schienen:

- **Telegram** — Bot-DM mit der Kurzadresse des Wallets +
  Loan-ID + aktuellem HF.
- **Push Protocol** — Wallet-direkte Benachrichtigung über den
  Vaipakam-Push-Channel.

Beide teilen sich die Schwellen-Leiter; Per-Channel-Warn-Levels
werden absichtlich nicht exponiert (vermeidet Drift). Das
Push-Channel-Publishing ist gestubbt, bis der Channel erstellt
wird — siehe Phase-8a-Notizen.

---

## NFT-Verifier

<a id="nft-verifier.lookup"></a>

### Verifiziere einen NFT

Bei `(nftAddress, tokenId)` werden geholt:

- `IERC721.ownerOf(tokenId)` (oder Burn-Selector `0x7e273289`
  => bereits geburnt).
- `IERC721.tokenURI(tokenId)` → On-Chain-JSON-Metadaten.
- Diamond-Cross-Check: leitet die zugrundeliegende `loanId` aus
  den Metadaten ab und liest `LoanFacet.getLoanDetails(loanId)`,
  um den Status zu bestätigen.

Zeigt: minted-by-Vaipakam? welche Chain? Loan-Status? aktueller
Halter? Lässt dich eine Fälschung, eine bereits geclaimte
(geburnte) Position oder eine Position erkennen, deren Loan
gesettled ist und mid-claim steht.

Der Position-NFT ist das Inhaber-Instrument — verifizieren, bevor
auf einem Sekundärmarkt gekauft wird.

---

## Keeper-Einstellungen

<a id="keeper-settings.overview"></a>

### Über Keeper

Per-Wallet-Keeper-Whitelist (`KeeperSettingsFacet`) von bis zu 5
Keepern (`MAX_KEEPERS = 5`). Jeder Keeper hat eine
Action-Bitmask (`KEEPER_ACTION_*`), die spezifische
Wartungsaufrufe auf **deiner Seite** eines Loans autorisiert.
Money-Out-Pfade (Repay, Claim, addCollateral, Liquidate) sind
per Design nur für den Nutzer und können nicht delegiert werden.

Zwei zusätzliche Gates greifen zur Aktionszeit:

1. Keeper-Master-Access-Switch (One-Flip-Notbremse;
   deaktiviert jeden Keeper, ohne die Allowlist anzufassen).
2. Per-Loan-Opt-in-Toggle (gesetzt am Offer Book / Loan
   Details).

Ein Keeper kann nur agieren, wenn `(approved, masterOn,
perLoanOn, actionBitSet)` alle wahr sind.

<a id="keeper-settings.approved-list"></a>

### Genehmigte Keeper

Aktuell exponierte Bitmask-Flags:

- `COMPLETE_LOAN_SALE` (0x01)
- `COMPLETE_OFFSET` (0x02)
- `INIT_EARLY_WITHDRAW` (0x04)
- `INIT_PRECLOSE` (0x08)
- `REFINANCE` (0x10)

On-Chain hinzugefügte Bits, die das Frontend nicht reflektiert,
bekommen ein `InvalidKeeperActions`-Revert. Widerruf ist
`KeeperSettingsFacet.removeKeeper(addr)` und ist auf allen Loans
sofort wirksam.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Wallet-freier Aggregator, der live aus On-Chain-Diamond-View-Calls
über jede unterstützte Chain berechnet wird. Kein Backend /
Datenbank. Beteiligte Hooks: `useProtocolStats`, `useTVL`,
`useTreasuryMetrics`, `useUserStats`, `useVPFIToken`. CSV / JSON-
Export verfügbar; die Diamond-Adresse + View-Funktion für jede
Metrik wird zur Verifizierbarkeit angezeigt.

<a id="public-dashboard.combined"></a>

### Kombiniert — Alle Chains

Cross-Chain-Rollup. Der Header berichtet `chainsCovered` und
`chainsErrored`, sodass ein nicht erreichbarer RPC zur Fetch-Zeit
explizit ist. `chainsErrored > 0` heißt, dass die Pro-Chain-
Tabelle markiert, welche — TVL-Summen werden trotzdem berichtet,
erkennen aber die Lücke an.

<a id="public-dashboard.per-chain"></a>

### Aufschlüsselung pro Chain

Pro-Chain-Aufteilung der kombinierten Metriken. Nützlich, um
TVL-Konzentration, nicht zueinander passende VPFI-Mirror-Supplies
(Summe sollte dem Lock-Saldo des kanonischen Adapters
entsprechen) oder stillstehende Chains zu erkennen.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token-Transparenz

On-Chain-VPFI-Buchhaltung auf der aktiven Chain:

- `totalSupply()` — ERC-20-nativ.
- Zirkulierender Supply — `totalSupply()` minus
  protokollgehaltene Bestände (Treasury, Reward-Pools,
  in-flight LZ-Pakete).
- Verbleibender mintbarer Cap — abgeleitet aus `MAX_SUPPLY -
totalSupply()` auf Kanonisch; Mirror-Chains berichten `n/a`
  für den Cap (Mints dort sind bridge-getrieben).

Cross-Chain-Invariante: Summe der `VPFIMirror.totalSupply()`
über alle Mirror-Chains == `VPFIOFTAdapter.lockedBalance()` auf
Kanonisch. Watcher überwacht und alarmiert bei Drift.

<a id="public-dashboard.transparency"></a>

### Transparenz & Quelle

Für jede Metrik werden gelistet:

- Die als Snapshot verwendete Block-Nummer.
- Daten-Aktualität (max. Staleness über Chains hinweg).
- Die Diamond-Adresse und der View-Funktionsaufruf.

Jeder kann jede Zahl auf dieser Seite aus
`(rpcUrl, blockNumber, diamondAddress, fnName)` neu ableiten —
das ist der Maßstab.

---

## Refinance

Diese Seite ist nur für Borrower — Refinance wird vom Borrower
auf dem Loan des Borrowers initiiert.

<a id="refinance.overview"></a>

### Über Refinancing

`RefinanceFacet` — zahlt deinen bestehenden Loan atomar aus
neuem Principal ab und eröffnet einen frischen Loan mit den
neuen Konditionen, alles in einer Tx. Collateral bleibt die
ganze Zeit in deinem Escrow — kein ungesichertes Fenster. Der
neue Loan muss bei der Initiierung `MIN_HEALTH_FACTOR = 1.5e18`
genauso bestehen wie jeder andere Loan.

`LibVPFIDiscount.settleBorrowerLifProper(oldLoan)` wird auf dem
alten Loan als Teil des Tauschs aufgerufen, sodass jeder
ungenutzte LIF-VPFI-Rebate korrekt gutgeschrieben wird.

<a id="refinance.position-summary"></a>

### Deine aktuelle Position

Snapshot des refinanzierten Loans — `loan.principal`, aktueller
`accruedInterest()`, HF/LTV, Collateral-Korb. Die neue Offer
sollte mindestens den ausstehenden Betrag dimensionieren
(`principal + accruedInterest()`); jeglicher Überschuss auf der
neuen Offer wird als freier Principal an deinen Escrow
geliefert.

<a id="refinance.step-1-post-offer"></a>

### Schritt 1 — Poste die neue Offer

Postet eine Borrower-Offer via `OfferFacet.createBorrowerOffer`
mit deinen Ziel-Konditionen. Der alte Loan lässt weiterhin Zinsen
auflaufen; das Collateral bleibt gesperrt. Die Offer erscheint
im öffentlichen Offer Book, und jeder Lender kann sie
akzeptieren. Du kannst vor der Annahme stornieren.

<a id="refinance.step-2-complete"></a>

### Schritt 2 — Abschließen

`RefinanceFacet.completeRefinance(oldLoanId, newOfferId)` —
atomar:

1. Finanziert den neuen Loan vom akzeptierenden Lender.
2. Zahlt den alten Loan vollständig zurück (Principal + Zinsen,
   abzüglich Treasury-Anteil).
3. Burnt die alten Position-NFTs.
4. Mintet die neuen Position-NFTs.
5. Settled den LIF-Rebate des alten Loans via
   `LibVPFIDiscount.settleBorrowerLifProper`.

Revertet bei HF < 1.5e18 auf den neuen Konditionen.

---

## Preclose

Diese Seite ist nur für Borrower — Preclose wird vom Borrower
auf dem Loan des Borrowers initiiert.

<a id="preclose.overview"></a>

### Über Preclose

`PrecloseFacet` — Borrower-getriebene vorzeitige Beendigung.
Zwei Pfade:

- **Direkt** — `precloseDirect(loanId)`. Zahlt
  `principal + accruedInterest()` aus deinem Wallet, gibt
  Collateral frei. Ruft
  `LibVPFIDiscount.settleBorrowerLifProper(loan)` auf.
- **Offset** — `initOffset(loanId, swapParams)` dann
  `completeOffset(loanId)`. Verkauft einen Teil des Collaterals
  via `LibSwap` (4-DEX-Failover) gegen das Hauptasset, zahlt aus
  dem Erlös zurück, der Rest des Collaterals geht an dich
  zurück. Gleiches LIF-Rebate-Settlement.

Keine pauschale Frühschluss-Strafe. Die zeitgewichtete
VPFI-Mathematik aus Phase 5 übernimmt die Fairness-Mathematik.

<a id="preclose.position-summary"></a>

### Deine aktuelle Position

Snapshot des in Preclose befindlichen Loans — ausstehender
Principal, aufgelaufene Zinsen, aktuelle HF/LTV. Der
Preclose-Flow erfordert beim Aussteigen **kein** HF ≥ 1.5e18
(es ist ein Schluss, kein Re-Init).

<a id="preclose.in-progress"></a>

### Offset in Bearbeitung

Status: `initOffset` ist gelandet, Swap ist mid-execution (oder
Quote verbraucht, aber finales Settle steht aus). Zwei Ausgänge:

- `completeOffset(loanId)` — settled den Loan aus dem
  realisierten Erlös, gibt den Rest zurück.
- `cancelOffset(loanId)` — abbrechen; Collateral bleibt gesperrt,
  Loan unverändert. Verwende es, wenn der Swap sich zwischen
  Init und Complete gegen dich bewegt hat.

<a id="preclose.choose-path"></a>

### Wähle einen Pfad

Der direkte Pfad verbraucht Wallet-Liquidität im Hauptasset. Der
Offset-Pfad verbraucht Collateral via DEX-Swap; bevorzugt, wenn
du das Hauptasset nicht zur Hand hast oder du auch aus der
Collateral-Position aussteigen willst. Offset-Slippage läuft
über `LibSwap`s 4-DEX-Failover (0x → 1inch → Uniswap V3 →
Balancer V2).

---

## Early Withdrawal (Lender)

Diese Seite ist nur für Lender — Early Withdrawal wird vom
Lender auf dem Loan des Lenders initiiert.

<a id="early-withdrawal.overview"></a>

### Über Lender Early Exit

`EarlyWithdrawalFacet` — Sekundärmarkt-Mechanismus für
Lender-Positionen. Du listest deinen Position-NFT zum Verkauf zu
einem gewählten Preis; bei Annahme zahlt der Käufer, das
Eigentum am Lender-NFT geht an den Käufer über, und der Käufer
wird zum Lender-of-record für jedes zukünftige Settlement
(Claim am Terminal etc.). Du gehst mit dem Verkaufserlös davon.

Liquidationen bleiben nur dem Nutzer vorbehalten und werden NICHT
über den Verkauf delegiert — nur das Recht zu claimen wird
übertragen.

<a id="early-withdrawal.position-summary"></a>

### Deine aktuelle Position

Snapshot — ausstehender Principal, aufgelaufene Zinsen,
verbleibende Zeit, aktuelle HF/LTV der Borrower-Seite. Das setzt
den fairen Preis, den der Käufermarkt erwartet: das Payoff des
Käufers ist `principal + interest` am Terminal, abzüglich
Liquidationsrisiko über die verbleibende Zeit.

<a id="early-withdrawal.initiate-sale"></a>

### Verkauf einleiten

`initEarlyWithdrawal(loanId, askPrice)`. Listet den Position-NFT
zum Verkauf via das Protokoll;
`completeEarlyWithdrawal(saleId)` ist das, was ein Käufer aufruft,
um zu akzeptieren. Vor Befüllung stornierbar via
`cancelEarlyWithdrawal(saleId)`. Optional an einen Keeper
delegierbar, der das `COMPLETE_LOAN_SALE`-Action-Bit hält; das
Init selbst bleibt nur dem Nutzer vorbehalten.
