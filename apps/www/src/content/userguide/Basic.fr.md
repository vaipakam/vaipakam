# Vaipakam — Guide utilisateur (Mode Basique)

Explications claires et accessibles de chaque carte de l'application.
Chaque section correspond à une icône d'information `(i)` à côté du
titre d'une carte.

> **Vous lisez la version Basique.** Elle correspond au mode
> **Basique** de l'app (la vue plus simple, avec moins de contrôles
> et des valeurs par défaut plus sûres). Pour une présentation plus
> technique et détaillée, basculez l'app en mode **Avancé** —
> ouvrez les Paramètres (icône d'engrenage en haut à droite) →
> **Mode** → **Avancé**. Les liens « En savoir plus » (i) dans l'app
> ouvriront alors le guide Avancé.

---

<a id="chapter.dashboard"></a>

## Tableau de bord

<a id="dashboard.your-vault"></a>

### Votre Vault

Considère ton **vault** comme ton coffre-fort privé à l'intérieur de
Vaipakam. C'est un petit contrat que toi seul contrôles. Chaque fois
que tu participes à un prêt — soit en déposant un collatéral, soit en
prêtant un actif — les actifs passent de ton wallet vers ce coffre.
Ils ne sont jamais mélangés à l'argent de quelqu'un d'autre. Quand le
prêt se termine, tu les récupères directement.

Tu n'as pas besoin de "créer" un vault toi-même ; l'application en
crée un la première fois que tu en as besoin. Une fois qu'il existe,
il reste comme ton emplacement dédié sur cette chaîne.

<a id="dashboard.your-loans"></a>

### Vos prêts

Chaque prêt auquel tu participes sur cette chaîne apparaît ici — que
tu sois le prêteur (celui qui dépose l'actif à prêter) ou
l'emprunteur (celui qui l'a pris). Chaque ligne est une position.
Clique dessus et tu obtiens le tableau complet : la santé du prêt,
ce qui est verrouillé en collatéral, l'intérêt accumulé, et les
boutons pour rembourser, réclamer ou liquider le moment venu.

Si un prêt couvre les deux rôles (tu as prêté sur l'un, emprunté sur
un autre), les deux apparaissent — même endroit, lignes différentes.

<a id="dashboard.vpfi-panel"></a>

### VPFI sur cette chaîne

**VPFI** est le token natif du protocole. En détenir dans ton vault
te donne une remise sur les frais du protocole. Cette carte
t'indique, sur la chaîne à laquelle tu es connecté :

- Combien de VPFI se trouvent dans ton wallet en ce moment.
- Combien sont dans ton vault (ce qui compte pour ton palier de remise).
- Quelle part de l'offre totale de VPFI tu détiens.
- Combien de VPFI il reste à minter au total (le protocole a un
  plafond strict).

Vaipakam fonctionne sur plusieurs chaînes. L'une d'elles (Base) est
la chaîne **canonique** où les nouveaux VPFI sont mintés ; les
autres sont des **mirrors** qui détiennent des copies maintenues
synchronisées via un pont cross-chain. De ton point de vue, tu n'as
pas à y penser — le solde que tu vois est réel sur n'importe quelle
chaîne où tu te trouves.

<a id="dashboard.fee-discount-consent"></a>

### Consentement à la remise sur frais

Vaipakam peut t'accorder une remise sur les frais du protocole selon
le VPFI que tu gardes en vault. Pour un emprunteur, la remise est
simplement une Loan Initiation Fee plus basse, prélevée dans l'actif
propre du prêt au moment où il démarre — aucun VPFI n'est dépensé
pour cela. Cet interrupteur est le "oui, fais-le". Tu ne le
bascules qu'une fois.

L'ampleur de la remise dépend de la quantité de VPFI que tu gardes en
vault :

- **Tier 1** — `{liveValue:tier1Min}` VPFI ou plus → `{liveValue:tier1DiscountBps}`% de remise
- **Tier 2** — `{liveValue:tier2Min}` VPFI ou plus → `{liveValue:tier2DiscountBps}`% de remise
- **Tier 3** — `{liveValue:tier3Min}` VPFI ou plus → `{liveValue:tier3DiscountBps}`% de remise
- **Tier 4** — plus de `{liveValue:tier4Min}` VPFI → `{liveValue:tier4DiscountBps}`% de remise

Tu peux désactiver l'interrupteur à tout moment. Si tu retires des
VPFI de ton vault, ton tier baisse en temps réel.

> **Remarque sur le gas du réseau blockchain.** La remise ci-dessus
> s'applique aux **frais de protocole** de Vaipakam (Commission de
> Rendement, Frais d'Initiation du Prêt). Les petits **frais de
> gas** que requiert chaque action on-chain — payés aux validateurs
> de la blockchain lors de la création d'une offre, l'acceptation,
> le remboursement, la réclamation, etc. — sont des frais séparés
> qui vont au réseau, pas à Vaipakam. Le protocole ne peut pas y
> appliquer de remise puisqu'il ne les reçoit jamais.

<a id="dashboard.rewards-summary"></a>

### Vos récompenses VPFI

Cette carte rassemble en un seul endroit toutes les
récompenses VPFI que vous avez gagnées du protocole. Le grand
nombre en haut est le total combiné — ce que vous avez déjà
réclamé plus ce qui attend d'être réclamé.

Les récompenses proviennent de l'**interaction avec la
plateforme** — vous gagnez un peu chaque jour pour chaque prêt
auquel vous participez, des deux côtés. Payé en VPFI sur la
chaîne sur laquelle vous êtes, sans pont.

La ligne a une petite flèche chevron à droite. Cliquez dessus
pour sauter directement à la carte de réclamation complète dans
le Claim Center.

Si vous n'avez encore rien gagné, la carte s'affiche quand
même avec *Total gagné : 0 VPFI* plus un indice sur comment
commencer. Vous n'avez rien fait de mal — il n'y a juste pas
d'historique à montrer.


---

<a id="chapter.offer-book"></a>

## Carnet d'offres

<a id="offer-book.filters"></a>

### Filtres

Les listes de marché peuvent être longues. Les filtres les
restreignent par actif concerné par le prêt, par nature de l'offre
(prêteur ou emprunteur), et selon quelques autres axes. Tes propres
offres actives restent toujours visibles en haut de la page — les
filtres n'affectent que ce que les autres te montrent.

<a id="offer-book.your-active-offers"></a>

### Vos offres actives

Les offres que **tu** as publiées et que personne n'a encore
acceptées. Tant qu'une offre est ici, tu peux l'annuler sans frais.
Une fois acceptée, la position devient un vrai prêt et passe à "Vos
prêts" sur le Tableau de bord.

<a id="offer-book.lender-offers"></a>

### Offres de prêteurs

Publications de personnes proposant de prêter. Chacune dit : "Je
prêterai X unités de l'actif Y au taux de Z% pendant D jours, en
échange de tant de collatéral".

Un emprunteur acceptant l'une de ces offres devient l'emprunteur
inscrit du prêt : le collatéral de l'emprunteur est verrouillé en
vault, l'actif principal arrive dans le wallet de l'emprunteur, et
les intérêts s'accumulent jusqu'à ce que l'emprunteur rembourse.

Le protocole impose une règle de sécurité du côté de l'emprunteur au
moment de l'acceptation : le collatéral doit valoir au moins 1.5×
le prêt. (Ce nombre s'appelle **Health Factor 1.5**.) Si le
collatéral de l'emprunteur n'est pas suffisant, le prêt ne démarre
pas.

<a id="offer-book.borrower-offers"></a>

### Offres d'emprunteurs

Publications d'emprunteurs ayant déjà verrouillé leur collatéral et
attendant que quelqu'un finance le prêt.

Un prêteur acceptant l'une de ces offres finance le prêt : l'actif
du prêteur va à l'emprunteur, le prêteur devient le prêteur inscrit,
et le prêteur perçoit des intérêts au taux de l'offre sur toute la
durée. Une petite portion (`{liveValue:treasuryFeeBps}`%) des intérêts revient à la trésorerie
du protocole au moment du règlement.
Ce taux est figé à la création du prêt : une modification ultérieure des
frais du protocole laisse un prêt déjà ouvert au taux avec lequel il a
commencé.

---

<a id="chapter.create-offer"></a>

## Créer une offre

<a id="create-offer.offer-type"></a>

### Type d'offre

Choisis un côté :

- **Prêteur** — le prêteur fournit un actif et perçoit des intérêts
  pendant qu'il est en cours.
- **Emprunteur** — l'emprunteur verrouille un collatéral et demande
  un autre actif en échange.

Une sous-option **Location** existe pour les NFT "louables" (une
classe spéciale de NFT pouvant être délégués temporairement). Les
locations ne prêtent pas d'argent — c'est le NFT lui-même qui est
loué pour des frais journaliers.

<a id="create-offer.lending-asset"></a>

### Actif prêté

L'actif et le montant en jeu, plus le taux d'intérêt (APR en %) et
la durée en jours. Le taux est fixé lorsque l'offre est publiée ;
personne ne peut le changer ensuite. Après la fin de la durée, une
courte fenêtre de grâce s'applique — si l'emprunteur n'a pas
remboursé d'ici là, le prêt peut être mis en défaut et la
réclamation du collatéral du prêteur s'enclenche.

<a id="create-offer.lending-asset:lender"></a>

#### Si tu es le prêteur

L'actif principal et le montant que tu es prêt à offrir, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut.

<a id="create-offer.nft-details"></a>

### Détails du NFT

Pour une offre de location, cette carte fixe les frais journaliers
de location. Le locataire paie le coût total de la location à
l'avance lors de l'acceptation, plus un petit buffer de 5% au cas où
l'opération s'étirerait légèrement. Le NFT lui-même reste en vault
pendant toute la durée — le locataire a le droit de l'utiliser mais
ne peut pas le déplacer.

<a id="create-offer.collateral"></a>

### Collatéral

Ce qui est verrouillé pour sécuriser le prêt. Deux variantes :

- **Liquide** — un token bien connu avec un flux de prix en direct
  (Chainlink + un pool on-chain suffisamment profond). Le protocole
  peut le valoriser en temps réel et liquider automatiquement la
  position si le prix bouge contre le prêt.
- **Illiquide** — NFT, ou tokens sans flux de prix. Le protocole ne
  peut pas les valoriser, donc en cas de défaut, le prêteur prend
  simplement tout le collatéral. Les deux parties doivent cocher une
  case acceptant cela avant que l'offre puisse être faite.

<a id="create-offer.collateral:lender"></a>

#### Si tu es le prêteur

Combien tu veux que l'emprunteur verrouille pour sécuriser le prêt.
Les ERC-20 liquides (flux Chainlink + ≥1M$ de profondeur de pool v3)
relèvent du calcul LTV/HF ; les ERC-20 illiquides et les NFT n'ont
pas de valorisation on-chain et nécessitent que les deux parties
consentent à un scénario de transfert intégral du collatéral en
défaut.

<a id="create-offer.collateral:borrower"></a>

#### Si tu es l'emprunteur

Combien tu es prêt à verrouiller pour sécuriser le prêt. Les ERC-20
liquides (flux Chainlink + ≥1M$ de profondeur de pool v3) relèvent
du calcul LTV/HF ; les ERC-20 illiquides et les NFT n'ont pas de
valorisation on-chain et nécessitent que les deux parties
consentent à un scénario de transfert intégral du collatéral en
défaut.

<a id="create-offer.risk-disclosures"></a>

### Avertissements de risque

Prêter et emprunter sur Vaipakam comporte un risque réel. Avant
qu'une offre soit signée, cette carte demande un consentement
explicite de la partie qui signe. Les risques ci-dessous s'appliquent
aux deux côtés ; les onglets spécifiques à chaque rôle ci-dessous
mettent en évidence dans quel sens chacun a tendance à mordre.

Vaipakam est non-custodial. Il n'y a aucun service support pouvant
inverser une transaction déjà passée. Lis attentivement avant de
signer.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si tu es le prêteur

- **Risque smart contract** — les contrats sont du code immuable ;
  un bug inconnu pourrait affecter les fonds.
- **Risque oracle** — un flux de prix obsolète ou manipulé peut
  retarder la liquidation au-delà du point où le collatéral couvre
  ton principal. Tu pourrais ne pas être indemnisé totalement.
- **Slippage de liquidation** — même quand la liquidation se
  déclenche à temps, le swap DEX peut s'exécuter à un prix plus
  défavorable que la cotation, rognant ce que tu récupères
  réellement.
- **Collatéral illiquide** — en cas de défaut, le collatéral te
  revient intégralement, mais s'il vaut moins que le prêt tu n'as
  aucun recours supplémentaire. Tu as accepté ce compromis lors de
  la création de l'offre.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si tu es l'emprunteur

- **Risque smart contract** — les contrats sont du code immuable ;
  un bug inconnu pourrait affecter ton collatéral verrouillé.
- **Risque oracle** — un flux de prix obsolète ou manipulé peut
  déclencher une liquidation contre toi au mauvais moment, même
  quand le prix réel du marché serait resté sûr.
- **Slippage de liquidation** — quand la liquidation se déclenche,
  le swap DEX peut vendre ton collatéral à un prix moins bon que
  prévu.
- **Collatéral illiquide** — en cas de défaut, ton collatéral
  intégral est transféré au prêteur, sans aucune réclamation
  résiduelle pour toi. Tu as accepté ce compromis lors de la
  création de l'offre.

<a id="create-offer.advanced-options"></a>

### Options avancées

Réglages supplémentaires pour les utilisateurs qui les veulent — la
plupart des gens les laissent tels quels. Des choses comme la durée
pendant laquelle une offre reste ouverte avant d'expirer, l'usage
ou non de VPFI pour la remise sur frais sur cette offre spécifique,
et quelques toggles spécifiques au rôle. Tu peux les passer sans
risque pour une première offre.

---

<a id="chapter.claim-center"></a>

## Centre de réclamations

<a id="claim-center.claims"></a>

### Fonds réclamables

Quand un prêt est terminé — remboursé, en défaut ou liquidé — ta
part du résultat ne va pas automatiquement dans ton wallet. Tu dois
cliquer sur **Réclamer** pour la récupérer. Cette page liste chaque
réclamation en attente que tu as sur cette chaîne.

Un utilisateur peut détenir simultanément des réclamations de
prêteur (issues de prêts qu'il a financés) et des réclamations
d'emprunteur (issues de prêts qu'il a pris) — les deux apparaissent
dans la même liste. Les deux onglets spécifiques au rôle décrivent
ce que chaque type de réclamation rend.

<a id="claim-center.claims:lender"></a>

#### Si tu es le prêteur

Ta réclamation de prêteur rend le principal du prêt plus les
intérêts accumulés, moins la coupe de trésorerie sur la portion
d'intérêts. Cette coupe est le pourcentage fixé à la création de ton
prêt — un changement ultérieur des frais du protocole ne la modifie
pas. Les prêts créés au taux actuel portent une coupe de
`{liveValue:treasuryFeeBps}`%. Elle devient réclamable dès que le prêt est
réglé — remboursé, en défaut ou liquidé. La réclamation consomme
ton NFT de position de prêteur de manière atomique — une fois
exécutée, ce côté du prêt est entièrement clos.

<a id="claim-center.claims:borrower"></a>

#### Si tu es l'emprunteur

Si tu as remboursé le prêt en totalité, ta réclamation d'emprunteur
te rend le collatéral que tu as verrouillé au début. En cas de
défaut ou de liquidation, vérifie quand même. On ne prélève que
la valeur qu'exigent la dette et les frais de sa clôture, et tout
ce qui dépasse est enregistré comme tien. Sa forme dépend de la
manière dont le prêt s'est terminé : si le collatéral a été vendu
via une place de marché, le reste te parvient dans l'actif du prêt
lui-même. S'il a été remis à la place, c'est le collatéral lui-même
qui t'attend. Plusieurs choses le remettent, quelle que soit la manière dont le prêt
s'est terminé : un liquidateur qui le prend directement avec une décote,
une clôture appariée à l'intérieur du protocole contre une position
opposée plutôt que vendue, ou une vente qui n'a pas pu se faire — là tu as le collatéral, sauf si le prêteur apporte une cotation qui
fonctionne au moment de la réclamation — tu es alors payé dans l'actif
du prêt ; la plupart n'en apportent aucune. Une liquidation
ordinaire comme un défaut cherchent cet appariement interne avant
d'aller sur le marché, donc aucun de ces deux-là ne finit toujours
pareil : lis la réclamation plutôt que de le déduire de la façon dont
le prêt s'est clos. La prise avec décote fait exception, et elle est
prévisible dans l'autre sens : elle ne vend jamais, donc il te reste
toujours le collatéral. Souvent — sur un
défaut portant sur un collatéral que nous ne pouvons pas
valoriser — tout le panier part et il ne reste rien, et sur cette voie c'est la règle, non une issue malheureuse. Réclamer consomme ton NFT de position
d'emprunteur. L'inverse n'est pas vrai : un NFT encore présent
après une liquidation ne prouve pas que quelque chose t'attend.
S'il ne restait rien, il n'y a rien à récupérer, la tentative est
refusée, et le NFT peut rester quand même. Lis ce que dit la créance plutôt que de
prendre le NFT pour une promesse.

---

<a id="chapter.activity"></a>

## Activité

<a id="activity.feed"></a>

### Flux d'activité

Chaque événement on-chain impliquant ton wallet sur la chaîne à
laquelle tu es connecté — chaque offre que tu as publiée ou
acceptée, chaque prêt, chaque remboursement, chaque réclamation,
chaque liquidation. Tout est lu en direct depuis la chaîne
elle-même ; il n'y a aucun serveur central qui pourrait tomber. Les
plus récents en premier, regroupés par transaction pour que les
choses faites en un même clic restent ensemble.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Obtenir du VPFI

VPFI est librement transférable. Procure-t'en sur le marché ouvert
partout où il s'échange, ou transfère-le par bridge — VPFI est un
token Chainlink CCIP, donc il circule entre les chaînes prises en
charge via le bridge officiel et atterrit dans ton wallet sur
n'importe quelle chaîne à laquelle tu es connecté.

<a id="buy-vpfi.discount-status"></a>

### Votre statut de remise VPFI

Lecture rapide du tier de remise dans lequel tu te trouves
actuellement. Le tier vient de la quantité de VPFI dans ton
**vault** (pas dans ton wallet). La carte t'indique aussi (a)
combien de VPFI supplémentaires il faudrait dans l'vault pour
passer au tier suivant, et (b) si l'interrupteur de consentement du
Tableau de bord est activé — la remise ne s'applique que tant
qu'il l'est.

<a id="buy-vpfi.deposit"></a>

### Dépose le VPFI dans ton vault

Le VPFI dans ton wallet ne compte pas pour le palier de remise.
Pour débloquer la remise sur les frais, tu dois déplacer le VPFI
dans ton vault toi-même. C'est toujours un clic explicite —
l'application ne déplace jamais ton VPFI sans que tu le demandes.
Une transaction (ou une seule signature, sur les chaînes qui le
supportent) et c'est réglé.

<a id="buy-vpfi.unstake"></a>

### Désengage du VPFI de ton vault

Tu veux récupérer du VPFI dans ton wallet ? Cette carte le renvoie
de l'vault vers toi. Attention : retirer du VPFI fait baisser ton
tier de remise **immédiatement**. Si tu as des prêts ouverts, le
calcul de la remise bascule au tier inférieur à partir de cet
instant.

---

<a id="chapter.rewards"></a>

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Vaipakam te verse une **récompense d'interaction avec la
plateforme** : chaque dollar d'intérêts qu'un prêt auquel tu
participes parvient réellement à régler te rapporte une part
journalière d'une enveloppe de récompenses communautaire.

Les récompenses sont versées en VPFI, mintées directement sur la
chaîne où tu te trouves. Pas de pont, pas de changement de chaîne.

<a id="rewards.claim"></a>

### Réclamer les récompenses

Un seul bouton réclame tes récompenses accumulées en une seule
transaction. La part de l'enveloppe d'interaction se règle une fois
par jour, donc si tu en as gagné depuis le dernier règlement, elle
ne devient effective que peu après la fermeture de la prochaine
fenêtre journalière.

---

<a id="chapter.loan-details"></a>

## Détails du prêt

<a id="loan-details.overview"></a>

### Détails du prêt (cette page)

Tout sur un prêt unique, sur une seule page. Les conditions sous
lesquelles il a été ouvert, sa santé actuelle, qui est de chaque
côté, et chaque bouton sur lequel tu peux appuyer en fonction du
rôle que tu joues — rembourser, réclamer, liquider, clôturer
anticipativement, refinancer.

<a id="loan-details.terms"></a>

### Conditions du prêt

Les parties fixes du prêt : quel actif a été prêté, combien, le
taux d'intérêt, la durée, et combien d'intérêts se sont accumulés
jusqu'à présent. Aucun de ces éléments ne change une fois le prêt
ouvert. (Si des conditions différentes sont nécessaires, refinance
— l'application crée un nouveau prêt et règle celui-ci dans la même
transaction.)

<a id="loan-details.collateral-risk"></a>

### Collatéral & Risque

Le collatéral sur ce prêt, plus les chiffres de risque en direct —
Health Factor et LTV. Le **Health Factor** est un score de sécurité
unique : au-dessus de 1, le collatéral couvre confortablement le
prêt ; proche de 1, c'est risqué et le prêt pourrait être liquidé.
Le **LTV** mesure "combien a été emprunté par rapport à la valeur
de ce qui a été déposé". Les seuils où la position devient
dangereuse figurent sur la même carte.

Si le collatéral est illiquide (un NFT ou un token sans flux de
prix en direct), ces chiffres ne peuvent pas être calculés. Les
deux parties ont accepté ce résultat lors de la création de
l'offre.

<a id="loan-details.collateral-risk:lender"></a>

#### Si tu es le prêteur

Voilà le collatéral de l'emprunteur — ta protection. Tant que HF
reste au-dessus de 1, tu es bien couvert. Quand HF baisse, ta
protection s'amincit ; s'il franchit 1, n'importe qui (toi inclus)
peut déclencher la liquidation, et le swap DEX convertit le
collatéral en ton actif principal pour te rembourser. Sur un
collatéral illiquide, le défaut te transfère le collatéral
intégralement — tu prends ce qu'il vaut.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si tu es l'emprunteur

Voilà ton collatéral verrouillé. Garde HF confortablement au-dessus
de 1 — quand il s'en approche, tu es à risque de liquidation. Tu
peux généralement remonter HF en ajoutant du collatéral ou en
remboursant une partie du prêt. Si HF franchit 1, n'importe qui
peut déclencher la liquidation, et le swap DEX vendra ton
collatéral à des prix érodés par le slippage pour rembourser le
prêteur. Sur un collatéral illiquide, le défaut transfère
l'intégralité de ton collatéral au prêteur sans aucune réclamation
résiduelle pour toi.

<a id="loan-details.parties"></a>

### Parties

Les deux adresses de wallet sur ce prêt — prêteur et emprunteur —
et les coffres d'vault qui détiennent leurs actifs. Chaque côté
a aussi reçu un "NFT de position" à l'ouverture du prêt. Ce NFT
_est_ le droit à la part de résultat de ce côté — garde-le en
sécurité. Si un détenteur le transfère à quelqu'un d'autre, le
nouveau détenteur peut réclamer à sa place.

<a id="loan-details.actions"></a>

### Actions

Chaque bouton disponible sur ce prêt. L'ensemble que tu vois
dépend de ton rôle sur ce prêt précis — les onglets spécifiques au
rôle ci-dessous listent les options de chaque côté. Les boutons
indisponibles pour le moment sont grisés, avec une petite
info-bulle expliquant pourquoi.

<a id="loan-details.actions:lender"></a>

#### Si tu es le prêteur

- **Réclamer** — une fois le prêt réglé (remboursé, en défaut ou
  liquidé), débloque le principal plus les intérêts, moins la
  coupe de trésorerie fixée à la création de ton prêt
  (`{liveValue:treasuryFeeBps}`% pour les prêts créés au taux
  actuel). Consomme ton NFT de prêteur.
- **Initier un retrait anticipé** — mets en vente ton NFT de
  prêteur à un autre acheteur en cours de prêt. L'acheteur prend
  le relais de ton côté ; tu repars avec le produit de la vente.
- **Liquider** — n'importe qui (toi inclus) peut déclencher cela
  quand HF descend sous 1 ou quand la période de grâce expire.

<a id="loan-details.actions:borrower"></a>

#### Si tu es l'emprunteur

- **Rembourser** — total ou partiel. Le remboursement partiel
  abaisse ton solde restant et améliore HF ; le remboursement
  total clôt le prêt et débloque ton collatéral via Réclamer.
- **Clôture anticipée** — clôt le prêt avant terme. Voie directe :
  payer le solde restant complet depuis ton wallet maintenant.
  Voie offset : vendre une partie du collatéral sur un DEX,
  utiliser le produit pour rembourser, récupérer ce qui reste.
- **Refinancer** — basculer vers un nouveau prêt avec de nouvelles
  conditions ; le protocole solde l'ancien prêt depuis le nouveau
  principal en une seule transaction. Le collatéral ne quitte
  jamais l'vault.
- **Réclamer** — une fois le prêt réglé, rend ton collatéral en
  cas de remboursement total. En cas de défaut il peut rester un
  excédent : on ne prélève que le collatéral qu'exigent la dette et
  le coût de sa clôture, et ce que tu avais déposé en plus est
  enregistré comme ta créance. Ce que c'est dépend du chemin —
  voir la section Claim Center.

---

<a id="chapter.allowances"></a>

## Allowances

<a id="allowances.list"></a>

### Allowances

Quand tu acceptes une offre, ton wallet "approuve" parfois Vaipakam
à déplacer un token spécifique en ton nom. Certains wallets ont
tendance à laisser ces approbations ouvertes plus longtemps que
nécessaire. Cette page liste chaque approbation que tu as donnée à
Vaipakam sur cette chaîne et te permet d'en désactiver n'importe
laquelle en un clic. Les approbations non nulles (celles
réellement actives) apparaissent en haut.

Une liste d'approbations propre est une habitude d'hygiène — comme
sur Uniswap ou 1inch.

---

<a id="chapter.alerts"></a>

## Alertes

<a id="alerts.overview"></a>

### À propos des alertes

Quand le prix de ton collatéral baisse, le score de sécurité de
ton prêt (son Health Factor) baisse avec lui. Les alertes te
permettent de t'inscrire pour recevoir un avertissement **avant**
que quiconque puisse te liquider. Un petit service off-chain
surveille tes prêts toutes les cinq minutes et t'envoie un ping au
moment où le score traverse une bande de danger. Aucun coût en gas ;
rien ne se passe on-chain.

<a id="alerts.threshold-ladder"></a>

### Échelle de seuils

Les bandes de danger qu'utilise le watcher. Passer dans une bande
plus dangereuse déclenche une fois. Le ping suivant n'arrive que si
tu traverses une autre bande encore plus profonde. Si tu remontes
dans une bande plus sûre, l'échelle se réinitialise. Les valeurs
par défaut sont calibrées pour des prêts typiques ; si tu détiens
un collatéral très volatil, tu peux vouloir fixer des seuils plus
élevés.

<a id="alerts.delivery-channels"></a>

### Canaux de livraison

Là où les pings arrivent réellement. Tu peux choisir Telegram (un
bot t'envoie un DM), ou Push Protocol (notifications directement
dans ton wallet), ou les deux. Les deux canaux partagent la même
échelle de seuils ci-dessus — tu ne les règles pas séparément.

---

<a id="chapter.nft-verifier"></a>

## Vérificateur de NFT

<a id="nft-verifier.lookup"></a>

### Vérifier un NFT

Les NFT de position Vaipakam apparaissent parfois sur des marchés
secondaires. Avant d'en acheter un à un autre détenteur, colle ici
l'adresse du contrat NFT et le token ID. Le vérificateur confirme
(a) qu'il a bien été minté par Vaipakam, (b) sur quelle chaîne vit
le prêt sous-jacent, (c) dans quel état se trouve ce prêt, et (d)
qui détient actuellement le NFT on-chain.

Le NFT de position _est_ le droit de réclamer sur le prêt. Repérer
un faux — ou une position déjà réglée — t'évite la mauvaise
transaction.

---

<a id="chapter.keeper-settings"></a>

## Paramètres des keepers

<a id="keeper-settings.overview"></a>

### À propos des keepers

Un "keeper" est un wallet en qui tu as confiance pour effectuer des
actions de maintenance spécifiques sur tes prêts à ta place —
finaliser un retrait anticipé, finaliser un refinancement, ce
genre de choses. Les keepers ne peuvent jamais dépenser ton argent
— rembourser, ajouter du collatéral, réclamer et liquider restent
réservés à l'utilisateur. Tu peux approuver jusqu'à 5 keepers, et
tu peux désactiver l'interrupteur principal à tout moment pour les
désactiver tous d'un coup.

<a id="keeper-settings.approved-list"></a>

### Keepers approuvés

Chaque keeper de la liste ne peut faire **que les actions que tu
as cochées** pour lui. Donc un keeper avec uniquement "finaliser
retrait anticipé" autorisé ne peut pas en démarrer un en ton nom —
il ne peut que finaliser celui que tu as démarré. Si tu changes
d'avis, modifie les coches ; si tu veux qu'un keeper disparaisse
totalement, retire-le de la liste.

---

<a id="chapter.public-analytics-dashboard"></a>

## Tableau de bord d'analytique publique

<a id="public-dashboard.overview"></a>

### À propos de Public Analytics

Une vue du protocole sans wallet, sur un réseau : celui que l'app
lit. Tu n'as rien à connecter. La page s'appuie sur deux sources
publiques et indique d'où vient chaque chiffre — l'indexeur
public, que chacun peut interroger sans clé, et le contrat de la
plateforme lui-même —, pour que tu n'aies jamais à croire un
chiffre sur parole.

<a id="public-dashboard.loans-offers"></a>

### Prêts et offres

Le nombre de prêts par état (actifs, remboursés, en défaut,
liquidés, etc.) et d'offres par état, depuis l'indexeur public. Un
nombre que l'indexeur n'a pas fourni s'affiche « non fourni »,
jamais zéro. Seules les offres on-chain sont comptées : les ordres
signés sans gas ne le sont pas ici, même s'ils apparaissent dans
l'Offer Book. Le total des offres correspond aux offres
actuellement enregistrées, pas à un total historique.

<a id="public-dashboard.recycling"></a>

### Compte de recyclage et bouclage

D'où venait la réserve de récompenses de chaque jour et combien
en a été prélevé, et quelle part du VPFI de récompense versé par
les réclamations reste dans la plateforme. Ce sont des écritures
comptables de l'indexeur public ; un chiffre encore inconnu le dit
au lieu d'afficher zéro.

<a id="public-dashboard.transparency"></a>

### Transparence & source

L'adresse du contrat de la plateforme, avec un lien pour l'ouvrir
dans un explorateur de blocs, le réseau, le dernier bloc lu par
l'indexeur et depuis combien de temps. Les chiffres de l'indexeur
ne sont à jour que jusqu'à ce bloc, d'où l'affichage de son
âge.

<a id="public-dashboard.vpfi-transparency"></a>

### Jeton VPFI

Lu directement dans le contrat de la plateforme, pas dans
l'indexeur : l'adresse du jeton VPFI et son offre sur ce réseau.
Sur le réseau où VPFI est émis, la page montre aussi le plafond
d'offre, ce qui peut encore être émis en dessous, et la seule
adresse autorisée à émettre. Sur un réseau que VPFI atteint par
pont, elle ne montre que l'offre de ce réseau.

<a id="public-dashboard.fees"></a>

### Frais et trésorerie

Également lus dans le contrat : les frais enregistrés par le
protocole depuis le début de l'enregistrement, sur le dernier jour
et sur la dernière semaine, et l'adresse de trésorerie où ils
vont. La page indique le bloc lu, l'âge de cette lecture et les
fonctions appelées, et énonce chaque raison pour laquelle les
chiffres des frais peuvent être inférieurs à ce qui a réellement
été perçu. Après un changement de devise de référence, les frais
antérieurs restent dans l'ancienne unité, ce qui peut écarter un
total dans un sens comme dans l'autre ; la page le dit aussi. Un
chiffre qui n'a pas pu être lu le dit au lieu d'afficher zéro.

---

<a id="chapter.refinance"></a>

## Refinancer

Cette page est réservée aux emprunteurs — le refinancement est
initié par l'emprunteur sur le prêt de l'emprunteur.

<a id="refinance.overview"></a>

### À propos du refinancement

Le refinancement bascule ton prêt existant vers un nouveau sans
toucher à ton collatéral. Tu publies une nouvelle offre côté
emprunteur avec les nouvelles conditions ; une fois qu'un prêteur
accepte, le protocole solde l'ancien prêt et ouvre le nouveau dans
une seule transaction. À aucun moment ton collatéral n'est sans
protection.

<a id="refinance.position-summary"></a>

### Votre position actuelle

Un instantané du prêt que tu refinances — ce qui reste dû, combien
d'intérêts se sont accumulés, sa santé, ce qui est verrouillé.
Sers-toi de ces chiffres pour dimensionner la nouvelle offre
intelligemment.

<a id="refinance.step-1-post-offer"></a>

### Étape 1 — Publie la nouvelle offre

Tu publies une offre d'emprunteur avec l'actif, le montant, le
taux et la durée que tu veux pour le refinancement. Tant qu'elle
est listée, l'ancien prêt continue normalement — les intérêts
s'accumulent encore, ton collatéral reste en place. Les autres
utilisateurs voient cette offre dans le Carnet d'offres.

<a id="refinance.step-2-complete"></a>

### Étape 2 — Finaliser

Une fois qu'un prêteur a accepté ton offre de refinancement,
clique sur Finaliser. Le protocole, atomiquement : rembourse
l'ancien prêt depuis le nouveau principal, ouvre le nouveau prêt,
et garde ton collatéral verrouillé tout du long. Une transaction,
deux états changés, aucune fenêtre d'exposition.

---

<a id="chapter.preclose"></a>

## Clôture anticipée

Cette page est réservée aux emprunteurs — la clôture anticipée
(preclose) est initiée par l'emprunteur sur son prêt.

<a id="preclose.overview"></a>

### À propos de la clôture anticipée

La clôture anticipée, c'est "fermer mon prêt avant terme". Tu as
deux voies :

- **Direct** — payer la totalité du solde restant depuis ton
  wallet maintenant.
- **Offset** — vendre une partie de ton collatéral sur un DEX et
  utiliser le produit pour solder le prêt. Tu récupères ce qui
  reste.

Direct revient moins cher si tu as les liquidités. Offset est la
réponse quand tu ne les as pas, mais que tu ne veux plus non plus
laisser le prêt courir.

<a id="preclose.position-summary"></a>

### Votre position actuelle

Un instantané du prêt que tu clos en avance — solde restant,
intérêts accumulés, santé actuelle. Clore en avance est juste sur
le plan des frais — il n'y a pas de pénalité forfaitaire ; le
calcul VPFI pondéré dans le temps du protocole gère la
comptabilité.

<a id="preclose.in-progress"></a>

### Offset en cours

Tu as démarré un offset preclose il y a un instant et l'étape de
swap est en plein vol. Tu peux soit le finaliser (le produit règle
le prêt et tout reliquat te revient), soit — si le prix a bougé
pendant ta réflexion — l'annuler et réessayer avec une nouvelle
cotation.

<a id="preclose.choose-path"></a>

### Choisis une voie

Choisis **Direct** si tu as les liquidités pour solder le prêt
maintenant. Choisis **Offset** si tu préfères vendre une partie du
collatéral en sortie. L'une ou l'autre voie clôt le prêt en
totalité ; tu ne peux pas faire une demi-clôture en preclose.

---

<a id="chapter.early-withdrawal-lender"></a>

## Retrait anticipé (prêteur)

Cette page est réservée aux prêteurs — le retrait anticipé est
initié par le prêteur sur son prêt.

<a id="early-withdrawal.overview"></a>

### À propos de la sortie anticipée du prêteur

Si tu veux sortir d'un prêt avant la fin de la durée, tu peux
mettre ton NFT de prêteur en vente via le protocole. L'acheteur te
paie pour ; en retour, il prend ton côté du prêt — il encaisse le
remboursement éventuel + les intérêts. Tu repars avec ton argent
plus la prime éventuelle versée par l'acheteur.

<a id="early-withdrawal.position-summary"></a>

### Votre position actuelle

Un instantané du prêt dont tu sors — principal, intérêts accumulés
jusqu'à présent, temps restant, et le score de santé actuel de
l'emprunteur. Ce sont les chiffres qu'un acheteur regardera pour
décider de la valeur de ton NFT.

<a id="early-withdrawal.initiate-sale"></a>

### Initier la vente

Tu fixes le prix demandé, le protocole met en liste ton NFT de
prêteur, et tu attends un acheteur. Dès qu'un acheteur accepte, le
produit atterrit dans ton wallet et le prêt continue — mais tu
n'es plus engagé dessus. Tant que la mise en vente est ouverte et
non remplie, tu peux l'annuler.

<a id="chapter.next-app"></a>

## La prochaine app

La prochaine version de l'app Vaipakam se construit page par page, à
côté de l'actuelle. Une page pas encore construite le dit et vous
renvoie vers l'app actuelle, qui la sert toujours. Ce chapitre
explique les pages déjà construites.

<a id="advanced-mode"></a>

### Basic et Advanced

Basic montre ce dont la plupart des gens ont besoin. Advanced ajoute
les outils de sortie et de règlement, l'automatisation, les ordres
signés, l'état des keepers et le détail comptable. Changer de mode ne
masque jamais un consentement à donner, ce qui vous bloque, ni le
moyen d'y remédier. Chaque bouton d'information (i), après la phrase qu'il explique,
ouvre l'explication complète, et son lien « En savoir plus » ouvre ce guide dans le mode
que vous utilisez.

<a id="wallet"></a>

### Votre wallet et l'origine de vos chiffres

L'app lit vos loans, votre vault et vos claims d'abord par la propre
connexion de votre wallet au réseau. Ce n'est que si le wallet n'en
propose aucune qu'elle utilise un proxy en lecture seule. Vos
chiffres ne viennent jamais de l'index partagé. L'adresse et le
réseau affichés en haut sont ceux auxquels appartient chaque chiffre
de la page. Si votre wallet est sur un réseau que l'app ne sert pas,
rien de vous n'est affiché tant que vous ne changez pas.

<a id="deployments"></a>

### Ce que le déploiement prend en charge

Avant de proposer une action, l'app lit quelles fonctions le contrat
du protocole prend en charge en ce moment sur votre réseau. Une mise
à jour peut changer cette liste, et la lire permet à l'app de vous
dire ce qui a changé au lieu d'échouer. Si la liste est illisible,
aucune étape de signature n'est proposée.

<a id="home-start"></a>

### Home : choisir une tâche

Home commence par « Je veux… » : emprunter, prêter, louer un NFT,
mettre votre NFT en location ou gérer ce que vous avez. Chaque choix
ouvre une page guidée. Emprunter et prêter montrent d'abord les
offres qui correspondent et vous laissent publier la vôtre si aucune
ne convient. La location couvre les deux côtés : utiliser le NFT de
quelqu'un d'autre, ou laisser quelqu'un utiliser le vôtre pendant
qu'il reste dans un vault. Avec un wallet connecté, Home montre aussi
trois courtes cartes de démarrage, que vous pouvez masquer.

<a id="home-status"></a>

### Home : état du protocole

Home indique toujours si le protocole tourne sur votre réseau.
Pendant une pause liée à un incident, les nouvelles positions, les
claims, les retraits, les liquidations, les défauts et les étapes des
keepers s'arrêtent. Le remboursement total, le remboursement partiel
et l'ajout de collatéral restent ouverts, et le temps de pause
s'ajoute à l'échéance de chaque loan ouvert. Une pause automatique
dure un temps fixe, et une nouvelle ne peut commencer qu'après un
délai de carence. Le service des keepers peut être mis en pause à
part ; cela ne bloque jamais ce que vous faites vous-même. Si l'état
est illisible, Home le dit en haut au lieu de supposer que tout
tourne.

<a id="home-payouts"></a>

### Home : prêt à encaisser

Un paiement est prêt quand un loan est terminé et qu'un claim vous
paierait maintenant : le remboursement pour le prêteur, le collatéral
rendu (ou ce qu'il en reste) pour l'emprunteur, ou un NFT rendu à la
fin d'une location. Home les liste en premier et vous envoie vers
Claims, qui montre chaque montant avant l'encaissement.

<a id="home-loans"></a>

### Home : vos loans

Chaque loan en cours montre votre côté, ses conditions, son
collatéral et sa prochaine échéance, la plus urgente d'abord. Un loan
est dû à sa date d'échéance. Ensuite court un délai de grâce pendant
lequel l'emprunteur peut encore rembourser avec des frais de retard.
Une fois ce délai écoulé, n'importe qui peut lancer le défaut, qui
règle le loan sur le collatéral. Le health factor compare la valeur
du collatéral à la dette : sous 1, le loan peut être liquidé. Un loan
dans un actif sans prix n'a pas de health factor. Les loans ouverts à
partir d'une de vos offres sont montrés ensemble.

Un loan qui paie des intérêts périodiquement a aussi des échéances intermédiaires, jusqu'à son échéance finale incluse. Les intérêts encore dus à la fin du délai de grâce d'une échéance peuvent être payés en vendant du collatéral, et le loan reste ouvert ; Home montre la prochaine échéance et place en premier une échéance impayée, même si elle tombe à l'échéance finale, car son délai de grâce peut finir avant celui du loan. Le protocole peut désactiver ce règlement ; Home indique alors qu'aucun collatéral n'est vendu à une échéance.

<a id="home-exposure"></a>

### Home : prêté et emprunté

Quand vous prêtez et empruntez à la fois, Home compare les deux côtés
selon leur valeur du jour. Les loans impossibles à évaluer, comme les
NFT ou les actifs sans prix, sont comptés et laissés de côté, et Home
ne nomme le côté le plus grand que s'ils ne pourraient pas changer la
réponse.

<a id="home-faucet"></a>

### Home : actifs de test

Sur un réseau de test, Home propose des jetons et des NFT de test pour essayer d'emprunter, de prêter et de louer sans argent réel. Ils n'ont aucune valeur et sont frappés par des contrats de jetons de test, pas par le protocole. Certains jetons de test ont un prix de test, donc les prêts qui les utilisent ont un facteur de santé ; d'autres n'en ont pas, donc un défaut remet la garantie elle-même. Les NFT de test peuvent être loués. Chaque frappe affiche d'abord un reçu, et le résultat est vérifié ensuite sur la chaîne.

<a id="home-fee-discount"></a>

### Home : remise sur les frais

La remise sur les frais est un seul réglage par réseau pour tout votre wallet. Tant qu'elle est désactivée, vos frais n'ont aucune remise, quel que soit le VPFI que vous détenez. Tant qu'elle est activée, les frais payés quand vous empruntez sont réduits, de même que les frais sur les intérêts que vous gagnez comme prêteur, selon votre niveau de remise VPFI au moment où chaque frais est prélevé ; au niveau 0, il n'y en a pas. Sur certains réseaux, la remise du prêteur est payée en VPFI depuis votre vault, et le reçu indique lequel s'applique avant que vous confirmiez. L'activer exige d'avoir accepté les Conditions en vigueur ; la désactiver, jamais. Pendant une pause du protocole, elle ne peut être modifiée dans aucun sens. Un prêt dans un actif prêté illiquide paie toujours les frais complets, et aucune remise ne dépasse jamais la moitié des frais.

<a id="home-rewards"></a>

### Home: Récompenses

Les récompenses sont des remises d'usage sur vos prêts et emprunts sur ce réseau, comptées par jour de récompense et versées en VPFI. Home affiche exactement ce que paierait une réclamation faite maintenant, car l'app exécute d'abord la réclamation en aperçu. Si cet aperçu ne peut pas s'exécuter, Home affiche à la place une borne inférieure, indiquée comme telle, et ne propose la réclamation qu'une fois le montant exact calculable. Une réclamation paie jusqu'à 30 jours de récompense ; s'il en reste, Home propose de réclamer à nouveau, et s'arrêter en cours de route est sans risque. Une réclamation est livrée dans votre coffre, prête à l'emploi, ou dans votre portefeuille quand le coffre ne peut pas la recevoir ; une réclamation n'ouvre jamais de coffre. Quand un jour de récompense attend encore sa finalisation entre réseaux, ou que son financement atteigne ce réseau, Home nomme ce jour au lieu de proposer une réclamation qui échouerait. Les récompenses ne sont ni des intérêts ni un rendement, et réclamer ne met jamais rien en staking ni ne réinvestit rien. Il arrive qu'un claim ne paie rien tout en dépassant des jours de récompense qui ne vous ont rien payé, afin que les jours suivants puissent être payés ; Home le dit et le propose quand même.

<a id="home-rewards-expiry"></a>

### Home: Dates de retrait des récompenses

Sur un réseau où les récompenses non réclamées peuvent être retirées, Home affiche la date de retrait estimée la plus proche parmi vos récompenses, et un dernier avis dans les 90 derniers jours avant celle-ci. Réclamer avant garde toujours la récompense. L'estimation n'est jamais postérieure à la date réelle en l'état : le temps pendant lequel la récompense ne peut pas être réclamée repousse la date réelle, mais une modification de la fenêtre de réclamation du réseau peut l'avancer, vérifiez donc à nouveau avant de vous y fier. Si toutes les récompenses n'ont pas pu être vérifiées, Home le dit au lieu d'affirmer que rien n'est dû. Là où le réseau ne retire rien, aucune date n'est affichée.

<a id="home-rewards-held"></a>

### Home: Récompenses retenues

Si le filtrage des sanctions signale votre portefeuille, rien ne lui est versé tant que le signalement demeure. Les récompenses gagnées avant le signalement sont retenues pour lui, bloquées mais pas perdues, et libérées dès que le portefeuille n'est plus signalé ; Home propose alors de réclamer exactement ce solde seul. Tant qu'un signalement est confirmé, les récompenses gagnées sont perdues définitivement et le VPFI de votre coffre ne peut pas être déplacé. S'il est impossible de lire si le portefeuille est toujours signalé, rien n'est libéré.

<a id="borrow-start"></a>

### Borrow: Comment ça marche

Pour emprunter, vous acceptez l'offre ouverte d'un prêteur : un montant d'un token, un taux, une durée et la garantie que le prêteur demande. L'accepter ouvre le prêt en une seule transaction. Votre garantie passe de votre wallet à votre propre vault, où elle reste bloquée tant que le prêt est ouvert, et le montant, moins de petits frais d'ouverture, arrive dans votre wallet. Vous remboursez le montant plus les intérêts avant l'échéance. Si aucune offre ne convient, vous pouvez aussi publier votre propre demande d'emprunt et attendre un prêteur.

<a id="borrow-pair"></a>

### Borrow: Choisir les tokens

Choisissez d'abord ce que vous empruntez et ce que vous bloquez. L'app suggère des tokens du réseau, ou vous pouvez coller une adresse de token ; aucun contrôle de sécurité des tokens n'est fait, vérifiez donc vous-même une adresse collée. Pour chaque token, l'app lit ce que le protocole en dit maintenant. Un token liquide a un prix : le prêt a un facteur de santé et peut être liquidé si la garantie perd de la valeur. Un token illiquide est évalué à zéro, et en cas de défaut le prêteur reçoit la garantie elle-même. Quand le protocole ne fait pas confiance au prix d'un token, les nouveaux prêts sur celui-ci sont fermés jusqu'à ce qu'il lui fasse de nouveau confiance ; les prêts déjà ouverts ne sont pas concernés.

<a id="borrow-offers"></a>

### Borrow: Choisir une offre

La page liste les offres ouvertes des prêteurs pour vos deux tokens, lues dans le protocole lui-même. Chacune indique le montant, le taux et la durée, la garantie demandée, le ratio prêt-valeur aux prix du jour, le mode de calcul des intérêts, l'éventuel calendrier d'intérêts, la fin de l'offre et ce que vous recevriez après les frais. Une offre s'accepte en entier, au montant complet du prêteur et à son taux le plus bas. Si le protocole refuserait une offre, la page dit pourquoi et n'affiche pas de bouton. L'ordre est une commodité, pas un conseil.

<a id="borrow-review"></a>

### Borrow: Vérifier et signer

Avant que votre wallet ne s'ouvre, la vérification montre chaque chiffre : ce que vous recevez, les frais, ce que vous bloquez, le taux, ce que vous devez à l'échéance, le délai de grâce et ce que vous pouvez perdre. Vous cochez une case pour accepter les Informations sur les risques et les Conditions ; si les chiffres changent avant votre confirmation, la case se décoche. Votre wallet vous demande ensuite de signer les conditions, ce qui ne coûte rien, d'approuver exactement la garantie si nécessaire, puis d'envoyer l'acceptation, que l'app essaie d'abord à blanc. Si cela s'arrête après une approbation, l'app demande de la remettre et dit si c'est fait. Ensuite, l'app vérifie sur la chaîne le prêt ouvert, ce qui est arrivé et ce qui a été bloqué. Il indique aussi les conditions du prêt sur sa durée, chacune même lorsqu'elle est celle par défaut : remboursement partiel, vente de la garantie, et tout refinancement ou prêt lié. Le montant dû suppose aucune pause : une pause repousse l'échéance et les intérêts continuent de courir pendant celle-ci.

<a id="borrow-fee"></a>

### Borrow: Les frais d'ouverture

Ouvrir un prêt coûte une petite part du montant, prélevée une fois, dans le token emprunté, et déduite de ce que vous recevez ; la vérification montre le taux en vigueur. Vous devez des intérêts sur le montant entier. Votre niveau de remise réduit les frais quand la remise sur les frais est activée et que le token emprunté est liquide. Aucun VPFI n'est pris ni conservé pour ces frais, et rien n'est remboursé plus tard. Comme vous envoyez vous-même l'acceptation, une petite part des frais, celle que le protocole verse à quiconque soumet un appariement, vous revient avec le montant ; la vérification l'indique.

<a id="borrow-risks"></a>

### Borrow: Risques

Un prêt peut vous coûter votre garantie. Si vous n'avez pas remboursé à la fin du délai de grâce, le prêt est en défaut et le prêteur est payé sur votre garantie : vendue pour lui là où le protocole le peut, remise telle quelle sinon. Avec une garantie liquide, si sa valeur baisse jusqu'à ce que le facteur de santé passe sous 1, n'importe qui peut liquider le prêt et vous perdez de la garantie. Avec des intérêts sur toute la durée, vous devez les intérêts de toute la durée même en remboursant tôt. Avec un calendrier d'intérêts, une période manquée est payée en vendant une partie de votre garantie. Votre garantie reste bloquée jusqu'au remboursement ou au règlement du prêt.

<a id="borrow-request"></a>

### Borrow : Publier votre propre demande

Si aucune offre ne convient, vous pouvez publier votre propre demande d'emprunt pour vos deux tokens : le montant exact, le taux que vous paierez, la durée et la garantie que vous bloquez. La publication déplace la garantie de votre wallet vers votre propre vault, où elle reste tant que la demande est ouverte. Un prêteur qui l'accepte ouvre le prêt aussitôt, à vos conditions, sans vous redemander ; le montant, moins les frais d'ouverture, arrive dans votre wallet. Vous pouvez annuler à partir de cinq minutes après la publication, et la garantie revient dans votre wallet. Une demande expirée ne peut plus être acceptée ; sa garantie reste dans votre vault jusqu'à ce que vous, ou n'importe qui, la clôturiez, puis revient uniquement dans votre wallet. Tant que la page Offres de la prochaine app n'est pas construite, vous suivez, annulez et clôturez une demande sur la page Offres de l'app actuelle ; la vérification le dit avant que quoi que ce soit ne soit bloqué.

<a id="borrow-request-terms"></a>

### Borrow : Les conditions de la demande

Un seul prêteur prend tout le montant, ou personne. Chaque chiffre est lu exactement comme vous le saisissez : plus de décimales que n'en a le token sont refusées, jamais arrondies, et le taux va jusqu'à 100 % par an avec deux décimales. Les durées proposées s'arrêtent à la plus longue que le réseau autorise ; vous pouvez aussi saisir une durée en jours. La demande reste ouverte jusqu'à son acceptation ou son annulation, ou pendant le nombre de jours choisi, jusqu'à un an. Les intérêts sur toute la durée, le choix habituel, sont dus en entier même si vous remboursez tôt ; au prorata, seule la période où le prêt est ouvert est facturée. Le formulaire montre ce que vous recevriez au taux de frais d'aujourd'hui et devriez à l'échéance si un prêteur l'acceptait maintenant.

<a id="borrow-request-review"></a>

### Borrow : Vérifier et publier une demande

Avant que votre wallet ne s'ouvre, l'app demande au protocole d'essayer votre demande à blanc, si bien que la vérification montre la réponse du protocole lui-même. Elle indique ce que vous bloquez maintenant, le montant, le taux et la durée, ce que vous recevriez et comment les frais sont fixés (le taux de frais en vigueur quand un prêteur l'accepte, moins votre niveau de remise sur les frais à ce moment-là ; le chiffre affiché utilise le taux d'aujourd'hui), ce que vous devriez, chaque condition du prêt, quand la demande expire, le ratio prêt-valeur et si une approbation est nécessaire. Vous cochez une case pour accepter les Informations sur les risques et les Conditions. Votre wallet approuve exactement la garantie si nécessaire, l'app essaie de nouveau la demande, puis seulement la publie. Si cela s'arrête après une approbation, l'app demande de la remettre et dit si c'est fait. Ensuite, l'app vérifie sur la chaîne la demande enregistrée et la garantie bloquée.

<a id="borrow-nft-collateral"></a>

### Borrow : un NFT en garantie

Une demande peut bloquer un NFT au lieu d'un jeton. Choisissez la collection comme ce que vous bloquez (les collections de test sont marquées comme NFT, ou collez une adresse) ; qu'une adresse soit un jeton ou une collection de NFT est lu dans son contrat. Saisissez ensuite le numéro du NFT, son identifiant de jeton, affiché dans votre portefeuille ou sur la page de la collection ; le formulaire indique aussitôt si votre portefeuille le détient. Le protocole évalue un NFT à zéro, quel que soit son prix ailleurs : un prêt garanti par un NFT n'a ni ratio prêt-valeur ni liquidation fondée sur un prix, et si vous ne remboursez pas avant la fin du délai de grâce, le prêteur reçoit le NFT lui-même. La publication demande à votre portefeuille d'autoriser le protocole pour ce seul NFT, jamais pour le reste de votre collection, et son transfert dans votre coffre efface cette autorisation de lui-même ; si la demande s'arrête après l'autorisation, l'application demande de la rétablir et dit si c'est fait. Les NFT qui existent en quantités (collections multi-jetons) fonctionnent de la même façon, avec une quantité : saisissez le numéro du jeton et combien en bloquer, et le formulaire indique combien votre portefeuille en détient. Une telle collection ne peut pas autoriser un seul jeton, seulement tous les vôtres qu'elle contient : la publication accorde donc cette autorisation pour cette demande seulement et la retire ensuite par une étape de plus dans le portefeuille, que la demande ait abouti ou non ; une autorisation que vous aviez déjà donnée reste telle que vous l'aviez réglée. Accepter l'offre d'un prêteur qui demande un NFT se fait encore dans l'application actuelle pour l'instant.

<a id="borrow-request-range"></a>

### Borrow: Une fourchette de montants (Avancé)

En mode Avancé, une demande peut accepter une fourchette : le plus petit et le plus grand montant qu'un prêteur peut prêter, à votre taux unique, et, si vous le souhaitez, une garantie plus faible pour le plus petit prêt. Un prêteur qui accepte la demande directement prête le plus petit montant et ne bloque que la garantie fixée pour lui ; le reste revient à votre portefeuille. Les appariements peuvent prêter davantage, jusqu'au plus grand montant, tant que l'appariement est activé sur le réseau ; la vérification indique s'il l'est, et que tant qu'il est désactivé la fourchette n'est remplie qu'une fois. Le protocole refuse un plus grand montant que votre garantie ne couvre pas aux prix du jour, et la vérification indique le maximum qu'elle couvre. La vérification affiche le ratio prêt-valeur aux deux extrémités et avertit lorsqu'un prêteur ne pourrait pas accepter la demande directement aux prix du jour. Les options définies en mode Avancé s'appliquent encore si vous passez en mode Basique : le formulaire le dit et vous permet de les effacer. Un appariement ne bloque que la garantie que demande son prêteur, au moins le plancher ; la revue indique donc le plus grand appariement de toute votre garantie jusqu'au seul plancher, et avertit qu'un prêt apparié peut démarrer plus risqué qu'un prêt direct. Tant que l'appariement est activé, la garantie qu'un appariement ne bloque pas reste avec la demande pour les appariements suivants et ne revient à votre portefeuille qu'à la clôture de la demande ou quand vous l'annulez.

<a id="borrow-request-fill"></a>

### Borrow: Comment une demande est remplie (Avancé)

Partiel, le mode par défaut, laisse les appariements remplir la demande en un ou plusieurs prêts jusqu'à ce qu'elle soit remplie, annulée ou expirée. Tout ou rien n'admet qu'un seul remplissage du montant entier et ne peut donc pas servir avec une fourchette. Immédiat ou annulé remplit comme partiel, mais seulement jusqu'à l'expiration de la demande, et exige donc une date d'expiration. Le mode de remplissage ne peut pas être modifié après la publication ; pour le changer, annulez la demande et publiez-en une nouvelle. Le protocole permet de modifier les montants, le taux et la garantie tant que la demande est ouverte, jamais en dessous de ce que les appariements ont déjà utilisé, mais cette application ne le propose pas encore : pour l'instant, un changement implique d'annuler et de republier.

<a id="borrow-request-cadence"></a>

### Borrow: Un échéancier d'intérêts (Avancé)

En mode Avancé, une demande peut payer les intérêts selon un échéancier plutôt que tout au remboursement : chaque mois, trimestre, semestre ou année. Le formulaire ne propose que les échéanciers que le protocole autorise pour vos conditions et indique sous chacun de ceux qui sont fermés pourquoi : les intérêts périodiques sont désactivés sur le réseau, un actif n'a pas de prix, le prêt vaut moins que le seuil du protocole (les deux chiffres sont affichés), ou la période n'est pas plus courte que le prêt. La revue montre les intérêts de chaque période et le délai de grâce d'une période manquée. Si une période n'est pas payée avant la fin de son délai de grâce, n'importe qui peut vendre une partie de votre garantie pour la payer, et le prêt reste ouvert. L'échéancier ne peut plus être modifié après publication. Comme les autres options avancées, il continue de s'appliquer si vous passez en mode Basique, et le formulaire le dit.

<a id="borrow-request-tariff"></a>

### Borrow: Le tarif de frais Full (Avancé)

En mode Avancé, une demande peut prendre le tarif de frais Full : des frais en VPFI, prélevés dans votre coffre à l'ouverture de chaque prêt, qui ajoutent dix points à la remise sur les frais de prêt, jusqu'au plafond de 50 % du protocole. Les frais de prêt restent facturés dans l'actif prêté, et le tarif n'est pas remboursé. Le formulaire ne le propose que tant que le protocole l'a activé, et affiche le tarif du jour pour votre montant et votre durée. Vous fixez le maximum de VPFI qu'un prêt peut prendre (laissé vide : le tarif du jour pour le plus grand prêt) et ce qui arrive à un prêt qui ne peut pas prendre le tarif à son ouverture : il est refusé, ou il s'ouvre sans lui. Un prêt ne peut le prendre que si, à ce moment, le tarif est activé, l'actif prêté a un prix et est liquide, son tarif reste dans votre maximum et votre coffre détient assez de VPFI libres. Le tarif est fixé par une seconde transaction après la publication ; un prêteur qui prend la demande avant sa confirmation ouvre donc un prêt sans lui. Cette application ne propose pas encore de prêt de secours pour les demandes que personne ne prend.

<a id="lend-start"></a>

### Lend: Comment ça marche

Pour prêter, vous financez la demande ouverte d'un emprunteur : un montant d'un jeton, le taux qu'il paiera, une durée et une garantie que l'emprunteur a déjà bloquée dans son propre coffre. La financer ouvre le prêt en une seule transaction. Le montant quitte votre portefeuille, l'emprunteur le reçoit moins ses frais d'ouverture, et la garantie reste bloquée pour vous jusqu'à la fin du prêt. Votre côté du prêt est un jeton de position dans votre portefeuille, et c'est son détenteur qui est remboursé. L'emprunteur rembourse le montant plus les intérêts avant l'échéance, et le protocole garde sa part des intérêts. Si aucune demande ne convient, vous pouvez publier votre propre offre de prêt depuis la même page.

<a id="lend-offers"></a>

### Lend: Choisir une demande

Choisissez d'abord ce que vous prêtez et la garantie que vous acceptez ; ce doivent être des jetons différents, et cette page ne propose que des jetons. La page liste les demandes d'emprunt ouvertes pour cette paire, lues dans le protocole lui-même. Chacune indique le montant, le taux et la durée, la garantie bloquée, le ratio prêt-valeur aux prix du jour, le mode de calcul des intérêts, un éventuel calendrier d'intérêts et la part des frais de l'emprunteur qui vous revient. Une demande se finance en entier : si elle indique une fourchette, vous prêtez le plus petit montant de l'emprunteur à son taux le plus élevé. Quand le protocole refuserait une demande, la page dit pourquoi et ne propose aucun bouton. Vos propres demandes, les demandes avec un NFT et les ventes de prêts en cours sont comptées, pas listées. L'ordre (d'abord les demandes que vous pouvez financer, puis le taux le plus élevé) est une commodité, pas un conseil.

<a id="lend-review"></a>

### Lend: Vérifier et signer

Avant l'ouverture de votre portefeuille, la vérification affiche chaque chiffre : ce qui quitte votre portefeuille, ce que reçoit l'emprunteur, les frais et votre part de ceux-ci, la garantie détenue pour vous, le taux, les intérêts dus à l'échéance, la part du protocole sur ceux-ci, ce qui vous revient, le délai de grâce et ce que vous pouvez perdre. Elle indique aussi chaque condition du cycle de vie, même quand c'est la valeur par défaut. Si votre portefeuille détient moins que le montant, la vérification dit combien il manque et ne propose aucune signature. Vous cochez une case pour accepter les Avertissements sur les risques et les Conditions ; si les chiffres changent avant votre confirmation, la case se décoche. Votre portefeuille vous demande ensuite de signer les conditions, ce qui ne coûte rien, d'approuver exactement le montant si nécessaire, et d'envoyer l'acceptation, que l'application essaie d'abord à blanc. Si cela s'arrête après une approbation, l'application propose de rétablir l'approbation et dit si c'est fait. Ensuite, l'application vérifie sur la chaîne le prêt ouvert, ce qui a quitté votre portefeuille et ce qui y est revenu.

<a id="lend-fee"></a>

### Lend: Les frais et la part du protocole

Les frais d'ouverture sont à la charge de l'emprunteur : une petite part du montant, prélevée une fois dans l'actif prêté et déduite de ce que reçoit l'emprunteur. Vous prêtez le montant entier, et l'emprunteur le doit en totalité avec les intérêts. Comme vous envoyez vous-même l'acceptation, une petite part de ces frais, celle que le protocole verse à qui soumet un appariement, revient à votre portefeuille ; la vérification l'affiche. Si l'emprunteur a choisi le tarif de frais Full et qu'il s'applique à l'ouverture du prêt, les frais sont plus bas, et cette part aussi. Quand des intérêts sont payés, le protocole garde sa part, au taux en vigueur à l'ouverture du prêt ; votre palier de remise sur les frais peut réduire cette part tant que votre réglage de remise est activé. La vérification affiche le taux du jour et le maximum que cette part peut prendre.

<a id="lend-risks"></a>

### Lend: Risques

Prêter peut vous faire perdre de l'argent. Si l'emprunteur n'a pas remboursé à la fin du délai de grâce, le prêt est en défaut et vous êtes payé sur la garantie : vendue pour vous là où le protocole le peut, remise telle quelle sinon, et une vente peut rapporter moins que ce qui vous est dû. Avec une garantie liquide, n'importe qui peut liquider le prêt dès que son facteur de santé passe sous 1 ; la vente vous rembourse en premier, mais une forte baisse peut laisser moins que ce qui vous est dû. Un jeton illiquide est valorisé à zéro, il n'y a donc pas de liquidation fondée sur le prix, et en cas de défaut vous recevez toute la garantie, quelle que soit sa valeur. Vous ne pouvez pas reprendre le montant avant la fin du prêt ; sortir plus tôt signifie vendre votre position à un autre prêteur. Avec des intérêts au prorata, un remboursement anticipé vous rapporte moins. Une pause repousse l'échéance, et les intérêts continuent de courir pendant celle-ci.

<a id="lend-offer"></a>

### Lend : Publier votre propre offre

Si aucune demande ne convient, vous pouvez publier votre propre offre de prêt pour vos deux jetons : le montant exact que vous prêtez, le taux que vous demandez, la durée et la garantie qu'un emprunteur doit bloquer. La publication déplace le montant de votre portefeuille vers votre propre coffre, où il reste bloqué tant que l'offre est ouverte. Un emprunteur qui l'accepte ouvre le prêt aussitôt, à vos conditions, sans vous redemander : il reçoit le montant moins ses frais d'ouverture, et sa garantie est bloquée dans son coffre pour vous. Tant que l'appariement est activé sur le réseau, n'importe qui peut aussi associer votre offre à la demande d'un emprunteur ; sans parts, ce prêt prête tout votre montant à votre taux, contre au moins la garantie que vous demandez. La vérification indique si l'appariement est activé en ce moment. Vous pouvez annuler à partir de cinq minutes après la publication, et le montant revient dans votre portefeuille. Une offre expirée ne peut plus être acceptée ; son montant reste dans votre coffre jusqu'à ce que vous, ou n'importe qui, la fermiez, puis revient uniquement dans votre portefeuille. Tant que la page Offres de la prochaine application n'est pas construite, vous suivez, annulez et fermez une offre sur la page Offres de l'application actuelle ; la vérification le dit avant que rien ne soit bloqué.

<a id="lend-offer-terms"></a>

### Lend : Les conditions de l'offre

Sauf si vous fixez des parts en mode avancé, un seul emprunteur prend tout le montant, ou personne, et doit bloquer exactement la garantie que vous fixez. Le formulaire indique combien du jeton prêté votre portefeuille détient. Chaque chiffre est lu exactement comme vous le saisissez : plus de décimales que le jeton n'en a sont refusées, jamais arrondies, et le taux va jusqu'à 100 % par an avec deux décimales. Les durées proposées s'arrêtent à la plus longue que le réseau autorise. L'offre reste ouverte jusqu'à son acceptation ou son annulation, ou pendant le nombre de jours que vous choisissez, jusqu'à un an. Les intérêts sur toute la durée, le choix habituel, signifient qu'un remboursement anticipé ne réduit pas ce que vous gagnez ; au prorata, vous n'êtes payé que pour le temps où le prêt est ouvert. Vous pouvez aussi permettre à l'emprunteur de rembourser une partie en avance. Le formulaire montre ce que l'emprunteur vous devrait à l'échéance s'il acceptait l'offre maintenant. En mode avancé, une offre peut aussi être prêtée en parts, porter un mode d'exécution, payer les intérêts selon un échéancier et prendre le tarif de frais Full.

<a id="lend-offer-parts"></a>

### Lend : Une offre en parts (Avancé)

En mode avancé, une offre de prêt peut être prêtée en parts. Le montant saisi reste le montant entier : la publication bloque tout, et un emprunteur qui prend votre offre directement emprunte tout. Vous ajoutez la plus petite part qu'un appariement peut prêter. Tant que l'appariement est activé sur le réseau, les apparieurs peuvent prêter votre offre à plusieurs emprunteurs, chaque prêt entre la plus petite part et ce qui reste, à votre taux. Chacun demande au moins la part de votre garantie qui correspond à sa part, arrondie vers le bas, et la vérification montre ce que demande la plus petite part. Dès qu'un appariement a prêté une part, aucun emprunteur ne peut prendre le reste directement ; seuls d'autres appariements le peuvent, et vous pouvez annuler l'offre pour reprendre le reste. Quand il reste moins que la plus petite part, le protocole le renvoie à votre portefeuille et ferme l'offre. La vérification indique si l'appariement est activé en ce moment ; tant qu'il est désactivé, seul un emprunteur qui prend tout ouvre un prêt. Le mode d'exécution fonctionne comme pour une demande : partiel par défaut, tout ou rien pour un seul prêt du montant entier (donc sans parts), ou immédiat ou annulé, qui exige une expiration ; il ne peut pas être modifié après la publication. Le protocole refuse une offre qui demande moins de garantie que le montant entier n'en exige aux prix du jour, et la vérification indique le minimum demandé. Les options fixées en mode avancé s'appliquent toujours si vous passez en mode Basic : le formulaire le dit et vous permet de les effacer.

<a id="lend-offer-schedule"></a>

### Lend : Un échéancier d'intérêts sur une offre (Avancé)

En mode Avancé, une offre de prêt peut porter un échéancier d'intérêts, comme une demande : chaque mois, trimestre, semestre ou année. Le formulaire ne propose que les échéanciers que le protocole autorise pour vos conditions, et indique sous chaque échéancier fermé pourquoi. Avec des parts, le protocole vérifie la plus petite part à la publication, donc une plus petite part sous son seuil ferme les échéanciers plus fins ; chaque prêt est vérifié à nouveau à son ouverture. La revue montre les intérêts de chaque période si un emprunteur prend tout et, avec des parts, sur un prêt de la plus petite part, ainsi que le délai de grâce d'une période manquée. Si une période n'est pas payée à la fin de son délai de grâce, n'importe qui peut vendre une partie de la garantie de l'emprunteur pour vous la payer, et le prêt reste ouvert. L'échéancier ne peut pas être modifié après la publication.

<a id="lend-offer-tariff"></a>

### Lend : Le tarif de frais Full sur une offre (Avancé)

En mode Avancé, une offre de prêt peut prendre le tarif de frais Full : des frais en VPFI, prélevés dans votre coffre à l'ouverture de chaque prêt issu de l'offre, calculés selon le montant et la durée de ce prêt. En échange, la part du protocole sur les intérêts de ce prêt reçoit dix points de remise de plus, jusqu'à son plafond de 50 % ; la part reste prélevée dans l'actif prêté. Les points supplémentaires valent pour la durée du prêt : si le prêt est prolongé pour une nouvelle durée, ils cessent pour celle-ci. Ils appartiennent à la position de prêteur, donc celui qui la détient au paiement des intérêts les reçoit. Le tarif n'est pas remboursé. Le formulaire affiche le tarif du jour pour le montant entier, le plus grand prêt que l'offre ouvre. Vous fixez le maximum de VPFI qu'un prêt peut prendre, et si un prêt qui ne peut pas prendre le tarif est refusé ou s'ouvre sans lui. Un prêt ne peut le prendre que si, à ce moment, le tarif est activé, l'actif prêté a un prix et est liquide, son tarif est dans votre maximum et votre coffre détient assez de VPFI libre. Le tarif est fixé par une seconde transaction après la publication, donc un prêt ouvert depuis l'offre avant sa confirmation, par un emprunteur ou par un appariement, s'ouvre sans lui.

<a id="lend-offer-review"></a>

### Lend : Vérifier et publier une offre

Avant l'ouverture de votre portefeuille, l'application demande au protocole d'essayer votre offre à blanc, si bien que la vérification montre la réponse du protocole lui-même. Elle indique ce que vous bloquez maintenant, le montant qu'un emprunteur prend, la garantie qu'il doit bloquer, le taux et la durée, ce que l'emprunteur recevrait au taux de frais d'aujourd'hui, les intérêts à l'échéance, la part du protocole et ce qui vous revient, chaque condition du cycle de vie, quand l'offre expire, le ratio prêt-valeur aux prix d'aujourd'hui et si une approbation est nécessaire. Si votre portefeuille détient moins que le montant, la vérification indique ce qui manque et ne propose aucune signature. Vous cochez une case pour accepter les Avertissements sur les risques et les Conditions. Votre portefeuille approuve exactement le montant si nécessaire, l'application essaie de nouveau l'offre, et seulement alors la publie. Si tout s'arrête après une approbation, l'application demande de remettre l'approbation en l'état et dit si c'est fait. Ensuite, l'application vérifie sur la chaîne l'offre enregistrée et le montant bloqué dans votre coffre.

<a id="lend-offer-fee"></a>

### Lend : Les frais de votre offre

Publier une offre ne vous coûte aucuns frais. Les frais d'ouverture sont ceux de l'emprunteur : une petite part du montant, prélevée une fois dans l'actif prêté quand un emprunteur accepte votre offre, au taux en vigueur à ce moment, et retirée de ce qu'il reçoit. Vous prêtez tout le montant, et l'emprunteur vous le doit en entier avec les intérêts. Quand les intérêts sont payés, le protocole garde sa part, au taux en vigueur à l'ouverture du prêt ; votre palier de réduction des frais peut baisser cette part tant que votre réglage de réduction est activé. La vérification montre le taux d'aujourd'hui et le maximum que cette part peut prendre ; si ce taux ne peut pas être lu, la vérification le dit au lieu d'afficher un chiffre.

<a id="positions"></a>

### Positions : vos positions de prêt

Positions liste chaque prêt que vous avez accordé ou contracté sur ce réseau, à partir des jetons de position détenus par votre wallet ; une position transférée à quelqu'un d'autre quitte donc votre liste. Les paiements prêts à être récupérés viennent d'abord et ouvrent Claims. Viennent ensuite les prêts en cours, l'échéance la plus urgente d'abord, comme sur Home. Les prêts terminés viennent en dernier, chacun avec sa fin : remboursé, en défaut, réglé ou clos par un appariement. Un prêt terminé dont le paiement attend encore vous renvoie vers Claims.

Tous, Prêtés et Empruntés filtrent les trois listes à la fois. Positions n'affirme que vous n'avez rien qu'après avoir tout lu ; si une liste n'a pas pu être lue en entier, il le dit. Chaque prêt ouvre sa propre page, qui montre les actions qui vous sont ouvertes. La liste elle-même ne signe jamais rien.

<a id="position"></a>

### Position : un prêt

Chaque prêt a sa propre page. Elle commence par le statut du prêt, puis votre rôle : le côté que votre wallet détient maintenant, car les jetons de position peuvent être vendus ou transférés. Si vous ne détenez aucun côté, vous consultez le prêt. Une échéance qui vous concerne est formulée pour votre côté. Une fois le délai de grâce écoulé, la page indique que n'importe qui peut lancer le défaut, et seulement quand le protocole le confirme.

Viennent ensuite les dates du prêt (l'échéance de la période en cours avant tout crédit de pause, le temps ajouté pendant une pause du protocole, l'échéance et la fin du délai de grâce), ses conditions telles qu'elles sont maintenant (un remboursement partiel réduit le capital encore dû), son facteur de santé et l'endroit où sa garantie est détenue. Un chiffre qui n'a pas pu être lu est affiché comme inconnu. Si la garantie n'a pas de prix, un défaut remet au prêteur la garantie elle-même, et la page le dit. Si le réseau réserve une bande juste au-dessus du seuil de liquidation à un appariement interne avec un autre prêt, la page l'indique : dans cette bande, aucune vente externe ne peut clore le prêt. Une location de NFT n'a pas de garantie : en cas de défaut, l'usage du locataire prend fin, le loyer prépayé va au prêteur moins la part du protocole et la réserve va à la trésorerie. Le remboursement intégral, le remboursement partiel, l'ajout et la reprise de garantie sont ses premières actions ; les autres arrivent dans de prochaines mises à jour.

<a id="repay"></a>

### Rembourser intégralement

Sur un prêt en cours, la page propose de le rembourser intégralement. Tout le monde peut rembourser, sauf le prêteur. Si vous ne détenez pas la position d'emprunteur, payer ne vous donne aucun droit sur la garantie : seul son détenteur peut la récupérer. Le remboursement est suspendu dès la fin du délai de grâce (le prêt passe alors en défaut) et tant qu'un ordre de swap-to-repay est en attente.

Ce que vous devez augmente à chaque seconde, et le protocole prend le montant au moment où votre remboursement est confirmé. L'examen montre deux chiffres : ce que cela coûte maintenant et ce que cela coûterait environ trente minutes plus tard. Votre portefeuille approuve exactement le second chiffre. Si vous aviez déjà approuvé davantage, même un montant illimité, l'approbation est ramenée à ce chiffre pour le remboursement, car le remboursement ne fixe lui-même aucun maximum. L'approbation limite le montant, pas le temps : un remboursement confirmé plus tard ne passe que tant que ce qui est dû y tient encore, sinon il est refusé et rien ne bouge. Sur un prêt qui facture la durée entière, le montant ne grandit pas avant l'échéance, donc un remboursement plus tardif peut encore passer. Ce que le remboursement n'utilise pas de l'approbation est remis en place ensuite. Puis l'emprunteur récupère la garantie et le prêteur récupère le principal et les intérêts dans Claims.

<a id="interest-schedule"></a>

### Échéancier des intérêts

Un prêt assorti d'un échéancier doit des intérêts à chaque période (un mois, un trimestre, six mois ou un an), pas seulement à la fin. Sa page montre la période en cours : quand elle se termine, quand son délai de grâce se termine, les intérêts qu'elle doit, ce qui a été payé et ce qui reste dû. Les intérêts d'une période sont calculés sur le capital et le taux tels qu'ils sont maintenant, donc un remboursement partiel les réduit.

Une fois une période et son délai de grâce écoulés, n'importe qui peut la régler. Une période payée fait seulement avancer l'échéance ; pour une période encore incomplète, juste assez de garantie de l'emprunteur est vendue pour couvrir ce qui est dû et les frais de la vente. La page indique si le règlement est ouvert maintenant. Elle nomme l'interrupteur de règlement périodique du réseau lorsqu'il est coupé (rien ne peut alors être réglé et aucune garantie n'est vendue) et la pause du protocole tant qu'elle dure (le règlement s'arrête et le temps de pause s'ajoute aux dates de la période). Une pause repousse les dates de la période de la durée de pause, mais les intérêts qu'une période doit restent ceux d'une période ; les intérêts continuent de courir pendant la pause, et tout intérêt payé par un remboursement compte pour la période.

<a id="partial-repay"></a>

### Rembourser une partie d'un prêt

Le détenteur de la position emprunteur peut rembourser une partie du principal d'un prêt en cours depuis sa page, lorsque les conditions du prêt le permettent. Saisissez la part du principal : le protocole accepte au moins sa part minimale pour le jeton prêté, et moins que la totalité du principal (tout rembourser, c'est « Rembourser en totalité »). Les intérêts courus depuis le dernier paiement d'intérêts du prêt s'y ajoutent. Le prêt continue avec le principal réduit, et sa date d'échéance ne bouge pas.

La vérification montre la part, les intérêts, le principal restant et ce que couvre l'autorisation. Sur un prêt au prorata avant son échéance, les intérêts sont exacts. Sur un prêt à intérêts sur toute la durée, ou après l'échéance, on lit « au plus » : le chiffre du protocole que lit l'application compte aussi le reste de la durée ou des pénalités de retard, qu'un paiement partiel ne facture pas. Le paiement partiel est suspendu tant qu'une demande de refinancement du prêt ou une offre de compensation sur la position emprunteur est active, et dès la fin du délai de grâce.

<a id="add-collateral"></a>

### Ajouter de la garantie

Le détenteur de la position emprunteur peut ajouter de la garantie à un prêt en cours depuis sa page. Cela relève le facteur de santé du prêt et abaisse son ratio prêt-valeur, ce qui l'éloigne de la liquidation. Vous ajoutez davantage du même jeton que le prêt détient déjà : le protocole n'en accepte pas d'autre, et n'accepte un complément que pour une garantie qu'il évalue actuellement. Saisissez le montant ; le formulaire indique ce que détient votre portefeuille.

L'examen montre la garantie avant et après, où elle est conservée (dans votre coffre, liée au prêt jusqu'à sa fin), ainsi que le facteur de santé et le ratio prêt-valeur du prêt maintenant. Votre portefeuille approuve exactement le montant si votre approbation ne le couvre pas déjà, et l'application essaie d'abord le complément en simulation. Ensuite, l'application affiche le facteur de santé et le ratio prêt-valeur calculés par le protocole après le complément. L'ajout reste possible même quand le protocole est en pause. Un prêt en fallback repart s'il retrouve, grâce au complément, les limites d'ouverture du protocole ; sinon la garantie est ajoutée et le prêt reste en fallback. La garantie ajoutée peut être perdue avec le reste si le prêt est liquidé ou fait défaut. Si vous avez repris la position emprunteur et que le prêt est en fallback, le complément va dans le coffre de l'emprunteur que le prêt enregistre, et ne passe dans le vôtre que s'il remet le prêt en cours.

<a id="take-back-collateral"></a>

### Reprendre de la garantie

Tant qu'un prêt court, le détenteur de la position d'emprunteur peut reprendre, depuis la page du prêt, la garantie au-delà de ce dont le prêt a besoin. Le protocole calcule le maximum pour que le facteur de santé reste au minimum du prêt ou au-dessus et que le ratio prêt/valeur reste sous son plafond d'ouverture. Cette limite évolue avec les prix et à mesure que les intérêts courent, et le formulaire l'affiche pendant la saisie. Reprendre de la garantie rapproche le prêt de la liquidation.

La revue montre la garantie maintenant et après, qu'elle passe de votre coffre à votre portefeuille, la limite actuelle, ainsi que le facteur de santé et le ratio prêt/valeur actuels. Aucune approbation n'est nécessaire : votre portefeuille demande une seule confirmation, après que l'app a testé le retrait en simulation. Le protocole revérifie ses limites à la confirmation : si les prix ont bougé et que le montant ne passe plus, le retrait est refusé et rien ne bouge. Une pause du protocole, un ordre swap-to-repay en attente, une demande de refinancement en cours ou une mise en vente par le prêteur le bloque, et le protocole ne laisse reprendre de garantie que pour un jeton qu'il valorise. Si le mode protégé est activé sur votre compte, la garantie attend dans sa file de paiements pendant le délai du compte avant d'arriver dans votre portefeuille, et la revue le dit.

<a id="collect-a-payout"></a>

### Encaisser un versement

Quand un prêt prend fin, le protocole enregistre ce qui revient à chaque partie, et le détenteur de chaque position l'encaisse depuis la page du prêt ou depuis Réclamations. Il paie celui qui détient la position aujourd'hui : une position que vous avez achetée vous paie. Le versement du prêteur est le principal et les intérêts, ou ce qu'un défaut ou une liquidation a récupéré, plus les fonds retenus pour le prêteur et, pour une location, le NFT loué. Le versement de l'emprunteur est la garantie rendue ou ce qui reste, plus un excédent retenu pour l'emprunteur. L'encaissement brûle votre jeton de position, et une fois que les deux parties ont encaissé, le prêt est soldé.

L'examen liste chaque paiement que fait la réclamation, ce que les anciens vendeurs d'une position de prêteur prennent d'abord (des intérêts gagnés et non payés) et où arrive le paiement : votre portefeuille ou, avec le mode protégé actif, la file de versements de votre compte ou votre coffre. Aucune approbation n'est nécessaire, votre portefeuille demande donc une fois, après que l'application a simulé la réclamation. Une pause du protocole arrête toute réclamation. Tant qu'un prêt est en repli, le versement de l'emprunteur attend que le prêteur encaisse, et cet encaissement met fin au repli : l'emprunteur ne peut plus le régulariser. La carte de fin montre ce que la transaction a réellement payé.

<a id="payout-queue"></a>

### Versements en attente dans votre file

Avec le mode protégé actif, tout ce qui quitte votre coffre vers votre portefeuille attend le délai de votre compte dans une file de versements. Réclamations liste ce qui y attend, le plus proche d'abord, chacun avec un court code de demande : chaque alerte sur un versement affiche le même code, ce qui vous permet de relier un message à une demande. Chaque ligne indique ce qu'elle paie, où elle va et quand elle peut être libérée. Une fois un versement dû, n'importe qui peut le libérer, et il ne paie que la destination qu'il a enregistrée ; si cette destination n'est plus autorisée, le libérer l'annule. Vous, ou l'un de vos signataires secondaires, pouvez annuler un versement à tout moment, même pendant une pause, et l'actif reste dans votre coffre. Si votre compte exige une approbation, un signataire secondaire approuve d'abord chaque versement ; un signataire trouve votre compte en mode avancé en collant son adresse. Une pause retient les libérations jusqu'à sa fin ou, après une longue pause, jusqu'à l'ouverture de sa voie de sortie. Chaque action sollicite votre portefeuille une fois, et la carte de fin montre ce que la transaction a fait.

<a id="seller-interest"></a>

### Les intérêts d'une position que vous avez vendue

Quand vous vendez une position de prêteur, les intérêts gagnés pendant que vous la déteniez et pas encore payés restent à vous, sous forme de créance sur le prêt. Claims liste chaque prêt sur lequel vous détenez une telle créance, avec ce qui vous est dû après la part d'intérêts du protocole et ce qui attend déjà dans votre coffre. Tant que le prêt court, chaque paiement d'intérêts règle d'abord les créances ouvertes, la plus ancienne d'abord, dans le coffre de chaque vendeur ; tant que rien n'atteint le vôtre, il n'y a rien à retirer. Une fois le prêt terminé, le retrait répartit d'abord ce que le côté prêteur a récupéré : le principal du détenteur d'abord, puis chaque créance de vendeur, la plus ancienne d'abord. Toutes les créances ouvertes se ferment alors, et ce qu'une créance ne reçoit pas reste impayé. Les prêts viennent de l'index de l'app ; s'il ne peut pas les lister, cherchez un prêt par son numéro, lu sur la chaîne seule. Aucune approbation n'est nécessaire : votre portefeuille demande une fois, après une simulation, et la carte finale montre ce que la transaction a payé.

<a id="risk-access"></a>

### Risk Access : votre niveau de risque

Chaque compte commence au niveau de risque le plus bas, actifs blue-chip uniquement, et vous seul pouvez le relever. Une paire exige le niveau de son jeton le plus risqué : les jetons blue-chip n'exigent rien, les autres jetons liquides exigent « Actifs liquides », et un jeton illiquide exige « Tout actif, y compris illiquide » ainsi que votre accord pour cette paire précise. Quand accepter une offre ou publier une demande exige une telle étape, la vérification l'indique sur place et la propose en une seule confirmation de portefeuille avec son propre reçu : ce qui change, quelles paires elle couvre, quand elle prend effet et qu'aucun fonds ne bouge. Relever votre niveau, ou donner votre accord pour une paire, peut attendre un délai fixé par le protocole ; pour un niveau relevé, l'application affiche l'heure de prise d'effet, lue sur la chaîne ; pour un accord, elle indique que le protocole ne publie pas encore cette heure ; et elle ne propose jamais deux fois la même étape, car une seconde relancerait l'attente. Abaisser votre niveau prend toujours effet immédiatement. Quand le protocole publie de nouvelles conditions de risque, votre niveau et vos accords cessent de compter jusqu'à ce que vous les confirmiez à nouveau. Si vous avez activé le mode strict, chaque paire liquide exige aussi votre reconnaissance. Un blocage dû au niveau de risque du prêteur est présenté comme le sien : rien dans votre compte ne le changerait.

<a id="terms-gate"></a>

### La demande d'acceptation des Conditions

Lorsqu'une version des Conditions d'utilisation est en vigueur, l'app vous demande de l'accepter avant une action qui crée quelque chose de nouveau, comme activer la remise sur les frais, et nomme l'action qui l'a demandé. Elle affiche la version, une empreinte de son texte et un lien vers cette version précise, dont le texte ne change jamais. Accepter tient en une confirmation dans le wallet et ne déplace aucun fonds. Si l'app ne peut pas lire si vous avez accepté, elle le dit et vous laisse réessayer au lieu d'y voir un refus. Rembourser, réclamer, retirer vos propres actifs, annuler vos propres offres et désactiver un consentement ne sont jamais bloqués.
