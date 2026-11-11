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

<a id="alerts-inbox"></a>

### Der Alerts-Posteingang

Die Seite Alerts listet die Hinweise, die der Index des Protokolls für deine Wallet im aktuellen Netzwerk führt, die neuesten zuerst. Sie ist kostenlos, und du musst dich für nichts anmelden. Ein Hinweis entsteht, wenn ein Kredit startet, teilweise oder vollständig zurückgezahlt wird, ausfällt oder liquidiert wird, sich seiner Fälligkeit nähert, in seine Nachfrist eintritt oder sie verlässt oder seine Gesundheit unter 1,5, 1,2 oder 1,05 fällt, und wenn sich ein Belohnungseintrag seiner Einlösefrist nähert oder sie überschreitet. Jeder Hinweis öffnet den Kredit, dessen Seite ihn von der Chain liest, oder bei einer Belohnung die Seite Claims. Die Glocke neben deiner Wallet oben zählt die Hinweise, die seit deinem letzten Öffnen der Seite in diesem Browser eingegangen sind. Kann der Index nicht gelesen werden, sagt die Seite das, statt einen leeren Posteingang zu zeigen. Telegram, Push, Gesundheitswarnungen und Zahlungserinnerungen richtest du direkt unter dem Posteingang ein. Jede Benachrichtigung beschreibt den Stand zu dem Zeitpunkt, als sie geschrieben wurde; öffnen Sie den Kredit, um den aktuellen Stand zu sehen.

<a id="alerts-channels"></a>

### Telegram, Push und Warnungen

Unter dem Posteingang richtet die Seite Alerts Hinweise ein, die dich außerhalb der App erreichen. Jede Änderung ist eine kostenlose Signatur in deiner Wallet, keine Transaktion. Um Telegram zu verbinden, tippe auf Telegram verbinden, sende den Einmalcode innerhalb von zehn Minuten an den Vaipakam-Bot und sende dann eine Testnachricht: Die Verbindung gilt als funktionierend, sobald diese Nachricht deinen Chat erreicht. Push wird nur angeboten, wenn der Hinweisdienst sagt, dass er gerade senden kann; zusätzlich abonnierst du den Vaipakam-Kanal in deiner Push-App und kündigst ihn dort, um Push zu beenden. Gesundheitswarnungen sind immer an, sobald Telegram oder Push eingerichtet ist, bei Gesundheit 1,5, 1,2 und 1,05. Zahlungserinnerungen lassen sich aus- und einschalten. Die Seite zeigt, was dieser Browser getan hat; eine Verbindung oder Einstellung von einem anderen Gerät kann trotzdem bestehen.

<a id="alerts-paid-push"></a>

### Kostenpflichtige Push-Hinweise

In manchen Netzwerken berechnet der Hinweisdienst für Push-Hinweise zu einem Kredit eine kleine Gebühr in VPFI. Er kann sie dir nur berechnen, wenn du vorher on-chain zustimmst, und höchstens bis zu dem Betrag, dem du zugestimmt hast. Der Bereich Kostenpflichtige Push-Hinweise zeigt die Gebühr in diesem Netzwerk und ob der Dienst hier berechnet. Die Gebühr wird aus freiem VPFI in deinem Tresor genommen, höchstens einmal pro Kreditseite, wenn der erste kostenpflichtige Push-Hinweis zu diesem Kredit gesendet wird; eine bereits berechnete Gebühr wird nicht erstattet, und Telegram-Hinweise sind kostenlos. Eine Gebührenerhöhung innerhalb deiner Obergrenze wird ohne erneute Nachfrage berechnet. Du kannst die Zustimmung jederzeit zurückziehen.

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
nichts von dir angezeigt, bis du wechselst. Tippe oben auf deine Adresse, um sie vollständig zu sehen, sie zu kopieren, in ein anderes Netzwerk der App zu wechseln oder die Verbindung zu trennen. Die App zeigt die Adresse selbst, keinen Namen aus einem Namensdienst, denn sie liest nichts im Ethereum-Mainnet.

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

Jeder gewählte Token zeigt außerdem, welchen Rang er nach Marktwert hat, nach zwei öffentlichen Listen von Tokens. Abgeglichen wird über die Vertragsadresse des Tokens im Netzwerk, nie über seinen Namen. Ein Blue Chip gehört zu den Top 20 und wird vom Protokoll bepreist; danach folgen die Top 100, 200, 300 und 500. Ein Token außerhalb der Top 500 wird als Nutzung auf eigenes Risiko markiert. Ein Token, der Namen oder Symbol eines gelisteten Tokens unter einer anderen Adresse trägt, wird als mögliche Kopie markiert, mit der Adresse des echten Tokens; wenn sich die beiden Listen uneinig sind, wo ein Token liegt, wird er als nicht bestätigt markiert. Das Datum der Listen wird angezeigt, und eine fehlgeschlagene Aktualisierung wird genannt. In einem Testnetzwerk haben Tokens keinen Marktwert und keinen Rang. Um einen Token zu finden, tippen Sie Namen oder Symbol in das Feld Anderer Token: Gelistete Tokens stehen zuerst, jeweils mit Stufe und vollständiger Adresse, und eine Auswahl trägt die Adresse ein. Prüfen Sie die Adresse, nicht den Namen. Die Stufe ist nur eine Orientierung und ändert nichts an dem, was das Protokoll tut.

<a id="borrow-offers"></a>

### Borrow: Ein Angebot auswählen

Die Seite listet die offenen Angebote von Verleihern für deine beiden Tokens, direkt aus dem Protokoll gelesen. Jedes zeigt Betrag, Zinssatz und Laufzeit, die verlangte Sicherheit, den Beleihungswert zu heutigen Preisen, wie Zinsen berechnet werden, einen etwaigen Zinsplan, wann das Angebot endet und was du nach der Gebühr erhalten würdest. Ein Angebot wird ganz angenommen, zum vollen Betrag und niedrigsten Zinssatz des Verleihers. Würde das Protokoll ein Angebot ablehnen, sagt die Seite warum und zeigt keine Schaltfläche. Die Reihenfolge ist eine Hilfe, keine Empfehlung.

Zuerst nennt die Seite die zwei Wege zu leihen: jetzt ein Angebot annehmen oder mit einer Anfrage deinen eigenen Zinssatz festlegen und auf einen Verleiher warten. Angebote sind nach Zinssatz gruppiert, der niedrigste zuerst, und jede Stufe zeigt, wie viele Angebote sie enthält und den Betrag jedes einzelnen; die Beträge werden nie addiert, da du ein Angebot ganz annimmst. Du kannst den höchsten Zinssatz eingeben, den du akzeptierst; er blendet Angebote nur aus und sagt, wie viele. Neben der Anfrage zeigt die Seite die Verleiher, die für dein Paar bereitstehen: Ein Abgleichdienst füllt eine Anfrage aus ihren Mitteln, wenn ihre Bedingungen in deren Grenzen passen, daher ist eine Füllung wahrscheinlich, aber weder sofort noch garantiert. Ist der Abgleich mit diesen Verleihern in diesem Netzwerk abgeschaltet, sagt die Seite stattdessen das, und kann das nicht gelesen werden, sagt sie, dass nicht bekannt ist, ob eine Anfrage erfüllt würde. Ihre eigenen stehenden Angebote werden nie mitgezählt. Stehende Verleiher erfüllen nur Anfragen, die die Zinsen der vollen Laufzeit berechnen und keine Teilrückzahlung zulassen; im Anfrageformular wird eine Wahl, die sie ausschließt, genannt. Hat das Protokoll alle Keeper in diesem Netzwerk pausiert, sagt die Seite, dass der Abgleichdienst keine Anfrage erfüllt, bis sie wieder laufen, ein Verleiher eine Anfrage aber weiterhin aus seinem eigenen stehenden Angebot erfüllen kann. Stehende Verleiher erfüllen außerdem keine Anfrage, die Zinsen nach einem Zahlungsplan zahlt. Ein Verleiher, der nur von ihm gewählte Füller gegen sein Angebot füllen lässt, wird getrennt gezeigt, ohne die wahrscheinliche Füllung, denn ob der Abgleichdienst einer davon ist, ist nicht bekannt. Solange das Protokoll pausiert ist, sagt die Seite, dass bis zur Wiederaufnahme keine Anfrage eingestellt oder gegen sie gefüllt wird.

<a id="borrow-review"></a>

### Borrow: Prüfen und Signieren

Bevor sich deine Wallet öffnet, zeigt die Prüfung jede Zahl: was du erhältst, die Gebühr, was du sperrst, den Zinssatz, was du am Fälligkeitstag schuldest, die Nachfrist und was du verlieren kannst. Du setzt ein Häkchen, um den Risikohinweisen und den Bedingungen zuzustimmen; ändern sich die Zahlen vor der Bestätigung, wird es entfernt. Dann bittet dich deine Wallet, die Bedingungen zu signieren (das kostet nichts), falls nötig genau die Sicherheit freizugeben und die Annahme zu senden, die die App zuerst als Probelauf ausführt. Stoppt es nach einer Freigabe, bittet die App darum, die Freigabe zurückzusetzen, und sagt, ob das geschah. Danach prüft die App auf der Chain den eröffneten Kredit, was ankam und was gesperrt wurde. Sie nennt auch die Laufzeitbedingungen des Kredits, jede auch dann, wenn sie dem Standard entspricht: Teilrückzahlung, Verkauf der Sicherheit sowie eine etwaige Refinanzierung oder ein verknüpfter Kredit. Der geschuldete Betrag gilt ohne Pause: Eine Pause verschiebt das Fälligkeitsdatum nach hinten, und die Zinsen laufen währenddessen weiter. Die Prüfung zeigt auch, wie hoch das Protokoll Betrag und Sicherheit jetzt bewertet; diese Zahlen dienen nur der Information und ändern sich mit dem Preis.

<a id="borrow-fee"></a>

### Borrow: Die Eröffnungsgebühr

Die Eröffnung eines Kredits kostet einen kleinen Anteil des Betrags, einmalig, im geliehenen Token, abgezogen von dem, was du erhältst; die Prüfung zeigt den geltenden Satz. Zinsen schuldest du auf den ganzen Betrag. Deine Rabattstufe senkt die Gebühr, wenn der Gebührenrabatt an ist und der geliehene Token liquide ist. Für diese Gebühr wird kein VPFI genommen oder gehalten, und später wird nichts erstattet. Da du die Annahme selbst sendest, kommt ein kleiner Anteil der Gebühr, den das Protokoll jedem zahlt, der ein Matching einreicht, mit dem Betrag zu dir zurück; die Prüfung zeigt ihn.

<a id="borrow-risks"></a>

### Borrow: Risiken

Ein Kredit kann dich deine Sicherheit kosten. Hast du bis zum Ende der Nachfrist nicht zurückgezahlt, fällt der Kredit aus und der Verleiher wird aus deiner Sicherheit bezahlt: für ihn verkauft, wo das Protokoll es kann, unverändert übergeben, wo nicht. Bei liquider Sicherheit kann jeder den Kredit liquidieren, wenn ihr Wert fällt, bis der Health Factor unter 1 sinkt, und du verlierst Sicherheit. Bei Zinsen für die volle Laufzeit schuldest du die Zinsen der ganzen Laufzeit auch bei früher Rückzahlung. Mit einem Zinsplan wird eine verpasste Periode durch den Verkauf eines Teils deiner Sicherheit bezahlt. Deine Sicherheit bleibt gesperrt, bis der Kredit zurückgezahlt oder abgewickelt ist.

<a id="borrow-request"></a>

### Borrow: Eine eigene Anfrage stellen

Passt kein Angebot, kannst du für deine beiden Tokens eine eigene Kreditanfrage stellen: den genauen Betrag, den Zinssatz, den du zahlst, die Laufzeit und die Sicherheit, die du sperrst. Beim Stellen wandert die Sicherheit aus deiner Wallet in deinen eigenen Vault und bleibt dort, solange die Anfrage offen ist. Ein Verleiher, der sie annimmt, eröffnet den Kredit sofort zu deinen Bedingungen, ohne dich noch einmal zu fragen; der Betrag, abzüglich der Eröffnungsgebühr, kommt in deiner Wallet an. Ab fünf Minuten nach dem Stellen kannst du stornieren, und die Sicherheit kehrt in deine Wallet zurück. Eine abgelaufene Anfrage kann nicht mehr angenommen werden; ihre Sicherheit bleibt in deinem Vault, bis du oder jemand anderes sie schließt, und geht dann nur an deine Wallet zurück. Solange die Angebotsseite der nächsten App noch nicht gebaut ist, verfolgst, stornierst und schließt du eine Anfrage auf der Angebotsseite der aktuellen App; die Prüfung sagt das, bevor etwas gesperrt wird. Unter jedem Betrag, den du eingibst, zeigt das Formular, wie hoch das Protokoll ihn jetzt bewertet, in seiner eigenen Einheit; für ein Asset ohne Preis sagt es das statt einer Zahl.

<a id="borrow-request-terms"></a>

### Borrow: Die Bedingungen der Anfrage

Ein Verleiher übernimmt den ganzen Betrag oder keiner. Jede Zahl wird genau so gelesen, wie du sie eingibst: mehr Nachkommastellen, als der Token hat, werden abgelehnt, nie gerundet, und der Zinssatz geht bis 100 % im Jahr mit zwei Nachkommastellen. Die angebotenen Laufzeiten enden bei der längsten, die das Netzwerk erlaubt; du kannst eine Laufzeit auch in Tagen eingeben. Die Anfrage bleibt offen, bis sie angenommen oder storniert wird, oder so viele Tage, wie du wählst, höchstens ein Jahr. Zinsen für die volle Laufzeit, die übliche Wahl, sind auch bei früher Rückzahlung ganz geschuldet; anteilige Zinsen fallen nur für die Zeit an, in der der Kredit läuft. Das Formular zeigt, was du zum heutigen Gebührensatz erhalten und am Fälligkeitstag schulden würdest, wenn ein Verleiher jetzt annähme.

<a id="borrow-request-review"></a>

### Borrow: Anfrage prüfen und stellen

Bevor sich deine Wallet öffnet, lässt die App das Protokoll deine Anfrage als Probelauf ausführen, sodass die Prüfung die eigene Antwort des Protokolls zeigt. Sie nennt, was du jetzt sperrst, Betrag, Zinssatz und Laufzeit, was du erhalten würdest und wie die Gebühr bestimmt wird (der bei der Annahme geltende Gebührensatz, abzüglich deiner Gebührenrabattstufe in diesem Moment; die angezeigte Zahl nutzt den heutigen Satz), was du schulden würdest, jede Laufzeitbedingung, wann die Anfrage abläuft, den Beleihungswert und ob eine Freigabe nötig ist. Du setzt ein Häkchen, um den Risikohinweisen und den Bedingungen zuzustimmen. Deine Wallet gibt, falls nötig, genau die Sicherheit frei, die App führt die Anfrage erneut als Probelauf aus und stellt sie erst dann. Stoppt es nach einer Freigabe, bittet die App darum, die Freigabe zurückzusetzen, und sagt, ob das geschah. Danach prüft die App auf der Chain die erfasste Anfrage und die gesperrte Sicherheit.

<a id="borrow-nft-collateral"></a>

### Borrow: Ein NFT als Sicherheit

Eine Anfrage kann statt eines Tokens ein NFT sperren. Wählen Sie die Sammlung als das, was Sie sperren (die Test-Sammlungen sind als NFTs gekennzeichnet, oder fügen Sie eine Adresse ein); ob eine Adresse ein Token oder eine NFT-Sammlung ist, wird aus ihrem Vertrag gelesen. Geben Sie dann die Nummer des NFT ein, seine Token-ID, die Ihre Wallet oder die Seite der Sammlung zeigt; das Formular sagt sofort, ob Ihre Wallet es hält. Das Protokoll bewertet ein NFT mit null, egal wofür es anderswo verkauft wird: Ein Darlehen darauf hat keinen Beleihungswert und keine preisbasierte Liquidation, und zahlen Sie bis zum Ende der Kulanzfrist nicht zurück, erhält der Kreditgeber das NFT selbst. Beim Stellen bittet die App Ihre Wallet, dem Protokoll nur dieses eine NFT freizugeben, nie den Rest Ihrer Sammlung, und die Übertragung in Ihren Tresor hebt diese Freigabe von selbst auf; stoppt die Anfrage nach der Freigabe, bittet die App, sie zurückzusetzen, und sagt, ob das geschah. NFTs, die in Stückzahlen vorkommen (Multi-Token-Sammlungen), funktionieren genauso, mit einer Menge: Geben Sie die Nummer des Tokens ein und wie viele davon Sie sperren, und das Formular sagt, wie viele Ihre Wallet hält. Eine solche Sammlung kann kein einzelnes Token freigeben, nur alle Ihre Tokens darin; daher erteilt das Einstellen diese Freigabe nur für diese Anfrage und nimmt sie danach in einem weiteren Wallet-Schritt zurück, ob die Anfrage durchging oder nicht; eine Freigabe, die Sie schon vorher erteilt hatten, bleibt, wie Sie sie gesetzt haben. Das Annehmen eines Kreditgeberangebots, das ein NFT verlangt, geschieht vorerst weiterhin in der aktuellen App.

<a id="borrow-request-range"></a>

### Borrow: Eine Betragsspanne (Erweitert)

Im erweiterten Modus kann eine Anfrage eine Spanne annehmen: den kleinsten und den größten Betrag, den ein Kreditgeber verleihen darf, zu Ihrem einen Zinssatz, und auf Wunsch eine kleinere Sicherheit für den kleinsten Kredit. Ein Kreditgeber, der die Anfrage direkt annimmt, verleiht den kleinsten Betrag und sperrt nur die dafür festgelegte Sicherheit; der Rest geht an Ihre Wallet zurück. Matches dürfen mehr verleihen, bis zum größten Betrag, solange das Matching im Netzwerk eingeschaltet ist; die Prüfung sagt, ob es das ist, und dass die Spanne bei ausgeschaltetem Matching nur einmal gefüllt wird. Das Protokoll lehnt einen größten Betrag ab, den Ihre Sicherheit zu heutigen Preisen nicht trägt, und die Prüfung nennt das Höchste, was sie trägt. Die Prüfung zeigt den Beleihungswert an beiden Enden und warnt, wenn ein Kreditgeber die Anfrage zu heutigen Preisen nicht direkt annehmen könnte. Im erweiterten Modus gesetzte Optionen gelten weiter, wenn Sie zu Basis wechseln: Das Formular sagt es und lässt Sie sie löschen. Ein Match sperrt nur die Sicherheit, die sein Kreditgeber verlangt, mindestens aber den Boden; daher nennt die Prüfung den größten Match von deiner ganzen Sicherheit bis hinunter zum Boden und warnt, dass ein gematchter Kredit riskanter starten kann als ein direkter. Solange das Matching eingeschaltet ist, bleibt die Sicherheit, die ein Match nicht sperrt, für spätere Matches bei der Anfrage und kommt erst an Ihre Wallet zurück, wenn die Anfrage schließt oder Sie sie stornieren.

<a id="borrow-request-fill"></a>

### Borrow: Wie eine Anfrage gefüllt wird (Erweitert)

Teilweise, die Voreinstellung, lässt Matches die Anfrage über einen oder mehrere Kredite füllen, bis sie gefüllt, storniert oder abgelaufen ist. Alles oder nichts erlaubt eine einzige Füllung des ganzen Betrags und geht daher nicht mit einer Spanne. Sofort oder stornieren füllt wie teilweise, aber nur bis die Anfrage abläuft, und braucht daher ein Ablaufdatum. Der Füllmodus lässt sich nach dem Veröffentlichen nicht ändern; um ihn zu ändern, stornieren Sie die Anfrage und veröffentlichen eine neue. Das Protokoll erlaubt, Beträge, Zinssatz und Sicherheit zu ändern, solange die Anfrage offen ist, nie unter das, was Matches schon genutzt haben; diese App bietet das noch nicht an, daher bedeutet eine Änderung vorerst Stornieren und neu Veröffentlichen.

<a id="borrow-request-cadence"></a>

### Borrow: Ein Zinsplan (Erweitert)

Im erweiterten Modus kann eine Anfrage die Zinsen nach einem Plan zahlen statt alles bei der Rückzahlung: jeden Monat, jedes Quartal, alle sechs Monate oder jedes Jahr. Das Formular bietet nur die Pläne an, die das Protokoll für deine Bedingungen zulässt, und nennt unter jedem geschlossenen den Grund: periodische Zinsen sind im Netzwerk abgeschaltet, ein Asset hat keinen Preis, der Kredit ist weniger wert als die Schwelle des Protokolls (beide Zahlen werden gezeigt), oder die Periode ist nicht kürzer als der Kredit. Die Prüfung zeigt die Zinsen jeder Periode und die Nachfrist einer versäumten Periode. Wird eine Periode bis zum Ende ihrer Nachfrist nicht bezahlt, darf jeder einen Teil deiner Sicherheit verkaufen, um sie zu bezahlen, und der Kredit bleibt offen. Der Plan lässt sich nach dem Veröffentlichen nicht mehr ändern. Wie die anderen erweiterten Optionen gilt er auch nach dem Wechsel zu Basis weiter, und das Formular sagt es.

<a id="borrow-request-tariff"></a>

### Borrow: Der Full-Gebührentarif (Erweitert)

Im erweiterten Modus kann eine Anfrage den Full-Gebührentarif nehmen: eine Gebühr in VPFI, die beim Eröffnen jedes Kredits aus Ihrem Tresor genommen wird und den Rabatt auf die Kreditgebühr um zehn Punkte erhöht, bis zur Obergrenze des Protokolls von 50 %. Die Kreditgebühr selbst wird weiterhin im verliehenen Vermögenswert berechnet, und der Tarif wird nicht erstattet. Das Formular bietet ihn nur an, solange das Protokoll ihn eingeschaltet hat, und zeigt den heutigen Tarif für Betrag und Laufzeit. Sie legen fest, wie viel VPFI ein Kredit höchstens nehmen darf (leer gelassen: der heutige Tarif für den größten Kredit), und was mit einem Kredit geschieht, der den Tarif beim Eröffnen nicht nehmen kann: Er wird abgelehnt oder ohne ihn eröffnet. Ein Kredit kann ihn nur nehmen, wenn in diesem Moment der Tarif eingeschaltet ist, der verliehene Vermögenswert einen Preis hat und liquide ist, sein Tarif innerhalb Ihres Höchstwerts liegt und Ihr Tresor genug freie VPFI hält. Der Tarif wird mit einer zweiten Transaktion nach dem Veröffentlichen gesetzt; ein Kreditgeber, der die Anfrage vorher übernimmt, eröffnet einen Kredit ohne ihn. Backstop-Kredite für Anfragen, die niemand übernimmt, bietet diese App noch nicht an.

<a id="lend-start"></a>

### Lend: So funktioniert es

Um zu verleihen, finanzieren Sie die offene Anfrage eines Kreditnehmers: einen Betrag eines Tokens, den Zinssatz, den er zahlt, eine Laufzeit und Sicherheiten, die der Kreditnehmer bereits in seinem eigenen Tresor gesperrt hat. Die Finanzierung eröffnet den Kredit in einer Transaktion. Der Betrag verlässt Ihre Wallet, der Kreditnehmer erhält ihn abzüglich seiner Eröffnungsgebühr, und die Sicherheiten bleiben bis zum Ende des Kredits für Sie gesperrt. Ihre Seite des Kredits ist ein Positions-Token in Ihrer Wallet; wer es hält, wird zurückgezahlt. Der Kreditnehmer zahlt den Betrag plus Zinsen bis zum Fälligkeitsdatum zurück, und das Protokoll behält seinen Anteil an den Zinsen. Passt keine Anfrage, können Sie stattdessen auf derselben Seite ein eigenes Kreditangebot veröffentlichen.

<a id="lend-offers"></a>

### Lend: Eine Anfrage auswählen

Wählen Sie zuerst, was Sie verleihen und welche Sicherheiten Sie akzeptieren; es müssen verschiedene Token sein, und diese Seite bietet nur Token an. Die Seite listet die für dieses Paar offenen Kreditanfragen, direkt aus dem Protokoll gelesen. Jede zeigt Betrag, Zinssatz und Laufzeit, die gesperrten Sicherheiten, den Beleihungswert zu heutigen Preisen, wie Zinsen berechnet werden, einen etwaigen Zinsplan und wie viel von der Gebühr des Kreditnehmers an Sie zurückfließt. Eine Anfrage wird vollständig finanziert: Nennt sie eine Spanne, verleihen Sie den kleinsten Betrag des Kreditnehmers zu seinem höchsten Zinssatz. Würde das Protokoll eine Anfrage ablehnen, sagt die Seite warum und bietet keine Schaltfläche an. Ihre eigenen Anfragen, Anfragen mit einem NFT und Verkäufe laufender Kredite werden gezählt, nicht gelistet. Die Reihenfolge (finanzierbare Anfragen zuerst, dann der höchste Zinssatz) ist eine Hilfe, keine Empfehlung.

<a id="lend-review"></a>

### Lend: Prüfen und Signieren

Bevor Ihre Wallet sich öffnet, zeigt die Prüfung jede Zahl: was Ihre Wallet verlässt, was der Kreditnehmer erhält, die Gebühr und Ihren Anteil daran, die für Sie gehaltenen Sicherheiten, den Zinssatz, die am Fälligkeitsdatum geschuldeten Zinsen, den Anteil des Protokolls daran, was an Sie zurückfließt, die Nachfrist und was Sie verlieren können. Sie nennt außerdem jede Lebenszyklus-Bedingung, auch wenn sie der Standard ist. Hält Ihre Wallet weniger als den Betrag, sagt die Prüfung, wie viel fehlt, und bietet keine Signatur an. Sie setzen ein Häkchen, um den Risikohinweisen und Bedingungen zuzustimmen; ändern sich die Zahlen vor der Bestätigung, wird das Häkchen entfernt. Ihre Wallet bittet Sie dann, die Bedingungen zu signieren, was nichts kostet, genau den Betrag freizugeben, falls nötig, und die Annahme zu senden, die die App zuerst als Probelauf ausführt. Stoppt der Ablauf nach einer Freigabe, bietet die App an, die Freigabe zurückzusetzen, und sagt, ob das geschehen ist. Danach prüft die App auf der Chain den eröffneten Kredit, was Ihre Wallet verlassen hat und was zurückgekommen ist.

<a id="lend-fee"></a>

### Lend: Die Gebühr und der Anteil des Protokolls

Die Eröffnungsgebühr trägt der Kreditnehmer: ein kleiner Anteil des Betrags, einmal im verliehenen Vermögenswert berechnet und von dem abgezogen, was der Kreditnehmer erhält. Sie verleihen den ganzen Betrag, und der Kreditnehmer schuldet ihn vollständig mit Zinsen zurück. Weil Sie die Annahme selbst senden, fließt ein kleiner Teil dieser Gebühr, der Anteil, den das Protokoll dem Einreicher eines Matches zahlt, in Ihre Wallet zurück; die Prüfung zeigt ihn. Hat der Kreditnehmer den Full-Gebührentarif gewählt und greift er beim Eröffnen, ist die Gebühr niedriger und damit auch dieser Anteil. Werden Zinsen gezahlt, behält das Protokoll seinen Anteil daran, zu dem Satz, der beim Eröffnen des Kredits gilt; Ihre Gebührenrabattstufe kann diesen Anteil senken, solange Ihre Gebührenrabatt-Einstellung an ist. Die Prüfung zeigt den heutigen Satz und das Höchste, was dieser Anteil nehmen kann.

<a id="lend-risks"></a>

### Lend: Risiken

Beim Verleihen können Sie Geld verlieren. Hat der Kreditnehmer bis zum Ende der Nachfrist nicht zurückgezahlt, fällt der Kredit aus und Sie werden aus den Sicherheiten bezahlt: für Sie verkauft, wo das Protokoll es kann, unverändert übergeben, wo nicht; ein Verkauf kann weniger einbringen, als Ihnen geschuldet wird. Bei liquiden Sicherheiten kann jeder den Kredit liquidieren, sobald sein Health Factor unter 1 fällt; der Verkauf zahlt Sie zuerst, aber ein starker Kursrückgang kann weniger übrig lassen, als Ihnen geschuldet wird. Ein illiquider Token wird mit null bewertet, daher gibt es keine preisbasierte Liquidation, und bei einem Ausfall erhalten Sie alle Sicherheiten, was immer sie wert sind. Sie können den Betrag nicht vor Ende des Kredits zurücknehmen; früher aussteigen heißt, Ihre Position an einen anderen Kreditgeber zu verkaufen. Bei anteiligen Zinsen bringt eine vorzeitige Rückzahlung Ihnen weniger. Eine Pause verschiebt das Fälligkeitsdatum nach hinten, und die Zinsen laufen währenddessen weiter.

<a id="lend-offer"></a>

### Lend: Ein eigenes Angebot veröffentlichen

Passt keine Anfrage, können Sie für Ihre zwei Token ein eigenes Kreditangebot veröffentlichen: den genauen Betrag, den Sie verleihen, den Zinssatz, den Sie verlangen, die Laufzeit und die Sicherheit, die ein Kreditnehmer sperren muss. Beim Veröffentlichen wandert der Betrag aus Ihrer Wallet in Ihren eigenen Vault und bleibt dort gesperrt, solange das Angebot offen ist. Ein Kreditnehmer, der es annimmt, eröffnet den Kredit sofort zu Ihren Bedingungen, ohne Sie erneut zu fragen: Er erhält den Betrag abzüglich seiner Eröffnungsgebühr, und seine Sicherheit wird in seinem Vault für Sie gesperrt. Solange das Matching im Netzwerk eingeschaltet ist, kann jeder Ihr Angebot außerdem mit der Anfrage eines Kreditnehmers zusammenführen; ohne Teile verleiht ein solcher Kredit Ihren gesamten Betrag zu Ihrem Zinssatz, gegen mindestens die Sicherheit, die Sie verlangen. Die Prüfung sagt, ob das Matching gerade eingeschaltet ist. Ab fünf Minuten nach dem Veröffentlichen können Sie stornieren, und der Betrag kehrt in Ihre Wallet zurück. Ein abgelaufenes Angebot kann nicht mehr angenommen werden; sein Betrag bleibt in Ihrem Vault, bis Sie oder irgendjemand es schließt, und kehrt dann nur in Ihre Wallet zurück. Bis die Angebotsseite der nächsten App gebaut ist, verfolgen, stornieren und schließen Sie ein Angebot auf der Angebotsseite der aktuellen App; die Prüfung sagt das, bevor etwas gesperrt wird.

<a id="lend-offer-terms"></a>

### Lend: Die Bedingungen des Angebots

Sofern Sie im Advanced-Modus keine Teile festlegen, übernimmt ein Kreditnehmer den ganzen Betrag, oder niemand, und muss genau die Sicherheit sperren, die Sie festlegen. Das Formular zeigt, wie viel des verliehenen Tokens Ihre Wallet hält. Jede Zahl wird genau so gelesen, wie Sie sie eingeben: Mehr Nachkommastellen, als der Token hat, werden abgelehnt, nie gerundet, und der Zinssatz reicht bis 100 % pro Jahr mit zwei Nachkommastellen. Die angebotenen Laufzeiten enden bei der längsten, die das Netzwerk erlaubt. Das Angebot bleibt offen, bis es angenommen oder storniert wird, oder für die Zahl von Tagen, die Sie wählen, höchstens ein Jahr. Zinsen für die volle Laufzeit, die übliche Wahl, bedeuten, dass eine vorzeitige Rückzahlung Ihren Ertrag nicht senkt; anteilige Zinsen zahlen Ihnen nur die Zeit, in der der Kredit läuft. Sie können dem Kreditnehmer auch Teilrückzahlungen erlauben. Das Formular zeigt, was der Kreditnehmer Ihnen am Fälligkeitsdatum schulden würde, wenn er das Angebot jetzt annähme. Im Advanced-Modus kann ein Angebot auch in Teilen verliehen werden, einen Ausführungsmodus tragen, Zinsen nach Plan zahlen und den Full-Gebührentarif nehmen.

<a id="rate-check"></a>

### Ihren Zinssatz mit aktuellen Krediten vergleichen

Unter dem Zinssatz zeigt die App auf beiden Formularen, dem Angebot eines Verleihers und der Anfrage eines Kreditnehmers, den mittleren Zinssatz der Kredite, die in den letzten 30 Tagen mit demselben Paar und derselben Laufzeit begonnen haben, und wie viele es waren. Liegt Ihr Satz mehr als fünf Prozentpunkte daneben, warnt die App und sagt, in welche Richtung das wirkt: Ein Verleiher weit unter dem Markt oder ein Kreditnehmer weit darüber stellt das Angebot ein, das zuerst angenommen wird, wenn sich die Zinsen bewegen; in die andere Richtung bleibt das Angebot womöglich liegen. Es ist nur eine Warnung, Sie können trotzdem posten. Gibt es keine aktuellen Kredite zum Vergleich, ist die Sicherheit ein NFT oder kann der Index des Protokolls nicht gelesen werden, sagt das Formular das, statt zu schweigen.

<a id="public-queue"></a>

### Netzwerke mit öffentlicher Warteschlange

Auf Ethereum, BNB Chain und Polygon (und dem BNB Testnet sowie Polygon Amoy) wartet eine gesendete Transaktion in einer öffentlichen Warteschlange, bevor sie aufgenommen wird, und wer diese Warteschlange beobachtet, auch Bots, kann sie sehen und zuerst handeln: ein Angebot annehmen, bevor Ihre Stornierung ankommt, oder auf einen Kredit reagieren, bevor Ihre Rückzahlung ankommt. Auf diesen Netzwerken sagt die Prüfung beim Einstellen, Annehmen oder Stornieren eines Angebots, beim Zurückzahlen und beim Nachlegen von Sicherheiten das deshalb, bevor sich Ihre Wallet öffnet. Manche Wallets können eine Transaktion stattdessen privat senden; sehen Sie in den Netzwerk- oder Sicherheitseinstellungen Ihrer Wallet nach. Die App kann diesen Weg nicht für Sie wählen, und der übliche Weg ändert nur, wer die Transaktion sieht, bevor sie ankommt. Base, Arbitrum und Optimism haben keine öffentliche Warteschlange, dort wird nichts angezeigt.

<a id="lend-offer-parts"></a>

### Lend: Ein Angebot in Teilen (Erweitert)

Im Advanced-Modus kann ein Kreditangebot in Teilen verliehen werden. Der eingegebene Betrag bleibt der ganze Betrag: Beim Veröffentlichen wird alles gesperrt, und ein Kreditnehmer, der Ihr Angebot direkt annimmt, leiht alles. Sie geben den kleinsten Teil an, den ein Match verleihen darf. Solange das Matching im Netzwerk eingeschaltet ist, dürfen Matcher Ihr Angebot an mehrere Kreditnehmer verleihen, jeden Kredit zwischen dem kleinsten Teil und dem Rest, zu Ihrem Zinssatz. Jeder verlangt mindestens den Anteil Ihrer Sicherheit, der zu seinem Teil passt, abgerundet, und die Prüfung zeigt, was der kleinste Teil verlangt. Hat ein Match einen Teil verliehen, kann kein Kreditnehmer den Rest direkt annehmen; nur weitere Matches können das, und Sie können das Angebot stornieren, um den Rest zurückzunehmen. Bleibt weniger als der kleinste Teil übrig, gibt das Protokoll ihn an Ihre Wallet zurück und schließt das Angebot. Die Prüfung sagt, ob das Matching gerade eingeschaltet ist; solange es aus ist, eröffnet nur ein Kreditnehmer, der alles annimmt, einen Kredit. Der Ausführungsmodus wirkt wie bei einer Anfrage: standardmäßig teilweise, alles oder nichts für einen Kredit über den ganzen Betrag (also keine Teile) oder sofort oder storniert, was einen Ablauf braucht; er lässt sich nach dem Veröffentlichen nicht ändern. Das Protokoll lehnt ein Angebot ab, das weniger Sicherheit verlangt, als der ganze Betrag zu heutigen Preisen braucht, und die Prüfung nennt das Mindeste, das es verlangt. Im Advanced-Modus gesetzte Optionen gelten weiter, wenn Sie zu Basic wechseln: Das Formular sagt das und lässt Sie sie löschen.

<a id="lend-offer-schedule"></a>

### Lend: Ein Zinsplan für ein Angebot (Erweitert)

Im erweiterten Modus kann ein Kreditangebot wie eine Anfrage einen Zinsplan tragen: jeden Monat, jedes Quartal, alle sechs Monate oder jedes Jahr. Das Formular bietet nur die Pläne an, die das Protokoll für Ihre Bedingungen erlaubt, und sagt unter jedem geschlossenen, warum. Mit Teilen prüft das Protokoll beim Veröffentlichen den kleinsten Teil, sodass ein kleinster Teil unter seiner Schwelle die feineren Pläne schließt; jeder Kredit wird bei seiner Eröffnung erneut geprüft. Die Prüfung zeigt die Zinsen jeder Periode, wenn ein Kreditnehmer alles übernimmt, und mit Teilen für einen Kredit über den kleinsten Teil, sowie die Nachfrist einer versäumten Periode. Wird eine Periode bis zum Ende ihrer Nachfrist nicht bezahlt, darf jeder einen Teil der Sicherheit des Kreditnehmers verkaufen, um sie Ihnen zu zahlen, und der Kredit bleibt offen. Der Plan kann nach dem Veröffentlichen nicht geändert werden.

<a id="lend-offer-tariff"></a>

### Lend: Der Full-Gebührentarif für ein Angebot (Erweitert)

Im erweiterten Modus kann ein Kreditangebot den Full-Gebührentarif nehmen: eine Gebühr in VPFI, die beim Eröffnen jedes Kredits aus dem Angebot aus Ihrem Tresor genommen wird, bemessen nach Betrag und Laufzeit dieses Kredits. Dafür erhält der Anteil des Protokolls an den Zinsen dieses Kredits zehn Punkte mehr Rabatt, bis zu seiner Obergrenze von 50 %; der Anteil wird weiterhin im verliehenen Vermögenswert genommen. Die zusätzlichen Punkte gelten für die Laufzeit des Kredits: Wird der Kredit um eine neue Laufzeit verlängert, enden sie für diese. Sie gehören zur Kreditgeberposition, also erhält sie, wer diese hält, wenn Zinsen gezahlt werden. Der Tarif wird nicht erstattet. Das Formular zeigt den heutigen Tarif für den ganzen Betrag, den größten Kredit, den das Angebot eröffnet. Sie legen fest, wie viel VPFI ein Kredit höchstens nehmen darf und ob ein Kredit, der den Tarif nicht nehmen kann, abgelehnt wird oder ohne ihn eröffnet. Ein Kredit kann ihn nur nehmen, wenn in diesem Moment der Tarif eingeschaltet ist, der verliehene Vermögenswert bepreist und liquide ist, sein Tarif innerhalb Ihres Höchstwerts liegt und Ihr Tresor genug freies VPFI hält. Der Tarif wird durch eine zweite Transaktion nach dem Veröffentlichen gesetzt; ein Kredit, der vor deren Bestätigung aus dem Angebot eröffnet wird, durch einen Kreditnehmer oder ein Match, eröffnet ohne ihn.

<a id="lend-offer-review"></a>

### Lend: Angebot prüfen und veröffentlichen

Bevor sich Ihre Wallet öffnet, lässt die App das Protokoll Ihr Angebot probeweise ausführen, sodass die Prüfung die eigene Antwort des Protokolls zeigt. Sie nennt, was Sie jetzt sperren, den Betrag, den ein Kreditnehmer übernimmt, die Sicherheit, die er sperren muss, Zinssatz und Laufzeit, was der Kreditnehmer zum heutigen Gebührensatz erhielte, die Zinsen am Fälligkeitsdatum, den Anteil des Protokolls daran und was an Sie zurückfließt, jede Bedingung für die Laufzeit des Kredits, wann das Angebot abläuft, den Beleihungsauslauf zu heutigen Preisen und ob eine Freigabe nötig ist. Hält Ihre Wallet weniger als den Betrag, sagt die Prüfung, wie viel fehlt, und bietet keine Signatur an. Sie setzen ein Häkchen, um den Risikohinweisen und den Bedingungen zuzustimmen. Ihre Wallet gibt bei Bedarf genau den Betrag frei, die App führt das Angebot erneut probeweise aus und veröffentlicht es erst dann. Bricht es nach einer Freigabe ab, bittet die App, die Freigabe zurückzusetzen, und sagt, ob das geschehen ist. Danach prüft die App auf der Chain das erfasste Angebot und den in Ihrem Vault gesperrten Betrag.

<a id="lend-offer-fee"></a>

### Lend: Gebühren bei Ihrem Angebot

Das Veröffentlichen eines Angebots kostet Sie keine Gebühr. Die Eröffnungsgebühr trägt der Kreditnehmer: ein kleiner Anteil des Betrags, einmal im verliehenen Asset erhoben, wenn ein Kreditnehmer Ihr Angebot annimmt, zum dann geltenden Satz, und von dem abgezogen, was er erhält. Sie verleihen den ganzen Betrag, und der Kreditnehmer schuldet ihn vollständig mit Zinsen zurück. Werden Zinsen gezahlt, behält das Protokoll seinen Anteil daran, zum Satz, der bei Eröffnung des Kredits gilt; Ihre Gebührenrabattstufe kann diesen Anteil senken, solange Ihre Gebührenrabatt-Einstellung aktiv ist. Die Prüfung zeigt den heutigen Satz und das Höchste, was dieser Anteil nehmen kann; lässt sich der Satz nicht lesen, sagt die Prüfung das, statt eine Zahl zu zeigen.

<a id="positions"></a>

### Positions: Ihre Kreditpositionen

Positions listet jeden Kredit, den Sie in diesem Netzwerk vergeben oder aufgenommen haben, anhand der Positions-Token in Ihrer Wallet. Eine Position, die Sie an jemand anderen übertragen haben, verschwindet daher aus Ihrer Liste. Zuerst kommen Auszahlungen, die zum Abholen bereitstehen; sie öffnen Claims. Dann folgen laufende Kredite, die dringendste Frist zuerst, wie auf Home. Zuletzt kommen beendete Kredite, jeweils mit ihrem Ende: zurückgezahlt, ausgefallen, abgewickelt oder durch ein Matching geschlossen. Ein beendeter Kredit, dessen Auszahlung noch wartet, verweist Sie auf Claims.

Alle, Verliehen und Geliehen grenzen alle drei Listen zugleich ein. Positions sagt nur dann, dass Sie nichts haben, wenn alles gelesen wurde; konnte eine Liste nicht vollständig gelesen werden, steht das dort. Jeder Kredit öffnet seine eigene Seite, die zeigt, welche Aktionen Ihnen offenstehen. Die Liste selbst signiert nie etwas.

Bei zwei oder mehr laufenden Krediten steht eine Übersicht an erster Stelle. Für jede Seite nennt sie das noch geschuldete oder noch verliehene Kapital je Token (Beträge in verschiedenen Token werden nie zusammengezählt, NFT-Vermietungen werden gezählt), den nächsten Fälligkeitstermin einer Zahlung mit einem Link zu seinem Kredit sowie die überfälligen Kredite und die Kredite im Fallback, jeweils verlinkt. Zinsen sind in diesen Summen nicht enthalten; die Seite jedes Kredits zeigt, was die Rückzahlung jetzt kostet. Bei einer Vermietung ist dieses Datum das Ende der Miete, die im Voraus bezahlt ist; es heißt daher nie Rückzahlung.

<a id="position"></a>

### Position: Ein Kredit

Jeder Kredit hat eine eigene Seite. Sie beginnt mit dem Status des Kredits, dann Ihre Rolle: die Seite, die Ihre Wallet jetzt hält, denn Positions-Token können verkauft oder übertragen werden. Halten Sie keine Seite, sehen Sie den Kredit nur an. Eine Frist, die Sie betrifft, ist für Ihre Seite formuliert. Ist die Kulanzfrist vorbei, sagt die Seite, dass jetzt jeder den Ausfall einleiten kann, und nur, wenn das Protokoll es bestätigt.

Darunter folgen die Daten des Kredits (das Fälligkeitsdatum der aktuellen Laufzeit vor einer Pausengutschrift, Zeit, die während einer Protokollpause gutgeschrieben wurde, das Fälligkeitsdatum und das Ende der Kulanzfrist), seine Bedingungen, wie sie jetzt stehen (eine Teilrückzahlung senkt den noch geschuldeten Kapitalbetrag), sein Health Factor und wo seine Sicherheit liegt. Eine Zahl, die nicht gelesen werden konnte, wird als unbekannt angezeigt. Hat die Sicherheit keinen Preis, erhält der Kreditgeber bei einem Ausfall die Sicherheit selbst, und die Seite sagt das. Hält das Netzwerk knapp über der Liquidationsschwelle ein Band für einen internen Abgleich mit einem anderen Kredit zurück, nennt die Seite es: Innerhalb dieses Bands kann kein externer Verkauf den Kredit schließen. Eine NFT-Miete hat keine Sicherheit: Fällt sie aus, endet die Nutzung des Mieters, die vorausbezahlte Miete geht abzüglich des Protokollanteils an den Kreditgeber und der Puffer an die Treasury. Die vollständige und die teilweise Rückzahlung sowie das Hinzufügen und Zurücknehmen von Sicherheiten sind ihre ersten Aktionen; die anderen folgen in späteren Updates.

<a id="repay"></a>

### Vollständig zurückzahlen

Bei einem laufenden Kredit bietet die Seite an, ihn vollständig zurückzuzahlen. Zurückzahlen darf jeder außer dem Kreditgeber. Halten Sie die Kreditnehmerposition nicht, gibt Ihnen die Zahlung kein Recht auf die Sicherheit: Nur deren Inhaber kann sie abholen. Die Rückzahlung ist angehalten, sobald die Kulanzfrist abgelaufen ist (der Kredit geht dann in den Ausfall), und solange ein Swap-to-Repay-Auftrag offen ist.

Der geschuldete Betrag wächst mit jeder Sekunde, und das Protokoll nimmt den Betrag zum Zeitpunkt, an dem Ihre Rückzahlung bestätigt wird. Die Prüfung zeigt zwei Zahlen: was es jetzt kostet und was es etwa dreißig Minuten später kosten würde. Ihre Wallet genehmigt genau die zweite Zahl. Hatten Sie schon mehr genehmigt, auch unbegrenzt, wird die Genehmigung für die Rückzahlung auf diese Zahl gesenkt, denn die Rückzahlung kennt selbst keinen Höchstbetrag. Die Genehmigung begrenzt den Betrag, nicht die Zeit: Eine später bestätigte Rückzahlung geht nur durch, solange der geschuldete Betrag noch hineinpasst, sonst wird sie abgelehnt und nichts bewegt sich. Bei einem Kredit, der die volle Laufzeit berechnet, wächst der Betrag vor dem Fälligkeitsdatum nicht, sodass auch eine spätere Rückzahlung noch durchgehen kann. Was die Rückzahlung von der Genehmigung nicht verbraucht, wird danach zurückgesetzt. Dann holt der Kreditnehmer die Sicherheit und der Kreditgeber Kapital und Zinsen unter Claims ab.

Ist der Kredit über sein Fälligkeitsdatum hinaus und in der Nachfrist, zählt die Prüfung nach der Uhr der Chain bis zum Ende der Nachfrist herunter. Danach lehnt das Protokoll eine Rückzahlung ab und jeder kann einen Ausfall melden; die Transaktion, die zuerst gemined wird, gewinnt. Senden Sie die Rückzahlung also rechtzeitig; bei einer Stunde oder weniger sagt die Prüfung, dass Sie jetzt senden sollen. Eine Teilzahlung zeigt denselben Countdown.

<a id="interest-schedule"></a>

### Zinsplan

Ein Kredit mit Zinsplan schuldet Zinsen in jeder Periode (ein Monat, ein Quartal, sechs Monate oder ein Jahr), nicht erst am Ende. Seine Seite zeigt die laufende Periode: wann sie endet, wann ihre Kulanzfrist endet, welche Zinsen sie schuldet, was darauf gezahlt wurde und was noch offen ist. Die Zinsen einer Periode werden auf Kapitalbetrag und Zinssatz berechnet, wie sie jetzt stehen, daher senkt eine Teilrückzahlung sie.

Sind eine Periode und ihre Kulanzfrist vorbei, darf jeder sie abrechnen. Eine bezahlte Periode rückt nur den Stichtag vor; bei einer noch offenen wird gerade so viel Sicherheit des Kreditnehmers verkauft, wie die offene Summe und die Kosten des Verkaufs decken. Die Seite sagt, ob die Abrechnung jetzt offen ist. Sie nennt den Schalter des Netzwerks für die periodische Abrechnung, wenn er aus ist (dann kann nichts abgerechnet und keine Sicherheit verkauft werden), und die Protokollpause, solange sie dauert (die Abrechnung ruht, und die pausierte Zeit wird den Daten der Periode hinzugefügt). Eine Pause verschiebt die Daten der Periode um die pausierte Zeit nach hinten, doch die Zinsen, die eine Periode schuldet, bleiben die einer Periode; Zinsen laufen während der Pause weiter, und jeder Zins, den eine Rückzahlung zahlt, zählt für die Periode.

<a id="partial-repay"></a>

### Einen Teil des Kredits zurückzahlen

Der Inhaber der Kreditnehmerposition kann auf der Seite eines laufenden Kredits einen Teil des Kapitals zurückzahlen, wenn die Bedingungen des Kredits das erlauben. Geben Sie den Kapitalteil ein: Das Protokoll nimmt mindestens seinen Mindestteil für den verliehenen Token und weniger als das gesamte Kapital an (alles zurückzuzahlen ist „Vollständig zurückzahlen“). Die seit der letzten Zinszahlung aufgelaufenen Zinsen kommen hinzu. Der Kredit läuft mit dem niedrigeren Kapital weiter, und sein Fälligkeitsdatum verschiebt sich nicht.

Die Prüfung zeigt den Teil, die Zinsen, das verbleibende Kapital und was die Freigabe abdeckt. Bei einem Pro-rata-Kredit vor seinem Fälligkeitsdatum sind die Zinsen exakt. Bei einem Kredit mit voller Laufzeitverzinsung oder nach dem Fälligkeitsdatum steht dort „höchstens“: Die Protokollzahl, die die App liest, enthält auch den Rest der Laufzeit oder eine Verzugsgebühr, die eine Teilzahlung nicht berechnet. Eine Teilzahlung wird zurückgehalten, solange eine Refinanzierungsanfrage für den Kredit oder ein Offset-Angebot auf der Kreditnehmerposition aktiv ist, und sobald die Nachfrist abgelaufen ist.

<a id="add-collateral"></a>

### Sicherheiten hinzufügen

Wer die Kreditnehmerposition hält, kann einem laufenden Kredit auf dessen Seite Sicherheiten hinzufügen. Das erhöht den Health Factor des Kredits und senkt seinen Beleihungsauslauf, sodass er weiter von einer Liquidation entfernt ist. Sie fügen mehr vom selben Token hinzu, den der Kredit bereits hält: Das Protokoll nimmt keinen anderen und nimmt eine Aufstockung nur für Sicherheiten an, die es derzeit bewertet. Geben Sie den Betrag ein; das Formular zeigt, was Ihre Wallet hält.

Die Prüfung zeigt die Sicherheiten jetzt und danach, wo sie liegen (in Ihrem Tresor, bis zum Ende des Kredits an ihn gebunden), sowie Health Factor und Beleihungsauslauf des Kredits jetzt. Ihre Wallet genehmigt genau den Betrag, falls Ihre Genehmigung ihn nicht schon abdeckt, und die App probiert die Aufstockung zuerst als Testlauf. Danach zeigt die App Health Factor und Beleihungsauslauf, wie das Protokoll sie nach der Aufstockung berechnet. Das Hinzufügen bleibt auch möglich, während das Protokoll pausiert ist. Ein Kredit im Fallback läuft wieder normal, wenn die Aufstockung die Eröffnungsgrenzen des Protokolls wiederherstellt; andernfalls werden die Sicherheiten hinzugefügt und der Kredit bleibt im Fallback. Hinzugefügte Sicherheiten können mit den übrigen verloren gehen, wenn der Kredit liquidiert wird oder ausfällt. Haben Sie die Kreditnehmerposition übernommen und ist der Kredit im Fallback, geht die Aufstockung in den Vault des im Kredit vermerkten Kreditnehmers und wechselt nur dann in Ihren, wenn sie den Kredit wieder laufen lässt.

<a id="take-back-collateral"></a>

### Sicherheiten zurücknehmen

Solange ein Kredit läuft, kann wer die Kreditnehmerposition hält auf dessen Seite Sicherheiten zurücknehmen, die über das hinausgehen, was der Kredit braucht. Das Protokoll berechnet den Höchstbetrag so, dass der Health Factor mindestens beim Minimum des Kredits und der Beleihungsauslauf innerhalb seiner Obergrenze bei Eröffnung bleibt. Diese Grenze ändert sich mit den Preisen und mit auflaufenden Zinsen, und das Formular zeigt sie bei der Eingabe an. Das Zurücknehmen bringt den Kredit näher an eine Liquidation.

Die Prüfung zeigt die Sicherheiten jetzt und danach, dass sie aus Ihrem Vault in Ihre Wallet gehen, die aktuelle Grenze sowie Health Factor und Beleihungsauslauf jetzt. Eine Freigabe ist nicht nötig, daher fragt Ihre Wallet einmal, nachdem die App die Entnahme als Probelauf getestet hat. Das Protokoll prüft seine Grenzen erneut, wenn die Entnahme bestätigt wird: Haben sich die Preise bewegt und passt der Betrag nicht mehr, wird sie abgelehnt und nichts bewegt sich. Eine Protokollpause, ein offener Swap-to-Repay-Auftrag, eine bestehende Refinanzierungsanfrage oder ein Verkaufsangebot des Kreditgebers hält sie auf, und das Protokoll lässt Sicherheiten nur für einen Token zurücknehmen, den es bepreist. Ist für Ihr Konto der geschützte Modus aktiv, wartet die Sicherheit in dessen Auszahlungswarteschlange für die Verzögerung des Kontos, bevor sie Ihre Wallet erreicht, und die Überprüfung sagt das.

<a id="collect-a-payout"></a>

### Eine Auszahlung abholen

Wenn ein Kredit endet, hält das Protokoll fest, was jeder Seite zusteht, und der Inhaber jeder Position holt es auf der Seite des Kredits oder unter „Claims“ ab. Es zahlt an den, der die Position jetzt hält; eine gekaufte Position zahlt also an Sie. Die Auszahlung des Kreditgebers ist Kapital und Zinsen oder das, was ein Ausfall oder eine Liquidation erlöst hat, dazu für den Kreditgeber zurückgehaltene Mittel und bei einer Vermietung das vermietete NFT. Die Auszahlung des Kreditnehmers ist die zurückgegebene Sicherheit oder der Rest, dazu ein für den Kreditnehmer gehaltener Überschuss. Das Abholen verbrennt Ihr Positions-Token, und sobald beide Seiten abgeholt haben, ist der Kredit abgewickelt.

Die Prüfung listet jede Zahlung auf, die die Forderung leistet, was frühere Verkäufer einer Kreditgeberposition zuerst erhalten (verdiente, nicht gezahlte Zinsen) und wohin die Zahlung geht: in Ihre Wallet oder, bei aktivem Schutzmodus, in die Auszahlungswarteschlange Ihres Kontos oder in Ihren Tresor. Eine Genehmigung ist nicht nötig, Ihre Wallet fragt also einmal, nachdem die App die Forderung als Probelauf ausgeführt hat. Eine Pause des Protokolls stoppt jede Forderung. Solange ein Kredit im Fallback ist, wartet die Auszahlung des Kreditnehmers, bis der Kreditgeber abholt, und das beendet den Fallback: Der Kreditnehmer kann ihn nicht mehr heilen. Die Abschlusskarte zeigt, was die Transaktion tatsächlich gezahlt hat.

<a id="claim-everything"></a>

### Alles einfordern

Claims beginnt mit „Alles einfordern“: jede Auszahlung, die Sie jetzt einziehen können, gesammelt in einer Transaktion. Aufgeführt werden Kreditauszahlungen beendeter Kredite, deren Position Sie halten, Interaktionsbelohnungen, das nicht verliehene Kapital Ihrer stehenden Angebote, freies VPFI in Ihrem Tresor und, wenn Sie Zahlungsempfänger sind, abhebbare Gehaltszahlungen. Jede Auszahlung hat einen Schalter, sodass Sie jede davon auslassen können. Freies VPFI im Tresor ist aus, bis Sie es einschalten, weil es Ihre Gebührenrabattstufe bestimmt; ebenso das Kapital eines stehenden Angebots, das noch verleiht. Zinsen aus einer Position, die Sie verkauft haben, und ein Kredit im Fallback werden einzeln eingezogen. Jede Auszahlung läuft innerhalb der Transaktion für sich: eine, die das Protokoll ablehnt, wird übersprungen und bleibt aufgeführt, die übrigen werden trotzdem gezahlt. Eine Transaktion trägt höchstens 30 Auszahlungen; der Rest wartet auf eine zweite. Nichts verlässt Ihre Wallet, daher fragt Ihre Wallet einmal, nach einem Probelauf, und die Abschlusskarte zeigt jede Auszahlung als eingezogen oder übersprungen und wo das Geld angekommen ist. Eine Pause stoppt jede Einforderung.

<a id="payout-queue"></a>

### Auszahlungen in Ihrer Warteschlange

Bei aktivem Schutzmodus wartet alles, was Ihren Tresor in Richtung Ihrer Wallet verlässt, die Verzögerung Ihres Kontos in einer Auszahlungswarteschlange ab. „Claims“ listet auf, was dort wartet, das Früheste zuerst, jeweils mit einem kurzen Anfragecode: Jede Benachrichtigung zu einer Auszahlung zeigt denselben Code, sodass Sie eine Nachricht einer Anfrage zuordnen können. Jede Zeile nennt, was sie zahlt, wohin sie geht und ab wann sie freigegeben werden kann. Sobald eine Auszahlung fällig ist, kann jeder sie freigeben, und sie zahlt immer nur an das gespeicherte Ziel; ist dieses Ziel nicht mehr erlaubt, storniert die Freigabe sie stattdessen. Sie oder einer Ihrer zweiten Unterzeichner können eine Auszahlung jederzeit stornieren, auch während einer Pause, und der Vermögenswert bleibt in Ihrem Tresor. Verlangt Ihr Konto eine Genehmigung, genehmigt ein zweiter Unterzeichner jede Auszahlung zuerst; ein Unterzeichner findet Ihr Konto im Advanced-Modus, indem er dessen Adresse einfügt. Eine Pause hält Freigaben an, bis sie endet oder sich nach einer langen Pause der Notausgang öffnet. Jede Aktion fragt Ihre Wallet einmal, und die Abschlusskarte zeigt, was die Transaktion bewirkt hat.

<a id="seller-interest"></a>

### Zinsen aus einer verkauften Position

Wenn Sie eine Kreditgeberposition verkaufen, bleiben die Zinsen, die Sie in Ihrer Haltezeit verdient und noch nicht erhalten haben, als Anspruch auf den Kredit Ihre. Claims listet jeden Kredit, auf dem Sie einen solchen Anspruch halten, mit dem, was Ihnen nach dem Zinsanteil des Protokolls zusteht, und dem, was schon in Ihrem Vault wartet. Solange der Kredit läuft, bedient jede Zinszahlung zuerst die offenen Ansprüche, den ältesten zuerst, in den eigenen Vault jedes Verkäufers; bis etwas Ihren erreicht, gibt es nichts abzuheben. Ist der Kredit beendet, teilt die Abhebung zuerst auf, was die Kreditgeberseite zurückerhalten hat: zuerst das Kapital des Inhabers, dann jeden Verkäuferanspruch, den ältesten zuerst. Dabei schließen alle offenen Ansprüche, und was ein Anspruch nicht erhält, bleibt unbezahlt. Die Kredite stammen aus dem Index der App; kann er sie nicht auflisten, suchen Sie einen Kredit über seine Nummer, die allein von der Chain gelesen wird. Es ist keine Freigabe nötig, Ihre Wallet fragt also einmal, nach einem Probelauf, und die Abschlusskarte zeigt, was die Transaktion gezahlt hat.

<a id="frozen-proceeds"></a>

### Wenn eine Auszahlung eingefroren ist

Wenn das Sanktions-Screening Ihre Wallet markiert, nimmt das Protokoll nichts von dem, was Ihnen zusteht, und hält keinen Kredit vom Abschluss ab: Die Gegenseite erhält trotzdem, was ihre Seite erlöst. Ihr Anteil wird gesperrt in einem Tresor verwahrt und freigegeben, sobald Ihre Wallet von der Liste gestrichen ist. Claims und die Seite des Kredits zeigen dann „Eingefroren, wartet auf Streichung von der Liste“ und bieten keine Schaltfläche zum Einziehen an. Kann das Screening nicht gelesen werden und wurde Ihre Wallet zuvor als markiert bestätigt, bleibt eine eingefrorene Auszahlung gesperrt, bis das Screening wieder antwortet, und eine in dieser Zeit fällige Zahlung an Ihre Wallet wird ebenso verwahrt, weil das Protokoll sie weiter als markiert behandelt; ein Ausfall allein friert keine Wallet ein, die nie als markiert bestätigt wurde. Bei einem laufenden Kredit zeigt dessen Seite außerdem, was der Kredit bereits gezahlt hat und für die Kreditgeberposition reserviert ist, bis der Kreditgeber es einzieht, und ein zurückgezahlter Kredit sagt, wenn er auf einen Überschuss wartet, den der Kreditnehmer noch nicht eingezogen hat.

<a id="extension-reserves"></a>

### Verlängerungsreserven

Wenn Sie die Kreditnehmerposition eines Kredits halten, können Sie den Token des Kredits in Ihrem eigenen Tresor für dessen Verlängerungen zurücklegen. Eine Verlängerung, die des Keepers oder Ihre eigene, greift zuerst auf diese Reserve zu. Die Reserve bleibt Ihre. Claims listet jeden Kredit, bei dem Ihnen noch etwas davon bleibt, und sagt, ob eine Verlängerung noch darauf zugreifen kann: nur solange der Kredit läuft und Sie seine Kreditnehmerposition halten. Sie können die ganze Reserve jederzeit zurücknehmen, solange das Protokoll nicht pausiert ist, gleich in welchem Zustand der Kredit ist; läuft der Kredit noch, greift seine nächste Verlängerung dann stattdessen auf Ihr übriges Guthaben des Tokens zu. Die Kredite werden im Index der App gefunden; kann er sie nicht auflisten, suchen Sie einen Kredit über seine Nummer. Eine Freigabe ist nicht nötig, daher fragt Ihre Wallet einmal, nach einem Probelauf, und die Abschlusskarte zeigt, wo das Geld angekommen ist.

<a id="vault-holdings"></a>

### Ihr Tresor

Die Seite „Tresor“ zeigt Ihren eigenen Tresor im verbundenen Netzwerk: seine vollständige Adresse mit einem Link zum Explorer. Er ist ein Vertrag, den das Protokoll allein für Ihre Wallet führt; nichts darin wird mit dem Vermögen anderer vermischt, und Vermögenswerte verlassen ihn nur nach den Regeln des Protokolls. Haben Sie noch keinen Tresor, sagt die Seite das und bietet an, einen anzulegen; Ihre erste Einzahlung oder Ihr erstes Angebot würde ihn ohnehin anlegen. Das Anlegen bewegt nichts und verlangt keine Freigabe, daher fragt Ihre Wallet einmal. Jeder Vermögenswert zeigt drei Zahlen des Protokolls: Im Tresor (was das Protokoll dort als Ihres zählt), Jetzt frei abhebbar und Von Ihren Positionen gehalten (was Ihre Kredite, Angebote, Ansprüche, Reserven oder wartenden Auszahlungen binden). Ein Token, der per einfacher Überweisung in Ihren Tresor gelangt ist, wird nicht gezählt und kann erst abgehoben werden, wenn Sie ihn übernehmen; die Zeile sagt das und verlinkt dorthin, wo Sie ihn übernehmen oder ablehnen. Die Seite listet die Vermögenswerte, die Sie eingezahlt haben, und die, die Ihre Kredite, die von Ihnen erstellten Angebote und Ihre stehenden Angebote nennen; ein per einfacher Überweisung gesendeter Token erscheint also nur, wenn eine dieser Quellen ihn nennt. Kleine und leere Zeilen liegen hinter einem Schalter, der sie zählt. VPFI in Ihrem Tresor bestimmt Ihre Gebührenrabattstufe; es dafür zu halten verpfändet es nicht, und VPFI, das Sie für einen Kredit oder ein Angebot verpfänden, erscheint als gebunden. Jedes Asset mit einem freien Teil hat eine Schaltfläche zum Abheben.

<a id="vault-deposit"></a>

### In Ihren Tresor einzahlen

Einzahlen auf der Tresor-Seite bewegt einen Token oder ein NFT aus Ihrer Wallet in Ihren eigenen Tresor, außerhalb jedes Kredits. Wählen Sie, was Sie einzahlen: einen vorgeschlagenen Token oder eine Testsammlung, oder fügen Sie eine Adresse ein; ob es ein Token, ein NFT oder eine Multi-Token-Sammlung ist, wird aus seinem Vertrag gelesen. Geben Sie dann den Betrag, die Token-ID des NFT oder die Token-ID und die Anzahl ein. Gelten Nutzungsbedingungen, die Sie noch nicht akzeptiert haben, fragt die App zuerst danach, und vor dem Signieren erneut, wenn Sie zu einer Wallet wechseln, die sie nicht akzeptiert hat. Die Prüfung nennt, was Ihre Wallet verlässt und in welchen Tresor; haben Sie noch keinen, legt die Einzahlung ihn an. Ein Token verlangt eine Freigabe über genau den Betrag, ein NFT nur für dieses eine Token, und eine Multi-Token-Sammlung eine Freigabe, die direkt nach der Einzahlung in einem weiteren Wallet-Schritt zurückgenommen wird. Das Protokoll prüft die Einzahlung, bevor Ihre Wallet sie sendet, und lehnt einen Token ab, der nicht vollständig ankommt, etwa einen mit Gebühr beim Transfer. Geht die Einzahlung nicht durch, bittet die App, eine Freigabe zurückzusetzen. Was ankommt, zählt als Ihres. Ohne geschützten Modus können Sie es sofort abheben; mit ihm wartet eine Abhebung die Verzögerung Ihres Kontos ab, und solange das Konto gesperrt ist, verlässt nichts den Tresor. Die Prüfung nennt, was gilt. Solange das Protokoll pausiert ist, sind Einzahlungen geschlossen.

<a id="vault-withdraw"></a>

### Aus Ihrem Tresor abheben

Abheben an einem Asset der Tresor-Seite bringt den freien Teil zurück in Ihre Wallet. Frei heißt: von keinem Kredit, Angebot, Anspruch, stehenden Angebot und keiner wartenden Auszahlung gehalten; es zählt der Wert des Protokolls selbst, das Formular zeigt ihn und lehnt mehr ab. Ein NFT, das Ihr Einzahlungsverzeichnis nur über seine Sammlung nennt, heben Sie ab, indem Sie unter dieser Sammlung seine Token-ID eingeben. Die App hebt nur an die Wallet ab, die signiert. Die Prüfung nennt, was welchen Tresor verlässt und wohin es geht. Ohne geschützten Modus erreicht es Ihre Wallet sofort. Mit ihm stellt das Protokoll es für die Verzögerung Ihres Kontos in die Warteschlange, mit der Zustimmung eines Zweitunterzeichners, falls Ihr Konto eine verlangt; eine wartende Abhebung können Sie in der Auszahlungswarteschlange auf der Seite Ansprüche abbrechen, dann bleibt sie in Ihrem Tresor. Solange das Konto gesperrt ist, kann nichts abgehoben werden. Nichts verlässt Ihre Wallet, und keine Freigabe wird verlangt. Solange das Protokoll pausiert ist, sind Abhebungen geschlossen, bis sein Notausgang öffnet; siehe Wenn das Protokoll pausiert ist.

<a id="vault-safety"></a>

### Kontosicherheit

Die Karte Kontosicherheit auf der Tresor-Seite zeigt, ob Ihr Konto im geschützten Modus läuft, seine Verzögerung, ob ein zweiter Unterzeichner jede Freigabe genehmigen muss, ob Ihre Positions-NFTs geschützt sind, wie viele Auszahlungen in der Warteschlange warten und jede noch ausstehende Änderung. Mit eingeschaltetem geschützten Modus wartet jede Auszahlung aus Ihrem Tresor an Ihre Wallet eine Verzögerung ab, sodass ein Dieb, der Ihre Wallet übernimmt, Ihren Tresor nicht leeren kann, bevor Sie es bemerken; eine Zahlung an Sie aus dem Tresor eines anderen landet stattdessen in Ihrem Tresor, und nichts, was Sie anderen schulden, wird verzögert. Im Basismodus ist die Verzögerung die kürzeste, die das Protokoll erlaubt, zwei Tage, und der Schutz der Positions-NFTs bleibt aus; im erweiterten Modus wählen Sie bis zu fünf Tage und können Ihre Positions-NFTs schützen. Jetzt sperren storniert jede wartende Auszahlung (die Assets bleiben in Ihrem Tresor), stoppt neue Positionen und verwirft jede ausstehende Änderung; Rückzahlen und Sicherheiten nachschießen funktionieren weiter, und eine Sperre wirkt auch während einer Pause. Entsperren ist ein Antrag, der erst nach der Verzögerung Ihres Kontos wirkt; sobald er fällig ist, wendet Fällige Änderungen anwenden ihn an, zusammen mit jeder anderen fälligen Änderung. Ihre Auszahlungs-Warteschlange steht unter der Karte. Hat das Protokoll in diesem Netzwerk keinen geschützten Modus, sagt die Karte, dass er nicht verfügbar ist; lässt er sich nicht lesen, bietet die Karte keine Steuerung an und sagt, dass Sie nicht von „aus“ ausgehen sollen. Jede Aktion fragt Ihre Wallet einmal, und die Abschlusskarte zeigt, was das Protokoll verbucht hat.

<a id="vault-escape"></a>

### Wenn das Protokoll pausiert ist

Solange das Protokoll pausiert ist, sagt die Tresor-Seite das oben: Abhebungen sind geschlossen, während vollständige und teilweise Rückzahlung und das Nachschießen von Sicherheiten offen bleiben. Ist es eine administrative Pause, nennt sie auch, wann deren Notausgang öffnet, so wie das Protokoll es meldet, mit einem Countdown. Ist der Notausgang offen, bringt Abheben an jedem Asset mit freiem Anteil das, was Ihnen gehört, direkt zurück in Ihre Wallet; die Prüfung sagt, dass es über den Notausgang geht, und er gibt nie zurück, was ein Kredit, ein Angebot oder ein Anspruch hält. Mit geschütztem Modus warten Ihre Abhebungen wie gewohnt die Verzögerung Ihres Kontos in der Auszahlungs-Warteschlange ab. Eine automatische Pause oder ein noch nicht gestartetes Protokoll öffnet keinen Notausgang, und die Seite sagt, dass keiner geplant ist.

<a id="protection-addresses"></a>

### Gespeicherte Adressen

Die Seite Protection, verlinkt von der Karte Kontosicherheit, speichert die Adressen, denen Sie Auszahlungen anvertrauen, je Netzwerk und Wallet. Die Liste liegt nur in diesem Browser; ein anderer Browser oder ein anderes Gerät hat eine eigene. Um eine Wallet zu speichern, die Sie kontrollieren, geben Sie ihr einen Namen und fügen ihre Adresse ein: Die Seite zeigt sie vollständig und bittet Sie zu bestätigen, dass Sie sie geprüft haben. Dann erstellt sie einen Link. Öffnen Sie ihn in der Wallet-App, die diese Adresse hält, verbinden Sie diese Wallet und signieren Sie; das Signieren bewegt nichts und kostet nichts. Fügen Sie den angezeigten Code wieder in die Seite ein, und die Wallet ist als geprüft gespeichert. Eine Einzahlungsadresse einer Börse kann nicht signieren; sie wird daher ungeprüft unter dem Namen der Börse gespeichert, sobald Sie drei Risiken akzeptieren: Bei einer falschen Adresse ist das Gesendete verloren, die Börse schreibt eine Einzahlung aus Ihrem Vault vielleicht nicht gut, und die Börse kann die Adresse später jemand anderem geben. Überall, wo die App eine Adresse für Geld oder Kontrolle annimmt, lehnt sie eine Adresse ab, deren erste drei und letzte drei Zeichen einer bereits genutzten Adresse gleichen, während der Rest abweicht; so fängt Address Poisoning Menschen, die aus ihrem Verlauf kopieren.

<a id="protection-destinations"></a>

### Auszahlungsziele

Bei eingeschaltetem geschützten Modus zeigt die Seite Protection auch Ihre Auszahlungsziele: neben Ihrer eigenen Wallet höchstens fünf Adressen, an die eine geschützte Auszahlung gehen darf. Ein Ziel wird nur aus Ihren gespeicherten Adressen gewählt. Die Anfrage, eines hinzuzufügen, ändert zunächst nichts: Es wird nach der Verzögerung Ihres Kontos nutzbar, muss dann innerhalb einer weiteren Verzögerung aktiviert werden und verfällt sonst; danach kann es erneut angefragt werden. Sie oder ein zweiter Unterzeichner können eine wartende Anfrage abbrechen, und eine Sperre bricht jede Anfrage ab. Das Entfernen eines Ziels wirkt sofort und bricht jede an es gereihte Auszahlung ab; die Werte bleiben in Ihrem Vault. Jede Änderung fragt Ihre Wallet einmal, ihre Prüfung zeigt die Adresse vollständig, und die Abschlusskarte zeigt, was das Protokoll erfasst hat. Ist der geschützte Modus aus, gehen Auszahlungen nur an Ihre Wallet, und die Seite sagt, dass Ziele nicht gelten.

<a id="protection-signers"></a>

### Zweitsignierer

Bei eingeschaltetem Schutzmodus listet die Protection-Seite auch Ihre Zweitsignierer: andere Wallets, die Sie besitzen, etwa eine Hardware-Wallet, und die das Konto absichern. Ein Signierer kann jede wartende Änderung abbrechen, das Konto sperren, eine eingereihte Auszahlung abbrechen oder sie mitsignieren, wenn Mitsignaturen verlangt sind, ein Auszahlungsziel entfernen und gemeinsam mit den anderen Signierern dem Ersetzen Ihrer Haupt-Wallet zustimmen. Er kann nie etwas aus Ihrem Vault bewegen, keine Position eröffnen und kein Auszahlungsziel und keinen Signierer hinzufügen. Ein Signierer wird nur aus Ihren gespeicherten Wallets gewählt, die ihre Kontrolle durch eine Signatur bewiesen haben. Die Anfrage ändert zunächst nichts: Die Seite zeigt einen Link, den die angefragte Wallet öffnet, um mit ihrem eigenen Schlüssel anzunehmen. Sobald Ihre Wartezeit vorbei ist und sie angenommen hat, muss die Anfrage innerhalb einer weiteren Wartezeit aktiviert werden, sonst verfällt sie und muss abgebrochen werden, bevor Sie erneut fragen. Auch das Entfernen eines Signierers wartet Ihre Wartezeit ab, und ein anderer Signierer kann es abbrechen. Sie können außerdem für jede Auszahlung die Mitsignatur eines Signierers verlangen: Das Einschalten gilt sofort, das Ausschalten wartet Ihre Wartezeit ab, und das Entfernen Ihres letzten Signierers schaltet es ebenfalls aus. Sie können höchstens fünf Signierer haben.

<a id="my-offers"></a>

### Ihre Angebote

Angebote listet jedes Angebot, das Sie im verbundenen Netzwerk erstellt haben, und jedes Angebot, dessen Positions-Token Sie gerade halten, das neueste zuerst. Jedes zeigt den Status, den das Protokoll meldet: offen, erfüllt, verkauft, abgelaufen oder storniert, und die Filter über der Liste zählen jeden Status. Eine Kreditanfrage gilt als verkauft, wenn ihre Sicherheit über ihr Marktplatz-Angebot verkauft wurde, bevor jemand sie angenommen hat: Es wurde kein Kredit eröffnet, und der Verkaufserlös ging in den Vault ihres Erstellers. Ein offenes Angebot hält, was es verleiht oder verpfändet, in Ihrem Vault, bis es erfüllt oder storniert wird; ein abgelaufenes hält es dort, bis es aufgeräumt wird. Storniert das Protokoll ein Angebot, das noch nichts erfüllt hat, löscht es dessen Bedingungen, daher zeigt die Seite nur Nummer und Status. Hält eine andere Wallet den Positions-Token eines Angebots, das Sie erstellt haben, können Sie es trotzdem stornieren, und die Rückgabe geht an Sie; halten Sie eines, das eine andere Wallet erstellt hat, kann nur diese es vor Ablauf stornieren. Unter Ihren Angeboten folgt das Orderbuch, das als Nächstes beschrieben wird.

<a id="offer-book"></a>

### Das Orderbuch

Unter Ihren Angeboten listet das Orderbuch jedes offene Angebot im Netzwerk, das neueste zuerst; es wird erst gelesen, wenn Sie eine Wallet verbinden. Reiter trennen Kredite eines Tokens von NFT-Mieten, ein Filter zeigt Angebote von Kreditgebern, Anfragen von Kreditnehmern oder beides, und nach dem Verbinden können Sie Ihre eigenen Angebote ausblenden. Ältere Angebote laden mit „Ältere Angebote anzeigen“; die Filter gelten für das bisher Gelesene, und die Zählzeile sagt, wie viel das ist. Das Buch stammt aus dem Index des Protokolls, der der Chain einige Minuten hinterherhinken kann; es weist Sie also nur auf Angebote hin: Öffnen Sie eines, um es so zu sehen, wie die Chain es hält. Ein Angebot nach seinem Ablauf ist als abgelaufen markiert; jeder darf es aufräumen, und was es gesperrt hat, geht an seinen Ersteller zurück. Kann der Index nicht gelesen werden, sagt das Buch das, statt keine Angebote zu zeigen.

<a id="offer-detail"></a>

### Die Seite eines Angebots

Jedes Angebot hat seine eigene Seite, die aus der Chain gelesen wird, sobald eine Wallet verbunden ist. Sie zeigt, wer es eingestellt hat, den Betrag, was bereits gefüllt ist, die Sicherheit, die Laufzeit und wann das Angebot verfällt. Von dort können Sie ein offenes Kreditangebot ganz annehmen, über dieselbe Prüfung und Zustimmung wie bei Leihen und Verleihen: von einem Angebot eines Kreditgebers leihen oder die Anfrage eines Kreditnehmers finanzieren. Stornieren und Aufräumen funktionieren dort wie bei Ihren Angeboten. Mieten, Angebote mit NFT-Sicherheit, Verkäufe eines laufenden Kredits und Angebote zur vorzeitigen Schließung werden vorerst in der aktuellen App angenommen, und die Seite verlinkt dorthin. Ein Angebot ist nicht reserviert, während Sie es prüfen; jemand anderes kann es zuerst annehmen oder stornieren.

<a id="offer-cancel"></a>

### Ein Angebot stornieren

Stornieren bei einem offenen Angebot, das Sie erstellt haben, nimmt es aus dem Buch und gibt zurück, was es noch in Ihrem Vault sperrt: den nicht verliehenen Betrag oder das NFT eines Leihangebots, die ungenutzte Sicherheit einer Anfrage oder die vorausbezahlte Gebühr samt Puffer einer Mietanfrage. Ein Angebot, das noch nichts erfüllt hat, kann in seinen ersten fünf Minuten nicht storniert werden, damit eine Stornierung nie mit einer Annahme konkurriert; die Prüfung nennt den Zeitpunkt und hebt die Sperre von selbst auf. Ein bereits erfüllter Teil bleibt erfüllt. Ein abgelaufenes Angebot hat die Schaltfläche Aufräumen, die ebenso zurückgibt, was es sperrte; jeder darf ein abgelaufenes Angebot aufräumen, und die Rückgabe geht immer an seinen Ersteller. Die Prüfung sagt, was zurückkommt und wohin: ohne geschützten Modus sofort an Ihre Wallet; mit ihm wartet es die Verzögerung Ihres Kontos in der Auszahlungswarteschlange ab oder bleibt in Ihrem Vault, solange das Konto gesperrt ist. Kann die App die Rückgabe nicht beziffern, etwa bei einem Angebot, das an einen laufenden Kredit gebunden ist, sagt die Prüfung das, und die Abschlusskarte zeigt, was bewegt wurde. Solange das Protokoll pausiert ist, ist das Stornieren geschlossen. Nichts verlässt Ihre Wallet und keine Freigabe wird verlangt, daher fragt Ihre Wallet einmal.

<a id="offers-price-guard"></a>

### Preisbewegungsschutz

Ein Angebot eines Tokens gegen Token-Sicherheiten kann einen Preisbewegungsschutz tragen. Während Ihr Angebot im Orderbuch wartet, bewegen sich die Preise, und jemand könnte es genau dann annehmen, wenn sich der Markt zu seinen Gunsten bewegt hat. Auf der Seite des Angebots können Sie ein Limit zwischen 0,5 % und 50 % setzen: Das Angebot lehnt dann eine Annahme ab, solange sich das Verhältnis von Sicherheit zu Kapital seit dem Setzen des Schutzes um mehr als dieses Limit bewegt hat oder der Markt des Paares nicht ruhig ist. Wer das Angebot ansieht, sieht den Schutz und ob er eine Annahme jetzt zulässt. Auf einem bereits eingestellten Angebot schützt er erst ab dem Moment, in dem er erfasst wird. Er bewegt nie etwas, und Sie können ihn ändern oder entfernen, solange das Angebot offen ist. Im Fortgeschrittenen-Modus können Sie den Schutz auch schon beim Einstellen eines Angebots hinzufügen, sodass es vom ersten Moment im Orderbuch an geschützt ist.

<a id="risk-access"></a>

### Risk Access: Ihre Risikostufe

Jedes Konto beginnt auf der niedrigsten Risikostufe, nur Blue-Chip-Assets, und nur Sie können sie anheben. Ein Paar braucht die Stufe seines riskanteren Tokens: Blue-Chip-Tokens brauchen nichts, andere liquide Tokens brauchen „Liquide Assets“, und ein illiquider Token braucht „Jedes Asset, auch illiquide“ sowie Ihre Zustimmung zu genau diesem Paar. Wenn das Annehmen eines Angebots oder das Stellen einer Anfrage einen solchen Schritt braucht, sagt die Prüfung das an Ort und Stelle und bietet ihn als eine Wallet-Bestätigung mit eigenem Beleg an: was sich ändert, welche Paare es betrifft, wann es wirksam wird und dass keine Mittel bewegt werden. Das Anheben der Stufe oder die Zustimmung zu einem Paar kann eine vom Protokoll festgelegte Wartezeit haben; für eine angehobene Stufe zeigt die App den Zeitpunkt des Inkrafttretens, von der Chain gelesen, für eine Zustimmung sagt sie, dass das Protokoll diese Zeit noch nicht veröffentlicht, und sie bietet denselben Schritt nie zweimal an, weil ein zweiter die Wartezeit neu starten würde. Das Senken der Stufe wirkt immer sofort. Veröffentlicht das Protokoll neue Risikobedingungen, zählen Ihre Stufe und Zustimmungen erst wieder, wenn Sie sie erneut bestätigen. Haben Sie den strengen Modus eingeschaltet, braucht auch jedes liquide Paar Ihre Bestätigung. Eine Sperre durch die Risikostufe des Kreditgebers wird als seine gezeigt: Nichts in Ihrem Konto würde sie ändern.

<a id="terms-gate"></a>

### Die Abfrage der Nutzungsbedingungen

Wo eine Version der Nutzungsbedingungen gilt, bittet dich die App, sie vor einer Aktion zu akzeptieren, die etwas Neues beginnt, etwa das Einschalten des Gebührenrabatts, und nennt die Aktion, die gefragt hat. Sie zeigt die Version, einen Fingerabdruck ihres Textes und einen Link zu genau dieser Version, deren Text sich nie ändert. Das Akzeptieren ist eine Bestätigung in der Wallet und bewegt keine Mittel. Kann die App nicht lesen, ob du akzeptiert hast, sagt sie das und lässt dich es erneut versuchen, statt es als Nein zu werten. Zurückzahlen, Forderungen einlösen, eigene Assets abheben, eigene Angebote stornieren und eine Zustimmung ausschalten werden nie aufgehalten.

<a id="settings"></a>

### Einstellungen

Die Einstellungen findest du unten im Menü. Modus, Design und Sprache brauchen keine Wallet und bleiben in diesem Browser. Das Design folgt deinem Gerät, bis du eines wählst, und eine noch nicht übersetzte Sprache zeigt Englisch, bis sie übersetzt ist. Mit verbundener Wallet zeigen die Einstellungen, welche Version der Nutzungsbedingungen du in diesem Netzwerk akzeptiert hast oder dass eine Version gilt, die du noch nicht akzeptiert hast; du wirst bei der ersten Aktion gefragt, die sie braucht, nie dort. Die Einstellung zum Gebührenrabatt ist dieselbe wie auf der Startseite. Die Einstellungen sagen auch, was dieser Browser für die App speichert, dass nichts Geheimes gespeichert wird und dass die App keine Fehlerberichte oder Diagnosedaten sendet. Die Einstellungen können außerdem die Datensätze der App in diesem Browser als Datei herunterladen oder alles löschen, was diese Website hier speichert. Vor dem Löschen sagen sie, wie viele Einträge entfernt werden; das Löschen trennt deine Wallet, setzt Modus, Design und Sprache zurück und zeigt danach, was entfernt wurde. Deine Positionen on-chain, deine Hinweiseinstellungen beim Hinweisdienst, die Marketing-Website und deine Wallet-App bleiben unberührt.

Die Einstellungen zeigen außerdem in Worten deine Risikostufe in diesem Netzwerk, ob dieses Netzwerk sie durchsetzt und ob der strenge Modus an ist. Haben neue Risikobedingungen deine Stufe außer Kraft gesetzt, kannst du sie dort mit einem Wallet-Schritt erneut bestätigen. Um deine Stufe anzuheben oder zu senken oder den strengen Modus ein- oder auszuschalten, wechsle in den **Advanced**-Modus: Jede Änderung ist eine Wallet-Bestätigung mit eigenem Beleg und bewegt keine Mittel. Das Senken wirkt sofort und schließt Paare oberhalb der neuen Stufe für neue Angebote und Anfragen, auch für deine eigenen offenen; bestehende Kredite sind nicht betroffen. Das Anheben kann die Wartezeit des Protokolls abwarten, und die App zeigt, ab wann es zählt.

Die Einstellungen listen außerdem die dauerhaften Freigaben, die deine Wallet dem Protokoll in diesem Netzwerk erteilt: wie viel eines Tokens es bewegen darf, ohne dich erneut zu fragen, oder eine Freigabe für eine ganze NFT-Sammlung oder ein einzelnes NFT. Jede lässt sich mit einer Wallet-Bestätigung zurückziehen, die keine Mittel bewegt. Die Liste prüft die vorgeschlagenen Assets und jedes Asset, das deine Einlagen, Kredite und Angebote hier nennen, und du kannst ein weiteres Token prüfen lassen; eine Freigabe für ein anderes Token wird dort nicht gefunden, den Rest kann deine Wallet zeigen. Deckt eine weitere Freigabe dasselbe Asset ab, etwa die der ganzen Sammlung für ein NFT, nennt die Prüfung, dass sie nach dem Zurückziehen bestehen bleibt.

Die Einstellungen zeigen außerdem, ob Keeper in diesem Netzwerk für deine Wallet handeln dürfen und welche Keeper du freigegeben hast. Anfangs ist alles aus. Ein Keeper handelt nur, solange der Keeper-Zugang an ist und er die Aktion besitzt; ein Schritt bei einem Kredit verlangt zusätzlich, dass dieser Kredit oder dieses Angebot den Keeper nennt. Ein Keeper erhält nie deine Mittel und kann nichts beanspruchen, abheben oder übertragen. Den Keeper-Zugang ausschalten oder einen Keeper entfernen kannst du in beiden Modi mit einer Wallet-Bestätigung; um den Zugang einzuschalten, einen Keeper freizugeben oder seine Aktionen zu ändern, wechsle in den **Advanced**-Modus.

Du kannst die App auch auf deinem Handy oder Computer installieren; dann öffnet sie sich vom Startbildschirm oder aus der App-Liste, mit Verknüpfungen zu Angebote, Positionen, Tresor und Benachrichtigungen. Nutze dafür die Option „App installieren“ oder „Zum Startbildschirm“ deines Browsers (auf iPhone oder iPad: Safari, dann Teilen, dann Zum Home-Bildschirm), oder im **Advanced**-Modus „App installieren“ in den Einstellungen, wo dein Browser es anbietet. Die App behält Kopien ihrer eigenen Code-Dateien, damit sie schneller startet; deine Positionen und jeder Betrag werden immer aus dem Netzwerk gelesen.

<a id="rent-review"></a>

### Mieten: Ein NFT mieten

Mieten im Menü listet die NFTs, die Eigentümer in Ihrem Netzwerk zur Miete anbieten; ist in einem Testnetzwerk nichts gelistet, verweist die Seite auf den Faucet für ein Test-NFT und Test-Token. Eine Miete gibt Ihnen das Recht, ein NFT für eine feste Zahl von Tagen zu nutzen, nie das NFT selbst: Es bleibt im Vault des Eigentümers, der Sie bis zum Ende der Miete als Nutzer einträgt. Öffnen Sie ein Angebot und wählen Sie „Dieses NFT mieten“. Die Prüfung zeigt, was von Ihrer Wallet in Ihren eigenen Vault geht: die Tagesgebühr für die ganze Laufzeit plus einen Puffer, einen kleinen Anteil der Miete, den das Angebot beim Einstellen festgelegt hat. Sie zeigt auch die Mietregel (anteilig, also die genutzten Tage, wobei ein angefangener Tag als ganzer zählt, oder volle Laufzeit), was bei pünktlichem Schließen zurückkommt, die Nachfrist und die Verzugsgebühr, die aus dem Puffer genommen wird. Eine Miete hat keine Sicherheit und keinen Gesundheitsfaktor. Hält Ihre Wallet weniger als Miete plus Puffer, sagt die Prüfung das vor jedem Wallet-Schritt. Danach bittet Ihre Wallet Sie, die Bedingungen zu signieren, was nichts kostet, bei Bedarf genau diesen Betrag freizugeben und die Miete zu starten, die die App zuerst als Probelauf versucht. Anschließend prüft die App auf der Chain die gestartete Miete, die Zahlung in Ihren Vault und dass Sie jetzt Nutzer des NFTs sind.

<a id="rent-risks"></a>

### Mieten: Risiken

Ein gemietetes NFT gehört Ihnen nie, und Ihr Nutzungsrecht endet mit der Miete. Miete und Puffer bleiben für die Miete in Ihrem Vault und können nicht abgehoben werden, solange sie offen ist. Sobald jeder vereinbarte Tag abgerechnet ist, was jeder tun darf, schließt sich die Miete von selbst, und Sie können Ihren Puffer zurückfordern. Bis dahin schließen Sie sie selbst auf ihrer Positionsseite. Schließen in der Nachfrist kostet eine Verzugsgebühr aus dem Puffer; nach der Nachfrist fällt die Miete aus, die verbliebene Miete in Ihrem Vault geht an den Eigentümer, der Puffer an das Protokoll, und nichts kommt zu Ihnen zurück. Bei Miete für die volle Laufzeit ist die ganze Laufzeit geschuldet, auch wenn Sie früher schließen.

<a id="rent-list"></a>

### Mieten: Ihr NFT zur Miete anbieten

Unter Mieten öffnet „NFT zur Miete anbieten“ ein kurzes Formular: die Sammlung (in einem Testnetzwerk eine Testsammlung oder eine eingefügte Adresse), die Nummer des Tokens und bei einer Multi-Token-Sammlung die Menge; den Token, in dem Mieter zahlen; die Tagesgebühr, ein einziger Wert; die Laufzeit in Tagen; die Mietregel, anteilig oder volle Laufzeit; und wie lange das Angebot offen bleibt. Felder für Sicherheit oder Zins gibt es nicht: Eine Miete hat beides nicht. Die Prüfung zeigt, dass das NFT von Ihrer Wallet in Ihren eigenen Vault geht, was ein Mieter im Voraus zahlt, den Pufferanteil, den dieses Angebot zur heutigen Einstellung festlegt, was Sie erhalten (die fällige Miete abzüglich des Protokollanteils, der festgelegt wird, wenn ein Mieter das Angebot annimmt), die Nachfrist und was ein Ausfall bewirkt. Hält Ihre Wallet das NFT nicht, sagt die Prüfung das vor jedem Wallet-Schritt. Danach bittet Ihre Wallet Sie, dem Protokoll das Bewegen dieses einen Tokens zu erlauben (bei einer Multi-Token-Sammlung der ganzen Sammlung, nur für dieses Angebot, danach in einem weiteren Schritt zurückgenommen) und das Angebot einzustellen, das die App zuerst als Probelauf versucht. Anschließend prüft die App auf der Chain, dass das Angebot gespeichert wurde und das NFT in Ihrem Vault ankam, und verlinkt die Seite des Angebots.

<a id="rent-list-risks"></a>

### Mieten: Risiken des Anbietens

Das NFT bleibt in Ihrem Vault, solange das Angebot offen ist und solange es vermietet ist, und Sie können es erst abheben, wenn Angebot oder Miete enden. Solange niemand es gemietet hat, können Sie das Angebot nach seinen ersten fünf Minuten auf seiner Seite stornieren. Ist es vermietet, hat der Mieter bis zum Ende der Miete das Nutzungsrecht, und Sie können es nicht vorzeitig zurücknehmen. Die Miete kommt, abzüglich des Anteils des Protokolls, in Ihren Vault, sobald ein abgelaufener Tag abgerechnet wird; das darf jeder tun. Ist jeder vereinbarte Tag abgerechnet, schließt sich die Miete von selbst, und der Mieter kann den Puffer zurückfordern. Vorher kann der Mieter sie schließen, oder nach der Nachfrist kann jeder sie als Ausfall schließen. Schließt der Mieter sie, können Sie die noch nicht abgerechnete Miete und eine etwaige Verzugsgebühr beanspruchen, abzüglich des Anteils des Protokolls, und der Rest des Puffers geht an den Mieter zurück. Bei einem Ausfall können Sie die restliche Miete abzüglich dieses Anteils beanspruchen, und der Puffer geht an das Protokoll. Eine Pause stoppt die tägliche Abrechnung und verschiebt die Fristen für Verzugsgebühr und Ausfall nach hinten, verlängert aber nie die Nutzung des Mieters. Ein abgelaufenes Angebot lässt das NFT in Ihrem Vault, bis es geschlossen wird.

<a id="rent-request"></a>

### Mieten: Ein NFT zur Miete anfragen

Unter Mieten öffnet Mietanfrage stellen dasselbe kurze Formular wie ein Angebot, formuliert für Sie als Mieter: die Sammlung und die Nummer des Tokens (bei einer Multi-Token-Sammlung auch die Menge), der Token, in dem Sie zahlen, die Tagesgebühr als eine einzige Zahl, die Laufzeit in Tagen, die Mietregel und wie lange die Anfrage offen bleibt. Die Prüfung zeigt, dass die Miete für die ganze Laufzeit und ein Puffer jetzt von Ihrer Wallet in Ihren eigenen Vault gehen, den Pufferanteil, den diese Anfrage zur heutigen Einstellung festlegt, dass die Laufzeit beginnt, wenn ein Eigentümer die Anfrage annimmt, und dass ein Eigentümer, der sie annimmt, die Miete sofort startet, ohne weiteren Schritt von Ihnen. Hält Ihre Wallet zu wenig oder schon genau dieses NFT, sagt die Prüfung das vor jedem Wallet-Schritt; ein Token, den es noch nicht gibt, wird vermerkt. Danach genehmigt Ihre Wallet genau die Miete und den Puffer und stellt die Anfrage, die die App zuerst als Probelauf prüft. Anschließend prüft die App auf der Chain, dass die Anfrage erfasst wurde und Miete und Puffer in Ihrem Vault angekommen sind, und verlinkt die Seite der Anfrage.

<a id="rent-request-risks"></a>

### Mieten: Risiken einer Mietanfrage

Miete und Puffer bleiben in Ihrem Vault, solange die Anfrage offen ist, und Sie können sie erst abheben, wenn Sie sie stornieren oder sie endet. Solange kein Eigentümer sie angenommen hat, können Sie die Anfrage nach ihren ersten fünf Minuten auf ihrer Seite stornieren, und beides kommt in Ihre Wallet zurück. Ein Eigentümer, der sie annimmt, startet die Miete sofort zu genau diesen Bedingungen: Sie halten das Recht, das NFT zu nutzen, nie das NFT selbst. Sobald jeder vereinbarte Tag abgerechnet ist, was jeder tun darf, endet die Miete von selbst, und Sie können Ihren Puffer zurückfordern; bis dahin beenden Sie sie auf ihrer Positionsseite. Wer zu spät beendet, zahlt eine Verspätungsgebühr aus dem Puffer, und bei einem Ausfall geht die Miete an den Eigentümer und der Puffer an das Protokoll. Eine abgelaufene Anfrage lässt Miete und Puffer in Ihrem Vault, bis sie geschlossen wird. Der Pufferanteil ist die Einstellung des Protokolls, wenn die Anfrage auf der Chain landet: Ändert sie sich nach Ihrer Prüfung, wird ein höherer Anteil abgelehnt, wenn Ihre Wallet genau diesen Betrag freigegeben hat, und eingezogen, wenn eine frühere Freigabe ihn deckt; das Ergebnis nennt, was bewegt wurde.

<a id="rent-take"></a>

### Mieten: Die Anfrage eines Mieters annehmen

Die Anfrage eines Mieters bittet darum, ein NFT zu festen Bedingungen zu mieten, und der Mieter hat Miete und Puffer bereits in seinen eigenen Vault gelegt. Ihre Seite sagt das und bietet „Ihr NFT vermieten“ an. Die Prüfung zeigt, dass das NFT von Ihrer Wallet in Ihren eigenen Vault geht, wer der Mieter ist und dass er ab jetzt für die Laufzeit das Recht erhält, es zu nutzen, nie das NFT selbst. Sie zeigt auch die Tagesgebühr, die Laufzeit und die Mietregel, die die Anfrage festlegt, Miete und Puffer, die schon im Vault des Mieters liegen, was Sie erhalten (die Miete abzüglich des Anteils des Protokolls, der beim Start der Miete festgelegt wird, in Ihren Vault, sobald ein abgelaufener Tag abgerechnet wird, den Rest beim Schließen), die Nachfrist und was ein Ausfall bewirkt. Hält Ihre Wallet dieses NFT nicht oder zu wenige Einheiten davon, sagt die Prüfung das vor jedem Wallet-Schritt und liest von selbst neu, sobald sie es hält. Danach bittet Ihre Wallet Sie, die Bedingungen zu signieren, was nichts kostet, dem Protokoll zu erlauben, genau diesen einen Token zu bewegen (bei einer Multi-Token-Sammlung die ganze Sammlung nur für diese Miete, danach in einem weiteren Schritt zurückgenommen), und die Miete zu starten, die die App zuerst als Probelauf versucht. Anschließend prüft die App auf der Chain die gestartete Miete, dass das NFT Ihren Vault erreicht hat und dass Ihr Vault den Mieter als Nutzer einträgt, und verlinkt die Miete.

<a id="rent-take-risks"></a>

### Mieten: Risiken beim Annehmen einer Anfrage

Das NFT bleibt für die ganze Miete in Ihrem Vault, und Sie können es nicht abheben, solange die Miete offen ist. Der Mieter hält das Nutzungsrecht bis zum Ende der Miete, und Sie können es nicht früher zurücknehmen. Die Bedingungen sind die der Anfrage: Tagesgebühr, Laufzeit, Mietregel und Puffer können Sie nicht ändern. Die Miete kommt, abzüglich des Anteils des Protokolls, in Ihren Vault, sobald ein abgelaufener Tag abgerechnet wird; das darf jeder tun. Ist jeder vereinbarte Tag abgerechnet, schließt sich die Miete von selbst, und der Mieter kann den Puffer zurückfordern. Vorher kann der Mieter sie schließen, oder nach der Nachfrist kann jeder sie als Ausfall schließen. Schließt der Mieter sie, können Sie die noch nicht abgerechnete Miete und eine etwaige Verzugsgebühr beanspruchen, abzüglich des Anteils des Protokolls, und der Rest des Puffers geht an den Mieter zurück. Bei einem Ausfall können Sie die restliche Miete abzüglich dieses Anteils beanspruchen, und der Puffer geht an das Protokoll. Eine Pause stoppt die tägliche Abrechnung und verschiebt die Fristen für Verzugsgebühr und Ausfall nach hinten, verlängert aber nie die Nutzung des Mieters. Eine Anfrage ohne eigenen Puffer übernimmt beim Start der Miete die heutige Einstellung.

<a id="rent-close"></a>

### Mieten: Eine Miete schließen

Die Seite einer laufenden Miete bietet Ihnen als Mieter Miete schließen an. Das Schließen bezahlt die geschuldete Miete und eine etwaige Verzugsgebühr aus der Miete und dem Puffer, die Sie im Voraus in Ihren eigenen Vault gezahlt haben; Ihrer Wallet wird nichts entnommen, und es gibt keine Freigabe. Die Prüfung zeigt die geschuldete Miete, wenn jetzt geschlossen wird und zu einem Zeitpunkt kurz danach, gezählt nach der Mietregel (anteilig: die seit dem Start genutzten Tage, ein angefangener Tag als ganzer, abzüglich der schon abgerechneten Tage; volle Laufzeit: jeder vereinbarte, noch nicht abgerechnete Tag), die schon abgerechneten Tage, eine etwaige Verzugsgebühr, was als Anspruch an Sie zurückgeht und was der Eigentümer erhält: Miete und Verzugsgebühr abzüglich des Anteils des Protokolls. Reicht die Vorauszahlung nicht, sagt die Prüfung das, bevor sich Ihre Wallet öffnet. Ihre Wallet fragt dann einmal, ob die Miete geschlossen werden soll; die App probiert das zuerst als Probelauf. Danach prüft die App auf der Chain, dass die Miete geschlossen ist, welcher Anspruch für Sie verbucht wurde und dass Ihre Nutzung endete. Was zurückkommt, holen Sie auf der Seite Claims ab.

<a id="rent-close-risks"></a>

### Mieten: Risiken des Schließens

Das Schließen beendet Ihr Nutzungsrecht sofort, auch wenn noch vereinbarte Tage übrig sind, und lässt sich nicht rückgängig machen. Die Miete wird gezählt, wenn das Schließen auf der Chain landet; ein Tag, der vorher beginnt, wird als ganzer bezahlt. Bei voller Laufzeit wird jeder noch nicht abgerechnete vereinbarte Tag bezahlt, wie früh Sie auch schließen. Nach dem Ende der Laufzeit wird eine Verzugsgebühr aus Ihrem Puffer genommen: 1 % der ganzen Miete plus 0,5 % für jeden Tag Verzug, höchstens 5 % und nie mehr als der Puffer. Nach der Nachfrist lehnt das Protokoll ein Schließen ab; die Miete endet dann, wenn ihre restlichen Tage einzeln abgerechnet werden, was jeder tun darf, oder durch Ausfall, je nachdem, was zuerst eintritt. Der spätere Zeitpunkt, den die Prüfung zeigt, ist weder Frist noch Obergrenze: Ein Schließen, das später landet, wird dann gezählt, sodass mehr Miete oder eine höhere Verzugsgebühr anfallen kann und weniger an Sie zurückkommt. Was zurückkommt, bleibt als Anspruch in Ihrem eigenen Vault, bis Sie es abholen.

<a id="rewards-vpfi"></a>

### Belohnungen: VPFI in Ihrem Vault

Belohnungen im Menü zeigt Ihre Belohnungen in diesem Netzwerk, Ihr VPFI und Ihre Zustimmung zum Gebührenrabatt. Ihre Belohnungen sind die Nutzungsrabatte, die Home zeigt, und werden genauso beansprucht. Darunter zeigt die Seite Ihr VPFI: in Ihrer Wallet, in Ihrem eigenen Vault gezählt, jetzt frei abhebbar und für Kredite, Angebote, Ansprüche oder Auszahlungen gebunden. Gezähltes VPFI bestimmt Ihre Gebührenrabattstufe, und die Stufe senkt Ihre Gebühren nur, solange Ihre Zustimmung eingeschaltet ist. VPFI, das ohne Einzahlung direkt an Ihren Vault gesendet wurde, wird nicht gezählt und hebt Ihre Stufe nie; die Seite zeigt es und verweist Sie zur Vault-Seite, wo Sie es übernehmen können. „VPFI einzahlen“ bewegt VPFI aus Ihrer Wallet in Ihren eigenen Vault, den nur Ihre Wallet steuert, nachdem Sie die Bedingungen akzeptiert haben, falls noch nicht geschehen; die erste Einzahlung legt den Vault an. „VPFI abheben“ bewegt freies VPFI zurück in Ihre Wallet. Jede Prüfung sagt, was der Vorgang mit Ihrer Stufe macht und ob Ihre Zustimmung eingeschaltet ist, und danach prüft die App das Ergebnis auf der Chain. In einem Netzwerk, in dem VPFI nicht eingerichtet ist, sagt die Seite das und bietet beides nicht an. Nur VPFI in Ihrem Vault im Heimnetzwerk von VPFI bestimmt Ihre Stufe; andere Netzwerke wenden eine Kopie der dort ermittelten Stufe an, daher sagen dort die Seite und jede Prüfung, dass das Bewegen von VPFI keine Stufe ändert.

<a id="rewards-vpfi-risks"></a>

### Belohnungen: Risiken beim Bewegen von VPFI

Ihre Stufe ist nicht Ihr heutiger Bestand. Sie ist null, bis Ihr aktueller Bestand eine Mindestzahl von Tagen gehalten wurde. Danach folgt sie einem Durchschnitt Ihrer täglichen Bestände, der jüngere Tage stärker gewichtet. Unabhängig davon übersteigt sie nie die niedrigste Stufe, die Sie an einem Tag Ihres aktuellen Bestands hatten, mit einem Rückblick von höchstens 30 Tagen. Eine Einzahlung hebt Ihre Stufe also erst mit der Zeit, und eine kurze Aufstockung hebt sie nicht. Wenn Sie einen Teil Ihres gezählten VPFI abheben, kann Ihre Stufe sinken, und wenn Sie alles abheben, beginnt Ihre Haltezeit mit Ihrer nächsten Einzahlung neu. Für einen Kredit, ein Angebot, einen Anspruch oder eine Auszahlung gebundenes VPFI kann erst abgehoben werden, wenn es freigegeben ist, und die Abhebung eines geschützten Kontos wartet zuerst seine Verzögerung ab. Die Abhebung eines geschützten Kontos ändert Ihr gezähltes VPFI und Ihre Stufe erst, wenn sie freigegeben wird, und eine abgebrochene ändert beides nicht. VPFI in Ihrem Vault ist keine Sicherheit und deckt keinen Kredit. Das Protokoll verkauft kein VPFI, nennt keinen Preis dafür und zahlt nichts für das Halten.

<a id="rewards-tier"></a>

### Belohnungen: Ihre Gebührenrabattstufe

Unter Ihrem VPFI zeigt die Seite die Gebührenrabattstufe, die das Protokoll jetzt auf Ihre Gebühren anwendet, direkt aus dem Protokoll gelesen, und wie viel sie davon abzieht. Solange Ihre Zustimmung zum Gebührenrabatt ausgeschaltet ist, gilt keine Stufe. Ein neuer Bestand zählt erst mit der Zeit voll, daher sagt die Seite, wenn die Halteregeln Ihre Stufe unter dem halten, was Ihr gezähltes VPFI allein ergäbe. Im Heimatnetzwerk von VPFI zeigt eine Tabelle jede Stufe: das nötige gezählte VPFI, ihren Rabatt sowie die Kreditbearbeitungsgebühr und die Gebühr auf verdiente Zinsen mit diesem Rabatt, berechnet aus den aktuellen Einstellungen des Netzwerks. Jede Stufe beginnt bei ihrem Wert, außer der obersten, die knapp darüber beginnt. Kein Rabatt beträgt je mehr als die Hälfte einer Gebühr. In anderen Netzwerken zeigt die Seite die vom Heimatnetzwerk gesendete Stufe, und die Tabelle wird nicht gezeigt. Die Seite nennt die Halteregel, die Ihre Stufe drückt, und sagt bei ausgeschalteter Zustimmung, welche Stufe mit eingeschalteter gälte.

<a id="rewards-vpfi-sign"></a>

### Belohnungen: Signieren statt Genehmigen

Wenn Ihre Wallet Permit2 für VPFI bereits genehmigt hat, einen gemeinsamen Vertrag, über den viele Apps Token per Signatur bewegen, bietet die Prüfung der VPFI-Einzahlung „Signieren statt genehmigen“ an. Sie signieren dann eine einmalige Übertragung von genau dem Betrag, 30 Minuten gültig, und senden die Einzahlung: zwei Wallet-Schritte und keine Genehmigung an das Protokoll. Die Signatur kann einmal verwendet werden, nur von einer Transaktion, die Ihre eigene Wallet sendet, und nur in Ihren eigenen Tresor; ungenutzt verfällt sie. Die App bittet Sie nie, Permit2 selbst zu genehmigen, denn diese Genehmigung ist unbefristet und wird mit anderen Apps geteilt. Ohne sie bleibt die Prüfung bei der üblichen Genehmigung von genau dem Betrag. In einem Netzwerk ohne Permit2 wird die Wahl nicht angeboten.

<a id="desk-markets"></a>

### Rate desk: Märkte und Zinsleitern

Der Rate desk, im Menü unter Erweitert, zeigt die offenen Token-Kreditangebote in diesem Netzwerk, gruppiert in Märkte: ein verliehener Token gegen einen Token als Sicherheit, für eine Laufzeit. Jeder Markt zeigt, wie viele Angebote von Kreditgebern und Anfragen von Kreditnehmern er enthält, und den besten Zinssatz auf jeder Seite. Wählen Sie einen Markt, sehen Sie seine Zinsleiter: Angebote von Kreditgebern vom niedrigsten Satz aufwärts, Anfragen von Kreditnehmern vom höchsten Satz abwärts. Jeder Satz zeigt, wie viele Angebote auf ihm stehen, und ihre offenen Beträge zusammengezählt. Diese Summe ist Tiefe, kein Betrag, den Sie auf einmal nehmen können: Jedes Angebot wird weiterhin einzeln angenommen, mit eigener Sicherheit und eigenen Bedingungen. Der mittlere Satz liegt in der Mitte zwischen den beiden besten Sätzen; die App berechnet ihn, das Protokoll meldet ihn nicht. Der Desk liest den Index des Protokolls, der der Chain einige Minuten hinterherhinken kann, und die eigene Seite eines Angebots prüft es auf der Chain, bevor Sie es annehmen. Signierte Orders werden in den Märkten gezählt, auf der Leiter aber noch nicht aufgeführt. Im Basic-Modus sagt eine Karte oben, was die Seite ist, und verlinkt Borrow und Lend, die dieselbe Aufgabe Schritt für Schritt erledigen.

<a id="offer-terms-wait"></a>

### Wenn ein Angebot gerade erstellt oder geändert wurde

Ein Angebot oder eine Anfrage kann erst angenommen werden, wenn seine Bedingungen seit dem Erstellen oder der letzten Änderung einige Sekunden bestanden haben. Öffnen Sie es früher, sagt die Prüfung, wie lange die Bedingungen bestehen müssen und wie lange es ungefähr noch dauert, und zeigt keinen Schritt zum Signieren. Sie müssen nichts tun: Die Prüfung liest von selbst erneut und lässt Sie weitermachen, sobald die Zeit um ist. Während Sie warten, wird nichts gesendet.

<a id="desk-tape"></a>

### Rate desk: Ihre Angebote, letzte Kredite und vereinbarte Zinssätze

Unter der Zinsleiter eines Marktes zeigt der Rate desk drei weitere Dinge. Erstens Ihre eigenen Angebote auf dieser Leiter, mit dem Teil, der davon schon genommen wurde, und dem Teil, der noch offen ist, so wie der Index es zuletzt erfasst hat; die eigene Seite eines Angebots prüft es auf der Chain. Zweitens die letzten Kredite des Marktes, die neuesten zuerst: Jede Zeile ist ein in diesem Markt vereinbarter Kredit, mit dem Zinssatz und dem Betrag, die bei seiner Eröffnung galten; spätere Rückzahlungen oder Verlängerungen ändern daran nichts. Drittens ein Diagramm der Zinssätze, zu denen Kredite in den letzten 7, 30 oder 90 Tagen oder insgesamt vereinbart wurden. Jede Stufe ist der Zinssatz des letzten in ihrem Zeitraum vereinbarten Kredits, und der schattierte Balken reicht vom niedrigsten bis zum höchsten Zinssatz dieses Zeitraums. Eine Lücke bedeutet, dass damals kein Kredit vereinbart wurde; über sie wird nichts gezeichnet. Die gestrichelte Linie ist der aktuelle mittlere Zinssatz der Leiter, von der App berechnet, und dieselben Zahlen stehen in einer Tabelle unter dem Diagramm. Kann der Index die Laufzeit eines Kredits nicht bestätigen, ordnet er ihn keinem Markt zu; der Desk nennt, wie viele solche Kredite das Tokenpaar hat.

<a id="desk-history"></a>

### Rate desk: Ihre laufenden Kredite und Ihr Desk-Verlauf

Unter der Aktivität eines Marktes listet der Rate desk Ihre laufenden Kredite in diesem Markt auf. Sie stammen aus dem eigenen Abruf Ihrer Positionen von der Chain durch die App, demselben, den die Seite Positionen nutzt. Jeder Eintrag zeigt Ihre Seite, Betrag und Zinssatz sowie den Health Factor oder den Hinweis, dass es keinen gibt, und öffnet die Seite des Kredits, auf der Sie ihn verwalten. Darunter steht Ihr Desk-Verlauf: jeder Token-Kredit gegen Token-Sicherheit, bei dem Sie eine Seite gehalten haben, in jedem Status, neueste zuerst, jeweils zwanzig. Der angezeigte Status ist der Eintrag des Index und kann der Chain hinterherhinken; maßgeblich ist die Seite des Kredits. "Ältere Kredite anzeigen" erscheint nur, wenn es wirklich ältere gibt, und kann der Verlauf nicht gelesen werden, sagt der Desk das, statt eine leere Liste zu zeigen.

<a id="desk-ticket"></a>

### Rate desk: das Order-Ticket

Unter der Zinsleiter eines Marktes hat der Rate desk ein Order-Ticket. Damit stellen Sie ein Angebot zum Verleihen oder eine Anfrage zum Leihen in diesem Markt ein, ohne die geführten Schritte zu durchlaufen. Der Markt legt die beiden Token und die Laufzeit bereits fest. Sie wählen Ihre Seite, den Betrag, die Sicherheit, den Zinssatz, wie lange es offen bleibt und wie es gefüllt werden darf. Soll es in Teilen gefüllt werden, legen Sie auch die kleinste einzelne Füllung fest: Ein Angebot mit nur einer Größe wird immer ganz gefüllt. Der Zinssatz ist ein exakter Satz, keine Unter- oder Obergrenze: Ein Match braucht eine Zinsspanne der Gegenseite, die ihn einschließt. Das Ticket zeigt unter der Schaltfläche nur das erste Hindernis, sodass Sie eins nach dem anderen beheben. "Fill to balance" trägt Ihr gesamtes Wallet-Guthaben des Tokens ein, den Sie sperren würden, auf die letzte Stelle genau. Das Ticket nennt auch die Bedingungen, die es für Sie festlegt, und die Gebühren zu heutigen Sätzen. Es wird immer auf der Chain eingestellt: Sie zahlen Gas, und was Sie sperren, wartet bis zu einem Match in Ihrem eigenen Vault. Eine Order ohne Gas zu signieren ist in dieser App noch nicht möglich, und das Ticket sagt das. "Review" öffnet dieselbe Prüfung wie die Seiten Leihen und Verleihen, in der Sie zustimmen und bestätigen.

<a id="desk-signed"></a>

### Rate desk: Ihre signierten Orders

Eine signierte Order ist ein Angebot, dem Sie durch eine Signatur zustimmen, ohne Gas zu zahlen. Das Orderbuch bewahrt Ihre Signatur auf, und nichts erreicht die Chain, bis jemand sie füllt. Unter dem Order-Ticket eines Marktes listet der Rate desk die signierten Orders Ihrer Wallet in diesem Markt so, wie das Orderbuch sie führt, und prüft jede auf der Chain: offen, bereits gefüllt oder storniert, gestoppt, weil ihre Nonce storniert wurde, oder abgelaufen. Für eine signierte Order wird nichts zurückgelegt: Eine Füllung zieht den Betrag oder die Sicherheit in diesem Moment aus Ihrem eigenen Vault und scheitert, wenn Ihr Vault ihn nicht deckt. Eine Order aus dem Orderbuch zu entfernen, würde sie nicht stoppen, denn wer die Signatur schon hat, kann sie weiterhin senden. Der einzige Weg, eine Order vor ihrem Ablauf zu stoppen, ist die Stornierung auf der Chain; sie kostet Gas und gibt nichts zurück, weil nichts gehalten wurde. Sie können eine Order stornieren oder, wenn mehrere Ihrer offenen Orders eine Nonce teilen, alle auf einmal; das stoppt auch jede andere Order, die Sie mit dieser Nonce signiert haben, in jedem Markt. Eine Füllung, die vor Ihrer Stornierung gesendet wurde, kann trotzdem zuerst ankommen.
