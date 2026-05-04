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

Vaipakam transportiert VPFI chainübergreifend über LayerZero V2.
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
  schickt ein LayerZero-Paket an den kanonischen Receiver auf
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
