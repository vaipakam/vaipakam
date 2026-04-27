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

Ein upgradebarer Vertrag pro Nutzer — dein privater Tresor auf
dieser Chain — der für dich beim ersten Mal, wenn du an einem
Loan teilnimmst, deployed wird. Ein Escrow pro Adresse pro Chain.
Hält ERC-20-, ERC-721- und ERC-1155-Bestände, die mit deinen
Loan-Positionen verknüpft sind. Es gibt keine Vermischung: Assets
anderer Nutzer sind niemals in diesem Vertrag.

Der Escrow ist der einzige Ort, an dem Collateral, verliehene
Assets und dein gesperrtes VPFI sitzen. Das Protokoll
authentifiziert sich gegen ihn bei jedem Deposit und Withdraw.
Die Implementation kann durch den Protokolleigentümer aktualisiert
werden, aber nur über einen Timelock — niemals sofort.

<a id="dashboard.your-loans"></a>

### Deine Loans

Jeder Loan, der das verbundene Wallet auf dieser Chain einbezieht
— egal ob du auf der Lender-Seite, der Borrower-Seite oder beiden
über separate Positionen sitzt. Live aus den View-Methoden des
Protokolls gegen deine Adresse berechnet. Jede Zeile verlinkt auf
die volle Positionsseite mit HF, LTV, aufgelaufenen Zinsen, der
durch deine Rolle und den Loan-Status gegateten Action-Surface,
und der On-Chain-Loan-ID, die du in einen Block-Explorer einfügen
kannst.

<a id="dashboard.vpfi-panel"></a>

### VPFI auf dieser Chain

Live-VPFI-Buchhaltung für das verbundene Wallet auf der aktiven
Chain:

- Wallet-Saldo.
- Escrow-Saldo.
- Dein Anteil am zirkulierenden Supply (nach Abzug der
  protokollgehaltenen Bestände).
- Verbleibender mintbarer Cap.

Vaipakam transportiert VPFI cross-chain über LayerZero V2. **Base
ist die kanonische Chain** — der kanonische Adapter dort führt die
Lock-on-Send/Release-on-Receive-Semantik aus. Jede andere
unterstützte Chain führt einen Mirror aus, der bei eingehenden
Bridge-Paketen mintet und bei ausgehenden burnt. Der
Gesamt-Supply über alle Chains bleibt per Konstruktion invariant
unter Bridging.

Die nach dem Industrievorfall im April 2026 gehärtete
Cross-Chain-Nachrichten-Verifizierungspolicy lautet **3 erforderlich
+ 2 optional, Threshold 1-aus-2**. Die Standard-Konfiguration mit
einem einzigen Verifier wird am Deploy-Gate abgelehnt.

<a id="dashboard.fee-discount-consent"></a>

### Zustimmung zum Gebühren-Rabatt

Ein Wallet-Level-Opt-in-Flag, das es dem Protokoll erlaubt, den
rabattierten Anteil einer Gebühr in VPFI abzurechnen, das bei
terminalen Ereignissen aus deinem Escrow gezogen wird. Standard:
aus. Aus bedeutet, dass du 100% jeder Gebühr im Hauptasset
zahlst; an bedeutet, dass der zeitgewichtete Rabatt gilt.

Tier-Leiter:

| Tier | Min. Escrow-VPFI | Rabatt |
| ---- | ---------------- | ------ |
| 1    | ≥ 100            | 10%    |
| 2    | ≥ 1.000          | 15%    |
| 3    | ≥ 5.000          | 20%    |
| 4    | > 20.000         | 24%    |

Tier wird gegen deinen **Saldo nach Änderung** im Moment des
Einzahlens oder Abhebens von VPFI berechnet, dann zeitgewichtet
über die Lebensdauer jedes Loans. Ein Unstake stempelt den Rabatt
sofort am neuen niedrigeren Saldo für jeden offenen Loan, an dem
du beteiligt bist, neu — es gibt kein Gnadenfenster, in dem dein
altes (höheres) Tier noch gilt. Das schließt das
Gaming-Verhalten, bei dem ein Nutzer kurz vor Loan-Ende VPFI
aufladen, den vollen Tier-Rabatt einsacken und Sekunden später
abheben könnte.

Der Rabatt gilt auf der Lender-Yield-Fee beim Settlement und auf
der Borrower-Loan-Initiation-Fee (ausgezahlt als VPFI-Rebate, wenn
der Borrower claimt).

---

## Offer Book

<a id="offer-book.filters"></a>

### Filter

Client-seitige Filter über die Lender / Borrower-Offer-Listen.
Filter nach Asset, Seite, Status und ein paar weiteren Achsen.
Filter wirken sich nicht auf "Deine aktiven Offers" aus — diese
Liste wird immer vollständig angezeigt.

<a id="offer-book.your-active-offers"></a>

### Deine aktiven Offers

Offene Offers (Status Active, Ablauf noch nicht erreicht), die du
erstellt hast. Vor der Annahme jederzeit stornierbar — die
Stornierung ist kostenlos. Die Annahme schaltet die Offer auf
Accepted und triggert die Loan-Initiierung, die die zwei
Position-NFTs (je einen für Lender und Borrower) mintet und den
Loan im Status Active eröffnet.

<a id="offer-book.lender-offers"></a>

### Lender-Offers

Aktive Offers, bei denen der Creator bereit ist zu verleihen. Die
Annahme erfolgt durch einen Borrower. Hartes Gate bei der
Initiierung: Der Collateral-Korb des Borrowers muss einen Health
Factor von mindestens 1,5 gegenüber der Principal-Anforderung des
Lenders erzeugen. Die HF-Mathematik ist die des Protokolls — das
Gate ist nicht umgehbar. Der 1%-Treasury-Anteil auf Zinsen wird
beim terminalen Settlement abgezogen, nicht im Voraus.

<a id="offer-book.borrower-offers"></a>

### Borrower-Offers

Aktive Offers von Borrowern, die ihr Collateral bereits im Escrow
gesperrt haben. Die Annahme erfolgt durch einen Lender;
finanziert den Loan mit dem Hauptasset und mintet die
Position-NFTs. Gleiches HF ≥ 1,5-Gate bei der Initiierung. Die
fixe APR wird bei der Erstellung in der Offer gesetzt und ist
über die Lebensdauer des Loans unveränderlich — Refinance erstellt
einen neuen Loan, statt den existierenden zu mutieren.

---

## Offer erstellen

<a id="create-offer.offer-type"></a>

### Offer-Typ

Wählt aus, auf welcher Seite der Offer der Creator steht:

- **Lender** — der Lender stellt das Hauptasset und eine
  Collateral-Spezifikation, die der Borrower erfüllen muss.
- **Borrower** — der Borrower sperrt das Collateral im Voraus;
  ein Lender akzeptiert und finanziert.
- Sub-Typ **Rental** — für ERC-4907 (rentables ERC-721) und
  rentable ERC-1155-NFTs. Läuft über den Rental-Flow statt eines
  Schulden-Loans; der Mieter zahlt die volle Mietkosten im
  Voraus (Dauer × tägliche Gebühr) plus 5% Buffer.

<a id="create-offer.lending-asset"></a>

### Lending Asset

Für eine Schulden-Offer spezifizierst du das Asset, den Principal,
die fixe APR und die Dauer in Tagen:

- **Asset** — der ERC-20, der verliehen / geliehen wird.
- **Menge** — Principal, denominiert in den nativen Decimals
  des Assets.
- **APR** — fixe Jahresrate in Basis Points (Hundertstel
  Prozent), bei der Annahme als Snapshot festgehalten und
  danach nicht mehr reaktiv.
- **Dauer in Tagen** — setzt das Gnadenfenster, bevor ein
  Default ausgelöst werden kann.

Aufgelaufene Zinsen werden kontinuierlich pro Sekunde vom Start
des Loans bis zum terminalen Settlement berechnet.

<a id="create-offer.lending-asset:lender"></a>

#### Wenn du der Lender bist

Das Hauptasset und die Menge, die du bereit bist anzubieten,
plus der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz
wird zum Zeitpunkt der Offer fixiert; die Dauer setzt das
Gnadenfenster, bevor der Loan in Default gehen kann. Bei der
Annahme wandert der Principal aus deinem Escrow in den Escrow
des Borrowers als Teil der Loan-Initiierung.

<a id="create-offer.lending-asset:borrower"></a>

#### Wenn du der Borrower bist

Das Hauptasset und die Menge, die du vom Lender willst, plus
der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird
zum Zeitpunkt der Offer fixiert; die Dauer setzt das
Gnadenfenster, bevor der Loan in Default gehen kann. Dein
Collateral wird zum Zeitpunkt der Offer-Erstellung in deinem
Escrow gesperrt und bleibt gesperrt, bis ein Lender akzeptiert
und der Loan eröffnet wird (oder du stornierst).

<a id="create-offer.nft-details"></a>

### NFT-Details

Felder des Rental-Sub-Typs. Spezifiziert den NFT-Vertrag und die
Token-ID (und die Quantity für ERC-1155), plus die tägliche
Mietgebühr im Hauptasset. Bei der Annahme zieht das Protokoll die
vorausbezahlte Miete aus dem Escrow des Mieters in die
Verwahrung — das ist Dauer × tägliche Gebühr, plus 5% Buffer.
Der NFT selbst geht in einen delegierten Zustand (über
ERC-4907-Nutzungsrechte oder den entsprechenden ERC-1155-Rental-
Hook), sodass der Mieter Rechte hat, den NFT aber selbst nicht
übertragen kann.

<a id="create-offer.collateral"></a>

### Collateral

Collateral-Asset-Spezifikation auf der Offer. Zwei
Liquiditätsklassen:

- **Liquid** — hat einen registrierten Chainlink-Preisfeed UND
  mindestens einen Uniswap V3- / PancakeSwap V3- /
  SushiSwap V3-Pool mit ≥ 1 Mio. $ Tiefe am aktuellen Tick.
  LTV- und HF-Mathematik gelten; eine HF-basierte Liquidation
  routet das Collateral durch ein 4-DEX-Failover (0x → 1inch →
  Uniswap V3 → Balancer V2).
- **Illiquid** — alles, was Obiges nicht erfüllt. On-Chain mit
  $0 bewertet. Keine HF-Mathematik. Im Default vollständige
  Collateral-Übertragung an den Lender. Beide Seiten müssen das
  Illiquid-Collateral-Risiko bei der Offer-Erstellung /
  -Annahme ausdrücklich anerkennen, damit die Offer landet.

Das Preisorakel hat einen sekundären Quorum aus drei
unabhängigen Quellen (Tellor, API3, DIA) mit einer
Soft-2-aus-N-Entscheidungsregel über dem Chainlink-Primärfeed.
Pyth wurde evaluiert und nicht übernommen.

<a id="create-offer.collateral:lender"></a>

#### Wenn du der Lender bist

Wie viel du willst, dass der Borrower sperrt, um den Loan zu
sichern. Liquide ERC-20s (Chainlink-Feed plus ≥ 1 Mio. $
v3-Pool-Tiefe) bekommen LTV- / HF-Mathematik; illiquide ERC-20s
und NFTs haben keine On-Chain-Bewertung und erfordern, dass beide
Parteien einem Voll-Collateral-bei-Default-Ergebnis zustimmen.
Das HF ≥ 1,5-Gate bei der Loan-Initiierung wird gegen den
Collateral-Korb berechnet, den der Borrower bei der Annahme
präsentiert — die Anforderung hier zu dimensionieren setzt direkt
den HF-Spielraum des Borrowers.

<a id="create-offer.collateral:borrower"></a>

#### Wenn du der Borrower bist

Wie viel du bereit bist zu sperren, um den Loan zu sichern.
Liquide ERC-20s (Chainlink-Feed plus ≥ 1 Mio. $ v3-Pool-Tiefe)
bekommen LTV- / HF-Mathematik; illiquide ERC-20s und NFTs haben
keine On-Chain-Bewertung und erfordern, dass beide Parteien einem
Voll-Collateral-bei-Default-Ergebnis zustimmen. Dein Collateral
wird zum Zeitpunkt der Offer-Erstellung in deinem Escrow
gesperrt, wenn es eine Borrower-Offer ist; bei einer
Lender-Offer wird dein Collateral zum Zeitpunkt der Annahme
gesperrt. So oder so muss das HF ≥ 1,5-Gate bei der
Loan-Initiierung mit dem von dir präsentierten Korb freigegeben
werden.

<a id="create-offer.risk-disclosures"></a>

### Risiko-Hinweise

Bestätigungs-Gate vor dem Absenden. Die gleiche Risikofläche
gilt für beide Seiten; die rollen-spezifischen Tabs unten
erklären, wie jedes davon je nach Seite, auf der du die Offer
signierst, anders beißt. Vaipakam ist non-custodial: Es gibt
keinen Admin-Key, der eine durchgegangene Transaktion rückgängig
machen kann. Pause-Hebel gibt es nur an cross-chain-zugewandten
Verträgen, gegated zu einem Timelock; sie können keine Assets
bewegen.

<a id="create-offer.risk-disclosures:lender"></a>

#### Wenn du der Lender bist

- **Smart-Contract-Risiko** — der Vertragscode ist zur Laufzeit
  unveränderlich; geprüft, aber nicht formal verifiziert.
- **Oracle-Risiko** — Chainlink-Veraltung oder Divergenz der
  Pool-Tiefe kann eine HF-basierte Liquidation verzögern, bis das
  Collateral den Principal nicht mehr deckt. Der Sekundär-Quorum
  (Tellor + API3 + DIA, Soft-2-aus-N) fängt grobe Drift, aber
  kleine Schiefe kann die Erholung trotzdem schmälern.
- **Liquidations-Slippage** — der 4-DEX-Failover routet zur
  besten Ausführung, die er finden kann, kann aber keinen
  bestimmten Preis garantieren. Erholung ist netto nach Slippage
  und dem 1%-Treasury-Anteil auf Zinsen.
- **Defaults bei illiquidem Collateral** — Collateral geht zum
  Zeitpunkt des Defaults vollständig auf dich über. Kein Regress,
  wenn das Asset weniger wert ist als der Principal plus die
  aufgelaufenen Zinsen.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Wenn du der Borrower bist

- **Smart-Contract-Risiko** — der Vertragscode ist zur Laufzeit
  unveränderlich; Bugs würden das gesperrte Collateral betreffen.
- **Oracle-Risiko** — Veraltung oder Manipulation kann eine
  HF-basierte Liquidation gegen dich auslösen, wenn der echte
  Marktpreis sicher geblieben wäre. Die HF-Formel reagiert auf
  den Oracle-Output; ein einziger schlechter Tick, der 1,0
  kreuzt, reicht aus.
- **Liquidations-Slippage** — wenn eine Liquidation auslöst,
  kann der Swap dein Collateral zu Slippage-zerfressenen Preisen
  verkaufen. Der Swap ist permissionless — jeder kann ihn in dem
  Moment auslösen, in dem dein HF unter 1,0 fällt.
- **Defaults bei illiquidem Collateral** — der Default überträgt
  dein gesamtes Collateral an den Lender. Es gibt keinen
  Rest-Anspruch; nur ein eventuell ungenutzter VPFI-Loan-
  Initiation-Fee-Rebate, den du als Borrower beim Claim
  einnimmst.

<a id="create-offer.advanced-options"></a>

### Erweiterte Optionen

Weniger gebräuchliche Stellschrauben:

- **Ablauf** — die Offer storniert sich nach diesem Zeitstempel
  selbst. Standard ≈ 7 Tage.
- **Gebühren-Rabatt für diese Offer verwenden** — lokales
  Override des Wallet-Level-Rabatt-Consents für diese spezifische
  Offer.
- Seiten-spezifische Optionen, die der Offer-Erstellungs-Flow
  exponiert.

Defaults sind für die meisten Nutzer sinnvoll.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims sind per Design Pull-Style — terminale Ereignisse lassen
Mittel in der Verwahrung des Protokolls zurück, und der Halter
des Position-NFTs ruft Claim auf, um sie zu bewegen. Beide Arten
von Claims können gleichzeitig im selben Wallet sitzen. Die
rollen-spezifischen Tabs unten beschreiben jeden.

Jeder Claim burnt den Position-NFT des Halters atomar. Der NFT
*ist* das Inhaber-Instrument — ihn vor dem Claimen zu übertragen
gibt dem neuen Halter das Recht zu kassieren.

<a id="claim-center.claims:lender"></a>

#### Wenn du der Lender bist

Der Lender-Claim gibt zurück:

- Deinen Principal zurück in dein Wallet auf dieser Chain.
- Aufgelaufene Zinsen minus den 1%-Treasury-Anteil. Der Anteil
  wird selbst durch deinen zeitgewichteten VPFI-Gebühren-Rabatt-
  Akkumulator reduziert, wenn die Zustimmung an ist.

Claimable, sobald der Loan einen terminalen Zustand erreicht
(Settled, Defaulted oder Liquidated). Der Lender-Position-NFT
wird in derselben Transaktion geburnt.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

Der Borrower-Claim gibt je nach Settlement des Loans zurück:

- **Volle Rückzahlung / Preclose / Refinance** — dein
  Collateral-Korb zurück, plus den zeitgewichteten VPFI-Rebate
  aus der Loan Initiation Fee.
- **HF-Liquidation oder Default** — nur den ungenutzten
  VPFI-Loan-Initiation-Fee-Rebate, der auf diesen terminalen
  Pfaden null ist, sofern nicht ausdrücklich erhalten.
  Collateral ist bereits zum Lender gegangen.

Der Borrower-Position-NFT wird in derselben Transaktion geburnt.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

On-Chain-Ereignisse, die dein Wallet auf der aktiven Chain
betreffen, live aus den Logs des Protokolls über ein gleitendes
Block-Fenster gespeist. Kein Backend-Cache — jedes Laden
re-fetcht. Ereignisse werden nach Transaktions-Hash gruppiert,
sodass Multi-Event-Txns (z. B. Accept + Initiate im selben Block)
zusammenbleiben. Neueste zuerst. Zeigt Offers, Loans,
Rückzahlungen, Claims, Liquidationen, NFT-Mints/-Burns und
VPFI-Käufe / -Stakes / -Unstakes.

---

## VPFI kaufen

<a id="buy-vpfi.overview"></a>

### VPFI kaufen

Zwei Pfade:

- **Kanonisch (Base)** — direkter Aufruf des kanonischen
  Buy-Flows am Protokoll. Mintet VPFI direkt in dein Wallet auf
  Base.
- **Off-canonical** — der Buy-Adapter auf der lokalen Chain
  schickt ein LayerZero-Paket an den kanonischen Receiver auf
  Base, der den Kauf auf Base ausführt und das Ergebnis über den
  Cross-Chain-Token-Standard zurück bridgea. End-to-End-Latenz
  ≈ 1 Min auf L2-zu-L2-Paaren. Das VPFI landet im Wallet auf der
  **Origin**-Chain.

Adapter-Rate-Limits (post-Hardening): 50.000 VPFI pro Anfrage und
500.000 VPFI rolling über 24 Stunden. Durch Governance über einen
Timelock anpassbar.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Live-Status:

- Aktuelles Tier (0 bis 4).
- Escrow-VPFI-Saldo plus die Differenz zum nächsten Tier.
- Rabatt-Prozentsatz auf dem aktuellen Tier.
- Wallet-Level-Consent-Flag.

Beachte, dass Escrow-VPFI auch 5% APR über den Staking-Pool
auflaufen lässt — es gibt keine separate "Stake"-Aktion. VPFI in
deinen Escrow einzahlen IST staken.

<a id="buy-vpfi.buy"></a>

### Schritt 1 — VPFI mit ETH kaufen

Reicht den Kauf ein. Auf der kanonischen Chain mintet das
Protokoll direkt. Auf Mirror-Chains nimmt der Buy-Adapter die
Zahlung, schickt eine Cross-Chain-Nachricht, und der Receiver
führt den Kauf auf Base aus und bridgea VPFI zurück. Bridge-Fee
plus Verifier-Netzwerk-Kosten werden live quotiert und im
Formular angezeigt. VPFI wird nicht automatisch in den Escrow
eingezahlt — Schritt 2 ist per Design eine explizite
Nutzeraktion.

<a id="buy-vpfi.deposit"></a>

### Schritt 2 — VPFI in deinen Escrow einzahlen

Ein separater expliziter Deposit-Schritt von deinem Wallet zu
deinem Escrow auf derselben Chain. Auf jeder Chain erforderlich —
auch auf der kanonischen — weil Escrow-Deposit per Spec immer
eine explizite Nutzeraktion ist. Auf Chains, auf denen Permit2
konfiguriert ist, bevorzugt die App den Single-Signature-Pfad
gegenüber dem klassischen Approve-+-Deposit-Pattern; sie fällt
anmutig zurück, wenn Permit2 auf dieser Chain nicht konfiguriert
ist.

<a id="buy-vpfi.unstake"></a>

### Schritt 3 — VPFI aus deinem Escrow unstaken

Hebe VPFI aus deinem Escrow zurück in dein Wallet ab. Kein
Approve-Schritt — das Protokoll besitzt den Escrow und zieht von
sich selbst ab. Der Withdraw triggert ein sofortiges
Re-Stempeln des Rabatt-Satzes auf den neuen (niedrigeren) Saldo,
angewendet auf jeden offenen Loan, an dem du beteiligt bist. Es
gibt kein Gnadenfenster, in dem das alte Tier noch gilt.

---

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Zwei Streams:

- **Staking-Pool** — Escrow-gehaltenes VPFI läuft kontinuierlich
  zu 5% APR auf, mit Verzinsung pro Sekunde.
- **Interaktions-Pool** — Pro-Tag-Pro-Rata-Anteil an einer fixen
  täglichen Emission, gewichtet nach deinem Beitrag an
  gesettleten Zinsen zum Loan-Volumen dieses Tages.
  Tagesfenster finalisieren lazy beim ersten Claim oder
  Settlement nach Fenster-Schluss.

Beide Streams werden direkt auf der aktiven Chain geminted — es
gibt keinen Cross-Chain-Round-Trip für den Nutzer.
Cross-Chain-Reward-Aggregation findet nur zwischen
Protokollverträgen statt.

<a id="rewards.claim"></a>

### Rewards claimen

Eine einzige Transaktion claimed beide Streams gleichzeitig.
Staking-Rewards sind immer verfügbar; Interaktions-Rewards sind
null, bis das relevante Tagesfenster finalisiert
(Lazy-Finalisierung getriggert durch den nächsten
Nicht-Null-Claim oder das nächste Settlement auf dieser Chain).
Die UI sperrt den Button, während das Fenster noch finalisiert,
damit Nutzer nicht unter-claimen.

<a id="rewards.withdraw-staked"></a>

### Gestaktes VPFI abheben

Identische Surface zu "Schritt 3 — Unstake" auf der
VPFI-kaufen-Seite — hebe VPFI aus dem Escrow zurück in dein
Wallet ab. Abgehobenes VPFI verlässt den Staking-Pool sofort
(Rewards hören für diesen Betrag in diesem Block auf
aufzulaufen) und verlässt den Rabatt-Akkumulator sofort
(Post-Saldo-Re-Stamp auf jedem offenen Loan).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (diese Seite)

Single-Loan-Ansicht live aus dem Protokoll abgeleitet, plus
Live-HF und LTV aus dem Risiko-Engine. Rendert Konditionen,
Collateral-Risiko, Parteien, die durch deine Rolle und den
Loan-Status gegatete Action-Surface, und Inline-Keeper-Status.

<a id="loan-details.terms"></a>

### Loan Terms

Unveränderliche Bestandteile des Loans:

- Principal (Asset und Menge).
- APR (bei Offer-Erstellung fixiert).
- Dauer in Tagen.
- Startzeit und Endzeit (Startzeit + Dauer).
- Aufgelaufene Zinsen, live aus den seit dem Start verstrichenen
  Sekunden berechnet.

Refinance erstellt einen frischen Loan, statt diese Werte zu
mutieren.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risiko

Live-Risikomathematik.

- **Health Factor** = (USD-Wert des Collaterals × Liquidations-
  Threshold) / USD-Wert der Schuld. Ein HF unter 1,0 macht die
  Position liquidierbar.
- **LTV** = USD-Wert der Schuld / USD-Wert des Collaterals.
- **Liquidations-Threshold** = das LTV, bei dem die Position
  liquidierbar wird; hängt von der Volatilitätsklasse des
  Collateral-Korbs ab. Der Hochvolatilitäts-Kollaps-Trigger ist
  bei 110% LTV.

Illiquides Collateral hat on-chain einen USD-Wert von null;
HF und LTV kollabieren auf "n/a", und der einzige terminale
Pfad ist die vollständige Collateral-Übertragung im Default —
beide Parteien haben bei Offer-Erstellung über die
Illiquid-Risk-Bestätigung zugestimmt.

<a id="loan-details.collateral-risk:lender"></a>

#### Wenn du der Lender bist

Der Collateral-Korb, der diesen Loan sichert, ist dein Schutz.
Ein HF über 1,0 bedeutet, dass die Position gegenüber dem
Liquidations-Threshold überbesichert ist. Während HF gegen 1,0
driftet, dünnt dein Schutz aus. Sobald HF unter 1,0 fällt, kann
jeder (auch du) liquidieren aufrufen, und das Protokoll routet
das Collateral über das 4-DEX-Failover für dein Hauptasset.
Erholung ist netto nach Slippage.

Bei illiquidem Collateral geht der Korb im Default zum
Zeitpunkt des Defaults vollständig auf dich über — was es
tatsächlich am offenen Markt wert ist, ist dein Problem.

<a id="loan-details.collateral-risk:borrower"></a>

#### Wenn du der Borrower bist

Dein gesperrtes Collateral. Halte HF sicher über 1,0 — ein
übliches Buffer-Ziel ist 1,5, um Volatilität auszuhalten. Hebel,
um HF anzuheben:

- **Collateral hinzufügen** — den Korb aufstocken. Aktion nur
  durch den Nutzer.
- **Teilrückzahlung** — reduziert die Schuld, hebt HF.

Sobald HF unter 1,0 fällt, kann jeder eine HF-basierte
Liquidation auslösen; der Swap verkauft dein Collateral zu
Slippage-zerfressenen Preisen, um den Lender zurückzuzahlen. Bei
illiquidem Collateral überträgt der Default dein gesamtes
Collateral an den Lender — es bleibt nur ein eventuell
ungenutzter VPFI-Loan-Initiation-Fee-Rebate zum Claimen.

<a id="loan-details.parties"></a>

### Parteien

Lender, Borrower, Lender-Escrow, Borrower-Escrow und die zwei
Position-NFTs (je einer pro Seite). Jeder NFT ist ein ERC-721
mit On-Chain-Metadaten; ihn zu übertragen, überträgt das Recht
zu claimen. Die Escrow-Verträge sind pro Adresse deterministisch
— gleiche Adresse über Deploys hinweg.

<a id="loan-details.actions"></a>

### Aktionen

Action-Surface, pro Rolle vom Protokoll gegated. Die
rollen-spezifischen Tabs unten listen die verfügbaren Aktionen
jeder Seite auf. Deaktivierte Aktionen zeigen einen
Hover-Grund, abgeleitet vom Gate ("HF unzureichend", "Noch nicht
abgelaufen", "Loan gesperrt" etc.).

Permissionless-Aktionen, die unabhängig von der Rolle für jeden
verfügbar sind:

- **Liquidation auslösen** — wenn HF unter 1,0 fällt.
- **Default markieren** — wenn die Gnadenfrist ohne volle
  Rückzahlung abgelaufen ist.

<a id="loan-details.actions:lender"></a>

#### Wenn du der Lender bist

- **Als Lender claimen** — nur terminal. Gibt Principal plus
  Zinsen minus dem 1%-Treasury-Anteil zurück (weiter reduziert
  durch deinen zeitgewichteten VPFI-Yield-Fee-Rabatt, wenn die
  Zustimmung an ist). Burnt den Lender-Position-NFT.
- **Early Withdrawal initiieren** — listet den Lender-Position-
  NFT zum Verkauf zu einem von dir gewählten Preis. Ein Käufer,
  der den Verkauf abschließt, übernimmt deine Seite; du erhältst
  den Erlös. Vor Befüllung des Verkaufs stornierbar.
- Optional an einen Keeper delegierbar, der die relevante
  Action-Permission hält — siehe Keeper-Einstellungen.

<a id="loan-details.actions:borrower"></a>

#### Wenn du der Borrower bist

- **Repay** — vollständig oder teilweise. Teilweise reduziert
  den ausstehenden Saldo und hebt HF; vollständig triggert das
  terminale Settlement, einschließlich des zeitgewichteten
  VPFI-Loan-Initiation-Fee-Rebates.
- **Direkter Preclose** — zahle den ausstehenden Betrag jetzt
  aus deinem Wallet, gib das Collateral frei, settle den
  Rebate.
- **Offset-Preclose** — verkaufe einen Teil des Collaterals via
  des Swap-Routers des Protokolls, zahle aus dem Erlös zurück,
  und gib den Rest zurück. Zwei Schritte: initiieren, dann
  abschließen.
- **Refinance** — poste eine Borrower-Offer für neue
  Konditionen; sobald ein Lender akzeptiert, tauscht der
  Refinance-Abschluss die Loans atomar, ohne dass das
  Collateral deinen Escrow verlässt.
- **Als Borrower claimen** — nur terminal. Gibt das Collateral
  bei voller Rückzahlung zurück, oder den ungenutzten
  VPFI-Loan-Initiation-Fee-Rebate bei Default / Liquidation.
  Burnt den Borrower-Position-NFT.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Listet jede ERC-20-Allowance, die dein Wallet dem Protokoll auf
dieser Chain gewährt hat. Bezogen durch Scannen einer
Kandidaten-Token-Liste gegen On-Chain-Allowance-Views. Widerruf
setzt die Allowance auf null.

Gemäß der Exact-Amount-Approval-Policy verlangt das Protokoll
niemals unbegrenzte Allowances, daher ist die typische
Widerrufsliste kurz.

Hinweis: Permit2-artige Flows umgehen die Per-Asset-Allowance am
Protokoll, indem sie stattdessen eine einzige Signatur
verwenden, sodass eine saubere Liste hier zukünftige Deposits
nicht ausschließt.

---

## Alerts

<a id="alerts.overview"></a>

### Über Alerts

Ein Off-Chain-Watcher pollt jeden aktiven Loan, der dein Wallet
betrifft, im 5-Minuten-Takt, liest den Live-Health-Factor jedes
einzelnen, und löst bei einem Bandenwechsel in unsichere
Richtung einmal über die konfigurierten Kanäle aus. Kein
On-Chain-State, kein Gas. Alerts sind beratend — sie bewegen
keine Mittel.

<a id="alerts.threshold-ladder"></a>

### Schwellen-Leiter

Eine nutzer-konfigurierte Leiter von HF-Bändern. Das Wechseln in
eine gefährlichere Bande löst einmal aus und scharft die nächste
tiefere Schwelle; wieder über eine Bande hinaus zu kreuzen
scharft sie neu. Defaults: 1,5 → 1,3 → 1,1. Höhere Zahlen sind
für volatiles Collateral angemessen. Der einzige Job der Leiter
ist, dich rauszubekommen, bevor HF unter 1,0 fällt und die
Liquidation triggert.

<a id="alerts.delivery-channels"></a>

### Lieferkanäle

Zwei Schienen:

- **Telegram** — Bot-DM mit der Kurzadresse des Wallets, der
  Loan-ID und dem aktuellen HF.
- **Push Protocol** — Wallet-direkte Benachrichtigung über den
  Vaipakam-Push-Channel.

Beide teilen sich die Schwellen-Leiter; Per-Channel-Warn-Levels
werden absichtlich nicht exponiert, um Drift zu vermeiden. Das
Push-Channel-Publishing ist derzeit gestubbt, bis der Channel
erstellt wird.

---

## NFT-Verifier

<a id="nft-verifier.lookup"></a>

### Verifiziere einen NFT

Bei einer NFT-Vertragsadresse und einer Token-ID ruft der
Verifier ab:

- Den aktuellen Eigentümer (oder ein Burn-Signal, falls der
  Token bereits geburnt ist).
- Die On-Chain-JSON-Metadaten.
- Eine Protokoll-Cross-Check: leitet die zugrundeliegende
  Loan-ID aus den Metadaten ab und liest die Loan-Details aus
  dem Protokoll, um den Status zu bestätigen.

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

Eine Per-Wallet-Keeper-Whitelist von bis zu 5 Keepern. Jeder
Keeper hat einen Satz an Action-Permissions, die spezifische
Wartungsaufrufe auf **deiner Seite** eines Loans autorisieren.
Money-Out-Pfade (Repay, Claim, Collateral hinzufügen,
Liquidieren) sind per Design nur für den Nutzer und können nicht
delegiert werden.

Zwei zusätzliche Gates greifen zur Aktionszeit:

1. Der Keeper-Master-Access-Switch — eine One-Flip-Notbremse,
   die jeden Keeper deaktiviert, ohne die Allowlist anzufassen.
2. Ein Per-Loan-Opt-in-Toggle, gesetzt auf der Surface des Offer
   Books oder der Loan Details.

Ein Keeper kann nur agieren, wenn alle vier Bedingungen wahr
sind: genehmigt, Master-Switch an, Per-Loan-Toggle an, und die
spezifische Action-Permission auf diesem Keeper gesetzt.

<a id="keeper-settings.approved-list"></a>

### Genehmigte Keeper

Aktuell exponierte Action-Permissions:

- **Loan-Verkauf abschließen** (Lender-Seite, Sekundärmarkt-
  Exit).
- **Offset abschließen** (Borrower-Seite, zweiter Schritt des
  Preclose über Collateral-Verkauf).
- **Early Withdrawal initiieren** (Lender-Seite, Position zum
  Verkauf listen).
- **Preclose initiieren** (Borrower-Seite, startet den
  Preclose-Flow).
- **Refinance** (Borrower-Seite, atomarer Loan-Tausch auf einer
  neuen Borrower-Offer).

On-Chain hinzugefügte Permissions, die das Frontend noch nicht
reflektiert, bekommen ein klares "Permission ungültig"-Revert.
Der Widerruf ist auf allen Loans sofort wirksam — es gibt keine
Wartezeit.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Ein wallet-freier Aggregator, der live aus On-Chain-View-Calls
des Protokolls über jede unterstützte Chain berechnet wird. Kein
Backend, keine Datenbank. CSV- / JSON-Export verfügbar; die
Adresse des Protokolls plus die View-Funktion, die jede Metrik
unterstützt, werden zur Verifizierbarkeit angezeigt.

<a id="public-dashboard.combined"></a>

### Kombiniert — Alle Chains

Cross-Chain-Rollup. Der Header berichtet, wie viele Chains
abgedeckt wurden und wie viele fehlerhaft waren, sodass ein
nicht erreichbarer RPC zur Fetch-Zeit explizit ist. Wenn eine
oder mehrere Chains fehlerhaft waren, markiert die Pro-Chain-
Tabelle, welche — TVL-Summen werden trotzdem berichtet,
erkennen aber die Lücke an.

<a id="public-dashboard.per-chain"></a>

### Aufschlüsselung pro Chain

Pro-Chain-Aufteilung der kombinierten Metriken. Nützlich, um
TVL-Konzentration, nicht zueinander passende
VPFI-Mirror-Supplies (die Summe der Mirror-Supplies sollte dem
Lock-Saldo des kanonischen Adapters entsprechen) oder
stillstehende Chains zu erkennen.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token-Transparenz

On-Chain-VPFI-Buchhaltung auf der aktiven Chain:

- Gesamt-Supply, direkt aus dem ERC-20 gelesen.
- Zirkulierender Supply — Gesamt-Supply minus
  protokollgehaltene Bestände (Treasury, Reward-Pools,
  in-flight Bridge-Pakete).
- Verbleibender mintbarer Cap — nur auf der kanonischen Chain
  aussagekräftig; Mirror-Chains berichten "n/a" für den Cap,
  weil Mints dort bridge-getrieben sind, nicht aus dem Cap
  geminted.

Cross-Chain-Invariante: Die Summe der Mirror-Supplies über alle
Mirror-Chains entspricht dem Lock-Saldo des kanonischen
Adapters. Ein Watcher überwacht das und alarmiert bei Drift.

<a id="public-dashboard.transparency"></a>

### Transparenz & Quelle

Für jede Metrik werden gelistet:

- Die als Snapshot verwendete Block-Nummer.
- Daten-Aktualität (max. Staleness über Chains hinweg).
- Die Adresse des Protokolls und der View-Funktionsaufruf.

Jeder kann jede Zahl auf dieser Seite aus RPC + Block + Adresse
des Protokolls + Funktionsname neu ableiten — das ist der
Maßstab.

---

## Refinance

Diese Seite ist nur für Borrower — Refinance wird vom Borrower
auf dem Loan des Borrowers initiiert.

<a id="refinance.overview"></a>

### Über Refinancing

Refinance zahlt deinen bestehenden Loan atomar aus neuem
Principal ab und eröffnet einen frischen Loan mit den neuen
Konditionen, alles in einer Transaktion. Collateral bleibt die
ganze Zeit in deinem Escrow — kein ungesichertes Fenster. Der
neue Loan muss bei der Initiierung das HF ≥ 1,5-Gate genauso
bestehen wie jeder andere Loan.

Der ungenutzte Loan-Initiation-Fee-Rebate des alten Loans wird
als Teil des Tauschs korrekt abgerechnet.

<a id="refinance.position-summary"></a>

### Deine aktuelle Position

Snapshot des refinanzierten Loans — aktueller Principal, bisher
aufgelaufene Zinsen, HF / LTV und Collateral-Korb. Die neue
Offer sollte mindestens den ausstehenden Betrag dimensionieren
(Principal + aufgelaufene Zinsen); jeglicher Überschuss auf der
neuen Offer wird als freier Principal an deinen Escrow
geliefert.

<a id="refinance.step-1-post-offer"></a>

### Schritt 1 — Poste die neue Offer

Postet eine Borrower-Offer mit deinen Ziel-Konditionen. Der alte
Loan lässt während der Wartezeit weiterhin Zinsen auflaufen; das
Collateral bleibt gesperrt. Die Offer erscheint im öffentlichen
Offer Book, und jeder Lender kann sie akzeptieren. Du kannst vor
der Annahme stornieren.

<a id="refinance.step-2-complete"></a>

### Schritt 2 — Abschließen

Atomares Settlement, nachdem der neue Lender akzeptiert hat:

1. Finanziert den neuen Loan vom akzeptierenden Lender.
2. Zahlt den alten Loan vollständig zurück (Principal + Zinsen,
   abzüglich Treasury-Anteil).
3. Burnt die alten Position-NFTs.
4. Mintet die neuen Position-NFTs.
5. Settled den ungenutzten Loan-Initiation-Fee-Rebate des alten
   Loans.

Revertet, wenn HF auf den neuen Konditionen unter 1,5 läge.

---

## Preclose

Diese Seite ist nur für Borrower — Preclose wird vom Borrower
auf dem Loan des Borrowers initiiert.

<a id="preclose.overview"></a>

### Über Preclose

Eine Borrower-getriebene vorzeitige Beendigung. Zwei Pfade:

- **Direkt** — zahle den ausstehenden Betrag (Principal +
  aufgelaufene Zinsen) aus deinem Wallet, gib das Collateral
  frei, settle den ungenutzten Loan-Initiation-Fee-Rebate.
- **Offset** — initiiere den Offset, um einen Teil des
  Collaterals über das 4-DEX-Swap-Failover des Protokolls gegen
  das Hauptasset zu verkaufen, schließe den Offset ab, um aus
  dem Erlös zurückzuzahlen, und der Rest des Collaterals geht
  an dich zurück. Gleiches Rebate-Settlement.

Keine pauschale Frühschluss-Strafe. Die zeitgewichtete
VPFI-Mathematik übernimmt die Fairness.

<a id="preclose.position-summary"></a>

### Deine aktuelle Position

Snapshot des in Preclose befindlichen Loans — ausstehender
Principal, aufgelaufene Zinsen, aktuelle HF / LTV. Der
Preclose-Flow erfordert beim Aussteigen **kein** HF ≥ 1,5 (es
ist ein Schluss, kein Re-Init).

<a id="preclose.in-progress"></a>

### Offset in Bearbeitung

Status: Der Offset wurde initiiert, der Swap ist mid-execution
(oder die Quote wurde verbraucht, aber das finale Settle steht
aus). Zwei Ausgänge:

- **Offset abschließen** — settled den Loan aus dem
  realisierten Erlös, gibt den Rest zurück.
- **Offset abbrechen** — abbrechen; Collateral bleibt
  gesperrt, Loan unverändert. Verwende es, wenn der Swap sich
  zwischen Initiieren und Abschließen gegen dich bewegt hat.

<a id="preclose.choose-path"></a>

### Wähle einen Pfad

Der direkte Pfad verbraucht Wallet-Liquidität im Hauptasset.
Der Offset-Pfad verbraucht Collateral via DEX-Swap; bevorzugt,
wenn du das Hauptasset nicht zur Hand hast oder du auch aus der
Collateral-Position aussteigen willst. Offset-Slippage ist
durch das gleiche 4-DEX-Failover begrenzt, das auch für
Liquidationen verwendet wird (0x → 1inch → Uniswap V3 →
Balancer V2).

---

## Early Withdrawal (Lender)

Diese Seite ist nur für Lender — Early Withdrawal wird vom
Lender auf dem Loan des Lenders initiiert.

<a id="early-withdrawal.overview"></a>

### Über Lender Early Exit

Ein Sekundärmarkt-Mechanismus für Lender-Positionen. Du listest
deinen Position-NFT zum Verkauf zu einem gewählten Preis; bei
Annahme zahlt der Käufer, das Eigentum am Lender-NFT geht an
den Käufer über, und der Käufer wird zum Lender-of-Record für
jedes zukünftige Settlement (Claim am Terminal etc.). Du gehst
mit dem Verkaufserlös davon.

Liquidationen bleiben nur dem Nutzer vorbehalten und werden NICHT
über den Verkauf delegiert — nur das Recht zu claimen wird
übertragen.

<a id="early-withdrawal.position-summary"></a>

### Deine aktuelle Position

Snapshot — ausstehender Principal, aufgelaufene Zinsen,
verbleibende Zeit, aktuelle HF / LTV der Borrower-Seite. Das
setzt den fairen Preis, den der Käufermarkt erwartet: Das Payoff
des Käufers ist Principal plus Zinsen am Terminal, abzüglich
Liquidationsrisiko über die verbleibende Zeit.

<a id="early-withdrawal.initiate-sale"></a>

### Verkauf einleiten

Listet den Position-NFT zum Verkauf über das Protokoll zu deinem
Angebotspreis. Ein Käufer schließt den Verkauf ab; du kannst vor
Befüllung des Verkaufs stornieren. Optional an einen Keeper
delegierbar, der die "Loan-Verkauf abschließen"-Permission hält;
der Init-Schritt selbst bleibt nur dem Nutzer vorbehalten.
