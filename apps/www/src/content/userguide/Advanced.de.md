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

### Deine aktiven Angebote

Offene Angebote (Status Active, Ablauf noch nicht erreicht), die
du erstellt hast. Jederzeit vor der Annahme stornierbar — der
Stornoaufruf ist kostenlos. Die Annahme schaltet das Angebot auf
Accepted um und löst die Kreditinitialisierung aus, die die beiden
Positions-NFTs mintet (eines für den Verleiher, eines für den
Kreditnehmer) und den Kredit im Active-Status öffnet.

Geschlossene Angebote tragen einen von mehreren unterschiedlichen
Status. Einige werden bereits als Filter-Chips auf der Mein-Angebote-
Seite angezeigt; andere sind Indexer-seitige Terminals, die in
Folgearbeiten dedizierte UI-Behandlung erhalten:

- **Filled** — von einer Gegenpartei akzeptiert; die Kreditreferenz
  des Angebots ist die resultierende Kredit-ID.
- **Cancelled** — das Angebot erreichte den Cancelled-Status über
  einen der beiden Wege: vom Ersteller vor der Annahme
  zurückgezogen ODER permissionslos bereinigt via
  `OfferCancelFacet.cancelOffer`, sobald
  `LibVaipakam.isOfferExpired(offer)` wahr ist (die Rückerstattung
  wird unabhängig davon, wer den Cancel-Aufruf initiiert hat,
  immer noch an den Ersteller geroutet).
- **Sold** — das Angebot wurde in den borrow-OR-sell Parallel-Sale-
  Flow aufgenommen (siehe Angebot erstellen → Optionalen Verkauf
  erlauben) und ein Marketplace-Käufer hat das NFT-Collateral-
  Listing erfüllt, bevor ein Verleiher akzeptiert hat. Das
  Angebot trägt den On-Chain-Status `consumed_by_sale`; die
  Rate-Spalte der Zeile zeigt die Rate, zu der das Angebot
  gepostet wurde, und die Collateral-Zelle rendert die NFT-Form
  (Token-ID für ERC-721, Kopienanzahl für ERC-1155). Die dapp
  zeigt die Zeile auch im Activity-Feed als `Offer sold via
  OpenSea` für den Kreditnehmer (Angebotsersteller) an. Das
  On-Chain-Event selbst ist
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  sowohl die Offer-ID ALS AUCH die Executor-Adresse sind on-chain
  indiziert, aber die Kreditnehmer- / Erstelleradresse NICHT.
  Die Wallet-Übereinstimmung des Kreditnehmers für den
  Activity-Feed wird vom Indexer zur Ingestion-Zeit hinzugefügt
  (er joint die Angebotszeile, um den Ersteller nachzuschlagen),
  sodass der Per-Wallet-Filter den Kreditnehmer findet, ohne dass
  das Event ihn selbst indiziert.
- **Fully Filled (Indexer-Zustand, noch kein Chip)** — nur für
  Range-Orders. Wenn Partial-Fill-Matching das verbleibende
  Budget des Angebots verbraucht (das letzte Match füllt den
  Bereich vollständig oder ein Partial-Match hinterlässt einen
  Sub-Dust-Rest), emittiert `OfferMatchFacet`
  `OfferClosed(FullyFilled | Dust)` und der Indexer markiert die
  Angebotszeile mit `status = 'fullyFilled'`. Der `accepted`-
  Zustand des Vertrags und das On-Chain-Filled-Label oben sind
  für das Direct-Accept-Terminal reserviert, sodass `fullyFilled`
  Indexer-seitig unterschieden wird. Der `MyOfferStatus` der dapp
  exponiert dieses Terminal noch nicht als eigenen Filter-Chip —
  `useMyOffers` ignoriert derzeit Zeilen mit dem
  `fullyFilled`-Indexer-Status — sodass ein vollständig
  gefülltes Range-Angebot effektiv aus der Mein-Angebote-Ansicht
  herausfällt, bis der dedizierte Chip landet. Die Chip-Oberfläche
  ist als separates UI-Follow-up in der Warteschlange.

Past-GTT (GTT-Ablaufzeit) Angebote, die nie ein Terminal-Event
erreicht haben, sind noch nicht als eigener Status-Chip in der
dapp exponiert; sie fallen derzeit unter Active, bis der Indexer
ein Terminal aufzeichnet. Ein dedizierter Expired-Chip ist als
separates UI-Follow-up in der Warteschlange.


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
vorausbezahlte Mietgebühr aus dem Vault des Mieters in die
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
  Slippage ausgehöhlt sind, um den Lender zurückzuzahlen. Der Swap ist permissionless — jeder
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

<a id="create-offer.borrow-or-sell"></a>

### Optionalen Verkauf dieses NFTs auf OpenSea erlauben (nur Kreditnehmer-Angebote mit NFT-Collateral)

Wenn du ein **Kreditnehmer-Angebot** mit **ERC-721- oder
ERC-1155-Collateral** und einem **ERC-20-Principal** postest,
exponiert die dapp ein `Borrow or sell` Opt-in unter dem
Collateral-Abschnitt. Das Ankreuzen markiert das Angebot als
berechtigt für ein Parallel-Sale-Listing deines NFT-Collaterals
auf OpenSea — ein einzelnes Angebot, das ENTWEDER von einem
Verleiher (du nimmst den Kredit auf) ODER von einem Marketplace-
Käufer (du verkaufst das NFT) erfüllt werden kann. Das Listing
wird bei der Verleiher-Annahme NICHT abgebaut, falls es bereits
gepostet war: Wenn ein Verleiher zuerst erfüllt, nimmst du den
Kredit auf, das bestehende OpenSea-Listing wird durch die
Kreditinitialisierung bis zu seinem ursprünglichen Seaport-
Ablauf übertragen, und eine spätere Marketplace-Erfüllung vor
diesem Ablauf löst die Settlement-Waterfall des Diamonds aus, um
den Kredit aus den Verkaufserlösen zu schließen (siehe Szenario B
unten). Für gewöhnliche GTT-Angebote ist dieser Ablauf das
ursprüngliche GTT-Ablaufzeit des Angebots; die Verleiher-Annahme
verlängert das Listing nicht und postet es nicht für die volle
Kreditlaufzeit neu. Wenn ein Marketplace-Käufer zuerst erfüllt,
wird nie ein Kredit erstellt (Szenario A). Die zwei Szenarien
enden in unterschiedlichen Angebotszuständen: Szenario A markiert
das Angebot mit `consumed_by_sale` via `markOfferConsumedBySale`
(es erscheint unter dem Sold-Filter), und die Verleiher-Annahme
ist gegen jedes bereits markierte Angebot gegated. In Szenario B
ist das Angebot bereits im `Accepted`-Zustand, wenn die
Marketplace-Erfüllung landet; der Vertrag lässt den Angebotsstatus
absichtlich bei `Accepted` und settelt nur den Kredit aus dem
Verkauf — das Angebot transitioniert nicht ein zweites Mal zu
Sold.

**Zwei-Schritt-Natur.** Das Opt-in zur Angebotserstellungszeit
setzt nur das Berechtigungsflag am Angebot. Ein tatsächlich
kaufbares Listing auf OpenSea zu bekommen ist ein SEPARATER
ZWEI-TEILE-Schritt, den die dapp heute NICHT automatisiert:

1. **Registrieren + Verdrahten am Diamond.** Rufe
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` auf, während das Angebot noch aktiv ist und vor
   einer Verleiher-Annahme. Sobald das Angebot akzeptiert,
   storniert oder durch Verkauf verbraucht ist, revertiert dieser
   Aufruf als terminal; nur das Opt-in zu markieren reicht nicht
   aus, um ein Listing zu erstellen, das in Szenario B übertragen
   werden kann. Der Ask muss auch den Pre-Loan-Floor decken:
   Principal plus Worst-Case-Angebot-Interesse über die
   Kreditlaufzeit und das Grace-Fenster, Treasury-Anteil auf
   diese Zinsen, der konfigurierte Sicherheits-Buffer und alle
   Fee-Leg-Beträge. Asks unter dem Floor revertieren in diesem
   Schritt. Das `feeLegs`-Argument ist der EINZIGE Ort, an dem
   dieser Aufruf OpenSea-Protokoll-Fee- und Creator-Royalty-
   Verpflichtungen aufzeichnet: der Diamond zieht jeden Fee-Leg-
   Betrag von den Verkäufererlösen ab und hängt den Empfänger +
   absoluten Betrag an das Seaport-Consideration-Array an.
   `feeLegs: []` auf einer Fee-Enforced-Collection zu übergeben
   produziert eine Order-Form, die der OpenSea-Publish-Schritt
   ablehnt (die Fee-Recipient-Consideration-Items fehlen), und
   ein direkter Seaport-Fill routet den vollen Ask an den
   Verkäufer, statt die Fees aufzuteilen, wie es die Collection
   verlangt. Erfahrene Benutzer müssen den OpenSea-Required-Fee-
   Zeitplan für die Collection fetchen (der In-Repo-Fee-Parser
   bei `apps/defi/src/lib/openseaFeeSchedule.ts` ist die Referenz) und
   absolute, gegen den Ask abgeleitete Beträge vor dem Aufruf
   übergeben. Der Facet baut intern die kanonischen Seaport
   OrderComponents aus diesen Eingaben (plus Werte, die er in
   `CollateralListingExecutor.offerContext` hält — die Vault-
   Adresse des Kreditnehmers, Principal-Asset, Collateral-Felder,
   startTime, endTime) und dem aktuellen `Seaport.getCounter`
   für das Vault, leitet den orderHash via `Seaport.getOrderHash`
   ab, gibt ihn zurück, registriert das ERC-1271-Binding des
   Vaults an diesen Hash und gewährt die Seaport-Conduit-
   Approval für das NFT-Collateral. Das emittierte
   `PostParallelSaleListing`-Event exponiert die Input-Args
   (`offerId`, Kreditnehmer, orderHash, askPrice, Executor- /
   Conduit-Daten, Salt, Fee-Legs); es echote NICHT die
   Per-Context-Felder, sodass die Rekonstruktion von
   OrderComponents off-chain die zusätzlichen Reads aus Schritt 2
   unten erfordert. **Wichtig:** an diesem Punkt ist die Order
   bereits ÜBER SEAPORT ERFÜLLBAR. Ein Bot, der die Events des
   Contracts plus diese Reads beobachtet, kann die
   OrderComponents rekonstruieren und `Seaport.fulfillOrder`
   direkt aufrufen — das Listing muss nicht auf OpenSeas
   Marketplace-UI erscheinen, damit der On-Chain-Fill-Pfad
   funktioniert. Wenn du nicht möchtest, dass Gegenparteien zum
   aktuellen Ask erfüllen, bevor Schritt 2 landet, führe entweder
   Schritt 2 sofort nach Schritt 1 aus ODER rufe
   `releaseParallelSaleLock` auf, um das Binding vor einer
   unbeabsichtigten Erfüllung zu invalidieren.
2. **Auf OpenSea veröffentlichen.** Rekonstruiere dieselben
   OrderComponents, die der Facet gebaut hat. Das
   `PostParallelSaleListing`-Event allein reicht nicht: es
   emittiert `offerId`, Kreditnehmer, orderHash, askPrice,
   Executor- / Conduit-Daten, Salt und Fee-Legs, aber die
   Offer-keyed Order-Form benötigt auch Werte, die im
   `OfferContext`-Storage des Executors gehalten werden (Vault-
   Adresse des Kreditnehmers, Principal-Asset, Collateral-Felder,
   startTime, endTime) plus den Seaport-Counter des Kreditnehmer-
   Vaults (der Counter des Offerers —
   `LibPrepayOrder.buildAndHashOfferMem` hashed
   `Seaport.getCounter(ctx.borrowerVault)`, NICHT den Counter
   des Bidders). Das ist derselbe Kontext, den der
   `LibPrepayOrder.buildAndHashOfferMem`-Offer-Order-Pfad
   verwendet, und er unterscheidet sich von der Loan-keyed
   Prepay-Listing-Order-Form. Lies beides vor dem Posten:
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     gibt das persistierte `OfferContext`-Struct für diesen
     Hash zurück.
   - `Seaport.getCounter(borrowerVault)` gibt den kanonischen
     Seaport-Counter für den Vault-Offerer zurück.
   Mit diesen Feldern in der Hand reproduziert das
   OrderComponents-Struct genau das, was der Diamond gehashed
   hat. Vor dem POSTen füge das API-only-Feld
   `parameters.totalOriginalConsiderationItems` hinzu — die
   OpenSea-API verlangt es, obwohl es NICHT Teil des Seaport-
   Structs ist, das den kanonischen Hash produziert; die
   In-Repo-Publisher (`apps/defi/src/lib/openseaPublish.ts` +
   `apps/indexer/src/openseaPublish.ts`) injizieren es vor dem
   Endpoint-Aufruf. Für ERC-1271-validierte Orders akzeptiert
   OpenSea das `signature`-Feld als `0x` (leere Bytes) — der
   On-Chain-Callback des Vaults `isValidSignature(orderHash,
   '')` ignoriert die Signatur-Bytes und gibt den EIP-1271-
   Magic-Value für jeden orderHash zurück, den der Diamond zuvor
   registriert hat (aus Schritt 1). POSTe das JSON an den OpenSea-
   Listings-Endpoint (`POST
   /api/v2/orders/{chain}/{protocol}/listings`, gemäß den
   offiziellen [Create Listing](https://docs.opensea.io/reference/post_listing)-
   Docs — das ist derselbe Endpoint, den die Vaipakam-eigenen
   Publisher in `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` verwenden). Erst nach
   diesem Schritt erscheint das Listing auf der OpenSea-
   Marketplace-UI und wird für gelegentliche Käufer
   auffindbar. Vaipakam automatisiert diese Übermittlung für den
   Parallel-Sale-Pfad derzeit nicht — die End-to-End-Publish-
   Oberfläche ist als Follow-up nachverfolgt.

Erfahrene Benutzer, die heute dem manuellen Pfad folgen, brauchen
BEIDE Schritte für OpenSea-Sichtbarkeit; nur Schritt 1
auszuführen produziert eine Order, die direkt über Seaport
erfüllbar ist (durch einen Bot oder Gegenpartei, die die
Komponenten aus dem Event rekonstruiert), aber unsichtbar auf der
OpenSea-Marketplace-UI.

**Fill-Modus auf All-or-Nothing erzwungen.** Das Opt-in fixiert
den Fill-Modus des Angebots automatisch auf `Aon` — Partial-
oder IOC-Fill-Modi mit aktivierter Parallel-Sale-Option würden
mehrere Kredite gegen das Collateral eines einzelnen Angebots
erstellen, wogegen der Vertrag gated. Der Toggle ist bei
Verleiher-Angeboten, ERC-20-Collateral, NFT-Principals und jeder
anderen Form ausgeblendet, die das `_validatePostParallelSale`
des Vertrags ablehnen würde, sodass du es nicht versehentlich
auf einem nicht berechtigten Angebot ankreuzen kannst.

**Was ein Käufer sieht.**

- *Bevor ein Verleiher akzeptiert* (Szenario A): ein Käufer, der
  das OpenSea-Listing erfüllt, zahlt den gelisteten Preis. Auf
  Fee-Enforced-Collections routet Seaport OpenSea-Protokoll-Fee-
  und Creator-Fee-Legs zuerst direkt an ihre konfigurierten
  Empfänger; der Executor übergibt nur die **Netto-Erlöse**
  (gelisteter Preis minus diese Marketplace- / Creator-Fee-Legs)
  an den Diamond. Der Diamond escrowed diesen Netto-Betrag in
  deinem Vault, das NFT transferiert sich an den Käufer und das
  Angebot wird mit `consumed_by_sale` markiert (sichtbar als
  eigener "Sold"-Status in Meine Angebote, Activity und Angebot-
  Details). Es wurde nie ein Kredit erstellt; du behältst die
  Netto-Verkaufserlöse.
- *Nachdem ein Verleiher akzeptiert hat* (Szenario B): das
  Listing wird durch die Kreditinitialisierung übertragen —
  weder der Kreditnehmer-NFT-Lock noch das Listing werden
  abgebaut. Eine spätere Käufer-Erfüllung löst die Settlement-
  Waterfall des Diamonds in einer Seaport-Transaktion aus. Gleiche
  Fee-Leg-Notiz wie Szenario A: auf Fee-Enforced-Collections
  routet Seaport OpenSea-Protokoll-Fee- und Creator-Fee-Legs
  zuerst direkt an ihre konfigurierten Empfänger, und der
  Executor übergibt nur die **Netto-Erlöse** (Verkaufspreis minus
  Marketplace- / Creator-Fees) an die Waterfall des Diamonds.
  Die Waterfall routet diesen Netto-Betrag dann: der Verleiher
  erhält sein Settlement-Entitlement (das
  `LibEntitlement.settlementInterest` als vollen Coupon
  berechnet, wenn der Kredit mit `useFullTermInterest = true`
  erstellt wurde, oder ansonsten als die zum Settlement-
  Timestamp aufgelaufenen Pro-Rata-Zinsen — das Gate ist die
  Kreditpolitik, nicht ob der Verkauf vor oder nach der
  geplanten Fälligkeit stattfindet), der Treasury-Anteil geht an
  die Treasury und der Rest wird DIREKT in das Vault des
  aktuellen Kreditnehmer-Position-NFT-Holders deponiert (via
  `LibUserVault.getOrCreate` + ein Vault-Deposit). Es wird kein
  Claim-Center-Claim erstellt — prüfe deinen Vault-Saldo, nachdem
  der Verkauf gelandet ist.

**Womit du es nicht kombinieren kannst.** Zwei verschiedene
Konfliktklassen, in unterschiedlichen Protokollphasen
oberflächlich gemacht:

- *Publish-Zeit-Block (Geschwister-Loan-keyed-Listing).* Wenn der
  Kredit bereits ein Parallel-Sale-Listing hat, das aus der
  Angebotserstellung übernommen wurde UND der Kreditnehmer dann
  `NFTPrepayListingFacet.postPrepayListing` (oder
  `updatePrepayListing`) aufruft, um ein ZWEITES Loan-keyed-
  Prepay-Listing auf demselben Kredit zu posten, revertiert der
  Diamond mit `SiblingParallelSaleListingLive`. Die Conduit-
  Approval für das NFT des Kreditnehmers ist ein einzelner Slot —
  beide Listings gleichzeitig laufen zu lassen würde eine
  mehrdeutige Approval erzeugen. Der Kreditnehmer sieht den
  Revert beim Publish-/Update-Aufruf; nichts erfüllt sich.
- *Fill-Zeit-Block (offenes PrecloseFacet-Offset).* Wenn der
  Kredit ein offenes PrecloseFacet-Offset-Angebot hat UND ein
  Käufer später versucht, das Parallel-Sale-Listing zu erfüllen,
  revertiert das `_settleLoanFromParallelSale` des Diamonds mit
  `ParallelSaleBlockedByOpenOffsetOffer`. Das Listing bleibt auf
  OpenSea gültig, aber jeder Fill-Versuch revertiert, bis der
  Offset-Link gelöscht wird. Die dapp zeigt derzeit KEIN
  dediziertes Banner / keine Benachrichtigung auf der Kredit-
  Details-Seite für diese Kombination an; Benutzer werden
  Fills revertieren sehen und müssen möglicherweise den Revert-
  Grund in einem Block-Explorer inspizieren, um zu diagnostizieren.
  Der Cleanup-Pfad ist die gewöhnliche Offer-Cancel-Oberfläche
  — rufe `OfferCancelFacet.cancelOffer(offsetOfferId)` auf, um das
  Offset-Angebot zu stornieren, was den Offset-Link freigibt und
  den Parallel-Sale-Fill entsperrt (PrecloseFacet hat keinen
  separaten Cancellation-Entry-Point; das Offset ist an das
  verknüpfte Angebot gebunden, sodass das Stornieren des
  verknüpften Angebots es löscht). Eine dedizierte UI-Oberfläche
  für den Konflikt ist als separates UX-Follow-up in der
  Warteschlange.


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

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### OpenSea-Offers auf einem Prepay-Listing matchen

Sobald dein Prepay-Listing auf dem OpenSea-Marketplace live ist,
platzieren gelegentliche Käufer manchmal **Item-Offers** direkt
auf deinem Token — Bids, die an dein spezifisches Collateral
gebunden sind, nicht an irgendein Token in der Collection.
Vaipakam zeigt diese Item-Offers in Echtzeit auf der Kredit-
Details-Seite an — einen separaten Bereich unter "Kollateral auf OpenSea listen" mit einer Zeile pro eingehendem Offer. Der Bereich wendet
einen **Buffer-Threshold** an — das Settlement-Entitlement des
Verleihers (das BEREITS Principal plus den vollen Coupon bei
Full-Term-Interest-Krediten oder die Pro-Rata-Zinsen ansonsten
EINSCHLIESST — siehe
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus den
Treasury-Anteil, plus einen Sicherheits-Buffer — und **gräulicht**
Offers aus, die ihn nicht erreichen. Aus du kannst auf jedem Niveau
Marktinteresse sehen, aber nur Offers matchen, die das Protokoll
tatsächlich settlen wird.

Collection-weite / Criteria-Offers (Bids, die jedes Token in der
Collection erfüllen kann) bleiben auf OpenSea, aber **erscheinen
nicht** im Match-Bereich der dapp — die Multi-Leg-Consideration,
die das Protokoll settelt, kann gegen ein Criteria-Offer nicht
ohne contract-seitige Plumbing rekonstruiert werden, das nicht in
v1 ist. Wenn deine einzige eingehende Nachfrage collection-weit
ist, ist der praktische Pfad heute, auf einen item-spezifischen
Bid zu warten ODER das Listing zu deinem festen Ask zu lassen
und jedem Käufer zu erlauben, es direkt zu erfüllen. Du kannst
einen collection-weiten Bid nicht manuell selbst settlen — das
Collateral-NFT lebt in deinem Vaipakam-Vault, und Vaipakam-
seitige Seaport-Orders sind die einzige autorisierte Settlement-
Form.

Auf Collections, die OpenSea-Protokoll-Fees und/oder Creator-
Royalties durchsetzen, rendert die dapp DAS Offers-Bereich — der
Fee-Schedule-Fetch von der OpenSea-API wird als beratend
behandelt; die tatsächlichen Fulfillment-Daten werden zur MATCH-
KLICK-ZEIT gefetcht. Der Match-Bereich rendert unabhängig vom
Fee-Schedule-Fetch-Status; der Click-Time-Fulfillment-Daten-Fetch
ist das Gate. Wenn dieser Fetch fehlschlägt (Rate-Limit, API-
Ausfall, oder nicht unterstützte Collection-Form), BRICHT der
dapp-seitige Click-Handler ab, bevor eine
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer`-Transaktion
konstruiert wird — kein Calldata, kein Signaturprompt, kein
Revert. Die On-Chain-Funktion selbst ist kein `bool`-
zurückgebender Selector; wenn sie läuft, gibt sie einen `bytes32`-
OrderHash zurück oder revertiert. Der Bereich einer Fee-Enforced-
Collection kann also Offers zeigen, die du durchsuchen kannst,
aber nicht alle von ihnen sind in einem bestimmten Moment
klickbar-zum-Matchen.

Wenn du ein akzeptables Offer findest und auf **Angebot matchen**
klickst, öffnet die dapp den **Match bestätigen**-Bestätigungsdialog, das den
gematchten Wert (den Brutto-OpenSea-Offer-Betrag — NICHT den
Netto-Betrag, zu dem der Diamond settelt; auf Fee-Enforced-
Collections berechnet
`NFTPrepayListingAtomicFacet.matchOpenSeaOffer` `effectiveAsk =
offerValue - bidderFeeTotal` vor der Aufteilung Verleiher /
Treasury / Kreditnehmer, sodass der Netto-Betrag, den der
Diamond tatsächlich verteilt, kleiner ist als das Headline des
Bestätigungsdialogs) und eine generische Erklärung des Atomic-Match-Flows
gibt. Nach Bestätigung sendet die dapp eine einzelne
`matchOpenSeaOffer`-Transaktion, die das Bidder-Offer mit einer
frisch konstruierten Diamond-seitigen Counter-Order in einen
einzelnen `matchAdvancedOrders`-Seaport-Aufruf bündelt — die
Bidder-Erfüllung, das Listing-seitige Leg der Counter-Order
(unabhängig davon, ob du ein vorheriges v1-Prepay-Listing live
hattest oder nicht; der Atomic-Pfad unterstützt `existingHash ==
0`) und die Settlement-Waterfall des Diamonds landen atomar in
einem Block. Die Transaktion hat entweder vollen Erfolg
(Kredit gesettelt, NFT transferiert, Verkaufserlöse aufgeteilt)
oder revertiert vollständig (nichts bewegt sich), und es gibt
KEIN Fenster zwischen Listing-Rotation und Settlement, in dem
ein Dritt-Käufer beim matched price eingreifen könnte.

> **Kein Race-Window — atomar per Konstruktion.** Das ist die
> strukturelle Schließung des v1-Zwei-Schritt-"cancel + post"-
> Patterns: unter v1 würde die dapp das Listing als separate
> `updatePrepayListing`-Transaktion rotieren und den rotierten
> Preis auf OpenSea live lassen, bis der `fulfillOrder` des
> Bidders in einem späteren Block landet — jeder, der den
> Mempool beobachtet, könnte den Bidder aus dem Preis ausstechen,
> den er geboten hatte. Der Atomic-Pfad schließt diese Lücke,
> indem er beide Orders in einen Seaport-Match-Aufruf bindet:
> Entweder erfüllt der Bidder zum vereinbarten Preis oder die
> gesamte Transaktion revertiert.

**Was du vor dem Klick auf Match noch verifizieren willst:**

- **Bestätige den gematchten Wert im Bestätigungsdialog.** Der Bestätigungsdialog zeigt den
  Brutto-OpenSea-Offer-Betrag. Auf Fee-Enforced-Collections
  settelt der Diamond gegen den Netto-Effective-Ask nach
  Bidder-seitigen Marketplace- / Creator-Fee-Legs, sodass der
  Wert im Bestätigungsdialog höher sein kann als der Betrag, der für die
  Verleiher- / Treasury- / Kreditnehmer-Aufteilung verwendet
  wird. Die Bidder-Adresse und die genaue Aufteilung sind weder
  im Bestätigungsdialog NOCH in der Zeile im OpenSea-Offers-Bereich aufgeschlüsselt
  (die Zeile zeigt Wert, Payment-Token, Offer-Art, abgeschnittenen
  Bidder und End-Time). Die Aufteilung wird on-chain vom Diamond
  beim Settlement durchgesetzt — der Settlement-Buffer des
  Protokolls garantiert, dass der Effective-Ask das Settlement-
  Entitlement des Verleihers (das bereits Principal plus den
  vollen Coupon bei Full-Term-Interest-Krediten oder die Pro-Rata-
  Zinsen ansonsten einschließt) plus den Treasury-Anteil deckt,
  sodass die Aufteilung immer mindestens neutral für dich ist.
  Wenn du die projizierte Aufteilung vor der Bestätigung sehen
  willst, exponiert der Diamond
  `PrepayListingFacet.getPrepayContext(loanId, asOfTimestamp)`
  als aufrufbare View — er gibt die Verleiher- und Treasury-Legs
  zurück, die die Settlement-Waterfall zum gegebenen Timestamp
  routen wird, und der Rest gehört dir.
- **Prüfe OpenSeas Fee-Posture für die Collection.** Wenn die
  Collection OpenSea-Protokoll-Fees oder Creator-Royalties
  durchsetzt, benötigt der Atomic-Pfad SignedZone-`extraData`- /
  Criteria-Resolver-Plumbing, das die dapp über den OpenSea-
  Fulfillment-Daten-Proxy des Agents (PR #349) ZUR MATCH-KLICK-
  ZEIT fetcht. Der Match-Bereich rendert unabhängig vom Fee-
  Schedule-Fetch-Status; der Click-Time-Fulfillment-Daten-Fetch
  ist das Gate. Wenn dieser Fetch fehlschlägt (Rate-Limit, API-
  Ausfall, nicht unterstützte Collection-Form), bricht der
  Click-Handler der dapp ab, bevor er die On-Chain-
  `matchOpenSeaOffer`-Transaktion konstruiert — kein Calldata
  wird gebaut, kein Signaturprompt feuert, kein Banner wird im
  Voraus gezeigt. Du kannst den Click später erneut versuchen
  (der Fetch könnte nur ein vorübergehender API-Blip gewesen
  sein), oder das Listing direkt auf OpenSea zum gelisteten Ask
  in der Zwischenzeit erfüllen.

---

## Wie Liquidationen tatsächlich funktionieren

Die Risiko-Hinweise, denen du bei der Angebotserstellung zugestimmt hast, fassen das Worst-Case-Szenario in zwei Sätzen zusammen. Dieser Abschnitt erklärt die zugrunde liegenden Mechanismen — nützlich, wenn du verstehen willst, WARUM der In-Kind-Fallback existiert oder welchen der vier Wege dein Loan tatsächlich nehmen würde.

Die Vertragsfunktion, die über die Aufteilung entscheidet, ist `LibFallback.computeFallbackEntitlements`. Sie durchläuft vier Fälle in der angegebenen Reihenfolge; der ERSTE Fall, der zutrifft, wird ausgeführt.

<a id="liquidation-mechanics.case-1"></a>

### Fall 1 — Orakel verfügbar, Collateral wert ≥ fälliger Betrag

Der gesunde Pfad. Chainlink-Preisfeeds antworten, das sekundäre Soft-2-aus-N-Quorum (Tellor + API3 + DIA) hat nicht widersprochen, und das beschlagnahmte Collateral deckt den geschuldeten Betrag bei Bewertung durch das Orakel.

Was passiert:
- Der Lender erhält **Collateral-Assets** im Wert von (Principal + aufgelaufene Zinsen + 3% Fallback-Bonus), bewertet durch das Orakel. Effekt: Der Lender wird zum beizulegenden Zeitwert entschädigt, gezahlt im Collateral-Asset statt im Lending-Asset.
- Die Treasury erhält eine Prämie von 2% des Principals, ebenfalls im Collateral-Asset bewertet.
- Der Borrower erhält das **verbleibende** Collateral zurück. Dies ist eine echte Rückerstattung — es handelt sich um die Überbesicherung, die nicht zur Deckung der Forderung des Lenders benötigt wurde.

Beispiel: Ein Loan von 1000 USDC gegen 0,6 WETH (3000 $ Collateral, 1000 $ Schulden). Das Orakel bewertet ETH mit 5000 $/WETH; Schulden + Zinsen + Bonus = 1050 $. Der Lender erhält 0,21 WETH (Wert 1050 $), die Treasury erhält 0,004 WETH (Wert 20 $ der 2%-Prämie), der Borrower erhält die verbleibenden ~0,386 WETH.

<a id="liquidation-mechanics.case-2"></a>

### Fall 2 — Orakel verfügbar, Collateral wert < fälliger Betrag

Der "Unterwasser"-Pfad. Das Orakel funktioniert, aber das beschlagnahmte Collateral ist selbst zum Orakelpreis weniger wert als der fällige Betrag. Häufig bei Abstürzen volatiler Assets, bei denen der Collateral-Wert schneller fällt, als der HF reagieren kann.

Was passiert:
- Der Lender erhält **ALLES** beschlagnahmte Collateral im Collateral-Asset.
- Die Treasury erhält nichts.
- Der Borrower erhält nichts — es gibt keinen Rest zur Rückerstattung.

Der Lender fängt den Fehlbetrag auf. Es besteht kein weiterer Anspruch gegen den Borrower, das Protokoll oder Dritte. Dies ist der Fall, vor dem die Zeile "Wiedererlangung kann geringer sein als das verliehene Asset" in den Risiko-Hinweisen ausdrücklich warnt.

Beispiel: Derselbe 1000 USDC / 0,6 WETH Loan, aber ETH stürzt auf 1500 $/WETH ab. Collateral jetzt 900 $ wert; Schulden sind 1050 $. Der Lender erhält alle 0,6 WETH (Wert 900 $), Treasury 0, Borrower 0.

<a id="liquidation-mechanics.case-3"></a>

### Fall 3 — Orakel-Quorum NICHT VERFÜGBAR

Der Pfad des "dunklen Quorums". Die Veraltung von Chainlink liegt über der Volatilitätsgrenze UND das sekundäre 2-aus-N-Quorum findet keine Einigung (jedes sekundäre Orakel ist entweder offline oder widerspricht dem primären). Das Protokoll hat keinen vertrauenswürdigen Preis für eine der Seiten des Loans und kann daher keine faire Aufteilung berechnen.

Was passiert:
- Der Lender erhält **ALLES** beschlagnahmte Collateral im Collateral-Asset, **unabhängig vom berechneten Wert** (da keine Berechnung vertrauenswürdig ist).
- Die Treasury erhält nichts.
- Der Borrower erhält nichts.

Gleiche Auszahlung wie in Fall 2, aber aus einem grundlegend anderen Grund: Das Protokoll entscheidet nicht "Collateral ist weniger wert als Schulden" — es entscheidet "Ich kann hier keinem Wert vertrauen, also erhält der Lender den gesamten beschlagnahmten Korb und muss damit leben, was auch immer dieser am offenen Markt wert ist".

Ein anderes On-Chain-Event (`LiquidationFallbackOracleUnavailable`) wird emittiert, damit Auditoren die beiden Pfade in der Post-Mortem-Analyse unterscheiden können.

<a id="liquidation-mechanics.case-4"></a>

### Fall 4 — Illiquides Asset auf einer Seite

Der Pfad für illiquide Assets. Das Lending-Asset, das Collateral-Asset oder beide qualifizieren sich im Klassifikator des Protokolls nicht als Liquid (kein Chainlink-Feed oder kein konzentrierter Liquiditätspool vom Typ Uniswap-V3 über der Volumenschwelle). Häufig bei NFT-Collateral und Long-Tail-Token.

Was zum Zeitpunkt des Defaults passiert:
- Der Lender erhält das **vollständige Collateral** in-kind, unabhängig vom Marktwert.
- Keine Aufteilung zwischen "geschuldetem Betrag" und "Rest" — Orakel-Preise können nicht angewendet werden.
- Das Asset kann wesentlich mehr oder weniger wert sein als der geschuldete Betrag. Keine Gewährleistung für die Wiederverkäuflichkeit.

Beide Seiten haben dem bei Erstellung der Offer zugestimmt — die Illiquid-Asset-Klausel in den Risiko-Hinweisen deckt genau diesen Fall ab. Dieser Zweig kann nur erreicht werden, wenn beide Parteien sich wissentlich für einen Loan mit einem illiquiden Asset entschieden haben.

<a id="liquidation-mechanics.why-in-kind"></a>

### Warum in-kind, warum nicht immer Cash?

Drei Gründe, warum das Protokoll in Collateral-Asset-Einheiten auszahlt, statt immer in das Lending-Asset zu tauschen:
- **Sequencer- / DEX-Ausfall**: Wenn das Protokoll einen Swap nicht sicher ausführen kann (Slippage > 6 %, geringe Liquidität, DEX-Revert, Sequencer down), ist die sicherste Aktion, das zu liefern, was es bereits hat — das beschlagnahmte Collateral — direkt. Ein Swap um jeden Preis würde Verluste zementieren.
- **Black-Swan-Szenario**: In volatilen Kaskaden kann ein Pfad mit verfügbarem Orakel innerhalb von Minuten verschwinden. Den In-Kind-Fallback bereitizuhalten, hält das Protokoll funktionsfähig, selbst wenn jede Preisquelle beeinträchtigt ist.
- **Gegenpartei-Paar-Recovery**: Beim Claimen erhält der Lender (oder sein Keeper-Bot) eine zweite Chance über das vollständige 4-DEX-Failover. Wenn sich die Bedingungen bis dahin normalisiert haben, können sie das In-Kind-Collateral über dieselbe Routing-Infrastruktur, die der Pfad bei der Liquidation versucht hat, gegen das Lending-Asset verkaufen.

<a id="liquidation-mechanics.claim-time-retry"></a>

### Claim-Zeit-Retry

`ClaimFacet.claimAsLenderWithRetry` ermöglicht es dem Lender (oder einem Keeper, der für den NFT des Lenders handelt), eine ranggeordnete Retry-Liste von Swap-Adapter-Aufrufen (0x → 1inch → Uniswap V3 → Balancer V2) bereitzustellen, wenn sich der Loan in `FallbackPending` befindet. Die Library durchläuft die Liste, führt beim ersten Erfolg aus und schreibt die Lender- + Borrower-Claims in Erlöse des Principal-Assets um.

Ein totaler Fehlschlag lässt die aufgezeichnete Collateral-Aufteilung intakt und überführt den Loan endgültig in den Status Defaulted — an diesem Punkt übernimmt der Lender das In-Kind-Collateral und kann es über jeden externen Handelsplatz verkaufen.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### Interne Match-Rettung vor dem Claim

Bevor ein externer Swap läuft — bei HF-Liquidation, zeitbasiertem Default UND beim Claimen — prüft das Protokoll zuerst, ob ein **Loan in Gegenrichtung** existiert, der diesen Loan ohne jegliche DEX-Beteiligung settlen kann.

Wenn Loan A WETH gegen USDC verkaufen muss und Loan B USDC gegen WETH verkaufen muss, können die beiden direkt gematcht werden: Das Collateral of A deckt die Schulden von B und umgekehrt, bewertet zum Orakelpreis des Protokolls. Kein Aggregator, keine Slippage, keine Swap-Gebühr. Der Borrower behält wesentlich mehr von seinem Collateral; der Lender wird zum Orakelpreis entschädigt.

Dieser interne Matching-Pfad läuft automatisch:
- **Bei HF-Liquidation** — wenn ein Keeper Liquidation aufruft und eine Gegenpartei existiert, settelt das Protokoll intern statt zu swappen. Der Keeper verdient weiterhin einen Matcher-Incentive.
- **Bei zeitbasiertem Default** — dieselbe Prüfung vor dem Default-Swap.
- **Beim Claimen** — wenn ein Lender einen Loan claimt, der in `FallbackPending` feststeckt, prüft das Protokoll erneut auf eine Gegenpartei. Dies ist eine echte zweite Chance: Der Pool matchbarer Loans wächst kontinuierlich, sodass eine Gegenpartei, die bei der ersten Liquidation noch nicht existierte, beim Claimen vorhanden sein kann.

Ein Loan, der in `FallbackPending` gelandet ist, weil sein Swap bei der Liquidation *vorübergehend* fehlschlug (ein kurzzeitiger Slippage-Peak, ein DEX-Revert, ein veralteter Orakel-Tick), ist ein idealer Rettungskandidat — das zugrunde liegende Collateral ist normalerweise immer noch perfekt liquide, und ein Gegen-Loan kann es sauber klären. Das Protokoll erfordert nur, dass das Orakel das Asset noch bewerten kann; es erfordert keine DEX-Tiefe, da ein internes Match niemals einen DEX berührt.

Wenn keine Gegenpartei existiert, fällt das Protokoll auf den oben beschriebenen Pfad des externen Aggregators zurück. Das interne Match ist eine "besser-wenn-verfügbar"-Optimierung, niemals ein Blockierer.

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
must bei der Initiierung das HF ≥ 1,5-Gate genauso bestehen wie
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

## Wiederherstellung hängengebliebener Token

Dieser Abschnitt behandelt einen SONDERFALL, den die meisten Nutzer nie benötigen werden. Lies alles aufmerksam durch, bevor du auf den Wiederherstellungs-Link unten klickst — die Angabe einer falschen Quelle kann dazu führen, dass dein Vault im Rahmen der Sanktionspolitik des Protokolls gesperrt wird.

<a id="stuck-recovery.what"></a>

### Was "hängengebliebene Token" bedeutet

Dein Vaipakam-Vault-Proxy ist ein interner Speicher des Protokolls. Er ist KEINE Einzahlungsadresse. Jede vom Protokoll unterstützte Einzahlung läuft über die Facet-Einstiegspunkte von Vaipakam, die im Rahmen einer Offer-Erstellung, Loan-Annahme oder eines Staking-Vorgangs Mittel aus deinem Wallet in deinen Vault ziehen. Token, die AUSSERHALB dieses Flows im Vault ankommen — z. B. durch einen direkten `IERC20.transfer` aus einem Wallet oder einen CEX-Withdrawal, bei dem deine Vault-Adresse kopiert und eingefügt wurde — liegen dort ohne Protokoll-Buchhaltung. Der Asset-Viewer blendet sie aus, da er nur den vom Protokoll verfolgten Saldo anzeigt.

Token können auf zwei Arten hängenbleiben:
1. **Du hast sie selbst geschickt.** Du hast deine Vault-Adresse (aus dem Dashboard oder einem Block-Explorer) in ein CEX-Auszahlungsfeld oder das Senden-Formular eines Wallets kopiert und abgeschickt. Die Token landeten in deinem Vault, ohne den Einzahlungspfad des Protokolls zu durchlaufen.
2. **Ein Dritter hat sie geschickt ("Dust-Attacke").** Jemand hat einen kleinen Betrag von einem markierten Wallet an deinen Vault überwiesen, in der Hoffnung, deine Adresse mit seinem Ruf in Verbindung zu bringen. Dies ist ein realer Angriffsvektor gegen prominente Adressen auf permissionless Chains.

<a id="stuck-recovery.taint-poisoning"></a>

### Über "Taint-Poisoning"

Wenn der Dritt-Absender auf einer Sanktionsliste steht, könnten generische On-Chain-Analysetools deinen Vault als "sanktionsnah" markieren, obwohl du die eingehenden Token nie berührt hast. Es gibt keinen On-Chain-Weg, dies rückgängig zu machen — das Transfer-Event ist permanent. Die INTERNE Buchhaltung von Vaipakam ist davon unberührt (wir verfolgen nur über das Protokoll vermittelte Deposits, Dust geht niemals in unsere Zähler ein), sodass deine Loans / Stakes / Claims normal weiterfunktionieren. Externe Tools jedoch, die unsere Buchhaltung nicht verstehen, könnten Warnungen anzeigen.

<a id="stuck-recovery.dont-recover"></a>

### Wann du Token NICHT wiederherstellen solltest

Wenn du die Token NICHT selbst geschickt hast, **versuche nicht, sie wiederherzustellen**. Die Wiederherstellung erfordert, dass du die Adresse des Absenders angibst. Wenn diese Adresse auf der Sanktionsliste steht, wird dein Vault im Rahmen der Sanktionspolitik des Protokolls gesperrt, bis die Quelle vom Orakel von der Liste genommen wird.

Token, die du nicht gesendet hast, gehören dir nicht. Sie wiederherzustellen, indem du eine "saubere" Adresse angibst, die du gar nicht besitzt, ist ebenfalls eine schlechte Idee — das Protokoll kann die Angabe on-chain nicht verifizieren, aber externe Orakel-Tools könnten später widersprechen.

Der sicherste Weg ist es, unaufgeforderten Dust zu ignorieren. Er beeinträchtigt weder deinen Protokoll-Saldo noch aktive Loans oder Offers.

<a id="stuck-recovery.when-recover"></a>

### Wann du Token wiederherstellen solltest

Du hast die Token versehentlich selbst gesendet, du kontrollierst das Quell-Wallet und weißt, dass die Quelle auf keiner Sanktionsliste steht (dein eigenes EOA, ein CEX-Hot-Wallet, von dem du abgehoben hast, etc.).

<a id="stuck-recovery.flow"></a>

### Wiederherstellungs-Flow

1. Besuche die [Wiederherstellungs-Seite](/app/recover).
2. Gib die Token-Vertragsadresse, die Quelle, von der du gesendet hast, und den Betrag ein.
3. Lies den Hinweis auf dem Bildschirm sorgfältig durch.
4. Tippe "CONFIRM" ein, um das Signieren freizuschalten.
5. Signiere die EIP-712-Bestätigung in deinem Wallet.
6. Sende die Transaktion ab.

Zwei Ergebnisse sind möglich:
- **Quelle sauber** → Token kehren zu deinem EOA zurück.
- **Quelle markiert** → Token bleiben im Vault, dein Vault wird im Rahmen der Sanktionspolitik des Protokolls gesperrt. Die Sperre hebt sich automatisch auf, wenn die Adresse später vom Sanktions-Orakel entfernt wird.

<a id="stuck-recovery.disown"></a>

### Unaufgeforderte Token verleugnen (Compliance-Audit-Trail)

Wenn du einen öffentlichen On-Chain-Nachweis möchtest, dass ein bestimmter Token-Saldo in deinem Vault NICHT dir gehört, bietet das Protokoll eine `disown(token)`-Funktion an. Sie emittiert ein Event (`TokenDisowned`) und ändert sonst nichts — die Token bleiben wie zuvor im Vault. Dies ist nützlich bei Compliance-Streitigkeiten, falls eine CEX oder eine Regulierungsbehörde fragt: "Haben Sie diese Mittel erhalten?". Du kannst dann auf das On-Chain-Event verweisen.

Die Disown-Funktion ist derzeit nur über direkten Vertragsaufruf zugänglich; das Vaipakam-Frontend bietet dafür keinen Button an. Nutze die "Write Contract"-Oberfläche eines Block-Explorers oder ein Tool zur Interaktion mit Smart Contracts, um sie aufzurufen.
