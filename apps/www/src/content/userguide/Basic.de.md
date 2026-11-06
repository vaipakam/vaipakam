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

<a id="chapter.dashboard"></a>

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
zu halten verschafft dir einen Rabatt auf Protokollgebühren. Diese
Karte sagt dir, auf der Chain, mit der du verbunden bist:

- Wie viel VPFI gerade in deinem Wallet liegt.
- Wie viel in deinem Vault liegt (was zu deiner Rabatt-Stufe zählt).
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

Vaipakam kann dir einen Rabatt auf Protokollgebühren geben, je
nachdem, wie viel VPFI du im Vault hältst. Für einen Borrower ist
der Rabatt einfach eine kleinere Loan Initiation Fee, die beim
Start des Loans im eigenen Asset des Loans erhoben wird — dafür
wird kein VPFI ausgegeben. Dieser Schalter ist das "ja, gerne". Du
legst ihn nur einmal um.

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

Belohnungen stammen aus der **Plattform-Interaktion** — Sie
verdienen täglich ein wenig für jeden Kredit, an dem Sie auf einer
Seite beteiligt sind. Ausgezahlt in VPFI auf der Kette, auf der Sie
sich befinden, ohne Bridge.

Die Zeile hat einen kleinen Pfeil rechts. Klicken Sie darauf, um
direkt zur vollständigen Anspruchskarte im Claim Center zu springen.

Wenn Sie noch nichts verdient haben, wird die Karte trotzdem
mit *Insgesamt verdient: 0 VPFI* plus einem Hinweis zum
Einstieg gerendert. Sie haben nichts falsch gemacht — es gibt
nur keine Historie zu zeigen.


---

<a id="chapter.offer-book"></a>

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
über die gesamte Laufzeit. Ein kleiner Anteil (`{liveValue:treasuryFeeBps}`%) der Zinsen geht
beim Settlement an die Treasury des Protokolls.
Dieser Satz wird bei der Kreditvergabe festgeschrieben; eine spätere
Änderung der Protokollgebühr lässt einen bereits laufenden Kredit auf
seinem ursprünglichen Satz.

---

<a id="chapter.create-offer"></a>

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

<a id="chapter.claim-center"></a>

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
aufgelaufenen Zinsen zurück, abzüglich des Treasury-Anteils auf den
Zinsanteil. Dieser Anteil ist der Prozentsatz, der bei der Erstellung
deines Loans festgeschrieben wurde — eine spätere Änderung der
Protokollgebühr ändert ihn nicht. Loans, die zum aktuellen Satz
erstellt werden, tragen einen Anteil von `{liveValue:treasuryFeeBps}`%. Er wird claimbar, sobald der Loan settled —
zurückgezahlt, defaultet oder liquidiert. Der Claim verbraucht
deinen Lender-Position-NFT atomar — sobald er durchgeht, ist diese
Seite des Loans vollständig abgeschlossen.

<a id="claim-center.claims:borrower"></a>

#### Wenn du der Borrower bist

Wenn du den Loan vollständig zurückgezahlt hast, gibt dein
Borrower-Claim das Collateral zurück, das du am Anfang gesperrt
hast. Bei Default oder Liquidation sieh trotzdem nach. Es wird nur so
viel Wert genommen, wie die Schuld und die Kosten ihrer Auflösung
erfordern; alles darüber wird als deines erfasst. Welche Form es
hat, hängt davon ab, wie der Loan endete: wurde das Collateral
über eine Börse verkauft, erreicht dich der Rest im Asset des
Loans. Wurde es stattdessen übergeben, wartet das Collateral selbst
auf dich. Mehrerlei übergibt es, egal wie der Loan endete: ein Liquidator, der es
mit Abschlag direkt übernimmt, ein Close-out, der protokollintern gegen
eine gegenläufige Position gematcht statt verkauft wird, oder ein Verkauf, der nicht zustande kam — dort bekommst du das Collateral, sofern der Lender beim Claim kein
funktionierendes Quote mitbringt — dann wirst du im Asset des Loans
ausgezahlt; die meisten bringen keins mit. Eine
gewöhnliche Liquidation und ein Default suchen dieses interne
Matching, bevor sie an eine Börse gehen, also endet keines von beiden
immer gleich — lies den Claim, statt es aus der Endungsart zu erraten.
Die Übernahme mit Abschlag ist die Ausnahme und andersherum
berechenbar: sie verkauft nie, dir bleibt also immer das Collateral. Oft geht bei einem Default über Collateral, das wir
nicht bepreisen können, der ganze Korb weg und es bleibt nichts;
und das ist auf diesem Weg die Regel, kein unglücklicher Ausgang. Der Claim verbraucht deinen
Borrower-Position-NFT. Umgekehrt gilt das nicht: ein NFT, der nach
einer Liquidation noch da ist, ist kein Beleg dafür, dass etwas
auf dich wartet. Blieb nichts übrig, gibt es nichts
abzuholen, der Versuch wird abgelehnt, und der NFT kann trotzdem
dableiben. Lies, was der Claim sagt, statt
den NFT als Zusage zu nehmen.

---

<a id="chapter.activity"></a>

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

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### VPFI bekommen

VPFI ist frei übertragbar. Erwirb es auf dem freien Markt, wo immer
es gehandelt wird, oder bridge es herein — VPFI ist ein Chainlink
CCIP-Token, also bewegt es sich zwischen unterstützten Chains über
die offizielle Bridge und landet in deinem Wallet auf der Chain, mit
der du gerade verbunden bist.

<a id="buy-vpfi.discount-status"></a>

### Dein VPFI-Rabatt-Status

Schneller Überblick darüber, in welchem Rabatt-Tier du gerade
sitzt. Das Tier ergibt sich daraus, wie viel VPFI in deinem
**Vault** liegt (nicht in deinem Wallet). Die Karte sagt dir
außerdem (a) wie viel VPFI mehr du im Vault brauchen würdest, um
ins nächste Tier aufzusteigen, und (b) ob der Zustimmungsschalter
auf dem Dashboard an ist — der Rabatt gilt nur, solange er an ist.

<a id="buy-vpfi.deposit"></a>

### VPFI in deinen Vault einzahlen

VPFI in deinem Wallet zählt nicht zur Rabatt-Stufe. Um den
Gebühren-Rabatt freizuschalten, musst du VPFI selbst in deinen
Vault bewegen. Das ist immer ein expliziter Klick — die App bewegt
dein VPFI nie ohne deine Aufforderung. Eine Transaktion (oder eine
einzige Signatur, auf Chains, die das unterstützen) und du bist
fertig.

<a id="buy-vpfi.unstake"></a>

### VPFI aus deinem Vault abheben

Willst du etwas VPFI zurück in deinem Wallet? Diese Karte schickt
es vom Vault zurück zu dir. Achtung: VPFI rauszuziehen senkt dein
Rabatt-Tier **sofort**. Wenn du offene Loans hast, wechselt die
Rabatt-Mathematik ab diesem Moment auf das niedrigere Tier.

---

<a id="chapter.rewards"></a>

## Rewards

<a id="rewards.overview"></a>

### Über Rewards

Vaipakam zahlt dir eine **Plattform-Interaktions-Belohnung**: jeder
Dollar Zinsen, den ein Loan, an dem du beteiligt bist, tatsächlich
settled, bringt dir einen täglichen Anteil an einem
gemeinschaftsweiten Reward-Pool.

Rewards werden in VPFI ausgezahlt, direkt auf der Chain geminted,
auf der du bist. Keine Bridges, keine Chain-Wechsel.

<a id="rewards.claim"></a>

### Rewards claimen

Ein Button claimed deine aufgelaufenen Rewards in einer einzigen
Transaktion. Der Anteil aus dem Interaktions-Pool settled einmal pro
Tag, also wenn du seit dem letzten Settlement etwas verdient hast,
wird er erst kurz nach Schluss des nächsten Tagesfensters
scharfgeschaltet.

---

<a id="chapter.loan-details"></a>

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
  Zinsen, abzüglich des bei der Erstellung deines Loans
  festgeschriebenen Treasury-Anteils (`{liveValue:treasuryFeeBps}`%
  für Loans zum aktuellen Satz). Verbraucht deinen Lender-NFT.
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
  voller Rückzahlung zurück. Bei Default kann ein Überschuss
  bleiben: es wird nur so viel Collateral genommen, wie Schuld und
  Auflösungskosten erfordern, alles darüber wird als dein Claim
  erfasst. Was genau, hängt vom Pfad ab —
  siehe den Claim-Center-Abschnitt.

---

<a id="chapter.allowances"></a>

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

<a id="chapter.alerts"></a>

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

<a id="chapter.nft-verifier"></a>

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

<a id="chapter.keeper-settings"></a>

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

<a id="chapter.public-analytics-dashboard"></a>

## Public Analytics Dashboard

<a id="public-dashboard.overview"></a>

### Über Public Analytics

Eine Wallet-freie Sicht auf das Protokoll in einem Netzwerk:
dem, das die App gerade liest. Du musst nichts verbinden. Die
Seite stützt sich auf zwei öffentliche Quellen und sagt bei jeder
Zahl, woher sie stammt — den öffentlichen Indexer, den jede und
jeder ohne Schlüssel abfragen kann, und den Plattformvertrag
selbst —, damit du keiner Zahl einfach glauben musst.

<a id="public-dashboard.loans-offers"></a>

### Loans und Offers

Anzahl der Loans nach Status (aktiv, zurückgezahlt, ausgefallen,
liquidiert usw.) und der Offers nach Status, aus dem öffentlichen
Indexer. Eine Zahl, die der Indexer nicht gemeldet hat, steht als
„nicht gemeldet" da, nie als null. Gezählt werden nur On-Chain-
Offers: signierte gaslose Orders zählen hier nicht, erscheinen aber
im Offer Book. Die Offer-Summe sind die derzeit erfassten Offers,
keine Zahl über die gesamte Laufzeit.

<a id="public-dashboard.recycling"></a>

### Recyclingkonto und Loop Closure

Woher der Belohnungspool jedes Tages stammte und wie viel davon
entnommen wurde, und wie viel der durch Claims ausgezahlten
Belohnungs-VPFI innerhalb der Plattform bleibt. Das sind
Buchungsaufzeichnungen aus dem öffentlichen Indexer; eine noch
unbekannte Zahl sagt das, statt null zu zeigen.

<a id="public-dashboard.transparency"></a>

### Transparenz & Quelle

Die Adresse des Plattformvertrags mit einem Link zum Öffnen in
einem Block-Explorer, das Netzwerk, der letzte vom Indexer
gelesene Block und wie lange das her ist. Die Indexer-Zahlen sind
nur so aktuell wie dieser Block — deshalb wird sein Alter
angezeigt.

<a id="public-dashboard.vpfi-transparency"></a>

### VPFI-Token

Direkt aus dem Plattformvertrag gelesen, nicht aus dem Indexer:
die Adresse des VPFI-Tokens und seine Menge in diesem Netzwerk. Im
Netzwerk, in dem VPFI ausgegeben wird, zeigt die Seite außerdem
die Mengenobergrenze, wie viel darunter noch geprägt werden kann,
und die eine Adresse, die prägen darf. In einem Netzwerk, das VPFI
per Bridge erreicht, zeigt sie nur die Menge dieses Netzwerks.

<a id="public-dashboard.fees"></a>

### Gebühren und Treasury

Ebenfalls aus dem Vertrag gelesen: die Gebühren, die das Protokoll
seit Beginn der Aufzeichnung, am letzten Tag und in der letzten
Woche erfasst hat, und die Treasury-Adresse, an die sie gehen. Die
Seite nennt den gelesenen Block, das Alter dieser Ablesung und die
aufgerufenen Funktionen, und sie nennt jeden Grund, warum die
Gebührenzahlen niedriger sein können als das tatsächlich
Eingenommene. Nach einem Wechsel der Referenzwährung bleiben
frühere Gebühren in der alten Einheit, was eine Summe in beide
Richtungen verschieben kann; auch das sagt die Seite. Eine Zahl,
die nicht gelesen werden konnte, sagt das, statt null zu zeigen.

---

<a id="chapter.refinance"></a>

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

<a id="chapter.preclose"></a>

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

<a id="chapter.early-withdrawal-lender"></a>

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

<a id="chapter.next-app"></a>

## Die nächste App

Die nächste Version der Vaipakam-App entsteht Seite für Seite,
neben der aktuellen. Eine Seite, die noch nicht gebaut ist, sagt
das und verlinkt auf die aktuelle App, die sie weiter bedient.
Dieses Kapitel erklärt die Seiten, die schon gebaut sind.

<a id="advanced-mode"></a>

### Basic und Advanced

Basic zeigt, was die meisten brauchen. Advanced ergänzt die Exit-
und Settlement-Werkzeuge, Automatisierung, signierte Orders, den
Keeper-Status und Details zur Abrechnung. Ein Moduswechsel blendet
nie eine Zustimmung aus, die du geben musst, nichts, was dich
blockiert, und nie den Weg, es zu beheben. Jeder Info-Knopf (i) nach dem Satz, den er erklärt,
öffnet die volle Erklärung, und sein „Mehr lesen"-Link öffnet
diesen Guide in deinem Modus.

<a id="wallet"></a>

### Dein Wallet und woher deine Zahlen kommen

Die App liest deine Loans, deinen Vault und deine Claims zuerst
über die eigene Netzwerkverbindung deines Wallets. Nur wenn das
Wallet keine anbietet, nutzt sie einen Read-only-Proxy. Deine
eigenen Zahlen kommen nie aus dem gemeinsamen Index. Adresse und
Netzwerk oben sind die, zu denen jede Zahl auf der Seite gehört.
Ist dein Wallet in einem Netzwerk, das die App nicht bedient, wird
nichts von dir angezeigt, bis du wechselst.

<a id="deployments"></a>

### Was das Deployment unterstützt

Bevor die App eine Aktion anbietet, liest sie, welche Funktionen
der Protokoll-Contract in deinem Netzwerk gerade unterstützt. Ein
Upgrade kann diese Liste ändern; weil die App sie liest, kann sie
dir sagen, was sich geändert hat, statt zu scheitern. Ist die
Liste nicht lesbar, wird kein Signaturschritt angeboten.

<a id="home-start"></a>

### Home: Eine Aufgabe wählen

Home beginnt mit „Ich möchte …": leihen, verleihen, ein NFT mieten,
dein NFT vermieten oder verwalten, was du hast. Jede Wahl öffnet
eine geführte Seite. Leihen und Verleihen zeigen zuerst passende
Angebote und lassen dich ein eigenes erstellen, wenn keines passt.
Mieten deckt beide Seiten ab: das NFT eines anderen nutzen oder
jemanden deines nutzen lassen, während es in einem Vault bleibt.
Mit verbundenem Wallet zeigt Home außerdem drei kurze
Einstiegskarten, die du ausblenden kannst.

<a id="home-status"></a>

### Home: Protokollstatus

Home sagt immer, ob das Protokoll in deinem Netzwerk läuft. Ist es
wegen eines Vorfalls pausiert, stoppen neue Positionen, Claims,
Auszahlungen, Liquidationen, Defaults und Keeper-Schritte. Volle
Rückzahlung, Teilrückzahlung und das Nachlegen von Sicherheiten
bleiben offen, und die pausierte Zeit wird zum Fälligkeitsdatum
jedes offenen Loans addiert. Eine automatische Pause dauert eine
feste Zeit, und eine neue kann erst nach einer Abkühlphase
beginnen. Der Keeper-Dienst kann separat pausiert werden; das
blockiert nie etwas, das du selbst tust. Ist der Status nicht
lesbar, sagt Home das oben, statt anzunehmen, dass alles läuft.

<a id="home-payouts"></a>

### Home: Bereit zum Abholen

Eine Auszahlung ist bereit, wenn ein Loan beendet ist und ein Claim
dich jetzt bezahlen würde: die Rückzahlung für den Verleiher, die
Sicherheit (oder was davon übrig ist) für den Leihenden, oder ein
NFT, das am Ende einer Miete zurückkommt. Home listet sie zuerst
und schickt dich zu Claims, wo jeder Betrag vor dem Abholen steht.

<a id="home-loans"></a>

### Home: Deine Loans

Jeder laufende Loan zeigt deine Seite, seine Bedingungen, seine
Sicherheit und seine nächste Frist, die dringendste zuerst. Ein
Loan ist an seinem Fälligkeitsdatum fällig. Danach läuft eine
Kulanzfrist, in der der Leihende noch mit einer Verspätungsgebühr
zurückzahlen kann. Endet sie, kann jeder den Default auslösen, der
den Loan aus der Sicherheit begleicht. Der Health Factor vergleicht
den Wert der Sicherheit mit der Schuld: unter 1 kann der Loan
liquidiert werden. Ein Loan in einem Asset ohne Preis hat keinen
Health Factor. Loans aus einem deiner Angebote werden zusammen
gezeigt.

Ein Loan mit periodischer Zinszahlung hat zusätzlich Stichtage, bis einschließlich seines Fälligkeitsdatums. Zinsen, die nach der Kulanzfrist eines Stichtags noch offen sind, können durch den Verkauf von Sicherheiten bezahlt werden, und der Loan bleibt offen; Home zeigt den nächsten Stichtag und stellt einen offenen nach vorn, auch wenn er auf das Fälligkeitsdatum fällt, weil seine Kulanzfrist vor der des Loans enden kann. Das Protokoll kann diese Abrechnung abschalten; Home sagt dann, dass an einem Stichtag keine Sicherheit verkauft wird.

<a id="home-exposure"></a>

### Home: Verliehen und geliehen

Wenn du verleihst und leihst, vergleicht Home beide Seiten nach dem
heutigen Wert. Loans, die nicht bewertet werden können, etwa NFTs
oder Assets ohne Preis, werden gezählt und herausgelassen, und Home
nennt die größere Seite nur, wenn sie das Ergebnis nicht ändern
könnten.

<a id="home-faucet"></a>

### Home: Test-Assets

Auf einem Testnetz bietet Home Test-Token und NFTs an, damit du Leihen, Verleihen und Mieten ohne echtes Geld ausprobieren kannst. Sie haben keinen Wert und werden von Test-Token-Verträgen geprägt, nicht vom Protokoll. Manche Test-Token haben einen Testpreis, sodass Kredite in ihnen einen Health Factor haben; andere haben keinen, sodass ein Ausfall die Sicherheit selbst übergibt. Die Test-NFTs lassen sich vermieten. Jede Prägung zeigt zuerst einen Beleg, und das Ergebnis wird danach auf der Chain geprüft.

<a id="home-fee-discount"></a>

### Home: Gebührenrabatt

Der Gebührenrabatt ist eine Einstellung pro Netzwerk für deine ganze Wallet. Solange er aus ist, erhalten deine Gebühren keinen Rabatt, egal wie viel VPFI du hältst. Solange er an ist, wird die Gebühr beim Leihen reduziert, ebenso die Gebühr auf Zinsen, die du als Verleiher verdienst, und zwar nach deiner VPFI-Rabattstufe im Moment, in dem die Gebühr anfällt; bei Stufe 0 gibt es keinen. In manchen Netzwerken wird der Verleiher-Rabatt in VPFI aus deinem Vault bezahlt, und der Beleg sagt dir vor dem Bestätigen, welcher Fall gilt. Zum Einschalten müssen die aktuellen Bedingungen akzeptiert sein; zum Ausschalten nie. Während das Protokoll pausiert ist, lässt sich die Einstellung in keine Richtung ändern. Ein Kredit in einem illiquiden Kreditasset zahlt weiterhin die volle Gebühr beim Leihen, und kein Rabatt ist je mehr als die Hälfte der Gebühr.

<a id="home-rewards"></a>

### Home: Belohnungen

Belohnungen sind Nutzungsrabatte für Ihr Verleihen und Leihen in diesem Netzwerk, werden pro Belohnungstag gezählt und in VPFI ausgezahlt. Home zeigt genau, was ein jetzt ausgeführter Claim auszahlen würde, weil die App den Claim zuerst als Vorschau ausführt. Kann diese Vorschau nicht laufen, zeigt Home stattdessen eine als solche gekennzeichnete Untergrenze und bietet den Claim erst an, wenn der genaue Betrag ermittelt werden kann. Ein Claim zahlt bis zu 30 Belohnungstage aus; bleibt mehr übrig, bietet Home einen weiteren Claim an, und ein Abbruch zwischendurch ist sicher. Ein Claim wird in Ihren Vault geliefert, sofort nutzbar, oder an Ihre Wallet, wenn der Vault ihn nicht aufnehmen kann; ein Claim eröffnet nie einen Vault. Wartet ein Belohnungstag noch auf seine netzwerkübergreifende Finalisierung oder auf seine Finanzierung in diesem Netzwerk, nennt Home diesen Tag, statt einen Claim anzubieten, der scheitern würde. Belohnungen sind weder Zinsen noch Rendite, und ein Claim stakt oder reinvestiert nie etwas. Gelegentlich zahlt ein Claim nichts aus, rückt aber über Belohnungstage hinaus, die Ihnen nichts ausgezahlt haben, damit die Tage danach ausgezahlt werden können; Home sagt das und bietet ihn trotzdem an.

<a id="home-rewards-expiry"></a>

### Home: Entfernungstermine für Belohnungen

In einem Netzwerk, in dem nicht beanspruchte Belohnungen entfernt werden können, zeigt Home den frühesten geschätzten Entfernungstermin Ihrer Belohnungen und in den letzten 90 Tagen davor einen letzten Hinweis. Wer vorher beansprucht, behält die Belohnung immer. Die Schätzung liegt beim aktuellen Stand nie nach dem tatsächlichen Termin: Zeit, in der die Belohnung nicht beansprucht werden kann, verschiebt den tatsächlichen Termin nach hinten, eine Änderung des Claim-Fensters im Netzwerk kann ihn aber vorziehen, prüfen Sie also erneut, bevor Sie sich darauf verlassen. Konnte nicht jede Belohnung geprüft werden, sagt Home das, statt zu behaupten, nichts sei fällig. Wo das Netzwerk nichts entfernt, wird kein Termin angezeigt.

<a id="home-rewards-held"></a>

### Home: Zurückgehaltene Belohnungen

Markiert die Sanktionsprüfung Ihre Wallet, wird ihr nichts ausgezahlt, solange die Markierung besteht. Vor der Markierung verdiente Belohnungen werden für sie zurückgehalten, gesperrt, aber nicht verloren, und freigegeben, sobald die Wallet nicht mehr markiert ist; Home bietet dann an, genau diesen Betrag allein zu beanspruchen. Solange eine Markierung bestätigt ist, verfallen verdiente Belohnungen endgültig, und VPFI in Ihrem Vault kann nicht bewegt werden. Kann nicht gelesen werden, ob die Wallet noch markiert ist, wird nichts freigegeben.

<a id="borrow-start"></a>

### Borrow: So funktioniert es

Zum Leihen nimmst du das offene Angebot eines Verleihers an: einen Betrag eines Tokens, einen Zinssatz, eine Laufzeit und die Sicherheit, die der Verleiher verlangt. Die Annahme eröffnet den Kredit in einer Transaktion. Deine Sicherheit wandert aus deiner Wallet in deinen eigenen Vault und bleibt dort gesperrt, solange der Kredit läuft; der Betrag, abzüglich einer kleinen Eröffnungsgebühr, kommt in deiner Wallet an. Du zahlst Betrag und Zinsen bis zum Fälligkeitstag zurück. Passt kein Angebot, kannst du auch eine eigene Kreditanfrage stellen und auf einen Verleiher warten.

<a id="borrow-pair"></a>

### Borrow: Die Tokens wählen

Wähle zuerst, was du leihen und was du sperren willst. Die App schlägt Tokens im Netzwerk vor, oder du fügst eine Token-Adresse ein; es läuft keine Sicherheitsprüfung für Tokens, prüfe eine eingefügte Adresse also selbst. Für jeden Token liest die App, was das Protokoll jetzt dazu sagt. Ein liquider Token hat einen Preis, der Kredit hat also einen Health Factor und kann liquidiert werden, wenn die Sicherheit an Wert verliert. Ein illiquider Token wird mit null bewertet, und bei einem Ausfall erhält der Verleiher die Sicherheit selbst. Traut das Protokoll dem Preis eines Tokens nicht, sind neue Kredite darauf geschlossen, bis es wieder vertraut; offene Kredite sind nicht betroffen.

<a id="borrow-offers"></a>

### Borrow: Ein Angebot auswählen

Die Seite listet die offenen Angebote von Verleihern für deine beiden Tokens, direkt aus dem Protokoll gelesen. Jedes zeigt Betrag, Zinssatz und Laufzeit, die verlangte Sicherheit, den Beleihungswert zu heutigen Preisen, wie Zinsen berechnet werden, einen etwaigen Zinsplan, wann das Angebot endet und was du nach der Gebühr erhalten würdest. Ein Angebot wird ganz angenommen, zum vollen Betrag und niedrigsten Zinssatz des Verleihers. Würde das Protokoll ein Angebot ablehnen, sagt die Seite warum und zeigt keine Schaltfläche. Die Reihenfolge ist eine Hilfe, keine Empfehlung.

<a id="borrow-review"></a>

### Borrow: Prüfen und Signieren

Bevor sich deine Wallet öffnet, zeigt die Prüfung jede Zahl: was du erhältst, die Gebühr, was du sperrst, den Zinssatz, was du am Fälligkeitstag schuldest, die Nachfrist und was du verlieren kannst. Du setzt ein Häkchen, um den Risikohinweisen und den Bedingungen zuzustimmen; ändern sich die Zahlen vor der Bestätigung, wird es entfernt. Dann bittet dich deine Wallet, die Bedingungen zu signieren (das kostet nichts), falls nötig genau die Sicherheit freizugeben und die Annahme zu senden, die die App zuerst als Probelauf ausführt. Stoppt es nach einer Freigabe, bittet die App darum, die Freigabe zurückzusetzen, und sagt, ob das geschah. Danach prüft die App auf der Chain den eröffneten Kredit, was ankam und was gesperrt wurde. Sie nennt auch die Laufzeitbedingungen des Kredits, jede auch dann, wenn sie dem Standard entspricht: Teilrückzahlung, Verkauf der Sicherheit sowie eine etwaige Refinanzierung oder ein verknüpfter Kredit. Der geschuldete Betrag gilt ohne Pause: Eine Pause verschiebt das Fälligkeitsdatum nach hinten, und die Zinsen laufen währenddessen weiter.

<a id="borrow-fee"></a>

### Borrow: Die Eröffnungsgebühr

Die Eröffnung eines Kredits kostet einen kleinen Anteil des Betrags, einmalig, im geliehenen Token, abgezogen von dem, was du erhältst; die Prüfung zeigt den geltenden Satz. Zinsen schuldest du auf den ganzen Betrag. Deine Rabattstufe senkt die Gebühr, wenn der Gebührenrabatt an ist und der geliehene Token liquide ist. Für diese Gebühr wird kein VPFI genommen oder gehalten, und später wird nichts erstattet. Da du die Annahme selbst sendest, kommt ein kleiner Anteil der Gebühr, den das Protokoll jedem zahlt, der ein Matching einreicht, mit dem Betrag zu dir zurück; die Prüfung zeigt ihn.

<a id="borrow-risks"></a>

### Borrow: Risiken

Ein Kredit kann dich deine Sicherheit kosten. Hast du bis zum Ende der Nachfrist nicht zurückgezahlt, fällt der Kredit aus und der Verleiher wird aus deiner Sicherheit bezahlt: für ihn verkauft, wo das Protokoll es kann, unverändert übergeben, wo nicht. Bei liquider Sicherheit kann jeder den Kredit liquidieren, wenn ihr Wert fällt, bis der Health Factor unter 1 sinkt, und du verlierst Sicherheit. Bei Zinsen für die volle Laufzeit schuldest du die Zinsen der ganzen Laufzeit auch bei früher Rückzahlung. Mit einem Zinsplan wird eine verpasste Periode durch den Verkauf eines Teils deiner Sicherheit bezahlt. Deine Sicherheit bleibt gesperrt, bis der Kredit zurückgezahlt oder abgewickelt ist.

<a id="borrow-request"></a>

### Borrow: Eine eigene Anfrage stellen

Passt kein Angebot, kannst du für deine beiden Tokens eine eigene Kreditanfrage stellen: den genauen Betrag, den Zinssatz, den du zahlst, die Laufzeit und die Sicherheit, die du sperrst. Beim Stellen wandert die Sicherheit aus deiner Wallet in deinen eigenen Vault und bleibt dort, solange die Anfrage offen ist. Ein Verleiher, der sie annimmt, eröffnet den Kredit sofort zu deinen Bedingungen, ohne dich noch einmal zu fragen; der Betrag, abzüglich der Eröffnungsgebühr, kommt in deiner Wallet an. Ab fünf Minuten nach dem Stellen kannst du stornieren, und die Sicherheit kehrt in deine Wallet zurück. Eine abgelaufene Anfrage kann nicht mehr angenommen werden; ihre Sicherheit bleibt in deinem Vault, bis du oder jemand anderes sie schließt, und geht dann nur an deine Wallet zurück. Solange die Angebotsseite der nächsten App noch nicht gebaut ist, verfolgst, stornierst und schließt du eine Anfrage auf der Angebotsseite der aktuellen App; die Prüfung sagt das, bevor etwas gesperrt wird.

<a id="borrow-request-terms"></a>

### Borrow: Die Bedingungen der Anfrage

Ein Verleiher übernimmt den ganzen Betrag oder keiner. Jede Zahl wird genau so gelesen, wie du sie eingibst: mehr Nachkommastellen, als der Token hat, werden abgelehnt, nie gerundet, und der Zinssatz geht bis 100 % im Jahr mit zwei Nachkommastellen. Die angebotenen Laufzeiten enden bei der längsten, die das Netzwerk erlaubt; du kannst eine Laufzeit auch in Tagen eingeben. Die Anfrage bleibt offen, bis sie angenommen oder storniert wird, oder so viele Tage, wie du wählst, höchstens ein Jahr. Zinsen für die volle Laufzeit, die übliche Wahl, sind auch bei früher Rückzahlung ganz geschuldet; anteilige Zinsen fallen nur für die Zeit an, in der der Kredit läuft. Das Formular zeigt, was du zum heutigen Gebührensatz erhalten und am Fälligkeitstag schulden würdest, wenn ein Verleiher jetzt annähme.

<a id="borrow-request-review"></a>

### Borrow: Anfrage prüfen und stellen

Bevor sich deine Wallet öffnet, lässt die App das Protokoll deine Anfrage als Probelauf ausführen, sodass die Prüfung die eigene Antwort des Protokolls zeigt. Sie nennt, was du jetzt sperrst, Betrag, Zinssatz und Laufzeit, was du erhalten würdest und wie die Gebühr bestimmt wird (der bei der Annahme geltende Gebührensatz, abzüglich deiner Gebührenrabattstufe in diesem Moment; die angezeigte Zahl nutzt den heutigen Satz), was du schulden würdest, jede Laufzeitbedingung, wann die Anfrage abläuft, den Beleihungswert und ob eine Freigabe nötig ist. Du setzt ein Häkchen, um den Risikohinweisen und den Bedingungen zuzustimmen. Deine Wallet gibt, falls nötig, genau die Sicherheit frei, die App führt die Anfrage erneut als Probelauf aus und stellt sie erst dann. Stoppt es nach einer Freigabe, bittet die App darum, die Freigabe zurückzusetzen, und sagt, ob das geschah. Danach prüft die App auf der Chain die erfasste Anfrage und die gesperrte Sicherheit.

<a id="risk-access"></a>

### Risk Access: Ihre Risikostufe

Jedes Konto beginnt auf der niedrigsten Risikostufe, nur Blue-Chip-Assets, und nur Sie können sie anheben. Ein Paar braucht die Stufe seines riskanteren Tokens: Blue-Chip-Tokens brauchen nichts, andere liquide Tokens brauchen „Liquide Assets“, und ein illiquider Token braucht „Jedes Asset, auch illiquide“ sowie Ihre Zustimmung zu genau diesem Paar. Wenn das Annehmen eines Angebots oder das Stellen einer Anfrage einen solchen Schritt braucht, sagt die Prüfung das an Ort und Stelle und bietet ihn als eine Wallet-Bestätigung mit eigenem Beleg an: was sich ändert, welche Paare es betrifft, wann es wirksam wird und dass keine Mittel bewegt werden. Das Anheben der Stufe oder die Zustimmung zu einem Paar kann eine vom Protokoll festgelegte Wartezeit haben; die App zeigt dann den Zeitpunkt des Inkrafttretens, von der Chain gelesen, und bietet denselben Schritt nie zweimal an, weil ein zweiter die Wartezeit neu starten würde. Das Senken der Stufe wirkt immer sofort. Veröffentlicht das Protokoll neue Risikobedingungen, zählen Ihre Stufe und Zustimmungen erst wieder, wenn Sie sie erneut bestätigen. Haben Sie den strengen Modus eingeschaltet, braucht auch jedes liquide Paar Ihre Bestätigung. Eine Sperre durch die Risikostufe des Kreditgebers wird als seine gezeigt: Nichts in Ihrem Konto würde sie ändern.

<a id="terms-gate"></a>

### Die Abfrage der Nutzungsbedingungen

Wo eine Version der Nutzungsbedingungen gilt, bittet dich die App, sie vor einer Aktion zu akzeptieren, die etwas Neues beginnt, etwa das Einschalten des Gebührenrabatts, und nennt die Aktion, die gefragt hat. Sie zeigt die Version, einen Fingerabdruck ihres Textes und einen Link zu genau dieser Version, deren Text sich nie ändert. Das Akzeptieren ist eine Bestätigung in der Wallet und bewegt keine Mittel. Kann die App nicht lesen, ob du akzeptiert hast, sagt sie das und lässt dich es erneut versuchen, statt es als Nein zu werten. Zurückzahlen, Forderungen einlösen, eigene Assets abheben, eigene Angebote stornieren und eine Zustimmung ausschalten werden nie aufgehalten.
