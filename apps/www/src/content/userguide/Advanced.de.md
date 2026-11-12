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

<a id="chapter.dashboard"></a>

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

Ein Opt-in-Flag auf Wallet-Ebene, das deinen VPFI-Bestand in einen
Gebühren-Rabatt umsetzt. Standard: aus — aus bedeutet, dass du 100%
jeder Gebühr im Principal-Asset zahlst.

Die beiden Seiten funktionieren unterschiedlich. **Als Borrower**
ist der Rabatt eine direkte Minderung der Loan Initiation Fee, die
bei Annahme im Lending-Asset berechnet wird; dafür wird nichts aus
deinem Vault abgebucht. **Als Lender** greift der Yield-Rabatt beim
Settlement, und wenn eine VPFI-Preisreferenz konfiguriert ist, kann
er stattdessen in VPFI aus deinem Vault beglichen werden, sodass dir
die volle Gebühr im Lending-Asset verbleibt.

Tier-Leiter:

| Tier | Min. Vault-VPFI                       | Rabatt                            |
| ---- | -------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%   |

Das Tier wird gegen deinen Vault-Saldo **nach der Änderung** in dem
Moment berechnet, in dem du VPFI einzahlst oder abhebst. Der
tatsächlich berechnete Satz wird bei der Abrechnung aus deinem Tier
in genau diesem Moment aufgelöst — es gibt keinen gesonderten
Durchschnitt über die Laufzeit eines Loans. Das Tier selbst ist die
Absicherung: ein zeitgewichteter Durchschnitt deines Tagessaldos über
ein jüngeres Fenster von höchstens 30 Tagen — eine
Protokoll-Einstellung, gerechnet ab dem Tag, an dem dein aktueller
Bestand begann, wobei die jüngsten Tage stärker zählen. Dieser
Durchschnitt wird anschließend auf das niedrigste Tier gesenkt, auf
das du seit Beginn dieses Bestands gefallen bist, mit einem Rückblick
von bis zu 30 Tagen.

**Das sind zwei getrennte Rückblicke, und der zweite ist meist der
längere.** Das Durchschnittsfenster ist konfigurierbar und kann kürzer
als 30 Tage sein; der Rückblick der niedrigsten Stufe hängt nicht
daran — er umfasst deinen gesamten aktuellen Bestand, gedeckelt bei 30
Tagen. Bei einem 14-Tage-Fenster senkt ein Absacken vor 20 Tagen also
weiterhin dein Tier, obwohl es ganz außerhalb des Durchschnitts liegt.

Dein Tier ist vollständig null, solange du nicht **durchgehend** ein
Guthaben über null eine Mindestanzahl von Tagen gehalten hast —
ebenfalls eine Protokoll-Einstellung. Diese Frist beginnt, wenn dein
Saldo von null auf positiv wechselt, und beginnt nur dann von vorn,
wenn er wieder null erreicht; ein Aufstocken eines bestehenden
Bestands setzt sie nicht zurück.

Eine Abhebung greift daher sofort für jeden offenen Loan, an dem du
beteiligt bist — es gibt kein Gnadenfenster, in dem dein altes
(höheres) Tier weiter gilt. Damit wird das Muster geschlossen, bei dem
ein Nutzer kurz vor Loan-Ende VPFI aufladen, den vollen Tier-Rabatt
mitnehmen und Sekunden später wieder abheben könnte. Beachte, welche
Regel es schließt: Wer schon länger hält, hat die Mindestdauer längst
erfüllt, die Arbeit tut also die Regel der niedrigsten Stufe — was ein
Durchschnitt nicht könnte, denn einen Durchschnitt kann eine späte
Aufstockung hochziehen, ein Minimum nicht.

Gegen genau dieses Muster ist die heutige Regel die stärkere der
beiden. Sie ist **nicht** in jeder Hinsicht strenger: Weil der
Rückblick der niedrigsten Stufe höchstens 30 Tage zurückreicht, zählen
die frühen Monate mit niedrigem Tier bei einem langen Loan irgendwann
nicht mehr mit, während ein Durchschnitt über die gesamte Laufzeit sie
behalten hätte. Die Änderung hat die Abwehr gegen kurzes Aufladen
verschärft und das Gedächtnis verkürzt.

**Das gilt für die Lender-Yield-Fee.** Der Satz des Borrowers für die
Initiation-Fee wird einmal bei Annahme des Loans gelesen; danach ändert ihn
weder eine Abhebung noch eine Aufstockung.

Der Rabatt gilt für die Lender-Yield-Fee beim Settlement und für
die Borrower-Loan-Initiation-Fee — dort als **direkte Minderung
der Gebühr, die du im Lending-Asset zahlst**, angewendet bei
Annahme des Loans. Es wird kein VPFI aus deinem Vault entnommen,
um diese Gebühr zu bezahlen, und es gibt danach keinen Rebate zu
claimen.

> **Falls du auf einen Loan-Initiation-Fee-Rebate wartest, lies
> das hier.** Ein früheres Modell zog die volle Gebühr vorab in
> VPFI ein, hielt sie über die gesamte Laufzeit des Loans in
> Verwahrung und gab beim Claim einen Teil zurück. **Dieser Weg
> wurde entfernt.** Kein Loan wurde je darüber eröffnet, also hat
> kein Loan VPFI gegen seine Initiation-Fee verwahrt und es steht
> kein Rebate aus — darauf zu warten hieße, auf Geld zu warten,
> das nicht kommen kann.

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

Eine ambitionierte Übersichtskarte, die das VPFI-Rewards-Bild des
verbundenen Wallets in einer Ansicht zeigt. Die Hauptzahl ist die
Summe aus ausstehenden Interaction-Rewards und historisch
geclaimten Interaction-Rewards.

Die Aufschlüsselungszeile zeigt ausstehend + geclaimt und einen
Chevron-Deep-Link zur vollständigen Claim-Karte auf ihrer
Ursprungsseite:

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
die Karte bei null ausgeblendet, wäre das Rewards-Programm für
neue Nutzer unsichtbar, bis sie zufällig ins Claim Center gehen.

---

<a id="chapter.offer-book"></a>

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
selbst — das Gate ist nicht umgehbar. Der `{liveValue:treasuryFeeBps}`%-Treasury-Anteil auf
Zinsen wird beim terminalen Settlement abgezogen, nicht im Voraus.
Dieser Satz wird bei der Kreditvergabe festgeschrieben; eine spätere
Änderung der Protokollgebühr lässt einen bereits laufenden Kredit auf
seinem ursprünglichen Satz.

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

<a id="chapter.create-offer"></a>

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
  und dem `{liveValue:treasuryFeeBps}`%-Treasury-Anteil auf Zinsen.
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
  dein gesamtes Collateral an den Lender. Es gibt überhaupt
  keinen Restanspruch.

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
   bei `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** ist die Referenz) und
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
   Für Fee-Enforced-Collections, populiere `feeLegs` aus dem
   geforderten OpenSea- / Creator-Fee-Schedule der Collection vor
   diesem Schritt-Aufruf. Verwende NUR geforderte, nicht-null
   Fee-Zeilen; beschränke die Liste auf den vom Protokoll
   unterstützten Fee-Leg-Count; konvertiere jede Zeile in einen
   absoluten Festbetrag im Principal-Asset zum gewählten Ask-Preis;
   und verwende den gelisteten Fee-Empfänger als Leg-Empfänger.
   Wenn eine geforderte Fee am gewählten Ask auf null gerundet
   wird, ist der Ask zu klein für diese Collection und der Post
   sollte nicht versucht werden. Ein leeres Array zu übergeben ist
   nur für fee-freie Collections gültig. Auf Fee-Enforced-Collections
   kann es eine Order produzieren, die bei der OpenSea-
   Veröffentlichung fehlschlägt oder die geforderte Consideration-
   Form des Marketplaces nicht erfüllen kann.
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
   In-Repo-Publisher (`apps/indexer/src/openseaPublish.ts`) injizieren es vor dem
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
  Der Verkauf ist eine aus dem Collateral finanzierte Rückzahlung,
  also settelt der Diamond diesen Netto-Betrag genau so, wie es eine
  Rückzahlung im Moment des Fills täte: der Kredit wird
  zurückgezahlt; der Anspruch des Verleihers (der volle Coupon, wenn
  der Kredit mit `useFullTermInterest = true` erstellt wurde, sonst
  die bis dahin aufgelaufenen Zinsen, plus ein etwaiger
  Yield-Fee-Rabatt des Verleihers) wird in das Vault des Verleihers
  gelegt und dem aktuellen Lender-Position-Halter über den normalen
  Lender-Claim ausgezahlt; die Treasury erhält ihren Anteil abzüglich
  dieses Rabatts; und der Rest geht an die Wallet des aktuellen
  Borrower-Position-Halters. Kann der Rest nicht an diese Wallet
  gezahlt werden, wird er stattdessen gehalten und über den normalen Borrower-Claim
  im Claim Center ausgezahlt. Der Verleiher wird nie innerhalb des
  Verkaufs selbst bezahlt, daher kann nichts an seiner Wallet den
  Verkauf stoppen.

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


<a id="chapter.claim-center"></a>

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
- Aufgelaufene Zinsen minus den bei der Erstellung deines Loans
  festgeschriebenen Treasury-Anteil (`{liveValue:treasuryFeeBps}`%
  für Loans zum aktuellen Satz). Der Anteil wird selbst durch deinen
  zeitgewichteten VPFI-Gebühren-Rabatt-Akkumulator reduziert, wenn
  die Zustimmung an ist.

Claimable, sobald der Loan einen terminalen Zustand erreicht
(Settled, Defaulted oder Liquidated). Der Lender-Position-NFT
wird in derselben Transaktion verbrannt.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

Der Borrower-Claim gibt je nach Settlement des Loans zurück:

- **Volle Rückzahlung / Preclose / Refinance** — dein
  Collateral-Korb zurück. Ein Loan-Initiation-Fee-Rebate kommt
  nicht dazu: dein Rabatt wurde bei Annahme bereits von der Gebühr
  abgezogen.
- **Ein Prepay-Sale, der den Loan abschließt** — das Collateral
  geht an den Käufer, nicht an dich zurück. Du erhältst den
  Verkaufspreis abzüglich des Lender-Anspruchs, des Treasury-Anteils
  und etwaiger Verkäufergebühren des Listings, ausgezahlt an den
  Inhaber des Borrower-Position-NFT.
- **Swap-to-Repay** — dein Collateral wird zur Deckung der Schuld
  verkauft, bis zu einer Obergrenze, die du setzt. Setzt du sie
  großzügig, kann mehr verbraucht werden, als die Schuld strikt
  benötigte; was nicht verbraucht wird, kommt zu dir zurück. Ein
  Überschuss im Asset des Loans geht normalerweise direkt an den
  Inhaber des Borrower-Position-NFT statt als Claim zu warten — es
  sei denn, dieser Inhaber steht unter einem Sanktions-Freeze, dann
  wird er als Claim gehalten.
- **HF-Liquidation oder Default** — sieh trotzdem nach, es kann
  ein Überschuss übrig sein. Es wird nur so viel Wert
  genommen, wie Liquidator, Lender und Treasury decken; der Rest
  wird als dein Claim erfasst. Seine FORM hängt an einer Frage: wurde
  das Collateral VERKAUFT oder ÜBERGEBEN? Verkauft — also über
  eine Börse nach draußen geleitet — und der Rest erreicht dich
  im Principal-Asset des Loans. Übergeben, und was bleibt, ist das
  Collateral selbst, verpfändet in deinem Vault. Mehr als eines übergibt es, und keines davon hängt daran, über welchen
  Close-out du gegangen bist: ein Liquidator, der das Collateral mit
  Abschlag direkt übernimmt, ein Close-out, der intern gegen eine
  gegenläufige Position gematcht statt an eine Börse geschickt wird, und ein Verkauf, der nicht zustande kam — dort bekommst du das Collateral, sofern der Lender beim Claim nicht
  ein funktionierendes Quote mitbringt — dann wirst du im Asset des
  Loans ausgezahlt; die meisten Claims bringen gar keins mit. Die
  gewöhnliche Liquidation und ein zeitbasierter Default versuchen
  dieses interne Matching, BEVOR sie zur Börse greifen, also endet
  keiner dieser beiden Wege immer gleich — genau deshalb liest man
  den Claim und nicht den Weg. Der Weg mit Abschlag ist dagegen
  berechenbar, nur andersherum: er verkauft nicht und matcht nicht,
  dir bleibt also immer das Collateral. Eine
  Teilliquidation ist überhaupt kein Close-out — der Loan bleibt
  offen und es entsteht kein Claim. Sieh in den Claim, statt zu
  raten. Bei
  einem Default auf ein illiquides Asset geht meist der ganze Korb
  weg, dann bleibt nichts — das ist auf diesem Weg die Regel, kein unglücklicher Ausgang.

Der Borrower-Position-NFT wird beim Claim verbrannt, nicht bei der
Auflösung des Loans — ein von einer Liquidation übrig gelassener
Überschuss ist also danach noch abholbar. Dass der NFT noch da ist,
belegt aber keinen Überschuss: blieb nach einer Liquidation nichts
übrig, gibt es nichts abzuholen, der Claim wird abgelehnt, und der
NFT kann trotzdem dableiben. Lies den Claim,
nicht den NFT.

---

<a id="chapter.activity"></a>

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
NFT-Mints/-Burns und VPFI-Vault-Einzahlungen / -Abhebungen.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI bekommen

VPFI ist frei übertragbar. Erwirb es auf dem freien Markt, wo immer
es gehandelt wird, oder bridge es herein: VPFI ist ein Chainlink
CCIP Cross-Chain-Token, also bewegt es sich zwischen unterstützten
Chains über die offizielle Bridge und landet in deinem Wallet auf
der Chain, auf die du gebridget hast.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Live-Status:

- Aktuelles Tier (0 bis 4).
- Vault-VPFI-Saldo plus die Differenz zum nächsten Tier.
- Rabatt-Prozentsatz auf dem aktuellen Tier.
- Consent-Flag auf Wallet-Ebene.

VPFI im Vault zählt zu deinem Rabatt-Tier, solange es eingezahlt
bleibt — zusätzlich zum expliziten Deposit-Schritt unten gibt es
keine separate Locking-Aktion.

<a id="buy-vpfi.deposit"></a>

### VPFI in deinen Vault einzahlen

Ein expliziter Deposit-Schritt von deinem Wallet zu deinem Vault
auf derselben Chain. Auf jeder Chain erforderlich —
auch auf der kanonischen — weil Vault-Deposit per Spec immer
eine explizite Nutzeraktion ist. Auf Chains, auf denen Permit2
konfiguriert ist, bevorzugt die App den Single-Signature-Pfad
gegenüber dem klassischen Approve-+-Deposit-Pattern; sie fällt
sauber zurück, wenn Permit2 auf dieser Chain nicht konfiguriert
ist.

<a id="buy-vpfi.unstake"></a>

### VPFI aus deinem Vault abheben

Hebe VPFI aus deinem Vault zurück in dein Wallet ab. Es gibt
keinen separaten Approve-Schritt — das Protokoll besitzt den
Vault und zieht von sich selbst ab. Der Withdraw löst ein
sofortiges Neu-Stempeln des Rabatt-Satzes auf den neuen
(niedrigeren) Saldo aus, angewendet auf jeden offenen Loan, an dem
du beteiligt bist. Es gibt kein Gnadenfenster, in dem das alte Tier
noch gilt.

<a id="buy-vpfi.cross-chain-tier"></a>

### Wie dein VPFI-Tier zwischen Chains reist

Du hältst VPFI in deinem Vault auf Base, der kanonischen Chain, und
Base berechnet dein Tier. Wenn du auf einer anderen Chain leihst oder
verleihst, wendet diese Chain eine Kopie deines Tiers an, die Base über
Chainlink CCIP nach jeder Einzahlung, Auszahlung oder anderen Aktion
schickt, die es ändert.

Drei Dinge, die du wissen solltest:

- **Ein Tier, das allein mit der Zeit steigt, braucht eine Aktion auf
  Base, um zu reisen.** Wenn deine Haltedauer erreicht ist oder dein
  Durchschnitt aufholt, ohne Einzahlung oder Auszahlung, ist der Wert
  auf Base sofort aktuell. Die anderen Chains erfahren ihn mit deiner
  nächsten Einzahlung oder Auszahlung auf Base, egal in welcher Höhe.
- **Ein niedrigeres Tier reist zuerst.** Das Protokoll schickt ein
  niedrigeres Tier sofort und bezahlt ein höheres höchstens einmal pro
  Tag und Chain. Die Zustellung über CCIP dauert danach meist einige
  Minuten. Bis sie ankommt, wendet die Chain weiter dein vorheriges
  Tier an.
- **Eine Kopie kann veralten.** Nach 60 Tagen ohne neue Kopie (der
  Standardwert) oder sobald eine Änderung der Tier-Tabelle diese Chain
  erreicht, gibt die alte Kopie dort keinen Rabatt mehr. Eine neue
  Kopie wird nur geschickt, wenn sich dein Tier ändert.

Die vollständigen Regeln, einschließlich des Rabatt-Schalters, den du
auf Base ebenso wie auf der genutzten Chain brauchst, stehen im
Kapitel „Wie VPFI-Rabatte funktionieren“ weiter unten. Das Design der
Zustellung steht im
[Design-Dokument zur Tier-Zustellung](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(auf Englisch).

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Der **Interaction-Pool** zahlt einen täglichen Pro-rata-Anteil an
einer festen täglichen Emission, gewichtet nach deinem Beitrag an
gesettleten Zinsen zum Loan-Volumen dieses Tages. Tagesfenster
finalisieren lazy beim ersten Claim oder Settlement nach
Fenster-Schluss.

Rewards werden direkt auf der aktiven Chain geminted — es gibt
keinen Cross-Chain-Round-Trip für den Nutzer.
Cross-Chain-Reward-Aggregation findet nur zwischen
Protokollverträgen statt.

<a id="rewards.claim"></a>

### Rewards claimen

Eine einzige Transaktion claimt deine aufgelaufenen Rewards.
Interaction-Rewards sind null, bis das relevante Tagesfenster
finalisiert (Lazy-Finalisierung getriggert durch den nächsten
Nicht-Null-Claim oder das nächste Settlement auf dieser Chain).
Die UI sperrt den Button, während das Fenster noch finalisiert,
damit Nutzer nicht unter-claimen.

<a id="rewards.withdraw-staked"></a>

### VPFI aus deinem Vault abheben

Identische Oberfläche wie "VPFI aus deinem Vault abheben" im
VPFI-Bereich — hebe VPFI aus dem Vault zurück in dein Wallet ab.
Abgehobenes VPFI verlässt den Rabatt-Akkumulator sofort
(Post-Saldo-Re-Stamp auf jedem offenen Loan).

---

<a id="chapter.loan-details"></a>

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
Collateral an den Lender, und es bleibt nichts zum Claimen.

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
  Principal plus Zinsen zurück, minus dem bei der Erstellung deines
  Loans festgeschriebenen Treasury-Anteil
  (`{liveValue:treasuryFeeBps}`% für Loans zum aktuellen Satz; weiter
  reduziert durch deinen zeitgewichteten VPFI-Yield-Fee-Rabatt, wenn
  die Zustimmung an ist). Verbrennt den
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
  terminale Settlement.
- **Direkter Preclose** — zahle den ausstehenden Betrag jetzt
  aus deinem Wallet und gib das Collateral frei.
- **Offset-Preclose** — verkaufe einen Teil des Collaterals über
  den Swap-Router des Protokolls, zahle aus dem Erlös zurück,
  und gib den Rest zurück. Zwei Schritte: initiieren, dann
  abschließen.
- **Refinance** — poste eine Borrower-Offer für neue
  Konditionen; sobald ein Lender akzeptiert, tauscht der
  Refinance-Abschluss die Loans atomar, ohne dass das
  Collateral deinen Vault verlässt.
- **Als Borrower claimen** — nur in terminalen Zuständen. Gibt das
  Collateral bei voller Rückzahlung zurück; bei Default oder
  Liquidation kann ein Überschuss bleiben, da nur so viel Collateral
  genommen wird, wie Schuld und Auflösungskosten erfordern — siehe
  den Claim-Center-Abschnitt oben. Verbrennt den Borrower-Position-NFT.

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
(Kredit als zurückgezahlt geschlossen, NFT transferiert, Verkaufserlöse aufgeteilt)
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

<a id="chapter.how-liquidation-actually-works"></a>

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

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

## Alerts

<a id="alerts.overview"></a>

### Über Alerts

Ein Off-Chain-Watcher pollt jeden aktiven Loan, der dein Wallet
betrifft, im 5-Minuten-Takt, liest den Live-Health-Factor jedes
Loans und sendet bei einem Wechsel in ein unsichereres Band einmal
über die konfigurierten Kanäle. Kein On-Chain-State, kein Gas.
Alerts sind beratend — sie bewegen keine Mittel.

<a id="alerts-inbox"></a>

### Der Alerts-Posteingang

Die Seite Alerts liest den Posteingang des Index für die verbundene Wallet in ihrem Netzwerk, die neuesten zuerst, fünfzig Zeilen pro Seite. Eine Zeile wird für die Wallet geschrieben, die die Kreditposition beim Schreiben hält: Kredit gestartet; Teil- und Vollrückzahlung, einschließlich vorzeitiger Schließung, Refinanzierung, Swap-to-Repay und Schließung durch Sicherheitenverkauf; Ausfall oder Liquidation; Schließung durch internen Abgleich; ein Kredit, dessen Ende der Index sah, ohne sagen zu können, wie; die Fälligkeitshinweise 7 Tage und 1 Tag vorher; Nachfrist begonnen und beendet; und Gesundheit unter 1,5, 1,2 und 1,05. Die Gesundheitszeilen schreibt der Keeper des Protokolls, sie kommen also nur, solange er läuft, und nur für Kredite, für die die Gesundheit gilt. Die Zeilen zur letzten Mahnung und zum Ablauf eines Belohnungseintrags gehen an dessen Inhaber. Eine Zeile ist ein Verweis, nie ein Betrag: die Kreditseite liest die Chain. Eine Antwort für ein anderes Netzwerk oder eine andere Wallet wird abgelehnt, unlesbare Zeilen werden gezählt, und eine unbekannte Art wird mit ihrem Namen gezeigt. Der Zähler im Kopf ist die Zählung des Index selbst, über alle Zeilen, der Zeilen, deren ID über der neuesten in diesem Browser als gesehen vermerkten liegt; IDs wachsen nur in Schreibreihenfolge, also zählt auch eine Zeile mit älterem Block. Das Öffnen der Seite vermerkt alle bisher geschriebenen Zeilen als gesehen. Die Gesehen-Marke liegt nur in diesem Browser und bewegt sich nur vorwärts. Telegram, Push, Gesundheitswarnungen und Zahlungserinnerungen richtest du direkt unter dem Posteingang ein. Eine Zeile ist Verlauf: Sie sagt, wie der Kredit oder Eintrag stand, als sie geschrieben wurde, nie, dass das noch gilt, und eine Zeile zum Ablauf einer Belohnung bedeutet, dass die Rückgabe des Eintrags an das Programm begonnen hat, nicht dass sie abgeschlossen ist.

<a id="alerts-channels"></a>

### Telegram, Push und Warnungen

Jede Änderung ist eine EIP-191-Signatur über eine Klartextnachricht, die Aktion, Wallet, Netzwerk und Zeit nennt; der Hinweisdienst nimmt jede signierte Anfrage einmal innerhalb von zehn Minuten an, und ein Speichern trägt nur die Einstellung, die es ändert. Der Dienst speichert Wallet, Netzwerk, Einstellungen und nach dem Verbinden die Telegram-Chat-ID; er meldet sie nicht zurück, daher nennt jede Karte, was dieser Browser getan hat. Die Telegram-Verbindung gilt erst als belegt, wenn eine Testnachricht den Chat erreicht. Trennen mit einer gewöhnlichen Wallet löscht alle Netzwerke, ein Smart Account nur das signierte Netzwerk, und in einem Netzwerk mit geschütztem Modus bleibt der Chat, bis die Schutzfrist abgelaufen ist. Push wird nur angeboten, wenn der Status des Dienstes sagt, dass beide Absender auf einem Kanal senden können; deckt er nur den Erinnerungsabsender ab, erreichen Warnungen Push womöglich nicht. Die drei Gesundheitslinien sind standardmäßig 1,5, 1,2 und 1,05 und lassen sich hier ändern, jede über der nächsten und die letzte über 1,0. Telegram verbinden und Push einschalten verlangen zuerst die Bedingungen; Ausschalten nie.

<a id="alerts-paid-push"></a>

### Kostenpflichtige Push-Hinweise

Deine Zustimmung ist eine on-chain gespeicherte Obergrenze: das meiste VPFI, das du pro Kreditseite zahlst. Die Karte zeigt sie zusammen mit dem eigenen Urteil des Vertrags, ob sie die aktuelle Gebühr deckt. Im Basismodus stimmst du der aktuellen Gebühr zu; im Profimodus tippst du eine Obergrenze von der Gebühr bis zur Protokollgrenze von 50 VPFI, und wer der Grenze zustimmt, akzeptiert jede Gebühr, die die Governance festlegen kann. Zustimmen wird nur angeboten, wo der Hinweisdienst sagt, dass er berechnet, nie einer Wallet, die die Sanktionsprüfung markiert, und es fragt zuerst nach den Bedingungen. Zuerst kommen die Prüfung und ein Probelauf, und die Gebühr wird direkt vor dem Öffnen deiner Wallet erneut gelesen: Hat sie sich geändert, wird nichts gesendet. Zurückziehen setzt die Obergrenze auf null und wird angeboten, solange eine gespeichert ist, auch wenn das Protokoll pausiert ist oder der Hinweisdienst nicht erreichbar ist. Eine Bereitstellung ohne Zustimmungsdatensatz bietet beides nicht an, und die Karte sagt, ob sie die Gebühr trotzdem berechnen kann.

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Eine Wallet-freie Seite für eine einzelne Chain: Sie liest die
Chain, auf die die App zeigt (ohne verbundene Wallet die
Standard-Lese-Chain). Es gibt keinen Cross-Chain-Rollup und keinen
Export; um Chains zu vergleichen, öffne die Seite auf jeder. Zwei
Quellen, jeweils dort gekennzeichnet, wo sie genutzt werden:

- die schlüssellose Lese-API des Indexers mit offenem CORS — die
  Loan-, Offer-, Recycling- und Loop-Closure-Zahlen;
- die View-Funktionen des Diamonds selbst über einen öffentlichen
  RPC — die VPFI-Token- und Gebührenzahlen.

Jede Quelle kann direkt abgefragt werden, um das Gezeigte
nachzuvollziehen.

<a id="public-dashboard.loans-offers"></a>

### Loans und Offers

Loan-Zähler nach Status aus `/loans/stats`, einschließlich der
Töpfe für ausstehende Abwicklung, intern gematchte Loans und den
Rest, sodass die Teile die Summe ergeben; die Teilsummen für
ERC-20 und NFT-Rentals, wobei aktive Loans, deren Asset-Typ noch
nicht gelesen ist, gesondert genannt werden; und Offer-Zähler aus
`/offers/stats`. Offers sind nur die `offers`-Tabelle — gaslose
signierte Orders zählen nicht —, und stornierte Offers fallen aus
dem Index, daher ist die Offer-Summe keine Gesamtzahl über die
Laufzeit. Ein fehlender Zähler erscheint als „nicht gemeldet", ein
unmöglicher als „gemeldet, aber keine verwendbare Anzahl"; keiner
wird als 0 gezeigt.

<a id="public-dashboard.recycling"></a>

### Recyclingkonto und Loop Closure

Das Recyclingkonto (`/metrics/recycling`) listet für jeden
Programmtag den Pool, seine Finanzierung und die Entnahme,
beschriftet mit dem eigenen Tagesindex des Programms; ein nicht
finalisierter Tag erscheint ohne Pool, ein nicht scharf
geschalteter Tag als Schätzung. Loop Closure
(`/metrics/loop-closure`) zeigt pro UTC-Tag, was Claims
ausgezahlt haben, was in Vaults blieb und was absorbiert wurde,
gemessen am Zeitpunkt, bis zu dem die Aufzeichnung reicht.
Positive Beträge unter der Anzeigegenauigkeit werden beschriftet,
Anteile abgerundet, und eine unbekannte Zahl wird nie als null
gezeigt.

<a id="public-dashboard.transparency"></a>

### Transparenz & Quelle

Die Diamond-Adresse mit Explorer-Link, die Chain sowie Block und
Alter des Indexer-Cursors. Jede Zahl aus dem Indexer ist genau so
aktuell wie dieser Cursor; werden zwei Antworten kombiniert, wird
der ältere Cursor angegeben.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token

Aus `getVPFISnapshot()` am Diamond: die Token-Adresse und
`totalSupply` auf dieser Chain. Auf der kanonischen Chain zusätzlich
die Obergrenze, der Spielraum (`cap − totalSupply`, also was noch
geprägt werden kann) und der Minter. Auf einer Mirror-Chain trägt
der Snapshot weder Obergrenze noch Minter — die Menge kommt dort
über den CCIP-Token-Pool —, daher zeigt die Seite die lokale Menge
und sagt, dass Obergrenze und Minter zur kanonischen Chain gehören,
statt Nullen anzuzeigen. Ein nicht gebundener Token und ein nicht
lesbarer Snapshot werden getrennt genannt.

<a id="public-dashboard.fees"></a>

### Gebühren und Treasury

Aus `getTreasuryMetrics()`, `getTreasury()` und
`getNumeraireSymbol()`, im selben Multicall3-Aggregat wie der
Snapshot gelesen und an einen Block gebunden, den die Seite mit
seinem Alter nennt:

- Gebühren seit Beginn des Gebührenbuchs sowie über die letzten
  24 Stunden und 7 Tage, jeweils bei Erfassung im Numeraire
  bewertet und nie neu bewertet;
- eine Gebühr, die das Protokoll bei Erfassung nicht bewerten
  konnte, wird mit 0 gebucht, und die Fenstersummen lesen höchstens
  die letzten 10.000 Einträge — beides kann nur unterzeichnen, und
  die Seite sagt das;
- ein Wechsel des Numeraires lässt frühere Einträge in der alten
  Einheit, sodass die Summen danach Beträge in zwei Einheiten unter
  dem aktuellen Symbol addieren und in beide Richtungen abweichen
  können; die Seite sagt, dass frühere Gebühren in der alten Einheit
  gezählt sind;
- die Treasury-Adresse. Ist es eine externe Adresse, verlassen
  Gebühren den Vertrag bei Erhebung, und es wird kein Saldo dafür
  gezeigt. Ist der Diamond seine eigene Treasury, wird der
  gehaltene Betrag gezeigt, bewertet nur über Assets, die in
  offenen Loans vorkommen, und einschließlich Beträgen, die im
  Namen der Treasury anderswo angelegt sind.

Eine fehlgeschlagene View zeigt „konnte nicht gelesen werden" und
verdeckt die anderen nicht.

---

<a id="chapter.refinance"></a>

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
3. Markiert den alten Loan als zurückgezahlt. Seine Position-NFTs
   werden nicht verbrannt: beide bleiben bei ihren Haltern, mit dem
   Status Loan Repaid. Der alte Lender beansprucht die Rückzahlung
   mit seinem, der alte Borrower-NFT bleibt als Beleg.
4. Mintet die neuen Position-NFTs.

Revertet, wenn HF unter den neuen Konditionen unter 1,5 läge.

---

<a id="chapter.preclose"></a>

## Preclose

Diese Seite ist nur für Borrower — Preclose wird vom Borrower auf
seinem Loan initiiert.

<a id="preclose.overview"></a>

### Über Preclose

Eine Borrower-getriebene vorzeitige Beendigung. Zwei Pfade:

- **Direkt** — zahle den ausstehenden Betrag (Principal +
  aufgelaufene Zinsen) aus deinem Wallet und gib das Collateral
  frei.
- **Offset** — initiiere den Offset, um einen Teil des
  Collaterals über das 4-DEX-Swap-Failover des Protokolls gegen
  das Principal-Asset zu verkaufen, schließe den Offset ab, um aus
  dem Erlös zurückzuzahlen, und der Rest des Collaterals geht
  an dich zurück.

Keine pauschale Early-Close-Strafe.

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.stuck-token-recovery"></a>

## Wiederherstellung hängengebliebener Token

Dieser Abschnitt behandelt einen SONDERFALL, den die meisten Nutzer nie benötigen werden. Lies alles aufmerksam durch, bevor du auf den Wiederherstellungs-Link unten klickst — die Angabe einer falschen Quelle kann dazu führen, dass dein Vault im Rahmen der Sanktionspolitik des Protokolls gesperrt wird.

<a id="stuck-recovery.what"></a>

### Was "hängengebliebene Token" bedeutet

Dein Vaipakam-Vault-Proxy ist ein interner Speicher des Protokolls. Er ist KEINE Einzahlungsadresse. Jede vom Protokoll unterstützte Einzahlung läuft über die Facet-Einstiegspunkte von Vaipakam, die im Rahmen einer Offer-Erstellung, Loan-Annahme oder eines Deposit-Vorgangs Mittel aus deinem Wallet in deinen Vault ziehen. Token, die AUSSERHALB dieses Flows im Vault ankommen — z. B. durch einen direkten `IERC20.transfer` aus einem Wallet oder einen CEX-Withdrawal, bei dem deine Vault-Adresse kopiert und eingefügt wurde — liegen dort ohne Protokoll-Buchhaltung. Der Asset-Viewer blendet sie aus, da er nur den vom Protokoll verfolgten Saldo anzeigt.

Token können auf zwei Arten hängenbleiben:
1. **Du hast sie selbst geschickt.** Du hast deine Vault-Adresse (aus dem Dashboard oder einem Block-Explorer) in ein CEX-Auszahlungsfeld oder das Senden-Formular eines Wallets kopiert und abgeschickt. Die Token landeten in deinem Vault, ohne den Einzahlungspfad des Protokolls zu durchlaufen.
2. **Ein Dritter hat sie geschickt ("Dust-Attacke").** Jemand hat einen kleinen Betrag von einem markierten Wallet an deinen Vault überwiesen, in der Hoffnung, deine Adresse mit seinem Ruf in Verbindung zu bringen. Dies ist ein realer Angriffsvektor gegen prominente Adressen auf permissionless Chains.

<a id="stuck-recovery.taint-poisoning"></a>

### Über "Taint-Poisoning"

Wenn der Dritt-Absender auf einer Sanktionsliste steht, könnten generische On-Chain-Analysetools deinen Vault als "sanktionsnah" markieren, obwohl du die eingehenden Token nie berührt hast. Es gibt keinen On-Chain-Weg, dies rückgängig zu machen — das Transfer-Event ist permanent. Die INTERNE Buchhaltung von Vaipakam ist davon unberührt (wir verfolgen nur über das Protokoll vermittelte Deposits, Dust geht niemals in unsere Zähler ein), sodass deine Loans / Deposits / Claims normal weiterfunktionieren. Externe Tools jedoch, die unsere Buchhaltung nicht verstehen, könnten Warnungen anzeigen.

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

1. Besuche die [Wiederherstellungs-Seite](https://defi.vaipakam.com/recover).
2. Gib die Token-Vertragsadresse, die Quelle, von der du gesendet hast, und den Betrag ein.
3. Lies den Hinweis auf dem Bildschirm sorgfältig durch.
4. Tippe "CONFIRM" ein, um das Signieren freizuschalten.
5. Signiere die EIP-712-Bestätigung in deinem Wallet.
6. Sende die Transaktion ab.

Zwei Ergebnisse sind möglich:
- **Quelle sauber** → Die Token werden dem erfassten Saldo deines Vaults gutgeschrieben. Hebe sie wie gewohnt aus deinem Vault ab; ist der geschützte Kontomodus aktiv, gilt seine Auszahlungsverzögerung.
- **Quelle markiert** → Token bleiben im Vault, dein Vault wird im Rahmen der Sanktionspolitik des Protokolls gesperrt. Die Sperre hebt sich automatisch auf, wenn die Adresse später vom Sanktions-Orakel entfernt wird.

<a id="stuck-recovery.disown"></a>

### Unaufgeforderte Token verleugnen (Compliance-Audit-Trail)

Wenn du einen öffentlichen On-Chain-Nachweis möchtest, dass ein bestimmter Token-Saldo in deinem Vault NICHT dir gehört, bietet das Protokoll eine `disownUntracked(kind, asset, tokenId)`-Funktion an. Sie emittiert ein Event (`UntrackedDisowned`) und ändert sonst nichts — die Token bleiben wie zuvor im Vault. Dies ist nützlich bei Compliance-Streitigkeiten, falls eine CEX oder eine Regulierungsbehörde fragt: "Haben Sie diese Mittel erhalten?". Du kannst dann auf das On-Chain-Event verweisen.

Die Disown-Funktion ist derzeit nur über direkten Vertragsaufruf zugänglich; das Vaipakam-Frontend bietet dafür keinen Button an. Nutze die "Write Contract"-Oberfläche eines Block-Explorers oder ein Tool zur Interaktion mit Smart Contracts, um sie aufzurufen.

<a id="chapter.how-vpfi-discounts-work"></a>

## Wie VPFI-Rabatte funktionieren

VPFI in deinem Vault auf Base, der kanonischen Chain, bringt dir einen
Rabatt auf die eigenen Gebühren des Protokolls, auf jeder Chain, auf
der die Plattform läuft. Je mehr du hältst und je länger du es hältst,
desto höher dein Tier und desto größer der Rabatt. Die Tiers stehen in
der [Tier-Leiter](#dashboard.fee-discount-consent) weiter oben; die
Governance kann sie ändern.

Worauf der Rabatt wirkt:

- **Als Lender** auf die Yield-Gebühr, die das Protokoll von deinen
  Zinsen einbehält. Sie wird bei jedem Settlement von Zinsen gelesen,
  etwa bei Rückzahlung, Preclose oder Refinanzierung, mit deinem Tier
  in diesem Moment, nicht mit dem Tier bei Kreditbeginn.
- **Als Borrower** auf die Loan Initiation Fee, die bei Kreditbeginn
  berechnet wird. Sie wird einmal gelesen, bei der Annahme, und bleibt
  für diesen Kredit fest. Sie gilt nur, wenn das Lending-Asset liquide
  ist; ein illiquider Kredit zahlt die volle Gebühr.

Der Rabatt wird von der Gebühr selbst abgezogen, im Asset des Kredits,
und dafür verlässt kein VPFI deinen Vault. Die einzige Ausnahme ist der
Lender-Rabatt auf einem Deployment, das eine VPFI-Preisreferenz
konfiguriert: Dort kann er stattdessen in VPFI aus deinem Vault
beglichen werden. Zum Start ist keine konfiguriert. Dieses Kapitel
behandelt diesen Halte-Rabatt. Ein separater bezahlter Gebührenmodus,
„Full“, bleibt ausgeschaltet, solange ein Deployment ihn nicht
einschaltet.

<a id="vpfi-discounts.turning-on"></a>

### Den Rabatt einschalten

Der Rabatt ist Opt-in. Der Schalter liegt auf der VPFI-Seite, und es
gibt einen pro Chain, weil jede Chain ihre eigene Einstellung hat:

- **Auf der Chain, auf der die Gebühr anfällt**, muss der Schalter an
  sein, sonst berechnet diese Chain die volle Gebühr, egal welches Tier
  du hast.
- **Auf Base** muss der Schalter ebenfalls an sein, auch wenn du dort
  nie leihst oder verleihst. Solange er aus ist, schickt Base allen
  anderen Chains für dich Tier null.

Wenn du den Rabatt auf Base ausschaltest, schickt die App direkt danach
ein Tier-Update, damit auch alle anderen Chains ihn nicht mehr anwenden:
Base schickt ihnen dann für dich Tier null. Schlägt dieser zweite
Schritt fehl, sagt die Seite das, und die anderen Chains behalten dein
letztes Tier, bis etwas ein neues schickt. Schaltest du ihn auf einer
anderen Chain aus, ändert sich nur diese Chain.

VPFI zählt, wenn das Protokoll es in deinem Vault erfasst: was du über
die VPFI-Seite einzahlst, und VPFI-Rewards, die das Protokoll in deinen
Vault liefert. Token, die direkt an die Adresse deines Vaults geschickt
werden, verfolgt das Protokoll nicht, und sie erhöhen dein Tier nicht.

<a id="vpfi-discounts.tier-calculation"></a>

### Wie dein Tier berechnet wird

Dein Tier ergibt sich aus drei getrennten Prüfungen, und alle drei
müssen bestanden sein:

1. **Eine Mindesthaltedauer.** Dein Tier bleibt null, bis dein
   aktueller Bestand mindestens 3 Tage gehalten wurde. Ein Bestand
   beginnt, sobald dein Vault-Guthaben über null steigt, und dauert,
   bis es wieder auf null fällt. Nachlegen startet die Uhr nicht neu;
   alles abheben schon. (3 Tage ist der Standard; die Governance kann
   2 bis 14 festlegen.)
2. **Ein Durchschnitt mit Gewicht auf den letzten Tagen.** Dein
   Guthaben wird über die letzten 30 Tage gemittelt, wobei die letzten
   7 Tage dreifach zählen. Der Durchschnitt reicht nie vor den Beginn
   deines aktuellen Bestands zurück, sodass ein neuer Halter nicht
   durch Tage verwässert wird, an denen er nichts hielt. (Fenster,
   jüngste Tage und Gewicht sind Governance-Einstellungen; das Fenster
   kann 14 bis 30 Tage lang sein.)
3. **Das niedrigste Tier, das du berührt hast.** Unabhängig vom
   Durchschnitt kann dein Tier nicht höher sein als das niedrigste
   Tier, das dein Guthaben während des aktuellen Bestands erreicht hat,
   mit einem Rückblick von höchstens 30 Tagen. Es zählt der
   Tiefststand jedes Tages, ein Absinken und Erholen am selben Tag
   zählt also trotzdem als Absinken.

Was das praktisch heißt:

- Eine Einzahlung kurz vor dem Settlement eines Kredits hebt dein Tier
  nicht sofort an. Der zusätzliche Betrag muss erst in den Durchschnitt
  einfließen, und dein Tiefststand begrenzt dich weiterhin.
- Eine Auszahlung, die dich unter die Schwelle eines Tiers bringt,
  senkt dein Tier sofort.
- Ein Absinken, das mehr als 30 Tage zurückliegt, begrenzt dich nicht
  mehr.

<a id="vpfi-discounts.other-chains"></a>

### Dein Tier auf anderen Chains

Base berechnet dein Tier. Alle anderen Chains wenden eine Kopie an, die
Base über Chainlink CCIP schickt. Base aktualisiert deinen Tier-Eintrag,
wenn auf Base eines davon passiert: VPFI kommt in deinen Vault oder
verlässt ihn (eine Einzahlung, eine Auszahlung oder ein Reward, der in
ihn geliefert wird); ein Kredit beginnt mit dir als Verleiher oder
Kreditnehmer; ein Kreditschritt hält VPFI von dir fest oder gibt es
frei; oder du machst den Aufruf zum Auffrischen des Tiers. Jede
Aktualisierung schickt den anderen Chains eine neue Kopie, wenn sich die
Kopie ändern würde.

Jede Chain wird für sich beliefert. Eine nicht erreichbare Chain hält
die anderen nicht auf, und **eine Zustellung, die nicht rausgehen kann,
lässt deine eigene Aktion nie fehlschlagen**: Dein Tier auf Base ist
sofort aktuell, und jeder anderen Chain wird das Update geschuldet, bis
es ankommt.

Wer eine Zustellung bezahlt, hängt davon ab, in welche Richtung sich
dein Tier bewegt hat:

- **Ein niedrigeres Tier** wird sofort geschickt und vom Protokoll
  bezahlt, solange sein Budget es bezahlen kann. Bis es ankommt,
  wendet die Chain weiter dein vorheriges, höheres Tier an.
- **Ein höheres Tier**, auch dein erster Rabatt auf einer Chain, wird
  nie vom Protokoll bezahlt. Es wird geschickt, wenn jemand mit dem
  Zustellaufruf die Cross-Chain-Gebühr dafür bezahlt. Bis dahin behält
  die Chain dein vorheriges Tier. Eine Änderung der Tier-Tabelle zählt
  als höheres Tier.
- Ein Update, das das Budget nicht bezahlen konnte, **wird nicht von
  selbst erneut gesendet**. Es geht mit der nächsten Aktualisierung
  Ihres Tier-Eintrags auf Base hinaus, oder wenn jemand den
  Zustellaufruf für Sie ausführt. Ein höheres Tier wartet auf den
  Zustellaufruf.
- Diesen Aufruf kann jeder ausführen. Für ein niedrigeres Tier zahlt das
  Protokoll; für ein höheres zahlt der Aufrufer die Cross-Chain-Gebühr.
  Die Contracts bieten diesen Aufruf an; die App bietet ihn noch nicht
  an, ein höheres Tier erreicht eine andere Chain also vorerst nur über
  einen direkten Contract-Aufruf.

Eine Kopie zählt nicht mehr, und die Chain gibt dann keinen Rabatt,
wenn:

- sie älter ist als das Höchstalter der Chain (standardmäßig 60 Tage,
  nie weniger als 30); oder
- sie mit einer älteren Tier-Tabelle erstellt wurde als der, die die
  Chain inzwischen kennt.

Eine Kopie wird nur erneut geschickt, wenn sich etwas darin ändern
würde: dein Tier, sein Rabatt, wie lange sie gültig bleibt oder die
Version der Tier-Tabelle. Nach einer Änderung der Tier-Tabelle schickt
die nächste Aktualisierung deines Tier-Eintrags auf Base also jeder
Chain eine frische Kopie, auch wenn dein Tier gleich bleibt, außer es
ist null. Hat sich nichts davon geändert, gibt eine Chain mit veralteter
Kopie keinen Rabatt, bis sich etwas ändert.

Steigt dein Tier nur, weil Zeit vergangen ist — die Haltedauer ist
erreicht oder der Durchschnitt hat aufgeholt —, bemerkt Base das erst
bei der nächsten Aktualisierung deines Tier-Eintrags. Der Aufruf zum
Auffrischen des Tiers macht diese Aktualisierung, wann immer du willst;
die App macht ihn für dich nur, wenn du den Rabatt ausschaltest.

<a id="vpfi-discounts.operators"></a>

### Für Betreiber

Der Cross-Chain-Teil des Rabatts braucht diese Konfiguration. Sie
steht hier für alle, die ein eigenes Deployment betreiben.

**Auf Base:**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. Ohne das berechnet
  Base Tiers, schickt sie aber nirgendwohin.
- `RewardReporterFacet.setRewardMessenger` mit Verweis auf den
  `VaipakamRewardMessenger`, und `setBroadcastDestinations` des
  Messengers mit allen anderen Chains.
- Ein gedecktes Broadcast-Budget:
  `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable). Ein leeres
  Budget blockiert nichts. Jede Zustellung, die es nicht bezahlen
  kann, bleibt geschuldet und emittiert `TierPushDeferred` mit dem
  Grund, und `getTierPushStatus(user)` zeigt den Stand jeder Chain für
  einen Nutzer. Ein knappes Budget bedeutet, dass andere Chains länger
  alte Tiers anwenden; beobachte die Aufschübe und lade nach.

**Auf jeder anderen Chain:**

- `RewardReporterFacet.setRewardMessenger(addr)`: der einzige Absender,
  dessen Tier-Updates die Chain annimmt.
- `RewardReporterFacet.setBaseChainId(chainId)`: die EVM-Chain-ID von
  Base (8453 auf Mainnet, 84532 auf Base Sepolia), nicht ihr
  CCIP-Chain-Selektor.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)`: wie lange eine Kopie
  zählt (Standard 60 Tage; Werte unter 30 Tagen werden abgelehnt). Eine
  Senkung wirkt beim nächsten Lesen.

**Die Tier-Tabelle ändern:**

- `setVpfiTierThresholds` und `setVpfiTierDiscountBps` auf Base
  erhöhen die Version der Tabelle. Eine andere Chain erfährt die neue
  Version durch das erste Tier-Update, das sie trägt, egal von welchem
  Nutzer. Ab dann gilt jede mit der alten Tabelle erstellte Kopie als
  kein Rabatt, bis das eigene Update dieses Nutzers ankommt, und jedes dieser Updates ist ein höheres Tier, das nur ein zahlender Aufrufer zustellt.
- `setTwaMinStakedDays` ändert die Mindesthaltedauer, ohne die Version
  zu erhöhen. Die Änderung wirkt beim nächsten Lesen.

<a id="chapter.next-app"></a>

## Die nächste App

Die nächste Version der Vaipakam-App entsteht Seite für Seite,
neben der aktuellen. Eine noch nicht gebaute Seite sagt das und
verlinkt auf die aktuelle App, die sie weiter bedient. Jede Zahl
auf einer gebauten Seite wird von der Chain gelesen und nennt ihre
Quelle; eine nicht lesbare Zahl wird als unbekannt gezeigt, nie als
null.

<a id="advanced-mode"></a>

### Basic und Advanced

Basic zeigt die Funktionen, die die meisten brauchen. Advanced
ergänzt Exit- und Settlement-Werkzeuge, Automatisierung, signierte
Orders, den Keeper-Status und Abrechnungsdetails. Der Modus ist eine
Anzeigewahl in deinem Browser: Er ändert, wie viel gezeigt wird,
nicht, was das Protokoll erlaubt, und blendet nie eine Zustimmung,
eine Sperre oder eine Abhilfe aus.

<a id="wallet"></a>

### Dein Wallet und woher deine Zahlen kommen

Dein eigener Zustand (Loans, Angebote, Vault, Claims) wird von der
Chain gelesen: zuerst über den Provider des Wallets, dann über den
Read-only-RPC-Proxy, dann über den öffentlichen Endpunkt des
Netzwerks. Die Sync-Zeile nennt die Quelle, die geantwortet hat, und
das Alter des ältesten Lesevorgangs der Seite; Aktualisieren liest
alles neu. Der Index dient nur für Weltzahlen (Markt und Verlauf),
mit Blockhöhe und Alter. Ein Wallet in einem nicht bedienten
Netzwerk sieht nichts Eigenes, bis es wechselt. Der Adress-Chip öffnet das eigene Kontopanel der App: die volle Adresse mit Kopieraktion, das Netzwerk, einen Wechsel in jedes andere bediente Netzwerk und das Trennen. Die Wallet-Auswahl dient nur dem Verbinden. Verbunden rendert die App keine Namensdienst-Abfrage, daher liest eine verbundene Sitzung nichts im Ethereum-Mainnet und erreicht keinen Host außerhalb der connect-src-Liste der Seite.

<a id="deployments"></a>

### Was das Deployment unterstützt

Die App bindet sich pro Chain an einen Diamond und liest dessen
geroutete Selektoren über die Loupe, bevor sie eine Aktion anbietet.
Nach einem Facet-Refresh ändert sich diese Menge; weil die App sie
liest statt annimmt, kann sie eine fehlende Funktion benennen, statt
mit `FunctionDoesNotExist` zu scheitern. Solange die Menge nicht
lesbar ist, wird kein Signaturschritt angeboten.

<a id="home-start"></a>

### Home: Eine Aufgabe wählen

Home beginnt mit einer Aufgabe, nicht mit einem Protokollbegriff:
leihen, verleihen, ein NFT mieten, ein NFT vermieten oder verwalten,
was du hast. Leihen und Verleihen öffnen mit passenden Angeboten und
führen sonst zum eigenen Angebot. Mieten deckt beide Seiten einer
NFT-Miete ab; das NFT liegt die ganze Zeit in einem Vault. Ein
verbundenes Wallet sieht außerdem drei ausblendbare Einstiegskarten;
das Ausblenden wird im Browser gespeichert.

<a id="home-status"></a>

### Home: Protokollstatus

Home liest die globale Pause, das automatische Pausenfenster und die
Keeper-Pause auf der Chain, die die Seite beschreibt, und nennt das
Ergebnis in jedem Fall. Eine globale Pause stoppt neue Positionen,
Claims, Auszahlungen, Liquidationen, Defaults und Keeper-Settlement;
volle und teilweise Rückzahlung sowie Nachlegen von Sicherheiten
bleiben offen, und die pausierte Zeit wird den Fristen jedes offenen
Loans gutgeschrieben. Ein automatisches Pausenfenster zeigt sein
Ende; eine Admin-Pause, falls vorhanden, dauert länger, und ein
neues automatisches Fenster öffnet erst nach einer Abkühlphase. Eine
Keeper-Pause stoppt nur Schritte, die der Dienst für dich ausführt.
Ein nicht lesbarer Status, auch ein Neulesen, das nach einer
früheren Antwort scheiterte, steht oben als unbekannt. Einzelne
Assets können ebenfalls pausiert sein; die betroffenen Abläufe sagen
es.

<a id="home-payouts"></a>

### Home: Bereit zum Abholen

Home geht die Claimable-Views für Verleiher- und Leiherseite Seite
für Seite durch und nennt jede Auszahlung nach Loan und Seite. Es
zeigt keinen Betrag: Eine Auszahlung kann in mehr als einem Asset
und über mehr als einen Weg erfolgen, und Claims nennt jeden Betrag
vor dem Abholen. Endet der Durchgang vor dem Ende, sagt Home, dass
mehr existieren kann als gezeigt.

<a id="home-loans"></a>

### Home: Deine Loans

Jeder Loan im Status Active oder FallbackPending wird mit Seite,
Bedingungen, Sicherheit und Stufe gezeigt, nach Dringlichkeit
sortiert: Kulanz vorbei, in Kulanz, Fallback, Frist unlesbar, fällig
in drei Tagen, laufend. Fälligkeit und Kulanzende kommen aus der
Loan-Uhr des Protokolls und enthalten die pausierte Zeit, die
angezeigt wird, wenn sie nicht null ist. Der Health Factor ist der
1e18-skalierte Wert der Dashboard-View; ein Wert von 0 bedeutet
keinen Wert (ein Asset ohne Preis oder ein gescheitertes Lesen) und
wird so gezeigt. Zwei oder mehr Loans aus demselben Angebot, auf
derselben Seite und im selben ERC-20, werden gruppiert: Principal
summiert, Zins nach Principal gewichtet und abgerundet, und der
niedrigste Health Factor der bepreisten Loans, die unbepreisten
gezählt.

Ein Loan mit periodischer Zinszahlung hat zusätzlich Stichtage, bis einschließlich seines Fälligkeitsdatums. Zinsen, die nach der Kulanzfrist eines Stichtags noch offen sind, können durch den Verkauf von Sicherheiten bezahlt werden, und der Loan bleibt offen; Home zeigt den nächsten Stichtag und stellt einen offenen nach vorn, auch wenn er auf das Fälligkeitsdatum fällt, weil seine Kulanzfrist vor der des Loans enden kann. Das Protokoll kann diese Abrechnung abschalten; Home sagt dann, dass an einem Stichtag keine Sicherheit verkauft wird.

<a id="home-exposure"></a>

### Home: Verliehen und geliehen

Der Principal jedes Loans wird zu aktuellen Preisen im Numeraire
bewertet, über die eine Bewertungsregel des Protokolls: eine Schuld
aufgerundet, ein von dir gegebener Loan abgerundet. Ein nicht
bewertbarer Loan (ein NFT oder ein Asset ohne Preis) wird gezählt,
nicht geschätzt. Die größere Seite wird nur genannt, wenn die
unbewerteten Loans das Ergebnis nicht ändern könnten; sonst zeigt
Home die bewerteten Summen und die Anzahl.

<a id="home-faucet"></a>

### Home: Test-Assets

Auf einem Testnetz, dessen Deployment-Eintrag Test-Assets veröffentlicht, listet Home sie auf: Test-ERC-20s mit Test-Preisfeed und Pool (liquide), solche, die bewusst ohne beides bleiben (illiquide: Kredite in ihnen sind unbepreist und fallen in Sachwerten aus), und ERC-4907-Miet-NFTs. Eine Prägung ruft den Mock-Token-Vertrag auf, nie den Diamond: 1.000 ganze Token oder ein NFT unter einer frischen zufälligen Token-ID, die vor dem Öffnen der Wallet als ungeprägt geprüft wird. Das Ergebnis wird gemessen, indem der Saldo oder `ownerOf` zurückgelesen wird; eine Token-Prägung bietet danach `wallet_watchAsset` an. Ein Test-NFT kann nur sein Eigentümer oder ein genehmigter Operator verbrennen.

<a id="home-fee-discount"></a>

### Home: Gebührenrabatt

`setVPFIDiscountConsent` setzt ein Flag pro Wallet auf dem Diamond dieser Chain. Aus ist der Hold-Tier-Rabatt 0. An wird die Loan Initiation Fee des Leihenden bei der Annahme im Kreditasset reduziert (der VPFI-Preisweg gehört nie zum Leihenden-Pfad), und die Yield Fee des Verleihers wird bei jeder Abrechnung mit der dann geltenden effektiven Stufe rabattiert. Die Auszahlung folgt `getVPFIDiscountConfig`: Sind VPFI-Kurs und Referenz-Asset beide gesetzt, wird die rabattierte Gebühr in VPFI aus dem Vault des Verleihers abgebucht und er behält die gesamten Zinsen; sonst wird die Treasury-Gebühr selbst reduziert und kein VPFI bewegt. Kann diese Abbuchung bei einer Abrechnung nicht laufen (kein aktueller Kurs, zu wenig freies erfasstes VPFI im Vault oder dieses VPFI als Sicherheit gesperrt), erhält die Gebühr dieser Abrechnung keinen Hold-Tier-Rabatt. Der Aufruf ist `whenNotPaused`, die globale Pause schließt ihn also in beide Richtungen. Das Einschalten ist durch die Bedingungen gesperrt, das Ausschalten nicht, und keines von beiden sendet eine Stufe an die Mirrors. Der Leihenden-Rabatt gilt nur, wenn das Kreditasset bei der Annahme liquide ist (ein illiquider Kredit zahlt die volle LIF), und jeder Rabatt ist auf 50 % der Gebühr begrenzt. Seit #3562 ist der Hold-Tier-Rabatt eines Verleihers auf einen Kredit nie höher als der Wert, der für den Halter bei Übernahme der Verleiher-Position erfasst wurde (`lenderEntryDiscount`, geschrieben, sobald das Verleiher-Token einen Halter erhält; eine einfache Übertragung behält den niedrigeren Wert aus dem erfassten und dem des Empfängers).

<a id="home-rewards"></a>

### Home: Belohnungen

Die Hauptzahl ist `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`, das den Claim mit dem Vault-Ziel ausführt und immer revertiert: `InteractionRewardsSimulation(paid, fromDay, toDay)` trägt den genauen Betrag, jeder andere Revert ist die eigene Ablehnung des Claims (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`) und wird beim Namen genannt. Nur wenn keine Quelle die Vorschau ausführen kann, liest Home `previewInteractionRewards`, eine Untergrenze, und hält den Claim zurück. Ein genauer Betrag von null wird trotzdem angeboten: Das Protokoll erlaubt einen Claim, der nichts auszahlt, nur wenn er über Belohnungstage hinausrückt, die nichts ausgezahlt haben, und Home sagt das. Home beansprucht über `claimInteractionRewardsTo(2)`, das pro Aufruf höchstens `MAX_INTERACTION_CLAIM_DAYS` (30) Tage zahlt; liefert eine Vorschau, die im Block des abgeschlossenen Claims oder später gelesen wurde, noch einen Betrag, bietet Home den Rest an. Ein Claim, der nur aus Belohnungseinträgen zahlt, nennt keinen Tagesbereich (0 bis 0), und Home sagt das, statt Tage zu zeigen. Das Vault-Ziel wird für jedes Konto übergeben, auch für eine Contract-Wallet, weil das Default-Ziel einen Contract-Aufrufer an seine Wallet auszahlt: Der Vault wird gutgeschrieben, mit Rückfall auf die Wallet, wenn die Gutschrift nicht abgeschlossen werden kann (noch kein Vault). Das Ergebnis wird aus dem Beleg gelesen: `InteractionRewardsClaimed` nennt den gezahlten Betrag, und die VPFI-`Transfer`-Logs derselben Transaktion an die Wallet und an `getUserVaultAddress(user)` zeigen, wo er gelandet ist; ergeben sie nicht den gezahlten Betrag, wird das Ziel als unbekannt ausgewiesen. Die Summe aller Claims wird nicht gezeigt: Dafür gibt es noch keine Index-Route pro Nutzer.

Warum ein wartender Tag wartet, wird am Block der Vorschau gelesen. In einem Heimatnetzwerk (oder einem ohne gesetzte Rolle) nennt `RewardAggregatorFacet.isDayReadyToFinalize(day)` den Grund, warum ein Abschluss noch nicht laufen kann (keine gelistete Meldung, Meldungen noch in ihrer Karenzzeit, eine unbrauchbare Liste erwarteter Quellen), oder dass er jetzt laufen kann. In einem Mirror sagt `RewardReporterFacet.getBroadcastV2Applied(day)`, ob die Zahlen des Heimatnetzwerks angekommen sind, und bei einem Lieferwarten liefern `RewardRemittanceLensFacet.getDayDeliveryState(day)` und `getDayDeliveryParts(day)`, ob der Tag hier bepreist ist, ob die Meldung dieses Netzwerks gesendet wurde und welche Teile gegenüber dem erklärten Ganzen angekommen sind; ein Tag, dessen Teile unterschiedliche Ganze erklärten, wird als einer offengelegt, der unbezahlt übersprungen werden kann. Die Finanzierungsablehnungen der Einlösung werden mit den Zahlen des Protokolls genannt: `InteractionPoolExhausted` (der Pool an neuem VPFI ist ausgezahlt und die Einlösung hat keinen recycelten Anteil, was sich nicht aufhebt), `InteractionPoolReservedShortfall` und `RecycleBucketReservedShortfall` (für laufende Abrechnungen reserviert) und `InteractionRewardBackingShort` (benötigt gegenüber verfügbar). `EnforcedPause` wird mit dem genannt, was offen bleibt.

<a id="home-rewards-expiry"></a>

### Home: Entfernungstermine für Belohnungen

`ConfigFacet.getRewardClaimHorizonDays()` gleich 0 bedeutet, dass der Horizont dunkel ist und kein Termin angezeigt wird. Andernfalls durchläuft Home `getUserSoonestRewardExpiry(user, offset, 200, 50)` Seite für Seite, jede Seite im selben Block, bis zu zehn Seiten; der Durchlauf ist vollständig, wenn `nextOffset >= total`, und ein vorzeitig endender Durchlauf wird als unvollständig ausgewiesen, nie als „nichts fällig“. Der letzte Hinweis erscheint innerhalb von 90 Tagen vor der frühesten Schätzung. Die Schätzung ist das `expiresAt` des Eintrags in diesem Block: nicht ausführbare Claim-Zeit verschiebt die tatsächliche Entfernung nach hinten, eine Governance-Änderung des Horizonts kann sie vorziehen. Der Betrag, den der Eintrag entfernen würde, wird auf Home nicht gezeigt.

<a id="home-rewards-held"></a>

### Home: Zurückgehaltene Belohnungen

`getSanctionsHeldReward(user)` ist das zurückgehaltene Guthaben und `getRewardSanctionsStatus(user)` seine Entscheidung (Deliver, Hold oder Confirmed). Mit einem Guthaben und der Entscheidung Deliver bietet Home `claimHeldInteractionRewards(2)` an, das genau das zurückgehaltene Guthaben auszahlt, ohne neu Geschuldetes abzurechnen, und `InteractionRewardsClaimed(user, 0, 0, paid)` emittiert; solange die Wallet gesperrt ist, revertiert es mit `SanctionedAddress`. Die Prüfung vor dem Signieren liest beides erneut und simuliert den Aufruf als Absender. Tage, die bei bestätigter Markierung verdient wurden, verfallen endgültig.

<a id="borrow-start"></a>

### Borrow: So funktioniert es

Borrow nimmt ein Verleiherangebot (`offerType` 0) eines ERC-20 gegen ERC-20-Sicherheit direkt an, mit `acceptOffer(offerId, terms, signature)`. In einer Transaktion eröffnet es den Vault des Leihenden, falls keiner existiert, zieht die Sicherheit hinein, liefert den Kapitalbetrag abzüglich der Eröffnungsgebühr an die Wallet und emittiert `LoanInitiated`. Ein Leihender kann auch eine Anfrage stellen (`offerType` 1); NFT-Seiten, Paar-Zustimmungen und die erweiterten Optionen folgen in späteren Updates.

<a id="borrow-pair"></a>

### Borrow: Die Tokens wählen

Die Klasse jedes Tokens wird live gelesen: zuerst `getAssetPriceStatus(asset)` (Divergent gilt als misstraut und schließt neue Kredite), dann `checkLiquidityOnActiveNetwork(asset)` (0 liquide, 1 illiquide). Ein Revert mit `OraclePriceDivergence` oder `OracleCrossCheckDivergence` gilt als misstraut; jeder andere Fehler wird mit Grund als nicht lesbar gezeigt. Die Vorschlagsliste ist der Wrapped-Native-Token und die Test-Tokens des Deployment-Datensatzes; eine eingefügte Adresse wird nur auf Form geprüft.

Die Vertrauensstufe liest `GET /assets/rankings?chainId=<token chain>` vom Index, der den täglichen Abruf zweier öffentlicher Marktkapitalisierungslisten durch den Keeper bereitstellt (jeweils die Top 500): ein Eintrag pro Adresse mit Rang, Name und Symbol jeder Liste, dazu `listFetchedAt` und der letzte Lauf jeder Liste. Die App schlüsselt nach der kleingeschriebenen Adresse und nimmt den besten Rang über beide Listen: Blue Chip bei Rang ≤ 20 mit `getAssetPriceStatus(asset)` bepreist, dann ≤ 100, 200, 300 und 500. Ein Symbol, das eine andere Liste unter einer anderen Adresse führt, wobei keine Liste beide Adressen führt, macht den Token nicht bestätigt; ein nicht gelisteter Token, dessen `symbol()` oder `name()` einem gelisteten Symbol oder Namen entspricht, ist eine mögliche Kopie; jeder andere ist ungelistet. Ein Testtoken aus dem Deployment-Eintrag wird als Test markiert; eine Chain ohne gespeicherte Liste gilt im Testnetz als Testnetzwerk und im Mainnet als ohne Liste. Ein `lastRun`, der nach `listFetchedAt` fehlschlug, wird genannt. Die Stufe dient nur der Anzeige und ändert keine On-Chain-Behandlung. Die Suche gleicht gelistete Symbole und Namen als Teilzeichenfolge ab, bester Rang zuerst, dann vorgeschlagene Tokens nach Symbol; Text, der mit `0x` beginnt, wird stattdessen als Adresse gelesen.

<a id="borrow-offers"></a>

### Borrow: Ein Angebot auswählen

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` liefert die offenen Angebots-IDs des Paars und die Gesamtzahl. Für jede liest die Seite `getOffer`, `getOfferState` und, mit Wallet, `previewAccept(offerId, wallet)`, dessen `errorCode` die Ablehnung des Protokolls ist. Der Beleihungswert ist `calculateLTV` zu heutigen Preisen; eine illiquide oder preislose Seite sagt, warum es keinen gibt. Eine direkte Annahme bindet `amountMax` des Verleihers zu `interestRateBps`. Kreditanfragen, Angebote mit NFT-Seite und eigene Angebote werden gezählt, nicht gelistet.

Die App gruppiert die Zeilen nach dem Zinssatz, den die Annahme bindet (`interestRateBps`), der niedrigste zuerst; innerhalb einer Stufe bleibt die Reihenfolge der Liste. Der höchste Zinssatz und im Advanced-Modus der höchste Beleihungswert filtern nur die gelesenen Zeilen; eine Zeile, deren `calculateLTV` keine Zahl ist, bleibt und wird gezählt. Die Zeile der bereitstehenden Verleiher liest `getActiveLenderIntents(offset, 50)`, bis zu vier Seiten, behält die Intents des Paars und nimmt für jeden das Kleinere aus `availableCapital` und `maxExposure` minus `livePrincipal`; einer unter `minFillAmount` entfällt. Sie zeigt die Anzahl, den größten Einzelwert und das niedrigste `minRateBps`, im Advanced-Modus dazu das höchste `maxDurationDays` und `maxInitLtvBps`. Ein Abgleichdienst füllt eine Anfrage aus einem Intent nur innerhalb dieser Grenzen, daher ist eine Füllung nicht garantiert. Diese Zeile setzt voraus, dass `getPartialFillEnabled` und `isLenderIntentEnabled` beide true sind, gelesen im selben Block wie jede Seite der Liste; ist einer false, sagt die Seite, dass keine Anfrage gegen sie erfüllt wird, und ist einer ungelesen, sagt sie, dass das nicht bekannt ist. Ein gescheiterter erneuter Lesevorgang behält die letzte Antwort und sagt, dass sie sich geändert haben kann. Intents, deren `owner` das verbundene Konto ist, werden verworfen (ein Abgleich mit sich selbst wird als Self-Trade abgelehnt). Jede Intent-Erfüllung verlangt außerdem `useFullTermInterest` der Anfrage und lehnt `allowsPartialRepay` ab (`LenderIntentFullTermRequired`, `LenderIntentPartialRepayNotAllowed`); der Weg nennt beides, und das Anfrageformular nennt eine Wahl, die eines davon verfehlt, anstelle der wahrscheinlichen Erfüllung. Auch `keepersPaused()` wird am selben Block gelesen: Solange es true ist, erfüllt der Abgleichdienst des Protokolls nichts, daher sagt die Seite das anstelle der wahrscheinlichen Füllung und ergänzt, dass ein Verleiher weiterhin aus seinem eigenen Intent füllen kann und jeder Füller einen ohne `requiresKeeperAuth` füllen kann; ungelesen sagt sie, dass das nicht bekannt ist. Eine Intent-Füllung verlangt außerdem, dass `periodicInterestCadence` der Anfrage keiner ist, weil der Slice des Intents keinen Plan trägt und der Abgleich abweichende Laufzeitbedingungen ablehnt (`LifecycleTermsMismatch`); das Anfrageformular nennt einen gewählten Plan anstelle der wahrscheinlichen Füllung. Intents mit `requiresKeeperAuth` werden getrennt zusammengefasst und genannt, und die Zeile zur wahrscheinlichen Füllung gilt nie für sie: Nur der Verleiher oder ein von ihm für `KEEPER_ACTION_SIGNED_FILL` autorisierter Solver darf einen füllen, und ob der Abgleichdienst diese Autorisierung hat, wird nicht gelesen, daher sagt die Seite, dass es nicht bekannt ist. Das Urteil liest außerdem `paused()` und `aggregatorAdaptersPaused()` am selben Block: Eine globale Pause geht jeder anderen Schranke vor und wird als angehalten genannt, und solange Aggregatoren pausiert sind, wird jeder Eigentümer an diesem Block mit `isAggregatorAdapter` geprüft und seine Intents werden weggelassen, da `matchIntent` sie ablehnt; eine nicht gelesene Prüfung macht das Urteil unbekannt.

<a id="borrow-review"></a>

### Borrow: Prüfen und Signieren

Die Prüfung liest das Angebot, seinen Zustand, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, beide Klassen, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, Vault, Saldo und Freigabe der Wallet, `previewOfferAcceptBlock` und die Rabattzustimmung, und liest sie direkt vor dem Öffnen der Wallet erneut. Die Wallet signiert EIP-712 `AcceptTerms` (Domain `Vaipakam AcceptOffer`, Version 1) aus dem gespeicherten Angebot, mit frischer 128-Bit-Nonce und 30 Minuten Frist; eine Illiquiditäts-Bestätigung nennt nur eine Seite, die die Prüfung als illiquide zeigte. Eine Freigabe von genau der Sicherheit folgt nur, wenn die Freigabe nicht reicht; dann wird `acceptOffer` mit der Signatur simuliert und gesendet. Stoppt es nach der Freigabe, setzt die App sie auf den früheren Wert zurück, wenn nichts anderes sie geändert hat. Das Ergebnis liest `LoanInitiated` für dieses Angebot und diese Wallet und die `Transfer`-Logs des Belegs. Die Freigabe wird direkt vor der ersten Wallet-Abfrage erneut gelesen, und genau dieser Wert wird bei einem Zurücksetzen wiederhergestellt; eine gesendete Annahme, die zurückgesetzt wird (revert) oder die die Wallet abbricht oder ersetzt, erhält vom Transaktions-Tracker dasselbe Zurücksetzen. Die Prüfung nennt `allowsPartialRepay`, `allowsPrepayListing`, `allowsParallelSale` mit `parallelSaleOrderHash`, `refinanceTargetLoanId` und den verknüpften Kredit und kennzeichnet den geschuldeten Betrag als Fall ohne Pause, da Zinsen während einer Pause weiterlaufen, während sich das Fälligkeitsdatum verschiebt. Jeder Freigabeschritt wird an der Freigabe gemessen, die im Block seiner Quittung zurückgelesen wird, nie am Status der Quittung. Ein Token, das eine Änderung von einer Freigabe ungleich null auf eine andere ablehnt (per Probelauf von `approve` ermittelt), erhält zuerst einen Schritt auf null, den die Prüfung als zusätzliche Abfrage zählt. Die Annahme der Bedingungen wird unmittelbar vor dem Öffnen der Wallet erneut gelesen. Beide Verkaufswege listen die Sicherheit als NFT; bei Token-Sicherheiten wird eine gewährte Listing- oder Verkaufserlaubnis daher als für dieses Darlehen nicht nutzbar angegeben. Die Prüfung ergänzt `getNumeraireValue` für Kapital und Sicherheit zu den Beträgen der Vorschau, als Zeilen, die nichts binden.

<a id="borrow-fee"></a>

### Borrow: Die Eröffnungsgebühr

Die Gebühr ist `lifEstimate` aus `previewAccept`: `getLoanInitiationFeeBps` des Kapitalbetrags, im Leih-Token, vom Gelieferten abgezogen, gesenkt um den Haltestufen-Rabatt, wenn die Zustimmung an und der Leih-Token liquide ist, mit der Stufe zum Zeitpunkt der Annahme. Diese Seite wählt den Full-Tarif nie. Für die Gebühr wird kein VPFI eingezogen und keines erstattet. Der Anteil des Einreichers, `getLifMatcherFeeBps` der Gebühr, geht an den Absender, bei einer direkten Annahme also an den Leihenden; die Wallet erhält den Kapitalbetrag abzüglich der Gebühr plus diesen Anteil.

<a id="borrow-risks"></a>

### Borrow: Risiken

Ein Kredit nach dem Ende seiner Nachfrist (`getEffectiveGraceSeconds` nach dem Fälligkeitstag, den pausierte Zeit verschiebt) kann von jedem als ausgefallen ausgelöst werden: liquide Sicherheit wird für den Verleiher verkauft, illiquide unverändert übertragen. Liquide Sicherheit kann auch liquidiert werden, sobald der Health Factor unter 1 liegt. `useFullTermInterest` berechnet bei früher Rückzahlung die Zinsen der vollen Laufzeit; ein Zinsplan begleicht eine verpasste Periode durch einen Zwangsverkauf von Sicherheit.

<a id="borrow-request"></a>

### Borrow: Eine eigene Anfrage stellen

Eine Anfrage ist `createOffer` mit `offerType` 1, ERC-20 auf beiden Seiten, gesendet aus der Wallet des Leihenden. Sie zieht `collateralAmount` in den Vault des Leihenden, legt ihn an, falls keiner existiert, und emittiert `OfferCreated(offerId, creator, 1)`. Ein Verleiher nimmt sie mit `acceptOffer` an: der Kapitalbetrag abzüglich der Gebühr geht an die Wallet des Leihenden, der Absenderanteil der Gebühr an den Verleiher, der sie gesendet hat. `cancelOffer` steht dem Ersteller ab `MIN_OFFER_CANCEL_DELAY` (5 Minuten) nach der Erstellung offen und jedem, sobald die Anfrage abgelaufen ist; die Sicherheit geht immer an den Ersteller zurück. Unter jedem eingegebenen Betrag zeigt das Formular `getNumeraireValue(asset, amount, roundUp)` (Kapital aufgerundet, Sicherheit abgerundet) in der Einheit von `getNumeraireSymbol`, gelesen, sobald das Tippen pausiert; ein illiquides Asset gilt als mit nichts bewertet, ein strittiger Preis als kein Wert und ein fehlgeschlagener Lesevorgang als ungelesen.

<a id="borrow-request-terms"></a>

### Borrow: Die Bedingungen der Anfrage

Basic stellt eine Anfrage mit Einzelwerten: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 1 (AON), `periodicInterestCadence` 0, `allowsPrepayListing` und `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. Beträge werden exakt in Basiseinheiten umgerechnet, der Zinssatz beträgt höchstens 10.000 bps. `durationDays` ist durch das konfigurierte Maximum aus `getProtocolConfigBundle` begrenzt. `expiresAt` ist 0 (offen bis zur Stornierung) oder ein Zeitpunkt, der beim Öffnen der Prüfung aus dem letzten Block festgelegt wird, höchstens `MAX_OFFER_EXPIRY_HORIZON` (365 Tage) voraus. `useFullTermInterest` ist standardmäßig true, `allowsPartialRepay` false.

<a id="borrow-request-review"></a>

### Borrow: Anfrage prüfen und stellen

Die Prüfung simuliert `createOffer` aus der Wallet und liest beide Klassen, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, die maximale Laufzeit, Vault, Guthaben und Freigabe der Wallet sowie `calculateLTV`, wenn beide Seiten liquide sind; sie wird jeden Block und direkt vor dem Öffnen der Wallet neu gelesen. Solange die Freigabe zu niedrig ist, erreicht die Simulation nur den Einzug der Sicherheit: Ein Einzugsfehler des Tokens oder ein Revert ohne Fehlernamen des Protokolls wird als die zu erteilende Freigabe gezeigt, ein benannter Protokollfehler ist eine Ablehnung. Nach einer exakten Freigabe wird `createOffer` erneut simuliert und gesendet; ein Stopp nach der Freigabe setzt sie auf den früheren Wert zurück, wenn nichts anderes sie geändert hat. Das Ergebnis liest `OfferCreated` für diese Wallet und den `Transfer` der Sicherheit in den Vault.

<a id="borrow-nft-collateral"></a>

### Borrow: Ein NFT als Sicherheit

Der Standard der Sicherheit wird mit `supportsInterface` gelesen (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`); ein Revert zählt als keiner von beiden, ein fehlgeschlagener Lesevorgang bietet keine Anfrage an. Eine ERC-721-Anfrage sendet `collateralAssetType` 1, `collateralTokenId` die eingegebene ID, `collateralQuantity` 1 und `collateralAmount` = `collateralAmountMax` = 0; das Risikopaar ist an diese Token-ID gebunden. Die Prüfung liest `ownerOf`, `getApproved` und `isApprovedForAll(wallet, Diamond)` in einem Block; ein anderswo gehaltenes Token oder ein revertierendes `ownerOf` blockiert die Anfrage. Ohne eine der Freigaben endet der Probelauf am `ERC721InsufficientApproval` des Tokens, angezeigt als die zu erteilende Freigabe. Die Freigabe ist `approve(Diamond, id)` und zählt nur, wenn `getApproved` im Block der Quittung den Diamond liest; ein Stopp danach setzt sie nur auf die frühere Adresse zurück, solange sie noch den Diamond liest und die Wallet das Token noch hält. Bei ERC-721 wird `setApprovalForAll` nie verlangt. Das Ergebnis liest `OfferCreated` und den eigenen `Transfer` des Tokens (vier Topics) von der Wallet in den Tresor. Eine ERC-1155-Anfrage sendet `collateralAssetType` 2, die Token-ID, `collateralQuantity` als eingegebene Menge (1 bis 2^128−1) und beide Beträge 0. Die Prüfung liest `balanceOf(wallet, id)` und `isApprovedForAll(wallet, Diamond)` an einem Block; ein Bestand unter der Menge blockiert die Anfrage, und ohne Freigabe stoppt der Probelauf bei `ERC1155MissingApprovalForAll`. Die einzige Freigabe ist `setApprovalForAll(Diamond, true)`, gezählt, wenn sie am Block ihrer Quittung zurückgelesen wird, und mit `setApprovalForAll(Diamond, false)` zurückgenommen, nachdem die Anfrage gemined ist oder stoppt (gelesen nie vor dem Block der Freigabe), außer die Wallet hatte sie schon vorher erteilt. Das Ergebnis summiert `TransferSingle`/`TransferBatch` des Tokens von der Wallet in den Tresor. Kreditgeberangebote, die ein NFT verlangen, gehen weiterhin an die aktuelle App.

<a id="borrow-request-range"></a>

### Borrow: Eine Anfrage mit Spanne

Eine Spanne sendet `amount` (den kleinsten) unter `amountMax` (dem größten), `interestRateBps` = `interestRateBpsMax` (den einen Zinssatz) und `collateralAmount` (die Untergrenze für den kleinsten Kredit) höchstens gleich `collateralAmountMax` (beim Veröffentlichen in den Tresor gezogen); eine leere Untergrenze sendet beide gleich. Spannen gibt es nur für ERC-20-Sicherheiten. Ein direktes `acceptOffer` verleiht `amount` zu `interestRateBpsMax` gegen `collateralAmount` und gibt `collateralAmountMax − collateralAmount` an die Wallet zurück; `matchOffers` füllt zwischen den Enden, solange `getPartialFillEnabled` wahr ist. Der Probelauf von `createOffer` wendet die Angebotsgrenze am größten Ende an und lehnt mit `MaxLendingAboveCeiling(provided, ceiling)` ab, dessen Obergrenze die Prüfung zeigt. Das direkte Ende wird mit einem zweiten Probelauf einer Anfrage mit einem Wert bei (`amount`, `collateralAmount`) geprüft; eine Antwort, die vor der Grenze stoppt, wird als unbekannt angegeben. Der Beleihungswert jedes Endes ist `calculateLTV(lending, amount, collateral, collateralAmount)`, und `ZeroCollateral` gilt als wertlose Sicherheit. Der angezeigte Gesundheitsfaktor zu Kreditbeginn ist `getMinHealthFactor`, solange `getDepthTieredLtvEnabled` falsch ist, und 1,0, solange es wahr ist. Ein Match sperrt die anteilige Anforderung des Kreditgebers, angehoben auf `collateralAmount`, wenn die Sicherheit eine Spanne ist, und sonst bei der Anforderung belassen, und weiter auf die Untergrenze der Prüfung beim Kreditstart angehoben, wenn das Gesuch so viel hinterlegt hat; daher wird der größte Match sowohl bei `collateralAmountMax` als auch bei `collateralAmount` gezeigt (oder, ohne Sicherheitenspanne, als möglicherweise weniger sperrend); begrenzt wird er nur durch die Prüfung beim Kreditstart, und ein fehlgeschlagenes Lesen dieser Prüfung wird genannt, nie weggelassen. Im gestuften Regime wendet die Prüfung zusätzlich die Beleihungsobergrenze der Stufe an. Solange `getPartialFillEnabled` wahr ist, bleibt die Sicherheit, die ein Match nicht sperrt, für spätere Matches im Tresor und wird erst erstattet, wenn die Anfrage schließt (ihre verbleibende Kapazität fällt unter `amount`) oder `cancelOffer` läuft.

<a id="borrow-request-fill"></a>

### Borrow: Der Füllmodus einer Anfrage

`fillMode` ist 0 (Partial), 1 (AON) oder 2 (IOC) und ist nach dem Veröffentlichen unveränderlich. AON verlangt `amount` = `amountMax` (`AonRequiresSingleValueAmount`), IOC verlangt `expiresAt` ≠ 0 (`IocRequiresExpiry`); das Formular bietet keine der abgelehnten Formen an. Ein Post mit einer Größe sendet AON (#3520): `LibOfferMatch` hält jeden Match zwischen `amount` und dem Rest von `amountMax`, eine Größe wird also immer nur ganz gefüllt, und Partial und IOC werden nur mit einer Spanne angeboten. Beträge, Zinssatz und Sicherheit lassen sich bei einer offenen Anfrage über `setOfferAmount`, `setOfferRate`, `setOfferCollateral` und `modifyOffer` ändern, nie unter `amountFilled` oder `collateralAmountFilled`; diese App ruft sie noch nicht auf.

<a id="borrow-request-cadence"></a>

### Borrow: Der Zinsplan einer Anfrage

`periodicInterestCadence` reicht von 0 (None) bis 4 (Annual), mit Perioden von 30, 90, 180 und 365 Tagen. Das Formular bietet an, was `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)` zulässt; es führt die Regel aus, die `createOffer` durchsetzt, bewertet zu `amount` (dem kleinsten Ende einer Spanne). Jede Ablehnung wird aus ihren Revert-Daten genannt: `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid` oder `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. Die Zinsen einer Periode sind `principal × rate × intervalDays / (10000 × 365)`. Eine versäumte Periode kann jeder über `settlePeriodicInterest` begleichen, sobald die Nachfrist `getEffectiveGraceSeconds(intervalDays − 1)` verstrichen ist; dabei wird Sicherheit verkauft und der Kredit bleibt offen. Die Aktivierung des Keeper-Durchlaufs `periodicSettle` wird so gezeigt, wie der Fähigkeitsdienst sie meldet, standardmäßig unbekannt. Der Plan kann nach dem Veröffentlichen nicht geändert werden.

<a id="borrow-request-tariff"></a>

### Borrow: Der Full-Gebührentarif einer Anfrage

Die Zustimmung ist `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, vom Ersteller nach `createOffer` gesendet und mit `OfferAlreadyAccepted` abgelehnt, sobald ein Kreditgeber die Anfrage übernommen hat; `maxCStar` muss über null liegen (`FullTariffMaxCStarRequired`). Das Formular zeigt den Schalter aus `getFeeEntitlementConfig()` und den Tarif aus `quoteCStar(lendingAsset, principal, durationDays)`, bei einer Spanne zu `amount` und `amountMax`; die Obergrenze ist standardmäßig das Angebot zu `amountMax`. Bei jeder Annahme nimmt die Belastung `C*`, bewertet zum Kapital dieses Kredits, nur wenn der Schalter an ist, das Kapital einen Preis hat und liquide ist, `C* ≤ maxCStar` gilt und die freien VPFI des Tresors es decken (der Tresorsaldo, begrenzt durch `getTrackedVPFIBalance`, abzüglich aktiver Pfandrechte, über `getFreeBalance`); sonst revertiert sie mit `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` oder `FeeEntitlementTariffAboveAuth`, außer `allowDowngrade` lässt den Kredit ohne ihn eröffnen. Der Kreditgebührenrabatt des Kreditnehmers steigt um `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000), begrenzt auf `MAX_FEE_DISCOUNT_BPS` (5000). Die Prüfung blockiert eine Wahl, unter der jeder Kredit abgelehnt würde, und die Zustimmung wird durch erneutes Lesen von `getOffer` gemessen (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). Backstop-Kredite für nicht gefüllte Anfragen bietet diese App noch nicht an.

<a id="lend-start"></a>

### Lend: So funktioniert es

Lend nimmt eine Kreditanfrage (`offerType` 1) eines ERC-20 gegen ERC-20-Sicherheiten direkt an, mit `acceptOffer(offerId, terms, signature)`, gesendet vom Kreditgeber. In einer Transaktion wird das Kapital aus der Wallet des Kreditgebers, über eine Freigabe an den Diamond, in den Tresor des Kreditgebers gezogen; der Kreditnehmer erhält es abzüglich der Eröffnungsgebühr; die bereits im Tresor des Kreditnehmers liegenden Sicherheiten werden zu den Sicherheiten des Kredits; und `LoanInitiated` wird ausgegeben, mit einem Positions-NFT für Kreditgeber und Kreditnehmer. Ein Kreditangebot (`offerType` 0) wird auf derselben Seite veröffentlicht; NFT-Seiten folgen in einem späteren Update.

<a id="lend-offers"></a>

### Lend: Eine Anfrage auswählen

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` liefert die IDs der offenen Angebote des Paars. Für jedes liest die Seite `getOffer`, `getOfferState`, `getOfferLinkedLoanId` und, mit einer Wallet, `previewAccept(offerId, wallet)`, dessen `errorCode` die Ablehnung des Protokolls ist. Eine direkte Annahme bindet den `amount` der Anfrage (ihr Minimum) zu `interestRateBpsMax`, und der Beleihungswert ist `calculateLTV` auf diesen Betrag zu heutigen Preisen. Kreditgeberangebote, NFT-Seiten, die eigenen Anfragen des Lesers und Verkaufsvehikel für Kreditgeberpositionen (ein kreditnehmerseitiges Angebot mit einem `getOfferLinkedLoanId` ungleich null) werden gezählt, nicht gelistet. Die Reihenfolge: finanzierbar zuerst, dann Zinssatz absteigend, dann Betrag absteigend.

<a id="lend-review"></a>

### Lend: Prüfen und Signieren

Die Prüfung liest dasselbe wie bei Borrow (das Angebot, seinen Zustand, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, beide Klassen, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, den Tresor der Wallet, `previewOfferAcceptBlock` und die Gebührenrabatt-Zustimmung) plus `getTreasuryFeeBps`, und misst Saldo und Freigabe am verliehenen Vermögenswert, der Seite, die der Kreditgeber zahlt. Ein Fehlbetrag dort blockiert das Signieren, ebenso ein Verkaufsvehikel für eine Kreditgeberposition. Die Wallet signiert EIP-712 `AcceptTerms` (Domain `Vaipakam AcceptOffer`, Version 1), gibt genau das Kapital nur frei, wenn die Freigabe zu knapp ist (mit einem Schritt auf null zuerst bei einem Token, das eine Änderung zwischen zwei Werten ungleich null ablehnt), und `acceptOffer` wird simuliert und gesendet; eine von einem gestoppten Ablauf hinterlassene Freigabe wird wie bei Borrow zurückgesetzt. Das Ergebnis liest `LoanInitiated` für dieses Angebot, den `Transfer` des Kapitals aus der Wallet und den `Transfer` des Matcher-Anteils zurück.

<a id="lend-fee"></a>

### Lend: Die Gebühr und der Anteil des Protokolls

Die Gebühr ist `lifEstimate` aus `previewAccept` und gehört dem Kreditnehmer: `getLoanInitiationFeeBps` des Kapitals im verliehenen Vermögenswert, abgezogen von der Auszahlung an den Kreditnehmer, bei der Annahme gesenkt durch dessen Haltestufen-Rabatt und, wenn `creatorFull` gesetzt ist und die Belastung gelingt, durch den Bonus des Full-Tarifs. Der Anteil des Einreichers, `getLifMatcherFeeBps` der Gebühr, geht an den Absender, hier den Kreditgeber. Der Anteil des Protokolls an den Zinsen ist `getTreasuryFeeBps`, pro Kredit beim Eröffnen festgelegt (`treasuryFeeBpsAtInit`); der Haltestufen-Rabatt des Kreditgebers senkt ihn bei eingeschalteter Zustimmung, wenn Zinsen abgerechnet werden. Die Prüfung zeigt den heutigen Satz und den Anteil zu diesem Satz als Obergrenze.

<a id="lend-risks"></a>

### Lend: Risiken

Ein Kredit nach Ende seiner Nachfrist (`getEffectiveGraceSeconds` nach dem Fälligkeitsdatum, das pausierte Zeit verschiebt) kann von jedem für ausgefallen erklärt werden: liquide Sicherheiten werden für den Kreditgeber verkauft, illiquide unverändert übertragen. Sind beide Seiten liquide, kann der Kredit liquidiert werden, sobald der Health Factor unter 1 liegt, und der Verkauf zahlt den Kreditgeber zuerst. Eine illiquide Seite schließt die preisbasierte Liquidation aus, und bei einem Ausfall erhält der Kreditgeber alle Sicherheiten. `useFullTermInterest` setzt bei vorzeitiger Rückzahlung eine Untergrenze für die Zinsen; ohne es sind die Zinsen anteilig. Ein periodischer Zinsrhythmus begleicht eine verpasste Periode durch einen Zwangsverkauf von Sicherheiten an den Kreditgeber. Das Positions-NFT des Kreditgebers trägt den Anspruch: Wer es überträgt, überträgt den Kredit.

<a id="lend-offer"></a>

### Lend: Ein eigenes Angebot veröffentlichen

Ein Kreditangebot ist `createOffer` mit `offerType` 0, ERC-20 auf beiden Seiten, gesendet aus der Wallet des Kreditgebers. Es zieht `amountMax` des verliehenen Assets in den Vault des Kreditgebers, legt den Vault an, falls keiner existiert, und gibt `OfferCreated(offerId, creator, 0)` aus. Ein Kreditnehmer nimmt es mit `acceptOffer` an: Seine Sicherheit wird in seinen Vault gezogen, der Kapitalbetrag abzüglich der Gebühr geht in seine Wallet, und der Anteil des Absenders an der Gebühr geht an ihn als Absender. Solange `getPartialFillEnabled` true ist, kann `matchOffers` es außerdem mit der Anfrage eines Kreditnehmers paaren; ein Einzelwert-Kreditangebot verleiht dann seinen ganzen Betrag zu seinem Zinssatz, gegen mindestens seinen `collateralAmount`. `cancelOffer` steht dem Ersteller ab `MIN_OFFER_CANCEL_DELAY` (5 Minuten) nach der Erstellung offen und jedem, sobald das Angebot abgelaufen ist; der Betrag kehrt immer zum Ersteller zurück.

<a id="lend-offer-terms"></a>

### Lend: Die Bedingungen des Angebots

Ohne Teile ist ein Kreditangebot ein Einzelwert-Angebot: `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (die eine Sicherheit, die ein Kreditnehmer sperren muss), `fillMode` 1 (AON), sofern Advanced keinen anderen setzt (nächster Abschnitt), `periodicInterestCadence` 0, sofern Advanced keinen Plan setzt, `allowsPrepayListing` und `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true, und kein Full-Tarif, sofern Advanced ihn nicht wählt. Beträge werden exakt in Basiseinheiten geparst, und der Zinssatz beträgt höchstens 10.000 bps. `durationDays` ist durch das konfigurierte Maximum aus `getProtocolConfigBundle` begrenzt. `expiresAt` ist 0 (offen bis zur Stornierung) oder ein Zeitpunkt, der beim Öffnen der Prüfung vom neuesten Block aus festgelegt wird, höchstens `MAX_OFFER_EXPIRY_HORIZON` (365 Tage) voraus. `useFullTermInterest` ist standardmäßig true und `allowsPartialRepay` false.

<a id="rate-check"></a>

### Ihren Zinssatz mit aktuellen Krediten vergleichen

Beide Formulare lesen `/loans/recent` des Index für dasselbe Verleih-Asset, dasselbe Sicherheiten-Asset und dieselbe Laufzeit, ohne Verkaufsvehikel von Verleihern, und behalten die Kredite, die in den letzten 30 Tagen begonnen haben und einen vereinbarten Zinssatz tragen, den das Ledger des Index belegt (ein Kredit mit unbestätigten Bedingungen bleibt außen vor). Verglichen wird mit dem Median dieser Sätze, bei gerader Anzahl dem kleineren der beiden mittleren, damit kein Satz zwischen zwei vereinbarten erfunden wird. Ein Satz mehr als 5 Prozentpunkte (500 bps) davon entfernt ist eine Warnung mit Richtung: Ein Verleiher weit darunter oder ein Kreditnehmer weit darüber stellt das Angebot ein, das zuerst angenommen wird, wenn sich die Zinsen bewegen; in die andere Richtung bleibt es womöglich liegen. Innerhalb dieser Spanne ist es ein Hinweis mit Median und Anzahl. Ein Lesevorgang umfasst die neuesten 100 Kredite; erreicht er diese Grenze, sagt der Hinweis, dass nur die neuesten gelesen wurden. Eine Index-Antwort, die nicht auf das angefragte Paar und die Laufzeit beschränkt ist, wird abgelehnt statt verglichen, NFT-Sicherheiten werden nicht verglichen, und ein fehlgeschlagener Lesevorgang sagt das. Die Prüfung blockiert nie. Kredite auf dem Paar, deren Bedingungen der Index nicht bestätigt hat, gehören zu keiner Laufzeit; der Index zählt sie (`unplaced`), und das Formular nennt diese Zahl neben dem Vergleich, damit „keine bestätigten Kredite“ nie Kredite unbekannter Laufzeit verdeckt.

<a id="public-queue"></a>

### Netzwerke mit öffentlicher Warteschlange

Auf Ethereum, BNB Chain und Polygon (und dem BNB Testnet sowie Polygon Amoy) wartet eine gesendete Transaktion in einer öffentlichen Warteschlange, bevor sie aufgenommen wird, und wer diese Warteschlange beobachtet, auch Bots, kann sie sehen und zuerst handeln: ein Angebot annehmen, bevor Ihre Stornierung ankommt, oder auf einen Kredit reagieren, bevor Ihre Rückzahlung ankommt. Auf diesen Netzwerken sagt die Prüfung beim Einstellen, Annehmen oder Stornieren eines Angebots, beim Zurückzahlen und beim Nachlegen von Sicherheiten das deshalb, bevor sich Ihre Wallet öffnet. Manche Wallets können eine Transaktion stattdessen privat senden; sehen Sie in den Netzwerk- oder Sicherheitseinstellungen Ihrer Wallet nach. Die App kann diesen Weg nicht für Sie wählen, und der übliche Weg ändert nur, wer die Transaktion sieht, bevor sie ankommt. Base, Arbitrum und Optimism haben keine öffentliche Warteschlange, dort wird nichts angezeigt. Die Netzwerke sind eine Regel in der App (Ethereum 1, BNB Chain 56, BNB Testnet 97, Polygon 137, Polygon Amoy 80002), und ein Test schlägt fehl, wenn ein Netzwerk, das die App bedient, nicht entschieden ist. Der Hinweis erscheint in der Prüfung, vor der letzten Nachprüfung und der Wallet, nur für diese Vorgänge: Angebot einstellen, annehmen oder stornieren, volle und teilweise Rückzahlung und Sicherheiten nachlegen. Die Hilfe nennt keinen privaten Sendedienst, weil das Protokoll nicht prüfen kann, welchen Weg eine Wallet genommen hat, und die Wirkung der Transaktion auf beiden Wegen dieselbe ist.

<a id="lend-offer-parts"></a>

### Lend: Ein Angebot in Teilen

Teile senden `amount` (den kleinsten Teil, den ein Match verleihen darf) unter `amountMax` (dem ganzen Betrag, den `createOffer` in den Vault zieht); `collateralAmount` = `collateralAmountMax` bleibt die eine Anforderung, bezogen auf `amountMax` (sonst `LenderCollateralRangeNotAllowed`), und `interestRateBps` = `interestRateBpsMax`. Ein direktes `acceptOffer` eines Kreditangebots verleiht `amountMax` gegen `collateralAmount`, und nur solange `amountFilled` 0 ist (`OfferPartiallyFilled` nach einem Match). Solange `getPartialFillEnabled` true ist, verleiht `matchOffers` den größten Betrag, den beide Angebote akzeptieren (den kleineren der beiden Restbeträge, begrenzt auf das, was die Sicherheit des Kreditnehmers deckt und unter der Prüfung beim Kreditstart höchstens tragen darf), mindestens `amount`, zur Mitte der Zinsüberschneidung, gegen mindestens `collateralAmount × matchAmount ÷ amountMax` (abgerundet; die Sicherheitsspanne eines Kreditnehmers oder die Untergrenze der Prüfung beim Kreditstart kann ihn erhöhen). Fällt `amountMax − amountFilled` unter `amount`, wird der Rest an die Wallet des Kreditgebers ausgezahlt und das Angebot geschlossen (`OfferClosed`, Grund `Dust` oder `FullyFilled`). `cancelOffer` auf einem teilweise gefüllten Angebot überspringt die Wartezeit und gibt `amountMax − amountFilled` zurück. `fillMode` ist 0, 1 oder 2 wie bei einer Anfrage: AON verlangt `amount` = `amountMax`, IOC verlangt einen Ablauf, und er ändert sich nach dem Veröffentlichen nicht. Sind beide Seiten liquide, lehnt `createOffer` ein `collateralAmount` unter der Untergrenze bei `amountMax` mit `MinCollateralBelowFloor(provided, floor)` ab, deren Untergrenze die Prüfung zeigt. Es wird ein Beleihungswert gezeigt, `calculateLTV` bei (`amountMax`, `collateralAmount`): Ein Teil hat bis auf die Rundung dasselbe Verhältnis.

<a id="lend-offer-schedule"></a>

### Lend: Ein Zinsplan für ein Angebot

`periodicInterestCadence` eines Kreditangebots folgt der Regel der Anfrage (oben), wobei `previewCadenceAdmission` mit dem `amount` des Angebots bewertet wird: seinem kleinsten Teil, oder ohne Teile dem ganzen Betrag. `createOffer` lässt ihn dort über `requireCadenceAdmitted` zu, und die Eröffnung jedes Kredits prüft dessen eigenen Kreditbetrag erneut (`requireOriginationCadenceAdmitted`). Die Prüfung nennt die Zinsen einer Periode bei `amountMax` (eine direkte Übernahme) und mit Teilen bei `amount`. Eine versäumte Periode kann nach ihrer Nachfrist von jedem über `settlePeriodicInterest` abgewickelt werden: Sicherheit wird verkauft, um dem Kreditgeber die Zinsen dieser Periode zu zahlen, und der Kredit bleibt offen.

<a id="lend-offer-tariff"></a>

### Lend: Der Full-Gebührentarif für ein Angebot

Das Opt-in des Kreditgebers ist dasselbe `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, gesendet nach `createOffer`. Es wird mit `OfferAlreadyAccepted` abgelehnt, sobald das Angebot vollständig übernommen oder geschlossen ist; ein teilweise gematchtes Angebot nimmt es noch an, für seine späteren Kredite. Das Angebot wird mit `quoteCStar` bei `amount` und `amountMax` bepreist, und die Obergrenze ist standardmäßig das Angebot bei `amountMax`. Jeder Kredit wird einzeln gegen `maxCStar` geprüft, bepreist nach seinem Kreditbetrag, unter denselben Bedingungen wie eine Anfrage (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth` oder eine Herabstufung, wo erlaubt); die Prüfung des Kreditgebers nutzt das aktuelle freie VPFI des Tresors. Ein erhobener Tarif markiert den `lenderMode` des Kredits als Full, und jede Abrechnung der Ertragsgebühr des Kreditgebers addiert dann `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) zum Rabatt des Positionsinhabers auf den Anteil des Protokolls, begrenzt auf `MAX_FEE_DISCOUNT_BPS` (5000), mit oder ohne die Zustimmung zum Halte-Rabatt. Eine Verlängerung an Ort und Stelle (`repriceFeeEntitlementOnExtension`) setzt die Markierung für die neue Laufzeit auf None.

<a id="lend-offer-review"></a>

### Lend: Angebot prüfen und veröffentlichen

Die Prüfung simuliert `createOffer` aus der Wallet und liest beide Klassen, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, die maximale Laufzeit, den Vault der Wallet, deren Saldo und Freigabe auf dem verliehenen Asset (der Seite, die der Kreditgeber sperrt) und `calculateLTV`, wenn beide Seiten liquide sind; sie wird in jedem Block und direkt vor dem Öffnen der Wallet neu gelesen. Solange die Freigabe zu knapp ist, erreicht die Simulation nur den Einzug des Betrags, daher werden ein Einzugsfehler des Tokens, `VaultDepositFailed` (die Hülle des Protokolls um einen Einzug, der ohne Daten zurückgesetzt wurde, wie WETH es bei zu knapper Freigabe tut) oder ein Revert ohne Fehlernamen des Protokolls als zu erteilende Freigabe gezeigt, nach derselben Regel wie bei der Prüfung einer Anfrage; jeder andere benannte Protokollfehler ist eine Ablehnung. Nach einer exakten Freigabe wird `createOffer` erneut simuliert und gesendet; ein Abbruch nach der Freigabe setzt die Freigabe auf ihren früheren Wert zurück, wenn nichts anderes sie geändert hat. Das Ergebnis liest `OfferCreated` für diese Wallet mit `offerType` 0 und den `Transfer` des Betrags in den Vault.

<a id="lend-offer-fee"></a>

### Lend: Gebühren bei Ihrem Angebot

`createOffer` berechnet dem Kreditgeber nichts. Die gezeigte Gebühr ist die des Kreditnehmers: `getLoanInitiationFeeBps` des Betrags im verliehenen Asset, zum Satz, der gilt, wenn `acceptOffer` läuft, dann um den Haltestufen-Rabatt des Kreditnehmers gesenkt und von seiner Auszahlung abgezogen; die gezeigte Zahl nutzt den heutigen Satz. Der Anteil des Protokolls an den Zinsen ist `getTreasuryFeeBps`, je Kredit bei Eröffnung festgelegt (`treasuryFeeBpsAtInit`); der Haltestufen-Rabatt des Kreditgebers senkt ihn bei aktiver Einwilligung, wenn Zinsen abgerechnet werden. Die Prüfung zeigt den heutigen Satz und den Anteil zu diesem Satz als Obergrenze; ein fehlgeschlagenes Lesen von `getTreasuryFeeBps` wird genannt, und weder Anteil noch Rückfluss werden gezeigt.

<a id="positions"></a>

### Positions: Wie die Liste gelesen wird

Positions liest denselben Bestand wie Home über einen gemeinsamen Leser: `getUserPositionLoansPaginated` durchläuft die Positions-NFTs, die die Wallet hält, `getLoansBatch` lädt sie, und jede Seite ergibt sich aus dem gehaltenen Token (`lenderTokenId` oder `borrowerTokenId`), nie aus der bei der Entstehung erfassten Partei. Kredite mit Status Active oder FallbackPending sind laufend, mit den Fristen, dem Health Factor und der Gruppierung wie unter Home beschrieben. Jeder andere Status gilt als beendet, neueste Kredit-ID zuerst, benannt nach `LoanStatus`: Repaid, Defaulted, Settled oder InternalMatched (durch ein Matching geschlossen); eine Statusnummer, die die App nicht kennt, wird als Nummer angezeigt. Auszahlungen folgen der unter Home beschriebenen Claimables-Regel: Eine gehaltene Position auf einem beendeten Kredit, die die Wallet von jemand anderem erhalten hat, wird gezählt, nicht geraten.

Die Seitenauswahl filtert Auszahlungen, laufende und beendete Zeilen nach der gehaltenen Seite. „Nichts“ wird nur gesagt, wenn der Positions- und der Auszahlungsdurchlauf vollständig waren und das letzte Lesen gelang; ein an seiner Obergrenze gestoppter Durchlauf wird als unvollständig angegeben. Eine Zeile öffnet `/positions/<id>`, wo das Eignungsurteil jede Aktion entscheidet; die Liste sendet keine Transaktion.

Bei zwei oder mehr laufenden Zeilen nach der Seitenwahl steht eine Übersichtskarte an erster Stelle. Je Seite summiert sie `principal` je ERC-20-`principalAsset`, nie über Token hinweg (der Wertvergleich bleibt bei der Exposure-Zeile), und zählt Zeilen mit NFT-Kapital als Vermietungen. Der nächste Termin ist der früheste noch bevorstehende unter den Stufen, die auch die Zeilen verwenden: eine laufende oder bald fällige Fälligkeit (Rückzahlung) oder ein anstehender periodischer Checkpoint (Zinsen); bei Gleichstand gilt die niedrigere Kredit-ID. Kredite mit abgelaufener Karenzfrist (bei der Fälligkeit oder einem Checkpoint), Kredite in der Karenzfrist und FallbackPending-Kredite werden nach ID aufgeführt, jeder einmal unter seiner schwersten Stufe; Kredite mit nicht gelesenen Fristen werden gezählt. Zinsen sind ausgenommen. Die Karte nutzt nur den eigenen Lesevorgang der Liste und nennt einen unvollständigen Durchlauf. Eine Fälligkeit bei einer Zeile mit NFT-Kapital ist das Ende einer Vermietung (`rental-close`), nie eine Rückzahlung: Eine Vermietung endet mit ihrer vorausbezahlten Miete, daher nennt die Zusammenfassung sie so wie die Zeilen.

<a id="position"></a>

### Position: Wie ein Kredit gelesen wird

Die Seite liest `getLoanDetails(loanId)` und den Inhaber der Positions-NFTs von Kreditgeber und Kreditnehmer (`ownerOf` auf dem PositionNFT-Vertrag, den das Deployment verzeichnet, oder auf dem Diamond selbst bei einem Deployment vor #3205); die Rolle ist das Token, das die Wallet jetzt hält. Für einen laufenden Kredit (Active oder FallbackPending) liest sie `getLoanDeadlines` (Fälligkeit der aktuellen Laufzeit vor Pausengutschrift, die eine Verlängerung oder Schuldnerübergabe neu setzt, Pausengutschrift, Fälligkeit, Ende der Kulanzfrist), bei einem Zahlungsplan `previewPeriodicSettle` mit `getPeriodicInterestEnabled`, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor` und `calculateLTV`; für jeden Kredit `getLoanCollateralLien` und `isSaleVehicleLoan`. Jedes Lesen steht für sich: Ein fehlgeschlagenes wird als unbekannt angezeigt, nie als null, und kein Datum wird aus `startTime` und `durationDays` berechnet.

Für einen bepreisten Kredit liest sie auch `getInternalMatchConfigBundle`. Ist der interne Abgleich aktiv, wird ein Kredit, dessen Beleihungsquote von seiner Schwelle bis zur Schwelle plus `externalLiquidationPriorityWindowBps` reicht, für einen internen Abgleich zurückgehalten, und jede externe Liquidationsroute lehnt ab (`InternalMatchOnlyBand`); die Seite nennt dieses Band. Ein `loanInitiationFeeBpsAtInit` von 0 (ein Kredit, eröffnet bevor der Satz gespeichert wurde) wird als nicht erfasst gezeigt, ein `treasuryFeeBpsAtInit` von 0 als der 1-%-Altsatz, den die Abrechnung anwendet. Der Hinweis auf die Übergabe in Sachwerten gilt nur für einen ERC-20-Kredit: Eine NFT-Miete hat keine Sicherheit, und ihr Ausfall beendet die Nutzung des Mieters, zahlt die vorausbezahlte Miete abzüglich des Treasury-Anteils an den Kreditgeber und schickt den Puffer an die Treasury; das sagt die Seite stattdessen.

Sätze sind die Schnappschüsse des Kredits: `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (keiner bei einem Verkaufsvehikel) und `liquidationLtvBpsAtInit`. Ein Kredit mit einer illiquiden Seite (`principalLiquidity` oder `collateralLiquidity`) hat keine preisbasierte Messung: Das Protokoll verweigert dafür `calculateHealthFactor` und `calculateLTV`, und die Seite sagt das statt „unbekannt“. `principal` ist der noch geschuldete Betrag (eine Teilrückzahlung senkt ihn), und `interestRateBps` und `collateralAmount` können sich ebenfalls ändern, daher werden die Bedingungen so gezeigt, wie sie jetzt stehen; ein beendeter Kredit ohne Kapital im Datensatz sagt, ob ein interner Abgleich es gedeckt hat, und sonst nur, dass keines verzeichnet ist; eine NFT-Miete zeigt ihre Miete pro Tag (`principal`, in `prepayAsset`) und ob eine frühe Rückgabe weiterhin jeden verbleibenden Tag berechnet (`useFullTermInterest`). Ist `getPeriodicInterestEnabled` false, sagt die Seite, dass an einem Stichtag keine Sicherheit verkauft wird. `collateralLiquidity` Illiquid bei einem laufenden Kredit fügt die Sachwert-Warnung hinzu: Ein Ausfall überträgt die Sicherheit ohne Verkauf an den Kreditgeber. Ihre erste Transaktion ist die vollständige Rückzahlung, unten.

Für den Halter der Verleiher-Seite eines laufenden ERC-20-Kredits liest die Seite `lenderHoldDiscountView(loanId, wallet)`: den erfassten Eintrag (Halter, Stufe, Rabatt, Zeitpunkt), Stufe und Rabatt der Wallet jetzt sowie `holdBps`, den niedrigeren der beiden, wenn der Eintrag die Wallet nennt, sonst 0. Ein Diamond ohne diese View revertiert mit `FunctionDoesNotExist`, was die Seite als noch nicht gemeldet ausweist, nie als null. Im selben Block liest sie `getVPFIDiscountConsent` (der Hold-Anteil zählt nur, wenn es an ist), `getVPFIDiscountConfig` (wie der Rabatt gewährt wird) und `getFeeEntitlement(loanId).lenderMode` (Full fügt 10 Punkte innerhalb der 50-%-Obergrenze hinzu).

<a id="repay"></a>

### Vollständig zurückzahlen: Wie der Betrag bemessen wird

Die Aktion folgt einer Regel: `repayLoan` wird für einen Active- oder FallbackPending-ERC-20-Kredit jeder Wallet angeboten, die weder `loan.lender` noch `ownerOf(lenderTokenId)` ist (`LenderCannotRepayOwnLoan`), angehalten nach dem effektiven Ende der Kulanzfrist bei einem Active-Kredit (`RepaymentPastGracePeriod`) und solange die offene Route der Kreditnehmerposition `SwapToRepayIntent` ist (`positionRoute(borrowerTokenId)` auf dem Diamond, oder `positionLock(borrowerTokenId)` bei einem Deployment vor #3205). Ein Verkaufsangebot des Kreditgebers, eine Refinanzierungsanfrage und die globale Pause halten sie nicht an. Mieten werden hier noch nicht angeboten.

Die Prüfung liest `calculateRepaymentAmount(loanId)` am neuesten Block und erneut mit der auf `min(now + 30 Minuten, Ende der Kulanzfrist)` überschriebenen Blockzeit; dieselbe Anfrage liest die Blockzeit, unter der sie lief, und eine Verbindung, die die Überschreibung ignorierte, wird übergangen. Die Genehmigung ist genau die zweite Zahl, der Aufruf wird vor dem Öffnen der Wallet simuliert, und nach der Quittung wird der Status, in dem die Rückzahlung den Kredit ließ, aus ihrem `LoanRepaid`-Log gelesen (nicht am Block, an dem eine spätere Forderung ihn schon abgewickelt haben kann), die Zahlung aus den `Transfer`-Logs gemessen und die Allowance auf ihren vorherigen Wert zurückgesetzt, wenn sie die Genehmigung abzüglich der Zahlung liest. Eine höhere Allowance, auch eine unbegrenzte, wird ebenfalls auf diese Zahl gesenkt, da `repayLoan(loanId)` keinen Höchstbetrag und keine Frist kennt; das Zurücksetzen stellt danach den höheren Wert wieder her.

In der Nachfrist (`maturity ≤ now ≤ graceEnd` aus `getLoanDeadlines`) zählen die Prüfungen der vollen und der Teilrückzahlung auf der Chain-Uhr bis `graceEnd` herunter, geschätzt als der gelesene Block-Zeitstempel plus die seither vergangenen Sekunden. `repayLoan` und `repayPartial` brechen mit `RepaymentPastGracePeriod` ab, sobald `block.timestamp > graceEnd`, und ab dann ist `triggerDefault` für jeden offen, sodass eine späte Rückzahlung mit einem Ausfall um die Wette läuft. Bei einer Stunde oder weniger sagt die Uhr, jetzt zu senden. Sie stellt nur fest: Das vor dem Senden neu gelesene Urteil ist die Sperre, und eine Pause verschiebt `graceEnd` nach hinten. Block-Stuffing, um eine Rückzahlung über die Nachfrist hinaus aufzuhalten, ist im Bedrohungsmodell als akzeptiertes geringes Risiko festgehalten.

<a id="interest-schedule"></a>

### Zinsplan: Wie er gelesen wird

Für einen aktiven ERC-20-Kredit mit Kadenz liest die Karte `previewPeriodicSettle(loanId)` (Kadenz, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()` und `paused()` und nennt die gelesene Blockzeit. `expected` ist eine volle Periode beim aktuellen `principal` und `interestRateBps`; `periodEndAt` enthält die Pausengutschrift des Kredits.

`canSettleNow` der Vorschau beachtet weder den Schalter noch die Pause, daher setzt die Karte sie in der Reihenfolge von `settlePeriodicInterest` zusammen: ausgeschaltet (`PeriodicInterestDisabled`), pausiert (`whenNotPaused`), dann die Zeit der Periode (`PeriodicSettleNotDue` vor `graceEndsAt`). Ein Verkauf wird nur angekündigt, wenn der Schalter an und das Protokoll nicht pausiert ist; ein ungelesener Schalter oder eine ungelesene Pause wird als unbekannt angegeben. Bei einem Fehlbetrag von null rückt die Abrechnung nur den Stichtag vor. Die Scharfschaltung von `PERIODIC_SETTLE` beim Keeper wird der App nicht gemeldet, daher sagt die Karte, dass die Abrechnung jedem offensteht und der Stand des Keepers nicht bekannt ist.

<a id="partial-repay"></a>

### Einen Teil des Kredits zurückzahlen: Wie die Zahlung bemessen wird

`repayPartial(loanId, amount)` nimmt `amount` an Kapital plus die seit `interestAccrualStart` aufgelaufenen Zinsen (abzüglich periodischer Gutschriften). Es zahlt die Zinsen zuerst an frühere Inhaber, denen aus der Zeit vor einem Verkauf noch Zinsen zustehen (`paySellersFirst`), dann an den aktuellen Inhaber der Kreditgeberposition, wobei der Anteil der Treasury abgezogen wird (bei einem Inhaber, den das Protokoll einfrieren muss, wird sein Anteil stattdessen gesperrt im Kreditgeber-Vault hinterlegt, `freezeOrPayActiveLenderFromPayer`); es senkt `principal`, startet die Zinsuhr neu und schreibt den Betrag der laufenden Periode gut; die Fälligkeit bewegt sich nie. Es lehnt ab nach dem Ende der Nachfrist, unter `principal × minPartialBps / 10000` (`getAssetRiskParams`), bei dem gesamten Kapital oder mehr (`PartialWouldRetireFullPrincipal`), bei einem aktiven Intent-Commit oder einer Refinanzierungsanfrage und bei einem liquiden Kredit, wenn sich der Health Factor verschlechtern würde.

Keine View liefert die Zinsen der Teilzahlung vor dem Aufruf (#3299), daher nutzt die Prüfung `calculateRepaymentAmount` abzüglich `principal`, gelesen jetzt und für einen Zeitpunkt kurz danach. Das ist exakt für einen Pro-rata-Kredit bis zur Fälligkeit; mit `useFullTermInterest` enthält es den Mindestzins der Restlaufzeit und nach der Fälligkeit eine Verzugsgebühr, daher wird es als „höchstens“ gezeigt. Die Freigabe ist genau der Teil plus diese Obergrenze. Die Abschlusskarte misst `newPrincipal` aus dem eigenen `PartialRepaid`-Log der Zahlung (nicht `principal` am Block, den eine spätere Transaktion dort verändern kann), den Abfluss aus der Wallet und danach `previewPeriodicSettle`. Die Überprüfung lehnt die Wallet nur ab, wenn ihr der Teilbetrag fehlt oder der Teilbetrag plus ein exakter Zinsbetrag; übersteigt nur der obere Wert ihr Guthaben, entscheidet der Probelauf unmittelbar vor dem Senden der Zahlung.

<a id="add-collateral"></a>

### Sicherheiten hinzufügen: Was geprüft wird

`addCollateral(loanId, amount)` zieht genau `amount` des eigenen Sicherheiten-Tokens des Kredits vom Aufrufer in den Tresor des Kreditnehmers, erhöht `collateralAmount` und das Sicherheitenpfandrecht und emittiert `CollateralAdded` mit neuem Health Factor und LTV. Es lehnt einen laufenden Swap-to-Repay-Commit ab, einen anderen Aufrufer als `ownerOf(borrowerTokenId)`, einen Kredit, der weder Active noch FallbackPending ist, eine Miete, einen pausierten Sicherheiten-Token (`isAssetPaused`) und Sicherheiten, die `checkLiquidity` nicht als Liquid meldet. Es trägt kein `whenNotPaused`. Die Einzahlung geht in den Vault des vermerkten `loan.borrower`: Ein Active-Kredit konsolidiert eine übertragene Position zuerst auf den Inhaber (`consolidateToHolder`), also ist es dessen Vault; ein FallbackPending-Kredit wird erst nach der Heilung konsolidiert, daher nennt die Überprüfung den vermerkten Vault. Die hinzugefügten Token zählen in `collateralAmount`, das Liquidation und Ausfall aufbrauchen, und die Überprüfung sagt das.

Die App liest diese Eingaben, beide Asset-Prüfungen live statt aus der Eröffnungsklasse des Kredits, und der Testlauf hat das letzte Wort des Protokolls. Keine View liefert den Health Factor nach einer Aufstockung, daher nennt die Prüfung `calculateHealthFactor` und `calculateLTV` jetzt, und die Abschlusskarte liest die neuen Werte aus dem `CollateralAdded`-Log der Transaktion. Bei einem FallbackPending-Kredit heilt die Aufstockung ihn, wenn der neue Health Factor das Minimum des Kredits erreicht und der LTV innerhalb seiner Eröffnungsgrenze liegt; die Abschlusskarte prüft auf `LoanCuredFromFallback`. Eine bestehende Genehmigung in Höhe des Betrags oder darüber bleibt unverändert, da genau der Betrag gezogen wird; eine kleinere wird auf genau den Betrag erhöht und zurückgesetzt, falls die Aufstockung nicht durchgeht.

<a id="take-back-collateral"></a>

### Sicherheiten zurücknehmen: Was geprüft wird

`partialWithdrawCollateral(loanId, amount)` sendet `amount` der Sicherheit aus dem Vault des Kreditnehmers an die Wallet des Aufrufers, senkt `collateralAmount` und das Sicherungsrecht und emittiert `PartialCollateralWithdrawn` mit neuem Health Factor und LTV. Sie trägt `whenNotPaused` und lehnt der Reihe nach ab: einen sanktionierten Aufrufer, einen aktiven Swap-to-Repay-Commit, eine aktive Refinanzierungsanfrage (`RefinanceRequestOpen`), ein verknüpftes Verkaufsangebot (`SaleListingActive`), einen anderen Aufrufer als `ownerOf(borrowerTokenId)`, einen Kredit, der nicht Active ist, einen Betrag über der Sicherheit, eine Sicherheit, die `checkLiquidity` nicht als Liquid meldet, und ein Ergebnis unter dem Mindest-Health-Factor oder über dem LTV-Deckel bei Eröffnung.

Das Formular prüft den Betrag gegen `calculateMaxWithdrawable`, das für einen nicht aktiven Kredit oder eine illiquide Sicherheit null ist und mit auflaufenden Zinsen sinkt. Keine View zeigt ein verknüpftes Verkaufsangebot, daher führt die Prüfung die Entnahme als Probelauf aus und nennt diese Ablehnung; das Senden führt sie erneut aus. Die Abschlusskarte liest die verbleibende Sicherheit und die neuen Werte aus dem `PartialCollateralWithdrawn`-Log der Transaktion und den erhaltenen Betrag aus dem `Transfer` des Tokens an die Wallet. Bei einem Aufrufer im geschützten Kontomodus stellt das Auszahlungs-Gate des Vaults die Auszahlung für die Verzögerung des Kontos in die Warteschlange (`PayoutQueued`), statt sie zu zahlen; daher liest die Überprüfung `getProtectedAccount` und die Abschlusskarte dieses Log.

<a id="collect-a-payout"></a>

### Eine Auszahlung abholen: Was geprüft wird

`claimAsLender(loanId)` und `claimAsBorrower(loanId)` tragen `whenNotPaused` und zahlen aus dem Vault der für die Seite erfassten Partei (`loan.lender` / `loan.borrower`) an den Aufrufer, der `ownerOf` des Positions-Tokens dieser Seite sein muss. Der Kreditgeber kann bei einem Repaid-, Defaulted-, FallbackPending- oder InternalMatched-Kredit abholen, der Kreditnehmer nur bei Repaid, Defaulted oder InternalMatched. Die Forderung des Kreditgebers lehnt eine bereits abgeholte Zeile (`AlreadyClaimed`) vor der Inhaberprüfung ab und eine Seite ohne Offenes (`NothingToClaim`) danach; eine Zeile, die ein erzwungener Abschluss mit null erfasst hat, läuft trotzdem und schließt die Position. Die Forderung des Kreditnehmers lehnt nur ab, wenn Sicherheiten- und Überschusszeile beide leer oder abgeholt sind, und zahlt jede nach ihrem eigenen Flag, daneben Sicherheiten, die noch unter dem Sicherungsrecht des Kredits in einem anderen Token stehen.

Die Prüfung liest `getClaimable` (die Kreditgeberzeile bereits abzüglich früherer Verkäufer, daneben `getSellersShareOfLenderClaim`), `getBorrowerSurplusClaim` und `getLoanCollateralLien` und führt die Forderung als Probelauf aus, der auch die Sanktionsprüfungen anwendet. Die Liste folgt dem Positions-Token: `getUserDashboardClaimables` listet die Forderungen der erfassten Partei, daher bleibt eine gelistete Zeile nur, solange die Wallet diese Seite hält, und bei einer gehaltenen Position auf einem beendeten Kredit, die von jemand anderem stammt, wird die Forderung direkt gelesen. Die Abschlusskarte liest `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed` und `LoanSettled` sowie die Token-Transfers an die Wallet; bei einem Aufrufer im geschützten Kontomodus liest sie `PayoutQueued` (eigener Vault des Kontos), `PayoutHeldInVault` (gesperrtes Konto oder volle Warteschlange) oder `PaymentCreditedToVault` (Vault einer anderen Partei). Bei einem FallbackPending-Kredit kann die Forderung des Kreditgebers einen internen Abgleich beim Abholen ausführen, der die Zeile neu schreibt; daher vergleicht die Abschlusskarte die Transfers mit dem eigenen Eintrag des Protokolls.

<a id="claim-everything"></a>

### Alles einfordern: Was geprüft wird

Der Stapel läuft über `multicall(calls)`, das jeden Aufruf per `delegatecall` im Protokoll selbst ausführt, sodass `msg.sender` Ihre Wallet bleibt und jeder Aufruf seine eigenen Regeln prüft. Er nimmt höchstens 30 Aufrufe, und die App sendet jeden mit `allowFailure`, sodass ein abgelehnter Aufruf allein zurückgesetzt wird und der Stapel weiterläuft. Die Aufrufe sind `claimAsLender` / `claimAsBorrower(loanId)`; `claimInteractionRewardsTo(Vault)`, das auch eine einbehaltene Belohnung freigibt, oder `claimHeldInteractionRewards(Vault)`, wenn die Belohnungsvorschau nicht abschließen kann, `getRewardSanctionsStatus` aber Deliver liest; `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)` für das `availableCapital` jedes Intents aus `getLenderIntentsByOwner`; `withdrawVPFIFromVault(amount)` für das `freeHolding` an VPFI; und `withdrawSalary(streamId)` für jeden Stream aus `getPayrollStream`, dessen Begünstigter die Wallet ist, bemessen mit `getWithdrawableSalary`. Eine Kreditgeberforderung auf einen FallbackPending-Kredit bleibt außen vor, weil ihr Abgleich beim Einfordern entscheidet, was sie zahlt. Die Prüfung führt den Stapel als Probelauf aus und liest `success` und die Revert-Daten jedes Aufrufs, lässt einen abgelehnten Aufruf mit seinem dekodierten Fehler weg und führt ihn beim Senden erneut aus. Die Abschlusskarte liest das eigene Ereignis jedes Aufrufs (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`); ein Aufruf ohne Ereignis wurde übersprungen. Token-Überweisungen an die Wallet und `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` im geschützten Modus werden pro Token über die eingezogenen Aufrufe summiert. Die Pause (`whenNotPaused` auf jedem Aufruf) und eine markierte Wallet stoppen den Stapel vor dem Signieren.

<a id="payout-queue"></a>

### Die Auszahlungswarteschlange: Was geprüft wird

Die Liste ist `getPendingPayoutIds(account)`, mit `getPendingPayout(id)` und `requestCode(id)` je Zeile; der Code wird von demselben gemeinsamen Renderer, den die Benachrichtigungen nutzen, als sechs Base32-Zeichen dargestellt, und die Zeilen sind nach `releaseAt` gegen den Zeitstempel des letzten Blocks geordnet, nicht nach der Uhr des Browsers. `releasePayout(id)` ist erlaubnisfrei und wird während einer Pause abgelehnt, bis `isEscapeOpen()` gilt. Eine wartende Zeile, deren Empfänger weder der Verwalter (das Konto oder, nach dem Ruhestand, sein Controller) ist noch auf `getAllowlist` steht, wird vor der Zeitprüfung storniert statt ausgezahlt; sonst muss die Zeile fällig, das Konto entsperrt (`ProtectedVaultLocked`) und, solange `requireCosign` aktiv ist, mitunterzeichnet sein (`CosignRequired`), und der Empfänger wird erneut geprüft. `cancelPayout(id)` steht dem Verwalter oder einem Unterzeichner zu (`NotManagerOrSigner`), funktioniert auch während einer Pause und schreibt den Betrag dem Einlagenbuch gut, sodass er erneut abgehoben werden kann. `cosignPayout(id)` steht einem Unterzeichner aus `getProtectedSigners` zu (`NotSigner`); die App bietet es nur an, solange das Konto es verlangt und die Zeile noch nicht mitunterzeichnet ist. Jede Aktion läuft in der Prüfung als Probelauf und beim Senden erneut. Die Abschlusskarte liest `PayoutReleased` (den Betrag und das vom Protokoll gemessene `delivered`), `PayoutCancelled` und `PayoutCosigned` für diese ID. Ob der `protectedAccount`-Durchlauf des Keepers fällige Zeilen freigibt, ist die Antwort des Capability-Dienstes, standardmäßig unbekannt. Eine Sperre storniert jede wartende Zeile.

<a id="seller-interest"></a>

### Zinsen aus einer verkauften Position: Was geprüft wird

Ein Verkauf hält die verdienten, unbezahlten Zinsen des Verkäufers als Anspruch fest: `getInterestLedger(loanId)` listet die offenen Ansprüche, den ältesten zuerst, jeweils mit dem Bruttobetrag. `claimAsSeller(loanId)` trägt `whenNotPaused` und die Sanktionsprüfung. Auf einem Repaid-, Defaulted-, Settled- oder InternalMatched-Kredit mit offenen Ansprüchen teilt es zuerst die Rückflüsse des Kreditgebers auf (`getSellersShareOfLenderClaim`), zahlt jeden Anspruch bis zu seinem Nettobetrag (brutto abzüglich des Anteils `treasuryFeeBpsAtInit` des Kredits, abgerundet; die Legacy-1 % dort, wo der Kredit keinen festhielt) und schließt sie alle; ein FallbackPending-Kredit teilt nicht auf. Danach hebt es `getSellerInterestHeld(loanId, seller, asset)` für das Kapital-Token und, wo abweichend, für das Token des Kreditgeberanspruchs vom eigenen Vault des Verkäufers an seine Wallet ab und verweigert mit `NothingToClaimAsSeller`, wenn das null ist. Die App listet Kredite aus den Index-Aktivitäten, die unter der Wallet als Verkäufer abgelegt sind (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`); die Suche per Nummer liest allein die Chain. Im Kapital-Token leitet die Prüfung den Anteil der Wallet exakt aus dem Anteil ab; in einem anderen Token wird nach Wert geteilt und als beim Ausführen entschieden angegeben. Die Abhebung läuft in der Prüfung als Probelauf und beim Senden erneut. Die Abschlusskarte liest `SellerInterestClaimClosed` (gezahlt, gutgeschrieben, voll bezahlt) und `SellerInterestWithdrawn`, dazu `PayoutQueued` oder `PayoutHeldInVault`, wo der Schutzmodus die Zahlung einreihte oder behielt.

<a id="frozen-proceeds"></a>

### Eingefrorene Auszahlungen: Was geprüft wird

Die App liest `getSanctionsOracle` (null bedeutet kein Screening auf dieser Chain), `sanctionsStatus(wallet)` (Clean, Flagged oder Unavailable, wenn das Screening revertiert) und `isSanctionsConfirmedFlagged(wallet)`, das Register, das `refreshSanctionsFlag` aus einer eindeutigen Abfrage abgleicht. Flagged, oder Unavailable bei registrierter Wallet, gilt als eingefroren; Unavailable ohne Registrierung nicht. `claimAsLender` und `claimAsBorrower` prüfen den Aufrufer nach `whenNotPaused` und lassen einen Ausfall durch; eine Seite, deren Auszahlung das Protokoll für eine erfasste Partei eingefroren hat, wird fail-closed freigegeben und revertiert mit `SanctionedAddress` oder `SanctionsOracleUnavailable`, bis diese Partei Clean liest, gleich wer die Position dann hält. Das Protokoll bietet keine Abfrage dieser erfassten Partei, daher stützt sich die App dort auf den Probelauf und nennt dessen Ablehnung mit denselben Worten. `claimAsSeller` lehnt einen markierten Verkäufer ab, und während eines Ausfalls einen registrierten. Solange ein Kredit läuft, erhöht ein für einen markierten Inhaber geparkter Kreditgeberanteil `heldForLender` in `getClaimable(loanId, true)`, reserviert im Tresor des gespeicherten Kreditgebers, bis der Claim des Kreditgebers ihn auszahlt. Die Rückzahlung bleibt für einen markierten Kreditnehmer offen; das Hinzufügen von Sicherheiten nicht.

<a id="extension-reserves"></a>

### Verlängerungsreserven: Was geprüft wird

`fundExtendReserve(loanId, amount)` zahlt den Hauptsummen-Token des Kredits aus der Wallet des Inhabers der Kreditnehmerposition in dessen eigenen Tresor ein und reserviert ihn für diesen Kredit. Sie trägt `whenNotPaused` und das Sanktions-Screening und wird abgelehnt, sofern der Kredit nicht Active ist, ein ERC-20-Kredit, ohne periodischen Rhythmus. `getExtendFunding(loanId, holder)` liefert den Token, `reserved`, das übrige freie Guthaben des Inhabers und was eine Verlängerung jetzt und am Ende des Fensters berechnen würde; eine Verlängerung belastet nur den Tresor des aktuellen Inhabers, zuerst die Reserve. `withdrawExtendReserve(account, loanId, amount)` trägt `whenNotPaused`, verlangt, dass der Aufrufer der Verwalter des Kontos ist (seine eigene Wallet oder nach einem Ersatz sein Controller), prüft den Aufrufer (bei einem Ausfall offen) und bricht mit `ExtendReserveInsufficient` ab, wenn mehr als reserviert verlangt wird; sie ist offen, gleich in welchem Zustand der Kredit ist. Die App listet Kredite aus der Aktivität des Index, die unter der Wallet abgelegt ist (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`); die Suche über die Nummer liest allein die Chain. Sie hebt die ganze Reserve ab, die die Prüfung gelesen hat, führt den Aufruf in der Prüfung und beim Senden erneut als Probelauf aus, und die Abschlusskarte liest `ExtendReserveWithdrawn` (den Betrag und was reserviert bleibt), mit `PayoutQueued` oder `PayoutHeldInVault`, wo der geschützte Modus die Zahlung eingereiht oder behalten hat.

<a id="vault-holdings"></a>

### Ihr Tresor: was gelesen wird

Der Tresor ist `VaultFactoryFacet.getUserVaultAddress(wallet)`; `getOrCreateUserVault(wallet)` legt ihn an (Sanktionsprüfung Stufe 1, kein Pausen-Gate), und die Abschlusskarte liest `UserVaultCreated`. Je Vermögenswert, in einem Block: der eigene Saldo des Tresors (ERC-20 `balanceOf`, ERC-721 `ownerOf`, ERC-1155 `balanceOf`), `getTrackedHolding`, `withdrawableNow` und `untrackedHolding`. „Im Tresor“ ist der kleinere Wert aus Saldo und erfasstem Bestand; „Jetzt frei abhebbar“ ist `withdrawableNow` wie zurückgegeben (der Einzahlungsbestand, begrenzt durch `freeHolding`: erfasst minus Pfandrechte minus die Zweckbindung des Schutzmodus); „Von Ihren Positionen gehalten“ ist der gezählte Wert minus diesen. Die Vermögenswerte stammen aus `getDepositoryAssets(wallet, offset, limit)`, seitenweise bis zur zurückgegebenen Gesamtzahl gelesen (eine leere Seite davor gilt als unvollständig), der Standard jedes gelisteten Vertrags per ERC-165 gelesen, dazu die Seiten (verliehener Vermögenswert, Sicherheit, die vorausbezahlte Mietgebühr) jedes Kredits in `getUserLoansPaginated(wallet)` und jedes Kredits, dessen Position die Wallet hält, jeweils per `getLoanDetails` am selben Block gelesen, und die jedes Angebots, das die Wallet je erstellt hat, aus `getUserOffersPaginated(wallet)`, jeweils per `getOffer` gelesen (die Hinterlegung eines Angebots bleibt im Vault seines Erstellers, auch nachdem sein Positions-NFT übertragen wurde). Hinzu kommt der verliehene Vermögenswert jedes stehenden Angebots aus `getLenderIntentsByOwner(wallet)`, auch stornierter: Das Finanzieren eines solchen Angebots legt diesen Vermögenswert ohne Eintrag im Einzahlungsdatensatz in den Vault. Der Datensatz führt keine NFT-Token-IDs, daher wird jede eingezahlte NFT-Sammlung in einem Hinweis genannt, und nur ein Token, das ein Kredit oder Angebot nennt, wird mit Zahlen gelistet. Staub ist ein gezählter Wert über null und unter 1e-11 eines ganzen Tokens.

<a id="vault-deposit"></a>

### In Ihren Tresor einzahlen

Die Einzahlung ist `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)`: kind 0 ist ERC-20, 1 ERC-721, 2 ERC-1155; die Token-ID ist 0 für einen ERC-20 und der Betrag 1 für einen ERC-721. Sie ist `whenNotPaused`, prüft den Aufrufer (Tier-1) und lehnt eine durch eine Ersetzung stillgelegte Wallet ab (`requireManager`). Die Prüfung liest an einem Block `getUserVaultAddress`, `paused`, den Sanktionsstatus, `getProtectedAccount(wallet)` sowie Saldo und Freigabe der Wallet; eine ungelesene Pause, Prüfung oder Stilllegung wird genannt, und der Probelauf entscheidet. Die Freigabe ist ein exaktes ERC-20-`approve` (zwei Schritte, wenn der Token zuerst auf null muss), `approve(diamond, tokenId)` für einen ERC-721 oder `setApprovalForAll(diamond, true)` für einen ERC-1155, nach der Einzahlung zurückgenommen, sofern sie nicht schon bestand. Der Probelauf läuft nach der Freigabe; ein ERC-20 wird mit Prüfung auf vollständige Ankunft gezogen (`LibDelivery.pullExact`), daher scheitert ein Token mit Transfergebühr. Die Abschlusskarte liest `VaultDeposited(account, asset, kind, tokenId, amount)` und die eigenen Transfer-Logs des Tokens in den Tresor. Für diese Einzahlung gibt es keinen Permit-Weg. Aus `getProtectedAccount(wallet)` behält die Prüfung außerdem `enabled`, `locked`, `delaySeconds` und `requireCosign`, und der Beleg nennt, wie die Einzahlung den Tresor wieder verlassen kann: sofort, nach der Verzögerung (mit einem Zweitunterzeichner, wo verlangt) oder nicht, solange das Konto gesperrt ist, was `depositToVault` nicht ablehnt. Die letzte Prüfung vor dem Signieren liest `hasAcceptedCurrentTerms` erneut und lehnt eine nicht akzeptierte Version ab.

<a id="vault-withdraw"></a>

### Aus Ihrem Tresor abheben

Die Abhebung ist `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)`, mit `account` und `recipient` beide gleich der verbundenen Wallet. Sie ist durch `withdrawableNow(account, kind, asset, tokenId)` begrenzt (sonst `AmountExceedsFree`), prüft `requireManager(account)`, prüft den Aufrufer (Tier-1) und den Empfänger und wird während einer Pause abgelehnt, außer das Konto ist geschützt und `isEscapeOpen` ist wahr. Die Prüfung liest in einem Block `getUserVaultAddress`, `paused`, `isEscapeOpen`, den Sanktionsstatus, `getProtectedAccount(wallet)` und `withdrawableNow` und führt den Aufruf dann als Probelauf aus. Ohne geschützten Modus zahlen die Tresor-Routen sofort an die Wallet; mit ihm stellt `LibProtectedAccount.queuePayout` die Auszahlung für `delaySeconds` in die Warteschlange und lehnt `ProtectedVaultLocked`, `RecipientNotAllowlisted` und `TooManyPendingRows` ab. Die Abschlusskarte liest `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`, `PayoutQueued` und die eigenen Transfer-Logs des Tokens vom Tresor zur Wallet. Eine Sammlung, die das Einzahlungsverzeichnis ohne Token-IDs nennt, wird über die eingegebene Token-ID abgehoben; die Grenze des Formulars ist `withdrawableNow` für dieses Token, in jedem Block neu gelesen.

<a id="vault-safety"></a>

### Kontosicherheit

Die Karte liest in einem Block `getProtectedAccount(wallet)`, `getProtectedDelayBounds()`, `paused`, den Sanktionsstatus und `getPendingPayoutIds(wallet)`; ein Revert `FunctionDoesNotExist` gilt als nicht verfügbar. Einschalten ist `enableProtectedMode(delaySeconds, protectNfts)`: sofort wirksam, abgelehnt während einer Pause oder wenn der Modus schon an ist, die Verzögerung innerhalb der Grenzen (zwei bis fünf Tage), und es legt den Tresor an, falls keiner existiert. Jetzt sperren ist `lockVault(wallet)`: auch während einer Pause offen, storniert jede wartende Zeile (`PayoutCancelled`), verwirft jede ausstehende Änderung und macht einen vom Verwalter vorgeschlagenen Ersatz ungültig. Entsperren beantragen ist `requestUnlock(wallet)`, abgelehnt während einer Pause oder vor `cooldownUntil`, und setzt `pendingUnlockAt` auf jetzt plus `delaySeconds`. Fällige Änderungen anwenden ist `finalizeSettingChanges(wallet)` und wendet jede fällige Änderung auf einmal an; das Ausschalten wartet, bis keine Zeile mehr offen ist (`PendingRowsExist`). Jede Aktion wird bei der Prüfung und noch einmal vor dem Öffnen der Wallet trocken ausgeführt, und die Abschlusskarte liest `ProtectedModeEnabled`, `VaultLocked`, `PayoutCancelled`, `SettingChangeRequested` und `SettingChangeApplied` aus den Logs des Diamond.

<a id="vault-escape"></a>

### Wenn das Protokoll pausiert ist

Der Hinweis liest in einem Block `paused`, `VaultPayoutFacet.isEscapeOpen`, `escapeOpensAt` (Beginn der manuellen Pause plus die Notausgangsfrist, mit der sie begann; null, wenn keine gilt oder der Diamond nie gestartet wurde) und `getProtectedAccount(wallet)` und zählt gegen die Blockzeit herunter. Pausiert mit geschlossenem Notausgang revertiert `withdrawFromVault` mit `EnforcedPause`, und die Prüfung sagt, dass die Pause es stoppt. Sobald `isEscapeOpen` wahr ist, nutzt ein geschütztes Konto weiter `withdrawFromVault`, das weiter in die Warteschlange stellt; das Abheben jeder anderen Wallet ruft `escapeWithdraw(kind, asset, tokenId, amount)` auf, das ein geschütztes Konto ablehnt (`EscapeNotForProtected`), einen gesperrten Empfänger ablehnt, durch den eigenen Einlagenbestand der Wallet und den freien Wert begrenzt ist und an den Aufrufer zahlt. Die Abschlusskarte liest `EscapeWithdrawal(account, asset, tokenId, amount)` und die Übertragung des Tokens selbst vom Tresor an die Wallet. Ist die Pause, der Notausgang oder bei offenem Notausgang der Modus ungelesen, wird keine Abhebung gesendet.

<a id="protection-addresses"></a>

### Gespeicherte Adressen

Das Adressbuch liegt in `localStorage` je Chain-ID und Wallet, nie on-chain. Eine Wallet kommt hinzu, nachdem sie `AddressControl{account, destination, purpose, nonce, issuedAt}` in der Domain `{name: 'Vaipakam Address Check', version: '1', chainId, verifyingContract: Diamond}` signiert hat, mit einer zufälligen 32-Byte-Nonce und sieben Tagen Laufzeit. Die Anfrage reist als `/protection?prove=<code>`. Die Signierseite lehnt ein Netzwerk oder einen Diamond ab, den diese App nicht bedient, ebenso eine verfallene Anfrage, und signiert nur, wenn das verbundene Konto genau diese Adresse auf dieser Chain ist. Die eingefügte Antwort wird mit `verifyTypedData` über die eigene Leseverbindung der verbundenen Wallet geprüft, sodass eine Smart Wallet über ERC-1271 antwortet, und nur gespeichert, wenn sie genau diese Anfrage beantwortet. Das Adressfeld zeigt die volle Adresse mit abgesetzten ersten und letzten Zeichen, lehnt eine fehlerhafte EIP-55-Prüfsumme ab und lehnt ohne Ausnahme jede Adresse ab, deren erste drei und letzte drei Hex-Ziffern einer bereits genutzten gleichen (die eigene Adresse, gespeicherte und wartende Einträge, aktive und wartende Ziele, geschützte Unterzeichner, freigegebene Keeper und der Keeper des Netzwerks), während der Rest abweicht. Eine neue Adresse braucht ein ausdrückliches Häkchen, das jede Änderung löscht.

<a id="protection-destinations"></a>

### Auszahlungsziele

Der Abschnitt liest in einem Block `getProtectedAccount`, `getAllowlist`, `getPendingAllowlistAdditions` (jede Anfrage mit ihrem `maturesAt`), `getProtectedSigners`, `paused` und die je Empfänger gereihten Auszahlungen aus `getPendingPayoutIds`. Eine Anfrage wartet vor `maturesAt`, ist bereit bis `maturesAt + delay` und danach verfallen, gemessen an der Blockzeit plus den seither vergangenen Sekunden. Die vier Änderungen sind `addAllowlisted`, `cancelAddAllowlisted`, `finalizeAddAllowlisted` und `removeAllowlisted`, jeweils mit `(account, destination)`. Die Prüfung wird in einem Block gelesen und lehnt vor der Wallet ab, was die Facet ablehnen würde: eine Pause oder Sperre (beim Hinzufügen und Aktivieren), die eigene Wallet, eine bereits aktive oder wartende Adresse, schon fünf Ziele oder fünf Anfragen, eine markierte Adresse, eine noch nicht fällige oder verfallene Anfrage. Jeder Aufruf wird simuliert, direkt vor dem Öffnen der Wallet erneut geprüft und an seinem eigenen Log `AllowlistAddRequested`, `AllowlistAddCancelled`, `AllowlistAdded` oder `AllowlistRemoved` gemessen; ein Entfernen zählt auch die dadurch ausgelösten `PayoutCancelled`-Logs.

<a id="protection-signers"></a>

### Zweitsignierer

Der Abschnitt liest in einem Block `getProtectedAccount` (mit `requireCosign` und `pendingCosignOffAt`), `getProtectedSigners` mit `getSignerChange` für das `removeAt` jedes Signierers, `getPendingSignerAdditions` (jede angefragte Wallet mit `maturesAt` und `accepted`) und `paused`. Die Änderungen sind `addSigner`, `cancelAddSigner`, `finalizeAddSigner`, `requestRemoveSigner`, `cancelRemoveSigner` und `finalizeRemoveSigner`, jeweils mit `(account, signer)`; `acceptSignerRole(account)`, von der angefragten Wallet über den Annahme-Link (`/protection?signer=<account>&chain=<id>`) gesendet; und `setRequireCosign(account, on)`. Die Prüfung lehnt vor der Wallet ab, was die Facet ablehnen würde: eine Pause (außer beim Abbrechen), eine Sperre oder die Abkühlzeit einer neuen Haupt-Wallet (beim Anfragen, Entfernen und Ausschalten der Mitsignatur), Ihre eigene Wallet, eine Wallet, die schon Signierer oder schon angefragt ist, eine verfallene, noch nicht abgebrochene Anfrage, bereits fünf Signierer oder fünf Anfragen, eine angefragte Wallet, die nicht angenommen hat, eine nicht abgelaufene Wartezeit oder ein verstrichenes Fenster sowie eine Mitsignatur ohne Signierer. Jeder Aufruf wird probeweise ausgeführt, kurz vor dem Öffnen der Wallet erneut geprüft und aus seinem eigenen Log `SignerAddRequested`, `SignerAccepted`, `SignerAddCancelled`, `SignerAdded`, `SignerRemoveRequested`, `SignerRemoveCancelled`, `SignerRemoved`, `CosignRequirementSet` oder `SettingChangeRequested` gemessen. Wartende angefragte Wallets gehören zur Liste bekannter Adressen der Adressprüfung.

<a id="my-offers"></a>

### Ihre Angebote

Die Liste ist die Vereinigung von `getUserOffersPaginated(wallet)` (dem Index je Ersteller, der eine stornierte ID behält) und `getUserPositionOffersPaginated(wallet)` (den Angeboten, deren Positions-Token die Wallet hält), gelesen in Stapeln von höchstens 250 über `MetricsDashboardFacet.getOffersWithState`, das Position für Position antwortet. Jede Zeile wird der ID zugeordnet, nach der gefragt wurde: Bei einem ohne Erfüllung stornierten Angebot ist der Datensatz gelöscht, die Ansicht meldet ID 0 mit dem abgeleiteten Status Storniert, und die Zeile zeigt keine Bedingungen statt rekonstruierter. Ein nach teilweiser Erfüllung storniertes Angebot behält seinen Datensatz mit gesetztem `accepted` und gilt als erfüllt. Die Filterzahlen werden über die gelesenen Zeilen gebildet; konnte einer der Indizes nicht bis zum Ende gelesen werden, sagt die Seite, dass die Liste unvollständig sein kann.

<a id="offer-book"></a>

### Das Orderbuch

Das Buch liest `GET /offers/active?chainId&limit=50&before=<offerId>` des Indexers, das neueste zuerst nach Angebots-ID, seitenweise über `nextBefore`. Der Indexer behält ein verfallenes Angebot als `active` (der Ablauf ist on-chain träge), daher wird eine Zeile, deren `expiresAt` verstrichen ist, als abgelaufen markiert. `isSaleVehicle`, `isOffsetVehicle` und `refinanceTargetLoanId` (null = nicht gelesen) markieren die Art, `positionFlow.movedSinceOpened` eine bewegte gebundene Position (#3205). Jedes Feld wird exakt geparst; eine Zeile, die scheitert, zählt als ungelesen. Der Reiter ist `assetType` (0 = ein ERC-20-Kredit, sonst eine Miete), die Seite `offerType`. Die Abfrage wird durch die Push-Schiene invalidiert und alle 60 s neu gelesen, solange sie sichtbar ist; ein Indexfehler wird genannt, nie ein leeres Buch. Das Buch wird erst abgefragt, wenn eine Wallet in einem unterstützten Netzwerk verbunden ist; vorher bittet die Seite darum.

<a id="offer-detail"></a>

### Die Seite eines Angebots

`/offers/:id` liest an einem Block `OfferCancelFacet.getOffer(id)`, `MetricsFacet.getOfferState(id)` und `getOfferLinkedLoanId(id)`, über die verbundene Wallet; vor dem Verbinden einer Wallet wird nichts gelesen. Ein Ersteller null bedeutet, dass der Datensatz gelöscht (eine Stornierung ohne Füllung) oder nie geschrieben wurde; das Protokoll führt keine Angebotszahl, daher sagt die Seite nicht, welches von beiden. Ein verknüpfter Kredit ungleich null markiert einen Kreditverkauf (ein Angebot eines Kreditnehmers) oder einen Offset (ein Angebot eines Kreditgebers); `refinanceTargetLoanId` eines Kreditnehmer-Angebots markiert eine Refinanzierungsanfrage. Die Annahme läuft über den gemeinsamen `acceptOffer`-Ablauf (signierte `AcceptTerms`, exakte Freigabe, Probelauf, gemessenes Ergebnis) unter einem eigenen Speicherschlüssel; Stornieren und Aufräumen laufen über den gemeinsamen `cancelOffer`-Ablauf. Mieten, NFT-Sicherheiten, Kreditverkäufe und Offsets verlinken die aktuelle App.

<a id="offer-cancel"></a>

### Ein Angebot stornieren

Die Prüfung liest in einem Block `getOffer(id)`, `getOffersWithState([id])`, `getOfferLinkedLoanId(id)`, `paused()` und das `getProtectedAccount` des Erstellers und führt dann einen Probelauf von `OfferCancelFacet.cancelOffer(id)` aus. Die Facette erlaubt dem Manager des Erstellers jederzeit zu stornieren und jedem, sobald `expiresAt` verstrichen ist; sie verweigert `OfferAlreadyAccepted`, `OfferAlreadyConsumedBySale` und `CancelCooldownActive`, solange ein Angebot mit `amountFilled == 0` jünger als 300 Sekunden und nicht abgelaufen ist, und sie ist `whenNotPaused`. Die Rückgabe wird nach den eigenen Zweigen der Facette bemessen: Ein ERC-20-Leihangebot gibt `(amountMax oder amount) - amountFilled` des Leihguts zurück; ein NFT-Leihangebot seinen Token oder seine ERC-1155-Menge; eine Kreditanfrage ihre ungenutzte Sicherheit `(collateralAmountMax oder collateralAmount) - collateralAmountFilled` oder ihr NFT, und nichts, wenn `refinanceCarryOver` die Sicherheit im Kredit hält; eine Mietanfrage `amount × durationDays` plus den Puffer zu `rentalBufferBpsAtCreate`. Ein über `getOfferLinkedLoanId` an einen Kredit gebundenes Angebot oder eine Mietanfrage mit gestempeltem Puffer null (das Protokoll nutzt dann seinen aktuellen Satz) wird vor dem Signieren nicht beziffert. Jede Rückgabe verlässt den Vault des Erstellers über die Vault-Auszahlung, daher reiht der geschützte Modus sie ein oder hält sie im Vault, solange das Konto gesperrt ist. Der Positions-Token wird stillgelegt. Die Abschlusskarte liest `OfferCanceled(offerId, creator)`, den Auszahlungsdatensatz des Protokolls für den Ersteller und den eigenen Transfer des Tokens an den Ersteller.

<a id="offers-price-guard"></a>

### Preisbewegungsschutz

Bei einem offenen Angebot eines ERC-20 gegen ERC-20-Sicherheiten kann der Ersteller auf der Seite des Angebots einen Preisbewegungsschutz setzen, ändern oder entfernen. Wenn er erfasst wird, hält das Protokoll die Orakelpreise beider Token fest; danach wird jede Annahme abgelehnt, solange sich das Verhältnis von Sicherheit zu Kapital um mehr als das Limit (0,5 % bis 50 %, in beide Richtungen) von diesem Niveau bewegt hat, solange sich das Paar gegenüber einer der letzten beiden stündlichen Preisprüfungen über die Ruhegrenze hinaus bewegt hat oder solange ein aktueller Preis oder eine dieser Prüfungen fehlt. Die Prüfung läuft bei der Kreditentstehung, deckt also eine direkte Annahme und ein Matching ab, und die Seite zeigt allen das Limit, wie weit sich das Verhältnis bewegt hat und ob eine Annahme jetzt möglich ist. Jeder darf die stündlichen Prüfungen schreiben, und der Keeper des Protokolls soll sie für die Assets offener geschützter Angebote schreiben; solange sie für beide Token fehlen, kann niemand das Angebot annehmen. Ein Schutz auf einem eingestellten Angebot schützt ab dem Block, in dem er landet, nicht davor; eine Änderung erfasst die Preise neu. Er bewegt nichts und ändert keine Bedingung. Er kann auch beim Einstellen in den erweiterten Optionen des Angebotsformulars aktiviert werden: Schutz und Angebot gehen in einer Transaktion, sodass das Angebot nie ungeschützt im Orderbuch steht, und ein Paar, dessen Preise nicht lesbar sind, lehnt beides ab.

<a id="risk-access"></a>

### Risk Access: Ihre Risikostufe

Der Schalter ist `getRiskAccessGateEnabled`. Welchen Schritt ein Ablauf braucht, ist die eigene Antwort des Protokolls: bei einer Annahme `previewOfferAcceptBlock` (1 = Stufe zu niedrig, 2 = Paarzustimmung, 3 = Bestätigung im strengen Modus, 4 = das illiquide Paar, das früher die Bestätigung der Annahme abdeckte; es sperrt wie 2, und eine Paarzustimmung hebt es auf), sobald `previewCreatorBlock` zeigt, dass der Kreditgeber nicht gesperrt ist; bei einer Anfrage `RiskTierTooLow`, `IlliquidPairNotConsented` oder `MidTierPairNotAcknowledged` aus dem Probelauf von `createOffer`. Der Schritt liest in einem Block `pairRequiredRiskLevel` für das Paar (`acceptMidTierAckPair` für ein Angebot), `getVaultRiskTier`, `getEffectiveRiskTier`, `getVaultRiskTierVersion` gegen `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` und `getRiskTierMutationNonce`, und für ein Paar `isPairConsentPending` mit `hasIlliquidPairConsent` oder `isMidTierAckPending` mit `midTierStrictBlocked`. Eine Anhebung ist `setVaultRiskTierChecked(level, nonce, termsVersion)` auf die niedrigste Stufe, die das Paar braucht, und wird ohne Änderung abgelehnt, wenn nach der Prüfung ein anderer Stufenwechsel oder eine Bedingungsänderung eingetroffen ist. Ein Paarschritt ist `setIlliquidPairConsent(pair, true)` oder `setMidTierPairAck(pair)`. Eine noch wartende Anhebung oder ein noch ausstehender Paarschritt wird nicht erneut angeboten. Kein Lesezugriff liefert, wann ein ausstehender Paarschritt wirksam wird; die Prüfung sagt daher, dass sie diese Zeit nicht lesen kann; nur die Abschlusskarte des Schritts selbst nennt sie, aus der Blockzeit des Belegs plus der Wartezeit. Das Ergebnis wird am Block des Belegs zurückgelesen.

<a id="terms-gate"></a>

### Die Abfrage der Nutzungsbedingungen

`getCurrentTos` liefert Version und Inhalts-Hash, die auf der Chain der Aktion gelten; Version 0 bedeutet keine, und nichts ist gesperrt. Eine Wallet, deren `hasAcceptedCurrentTerms` false ist, wird vor neuer Exposition gefragt, und die Abfrage verlinkt `/terms/v<N>`, die versionsfeste Seite, deren Text sich nie ändert. Das Akzeptieren ruft `acceptTerms(version, hash)` einmal auf. Bevor die Wallet öffnet, wird das Paar erneut gelesen: Eine neuere Version ersetzt die angezeigte, und eine Akzeptanz aus einem anderen Tab lässt die Aktion weiterlaufen. Ein fehlgeschlagener Lesevorgang heißt „nicht bestätigbar“, mit Wiederholung, nie „nicht akzeptiert“. Ausstiege sind nie gesperrt.

<a id="settings"></a>

### Einstellungen

Die Einstellungen sammeln, was du einmal festlegst. Modus und Design liegen im Speicher dieses Browsers für diese Website, die Sprache dort und im Cookie `vaipakam_lang`, das die Websites der Plattform teilen; das Sprachattribut der Seite selbst bleibt Englisch, bis eine Übersetzung erscheint. Die Zeile zu den Bedingungen liest `getCurrentTos` und die Zustimmung der Wallet im verbundenen Netzwerk: keine in Kraft, akzeptiert mit Version und Fingerabdruck des Texts, oder in Kraft und nicht akzeptiert, abgefragt bei der ersten geschützten Aktion. Ein fehlgeschlagenes Lesen heißt „konnte nicht bestätigt werden“, mit erneutem Versuch, nie „nicht akzeptiert“. Der Schalter für den Gebührenrabatt ist `setVPFIDiscountConsent`, derselbe Ablauf wie auf der Startseite. Dieser Build enthält keine Diagnoseerfassung. Der Browser speichert außerdem, welche Hinweise gesehen wurden, den Datensatz der Hinweiskanäle, die Zeit der letzten signierten Hinweisanfrage, das letzte Token-Paar, geschlossene Einstiegskarten und die letzte Verbindung des Wallet-Connectors; nie einen Schlüssel oder eine Signatur. Der Download schreibt eine JSON-Datei mit den eigenen Datensätzen der App (Schlüssel, die mit `app.` oder `alpha05.` beginnen, und die Sprache), nennt die Wallet-Adressen, unter denen diese Datensätze liegen, und zählt die Sitzungseinträge des Wallet-Connectors und die Datenbanken dieser Website, ohne sie zu kopieren. Das Löschen trennt zuerst jede Wallet-Verbindung, damit der Connector seine Einträge nicht zurückschreibt, entfernt dann den lokalen und den Tab-Speicher dieser Website, löscht ihre Datenbanken, wo der Browser sie auflisten kann, und lässt das Cookie `vaipakam_lang` auf jeder Domain ablaufen, auf der es gesetzt sein kann; danach lädt es neu und zeigt für diesen Tab, was entfernt wurde und was der Browser verweigert hat, mit Grund. Zurückgeschrieben werden nur die „getrennt“-Markierungen des Wallet-Connectors, damit das Neuladen keine Wallet wieder verbindet, die diese Seite noch autorisiert; behält der Browser den Bericht nicht über das Neuladen, bleibt die Seite stehen und zeigt ihn stattdessen.

Der Risikozugang liest in einem Block `getVaultRiskTier`, `getEffectiveRiskTier`, die Bedingungsversion der Stufe gegen `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskStrictMode`, `getStrictModeStrictUntil` und `getRiskAccessGateEnabled`. Er nennt die Stufe, die zählt, und warum sie von der gewählten abweicht: eine Anhebung, die noch wartet (mit dem Zeitpunkt, ab dem sie zählt), oder eine Bedingungsänderung (zählt als Blue-Chip bis zur Bestätigung). Eine Stufenänderung ist `setVaultRiskTierChecked` mit dem gelesenen Änderungszähler und der Bedingungsversion, sodass ein Schreibvorgang von anderswo oder neue Bedingungen sie ablehnen und nichts ändern; eine Anhebung wartet die Frist ab und wird währenddessen nie erneut angeboten; das Senken wirkt sofort. Die Prüfung gilt nur bei der Entstehung, daher schließt das Senken Paare darüber für neue Angebote und Anfragen (deine eigenen offenen können nicht angenommen werden) und lässt offene Kredite unberührt. Der strenge Modus ist `setRiskStrictMode`: an sofort; aus gilt er noch für die Frist weiter, und die Seite sagt, bis wann. In einem Netzwerk mit ausgeschalteter Prüfung wird eine Änderung gespeichert und zählt erst, wenn die Prüfung eingeschaltet wird. Zustimmungen und Bestätigungen pro Paar bleiben in den Abläufen, die sie brauchen.

Freigaben liest in einem Block für jedes ERC-20 `allowance(wallet, Diamond)`, die Permit2-`allowance(wallet, token, Diamond)`, wo Permit2 bereitsteht (eine abgelaufene wird nicht gelistet), `isApprovedForAll(wallet, Diamond)` für jede NFT-Sammlung und `getApproved` für jedes ERC-721-Token, das eine Position nennt und die Wallet noch besitzt. Geprüft werden die vorgeschlagenen Assets, jedes Asset in `getDepositoryAssets`, die Seiten jedes Kredits in `getUserLoansPaginated` und jedes Angebots in `getUserOffersPaginated`, das verliehene Asset jedes stehenden Angebots und jeder Vertrag, den du hinzufügst. Eine Freigabe ab 2^255 (2^159 über Permit2) wird als unbegrenzt gezeigt. Das Zurückziehen sendet `approve(Diamond, 0)`, Permit2-`approve(token, Diamond, 0, 0)`, `setApprovalForAll(Diamond, false)` oder `approve(0x0, tokenId)`; die Zeile wird vor dem Öffnen der Wallet und im Block des Belegs erneut gelesen. Ein nicht bis zum Ende gelesener Datensatz oder ein Asset ohne Antwort wird genannt, nie als „keine Freigabe“ gezeigt. Auch das Sicherheiten-Asset eines stehenden Angebots wird geprüft, und ein Token im Besitz der Wallet, dessen `getApproved` nicht antwortet, zählt als unbekannt. Der Beleg liest im selben Block wie die Zeile die andere Freigabe desselben Assets (`isApprovedForAll` für ein Token, `getApproved` der gefundenen Tokens für eine Sammlung, `allowance` von Permit2 für ein ERC-20, die ERC-20-`allowance` für eine Permit2-Freigabe) und nennt sie als bestehen bleibend oder sagt, dass sie unbekannt ist; ändert sie sich, bevor die Wallet öffnet, hält das die Signatur an.

Keeper liest in einem Block `getKeeperAccess`, `getApprovedKeepers` und `getKeeperActions` für jeden freigegebenen Keeper (höchstens fünf). Die Aktionen sind die Bits des Protokolls. Einen Verkauf der Kreditgeberposition abschließen (0x01), eine vorzeitige Schließung per Offset abschließen (0x02), einen Verkauf der Kreditgeberposition starten (0x04), eine vorzeitige Schließung starten (0x08) und innerhalb vereinbarter Grenzen verlängern (0x20) wirken bei einem Kredit nur, wenn der Kredit oder das Angebot diesen Keeper zusätzlich aktiviert; stehende Kreditangebote füllen, die einen Keeper verlangen (0x40), zurückgezahltes Geld wieder in stehende Angebote einbringen (0x80) und ein geschütztes Konto sperren (0x100) wirken für das ganze Konto, sobald der Zugang an ist. Bit 0x10 ist stillgelegt und wird abgelehnt. Änderungen senden `setKeeperAccess`, `approveKeeper`, `setKeeperActions` oder `revokeKeeper`; eine Änderung, die einem Keeper mehr gibt, verlangt die Nutzungsbedingungen, wenn eine Version gilt, eine Rücknahme nie, und jede Änderung, auch das Entfernen, wird abgelehnt, solange das Protokoll pausiert ist. Der Keeper dieser App wird aus dem Deployment-Datensatz benannt.

Die App liefert ein Web-Manifest (`/manifest.webmanifest`) mit den vier Verknüpfungen und einem maskierbaren Symbol. Unter Einstellungen › App installieren erscheint die Schaltfläche erst, nachdem der Browser sein Ereignis `beforeinstallprompt` ausgelöst hat, und sie öffnet diesen Dialog; sonst nennt die Seite den Fall (installiert, iOS oder nicht angeboten). Ein bereitgestellter Build registriert `/sw.js`, geschrieben aus der Ausgabe dieses Builds: Er behält eine Kopie einer gehashten `/assets/`-Datei des Builds, sobald die Seite sie zum ersten Mal lädt, beantwortet spätere Anfragen nach dieser Datei aus der Kopie, löscht beim Übernehmen die Speicher früherer Builds und beantwortet nie eine Navigation, eine Anfrage an einen anderen Ursprung oder eine Datei, die nicht auf seiner Liste steht. „Deine Daten in diesem Browser“ zählt und löscht diese Speicher.

<a id="rent-review"></a>

### Mieten: Ein NFT mieten

Die Prüfung liest das Angebot mit `getOffer` (sein `rentalBufferBpsAtCreate`), das Urteil des Protokolls und die Tagesgebühr aus `previewAccept` und `getRiskConfig` nur für ein Angebot, das keinen eigenen Puffer gespeichert hat. Die Summe ist `amount × durationDays` plus dieser Anteil, abgerundet wie im Protokoll, und der Probelauf belegt, dass beide übereinstimmen. Die Miete ist `acceptOffer` mit signierten `AcceptTerms`, die das NFT als bestätigte illiquide Seite nennen und keine Sicherheitsseite; das Nutzungsrecht wird im Block des Belegs aus dem Vault des Eigentümers zurückgelesen, mit `vaultGetNFTUserOf` oder bei einem ERC-1155 mit `vaultGetNFTQuantity`.

<a id="rent-risks"></a>

### Mieten: Risiken

Ein gemietetes NFT gehört dir nie, und dein Nutzungsrecht endet mit der Miete. Miete und Puffer bleiben für die Miete in deinem Vault und können nicht abgehoben werden, solange sie offen ist. Sobald jeder vereinbarte Tag abgerechnet ist, was jeder tun darf, schließt sich die Miete von selbst, und du kannst deinen Puffer zurückfordern. Bis dahin schließt du sie selbst auf ihrer Positionsseite. Schließen in der Nachfrist kostet eine Verzugsgebühr aus dem Puffer; nach der Nachfrist fällt die Miete aus, die verbliebene Miete in deinem Vault geht an den Eigentümer, der Puffer an das Protokoll, und nichts kommt zu dir zurück. Bei Miete für die volle Laufzeit ist die ganze Laufzeit geschuldet, auch wenn du früher schließt.

<a id="rent-list"></a>

### Mieten: Ihr NFT zur Miete anbieten

Das Formular liest den Standard der Sammlung mit ERC-165 `supportsInterface` und die längste Laufzeit aus `getProtocolConfigBundle`. Die Prüfung liest den Token mit `ownerOf`, `getApproved` und `isApprovedForAll` (`balanceOf` bei einem ERC-1155), die Klasse des Zahlungstokens aus `getAssetPriceStatus` und der Liquiditätsprüfung, den Pufferanteil aus `getRiskConfig`, die Nachfrist aus `getEffectiveGraceSeconds` und den Protokollanteil aus `getTreasuryFeeBps` und führt dann `createOffer` als Probelauf aus, mit `assetType` 1 oder 2, `amount` und `amountMax` beide gleich der Tagesgebühr, jedem Sicherheits- und Zinsfeld auf null und `prepayAsset` als Zahlungstoken. Das Einstellen speichert `rentalBufferBpsAtCreate`; das Ergebnis wird aus dem `OfferCreated`-Log der Transaktion und dem eigenen `Transfer`- (oder `TransferSingle`-)Log des NFTs in den Vault des Eigentümers gelesen.

<a id="rent-list-risks"></a>

### Mieten: Risiken des Anbietens

Das NFT bleibt in deinem Vault, solange das Angebot offen ist und solange es vermietet ist, und du kannst es erst abheben, wenn Angebot oder Miete enden. Solange niemand es gemietet hat, kannst du das Angebot nach seinen ersten fünf Minuten auf seiner Seite stornieren. Ist es vermietet, hat der Mieter bis zum Ende der Miete das Nutzungsrecht, und du kannst es nicht vorzeitig zurücknehmen. Die Miete kommt, abzüglich des Anteils des Protokolls, in deinen Vault, sobald ein abgelaufener Tag abgerechnet wird; das darf jeder tun. Ist jeder vereinbarte Tag abgerechnet, schließt sich die Miete von selbst, und der Mieter kann den Puffer zurückfordern. Vorher kann der Mieter sie schließen, oder nach der Nachfrist kann jeder sie als Ausfall schließen. Schließt der Mieter sie, kannst du die noch nicht abgerechnete Miete und eine etwaige Verzugsgebühr beanspruchen, abzüglich des Anteils des Protokolls, und der Rest des Puffers geht an den Mieter zurück. Bei einem Ausfall kannst du die restliche Miete abzüglich dieses Anteils beanspruchen, und der Puffer geht an das Protokoll. Eine Pause stoppt die tägliche Abrechnung und verschiebt die Fristen für Verzugsgebühr und Ausfall nach hinten, verlängert aber nie die Nutzung des Mieters. Ein abgelaufenes Angebot lässt das NFT in deinem Vault, bis es geschlossen wird.

<a id="rent-request"></a>

### Mieten: Ein NFT zur Miete anfragen

Das Formular liest den Standard der Sammlung mit ERC-165 `supportsInterface` und die längste Laufzeit aus `getProtocolConfigBundle`. Die Prüfung liest den Halter des Tokens mit `ownerOf` (ein ERC-1155 hat keine Halterliste), die Klasse des Zahlungstokens aus `getAssetPriceStatus` und der Liquiditätsprüfung, `balanceOf` und `allowance` der Wallet für den Zahlungstoken, den Pufferanteil aus `getRiskConfig` und die Kulanzzeit aus `getEffectiveGraceSeconds` und führt dann `createOffer` als Probelauf aus, mit `offerType` 1, `assetType` 1 oder 2, `amount` und `amountMax` beide gleich der Tagesgebühr, allen Sicherheiten- und Zinsfeldern auf null und `prepayAsset` gleich dem Zahlungstoken. Das Einstellen speichert `rentalBufferBpsAtCreate` und zieht Tagesgebühr mal Laufzeit plus diesen Anteil in den Vault des Mieters; das Ergebnis wird aus dem `OfferCreated`-Log der Transaktion und dem `Transfer`-Log des Zahlungstokens in den Vault gelesen.

<a id="rent-request-risks"></a>

### Mieten: Risiken einer Mietanfrage

Miete und Puffer bleiben in deinem Vault, solange die Anfrage offen ist, und du kannst sie erst abheben, wenn du sie stornierst oder sie endet. Solange kein Eigentümer sie angenommen hat, kannst du die Anfrage nach ihren ersten fünf Minuten auf ihrer Seite stornieren, und beides kommt in deine Wallet zurück. Ein Eigentümer, der sie annimmt, startet die Miete sofort zu genau diesen Bedingungen: Du hältst das Recht, das NFT zu nutzen, nie das NFT selbst. Sobald jeder vereinbarte Tag abgerechnet ist, was jeder tun darf, endet die Miete von selbst, und du kannst deinen Puffer zurückfordern; bis dahin beende sie auf ihrer Positionsseite. Wer zu spät beendet, zahlt eine Verspätungsgebühr aus dem Puffer, und bei einem Ausfall geht die Miete an den Eigentümer und der Puffer an das Protokoll. Eine abgelaufene Anfrage lässt Miete und Puffer in deinem Vault, bis sie geschlossen wird. Der Pufferanteil ist die Einstellung des Protokolls, wenn die Anfrage auf der Chain landet: Ändert sie sich nach deiner Prüfung, wird ein höherer Anteil abgelehnt, wenn deine Wallet genau diesen Betrag freigegeben hat, und eingezogen, wenn eine frühere Freigabe ihn deckt; das Ergebnis nennt, was bewegt wurde.

<a id="rent-take"></a>

### Mieten: Die Anfrage eines Mieters annehmen

Die Prüfung liest die Anfrage mit `getOffer` (ihr `rentalBufferBpsAtCreate`), das Urteil des Protokolls aus `previewAccept`, die Risikoeinstellungen beider Seiten, die Nachfrist aus `getEffectiveGraceSeconds`, den Anteil des Protokolls aus `getTreasuryFeeBps` und `getRiskConfig` nur für eine Anfrage ohne eigenen Puffer. `previewAccept` prüft nicht, wer das NFT hält, daher liest die App das mit `ownerOf`, `getApproved` und `isApprovedForAll` (`balanceOf` und `isApprovedForAll` bei einem ERC-1155). Das Annehmen ist `acceptOffer` mit signierten `AcceptTerms`: Das Protokoll zieht das NFT aus der Wallet des Eigentümers in dessen Vault und trägt den Mieter bis zum Ende der Laufzeit als Nutzer ein. Das Ergebnis wird aus den Logs der Transaktion gelesen (die aus dieser Anfrage eröffnete Miete und der `Transfer` oder `TransferSingle` des NFTs in den Vault des Eigentümers) und aus `vaultGetNFTUserOf` im Block der Quittung. Jeden abgelaufenen Tag zahlt `autoDeductDaily(loanId)`, das jeder aufrufen darf, solange das Protokoll nicht pausiert ist, in den Vault dessen, der das Eigentümer-Positions-NFT hält; der Rest wird beim Schließen beansprucht.

<a id="rent-take-risks"></a>

### Mieten: Risiken beim Annehmen einer Anfrage

Das NFT bleibt für die ganze Miete in deinem Vault, und du kannst es nicht abheben, solange die Miete offen ist. Der Mieter hält das Nutzungsrecht bis zum Ende der Miete, und du kannst es nicht früher zurücknehmen. Die Bedingungen sind die der Anfrage: Tagesgebühr, Laufzeit, Mietregel und Puffer kannst du nicht ändern. Die Miete kommt, abzüglich des Anteils des Protokolls, in deinen Vault, sobald ein abgelaufener Tag abgerechnet wird; das darf jeder tun. Ist jeder vereinbarte Tag abgerechnet, schließt sich die Miete von selbst, und der Mieter kann den Puffer zurückfordern. Vorher kann der Mieter sie schließen, oder nach der Nachfrist kann jeder sie als Ausfall schließen. Schließt der Mieter sie, kannst du die noch nicht abgerechnete Miete und eine etwaige Verzugsgebühr beanspruchen, abzüglich des Anteils des Protokolls, und der Rest des Puffers geht an den Mieter zurück. Bei einem Ausfall kannst du die restliche Miete abzüglich dieses Anteils beanspruchen, und der Puffer geht an das Protokoll. Eine Pause stoppt die tägliche Abrechnung und verschiebt die Fristen für Verzugsgebühr und Ausfall nach hinten, verlängert aber nie die Nutzung des Mieters. Eine Anfrage ohne eigenen Puffer übernimmt beim Start der Miete die heutige Einstellung.

<a id="rent-close"></a>

### Mieten: Eine Miete schließen

Die Seite einer laufenden Miete bietet dir als Mieter Miete schließen an. Das Schließen bezahlt die geschuldete Miete und eine etwaige Verzugsgebühr aus der Miete und dem Puffer, die du im Voraus in deinen eigenen Vault gezahlt hast; deiner Wallet wird nichts entnommen, und es gibt keine Freigabe. Die Prüfung zeigt die geschuldete Miete, wenn jetzt geschlossen wird und zu einem Zeitpunkt kurz danach, gezählt nach der Mietregel (anteilig: die seit dem Start genutzten Tage, ein angefangener Tag als ganzer, abzüglich der schon abgerechneten Tage; volle Laufzeit: jeder vereinbarte, noch nicht abgerechnete Tag), die schon abgerechneten Tage, eine etwaige Verzugsgebühr, was als Anspruch an dich zurückgeht und was der Eigentümer erhält: Miete und Verzugsgebühr abzüglich des Anteils des Protokolls. Reicht die Vorauszahlung nicht, sagt die Prüfung das, bevor sich deine Wallet öffnet. Deine Wallet fragt dann einmal, ob die Miete geschlossen werden soll; die App probiert das zuerst als Probelauf. Danach prüft die App auf der Chain, dass die Miete geschlossen ist, welcher Anspruch für dich verbucht wurde und dass deine Nutzung endete. Was zurückkommt, holst du auf der Seite Claims ab.

Die Prüfung liest die Miete mit `getLoanDetails`, ihre Termine mit `getLoanDeadlines` und die Verzugsgebühr mit `calculateRepaymentAmount`, das bei einer Miete nur die Verzugsgebühr ist. Für die Miete selbst veröffentlicht das Protokoll keinen Wert, also zählt die App sie nach der Regel, die `repayLoan` anwendet, aus `startTime`, `lastDeductTime` und `durationDays`. Schließen ist `repayLoan(loanId)`, das nur der Mieter vor dem Ende der Nachfrist aufrufen darf. Das Ergebnis wird aus dem `LoanRepaid`-Log, aus `getClaimable(loanId, false)` und aus `vaultGetNFTUserOf` im Block der Quittung gelesen.

<a id="rent-close-risks"></a>

### Mieten: Risiken des Schließens

Das Schließen beendet dein Nutzungsrecht sofort, auch wenn noch vereinbarte Tage übrig sind, und lässt sich nicht rückgängig machen. Die Miete wird gezählt, wenn das Schließen auf der Chain landet; ein Tag, der vorher beginnt, wird als ganzer bezahlt. Bei voller Laufzeit wird jeder noch nicht abgerechnete vereinbarte Tag bezahlt, wie früh du auch schließt. Nach dem Ende der Laufzeit wird eine Verzugsgebühr aus deinem Puffer genommen: 1 % der ganzen Miete plus 0,5 % für jeden Tag Verzug, höchstens 5 % und nie mehr als der Puffer. Nach der Nachfrist lehnt das Protokoll ein Schließen ab; die Miete endet dann, wenn ihre restlichen Tage einzeln abgerechnet werden, was jeder tun darf, oder durch Ausfall, je nachdem, was zuerst eintritt. Der spätere Zeitpunkt, den die Prüfung zeigt, ist weder Frist noch Obergrenze: Ein Schließen, das später landet, wird dann gezählt, sodass mehr Miete oder eine höhere Verzugsgebühr anfallen kann und weniger an dich zurückkommt. Was zurückkommt, bleibt als Anspruch in deinem eigenen Vault, bis du es abholst.

<a id="rewards-programme"></a>

### Belohnungen: Läuft das Programm hier?

Oben auf der Seite Belohnungen sagt ein Satz, ob das Belohnungsprogramm in Ihrem Netzwerk läuft: es läuft und hält VPFI, um Belohnungen auszuzahlen; es läuft, hält aber gerade nichts zum Auszahlen; es hat keinen Starttermin; es startet zu einem genannten Zeitpunkt; oder das Netzwerk hat das Belohnungsnetz verlassen, sodass dort nichts Neues mehr einlösbar wird. Eine Einlösung zahlt nur aus VPFI, das in diesem Netzwerk bereits für Belohnungen gehalten wird. In einem Netzwerk, das vom Heimatnetzwerk von VPFI finanziert wird, kann auch VPFI, das für einen bestimmten Tag gesendet wurde, die Belohnungen dieses Tages zahlen; der Satz zählt es nicht mit und sagt dort deshalb nie, dass nichts zahlen kann. Lässt sich eine Angabe hinter dem Satz nicht lesen, sagt die Seite das und zeigt das Programm nie als laufend an. Ist das Protokoll pausiert, sagt die Seite auch das: Einlösungen von Belohnungen und Abhebungen sind gestoppt, während vollständige und teilweise Rückzahlung und das Hinzufügen von Sicherheiten möglich bleiben. Belohnungen sind ein Rabatt auf Ihre eigene Nutzung des Protokolls, nie ein Ertrag aus dem Halten von VPFI.

Der erweiterte Modus listet, worauf der Satz beruht: die Belohnungsrolle dieses Netzwerks (das Heimnetzwerk von VPFI, das Belohnungen zählt und finanziert; ein Netzwerk, das an das Heimnetzwerk meldet und von dort finanziert wird; keine gesetzte Rolle, womit es wie ein Heimnetzwerk arbeitet; oder abgekoppelt) und, bei einem endgültig stillgelegten Netzwerk, wohin sein übriges Belohnungs-VPFI geht und wie viel schon gesendet wurde; den Startzeitpunkt des Programms; das für Belohnungen gelieferte VPFI und das aus Gebühren zurückgeführte VPFI, auf das eine Einlösung jetzt zugreifen kann, jeweils abzüglich dessen, was ausstehende Abrechnungen reserviert haben; ob Belohnungs-VPFI in einem eigenen Verwahrungsvertrag oder im eigenen Bestand des Protokolls liegt; und ob nicht eingelöste Belohnungen entfernt werden können und nach welcher Zeit. Eine Angabe, die die Verträge dieses Netzwerks nicht anbieten, wird als solche genannt. Ob der tägliche Abschluss läuft, der die Belohnungen eines Tages einlösbar macht, liest die Seite nicht; jeder darf ihn ausführen, und Ihre Einlösungszahl zeigt, was eine Einlösung jetzt zahlt. VPFI, das über das für Belohnungen Gelieferte oder über den verbleibenden Pool des Programms hinaus gehalten wird, steht neben der auszahlbaren Zahl und zählt nicht als auszahlbar, weil eine Einlösung nur innerhalb beider Grenzen zahlt.

<a id="rewards-vpfi"></a>

### Belohnungen: VPFI im Vault

Die Seite liest den Token mit `getVPFIToken`; die Nulladresse bedeutet, dass VPFI in diesem Netzwerk nicht eingerichtet ist. In einem Block liest sie `balanceOf` der Wallet, den Vault aus `getUserVaultAddress`, das gezählte VPFI aus `getTrackedVPFIBalance`, den freien Betrag aus `withdrawableNow` und `balanceOf` des Vaults selbst. Gebunden ist der gezählte Betrag abzüglich des freien; ungezählt ist der Saldo des Vaults über dem gezählten. „VPFI einzahlen“ ist das allgemeine `depositToVault` des Vaults und „VPFI abheben“ sein `withdrawFromVault` (`escapeWithdraw`, solange das Protokoll pausiert und der Notausgang offen ist, für ein Konto ohne geschützten Modus), nicht die reinen VPFI-Einstiege: Die allgemeinen Routen erfassen VPFI für die Stufe genauso, und nur sie haben den Notausgang. Jede Prüfung liest `getTrackedVPFIBalance` und `getVPFIDiscountConsent` in ihrem eigenen Block, und das Ergebnis wird aus der Transaktion gemessen. `isCanonicalVpfiChain` wird mitgelesen: Nur das Heimnetzwerk von VPFI ermittelt die Stufe aus seinem eigenen gezählten VPFI, die anderen wenden eine zwischengespeicherte Kopie dieser Stufe an, daher sagen dort die Seite und jeder Beleg, dass ein Vorgang keine Stufe ändert.

<a id="rewards-vpfi-risks"></a>

### Belohnungen: Risiken beim Bewegen von VPFI

Die Stufe ist nicht dein heutiger Bestand. Sie ist null, bis dein aktueller ununterbrochener Bestand die Mindestzahl von Tagen erreicht hat; danach folgt sie einem nach Aktualität gewichteten Durchschnitt deiner täglichen Schlussbestände; und sie wird auf die niedrigste Stufe begrenzt, die du an einem Tag deines aktuellen Bestands hattest, mit einem Rückblick von höchstens 30 Tagen. Das sind zwei getrennte Rückblicke. Wenn du einen Teil deines gezählten VPFI abhebst, sinkt der niedrigste Bestand dieses Tages, den die Begrenzung liest, und wenn du alles abhebst, beginnt deine Haltezeit neu. Eine Aufstockung startet sie nicht neu. Für einen Kredit, ein Angebot, einen Anspruch oder eine Auszahlung gebundenes VPFI kann erst abgehoben werden, wenn es freigegeben ist. Die Abhebung eines geschützten Kontos ändert dein gezähltes VPFI und deine Stufe erst, wenn sie freigegeben wird, und eine abgebrochene ändert beides nicht. VPFI in deinem Vault ist keine Sicherheit. Das Protokoll verkauft kein VPFI, nennt keinen Preis dafür und zahlt nichts für das Halten.

<a id="rewards-tier"></a>

### Belohnungen: die Gebührenrabattstufe

In einem Block liest die Karte `getVPFIDiscountConsent`, `isCanonicalVpfiChain` und `getEffectiveDiscount`, das die Stufe und den Rabatt liefert, die der Gebührenpfad anwendet: null bei ausgeschalteter Zustimmung, auf 50 % begrenzt und in anderen Netzwerken die vom Heimatnetzwerk gesendete Kopie. Im selben Block liest sie `explainTier` und `getTwaConfig`. `explainTier` liefert unabhängig von der Zustimmung die Stufe, die das gezählte VPFI allein ergibt, den Wert jeder Halteregel und die Regel, die die wirksame Stufe darunter hält; die Karte nennt diese Regel nur, wenn die Erklärung dieselbe Stufe ergibt, die der Gebührenpfad anwendet, und sagt bei ausgeschalteter Zustimmung, welche Stufe mit eingeschalteter gälte. Advanced listet den Wert jeder Regel und die Einstellungen aus `getTwaConfig`, mit dem Fenster des Durchschnitts und dem Rückblick als zwei getrennten Längen. Die Tabelle liest `getVpfiTierThresholds`, `getVpfiTierDiscountBps` und `getFeesConfig` in einem Block. Die Stufen 1 bis 3 beginnen bei ihrem Schwellenwert, Stufe 4 oberhalb ihres eigenen. Jede Gebühr ist die Listengebühr mal eins minus den begrenzten Rabatt, exakt berechnet. Die Tabelle wird nur im Heimatnetzwerk gezeigt, wo Stufen festgelegt werden.

<a id="rewards-tier-elsewhere"></a>

### Belohnungen: Ihre Stufe in anderen Netzwerken

An einem Block liest der Abschnitt `getTierPushStatus(wallet)` (#1277): den zuletzt zum Senden festgeschriebenen Push (Nonce, Stufe, bps, Ablauf, Tabellenversion) und für jedes Broadcast-Ziel das zuletzt empfangene Tupel, ob ihm der festgeschriebene Push zusteht und ob das Protokollbudget ihn bezahlt, was nur gilt, wenn der Push senkt, was diese Lane gewährt. Am selben Block liest er `getEffectiveDiscount`, den Messenger aus `getRewardReporterConfig` und für jede geschuldete Lane `quoteSendTierUpdateTo` des Messengers mit dem festgeschriebenen Tupel und der Zeit des Blocks; ein Angebot, das revertiert, lässt diese Gebühr unbekannt, und kein Senden wird angeboten. Die Erfassung ist im Rückstand, wenn die festgeschriebene Stufe oder ihre bps nach der 50-%-Obergrenze von der effektiven abweichen; die Tabellenversion hat keinen Reader, daher bleibt die Aktualisierung in jedem Fall angeboten. „Erfassung aktualisieren“ sendet `pokeMyTier()`, das die Stufe neu auflöst, festschreibt und die Lanes liefert, die das Budget bezahlt. „An andere Netzwerke senden“ sendet `deliverTierPush(wallet)` mit dem Angebot jeder geschuldeten Lane plus 20 %, weil der Wert des Aufrufers geschuldete Lanes zuerst bezahlt, in Zielreihenfolge, budgetbezahlte eingeschlossen; es wird nur angeboten, solange die Erfassung der aktuellen Stufe entspricht und jede geschuldete Lane ein Angebot hat, und die Prüfung liest beides erneut und simuliert den Aufruf mit diesem Wert. Die Abschlusskarte liest den Status am Block der Quittung für die gelieferte Nonce jeder Lane und summiert die `ProtocolTierBroadcastSent`-Ereignisse mit `callerFunded`, um zu nennen, was bezahlt wurde; der Rest kam im selben Aufruf zurück. Ein Diamond, der noch `getTierPushSpacingSec()` routet, ist älter als die Regel, und seine Lanes werden nicht gelesen. Die Lane-Liste ist leer in einem Netzwerk, das nicht das Heimnetzwerk von VPFI ist oder keinen Messenger hat, und dann wird kein Schritt angeboten. Ob eine Kopie angekommen ist und im anderen Netzwerk gilt, wird dort gelesen, nicht hier. Jedes andere Netzwerk zählt eine Kopie außerdem nicht mehr, sobald sie älter ist als sein eigenes Höchstalter (60 Tage, sofern dieses Netzwerk nichts anderes festgelegt hat); das kann sie vor dem in der Nachricht mitgegebenen Ende beenden.

<a id="rewards-vpfi-sign"></a>

### Belohnungen: Signieren statt Genehmigen

In ihrem eigenen Block liest die Prüfung, ob Permit2 an seiner kanonischen Adresse Code hat, und die ERC-20-`allowance` der Wallet an Permit2 für das VPFI-Token. Nur wenn Permit2 bereitgestellt ist und diese Freigabe den Betrag deckt, wird „Signieren statt genehmigen“ angeboten; sonst sagt Advanced, was davon fehlt. Die Wallet signiert Permit2s `PermitTransferFrom` für das VPFI-Token und genau den Betrag, mit dem Diamond als Ausgeber, einer zufälligen Nonce, die gegen `nonceBitmap` als unbenutzt geprüft ist, und einer Frist 30 Minuten nach dem neuesten Block. Die App führt `depositVPFIToVaultWithPermit` mit der Signatur als Probelauf aus und sendet es dann; das Protokoll lehnt eine Genehmigung für jedes andere Token ab. Das Ergebnis wird aus `VPFIDepositedToVault` gemessen, das dieser Einstieg anstelle von `VaultDeposited` ausgibt, und aus der Übertragung des Tokens in den Tresor. Beide Wege zählen das VPFI für die Stufe gleich.

<a id="desk-markets"></a>

### Rate desk: Märkte und Zinsleitern

Die Marktliste ist die Marktübersicht des Index: jede eigene Kombination aus verliehenem Asset, Sicherheits-Asset und Laufzeit unter offenen Angeboten von ERC-20 gegen ERC-20, nicht abgelaufen, ohne Verkaufs- und Offset-Vehikel, die tiefsten zuerst und begrenzt, mit der Anzahl und dem besten Satz jeder Seite (das niedrigste `interestRateBps` der Kreditgeber, das höchste `interestRateBpsMax` der Kreditnehmer). Diese Zahlen enthalten aktive signierte Orders, die der Desk getrennt von der Leiter aufführt (nächster Abschnitt); wo die Zahl eines Marktes von dem abweicht, was seine Leiter aufführt, nennt die Leiter beide. Die Leiter liest die offenen Angebote des Marktes aus dem Index mit `excludeExpired`, `excludeSaleVehicles` und `excludeOffsetVehicles`, bis zu vier Seiten zu 50, und sagt, wenn der Markt mehr enthielt. Ein Angebot eines Kreditgebers steht auf seinem Mindestsatz, eine Anfrage eines Kreditnehmers auf seiner Obergrenze, dem höheren Wert aus Satz und Höchstsatz. Der offene Betrag einer Stufe zählt für jedes Angebot den oberen Betrag abzüglich des bereits Gefüllten zusammen. Die App lässt außerdem weg und zählt nach Grund: Angebote, die nach ihrer eigenen Uhr abgelaufen sind, Vehikel, die der Index noch geliefert hat, Angebote, die an eine seit ihrer Eröffnung bewegte Kreditposition gebunden sind (#3205), Angebote ohne offenen Rest und Zeilen mit anderen Bedingungen. Der mittlere Satz ist der Mittelwert aus bester Nachfrage und bestem Angebot, exakt auf ein Zehntel eines Basispunkts; liegt das beste Gebot auf oder über dem besten Angebot, sagt die Leiter, dass sich die Seiten überschneiden, und das Abgleichsband darunter bietet ein Paar zum Abgleichen an (siehe den Abschnitt dazu unten). Jedes Angebot verlinkt seine eigene Seite, die Zustand und Bedingungen von der Chain liest.

<a id="desk-signed-book"></a>

### Rate desk: die signierten Orders eines Marktes

Die Liste liest `/signed-offers` des Index für den Markt ohne `signer` und enthält so die Orders aller Maker: die 100 bestgepreisten Zeilen je Seite, mit Angabe von `truncated`. Jede Zeile muss sich in die kanonische Wire-Form zurückserialisieren lassen, ihr `orderHash` muss dem aus der Order neu berechneten EIP-712-Struct-Hash entsprechen, sie muss die Token und die Laufzeit des Marktes nennen, und ihre Signatur muss eine 65-Byte-ECDSA-Signatur sein; jede andere Zeile wird als unlesbar gezählt. Asks werden nach `interestRateBps` aufsteigend sortiert, Bids nach dem höheren Wert von `interestRateBps` und `interestRateBpsMax` absteigend, bei gleichem Zins in der Reihenfolge des Buchs. Der Stand jeder Order wird an einem Block nach derselben Regel gelesen wie bei Ihren eigenen signierten Orders, unten beschrieben. Am selben Block liest die App `freeHolding(signer, ERC20, stakeAsset, 0)` einmal je Maker und Einsatz-Asset und vergleicht es für jede noch füllbare Order mit dem, was eine Füllung des Rests ziehen würde: der Obergrenze eines Verleihers abzüglich des Gefüllten, oder der Sicherheit eines Kreditnehmers für diesen Rest zum eigenen Verhältnis der Order, aufgerundet. Ein fehlgeschlagener Lesevorgang wird als unbekannt angegeben, nie als null. Jede Order wird allein am ganzen freien Guthaben gemessen, sodass zwei Orders eines Makers jeweils als gedeckt erscheinen können, während der Vault nur für eine reicht. Eine offene Order, die jemand anderes signiert hat, kann ganz gefüllt werden. Die Prüfung liest `previewSignedOfferAccept(order, signature, acceptor)`, das die Annahmevorschau des Angebots liefert, das die Füllung anlegen würde, dazu den Hash der Order, das Einsatz-Asset, den Einsatz, den die Füllung aus dem Vault des Makers zieht, und dessen freies Guthaben; seine Ablehnungen (darunter `SignedOfferMakerShort`, `SignedOfferConsumed` und `SignedOfferNonceUsed`) werden namentlich genannt und sperren die Zustimmung. Die Terms-Signatur ist an den Hash der Order als `offerKey` gebunden, und gesendet wird `acceptSignedOffer(order, signature, terms, termsSignature)`, das die ganze Order verbraucht, das Angebot aus dem Vault des Makers anlegt und den Kredit in einer Transaktion eröffnet. Die Prüfung liest außerdem `previewSignedOfferRiskBlocks(order, acceptor)` (#3577), das die Sperre des Makers, die Sperre des Annehmenden und das Paar zurückgibt, gegen das beide geprüft werden, mit den Codes von `previewOfferAcceptBlock`. Eine Sperre des Makers wird genannt und sperrt die Zustimmung, ohne dass ein Schritt angeboten wird; eine Sperre des Annehmenden öffnet den Risikoschritt für das zurückgegebene Paar, bevor etwas signiert wird. Schlägt dieses Lesen fehl (ein Diamond ohne diese Funktion antwortet mit `FunctionDoesNotExist`), sagt die Prüfung, dass der Probelauf von `acceptSignedOffer` die Prüfung vornimmt, und eine Ablehnung dort (`RiskTierTooLow`, `IlliquidPairNotConsented`, `MidTierPairNotAcknowledged`) öffnet den Risikoschritt für das Paar der Order nur, wenn der Fehler den Annehmenden nennt. Die Abschlusskarte findet das `SignedOfferFilled` des Diamond zum Hash der Order und liest den Kredit daraus. Eine teilweise gematchte Order meldet `SignedOfferConsumed` und wird nicht angeboten; Ihre eigenen Orders ebenfalls nicht. `awaitingReplay` in der Antwort zählt Orders, die der Index zurückhält, während ein Neuaufbau nach einer Reorganisation ihre Füllungen und Stornierungen von der Chain neu liest (#3411); eine Zahl über null wird mit der Liste genannt, ein Wert, der keine nicht-negative ganze Zahl ist, als unbekannt.

<a id="desk-match"></a>

### Rate desk: eine Überschneidung abgleichen

Das Band paart die sich überschneidenden Stufen der Leiter: Angebote von Verleihern auf oder unter dem besten Gebot mit Anfragen von Kreditnehmern auf oder über dem besten Ask, ohne Paare aus einer Wallet und ohne Paare, deren Zinsspannen sich nicht treffen: Das Protokoll gleicht nur ab, wo die höhere der beiden Untergrenzen auf oder unter der niedrigeren der beiden Obergrenzen liegt. Überschneiden sich die Seiten, ohne dass sich Spannen treffen, sagt das Band, dass nichts abgeglichen werden kann. An einem Block liest es `getPartialFillEnabled`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps` und `getCapacityCurve(0)` und, nur wenn der Schalter an ist, `previewMatch(lenderOfferId, borrowerOfferId, matcher, initiator)` für bis zu 12 Paare, bestgepreiste zuerst, mit Ihrer Wallet als matcher und initiator. Das erste Paar, dessen Vorschau keinen Fehler meldet, wird mit Betrag, Zins (der Mitte der Spanne, die beide akzeptieren) und erforderlicher Sicherheit aus der Vorschau angeboten; sonst wird die Ablehnung des bestgepreisten Paars mit ihrem Grund genannt. Der Anteil wird als Obergrenze angegeben, Betrag mal Initiierungsgebührensatz mal Matcher-Satz, weil die Gebühr nach dem Rabatt des Kreditnehmers berechnet wird, den die Vorschau nicht meldet. Eine Kurve mit freier Stufe über null bedeutet, dass ein Kapazitätslimit gilt, und ein Abgleich zählt eine Füllung gegen den Absender. Die Prüfung liest die Einstellungen, die Vorschau und Ihren Vault an jedem Block neu und führt `matchOffers` vor dem Öffnen der Wallet trocken aus; eine geänderte Zahl braucht eine neue Bestätigung. Danach sucht die App `OfferMatched` für das Paar mit Ihrer Wallet als matcher und misst den Anteil an den `VaultOutflow`-Einträgen des Verleiher-Vaults der Klasse Incentive im Kreditasset, gezahlt an Ihre Wallet oder Ihren Vault; eine Angebotsrückerstattung oder der Kreditbetrag gehört zu einer anderen Klasse und wird nie mitgezählt. Ein konkurrierender Abgleich, der zuerst landet, kann von einem Angebot weniger übrig lassen, sodass Kredit und Anteil kleiner ausfallen können als geprüft; die Abschlusskarte nennt, was gelandet ist. Die Leiter liest den Index, daher kann ein abgeglichenes Paar dort noch einige Minuten stehen, nachdem die Chain es übernommen hat. Paare mit einem Angebot der verbundenen Wallet werden ebenfalls ausgelassen, und das Band sagt das: Ein Abgleich würde diese Wallet zum Kreditgeber oder Kreditnehmer machen, mit ihren eigenen Mitteln im Kredit.

<a id="offer-terms-wait"></a>

### Mindestalter der Angebotsbedingungen

Das Protokoll erfüllt ein Angebot oder eine Anfrage erst, wenn seine Bedingungen `getMinTermsAgeSec()` Sekunden nach `termsSetAt` aus `getOffer` bestanden haben (Standard 5 s, eine Admin-Einstellung zwischen 1 und 60 s; jede Änderung der Bedingungen startet sie neu). `previewAccept` meldet `TermsTooFresh`, solange sie nicht verstrichen ist. Die Prüfung liest dann `termsSetAt`, das Mindestalter und die Blockzeit an einem Block und nennt, wie lange die Bedingungen bestehen müssen und wie viel an diesem Block noch fehlte; sie zeigt keinen Zustimmungs- oder Signierschritt. Die Prüfung liest die Chain jeden Block neu, sodass die Ablehnung von selbst entfällt. Können diese Werte nicht gelesen werden oder fehlte am gelesenen Block nichts mehr, bleibt die einfache Ablehnung, die sagt, dass sie binnen Sekunden entfällt.

<a id="desk-tape"></a>

### Rate desk: eigene Angebote, Abschlussliste und Chart der vereinbarten Zinssätze

Ihre Angebote sind die Angebote der Leiter, deren Ersteller Ihre Wallet ist, jeweils mit `amountFilled` gegenüber ihrem oberen Betrag, wie der Index sie erfasst hat. Die Abschlussliste liest `/loans/recent` des Index, auf den Markt eingeschränkt und mit `excludeSaleVehicles`, die 20 neuesten Kredite, und zeigt die Momentaufnahme jedes Kredits bei Eröffnung: `initRateBps` und `initPrincipal`, nie die laufenden Werte `interestRateBps` oder `principal`, die Teilrückzahlung und `LoanExtended` überschreiben. Ein Betrag, den das Ledger nicht belegt, erscheint als nicht bestätigt. Ein Kredit gehört nur dann zu einem Markt, wenn der Index ihn dort einordnet (`marketDurationDays`, die vom Ledger belegte vereinbarte Laufzeit); die nicht eingeordneten Kredite des Paares werden gezählt, nie einer Laufzeit zugeraten, und eine Antwort, die nicht auf den Markt eingeschränkt ist, wird abgelehnt. Das Diagramm liest `/loans/rate-candles` in 1-Stunden-Schritten über 7 Tage, 4-Stunden-Schritten über 30 Tage und Tagesschritten über 90 Tage und den gesamten Zeitraum. Jeder Schritt trägt den ersten, höchsten, niedrigsten und letzten vereinbarten Zinssatz, die Anzahl der Kredite und die verliehenen Beträge, addiert über Kredite mit bestätigtem Betrag, die übrigen gezählt. Es kommen nur Schritte mit einem Kredit zurück. Die Linie verbindet nur aufeinanderfolgende Schritte, sodass ein leerer Schritt eine Lücke bleibt; hat der Index nur die neuesten Kredite gelesen, sagt das Diagramm, dass seine ältesten Schritte nicht gezeichnet sind. Die gestrichelte Referenz ist der abgeleitete mittlere Zinssatz der Leiter; eine Veränderungszahl wird nicht gezeigt.

<a id="desk-history"></a>

### Rate desk: laufende Kredite und Desk-Verlauf

Die laufenden Kredite sind die Zeilen Ihres eigenen Positionsabrufs (die `LoanSummary`-Zeilen hinter Positionen, mit dem Health Factor jedes Kredits und der Seite, die Ihr Positions-NFT hält), deren beide Seiten ERC-20-Token sind und zu Token und Laufzeit des Marktes passen. Sie werden nie aus dem Index gelesen, und ein unvollständiger Abruf sagt, dass ein Kredit fehlen kann. Der Verlauf liest `/loans/by-participant` des Index mit `scope=desk`: Kredite, deren Kredit- und Sicherheitsasset beide ERC-20 sind, ohne den Buchungskredit, den der Verkauf eines Kreditgebers eröffnet, aus dem nur anhängenden Protokoll, wer welche Seite hielt (geschrieben bei der Eröffnung und bei jeder Übertragung einer Position, nie gelöscht). Die Zeilen kommen nach letzter Beteiligung, neueste zuerst; der Leser fragt 21 Zeilen an und bietet eine ältere Seite ab Beteiligungszeit und Kredit-ID der 20. Zeile nur an, wenn die 21. kommt, sodass eine Seite, die genau an der Grenze endet, nichts anbietet. Jede Zeile wird erneut gegen den Desk-Umfang geprüft, und eine abgelehnte Zeile wird gezählt, nicht verworfen. Der Status ist der des Index (`active`, `repaid`, `defaulted`, `liquidated`, `settled`, `internal_matched`, `fallback_pending` oder unbekannt), und die Seite des Kredits liest die Chain.

<a id="desk-ticket"></a>

### Rate desk: Order-Ticket

Das Ticket stellt über `createOffer` im angezeigten Markt ein: Lending Asset, Collateral Asset und `durationDays` kommen vom Markt, das Ticket liefert die Seite (`offerType`), den Gesamtbetrag als `amountMax`, mit `amount` als kleinster Einzelfüllung bei partial oder immediate-or-cancel und dem Gesamtbetrag bei all-or-none (`LibOfferMatch` hält jeden Match zwischen `amount` und dem Rest, eine einzige Größe wird also immer ganz gefüllt), `collateralAmount`, einen Zinssatz (`interestRateBpsMax` gleich `interestRateBps`) (ein exakter Satz: `LibOfferMatch` verlangt sich überschneidende Zinsspannen, das Ticket matcht also nur eine Seite, deren Spanne ihn einschließt), den Ablauf und `fillMode` (partial, all-or-none oder immediate-or-cancel; immediate-or-cancel braucht einen endlichen Ablauf). Der Rest sind die Standardwerte der geführten Abläufe, auf dem Ticket genannt: `useFullTermInterest` true, `allowsPartialRepay` false, `periodicInterestCadence` 0, keine Sicherheitenspanne (`collateralFloor` gleich der Sicherheit), kein Gebührentarif und kein Preisschutz. `expiresAt` wird beim Öffnen der Prüfung aus dem Zeitstempel des letzten Blocks festgelegt, oder 0 für ein Angebot ohne Ablauf. Beträge werden mit den Dezimalstellen des Tokens gelesen und nie gerundet; mehr Dezimalstellen als der Token hat, stoppen das Ticket. Das erste Hindernis wird in fester Reihenfolge gemeldet: Wallet, Netzwerk, Markt, die Abrufe (`readPostFormInputs`, die Dezimalstellen beider Token und die geltenden Bedingungen), die Laufzeit gegen `maxDurationDays`, dann Betrag, Sicherheit, Zinssatz (höchstens 100% pro Jahr) und Fill-Modus. Die Gebühren nutzen die gelistete Loan Initiation Fee und den Treasury-Anteil; ein Gebührenrabatt kann sie nur senken. Die Prüfung ist die eigene Einstell-Prüfung der geführten Abläufe, mit der Annahme der Bedingungen zuerst. Im signierten Modus signiert das Ticket die Order stattdessen (nächster Abschnitt).

<a id="desk-sign"></a>

### Rate desk: eine neue Order signieren

Im signierten Modus baut das Ticket ein `SignedOffer` aus denselben `createParams`, die ein eingestelltes Angebot sendet, in der Wire-Form, die der Index speichert (Adressen kleingeschrieben, Zahlen als Dezimaltext), mit `creatorFull` false, einem zufälligen 128-Bit-`nonce` und `deadline` gleich `expiresAt`. Es signiert nur, was ein vault-gedecktes `acceptSignedOffer` in einem Stück füllen kann: ERC-20 auf beiden Seiten, `fillMode` all-or-none mit `amount` gleich `amountMax` und einem einzigen Sicherheitsbetrag (sonst könnte der Matcher Teile füllen), kein Gebührentarif und kein Preisschutz; ein `expiresAt` von 0 wird abgelehnt. Order und Nonce werden beim Öffnen der Prüfung festgelegt, und Beleg und Signatur lesen diese eine Order. Die Prüfung liest den neuesten Block und `freeHolding(signer, ERC20, stakeAsset, 0)` vom Protokoll; eine Unterdeckung gegenüber dem Einsatz wird genannt, blockiert aber nie. Die Wallet signiert EIP-712-Typed-Data unter der Domain `Vaipakam SignedOffer`, Version `1`, dieser Chain-ID und dem Diamond. Danach sendet die App `{chainId, order, signature}` per POST an `/signed-offers` des Index: 201 heißt gelistet, 200 bereits gelistet (beide müssen den Hash dieser Order liefern), ein 4xx mit `error`-Code ist eine Ablehnung, alles andere oder keine Antwort ist unbekannt. Eine Listung oder Ablehnung verwirft die Signatur; eine unbekannte Antwort behält sie zum erneuten Senden im Speicher der App (nicht im Browser-Speicher, ein Neuladen verliert sie).

<a id="desk-signed"></a>

### Rate desk: signierte Orders und die Stornierung auf der Chain

Die Liste liest `/signed-offers` des Index für den Markt, mit `signer` auf Ihre Wallet gesetzt (bis zu 500 Zeilen pro Seite, `truncated` wird genannt), damit die Tiefe anderer Maker Ihre Orders nicht verdrängen kann. Jede Zeile muss sich wieder in die kanonische Wire-Form mit 31 Feldern serialisieren lassen, ihr `orderHash` muss dem aus der Order neu berechneten EIP-712-Struct-Hash entsprechen, und sie muss Ihre Wallet sowie Token und Laufzeit des Marktes nennen; jede andere Zeile wird als unlesbar gezählt. Das Buch liefert nur Orders, die es als aktiv und nicht abgelaufen führt, und kann der Chain in beide Richtungen hinterherhinken, daher wird der Stand jeder Order an einem Block gelesen: ein `signedOfferFilledAmount(orderHash)` in Höhe der Obergrenze der Order (`amountMax`, oder `amount`, wenn das null ist) ist verbraucht (eine direkte Füllung und `cancelSignedOffer` schreiben beide die Obergrenze), sonst ist `isSignedOfferNonceUsed(signer, nonce)` eine stornierte Nonce, sonst abgelaufen, sobald die Blockzeit nach dem früheren von `expiresAt` und `deadline` (jeweils ungleich null) liegt, sonst teilweise gefüllt, wenn dieser Wert über null liegt (ein Match hat einen Teil genommen, der Rest bleibt füllbar und stornierbar), sonst offen. Eine einzelne Order zu stornieren sendet `cancelSignedOffer(order)` (nur der Signierer); per Nonce zu stornieren sendet `invalidateSignedOfferNonce(nonce)`, angeboten, wenn zwei oder mehr gelistete offene Orders sie teilen, und stoppt jede Order, die die Wallet mit dieser Nonce signiert hat, in jedem Markt. Beides wird abgelehnt, solange das Protokoll pausiert ist. Die Prüfung liest die Stände und die Pause und führt dann den eigenen Probelauf des Protokolls von Ihrer Wallet aus. Der Einsatz, den eine Füllung ziehen würde, ist beim Verleiher `amountMax` (oder `amount`, wenn das null ist), beim Leiher `collateralAmountMax` (oder `collateralAmount`). Bei einer teilweise gefüllten Order nennt die Prüfung den bereits gefüllten Anteil und nur das, was der Rest noch ziehen könnte: den Kapitalbetrag unter der Obergrenze, beim Leiher die Sicherheit dafür im eigenen Verhältnis der Order, aufgerundet. Das Ergebnis wird aus dem eigenen `SignedOfferCancelled`- oder `SignedOfferNonceBurned`-Log der Transaktion vom Diamond gelesen, abgeglichen mit dem Order-Hash oder der Nonce und Ihrer Wallet. In diesem auf den Signierer begrenzten Abruf listet der Index solche zurückgehaltenen Orders mit `replayPending: true`; die Zeile sagt, dass die Order bis zum Ende der Neuprüfung aus dem gemeinsamen Buch fehlt, während ihr Stand weiter aus den obigen Chain-Abfragen stammt; nur ein frischer Stand, der noch füllbar ist, ergänzt, dass die Signatur noch gefüllt werden kann, und lässt die Stornierung angeboten.
