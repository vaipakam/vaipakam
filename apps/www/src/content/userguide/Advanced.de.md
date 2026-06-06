# Vaipakam — Benutzerhandbuch (Advanced-Modus)

Präzise, technisch belastbare Erklärungen zu jeder Karte in der App.
Jeder Abschnitt entspricht einem `(i)`-Info-Symbol neben einem
Karten-Titel.

> **Du liest die Advanced-Version.** Diese Version entspricht dem
> **Advanced**-Modus der App (dichtere Steuerelemente, Diagnosen und
> Details zur Protokoll-Konfiguration). Für die freundlichere,
> alltagssprachliche Erklärung wechsle die App in den
> **Basic**-Modus — öffne Einstellungen (Zahnrad-Symbol oben
> rechts) → **Modus** → **Basic**. Die "Mehr erfahren"-Links (i) in
> der App öffnen dann das Basic-Handbuch.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### Dein Vault

Ein upgradebarer Vertrag pro Nutzer — dein privater Tresor auf
dieser Chain — der für dich erstellt wird, sobald du zum ersten
Mal an einem Loan teilnimmst. Ein Vault pro Adresse pro Chain.
Er hält ERC-20-, ERC-721- und ERC-1155-Bestände, die mit deinen
Loan-Positionen verknüpft sind. Es gibt keine Vermischung: Assets
anderer Nutzer sind niemals in diesem Vertrag.

Der Vault ist der einzige Ort, an dem Collateral, verliehene
Assets und dein gesperrtes VPFI liegen. Das Protokoll prüft ihn
bei jedem Deposit und Withdraw. Die Implementierung kann durch den
Protokolleigentümer aktualisiert werden, aber nur über einen
Timelock — niemals sofort.

<a id="dashboard.your-loans"></a>

### Deine Loans

Jeder Loan, an dem das verbundene Wallet auf dieser Chain beteiligt
ist — egal ob du auf der Lender-Seite, der Borrower-Seite oder auf
beiden Seiten über getrennte Positionen stehst. Die Daten werden
live aus den View-Methoden des Protokolls für deine Adresse
berechnet. Jede Zeile führt zur vollständigen Positionsseite mit
HF, LTV, aufgelaufenen Zinsen, den durch Rolle und Loan-Status
freigegebenen Aktionen und der On-Chain-Loan-ID, die du in einen
Block-Explorer einfügen kannst.

<a id="dashboard.vpfi-panel"></a>

### VPFI auf dieser Chain

Live-VPFI-Buchhaltung für das verbundene Wallet auf der aktiven
Chain:

- Wallet-Saldo.
- Vault-Saldo.
- Dein Anteil am zirkulierenden Supply (nach Abzug der vom
  Protokoll gehaltenen Bestände).
- Verbleibender mintbarer Cap.

Vaipakam transportiert VPFI chainübergreifend über Chainlink CCIP.
**Base ist die kanonische Chain** — der kanonische Adapter dort
setzt die Semantik Lock-on-Send / Release-on-Receive um. Jede
andere unterstützte Chain betreibt einen Mirror, der bei
eingehenden Bridge-Paketen mintet und bei ausgehenden Paketen
verbrennt. Der Gesamt-Supply über alle Chains bleibt beim Bridging
konstruktionsbedingt invariant.

Die nach dem Branchenvorfall im April 2026 gehärtete Policy zur
Verifizierung von Cross-Chain-Nachrichten lautet **3 erforderliche
+ 2 optionale Verifier, Threshold 1-aus-2**. Die
Single-Verifier-Standardkonfiguration wird am Deploy-Gate
abgelehnt.

<a id="dashboard.fee-discount-consent"></a>

### Zustimmung zum Gebühren-Rabatt

Ein Opt-in-Flag auf Wallet-Ebene, das dem Protokoll erlaubt, den
rabattierten Anteil einer Gebühr in VPFI abzurechnen, das bei
terminalen Ereignissen aus deinem Vault abgebucht wird. Standard:
aus. Aus bedeutet, dass du 100% jeder Gebühr im Principal-Asset
zahlst; an bedeutet, dass der zeitgewichtete Rabatt angewendet wird.

Tier-Leiter:

| Tier | Min. Vault-VPFI                       | Rabatt                            |
| ---- | -------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%   |

Das Tier wird gegen deinen Vault-Saldo **nach der Änderung** in
dem Moment berechnet, in dem du VPFI einzahlst oder abhebst, und
dann über die Laufzeit jedes Loans zeitgewichtet. Ein Unstake
stempelt die Rate sofort auf den neuen niedrigeren Saldo für jeden
offenen Loan, an dem du beteiligt bist — es gibt kein
Gnadenfenster, in dem dein altes (höheres) Tier weiter gilt. Damit
wird das Muster geschlossen, bei dem ein Nutzer kurz vor Loan-Ende
VPFI aufladen, den vollen Tier-Rabatt mitnehmen und Sekunden später
wieder abheben könnte.

Der Rabatt gilt für die Lender-Yield-Fee beim Settlement und für
die Borrower-Loan-Initiation-Fee (ausgezahlt als VPFI-Rebate, wenn
der Borrower claimt).

> **Netzwerk-Gas ist separat.** Der obige Rabatt gilt für die
> **Protokollgebühren** von Vaipakam (Yield-Fee
> `{liveValue:treasuryFeeBps}` %, Loan Initiation Fee
> `{liveValue:loanInitiationFeeBps}` %). Die **Blockchain-Netzwerkgebühr
> (Gas)**, die jede On-Chain-Aktion zusätzlich erfordert — gezahlt
> an die Validatoren auf Base / Sepolia / Arbitrum / etc. beim
> Erstellen einer Offer, Annehmen, Zurückzahlen, Beanspruchen,
> Abheben usw. — ist keine Protokollgebühr. Vaipakam erhält sie
> nie; das Netzwerk schon. Sie kann nicht in Tiers eingeteilt oder
> erstattet werden, und sie variiert mit der Chain-Auslastung zum
> Zeitpunkt des Submits, nicht mit der Loan-Größe oder deinem
> VPFI-Tier.

<a id="dashboard.rewards-summary"></a>

### Deine VPFI-Rewards

Eine ambitionierte Übersichtskarte, die das kombinierte
VPFI-Rewards-Bild des verbundenen Wallets über beide Reward-Ströme
in einer Ansicht zeigt. Die Hauptzahl ist die Summe aus:
ausstehenden Staking-Rewards, historisch geclaimten
Staking-Rewards, ausstehenden Interaction-Rewards und historisch
geclaimten Interaction-Rewards.

Die Aufschlüsselungszeilen pro Strom zeigen ausstehend + geclaimt
und einen Chevron-Deep-Link zur vollständigen Claim-Karte auf der
jeweiligen Ursprungsseite:

- **Staking-Rendite** — ausstehendes VPFI, das mit der
  Protokoll-APR auf deinen Vault-Saldo aufläuft, plus alle
  Staking-Rewards, die du mit diesem Wallet bereits geclaimt hast.
  Deep-Link zur Staking-Claim-Karte auf der VPFI-kaufen-Seite.
- **Plattform-Interaction-Rewards** — ausstehendes VPFI, das über
  alle Loans aufläuft, an denen du teilgenommen hast (Lender- oder
  Borrower-Seite), plus alle Interaction-Rewards, die du bereits
  geclaimt hast. Deep-Link zur Interaction-Claim-Karte im Claim
  Center.

Die Lifetime-Claimed-Zahlen werden aus der On-Chain-Claim-Historie
jedes Wallets rekonstruiert. Es gibt keine laufende On-Chain-Summe,
die abgefragt werden könnte; daher wird die Zahl durch Durchlaufen
früherer Claim-Events dieses Wallets auf dieser Chain summiert. Ein
frischer Browser-Cache zeigt null (oder eine Teilsumme), bis der
historische Lauf abgeschlossen ist; danach springt die Zahl auf den
wahren Wert. Das Vertrauensmodell ist dasselbe wie bei den
zugrunde liegenden Claim-Karten.

Die Karte wird für verbundene Wallets immer gerendert, auch wenn
alle Werte null sind. Der Empty-State-Hinweis ist Absicht — würde
die Karte bei null ausgeblendet, wären die Rewards-Programme für
neue Nutzer unsichtbar, bis sie zufällig auf VPFI kaufen oder ins
Claim Center gehen.

---

## Offer Book

<a id="offer-book.filters"></a>

### Filter

Client-seitige Filter über die Lender- und Borrower-Offer-Listen.
Du kannst nach Asset, Seite, Status und einigen weiteren Achsen
filtern. Filter wirken sich nicht auf "Deine aktiven Offers" aus —
diese Liste wird immer vollständig angezeigt.

<a id="offer-book.your-active-offers"></a>

### Deine aktiven Offers

Offene Offers (Status Active, Ablauf noch nicht erreicht), die du
erstellt hast. Vor der Annahme jederzeit stornierbar — der
Cancel-Call ist kostenlos. Die Annahme schaltet die Offer auf
Accepted und löst die Loan-Initiierung aus. Dabei werden die zwei
Position-NFTs gemintet (einer für den Lender, einer für den
Borrower) und der Loan im Status Active eröffnet.

<a id="offer-book.lender-offers"></a>

### Lender-Offers

Aktive Offers von Creators, die verleihen möchten. Die Annahme
erfolgt durch einen Borrower. Bei der Initiierung gibt es ein
hartes Gate: Der Collateral-Korb des Borrowers muss gegenüber der
Principal-Anforderung des Lenders einen Health Factor von
mindestens 1,5 erzeugen. Die HF-Mathematik ist die des Protokolls
selbst — das Gate ist nicht umgehbar. Der 1%-Treasury-Anteil auf
Zinsen wird beim terminalen Settlement abgezogen, nicht im Voraus.

<a id="offer-book.borrower-offers"></a>

### Borrower-Offers

Aktive Offers von Borrowern, die ihr Collateral bereits im Vault
gesperrt haben. Die Annahme erfolgt durch einen Lender; dadurch
wird der Loan mit dem Principal-Asset finanziert und die
Position-NFTs werden gemintet. Bei der Initiierung gilt dasselbe
HF ≥ 1,5-Gate. Die feste APR wird bei der Erstellung der Offer
gesetzt und bleibt über die gesamte Laufzeit des Loans
unveränderlich — Refinance erstellt einen neuen Loan, statt den
bestehenden zu verändern.

---

## Offer erstellen

<a id="create-offer.offer-type"></a>

### Offer-Typ

Wählt aus, auf welcher Seite der Offer der Creator steht:

- **Lender** — der Lender stellt das Principal-Asset und eine
  Collateral-Spezifikation, die der Borrower erfüllen muss.
- **Borrower** — der Borrower sperrt das Collateral im Voraus;
  ein Lender akzeptiert und finanziert.
- Sub-Typ **Rental** — für ERC-4907 (rentables ERC-721) und
  rentable ERC-1155-NFTs. Läuft über den Rental-Flow statt eines
  Debt-Loans; der Mieter zahlt die vollen Mietkosten im Voraus
  (Dauer × tägliche Gebühr) plus 5% Puffer.

<a id="create-offer.lending-asset"></a>

### Lending Asset

Für eine Debt-Offer spezifizierst du das Asset, den
Principal-Betrag, die feste APR und die Dauer in Tagen:

- **Asset** — der ERC-20, der verliehen / geliehen wird.
- **Menge** — Principal, denominiert in den nativen Decimals
  des Assets.
- **APR** — feste Jahresrate in Basis Points (Hundertstel
  Prozent), bei der Annahme als Snapshot festgehalten und
  danach nicht mehr angepasst.
- **Dauer in Tagen** — setzt das Gnadenfenster, bevor ein
  Default ausgelöst werden kann.

Aufgelaufene Zinsen werden kontinuierlich pro Sekunde vom Start
des Loans bis zum terminalen Settlement berechnet.

<a id="create-offer.lending-asset:lender"></a>

#### Wenn du der Lender bist

Das Principal-Asset und die Menge, die du bereit bist anzubieten,
plus der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz
wird zum Zeitpunkt der Offer fixiert; die Dauer setzt das
Gnadenfenster, bevor der Loan in Default gehen kann. Bei der
Annahme wandert der Principal aus deinem Vault in den Vault
des Borrowers als Teil der Loan-Initiierung.

<a id="create-offer.lending-asset:borrower"></a>

#### Wenn du der Borrower bist

Das Principal-Asset und die Menge, die du vom Lender willst, plus
der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird
zum Zeitpunkt der Offer fixiert; die Dauer setzt das
Gnadenfenster, bevor der Loan in Default gehen kann. Dein
Collateral wird zum Zeitpunkt der Offer-Erstellung in deinem
Vault gesperrt und bleibt gesperrt, bis ein Lender akzeptiert
und der Loan eröffnet wird (oder du stornierst).

<a id="create-offer.nft-details"></a>

### NFT-Details

Felder des Rental-Sub-Typs. Spezifiziert den NFT-Vertrag und die
Token-ID (und die Menge für ERC-1155), plus die tägliche
Mietgebühr im Principal-Asset. Bei der Annahme zieht das Protokoll die
vorausbezahlte Miete aus dem Vault des Mieters in die
Verwahrung — das ist Dauer × tägliche Gebühr, plus 5% Puffer.
Der NFT selbst geht in einen delegierten Zustand (über
ERC-4907-Nutzungsrechte oder den entsprechenden ERC-1155-Rental-
Hook), sodass der Mieter Rechte hat, den NFT aber selbst nicht
übertragen kann.

<a id="create-offer.collateral"></a>

### Collateral

Collateral-Asset-Spezifikation der Offer. Zwei Liquiditätsklassen:

- **Liquid** — hat einen registrierten Chainlink-Preisfeed UND
  mindestens einen Uniswap V3- / PancakeSwap V3- /
  SushiSwap V3-Pool mit ≥ 1 Mio. $ Tiefe am aktuellen Tick.
  LTV- und HF-Mathematik greifen; eine HF-basierte Liquidation
  routet das Collateral durch ein 4-DEX-Failover (0x → 1inch →
  Uniswap V3 → Balancer V2).
- **Illiquid** — alles, was Obiges nicht erfüllt. On-Chain mit
  $0 bewertet. Keine HF-Mathematik. Bei Default wird das
  vollständige Collateral an den Lender übertragen. Beide Seiten
  müssen das Illiquid-Collateral-Risiko bei der Offer-Erstellung /
  -Annahme ausdrücklich anerkennen, damit die Offer zustande kommt.

Das Preisorakel hat ein sekundäres Quorum aus drei
unabhängigen Quellen (Tellor, API3, DIA) mit einer
weichen 2-aus-N-Entscheidungsregel über dem primären
Chainlink-Feed.
Pyth wurde evaluiert und nicht übernommen.

<a id="create-offer.collateral:lender"></a>

#### Wenn du der Lender bist

Wie viel der Borrower sperren soll, um den Loan zu sichern.
Liquide ERC-20s (Chainlink-Feed plus ≥ 1 Mio. $ v3-Pool-Tiefe)
erhalten LTV- / HF-Mathematik; illiquide ERC-20s und NFTs haben
keine On-Chain-Bewertung und erfordern, dass beide Parteien einem
Ergebnis "vollständiges Collateral bei Default" zustimmen. Das
HF ≥ 1,5-Gate bei der Loan-Initiierung wird gegen den
Collateral-Korb berechnet, den der Borrower bei der Annahme
präsentiert — die hier gesetzte Anforderung bestimmt direkt den
HF-Spielraum des Borrowers.

<a id="create-offer.collateral:borrower"></a>

#### Wenn du der Borrower bist

Wie viel du bereit bist zu sperren, um den Loan zu sichern.
Liquide ERC-20s (Chainlink-Feed plus ≥ 1 Mio. $ v3-Pool-Tiefe)
erhalten LTV- / HF-Mathematik; illiquide ERC-20s und NFTs haben
keine On-Chain-Bewertung und erfordern, dass beide Parteien einem
Ergebnis "vollständiges Collateral bei Default" zustimmen. Bei
einer Borrower-Offer wird dein Collateral bei der Offer-Erstellung
in deinem Vault gesperrt; bei einer Lender-Offer wird es bei der
Annahme der Offer gesperrt. In beiden Fällen muss der von dir
präsentierte Korb das HF ≥ 1,5-Gate bei der Loan-Initiierung
bestehen.

<a id="create-offer.risk-disclosures"></a>

### Risiko-Hinweise

Bestätigungs-Gate vor dem Absenden. Dieselbe Risikofläche gilt
für beide Seiten; die rollenspezifischen Tabs unten erklären, wie
sich jedes Risiko je nach Seite der Offer anders auswirkt.
Vaipakam ist non-custodial: Es gibt keinen Admin-Key, der eine
abgeschlossene Transaktion rückgängig machen kann. Pause-Hebel
existieren nur auf Cross-Chain-facing Contracts, sind durch einen
Timelock abgesichert und können keine Assets bewegen.

<a id="create-offer.risk-disclosures:lender"></a>

#### Wenn du der Lender bist

- **Smart-Contract-Risiko** — der Vertragscode ist zur Laufzeit
  unveränderlich; geprüft, aber nicht formal verifiziert.
- **Oracle-Risiko** — Veraltung des Chainlink-Feeds oder
  abweichende Pool-Tiefe kann eine HF-basierte Liquidation so weit
  verzögern, dass das Collateral den Principal nicht mehr deckt.
  Das sekundäre Quorum (Tellor + API3 + DIA, weich 2-aus-N) fängt
  grobe Drift ab, aber kleine Schieflagen können die Recovery
  trotzdem schmälern.
- **Liquidations-Slippage** — der 4-DEX-Failover routet zur
  besten Ausführung, die er finden kann, kann aber keinen
  bestimmten Preis garantieren. Recovery ist netto nach Slippage
  und dem 1%-Treasury-Anteil auf Zinsen.
- **Defaults bei illiquidem Collateral** — Collateral geht zum
  Zeitpunkt des Defaults vollständig auf dich über. Es gibt keinen
  Regress, wenn das Asset weniger wert ist als der Principal plus
  die aufgelaufenen Zinsen.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Wenn du der Borrower bist

- **Smart-Contract-Risiko** — der Vertragscode ist zur Laufzeit
  unveränderlich; Bugs würden das gesperrte Collateral betreffen.
- **Oracle-Risiko** — Veraltete Daten oder Manipulation können eine
  HF-basierte Liquidation gegen dich auslösen, wenn der echte
  Marktpreis sicher geblieben wäre. Die HF-Formel reagiert auf
  den Oracle-Output; ein einziger schlechter Tick, der 1,0
  kreuzt, reicht aus.
- **Liquidations-Slippage** — wenn eine Liquidation auslöst,
  kann der Swap dein Collateral zu Preisen verkaufen, die durch
  Slippage ausgehöhlt sind. Der Swap ist permissionless — jeder
  kann ihn in dem Moment auslösen, in dem dein HF unter 1,0 fällt.
- **Defaults bei illiquidem Collateral** — der Default überträgt
  dein gesamtes Collateral an den Lender. Es gibt keinen
  Restanspruch; nur ein eventuell ungenutzter VPFI-Loan-
  Initiation-Fee-Rebate, den du als Borrower beim Claim erhältst.

<a id="create-offer.advanced-options"></a>

### Erweiterte Optionen

Weniger häufig genutzte Stellschrauben:

- **Ablauf** — die Offer storniert sich nach diesem Zeitstempel
  selbst. Standard ≈ 7 Tage.
- **Gebühren-Rabatt für diese Offer verwenden** — lokale
  Übersteuerung des Wallet-Level-Rabatt-Consents für diese
  spezifische Offer.
- Seitenspezifische Optionen, die der Offer-Erstellungs-Flow
  freilegt.

Defaults sind für die meisten Nutzer sinnvoll.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Claims sind per Design Pull-style — terminale Ereignisse lassen
Mittel in der Verwahrung des Protokolls zurück, und der Halter des
Position-NFTs ruft Claim auf, um sie zu bewegen. Beide Claim-Arten
können gleichzeitig im selben Wallet liegen. Die rollenspezifischen
Tabs unten beschreiben beide.

Jeder Claim verbrennt den Position-NFT des Halters atomar. Der NFT
*ist* das Inhaber-Instrument — ihn vor dem Claimen zu übertragen
gibt dem neuen Halter das Recht zur Auszahlung.

<a id="claim-center.claims:lender"></a>

#### Wenn du der Lender bist

Der Lender-Claim gibt zurück:

- Deinen Principal zurück in dein Wallet auf dieser Chain.
- Aufgelaufene Zinsen minus den 1%-Treasury-Anteil. Der Anteil
  wird selbst durch deinen zeitgewichteten VPFI-Gebühren-Rabatt-
  Akkumulator reduziert, wenn die Zustimmung an ist.

Claimable, sobald der Loan einen terminalen Zustand erreicht
(Settled, Defaulted oder Liquidated). Der Lender-Position-NFT
wird in derselben Transaktion verbrannt.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

Der Borrower-Claim gibt je nach Settlement des Loans zurück:

- **Volle Rückzahlung / Preclose / Refinance** — dein
  Collateral-Korb zurück, plus den zeitgewichteten VPFI-Rebate
  aus der Loan Initiation Fee.
- **HF-Liquidation oder Default** — nur den ungenutzten
  VPFI-Loan-Initiation-Fee-Rebate, der auf diesen terminalen
  Pfaden null ist, sofern nicht ausdrücklich erhalten.
  Collateral ist bereits an den Lender gegangen.

Der Borrower-Position-NFT wird in derselben Transaktion verbrannt.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

On-Chain-Ereignisse, die dein Wallet auf der aktiven Chain
betreffen, live aus den Protokoll-Logs über ein gleitendes
Blockfenster bezogen. Es gibt keinen Backend-Cache — jedes Laden
der Seite holt die Daten neu. Ereignisse werden nach
Transaktions-Hash gruppiert, sodass Multi-Event-Transaktionen
(z. B. Accept + Initiate im selben Block) zusammenbleiben. Neueste
zuerst. Zeigt Offers, Loans, Rückzahlungen, Claims, Liquidationen,
NFT-Mints/-Burns und VPFI-Käufe / -Stakes / -Unstakes.

---

## VPFI kaufen

<a id="buy-vpfi.overview"></a>

### VPFI kaufen

Zwei Pfade:

- **Kanonisch (Base)** — direkter Aufruf des kanonischen
  Buy-Flows am Protokoll. Mintet VPFI direkt in dein Wallet auf
  Base.
- **Off-canonical** — der Buy-Adapter auf der lokalen Chain
  schickt ein Chainlink CCIP-Paket an den kanonischen Receiver auf
  Base, der den Kauf auf Base ausführt und das Ergebnis über den
  Cross-Chain-Token-Standard zurückbridget. End-to-End-Latenz
  ≈ 1 Min auf L2-zu-L2-Paaren. Das VPFI landet im Wallet auf der
  **Origin**-Chain.

Adapter-Rate-Limits (post-Hardening): 50.000 VPFI pro Anfrage und
500.000 VPFI als rollierendes Limit über 24 Stunden. Durch
Governance über einen Timelock anpassbar.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Live-Status:

- Aktuelles Tier (0 bis 4).
- Vault-VPFI-Saldo plus die Differenz zum nächsten Tier.
- Rabatt-Prozentsatz auf dem aktuellen Tier.
- Consent-Flag auf Wallet-Ebene.

Beachte, dass VPFI im Vault auch 5% APR über den Staking-Pool
verdient — es gibt keine separate "Stake"-Aktion. VPFI in deinen
Vault einzuzahlen IST Staking.

<a id="buy-vpfi.buy"></a>

### Schritt 1 — VPFI mit ETH kaufen

Reicht den Kauf ein. Auf der kanonischen Chain mintet das
Protokoll direkt. Auf Mirror-Chains nimmt der Buy-Adapter die
Zahlung, schickt eine Cross-Chain-Nachricht, und der Receiver
führt den Kauf auf Base aus und bridget VPFI zurück. Bridge-Fee
plus Verifier-Netzwerk-Kosten werden live quotiert und im
Formular angezeigt. VPFI wird nicht automatisch in den Vault
eingezahlt — Schritt 2 ist per Design eine explizite
Nutzeraktion.

<a id="buy-vpfi.deposit"></a>

### Schritt 2 — VPFI in deinen Vault einzahlen

Ein separater, expliziter Deposit-Schritt von deinem Wallet zu
deinem Vault auf derselben Chain. Auf jeder Chain erforderlich —
auch auf der kanonischen — weil Vault-Deposit per Spec immer
eine explizite Nutzeraktion ist. Auf Chains, auf denen Permit2
konfiguriert ist, bevorzugt die App den Single-Signature-Pfad
gegenüber dem klassischen Approve-+-Deposit-Pattern; sie fällt
sauber zurück, wenn Permit2 auf dieser Chain nicht konfiguriert
ist.

<a id="buy-vpfi.unstake"></a>

### Schritt 3 — VPFI aus deinem Vault unstaken

Hebe VPFI aus deinem Vault zurück in dein Wallet ab. Es gibt
keinen separaten Approve-Schritt — das Protokoll besitzt den
Vault und zieht von sich selbst ab. Der Withdraw löst ein
sofortiges Neu-Stempeln des Rabatt-Satzes auf den neuen
(niedrigeren) Saldo aus, angewendet auf jeden offenen Loan, an dem
du beteiligt bist. Es gibt kein Gnadenfenster, in dem das alte Tier
noch gilt.

---

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Zwei Streams:

- **Staking-Pool** — im Vault gehaltenes VPFI läuft kontinuierlich
  zu 5% APR auf, mit Verzinsung pro Sekunde.
- **Interaction-Pool** — täglicher Pro-rata-Anteil an einer festen
  täglichen Emission, gewichtet nach deinem Beitrag an
  gesettleten Zinsen zum Loan-Volumen dieses Tages. Tagesfenster
  finalisieren lazy beim ersten Claim oder Settlement nach
  Fenster-Schluss.

Beide Streams werden direkt auf der aktiven Chain geminted — es
gibt keinen Cross-Chain-Round-Trip für den Nutzer.
Cross-Chain-Reward-Aggregation findet nur zwischen
Protokollverträgen statt.

<a id="rewards.claim"></a>

### Rewards claimen

Eine einzige Transaktion claimt beide Streams gleichzeitig.
Staking-Rewards sind immer verfügbar; Interaction-Rewards sind
null, bis das relevante Tagesfenster finalisiert
(Lazy-Finalisierung getriggert durch den nächsten
Nicht-Null-Claim oder das nächste Settlement auf dieser Chain).
Die UI sperrt den Button, während das Fenster noch finalisiert,
damit Nutzer nicht unter-claimen.

<a id="rewards.withdraw-staked"></a>

### Gestaktes VPFI abheben

Identische Oberfläche wie "Schritt 3 — Unstake" auf der
VPFI-kaufen-Seite — hebe VPFI aus dem Vault zurück in dein Wallet
ab. Abgehobenes VPFI verlässt den Staking-Pool sofort
(Rewards hören für diesen Betrag in diesem Block auf
aufzulaufen) und verlässt den Rabatt-Akkumulator sofort
(Post-Saldo-Re-Stamp auf jedem offenen Loan).

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (diese Seite)

Single-Loan-Ansicht, live aus dem Protokoll abgeleitet, plus
Live-HF und LTV aus der Risk Engine. Rendert Konditionen,
Collateral-Risiko, Parteien, die durch deine Rolle und den
Loan-Status freigegebenen Aktionen und Inline-Keeper-Status.

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
verändern.

<a id="loan-details.collateral-risk"></a>

### Collateral & Risiko

Live-Risikomathematik.

- **Health Factor** = (USD-Wert des Collaterals × Liquidations-
  Threshold) / USD-Wert der Schuld. Ein HF unter 1,0 macht die
  Position liquidierbar.
- **LTV** = USD-Wert der Schuld / USD-Wert des Collaterals.
- **Liquidations-Threshold** = der LTV-Wert, bei dem die Position
  liquidierbar wird; hängt von der Volatilitätsklasse des
  Collateral-Korbs ab. Der Hochvolatilitäts-Kollaps-Trigger ist
  bei 110% LTV.

Illiquides Collateral hat on-chain einen USD-Wert von null; HF und
LTV fallen auf "n/a", und der einzige terminale Pfad ist die
vollständige Collateral-Übertragung bei Default — beide Parteien
haben dem bei Offer-Erstellung über die Illiquid-Risk-Bestätigung
zugestimmt.

<a id="loan-details.collateral-risk:lender"></a>

#### Wenn du der Lender bist

Der Collateral-Korb, der diesen Loan sichert, ist dein Schutz.
Ein HF über 1,0 bedeutet, dass die Position gegenüber dem
Liquidations-Threshold überbesichert ist. Während HF gegen 1,0
driftet, wird dein Schutz dünner. Sobald HF unter 1,0 fällt, kann
jeder (auch du) liquidieren aufrufen, und das Protokoll routet das
Collateral über das 4-DEX-Failover in dein Principal-Asset.
Recovery ist netto nach Slippage.

Bei illiquidem Collateral geht der Korb beim Default vollständig
auf dich über — was er tatsächlich am offenen Markt wert ist, ist
dann dein Risiko.

<a id="loan-details.collateral-risk:borrower"></a>

#### Wenn du der Borrower bist

Dein gesperrtes Collateral. Halte HF sicher über 1,0 — ein
übliches Pufferziel ist 1,5, um Volatilität auszuhalten. Hebel, um
HF anzuheben:

- **Collateral hinzufügen** — den Korb aufstocken. Aktion nur
  durch den Nutzer.
- **Teilrückzahlung** — reduziert die Schuld, hebt HF.

Sobald HF unter 1,0 fällt, kann jeder eine HF-basierte
Liquidation auslösen; der Swap verkauft dein Collateral zu Preisen,
die durch Slippage ausgehöhlt sind, um den Lender zurückzuzahlen.
Bei illiquidem Collateral überträgt der Default dein gesamtes
Collateral an den Lender — es bleibt nur ein eventuell
ungenutzter VPFI-Loan-Initiation-Fee-Rebate zum Claimen.

<a id="loan-details.parties"></a>

### Parteien

Lender, Borrower, Lender-Vault, Borrower-Vault und die zwei
Position-NFTs (je einer pro Seite). Jeder NFT ist ein ERC-721
mit On-Chain-Metadaten; ihn zu übertragen, überträgt das Recht
zu claimen. Die Vault-Verträge sind pro Adresse deterministisch
— gleiche Adresse über Deploys hinweg.

<a id="loan-details.actions"></a>

### Aktionen

Aktionsoberfläche, pro Rolle vom Protokoll gesteuert. Die
rollenspezifischen Tabs unten listen die verfügbaren Aktionen
jeder Seite auf. Deaktivierte Aktionen zeigen einen Hover-Grund,
abgeleitet vom Gate ("HF unzureichend", "Noch nicht abgelaufen",
"Loan gesperrt" etc.).

Permissionless-Aktionen, die unabhängig von der Rolle für jeden
verfügbar sind:

- **Liquidation auslösen** — wenn HF unter 1,0 fällt.
- **Default markieren** — wenn die Gnadenfrist ohne volle
  Rückzahlung abgelaufen ist.

<a id="loan-details.actions:lender"></a>

#### Wenn du der Lender bist

- **Als Lender claimen** — nur in terminalen Zuständen. Gibt
  Principal plus Zinsen minus dem 1%-Treasury-Anteil zurück
  (weiter reduziert durch deinen zeitgewichteten
  VPFI-Yield-Fee-Rabatt, wenn die Zustimmung an ist). Verbrennt den
  Lender-Position-NFT.
- **Early Withdrawal initiieren** — listet den Lender-Position-
  NFT zum Verkauf zu einem von dir gewählten Preis. Ein Käufer,
  der den Verkauf abschließt, übernimmt deine Seite; du erhältst
  den Erlös. Vor Ausführung des Verkaufs stornierbar.
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
- **Offset-Preclose** — verkaufe einen Teil des Collaterals über
  den Swap-Router des Protokolls, zahle aus dem Erlös zurück,
  und gib den Rest zurück. Zwei Schritte: initiieren, dann
  abschließen.
- **Refinance** — poste eine Borrower-Offer für neue
  Konditionen; sobald ein Lender akzeptiert, tauscht der
  Refinance-Abschluss die Loans atomar, ohne dass das
  Collateral deinen Vault verlässt.
- **Als Borrower claimen** — nur in terminalen Zuständen. Gibt das
  Collateral bei voller Rückzahlung zurück, oder den ungenutzten
  VPFI-Loan-Initiation-Fee-Rebate bei Default / Liquidation.
  Verbrennt den Borrower-Position-NFT.

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
Loans und sendet bei einem Wechsel in ein unsichereres Band einmal
über die konfigurierten Kanäle. Kein On-Chain-State, kein Gas.
Alerts sind beratend — sie bewegen keine Mittel.

<a id="alerts.threshold-ladder"></a>

### Schwellen-Leiter

Eine nutzerkonfigurierte Leiter von HF-Bändern. Der Wechsel in ein
gefährlicheres Band sendet einmal einen Alert und aktiviert die
nächste tiefere Schwelle; das Zurückkreuzen über ein Band aktiviert
sie erneut. Defaults: 1,5 → 1,3 → 1,1. Höhere Zahlen sind für
volatiles Collateral angemessen. Die einzige Aufgabe der Leiter ist
es, dich rechtzeitig herauszubekommen, bevor HF unter 1,0 fällt und
Liquidation auslöst.

<a id="alerts.delivery-channels"></a>

### Lieferkanäle

Zwei Schienen:

- **Telegram** — Bot-DM mit der Kurzadresse des Wallets, der
  Loan-ID und dem aktuellen HF.
- **Push Protocol** — Wallet-direkte Benachrichtigung über den
  Vaipakam-Push-Channel.

Beide teilen sich die Schwellen-Leiter; Warnstufen pro Channel
werden absichtlich nicht offengelegt, um Drift zu vermeiden. Das
Publishing für den Push-Channel ist derzeit als Stub hinterlegt,
bis der Channel erstellt ist.

---

## NFT-Verifier

<a id="nft-verifier.lookup"></a>

### Verifiziere einen NFT

Für eine NFT-Vertragsadresse und eine Token-ID ruft der Verifier ab:

- Den aktuellen Eigentümer (oder ein Burn-Signal, falls der
  Token bereits verbrannt ist).
- Die On-Chain-JSON-Metadaten.
- Einen Protokoll-Cross-Check: leitet die zugrundeliegende
  Loan-ID aus den Metadaten ab und liest die Loan-Details aus
  dem Protokoll, um den Status zu bestätigen.

Zeigt: von Vaipakam gemintet? Welche Chain? Loan-Status? Aktueller
Halter? So erkennst du Fälschungen, bereits geclaimte (verbrannte)
Positionen oder Positionen, deren Loan gesettled ist und gerade im
Claim-Prozess steht.

Der Position-NFT ist das Inhaber-Instrument — verifiziere ihn,
bevor du auf einem Sekundärmarkt kaufst.

---

## Keeper-Einstellungen

<a id="keeper-settings.overview"></a>

### Über Keeper

Eine Keeper-Whitelist pro Wallet mit bis zu 5 Keepern. Jeder
Keeper hat einen Satz an Action-Permissions, die spezifische
Wartungsaufrufe auf **deiner Seite** eines Loans autorisieren.
Money-Out-Pfade (Repay, Claim, Collateral hinzufügen,
Liquidieren) sind per Design nur für den Nutzer und können nicht
delegiert werden.

Zwei zusätzliche Gates greifen zur Aktionszeit:

1. Der Keeper-Master-Access-Switch — eine Notbremse mit einem
   einzigen Schalter, die jeden Keeper deaktiviert, ohne die
   Allowlist anzufassen.
2. Ein Per-Loan-Opt-in-Toggle, gesetzt auf der Oberfläche des Offer
   Books oder der Loan Details.

Ein Keeper kann nur agieren, wenn alle vier Bedingungen erfüllt
sind: genehmigt, Master-Switch an, Per-Loan-Toggle an, und die
spezifische Action-Permission ist für diesen Keeper gesetzt.

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

On-chain hinzugefügte Permissions, die das Frontend noch nicht
abbildet, erhalten ein klares "Permission ungültig"-Revert.
Der Widerruf ist auf allen Loans sofort wirksam — es gibt keine
Wartezeit.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Ein walletfreier Aggregator, der live aus On-Chain-View-Calls des
Protokolls über jede unterstützte Chain berechnet wird. Kein
Backend, keine Datenbank. CSV- / JSON-Export ist verfügbar; die
Protokolladresse plus die View-Funktion hinter jeder Metrik werden
zur Verifizierbarkeit angezeigt.

<a id="public-dashboard.combined"></a>

### Kombiniert — Alle Chains

Cross-Chain-Rollup. Der Header zeigt, wie viele Chains abgedeckt
wurden und wie viele Fehler hatten, sodass ein zur Fetch-Zeit nicht
erreichbarer RPC explizit sichtbar ist. Wenn eine oder mehrere
Chains Fehler hatten, markiert die Per-Chain-Tabelle, welche —
TVL-Summen werden trotzdem angezeigt, aber mit dieser Lücke.

<a id="public-dashboard.per-chain"></a>

### Aufschlüsselung pro Chain

Per-Chain-Aufteilung der kombinierten Metriken. Nützlich, um
TVL-Konzentration, nicht passende VPFI-Mirror-Supplies (die Summe
der Mirror-Supplies sollte dem Lock-Saldo des kanonischen Adapters
entsprechen) oder stillstehende Chains zu erkennen.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token-Transparenz

On-Chain-VPFI-Buchhaltung auf der aktiven Chain:

- Gesamt-Supply, direkt aus dem ERC-20 gelesen.
- Zirkulierender Supply — Gesamt-Supply minus
  vom Protokoll gehaltene Bestände (Treasury, Reward-Pools,
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

Diese Seite ist nur für Borrower — Refinance wird vom Borrower auf
seinem Loan initiiert.

<a id="refinance.overview"></a>

### Über Refinancing

Refinance zahlt deinen bestehenden Loan atomar aus neuem Principal
ab und eröffnet einen frischen Loan mit den neuen Konditionen —
alles in einer Transaktion. Collateral bleibt die ganze Zeit in
deinem Vault; es gibt kein ungesichertes Fenster. Der neue Loan
muss bei der Initiierung das HF ≥ 1,5-Gate genauso bestehen wie
jeder andere Loan.

Der ungenutzte Loan-Initiation-Fee-Rebate des alten Loans wird
als Teil des Tauschs korrekt abgerechnet.

<a id="refinance.position-summary"></a>

### Deine aktuelle Position

Snapshot des Loans, der refinanziert wird — aktueller Principal,
bisher aufgelaufene Zinsen, HF / LTV und Collateral-Korb. Die neue
Offer sollte mindestens den ausstehenden Betrag abdecken
(Principal + aufgelaufene Zinsen); jeglicher Überschuss auf der
neuen Offer wird als freier Principal an deinen Vault
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

1. Finanziert den neuen Loan durch den akzeptierenden Lender.
2. Zahlt den alten Loan vollständig zurück (Principal + Zinsen,
   abzüglich Treasury-Anteil).
3. Verbrennt die alten Position-NFTs.
4. Mintet die neuen Position-NFTs.
5. Rechnet den ungenutzten Loan-Initiation-Fee-Rebate des alten
   Loans ab.

Revertet, wenn HF unter den neuen Konditionen unter 1,5 läge.

---

## Preclose

Diese Seite ist nur für Borrower — Preclose wird vom Borrower auf
seinem Loan initiiert.

<a id="preclose.overview"></a>

### Über Preclose

Eine Borrower-getriebene vorzeitige Beendigung. Zwei Pfade:

- **Direkt** — zahle den ausstehenden Betrag (Principal +
  aufgelaufene Zinsen) aus deinem Wallet, gib das Collateral
  frei und settle den ungenutzten Loan-Initiation-Fee-Rebate.
- **Offset** — initiiere den Offset, um einen Teil des
  Collaterals über das 4-DEX-Swap-Failover des Protokolls gegen
  das Principal-Asset zu verkaufen, schließe den Offset ab, um aus
  dem Erlös zurückzuzahlen, und der Rest des Collaterals geht
  an dich zurück. Gleiches Rebate-Settlement.

Keine pauschale Early-Close-Strafe. Die zeitgewichtete
VPFI-Mathematik übernimmt die Fairness.

<a id="preclose.position-summary"></a>

### Deine aktuelle Position

Snapshot des Loans, der preclosed wird — ausstehender
Principal, aufgelaufene Zinsen, aktuelle HF / LTV. Der
Preclose-Flow erfordert beim Aussteigen **kein** HF ≥ 1,5 (es
ist ein Abschluss, kein Re-Init).

<a id="preclose.in-progress"></a>

### Offset in Bearbeitung

Status: Der Offset wurde initiiert, der Swap läuft noch (oder die
Quote wurde verbraucht, aber das finale Settlement steht aus). Zwei
Ausgänge:

- **Offset abschließen** — settlet den Loan aus dem
  realisierten Erlös, gibt den Rest zurück.
- **Offset abbrechen** — abbrechen; Collateral bleibt
  gesperrt, Loan unverändert. Verwende es, wenn der Swap sich
  zwischen Initiieren und Abschließen gegen dich bewegt hat.

<a id="preclose.choose-path"></a>

### Wähle einen Pfad

Der direkte Pfad verbraucht Wallet-Liquidität im Principal-Asset.
Der Offset-Pfad verbraucht Collateral über einen DEX-Swap; bevorzugt,
wenn du das Principal-Asset nicht zur Hand hast oder du auch aus der
Collateral-Position aussteigen willst. Offset-Slippage ist
durch das gleiche 4-DEX-Failover begrenzt, das auch für
Liquidationen verwendet wird (0x → 1inch → Uniswap V3 →
Balancer V2).

---

## Early Withdrawal (Lender)

Diese Seite ist nur für Lender — Early Withdrawal wird vom Lender
auf seinem Loan initiiert.

<a id="early-withdrawal.overview"></a>

### Über Lender Early Exit

Ein Sekundärmarkt-Mechanismus für Lender-Positionen. Du listest
deinen Position-NFT zu einem gewählten Preis zum Verkauf; bei
Annahme zahlt der Käufer, das Eigentum am Lender-NFT geht auf den
Käufer über, und der Käufer wird zum Lender-of-Record für jedes
zukünftige Settlement (Claim im terminalen Zustand etc.). Du erhältst
den Verkaufserlös.

Liquidationen bleiben nur dem Nutzer vorbehalten und werden NICHT
über den Verkauf delegiert — nur das Recht zu claimen wird
übertragen.

<a id="early-withdrawal.position-summary"></a>

### Deine aktuelle Position

Snapshot — ausstehender Principal, aufgelaufene Zinsen,
verbleibende Zeit, aktuelle HF / LTV der Borrower-Seite. Das
bestimmt den fairen Preis, den der Käufermarkt erwartet: Das
Payoff des Käufers ist Principal plus Zinsen im terminalen Zustand,
abzüglich Liquidationsrisiko über die verbleibende Zeit.

<a id="early-withdrawal.initiate-sale"></a>

### Verkauf einleiten

Listet den Position-NFT über das Protokoll zu deinem Angebotspreis
zum Verkauf. Ein Käufer schließt den Verkauf ab; du kannst vor
Ausführung des Verkaufs stornieren. Optional an einen Keeper
delegierbar, der die "Loan-Verkauf abschließen"-Permission hält;
der Initiate-Schritt selbst bleibt user-only.

---

<!-- ────────────────────────────────────────────────────────────── -->
<!-- T-086 #374 — TRANSLATION NEEDED                                -->
<!--                                                                -->
<!--   The three sections below are appended in ENGLISH as the      -->
<!--   translator source. Each block is anchored with a stable      -->
<!--   in-app HTML id (load-bearing for dapp cross-links — DO NOT   -->
<!--   change the anchor strings).                                  -->
<!--                                                                -->
<!--   Native German reviewer: please translate each block     -->
<!--   into German AND move it into the appropriate position   -->
<!--   in the body above:                                           -->
<!--                                                                -->
<!--   1. "Your Active Offers" — REPLACES the existing              -->
<!--      `offer-book.your-active-offers` section in this file      -->
<!--      (current locale content is the pre-OpenSea-feature        -->
<!--      version; the EN-source version below ADDS the closed-     -->
<!--      offer status bullets — Filled / Cancelled / Sold /        -->
<!--      Fully Filled / past-GTT note).                            -->
<!--                                                                -->
<!--   2. "Allow optional sale of this NFT on OpenSea"              -->
<!--      (anchor `create-offer.borrow-or-sell`) — INSERT after     -->
<!--      `create-offer.advanced-options` in the Create Offer       -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   3. "Matching OpenSea offers on a prepay listing"             -->
<!--      (anchor `matching-opensea-offers-on-a-prepay-listing`)    -->
<!--      — INSERT before the "How Liquidation Actually Works"      -->
<!--      section. This entire section is NEW in this locale.       -->
<!--                                                                -->
<!--   Once the translated sections are placed correctly above,     -->
<!--   delete this banner block and the EN source blocks below it.  -->
<!-- ────────────────────────────────────────────────────────────── -->

## [TRANSLATION NEEDED] EN source — Your Active Offers (target placement: `offer-book.your-active-offers`)

<a id="offer-book.your-active-offers"></a>

### Your Active Offers

Open offers (status Active, expiry not yet reached) you created.
Cancellable any time before acceptance — the cancel call is free.
Acceptance flips the offer to Accepted and triggers loan
initiation, which mints the two position NFTs (one for lender,
one for borrower) and opens the loan in the Active state.

Closed offers carry one of several distinct statuses. Some are
already exposed as filter chips on the My Offers page; others
are indexer-side terminals that will get dedicated UI treatment
in follow-up work:

- **Filled** — accepted by a counterparty; the offer's loan
  reference is the resulting loan id.
- **Cancelled** — the offer reached the Cancelled state via
  either path: withdrawn by the creator before acceptance,
  OR cleaned up permissionlessly via `OfferCancelFacet.cancelOffer`
  once `LibVaipakam.isOfferExpired(offer)` is true (the refund
  still routes to the creator regardless of who initiated the
  cancel call).
- **Sold** — the offer was opted into the borrow-OR-sell
  parallel-sale flow (see Create Offer → Allow optional sale)
  and a marketplace buyer filled the NFT collateral listing
  before any lender accepted. The offer carries the on-chain
  status `consumed_by_sale`; the row's rate column shows the
  rate the offer was posted at and the collateral cell renders
  the NFT shape (token id for ERC-721, copy count for
  ERC-1155). The dapp also surfaces the row in the Activity
  feed as `Offer sold via OpenSea` for the borrower (offer
  creator). The on-chain event itself is
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  both the offer id AND the executor address are indexed on-chain,
  but the borrower / creator address is NOT. The borrower's
  wallet match for the Activity feed is added by the indexer at
  ingestion time (it joins the offer row to look up the creator),
  so the per-wallet filter finds the borrower without the
  event itself indexing them.
- **Fully Filled (indexer state, no chip yet)** — Range-orders
  only. When partial-fill matching consumes the offer's
  remaining budget (the last match fully fills the range, or
  a partial match leaves a sub-dust remainder),
  `OfferMatchFacet` emits `OfferClosed(FullyFilled | Dust)` and
  the indexer stamps the offer row `status = 'fullyFilled'`.
  The contract's `accepted` state and the on-chain Filled
  label above are reserved for the direct-accept terminal, so
  `fullyFilled` is distinct on the indexer side. The dapp's
  `MyOfferStatus` doesn't yet expose this terminal as its own
  filter chip — `useMyOffers` currently ignores rows with the
  `fullyFilled` indexer status — so a fully-filled range offer
  effectively drops out of the My Offers view altogether
  until the dedicated chip lands. The chip surface is queued
  as a separate UI follow-up.

Past-GTT (Good-Til-Time) offers that never reached a terminal
event aren't yet exposed as a distinct status chip in the dapp;
they currently fall under Active until the indexer records a
terminal. A dedicated Expired chip is queued as a separate UI
follow-up.


## [TRANSLATION NEEDED] EN source — Allow optional sale of this NFT on OpenSea (target placement: `create-offer.borrow-or-sell`)

<a id="create-offer.borrow-or-sell"></a>

### Allow optional sale of this NFT on OpenSea (borrower NFT-collateral offers only)

If you're posting a **borrower offer** with **ERC-721 or
ERC-1155 collateral** and an **ERC-20 principal**, the dapp
exposes a `Borrow or sell` opt-in below the collateral
section. Ticking it marks the offer as eligible for a
parallel-sale listing of your NFT collateral on OpenSea — a
single offer that can be filled EITHER by a lender (you take
the loan) OR by a marketplace buyer (you sell the NFT). The
listing is NOT torn down at lender acceptance if it was already
posted: if a lender fills first you take the loan, the existing
OpenSea listing carries through loan initiation until its
original Seaport expiry, and a later marketplace fill before
that expiry triggers the diamond's settlement waterfall to close
the loan from the sale proceeds (see Scenario B below). For
ordinary GTT offers this expiry is the offer's original
Good-Til-Time; lender acceptance does not extend or repost the
listing for the full loan term. If a marketplace buyer fills
first, no loan is ever created (Scenario A). The two scenarios
end at different offer states: Scenario A stamps
the offer with `consumed_by_sale` via `markOfferConsumedBySale`
(it shows up under the Sold filter), and lender acceptance
is gated against any offer that has already been stamped. In
Scenario B the offer is already in the `Accepted` state by
the time the marketplace fill lands; the contract
deliberately leaves the offer status at `Accepted` and only
settles the loan from the sale — the offer doesn't transition
to Sold a second time.

**Two-step nature.** Opting in at offer create time just
sets the eligibility flag on the offer. Getting an actual
buyable listing onto OpenSea is a SEPARATE TWO-PART step
the dapp does NOT automate today:

1. **Record + wire on the diamond.** Call
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` while the offer is still active and before any
   lender acceptance. Once the offer is accepted, cancelled, or
   consumed by sale, this call reverts as terminal; ticking the
   opt-in alone is not enough to create a listing that can carry
   into Scenario B. The ask must also clear the pre-loan floor:
   principal plus worst-case offer interest through the loan
   duration and grace window, treasury cut on that interest, the
   configured safety buffer, and all fee-leg amounts. Under-floor
   asks revert at this step. The `feeLegs` argument is the ONLY
   place this call records OpenSea protocol-fee and creator-
   royalty obligations: the diamond subtracts each fee-leg
   amount from the seller proceeds and appends the recipient +
   absolute amount to the Seaport consideration array.
   Passing `feeLegs: []` on a fee-enforced collection produces
   an order shape that the OpenSea publish step will reject
   (the fee-recipient consideration items are missing) and a
   direct Seaport fill will route the full ask to the seller
   rather than splitting the fees as the collection requires.
   Advanced users must fetch the OpenSea required-fee schedule
   for the collection (the in-repo fee parser at
   `apps/agent/src/openseaFees.ts` is the reference) and pass
   absolute amounts derived against the ask before calling. The facet internally builds the
   canonical Seaport OrderComponents from those inputs, the
   OfferContext values it records for the executor (borrower
   vault address, principal asset, collateral fields, startTime,
   endTime), and the current `Seaport.getCounter` for the vault,
   derives the orderHash via
   `Seaport.getOrderHash`, returns it, registers the vault's
   ERC-1271 binding to that hash, and grants the Seaport
   conduit approval for the NFT collateral. The emitted
   `PostParallelSaleListing` event exposes the input args
   (`offerId`, borrower, orderHash, askPrice, executor /
   conduit data, salt, fee legs); it does NOT echo the
   per-context fields, so reconstructing OrderComponents
   off-chain requires the additional reads described in
   step 2 below. **Important:** at this point the order is
   already FILLABLE via Seaport. A bot watching the
   contract's events PLUS those reads can reconstruct the
   OrderComponents and call `Seaport.fulfillOrder` directly
   — the listing does not need to appear on OpenSea's
   marketplace UI for
   the on-chain fill path to work. If you don't want
   counterparties to fill at the current ask before step 2
   lands, either run step 2 immediately after step 1 OR call
   `releaseParallelSaleLock` to invalidate the binding before
   any unintended fill.
   For fee-enforced collections, populate `feeLegs` from the
   collection's required OpenSea / creator fee schedule before
   calling this step. Use only required, non-zero fee rows; cap
   the list to the protocol-supported fee-leg count; convert each
   row into an absolute fixed amount in the principal asset at the
   chosen ask price; and use the listed fee recipient as the leg
   recipient. If a required fee rounds to zero at the chosen ask,
   the ask is too small for that collection and the post should not
   be attempted. Passing an empty array is valid only for fee-free
   collections. On fee-enforced collections it can produce an order
   that fails OpenSea publication or cannot satisfy the marketplace's
   required consideration shape.
2. **Publish to OpenSea.** Reconstruct the same OrderComponents
   the facet built. The `PostParallelSaleListing` event alone
   isn't sufficient: it emits `offerId`, borrower, orderHash,
   askPrice, executor / conduit data, salt, and fee legs, but
   the offer-keyed order shape also needs values held in the
   executor's `OfferContext` storage (borrower vault address,
   principal asset, collateral fields, startTime, endTime) plus
   the borrower vault's Seaport counter. This is the same
   context used by the `LibPrepayOrder.buildAndHashOfferMem`
   offer-order path, and it is different from the loan-keyed
   prepay-listing order shape. Read both before posting:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     returns the persisted `OfferContext` struct for that hash.
   - `Seaport.getCounter(borrowerVault)` returns the canonical
     Seaport counter for the vault offerer.
   With those fields in hand the OrderComponents struct
   reproduces exactly the one the diamond hashed. Before POSTing,
   add the API-only `parameters.totalOriginalConsiderationItems`
   field — OpenSea's API requires it even though it's NOT part
   of the Seaport struct that produces the canonical hash; the
   in-repo publishers (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) inject it before
   calling the endpoint. For ERC-1271-validated orders OpenSea
   accepts the `signature` field as `0x` (empty bytes) — the
   vault's on-chain `isValidSignature(orderHash, '')` callback
   ignores the signature bytes and returns the EIP-1271 magic
   value for any orderHash the diamond previously registered
   (from step 1). POST the JSON to the OpenSea listings
   endpoint (`POST /api/v2/orders/{chain}/{protocol}/listings`,
   per the official [Create Listing](https://docs.opensea.io/reference/post_listing)
   docs — this is the same endpoint Vaipakam's own publishers
   in `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` use). Only after this
   step does the listing appear on OpenSea's marketplace UI
   and become discoverable to casual buyers. Vaipakam does
   not currently automate this submission for the
   parallel-sale path — surfacing the listing publication
   end-to-end is tracked as a follow-up.

Advanced users following the manual path today need BOTH steps
to get OpenSea visibility; running step 1 alone produces an
order that's fillable directly through Seaport (by a bot or
counterparty that reconstructs the components from the event)
but invisible on the OpenSea marketplace UI.

**Fill mode is forced to All-or-Nothing.** Opting in
automatically pins the offer's fill mode to `Aon` — partial
or IOC fills would create multiple loans against one
offer's collateral, which the contract gates against. The
toggle is hidden on lender offers, ERC-20 collateral, NFT
principals, and any other shape the contract's
`_validatePostParallelSale` would reject, so you can't
accidentally tick it on an ineligible offer.

**What a buyer sees.**

- *Before any lender accepts* (Scenario A): a buyer who
  fills the OpenSea listing pays the listed price. On
  fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first; the executor passes only the
  **net proceeds** (listed price minus those marketplace /
  creator fee legs) to the diamond. The diamond escrows that
  net amount in your vault, the NFT transfers to the buyer,
  and the offer is marked `consumed_by_sale` (visible as a
  distinct "Sold" status in My Offers, Activity, and Offer
  Details). No loan was ever created; you keep the net sale
  proceeds.
- *After a lender accepts* (Scenario B): the listing
  carries through loan initiation only if it was already
  posted before acceptance, and only until the Seaport order's
  original expiry. Neither the borrower NFT lock nor the listing
  is torn down at acceptance, but lender acceptance also does not
  extend or repost the order for the full loan term. A later buyer
  fill before that expiry triggers the diamond's settlement
  waterfall in one Seaport transaction. Same fee-leg note as Scenario A:
  on fee-enforced collections, Seaport routes OpenSea
  protocol-fee and creator-fee legs directly to their
  configured recipients first, and the executor passes only
  the **net proceeds** (sale price minus marketplace /
  creator fees) into the diamond's waterfall. The waterfall
  then routes that net amount: the lender receives their
  settlement entitlement (which `LibEntitlement.settlementInterest`
  computes as the full coupon when the loan was created with
  `useFullTermInterest = true`, or the pro-rata interest
  accrued to the settlement timestamp otherwise — the gate is
  the loan policy, not whether the sale happens before or
  after scheduled maturity), the treasury cut goes to
  treasury, and the remainder is deposited DIRECTLY into
  the current borrower-position NFT holder's vault (via
  `LibUserVault.getOrCreate` + a vault deposit). No Claim
  Center claim is created — check your vault balance after
  the sale lands.

**What you can't combine it with.** Two distinct conflict
classes, surfaced at different protocol stages:

- *Publish-time block (sibling loan-keyed listing).* If the
  loan already has a parallel-sale listing carrying through
  from offer-create AND the borrower then calls
  `NFTPrepayListingFacet.postPrepayListing` (or `updatePrepayListing`)
  to post a SECOND loan-keyed prepay listing on the same loan,
  the diamond reverts with `SiblingParallelSaleListingLive`.
  The conduit approval for the borrower's NFT is a single
  slot — running both listings concurrently would create an
  ambiguous approval. The borrower sees the revert at the
  publish/update call; nothing fills.
- *Fill-time block (open PrecloseFacet offset).* If the loan
  has an open PrecloseFacet offset offer AND a buyer later
  tries to fill the parallel-sale listing, the diamond's
  `_settleLoanFromParallelSale` reverts with
  `ParallelSaleBlockedByOpenOffsetOffer`. The listing remains
  valid on OpenSea but any fill attempt reverts until the
  offset link is cleared. The dapp does NOT currently surface
  a dedicated banner / notification on the Loan Details page
  for this combination; users will see fills revert and may
  need to inspect the revert reason on a block explorer to
  diagnose. The cleanup path is the ordinary offer-cancel
  surface — call `OfferCancelFacet.cancelOffer(offsetOfferId)`
  to cancel the offset offer, which releases the offset link
  and unblocks the parallel-sale fill (PrecloseFacet has no
  separate cancellation entry point; the offset is bound to
  the linked offer, so cancelling the linked offer clears it).
  A dedicated UI surface for the conflict is queued as a
  separate UX follow-up.



## [TRANSLATION NEEDED] EN source — Matching OpenSea offers on a prepay listing (target placement: `matching-opensea-offers-on-a-prepay-listing`)

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Matching OpenSea offers on a prepay listing

Once your prepay listing is live on OpenSea's marketplace,
casual buyers will sometimes place **item offers** directly
on your token — bids tied to your specific collateral, not
to any token in the collection. Vaipakam surfaces these item
offers on the Loan Details page in real time — a separate
panel under "List collateral on OpenSea" with one row per
incoming offer. The panel applies a **buffer threshold** —
the lender's settlement entitlement (which ALREADY INCLUDES
principal plus the full coupon for full-term-interest loans
or the pro-rata interest otherwise — see
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus the
treasury cut, plus a safety buffer — and **greys out** offers
that don't clear it. You can see market interest at every
level but can only Match offers that the protocol will
actually settle.

Collection-wide / criteria offers (bids that any token in
the collection can fulfill) stay on OpenSea but **don't
appear** in the dapp's Match panel — the multi-leg
consideration the protocol settles into can't be
reconstructed against a criteria offer without contract-side
plumbing that isn't in v1. If your only inbound demand is
collection-wide, the practical path today is to wait for
an item-specific bid OR to leave the listing at your fixed
ask and let any buyer fulfill it directly. You cannot
manually settle a collection-wide bid yourself — the
collateral NFT lives in your Vaipakam vault, and Vaipakam-
side Seaport orders are the only authorised settlement
shape.

On collections that enforce OpenSea protocol fees and/or
creator royalties, the dapp DOES render the offers panel —
the fee-schedule fetch from the OpenSea API is treated as
advisory; the actual fulfillment data is fetched at
Match-click time. If that fulfillment-data fetch fails (rate
limit, API outage, or unsupported collection shape), the
dapp-side Match click handler ABORTS before any
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` transaction
is constructed — no calldata, no signature prompt, no
revert. The on-chain function itself isn't a `bool`-returning
selector; when it does run it returns a `bytes32` order hash
or reverts. So a fee-enforced collection's panel may show
offers you can browse but not all of them are clickable-
to-match in a given moment.

When you find an acceptable offer and click **Match offer**,
the dapp opens the **Confirm Match** modal, which restates the
matched value (the gross OpenSea offer amount the panel showed
— NOT the net amount the diamond will settle at; on
fee-enforced collections `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
computes `effectiveAsk = offerValue - bidderFeeTotal` before
running the lender / treasury / borrower split, so the net the
diamond actually distributes is smaller than the modal's
headline) and gives a generic explanation of the atomic-match
flow. After you
confirm, the dapp sends a single `matchOpenSeaOffer`
transaction that bundles the bidder's offer with a freshly-
constructed diamond-side counter-order into one Seaport
`matchAdvancedOrders` call — the bidder's fulfilment, the
counter-order's listing-side leg (whether or not you had a
prior v1 prepay listing live; the atomic path supports
`existingHash == 0`), and the diamond's settlement waterfall
all land atomically in one block. The transaction either fully succeeds (loan
settled, NFT transferred, sale proceeds split) or fully
reverts (nothing moves), and there is **no window between
listing rotation and settlement** in which a third-party
buyer could step in at the matched price.

> **No race window — atomic by construction.** This is the
> structural close-out of the v1 two-step "cancel + post"
> pattern: under v1 the dapp would rotate the listing as a
> separate `updatePrepayListing` transaction, leaving the
> rotated price live on OpenSea until the bidder's
> `fulfillOrder` landed in a later block — anyone watching
> the mempool could snipe the bidder out of the price they
> bid. The atomic path closes that hole by binding both
> orders into one Seaport match call: either the bidder fills
> at the agreed price or the whole transaction reverts.

**What you still want to verify before clicking Match:**

- **Confirm the matched value in the modal.** The modal
  surfaces the gross OpenSea offer amount. On fee-enforced
  collections, the diamond settles against the net effective
  ask after bidder-side marketplace / creator fee legs, so the
  modal value can be higher than the amount used for the
  lender / treasury / borrower split. The bidder address and
  the precise split aren't broken out in either the modal OR
  the OpenSea Offers panel row (the row shows value, payment
  token, offer kind, truncated bidder, and end time). The split
  is enforced on-chain by the diamond at settlement — the
  protocol's settlement buffer guarantees the effective ask covers
  the lender's settlement entitlement (which already includes
  principal plus the full coupon on full-term-interest loans
  or the pro-rata interest otherwise) plus the
  treasury cut, so the split is always at least neutral for
  you. If you want to see the projected split before
  confirming, the diamond exposes
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  as a callable view — it returns the lender and treasury legs
  the settlement waterfall will route at the given timestamp,
  and the remainder is yours.
- **Check OpenSea's fee posture for the collection.** If the
  collection enforces OpenSea protocol fees or creator
  royalties, the atomic path needs SignedZone `extraData` /
  criteria-resolver plumbing that the dapp fetches via the
  agent's OpenSea fulfillment-data proxy (PR #349) AT MATCH
  CLICK TIME. The Match panel renders regardless of
  fee-schedule fetch status; the click-time fulfillment-data
  fetch is the gate. If that fetch fails (rate limit, API
  outage, unsupported collection shape), the dapp-side click
  handler aborts before constructing the on-chain
  `matchOpenSeaOffer` transaction — no calldata is built,
  no signature prompt fires, no banner is shown in advance.
  You can retry the click later (the fetch may have just
  been a transient API blip), or fill the listing directly
  on OpenSea at the listed ask in the meantime.


