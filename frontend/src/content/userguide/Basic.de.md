# Vaipakam — Benutzerhandbuch (Basic-Modus)

Verständliche, alltagssprachliche Erklärungen zu jeder Karte in der
App. Jeder Abschnitt entspricht einem `(i)`-Info-Symbol neben einem
Karten-Titel.

> **Sie lesen die Basic-Version.** Sie entspricht dem **Basic**-Modus
> der App (die einfachere Ansicht mit weniger Steuerelementen und
> sichereren Voreinstellungen). Für eine technischere, detailliertere
> Anleitung wechseln Sie die App in den **Advanced**-Modus — öffnen
> Sie Einstellungen (Zahnrad-Symbol oben rechts) → **Modus** →
> **Advanced**. Die "Mehr erfahren"-Links (i) in der App öffnen dann
> das Advanced-Handbuch.

---

## Dashboard

<a id="dashboard.your-vault"></a>

### Dein Vault

Stell dir deinen **Vault** als deinen privaten Tresor innerhalb von
Vaipakam vor. Es ist ein kleiner Vertrag, den nur du kontrollierst.
Immer wenn du an einem Loan teilnimmst — entweder als Sicherheit
oder als Verleiher eines Assets — wandern die Assets aus deinem
Wallet in diesen Tresor. Sie werden nie mit dem Geld anderer
vermischt. Wenn der Loan endet, claimst du sie direkt wieder
heraus.

Du musst keinen Vault selbst "anlegen"; die App erstellt einen
beim ersten Mal, wenn du ihn brauchst. Sobald er existiert, bleibt
er als deine zugewiesene Heimat auf dieser Chain.

<a id="dashboard.your-loans"></a>

### Deine Loans

Jeder Loan, an dem du auf dieser Chain beteiligt bist, taucht hier
auf — egal ob du der Lender bist (derjenige, der das Asset zum
Verleihen einbringt) oder der Borrower (derjenige, der es
aufgenommen hat). Jede Zeile ist eine einzelne Position. Klick
hinein und du bekommst das Gesamtbild: wie gesund der Loan ist, was
als Collateral gesperrt ist, wann Zinsen aufgelaufen sind und die
Buttons zum Zurückzahlen, Claimen oder Liquidieren, wenn die Zeit
gekommen ist.

Wenn ein Loan beide Rollen einschließt (du hast bei einem
verliehen, bei einem anderen geliehen), tauchen beide auf — gleicher
Ort, verschiedene Zeilen.

<a id="dashboard.vpfi-panel"></a>

### VPFI auf dieser Chain

**VPFI** ist der eigene Token des Protokolls. Etwas davon im Vault
zu halten verschafft dir einen Rabatt auf Protokollgebühren und
bringt dir eine kleine passive Rendite (5% APR). Diese Karte sagt
dir, auf der Chain, mit der du verbunden bist:

- Wie viel VPFI gerade in deinem Wallet liegt.
- Wie viel in deinem Vault liegt (was als "gestaked" zählt).
- Welchen Anteil am Gesamt-VPFI-Supply du hältst.
- Wie viel VPFI insgesamt noch geminted werden kann (das Protokoll
  hat eine harte Obergrenze).

Vaipakam läuft auf mehreren Chains. Eine davon (Base) ist die
**kanonische** Chain, auf der neues VPFI geminted wird; die anderen
sind **Mirrors**, die Kopien halten und über eine Cross-Chain-Bridge
synchron gehalten werden. Aus deiner Sicht musst du dir darüber
keine Gedanken machen — das Guthaben, das du siehst, ist auf der
Chain, auf der du gerade bist, real.

<a id="dashboard.fee-discount-consent"></a>

### Zustimmung zum Gebühren-Rabatt

Vaipakam kann dir einen Rabatt auf Protokollgebühren auszahlen,
indem ein Teil des VPFI verwendet wird, das du im Vault geparkt
hast. Dieser Schalter ist das "ja, gerne". Du legst ihn nur einmal
um.

Wie groß der Rabatt ist, hängt davon ab, wie viel VPFI du im
Vault hältst:

- **Tier 1** — `{liveValue:tier1Min}` VPFI oder mehr → `{liveValue:tier1DiscountBps}`% Rabatt
- **Tier 2** — `{liveValue:tier2Min}` VPFI oder mehr → `{liveValue:tier2DiscountBps}`% Rabatt
- **Tier 3** — `{liveValue:tier3Min}` VPFI oder mehr → `{liveValue:tier3DiscountBps}`% Rabatt
- **Tier 4** — mehr als `{liveValue:tier4Min}` VPFI → `{liveValue:tier4DiscountBps}`% Rabatt

Du kannst den Schalter jederzeit ausschalten. Wenn du VPFI aus dem
Vault abhebst, fällt dein Tier in Echtzeit.

> **Hinweis zur Blockchain-Netzwerkgebühr (Gas).** Der obige Rabatt
> gilt für die **Protokollgebühren** von Vaipakam (Renditegebühr,
> Kreditinitiierungsgebühr). Die kleine **Gas-Gebühr**, die jede
> On-Chain-Aktion zusätzlich erfordert — gezahlt an die
> Blockchain-Validatoren beim Erstellen eines Angebots, Annehmen,
> Zurückzahlen, Beanspruchen usw. — ist eine separate Gebühr, die
> ans Netzwerk geht, nicht an Vaipakam. Das Protokoll kann darauf
> keinen Rabatt geben, weil es sie nie erhält.

<a id="dashboard.rewards-summary"></a>

### Ihre VPFI-Belohnungen

Diese Karte fasst alle VPFI-Belohnungen, die Sie vom Protokoll
verdient haben, an einem Ort zusammen. Die große Zahl oben ist
die kombinierte Summe — was Sie bereits beansprucht haben plus
was darauf wartet, beansprucht zu werden.

Es gibt zwei Belohnungsströme und die Karte schlüsselt die
Summe nach jedem auf:

- **Staking-Rendite** — automatisch auf jedem VPFI verdient,
  das Sie in Ihrem Vault halten. Der Satz ist der Protokoll-
  APR, der auf der Buy-VPFI-Seite angezeigt wird.
- **Plattform-Interaktions-Belohnungen** — täglich ein wenig
  für jeden Kredit verdient, an dem Sie auf einer Seite
  beteiligt sind. Ausgezahlt in VPFI auf der Kette, auf der
  Sie sich befinden, ohne Bridge.

Jede Zeile hat einen kleinen Pfeil rechts. Klicken Sie darauf,
um direkt zur vollständigen Anspruchskarte für diesen Strom zu
springen — Staking lebt auf der Buy-VPFI-Seite, Plattform-
Interaktion lebt im Claim Center.

Wenn Sie noch nichts verdient haben, wird die Karte trotzdem
mit *Insgesamt verdient: 0 VPFI* plus einem Hinweis zum
Einstieg gerendert. Sie haben nichts falsch gemacht — es gibt
nur keine Historie zu zeigen.


---

## Offer Book

<a id="offer-book.filters"></a>

### Filter

Die Marktlisten können lang werden. Filter grenzen sie ein nach
welches Asset im Loan ist, ob es eine Lender- oder Borrower-Offer
ist und ein paar weiteren Stellschrauben. Deine eigenen aktiven
Offers bleiben immer oben auf der Seite sichtbar — Filter wirken
sich nur darauf aus, was andere Leute dir zeigen.

<a id="offer-book.your-active-offers"></a>

### Deine aktiven Offers

Offers, die **du** gepostet hast und die noch niemand akzeptiert
hat. Solange eine Offer hier liegt, kannst du sie kostenlos
stornieren. Sobald jemand akzeptiert, wird die Position zu einem
echten Loan und wandert auf dem Dashboard zu "Deine Loans".

<a id="offer-book.lender-offers"></a>

### Lender-Offers

Posts von Leuten, die anbieten zu verleihen. Jeder davon sagt:
"Ich verleihe X Einheiten von Asset Y zu Z% Zinsen für D Tage,
gegen so viel Collateral".

Ein Borrower, der eine davon akzeptiert, wird zum Borrower-of-record
des Loans: das Collateral des Borrowers wird im Vault gesperrt,
das Hauptasset kommt im Wallet des Borrowers an, und Zinsen laufen
auf, bis der Borrower zurückzahlt.

Das Protokoll setzt eine Sicherheitsregel auf der Borrower-Seite
bei der Annahme durch: das Collateral muss mindestens das 1,5-fache
des Loans wert sein. (Diese Zahl heißt **Health Factor 1.5**.)
Reicht das Collateral des Borrowers nicht aus, startet der Loan
nicht.

<a id="offer-book.borrower-offers"></a>

### Borrower-Offers

Posts von Borrowern, die ihr Collateral bereits gesperrt haben und
darauf warten, dass jemand den Loan finanziert.

Ein Lender, der eine davon akzeptiert, finanziert den Loan: das
Asset des Lenders geht zum Borrower, der Lender wird zum
Lender-of-record und der Lender verdient Zinsen zum Satz der Offer
über die gesamte Laufzeit. Ein kleiner Anteil (1%) der Zinsen geht
beim Settlement an die Treasury des Protokolls.

---

## Offer erstellen

<a id="create-offer.offer-type"></a>

### Offer-Typ

Wähle eine Seite:

- **Lender** — der Lender stellt ein Asset bereit und verdient
  Zinsen, solange es ausstehend ist.
- **Borrower** — der Borrower sperrt Collateral und fordert dafür
  ein anderes Asset an.

Eine Sub-Option **Rental** existiert für "rentable" NFTs (eine
spezielle Klasse von NFTs, die zeitlich begrenzt delegiert werden
können). Rentals verleihen kein Geld — der NFT selbst wird gegen
eine tägliche Gebühr vermietet.

<a id="create-offer.lending-asset"></a>

### Lending Asset

Das Asset und die Menge, die im Spiel sind, plus der Zinssatz
(APR in %) und die Dauer in Tagen. Der Satz wird beim Posten der
Offer fixiert; niemand kann ihn später ändern. Nach Ablauf der
Dauer greift ein kurzes Gnadenfenster — hat der Borrower bis dahin
nicht zurückgezahlt, kann der Loan auf Default gesetzt werden und
der Collateral-Anspruch des Lenders greift.

<a id="create-offer.lending-asset:lender"></a>

#### Wenn du der Lender bist

Das Hauptasset und die Menge, die du bereit bist anzubieten, plus
der Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird zum
Zeitpunkt der Offer fixiert; die Dauer setzt das Gnadenfenster,
bevor der Loan in Default gehen kann.

<a id="create-offer.lending-asset:borrower"></a>

#### Wenn du der Borrower bist

Das Hauptasset und die Menge, die du vom Lender willst, plus der
Zinssatz (APR in %) und die Dauer in Tagen. Der Satz wird zum
Zeitpunkt der Offer fixiert; die Dauer setzt das Gnadenfenster,
bevor der Loan in Default gehen kann.

<a id="create-offer.nft-details"></a>

### NFT-Details

Für eine Rental-Offer setzt diese Karte die tägliche Mietgebühr.
Der Mieter zahlt die volle Mietkosten beim Akzeptieren im Voraus,
plus einen kleinen 5%-Buffer, falls die Sache leicht überzieht.
Der NFT selbst bleibt während der ganzen Zeit im Vault — der
Mieter hat Nutzungsrechte, kann ihn aber nicht bewegen.

<a id="create-offer.collateral"></a>

### Collateral

Was gesperrt wird, um den Loan zu sichern. Zwei Geschmacksrichtungen:

- **Liquid** — ein bekannter Token mit einem Live-Preisfeed
  (Chainlink + ein ausreichend tiefer On-Chain-Pool). Das Protokoll
  kann ihn in Echtzeit bewerten und die Position automatisch
  liquidieren, wenn der Preis sich gegen den Loan bewegt.
- **Illiquid** — NFTs oder Tokens ohne Preisfeed. Das Protokoll
  kann diese nicht bewerten, also nimmt der Lender im Default
  einfach das gesamte Collateral. Beide Seiten müssen ein Häkchen
  setzen und dem zustimmen, bevor die Offer gestellt werden kann.

<a id="create-offer.collateral:lender"></a>

#### Wenn du der Lender bist

Wie viel du willst, dass der Borrower sperrt, um den Loan zu
sichern. Liquide ERC-20s (Chainlink-Feed + ≥1 Mio. $ v3-Pool-Tiefe)
bekommen LTV/HF-Mathematik; illiquide ERC-20s und NFTs haben keine
On-Chain-Bewertung und erfordern, dass beide Parteien einem
Voll-Collateral-bei-Default-Ergebnis zustimmen.

<a id="create-offer.collateral:borrower"></a>

#### Wenn du der Borrower bist

Wie viel du bereit bist zu sperren, um den Loan zu sichern.
Liquide ERC-20s (Chainlink-Feed + ≥1 Mio. $ v3-Pool-Tiefe) bekommen
LTV/HF-Mathematik; illiquide ERC-20s und NFTs haben keine
On-Chain-Bewertung und erfordern, dass beide Parteien einem
Voll-Collateral-bei-Default-Ergebnis zustimmen.

<a id="create-offer.risk-disclosures"></a>

### Risiko-Hinweise

Verleihen und Leihen auf Vaipakam birgt echtes Risiko. Bevor eine
Offer signiert wird, fragt diese Karte nach einer expliziten
Bestätigung der unterzeichnenden Seite. Die Risiken unten gelten
für beide Seiten; die rollen-spezifischen Tabs heben hervor, in
welche Richtung jedes davon tendenziell beißt.

Vaipakam ist non-custodial. Es gibt keinen Support-Schalter, der
eine durchgegangene Transaktion rückgängig machen könnte. Lies das
sorgfältig durch, bevor du signierst.

<a id="create-offer.risk-disclosures:lender"></a>

#### Wenn du der Lender bist

- **Smart-Contract-Risiko** — die Verträge sind unveränderlicher
  Code; ein unbekannter Bug könnte Mittel betreffen.
- **Oracle-Risiko** — ein veralteter oder manipulierter Preisfeed
  kann eine Liquidation verzögern, bis das Collateral deinen
  Principal nicht mehr deckt. Du bekommst möglicherweise nicht
  alles zurück.
- **Liquidations-Slippage** — selbst wenn die Liquidation
  rechtzeitig auslöst, kann der DEX-Swap zu einem schlechteren
  Preis als der Quote landen, was deine tatsächliche Erholung
  schmälert.
- **Illiquides Collateral** — im Default geht das Collateral
  vollständig auf dich über, aber wenn es weniger wert ist als der
  Loan, hast du keinen weiteren Anspruch. Du hast diesem Trade-Off
  bei der Offer-Erstellung zugestimmt.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Wenn du der Borrower bist

- **Smart-Contract-Risiko** — die Verträge sind unveränderlicher
  Code; ein unbekannter Bug könnte dein gesperrtes Collateral
  betreffen.
- **Oracle-Risiko** — ein veralteter oder manipulierter Preisfeed
  kann eine Liquidation gegen dich im falschen Moment auslösen,
  selbst wenn der echte Marktpreis sicher geblieben wäre.
- **Liquidations-Slippage** — wenn die Liquidation auslöst, kann
  der DEX-Swap dein Collateral zu einem schlechteren Preis als
  erwartet verkaufen.
- **Illiquides Collateral** — im Default geht dein gesamtes
  Collateral auf den Lender über, ohne Rest-Anspruch zurück an
  dich. Du hast diesem Trade-Off bei der Offer-Erstellung
  zugestimmt.

<a id="create-offer.advanced-options"></a>

### Erweiterte Optionen

Zusätzliche Stellschrauben für Nutzer, die sie wollen — die meisten
lassen sie in Ruhe. Dinge wie wie lange eine Offer offen bleibt,
bevor sie abläuft, ob VPFI für den Gebühren-Rabatt auf diese
spezifische Offer verwendet werden soll, und ein paar
rollen-spezifische Toggles. Bei einer ersten Offer kannst du sie
beruhigt überspringen.

---

## Claim Center

<a id="claim-center.claims"></a>

### Claimable Funds

Nachdem ein Loan beendet wurde — zurückgezahlt, defaultet oder
liquidiert — wandert dein Anteil am Ergebnis nicht automatisch in
dein Wallet. Du musst auf **Claim** klicken, um ihn zu holen.
Diese Seite ist die Liste jedes offenen Claims, den du auf dieser
Chain hast.

Ein Nutzer kann gleichzeitig sowohl Lender-Claims (aus Loans, die
er finanziert hat) als auch Borrower-Claims (aus Loans, die er
aufgenommen hat) halten — beide tauchen in derselben Liste auf.
Die zwei rollen-spezifischen Tabs unten beschreiben, was jede Art
von Claim zurückgibt.

<a id="claim-center.claims:lender"></a>

#### Wenn du der Lender bist

Dein Lender-Claim gibt den Principal des Loans plus die
aufgelaufenen Zinsen zurück, abzüglich eines 1%-Treasury-Anteils
auf den Zinsanteil. Er wird claimbar, sobald der Loan settled —
zurückgezahlt, defaultet oder liquidiert. Der Claim verbraucht
deinen Lender-Position-NFT atomar — sobald er durchgeht, ist diese
Seite des Loans vollständig abgeschlossen.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

Wenn du den Loan vollständig zurückgezahlt hast, gibt dein
Borrower-Claim das Collateral zurück, das du am Anfang gesperrt
hast. Bei Default oder Liquidation wird nur ein etwaiger
ungenutzter VPFI-Rebate aus der Loan Initiation Fee zurückgegeben
— das Collateral selbst ist bereits an den Lender gegangen. Der
Claim verbraucht deinen Borrower-Position-NFT atomar.

---

## Activity

<a id="activity.feed"></a>

### Activity Feed

Jedes On-Chain-Ereignis, das dein Wallet auf der Chain betrifft,
mit der du verbunden bist — jede Offer, die du gepostet oder
akzeptiert hast, jeder Loan, jede Rückzahlung, jeder Claim, jede
Liquidation. Alles wird live von der Chain selbst gelesen; es gibt
keinen zentralen Server, der ausfallen könnte. Neueste zuerst,
gruppiert nach Transaktion, sodass Dinge, die du in einem Klick
gemacht hast, zusammenbleiben.

---

## VPFI kaufen

<a id="buy-vpfi.overview"></a>

### VPFI kaufen

Die Kaufseite lässt dich ETH gegen VPFI zum festen Frühphasen-Kurs
des Protokolls tauschen. Du kannst das von jeder unterstützten
Chain aus tun — wir routen den Trade für dich im Hintergrund. Das
VPFI landet immer in deinem Wallet auf derselben Chain, mit der du
verbunden bist. Kein Netzwerkwechsel nötig.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Schneller Überblick darüber, in welchem Rabatt-Tier du gerade
sitzt. Das Tier ergibt sich daraus, wie viel VPFI in deinem
**Vault** liegt (nicht in deinem Wallet). Die Karte sagt dir
außerdem (a) wie viel VPFI mehr du im Vault brauchen würdest, um
ins nächste Tier aufzusteigen, und (b) ob der Zustimmungsschalter
auf dem Dashboard an ist — der Rabatt gilt nur, solange er an ist.

Dasselbe VPFI in deinem Vault ist außerdem automatisch "gestaked"
und bringt dir 5% APR.

<a id="buy-vpfi.buy"></a>

### Schritt 1 — VPFI mit ETH kaufen

Tippe ein, wie viel ETH du ausgeben willst, drück Kaufen, signier
die Transaktion. Das war's. Es gibt eine Pro-Kauf-Obergrenze und
eine rollende 24-Stunden-Obergrenze, um Missbrauch zu vermeiden —
du siehst die Live-Zahlen neben dem Formular, sodass du weißt, wie
viel dir noch bleibt.

<a id="buy-vpfi.deposit"></a>

### Schritt 2 — VPFI in deinen Vault einzahlen

VPFI zu kaufen legt es in dein Wallet, nicht in deinen Vault. Um
den Gebühren-Rabatt und die 5%-Staking-Rendite zu bekommen, musst
du es selbst in den Vault bewegen. Das ist immer ein expliziter
Klick — die App bewegt dein VPFI nie ohne deine Aufforderung. Eine
Transaktion (oder eine einzige Signatur, auf Chains, die das
unterstützen) und du bist fertig.

<a id="buy-vpfi.unstake"></a>

### Schritt 3 — VPFI aus deinem Vault unstaken

Willst du etwas VPFI zurück in deinem Wallet? Diese Karte schickt
es vom Vault zurück zu dir. Achtung: VPFI rauszuziehen senkt dein
Rabatt-Tier **sofort**. Wenn du offene Loans hast, wechselt die
Rabatt-Mathematik ab diesem Moment auf das niedrigere Tier.

---

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Vaipakam zahlt dir für zwei Dinge:

1. **Staking** — VPFI, das du im Vault hältst, verdient
   automatisch 5% APR.
2. **Interaktion** — jeder Dollar Zinsen, den ein Loan, an dem du
   beteiligt bist, tatsächlich settled, bringt dir einen täglichen
   Anteil an einem gemeinschaftsweiten Reward-Pool.

Beide werden in VPFI ausgezahlt, direkt auf der Chain geminted, auf
der du bist. Keine Bridges, keine Chain-Wechsel.

<a id="rewards.claim"></a>

### Rewards claimen

Ein Button claimed alles aus beiden Reward-Streams in einer
einzigen Transaktion. Staking-Rewards sind immer in Echtzeit
claimbar. Der Anteil aus dem Interaktions-Pool settled einmal pro
Tag, also wenn du seit dem letzten Settlement etwas verdient hast,
wird der Interaktions-Anteil des Totals erst kurz nach Schluss des
nächsten Tagesfensters scharfgeschaltet.

<a id="rewards.withdraw-staked"></a>

### Gestaktes VPFI abheben

Bewege VPFI aus deinem Vault zurück in dein Wallet. Sobald es im
Wallet ist, hört es auf, die 5% APR zu verdienen, und zählt nicht
mehr für dein Rabatt-Tier. Dasselbe wie der "Unstake"-Schritt auf
der VPFI-kaufen-Seite — gleiche Aktion, lebt nur auch hier zur
Bequemlichkeit.

---

## Loan Details

<a id="loan-details.overview"></a>

### Loan Details (diese Seite)

Alles über einen einzelnen Loan, auf einer Seite. Die Konditionen,
unter denen er eröffnet wurde, wie gesund er gerade ist, wer auf
jeder Seite steht, und jeder Button, den du je nach gespielter
Rolle drücken kannst — repay, claim, liquidate, früh schließen,
refinanzieren.

<a id="loan-details.terms"></a>

### Loan Terms

Die festen Bestandteile des Loans: welches Asset verliehen wurde,
wie viel, der Zinssatz, die Dauer und wie viele Zinsen sich bisher
angesammelt haben. Nichts davon ändert sich, sobald der Loan
eröffnet ist. (Wenn andere Konditionen gebraucht werden,
refinanzieren — die App erstellt einen frischen Loan und zahlt
diesen in derselben Transaktion ab.)

<a id="loan-details.collateral-risk"></a>

### Collateral & Risiko

Das Collateral auf diesem Loan, plus die Live-Risikozahlen —
Health Factor und LTV. **Health Factor** ist ein einziger
Sicherheitsscore: über 1 bedeutet, dass das Collateral den Loan
bequem deckt; nahe 1 bedeutet, dass es riskant ist und der Loan
liquidiert werden könnte. **LTV** ist "wie viel wurde geliehen vs.
dem Wert dessen, was hinterlegt wurde". Die Schwellen, an denen
die Position unsicher wird, stehen auf derselben Karte.

Wenn das Collateral illiquid ist (ein NFT oder ein Token ohne
Live-Preisfeed), können diese Zahlen nicht berechnet werden. Beide
Seiten haben diesem Ergebnis bei der Offer-Erstellung zugestimmt.

<a id="loan-details.collateral-risk:lender"></a>

#### Wenn du der Lender bist

Das ist das Collateral des Borrowers — dein Schutz. Solange HF
über 1 bleibt, bist du gut abgedeckt. Wenn HF fällt, dünnt dein
Schutz aus; wenn er 1 unterschreitet, kann jeder (auch du) eine
Liquidation auslösen, und der DEX-Swap konvertiert das Collateral
in dein Hauptasset, um dich zurückzuzahlen. Bei illiquidem
Collateral überträgt der Default das Collateral vollständig an dich
— du bekommst, was es eben wert ist.

<a id="loan-details.collateral-risk:borrower"></a>

#### Wenn du der Borrower bist

Das ist dein gesperrtes Collateral. Halte HF sicher über 1 — wenn
es nahe rangeht, bist du in Liquidationsgefahr. Du kannst HF
normalerweise wieder anheben, indem du mehr Collateral hinzufügst
oder einen Teil des Loans zurückzahlst. Wenn HF die 1
unterschreitet, kann jeder die Liquidation auslösen, und der
DEX-Swap verkauft dein Collateral zu Slippage-zerfressenen
Preisen, um den Lender zurückzuzahlen. Bei illiquidem Collateral
überträgt der Default dein gesamtes Collateral an den Lender ohne
Rest-Anspruch zurück an dich.

<a id="loan-details.parties"></a>

### Parteien

Die zwei Wallet-Adressen auf diesem Loan — Lender und Borrower —
und die Vault-Tresore, die ihre Assets halten. Jede Seite hat
außerdem einen "Position-NFT" bekommen, als der Loan eröffnet
wurde. Dieser NFT _ist_ das Recht auf den Anteil dieser Seite am
Ergebnis — pass darauf auf. Wenn ein Halter ihn an jemand anderen
überträgt, claimt der neue Halter stattdessen.

<a id="loan-details.actions"></a>

### Aktionen

Jeder Button, der auf diesem Loan verfügbar ist. Welche du siehst,
hängt von deiner Rolle auf diesem spezifischen Loan ab — die
rollen-spezifischen Tabs unten listen die Optionen jeder Seite
auf. Buttons, die gerade nicht verfügbar sind, sind ausgegraut,
mit einem kleinen Tooltip, das erklärt, warum.

<a id="loan-details.actions:lender"></a>

#### Wenn du der Lender bist

- **Claim** — sobald der Loan settled (zurückgezahlt, defaultet
  oder liquidiert), schaltet das den Principal zurück frei plus
  Zinsen, abzüglich des 1%-Treasury-Anteils auf die Zinsen.
  Verbraucht deinen Lender-NFT.
- **Initiate Early Withdrawal** — stell deinen Lender-NFT mitten
  im Loan zum Verkauf an einen anderen Käufer ein. Der Käufer
  übernimmt deine Seite; du gehst mit dem Verkaufserlös davon.
- **Liquidate** — jeder (auch du) kann das auslösen, wenn HF
  unter 1 fällt oder die Gnadenfrist abläuft.

<a id="loan-details.actions:borrower"></a>

#### Wenn du der Borrower bist

- **Repay** — vollständig oder teilweise. Teilrückzahlung senkt
  deinen ausstehenden Saldo und verbessert HF; vollständige
  Rückzahlung schließt den Loan und schaltet dein Collateral via
  Claim frei.
- **Preclose** — schließt den Loan früher. Direkter Pfad: zahle
  den vollen ausstehenden Saldo jetzt aus deinem Wallet.
  Offset-Pfad: verkaufe einen Teil des Collaterals auf einem DEX,
  nutze den Erlös zur Rückzahlung, bekomm zurück, was übrig
  bleibt.
- **Refinance** — roll in einen neuen Loan mit neuen Konditionen;
  das Protokoll zahlt den alten Loan vom neuen Principal in einer
  Transaktion ab. Das Collateral verlässt nie den Vault.
- **Claim** — sobald der Loan settled, gibt dein Collateral bei
  voller Rückzahlung zurück, oder einen etwaig übrig gebliebenen
  VPFI-Rebate aus der Loan-Initiation-Fee bei Default.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Wenn du eine Offer akzeptierst, "approved" dein Wallet manchmal
Vaipakam dafür, einen bestimmten Token in deinem Namen zu bewegen.
Manche Wallets haben die Angewohnheit, diese Approvals länger als
nötig offen zu halten. Diese Seite listet jede Approval, die du
Vaipakam auf dieser Chain gegeben hast, und lässt dich jede davon
mit einem Klick deaktivieren. Nicht-null Approvals (die wirklich
aktiv sind) erscheinen oben.

Eine saubere Approvals-Liste ist eine Hygienegewohnheit — genau
wie auf Uniswap oder 1inch.

---

## Alerts

<a id="alerts.overview"></a>

### Über Alerts

Wenn der Preis deines Collaterals fällt, fällt der
Sicherheitsscore deines Loans (sein Health Factor) mit. Alerts
lassen dich für eine Vorwarnung opt-in entscheiden, **bevor**
jemand dich liquidieren kann. Ein kleiner Off-Chain-Service
beobachtet deine Loans alle fünf Minuten und pingt dich in dem
Moment an, in dem der Score eine Gefahrenbande kreuzt. Es kostet
kein Gas; nichts passiert on-chain.

<a id="alerts.threshold-ladder"></a>

### Schwellen-Leiter

Die Gefahrenbänder, die der Watcher nutzt. Das Wechseln in eine
gefährlichere Bande löst einmal aus. Der nächste Ping kommt nur,
wenn du eine weitere, tiefere Bande kreuzt. Wenn du wieder in eine
sicherere Bande zurückkletterst, wird die Leiter zurückgesetzt.
Die Defaults sind auf typische Loans abgestimmt; wenn du sehr
volatiles Collateral hältst, willst du vielleicht höhere Schwellen
einstellen.

<a id="alerts.delivery-channels"></a>

### Lieferkanäle

Wohin die Pings tatsächlich gehen. Du kannst Telegram (ein Bot
schickt dir DM) oder Push Protocol (Benachrichtigungen direkt an
dein Wallet) wählen, oder beides. Beide Schienen teilen dieselbe
Schwellen-Leiter oben — du stellst sie nicht separat ein.

---

## NFT-Verifier

<a id="nft-verifier.lookup"></a>

### Verifiziere einen NFT

Vaipakam-Position-NFTs tauchen manchmal auf Sekundärmärkten auf.
Bevor du einen von einem anderen Halter kaufst, fügst du hier die
Adresse des NFT-Vertrags und die Token-ID ein. Der Verifier
bestätigt (a) dass er wirklich von Vaipakam geminted wurde, (b)
auf welcher Chain der zugrundeliegende Loan lebt, (c) in welchem
Zustand dieser Loan ist und (d) wer den NFT gerade on-chain hält.

Der Position-NFT _ist_ das Recht, aus dem Loan zu claimen. Eine
Fälschung — oder eine Position, die bereits gesettled ist — zu
erkennen, erspart dir den schlechten Trade.

---

## Keeper-Einstellungen

<a id="keeper-settings.overview"></a>

### Über Keeper

Ein "Keeper" ist ein Wallet, dem du vertraust, bestimmte
Wartungsaktionen auf deinen Loans für dich auszuführen — einen
Early Withdrawal abschließen, einen Refinance finalisieren, solche
Sachen. Keeper können nie dein Geld ausgeben — Repay, Collateral
hinzufügen, Claim und Liquidate bleiben alle nur dem Nutzer
vorbehalten. Du kannst bis zu 5 Keeper genehmigen, und du kannst
den Hauptschalter jederzeit ausschalten, um sie alle auf einmal zu
deaktivieren.

<a id="keeper-settings.approved-list"></a>

### Genehmigte Keeper

Jeder Keeper auf der Liste kann **nur die Aktionen ausführen, die
du** für ihn angehakt hast. Also kann ein Keeper, der nur "Early
Withdrawal abschließen" erlaubt hat, keinen in deinem Namen
starten — er kann nur einen abschließen, den du gestartet hast.
Wenn du es dir anders überlegst, bearbeite die Häkchen; wenn du
einen Keeper komplett loswerden willst, entferne ihn aus der
Liste.

---

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Eine Wallet-freie, transparente Sicht auf das gesamte Protokoll:
Total Value Locked, Loan-Volumina, Default-Raten, VPFI-Supply,
aktuelle Aktivität. Alles davon wird live aus On-Chain-Daten
berechnet — es gibt keine private Datenbank hinter irgendeiner
Zahl auf dieser Seite.

<a id="public-dashboard.combined"></a>

### Kombiniert — Alle Chains

Die protokollweiten Summen, über jede unterstützte Chain
aufaddiert. Die kleine Zeile "X Chains abgedeckt, Y nicht
erreichbar" sagt dir, ob das Netz einer Chain zum Zeitpunkt des
Seitenladens offline war — wenn ja, wird die spezifische Chain in
der Pro-Chain-Tabelle unten markiert.

<a id="public-dashboard.per-chain"></a>

### Aufschlüsselung pro Chain

Dieselben Summen, aufgeteilt pro Chain. Nützlich, um zu sehen,
welche Chain den meisten TVL hält, wo die meisten Loans
stattfinden, oder um zu erkennen, wann eine Chain stillsteht.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token-Transparenz

Der Live-Zustand von VPFI auf dieser Chain — wie viel insgesamt
existiert, wie viel tatsächlich zirkuliert (nach Abzug der
protokollgehaltenen Bestände), und wie viel unter dem Cap noch
mintbar ist. Über alle Chains bleibt der Supply per Konstruktion
beschränkt.

<a id="public-dashboard.transparency"></a>

### Transparenz & Quelle

Jede Zahl auf dieser Seite kann direkt aus der Blockchain
neuabgeleitet werden. Diese Karte listet den Snapshot-Block, wie
aktuell die Daten geholt wurden, und die Vertragsadresse, von der
jede Metrik kam. Wenn jemand eine Zahl prüfen will, hier fängt
man an.

---

## Refinance

Diese Seite ist nur für Borrower — Refinance wird vom Borrower auf
dem Loan des Borrowers initiiert.

<a id="refinance.overview"></a>

### Über Refinancing

Refinancing rollt deinen bestehenden Loan in einen neuen, ohne
dein Collateral anzurühren. Du postest eine frische
Borrower-seitige Offer mit den neuen Konditionen; sobald ein
Lender akzeptiert, zahlt das Protokoll den alten Loan ab und
eröffnet den neuen in einer einzigen Transaktion. Es gibt keinen
Zeitpunkt, an dem dein Collateral ungeschützt wäre.

<a id="refinance.position-summary"></a>

### Deine aktuelle Position

Eine Momentaufnahme des Loans, den du refinanzierst — was
ausstehend ist, wie viele Zinsen aufgelaufen sind, wie gesund er
ist, was gesperrt ist. Nutze diese Zahlen, um die neue Offer
sinnvoll zu dimensionieren.

<a id="refinance.step-1-post-offer"></a>

### Schritt 1 — Poste die neue Offer

Du postest eine Borrower-Offer mit dem Asset, der Menge, dem Satz
und der Dauer, die du für den Refinance willst. Solange sie
gelistet ist, läuft der alte Loan normal weiter — Zinsen laufen
weiter auf, dein Collateral bleibt liegen. Andere Nutzer sehen
diese Offer im Offer Book.

<a id="refinance.step-2-complete"></a>

### Schritt 2 — Abschließen

Sobald ein Lender deine Refinance-Offer akzeptiert, klick auf
Abschließen. Das Protokoll dann, atomar: zahlt den alten Loan vom
neuen Principal zurück, eröffnet den neuen Loan und hält dein
Collateral die ganze Zeit gesperrt. Eine Transaktion,
Zwei-Status-Wechsel, kein Expositionsfenster.

---

## Preclose

Diese Seite ist nur für Borrower — Preclose wird vom Borrower auf
dem Loan des Borrowers initiiert.

<a id="preclose.overview"></a>

### Über Preclose

Preclose ist "schließe meinen Loan früher". Du hast zwei Wege:

- **Direkt** — zahle den vollen ausstehenden Saldo jetzt aus
  deinem Wallet.
- **Offset** — verkaufe einen Teil deines Collaterals auf einem
  DEX und nutze den Erlös, um den Loan abzubezahlen. Du bekommst
  zurück, was übrig bleibt.

Direkt ist günstiger, wenn du das Cash hast. Offset ist die
Antwort, wenn du es nicht hast, aber den Loan auch nicht weiter
laufen lassen willst.

<a id="preclose.position-summary"></a>

### Deine aktuelle Position

Eine Momentaufnahme des Loans, den du früher schließt —
ausstehender Saldo, aufgelaufene Zinsen, aktuelle Gesundheit.
Frühes Schließen ist gebührenfair — es gibt keine
Pauschalstrafe; die zeitgewichtete VPFI-Mathematik des Protokolls
übernimmt die Buchhaltung.

<a id="preclose.in-progress"></a>

### Offset in Bearbeitung

Du hast vor einem Moment einen Offset-Preclose gestartet, und der
Swap-Schritt ist mitten im Flug. Du kannst ihn entweder
abschließen (der Erlös settled den Loan und ein Rest kommt zu dir
zurück), oder — wenn der Preis sich bewegt hat, während du
nachgedacht hast — abbrechen und mit einer frischen Quote erneut
versuchen.

<a id="preclose.choose-path"></a>

### Wähle einen Pfad

Wähle **Direkt**, wenn du das Cash hast, um den Loan jetzt
abzubezahlen. Wähle **Offset**, wenn du lieber einen Teil des
Collaterals beim Aussteigen verkaufen willst. Beide Pfade
schließen den Loan vollständig; mit Preclose kannst du nicht
halb-schließen.

---

## Early Withdrawal (Lender)

Diese Seite ist nur für Lender — Early Withdrawal wird vom Lender
auf dem Loan des Lenders initiiert.

<a id="early-withdrawal.overview"></a>

### Über Lender Early Exit

Wenn du vor Ende der Laufzeit aus einem Loan raus willst, kannst
du deinen Lender-NFT über das Protokoll zum Verkauf einstellen.
Der Käufer zahlt dir dafür; im Gegenzug übernimmt er deine Seite
des Loans — er kassiert die spätere Rückzahlung + Zinsen. Du gehst
mit deinem Geld plus jeglichem Aufpreis davon, den der Käufer
gezahlt hat.

<a id="early-withdrawal.position-summary"></a>

### Deine aktuelle Position

Eine Momentaufnahme des Loans, aus dem du aussteigst — Principal,
bisher aufgelaufene Zinsen, verbleibende Zeit, und der aktuelle
Gesundheitsscore des Borrowers. Das sind die Zahlen, die ein
Käufer anschauen wird, um zu entscheiden, was dein NFT wert ist.

<a id="early-withdrawal.initiate-sale"></a>

### Verkauf einleiten

Du setzt den geforderten Preis, das Protokoll listet deinen
Lender-NFT, und du wartest auf einen Käufer. Sobald ein Käufer
akzeptiert, landet der Erlös in deinem Wallet und der Loan läuft
weiter — aber du stehst nicht mehr in der Verantwortung dafür.
Solange das Listing offen und unbefüllt ist, kannst du es
stornieren.
