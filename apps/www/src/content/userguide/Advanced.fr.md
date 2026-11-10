# Vaipakam — Guide utilisateur (Mode Avancé)

Explications précises et techniquement rigoureuses de chaque carte de
l'application. Chaque section correspond à une icône d'information
`(i)` à côté du titre d'une carte.

> **Tu lis la version Avancée.** Elle correspond au mode
> **Avancé** de l'app (contrôles plus denses, diagnostics et
> détails de configuration du protocole). Pour une explication
> plus accessible et simple, bascule l'app en mode **Basique** —
> ouvre les Paramètres (icône d'engrenage en haut à droite) →
> **Mode** → **Basique**. Les liens « En savoir plus » (i) dans
> l'app ouvriront alors le guide Basique.

---

<a id="chapter.dashboard"></a>

## Tableau de bord

<a id="dashboard.your-vault"></a>

### Ton Vault

Un contrat upgradable par utilisateur — ton coffre privé sur cette
chaîne — créé pour toi la première fois que tu participes à un
prêt. Un vault par adresse par chaîne. Détient les soldes ERC-20,
ERC-721 et ERC-1155 liés à tes positions de prêt. Aucune mise en
commun : les actifs des autres utilisateurs ne sont jamais dans ce
contrat.

L'vault est the seul endroit où résident le collatéral, les actifs
prêtés et ton VPFI verrouillé. Le protocole s'authentifie auprès
de lui à chaque dépôt et retrait. L'implémentation peut être mise
à jour par le propriétaire du protocole, mais uniquement à travers
un timelock — jamais instantanément.

<a id="dashboard.your-loans"></a>

### Tes prêts

Chaque prêt impliquant le wallet connecté sur cette chaîne — que
tu sois côté prêteur, côté emprunteur, ou les deux sur des
positions distinctes. Les données sont calculées en direct à partir
des méthodes de vue du protocole pour ton adresse. Chaque ligne
renvoie vers la page de position complète avec HF, LTV, intérêts
accumulés, les actions autorisées par ton rôle et le statut du prêt,
ainsi que l'identifiant de prêt on-chain que tu peux coller dans un
explorateur de blocs.

<a id="dashboard.vpfi-panel"></a>

### VPFI sur cette chaîne

Comptabilité VPFI en direct pour le wallet connecté sur la chaîne
active :

- Solde du wallet.
- Solde de l'vault.
- Ta part de l'offre circulante (après soustraction des soldes
  détenus par le protocole).
- Plafond de minting restant.

Vaipakam transporte VPFI entre chaînes via Chainlink CCIP. **Base est
la chaîne canonique** — l'adaptateur canonique y applique la sémantique
verrouillage à l'envoi / libération à la réception. Toute autre
chaîne supportée exécute un mirror qui mint à l'arrivée d'un paquet
de bridge entrant et brûle en sortie. Par construction, l'offre
totale sur toutes les chaînes reste invariante pendant le bridging.

La politique de vérification des messages cross-chain durcie
après l'incident du secteur d'avril 2026 est de **3 vérificateurs
requis + 2 optionnels, seuil 1 sur 2**. La configuration par
défaut à un seul vérificateur est rejetée à la porte de
déploiement.

<a id="dashboard.fee-discount-consent"></a>

### Consentement à la remise sur frais

Un drapeau d'opt-in au niveau wallet qui transforme tes VPFI en remise
sur les frais. **En tant qu'emprunteur**, la remise est une réduction
directe du Loan Initiation Fee, prélevé dans l'actif prêté à
l'acceptation ; rien n'est débité de ton vault pour cela. **En tant que
prêteur**, la remise de rendement s'applique au règlement et, si une
référence de prix VPFI est configurée, elle peut être réglée en VPFI
depuis ton vault, te laissant la totalité des frais dans l'actif prêté. Par défaut : désactivé.
Désactivé signifie que tu paies 100% de chaque frais dans l'actif
principal ; activé signifie que la remise pondérée dans le temps
s'applique.

Échelle de tiers :

| Tier | VPFI minimum en vault                 | Remise                            |
| ---- | -------------------------------------- | --------------------------------- |
| 1    | ≥ `{liveValue:tier1Min}`               | `{liveValue:tier1DiscountBps}`%   |
| 2    | ≥ `{liveValue:tier2Min}`               | `{liveValue:tier2DiscountBps}`%   |
| 3    | ≥ `{liveValue:tier3Min}`               | `{liveValue:tier3DiscountBps}`%   |
| 4    | > `{liveValue:tier4Min}`               | `{liveValue:tier4DiscountBps}`%   |

Le tier est calculé contre ton solde d'vault **après changement** au
moment où tu déposes ou retires du VPFI. Le taux réellement prélevé est
résolu au règlement à partir de ton tier à cet instant : aucune moyenne
distincte n'est prise sur la durée de vie de chaque prêt. C'est le tier
lui-même qui protège : une moyenne pondérée dans le temps de ton solde
quotidien sur une fenêtre récente d'au plus 30 jours — un réglage du
protocole, comptée depuis le jour où ta détention actuelle a commencé,
les jours les plus récents comptant davantage. Cette moyenne est
ensuite ramenée au palier le plus bas que tu as atteint depuis le début
de cette détention, en remontant jusqu'à 30 jours.

**Ce sont deux reculs distincts, et le second est généralement le plus
long.** La fenêtre de moyenne est configurable et peut être réglée
en dessous de 30 jours ; le recul du palier le plus bas n'y est pas
lié — il couvre toute ta détention actuelle, plafonnée à 30 jours. Avec
une fenêtre de 14 jours, une baisse d'il y a 20 jours abaisse donc
encore ton palier alors qu'elle tombe entièrement hors de la moyenne.

Ton tier est nul tant que tu n'as pas détenu un solde non nul **sans
interruption** pendant un nombre minimum de jours, également un réglage
du protocole. Ce compteur démarre quand ton solde passe de zéro à
positif et ne repart que s'il revient à zéro : ajouter à une détention
existante ne le réinitialise pas.

Un retrait mord donc immédiatement sur chaque prêt ouvert te concernant
— il n'y a pas de fenêtre de grâce où ton ancien tier (plus haut)
s'applique encore. Cela ferme le schéma d'abus où un utilisateur
pourrait recharger du VPFI juste avant la fin d'un prêt, capturer la
remise du tier complet, et retirer quelques secondes plus tard. Note
quelle règle le ferme : qui détient depuis longtemps a déjà satisfait
la durée minimale, le travail est donc fait par la règle du palier le
plus bas — ce qu'une moyenne ne pourrait pas faire, car une moyenne
peut être tirée vers le haut par un rechargement tardif, un minimum
non.

Face à ce schéma précis, la règle actuelle est la plus forte des deux.
Elle n'est **pas** plus stricte à tous égards : comme le recul du
palier le plus bas ne remonte qu'à 30 jours au maximum, les premiers
mois à palier bas d'un prêt long finissent par ne plus compter, alors
qu'une moyenne sur toute la vie du prêt les aurait conservés. Le
changement a renforcé la défense contre le rechargement bref et
raccourci la mémoire.

**Cela vaut pour le yield-fee du prêteur.** Le taux de l'emprunteur sur les
frais d'initiation est lu une seule fois, à l'acceptation du prêt ; ensuite, ni
un retrait ni un rechargement ne le modifient.

La remise s'applique au yield-fee du prêteur au moment du
règlement et au Loan Initiation Fee de l'emprunteur, où elle est
une **réduction directe des frais que tu paies dans l'actif
prêté**, appliquée à l'acceptation du prêt. Aucun VPFI n'est
prélevé de ton vault pour payer ces frais, et il n'y a aucun
rabais à réclamer ensuite.

> **Si tu attends un rabais sur le Loan Initiation Fee, lis
> ceci.** Un modèle antérieur prélevait la totalité des frais en
> VPFI d'avance, les conservait pendant toute la durée du prêt et
> en restituait une partie lors de la réclamation. **Cette voie a
> été supprimée.** Aucun prêt n'a jamais été ouvert par elle : aucun
> prêt n'a donc de VPFI retenu contre ses frais d'initiation ni de
> rabais en attente — l'attendre reviendrait à attendre un argent
> qui ne peut pas arriver.

> **Le gas du réseau est séparé.** La remise ci-dessus s'applique
> aux **frais de protocole** de Vaipakam (yield-fee
> `{liveValue:treasuryFeeBps}` %, Loan Initiation Fee
> `{liveValue:loanInitiationFeeBps}` %). Les **frais de gas du
> réseau blockchain** que requiert chaque action on-chain — payés
> aux validateurs sur Base / Sepolia / Arbitrum / etc. lors de la
> création d'une offre, l'acceptation, le remboursement, la
> réclamation, le retrait, etc. — ne sont pas un frais de protocole.
> Vaipakam ne les reçoit jamais ; le réseau, oui. Ils ne peuvent
> pas être catégorisés en tiers ni remboursés, et ils varient avec
> la congestion de la chaîne au moment de la soumission, pas avec
> la taille du prêt ni avec ton tier VPFI.

<a id="dashboard.rewards-summary"></a>

### Tes récompenses VPFI

Carte de résumé ambitieuse qui affiche, dans une seule vue, l'image
des récompenses VPFI du wallet connecté. Le chiffre principal est la
somme des récompenses d'interaction en attente et des récompenses
d'interaction déjà réclamées sur toute la durée de vie du wallet.

La ligne de ventilation affiche en attente + réclamé, avec un lien
profond en chevron vers la carte de réclamation complète sur sa page
native :

- **Récompenses d'interaction avec la plateforme** — VPFI en attente
  accumulé sur tous les prêts auxquels tu as participé (côté prêteur
  ou emprunteur), plus toutes les récompenses d'interaction que tu
  as déjà réclamées. Lien vers la carte de réclamation d'interaction
  dans le Centre de réclamations.

Les montants déjà réclamés sont reconstruits depuis l'historique
on-chain des réclamations de chaque wallet. Il n'existe pas de total
cumulé on-chain à interroger ; le chiffre est donc calculé en
parcourant les événements de réclamation précédents du wallet sur
cette chaîne. Un cache de navigateur neuf affiche zéro (ou un total
partiel) jusqu'à la fin du parcours historique ; le nombre passe
ensuite à sa valeur correcte. Le modèle de confiance est le même que
celui des cartes de réclamation sous-jacentes.

La carte s'affiche toujours pour les wallets connectés, même quand
toutes les valeurs sont à zéro. L'indice d'état vide est
intentionnel — masquer la carte à zéro rendrait le programme de
récompenses invisible pour les nouveaux utilisateurs jusqu'à ce
qu'ils ouvrent le Centre de réclamations.

---

<a id="chapter.offer-book"></a>

## Carnet d'offres

<a id="offer-book.filters"></a>

### Filtres

Filtres côté client sur les listes d'offres de prêteur /
d'emprunteur. Filtre par actif, côté, statut, et quelques autres
axes. Les filtres n'affectent pas « Tes offres actives » — cette
liste est toujours affichée intégralement.

<a id="offer-book.your-active-offers"></a>

### Vos offres actives

Offres ouvertes (statut Active, expiration non encore atteinte) que
vous avez créées. Annulables à tout moment avant l'acceptation —
l'appel d'annulation est gratuit. L'acceptation fait passer l'offre
à Accepted et déclenche l'initialisation du prêt, qui mint les
deux NFTs de position (un pour le prêteur, un pour l'emprunteur)
et ouvre le prêt en état Active.

Les offres fermées portent l'un de plusieurs statuts distincts.
Certains sont déjà exposés comme chips de filtre sur la page Mes
Offres ; d'autres sont des terminaux côté indexeur qui recevront
un traitement UI dédié dans des suivis :

- **Filled** — acceptée par une contrepartie ; la référence de
  prêt de l'offre est l'ID du prêt résultant.
- **Cancelled** — l'offre a atteint l'état Cancelled par l'un des
  deux chemins : retirée par le créateur avant l'acceptation, OU
  nettoyée sans permission via `OfferCancelFacet.cancelOffer` une
  fois que `LibVaipakam.isOfferExpired(offer)` est vrai (le
  remboursement est toujours routé vers le créateur quel que soit
  l'initiateur de l'appel d'annulation).
- **Sold** — l'offre a été inscrite au flux borrow-OR-sell de
  vente parallèle (voir Créer Offre → Autoriser la vente
  optionnelle) et un acheteur de place de marché a rempli le listing
  du NFT collatéral avant qu'aucun prêteur n'accepte. L'offre
  porte le statut on-chain `consumed_by_sale` ; la colonne taux
  de la ligne affiche le taux auquel l'offre a été postée et la
  cellule collatéral rend la forme NFT (token id pour ERC-721,
  nombre de copies pour ERC-1155). La application expose également la
  ligne dans le feed Activity comme `Offer sold via OpenSea` pour
  l'emprunteur (créateur de l'offre). L'événement on-chain lui-
  même est
  `OfferConsumedBySale(uint96 indexed offerId, address indexed executor)` —
  à la fois l'offer id ET l'adresse de l'executor sont indexés
  on-chain, mais l'adresse emprunteur / créateur NON. La
  correspondance portefeuille de l'emprunteur pour le feed Activity est
  ajoutée par l'indexeur au moment de l'ingestion (il joint la
  ligne d'offre pour récupérer le créateur), donc le filtre par-
  portefeuille trouve l'emprunteur sans que l'événement lui-même les
  indexe.
- **Fully Filled (état indexeur, pas encore de chip)** —
  ordres à fourchette uniquement. Quand le matching partial-fill
  consomme le budget restant de l'offre (le dernier match remplit
  complètement la plage, ou un match partiel laisse un reste
  sub-dust), `OfferMatchFacet` émet
  `OfferClosed(FullyFilled | Dust)` et l'indexeur marque la ligne
  d'offre avec `status = 'fullyFilled'`. L'état `accepted` du
  contrat et le label Filled on-chain ci-dessus sont réservés au
  terminal d'acceptation directe, donc `fullyFilled` est distinct
  côté indexeur. Le `MyOfferStatus` de la application n'expose pas encore
  ce terminal comme son propre chip de filtre — `useMyOffers`
  ignore actuellement les lignes avec le statut indexeur
  `fullyFilled` — donc une offre de range entièrement remplie
  tombe effectivement hors de la vue Mes Offres jusqu'à ce que
  le chip dédié atterrisse. La affiche du chip est en file
  d'attente comme suivi UI séparé.

Les offres past-GTT (date limite GTT) qui n'ont jamais atteint un
événement terminal ne sont pas encore exposées comme chip de
statut distinct dans la application ; elles tombent actuellement sous
Active jusqu'à ce que l'indexeur enregistre un terminal. Un chip
Expired dédié est en file d'attente comme suivi UI séparé.


<a id="offer-book.lender-offers"></a>

### Offres de prêteurs

Offres actives où le créateur est prêt à prêter. L'acceptation est
réalisée par un emprunteur. Verrou strict à l'initialisation : le
panier de collatéral de l'emprunteur doit produire un Health
Factor d'au moins 1,5 face au principal demandé par le prêteur.
La mathématique HF est celle du protocole — le verrou n'est pas
contournable. La coupe de trésorerie de `{liveValue:treasuryFeeBps}`% sur les intérêts est
prélevée au règlement terminal, pas en amont.
Ce taux est figé à la création du prêt : une modification ultérieure des
frais du protocole laisse un prêt déjà ouvert au taux avec lequel il a
commencé.

<a id="offer-book.borrower-offers"></a>

### Offres d'emprunteurs

Offres actives d'emprunteurs ayant déjà verrouillé leur collatéral
en vault. L'acceptation est réalisée par un prêteur ; cela
finance le prêt avec l'actif principal et mint les NFT de
position. Même verrou HF ≥ 1,5 à l'initialisation. L'APR fixe
est défini sur l'offre à la création et immuable durant toute la
vie du prêt — le refinancement crée un nouveau prêt plutôt que de
modifier celui existant.

---

<a id="chapter.create-offer"></a>

## Créer une offre

<a id="create-offer.offer-type"></a>

### Type d'offre

Sélectionne le côté de l'offre où se trouve le créateur :

- **Prêteur** — le prêteur fournit l'actif principal et une
  spécification de collatéral à laquelle l'emprunteur doit
  satisfaire.
- **Emprunteur** — l'emprunteur verrouille le collatéral à
  l'avance ; un prêteur accepte et finance.
- Sous-type **Location** — pour les NFT ERC-4907 (ERC-721
  louable) et les ERC-1155 louables. Passe par le flux de
  location plutôt que par un prêt avec dette ; le locataire
  pré-paie le coût total de la location (durée × frais
  journalier) plus une marge de 5%.

<a id="create-offer.lending-asset"></a>

### Actif prêté

Pour une offre de dette tu spécifies l'actif, le montant
principal, l'APR fixe et la durée en jours :

- **Activo** — l'ERC-20 prêté / emprunté.
- **Montant** — principal, libellé dans les décimales natives de
  l'actif.
- **APR** — taux annuel fixe en basis points (centièmes de
  pourcent), figé à l'acceptation et inchangé ensuite.
- **Durée en jours** — fixe la fenêtre de grâce avant qu'un
  défaut puisse être déclenché.

L'intérêt accumulé est calculé en continu, à la seconde, à partir
du début du prêt jusqu'au règlement terminal.

<a id="create-offer.lending-asset:lender"></a>

#### Si tu es le prêteur

L'actif principal et le montant que tu es prêt à offrir, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé
au moment de l'offre ; la durée définit la fenêtre de grâce avant
que le prêt puisse passer en défaut. À l'acceptation, le principal
passe de ton vault à l'vault de l'emprunteur dans le cadre de
l'initialisation du prêt.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé
au moment de l'offre ; la durée définit la fenêtre de grâce avant
que le prêt puisse passer en défaut. Ton collatéral est verrouillé
dans ton vault au moment de la création de l'offre et reste
verrouillé jusqu'à ce qu'un prêteur accepte et que le prêt
s'ouvre (ou jusqu'à ce que tu annules).

<a id="create-offer.nft-details"></a>

### Détails du NFT

Champs du sous-type de location. Spécifie le contrat NFT et
l'identifiant du token (et la quantité pour ERC-1155), plus le
frais journalier de location dans l'actif principal. À
l'acceptation, le protocole prélève la location pré-payée depuis
l'vault du locataire vers la garde — soit durée × frais
journalier, plus une marge de 5%. Le NFT lui-même passe en état
délégué (via les droits d'utilisation ERC-4907, ou le hook
équivalent de location ERC-1155), de sorte que le locataire a
les droits mais ne peut pas transférer le NFT.

<a id="create-offer.collateral"></a>

### Collatéral

Spécification de l'actif de collatéral sur l'offre. Deux classes
de liquidité :

- **Liquide** — possède un flux de prix Chainlink enregistré ET
  au moins un pool Uniswap V3 / PancakeSwap V3 / SushiSwap V3
  avec ≥ 1 M$ de profondeur au tick courant. Les calculs LTV et
  HF s'appliquent ; une liquidation basée sur HF enruta le
  collatéral via un failover sur 4 DEX (0x → 1inch → Uniswap V3
  → Balancer V2).
- **Illiquide** — tout ce qui échoue à ce qui précède. Valorisé à
  $0 on-chain. Pas de calcul HF. En défaut, le collatéral
  intégral est transféré au prêteur. Les deux parties doivent
  reconnaître explicitement le risque de collatéral illiquide à
  la création / acceptation de l'offre pour que celle-ci soit
  enregistrée.

L'oracle de prix possède un quorum secondaire de trois sources
indépendantes (Tellor, API3, DIA) utilisant une règle de décision
souple 2-sur-N par-dessus le flux primaire Chainlink. Pyth a été
évalué et non adopté.

<a id="create-offer.collateral:lender"></a>

#### Si tu es le prêteur

Combien tu veux que l'emprunteur verrouille pour sécuriser le
prêt. Les ERC-20 liquides (flux Chainlink plus ≥ 1 M$ de
profondeur de pool v3) relèvent du calcul LTV / HF ; les ERC-20
illiquides et les NFT n'ont pas de valorisation on-chain et
nécessitent que les deux parties consentent à un scénario de
transfert intégral du collatéral en défaut. Le verrou HF ≥ 1,5
à l'initialisation du prêt est calculé contre le panier de
collatéral que l'emprunteur présente à l'acceptation —
dimensionner l'exigence ici fixe directement la marge HF de
l'emprunteur.

<a id="create-offer.collateral:borrower"></a>

#### Si tu es l'emprunteur

Combien tu es prêt à verrouiller pour sécuriser le prêt. Les
ERC-20 liquides (flux Chainlink plus ≥ 1 M$ de profondeur de pool
v3) relèvent du calcul LTV / HF ; les ERC-20 illiquides et les
NFT n'ont pas de valorisation on-chain et nécessitent que les
deux parties consentent à un scénario de transfert intégral du
collatéral en défaut. Ton collatéral est verrouillé dans ton
vault au moment de la création de l'offre sur une offre
d'emprunteur ; pour une offre de prêteur, ton collatéral est
verrouillé au moment de l'acceptation. Dans tous les cas, le
verrou HF ≥ 1,5 à l'initialisation du prêt doit être franchi
avec le panier que tu présentes.

<a id="create-offer.risk-disclosures"></a>

### Avertissements de risque

Porte de consentement avant la soumission. La même surface de
risque s'applique aux deux côtés ; les onglets spécifiques au rôle
ci-dessous expliquent comment chaque risque se manifeste selon le
côté de l'offre que tu signes. Vaipakam est non-custodial : il
n'existe pas de clé admin pouvant annuler une transaction passée.
Des leviers de pause existent uniquement sur les contrats exposés
au cross-chain, sont protégés par un timelock et ne peuvent pas
déplacer d'actifs.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si tu es le prêteur

- **Risque smart contract** — code immuable au runtime ; audité
  mais non vérifié formellement.
- **Risque oracle** — l'obsolescence Chainlink ou la divergence
  de profondeur de pool peut retarder une liquidation basée sur
  HF au-delà du point où le collatéral couvre le principal. Le
  quorum secondaire (Tellor + API3 + DIA, souple 2-sur-N) capte
  les dérives importantes, mais un petit biais peut encore éroder
  la récupération.
- **Slippage de liquidation** — le failover 4-DEX route vers la
  meilleure exécution qu'il puisse trouver, mais ne peut garantir
  un prix spécifique. La récupération est nette de slippage et
  de la coupe de trésorerie de `{liveValue:treasuryFeeBps}`% sur les intérêts.
- **Défauts sur collatéral illiquide** — le collatéral te revient
  intégralement au moment du défaut. Aucun recours si l'actif
  vaut moins que le principal plus les intérêts accumulés.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si tu es l'emprunteur

- **Risque smart contract** — code immuable au runtime ; les
  bugs affecteraient le collatéral verrouillé.
- **Risque oracle** — des données obsolètes ou une manipulation peuvent
  déclencher une liquidation basée sur HF contre toi alors que
  le prix de marché réel serait resté sûr. La formule HF est
  réactive à la sortie de l'oracle ; un seul mauvais tick
  franchissant 1,0 suffit.
- **Slippage de liquidation** — quand une liquidation se
  déclenche, le swap peut vendre ton collatéral à des prix
  érodés par le slippage. Le swap est permissionless —
  n'importe qui peut le déclencher dès que ton HF descend
  sous 1,0.
- **Défauts sur collatéral illiquide** — le défaut transfère ton
  collatéral intégral au prêteur. Il ne reste aucune réclamation
  résiduelle.

<a id="create-offer.advanced-options"></a>

### Options avancées

Réglages moins courants :

- **Expiration** — l'offre s'auto-annule après ce timestamp. Par
  défaut ≈ 7 jours.
- **Utiliser la remise sur frais pour cette offre** — surcharge
  locale du consentement à la remise au niveau wallet pour cette
  offre spécifique.
- Options spécifiques au côté exposées par le flux de création
  d'offre.

Les valeurs par défaut conviennent à la plupart des utilisateurs.

<a id="create-offer.borrow-or-sell"></a>

### Autoriser la vente optionnelle de ce NFT sur OpenSea (uniquement offres emprunteur avec collatéral NFT)

Si vous postez une **offre emprunteur** avec un **collatéral
ERC-721 ou ERC-1155** et un **principal ERC-20**, la application expose
un opt-in `Borrow or sell` sous la section collatéral. Le cocher
marque l'offre comme éligible pour un listing de vente parallèle
de votre NFT collatéral sur OpenSea — une seule offre qui peut
être remplie SOIT par un prêteur (vous prenez le prêt) SOIT par
un acheteur de place de marché (vous vendez le NFT). Le listing n'est
PAS démonté à l'acceptation du prêteur s'il était déjà posté : si
un prêteur remplit en premier, vous prenez le prêt, le listing
OpenSea existant se reporte à travers l'initialisation du prêt
jusqu'à son expiration Seaport originale, et un remplissage
place de marché ultérieur avant cette expiration déclenche la cascade
de règlement du diamond pour clôturer le prêt à partir des
recettes de vente (voir Scénario B ci-dessous). Pour les offres
GTT ordinaires cette expiration est le date limite GTT original de
l'offre ; l'acceptation du prêteur n'étend pas et ne repost pas
le listing pour la durée complète du prêt. Si un acheteur
place de marché remplit en premier, aucun prêt n'est jamais créé
(Scénario A). Les deux scénarios terminent dans des états d'offre
distincts : le Scénario A marque l'offre avec `consumed_by_sale`
via `markOfferConsumedBySale` (elle apparaît sous le filtre
Sold), et l'acceptation du prêteur est gatée contre toute offre
déjà marquée. Dans le Scénario B l'offre est déjà dans l'état
`Accepted` au moment où le remplissage place de marché atterrit ; le
contrat laisse délibérément le statut d'offre à `Accepted` et ne
règle que le prêt à partir de la vente — l'offre ne transite pas
à Sold une seconde fois.

**Nature en deux étapes.** L'opt-in à la création de l'offre ne
fait que définir le drapeau d'éligibilité sur l'offre. Obtenir un
listing réellement achetable sur OpenSea est une ÉTAPE DOUBLE
SÉPARÉE que la application n'automatise PAS aujourd'hui :

1. **Enregistrer + câbler sur le diamond.** Appelez
   `OfferParallelSaleFacet.postParallelSaleListing(uint96
   offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[]
   feeLegs)` tant que l'offre est encore active et avant toute
   acceptation de prêteur. Une fois l'offre acceptée, annulée ou
   consommée par vente, cet appel revert comme terminal ; cocher
   l'opt-in seul ne suffit pas à créer un listing reportable au
   Scénario B. L'ask doit aussi couvrir le seuil pré-prêt :
   principal plus intérêts pire-cas à travers la durée du prêt
   et la fenêtre de grâce, prélèvement trésorerie sur cet
   intérêt, le buffer de sécurité configuré, et tous les
   montants de fee-legs. Asks sous le seuil reverter à cette
   étape. L'argument `feeLegs` est le SEUL endroit où cet appel
   enregistre les obligations de frais protocole OpenSea et
   royalties créateur : le diamond soustrait chaque montant
   fee-leg des recettes vendeur et ajoute le destinataire +
   montant absolu au tableau de consideration Seaport. Passer
   `feeLegs: []` sur une collection à frais imposés produit une
   forme d'ordre que l'étape de publication OpenSea rejettera
   (les items de consideration de destinataires de frais sont
   manquants), et un remplissage Seaport direct routera l'ask
   complet au vendeur au lieu de répartir les frais comme requis.
   Les utilisateurs avancés doivent récupérer le calendrier des
   frais requis OpenSea pour la collection (le parser de frais
   in-repo à `apps/defi/src/lib/openseaFeeSchedule.ts` **[RETIRED #1854 — no live replacement; recover from git history / #1959]** est la référence) et
   passer des montants absolus dérivés contre l'ask avant
   d'appeler. Le facet construit en interne les OrderComponents
   canoniques Seaport à partir de ces entrées (plus des valeurs
   qu'il retient dans `CollateralListingExecutor.offerContext` —
   l'adresse du vault emprunteur, asset principal, champs
   collatéral, startTime, endTime) et le `Seaport.getCounter`
   actuel pour le vault, dérive l'orderHash via
   `Seaport.getOrderHash`, le retourne, enregistre le binding
   ERC-1271 du vault à ce hash, et accorde l'approbation conduit
   Seaport pour le NFT collatéral. L'événement
   `PostParallelSaleListing` émis expose les args d'entrée
   (`offerId`, emprunteur, orderHash, askPrice, données
   executor / conduit, salt, fee legs) ; il n'écho PAS les
   champs par-contexte, donc reconstruire OrderComponents off-
   chain nécessite les lectures supplémentaires décrites en
   étape 2 ci-dessous. **Important :** à ce stade l'ordre est
   déjà REMPLISSABLE via Seaport. Un bot surveillant les
   événements du contrat PLUS ces lectures peut reconstruire les
   OrderComponents et appeler `Seaport.fulfillOrder` directement
   — le listing n'a pas besoin d'apparaître sur l'UI place de marché
   OpenSea pour que le chemin de remplissage on-chain fonctionne.
   Si vous ne voulez pas que des contreparties remplissent à
   l'ask courant avant que l'étape 2 atterrisse, soit exécutez
   l'étape 2 immédiatement après l'étape 1, SOIT appelez
   `releaseParallelSaleLock` pour invalider le binding avant tout
   remplissage non intentionnel.
   Pour les collections à frais imposés, peuplez `feeLegs` à partir
   du calendrier de frais requis OpenSea / créateur de la collection
   avant d'appeler cette étape. N'utilisez QUE les lignes de frais
   requis, non-zéro ; limitez la liste au nombre de fee-legs
   supporté par le protocole ; convertissez chaque ligne en un
   montant fixe absolu dans l'asset principal au prix d'ask choisi ;
   et utilisez le destinataire de frais listé comme destinataire du
   leg. Si un frais requis arrondit à zéro au ask choisi, l'ask est
   trop petit pour cette collection et le post ne devrait pas être
   tenté. Passer un tableau vide n'est valide que pour les
   collections sans frais. Sur les collections à frais imposés cela
   peut produire un ordre qui échoue à la publication OpenSea ou ne
   peut pas satisfaire la forme de consideration requise du
   marketplace.
2. **Publier sur OpenSea.** Reconstruisez les mêmes
   OrderComponents que le facet a construits. L'événement
   `PostParallelSaleListing` seul ne suffit pas : il émet
   `offerId`, emprunteur, orderHash, askPrice, données executor
   / conduit, salt, et fee legs, mais la forme d'ordre offer-keyed
   nécessite aussi des valeurs retenues dans le storage
   `OfferContext` de l'executor (adresse vault emprunteur, asset
   principal, champs collatéral, startTime, endTime) plus le
   compteur Seaport du vault emprunteur (le compteur de
   l'offerer — `LibPrepayOrder.buildAndHashOfferMem` hash
   `Seaport.getCounter(ctx.borrowerVault)`, PAS le compteur du
   soumissionnaire). C'est le même contexte utilisé par le chemin
   offer-order de `LibPrepayOrder.buildAndHashOfferMem`, et il
   diffère de la forme d'ordre prepay-listing loan-keyed. Lisez
   les deux avant de poster :
   - `CollateralListingExecutor(executor).offerContext(orderHash)`
     retourne le struct `OfferContext` persisté pour ce hash.
   - `Seaport.getCounter(borrowerVault)` retourne le compteur
     Seaport canonique pour l'offerer du vault.
   Avec ces champs en main le struct OrderComponents reproduit
   exactement celui que le diamond a hashé. Avant de POSTer,
   ajoutez le champ API-only `parameters.totalOriginalConsiderationItems`
   — l'API OpenSea le requiert bien qu'il ne fasse PAS partie du
   struct Seaport qui produit le hash canonique ; les publishers
   in-repo (`apps/indexer/src/openseaPublish.ts`) l'injectent avant l'appel
   endpoint. Pour les ordres validés par ERC-1271, OpenSea
   accepte le champ `signature` comme `0x` (octets vides) — le
   callback on-chain du vault `isValidSignature(orderHash, '')`
   ignore les octets de signature et retourne la valeur magique
   EIP-1271 pour tout orderHash que le diamond a précédemment
   enregistré (de l'étape 1). POSTez le JSON à l'endpoint
   listings OpenSea (`POST
   /api/v2/orders/{chain}/{protocol}/listings`, selon les docs
   officiels [Create Listing](https://docs.opensea.io/reference/post_listing)
   — c'est le même endpoint que les publishers propres de
   Vaipakam dans `apps/agent/src/openseaProxy.ts` +
   `apps/indexer/src/openseaPublish.ts` utilisent). Ce n'est
   qu'après cette étape que le listing apparaît sur l'UI
   place de marché OpenSea et devient découvrable pour les acheteurs
   occasionnels. Vaipakam n'automatise pas actuellement cette
   soumission pour le chemin parallel-sale — surfaciser la
   publication de listing end-to-end est suivi comme follow-up.

Les utilisateurs avancés qui suivent le chemin manuel aujourd'hui
ont besoin des DEUX étapes pour obtenir une visibilité OpenSea ;
n'exécuter que l'étape 1 produit un ordre qui est remplissable
directement via Seaport (par un bot ou contrepartie qui
reconstruit les composants depuis l'événement) mais invisible sur
l'UI place de marché OpenSea.

**Mode de remplissage forcé à All-or-Nothing.** L'opt-in épingle
automatiquement le mode de remplissage de l'offre à `Aon` — les
modes Partial ou IOC avec parallel-sale activé créeraient
plusieurs prêts contre le collatéral d'une seule offre, ce contre
quoi le contrat verrou. Le toggle est caché sur les offres prêteur,
collatéral ERC-20, principaux NFT, et toute autre forme que le
`_validatePostParallelSale` du contrat rejetterait, donc vous ne
pouvez pas accidentellement le cocher sur une offre non éligible.

**Ce qu'un acheteur voit.**

- *Avant qu'un prêteur n'accepte* (Scénario A) : un acheteur qui
  remplit le listing OpenSea paie le prix listé. Sur les
  collections à frais imposés, Seaport route les legs de frais
  protocole OpenSea et frais créateur directement vers leurs
  destinataires configurés en premier ; l'executor passe
  uniquement les **recettes nettes** (prix listé moins ces legs
  de frais place de marché / créateur) au diamond. Le diamond
  escrowe ce montant net dans votre vault, le NFT se transfère à
  l'acheteur, et l'offre est marquée `consumed_by_sale` (visible
  comme statut "Sold" distinct dans Mes Offres, Activity, et
  Détails de l'Offre). Aucun prêt n'a jamais été créé ; vous
  gardez les recettes nettes de la vente.
- *Après qu'un prêteur a accepté* (Scénario B) : le listing se
  reporte à travers l'initialisation du prêt — ni le verrou du
  NFT emprunteur ni le listing ne sont démontés. Un remplissage
  acheteur ultérieur déclenche la cascade de règlement du
  diamond en une transaction Seaport. Même note de fee-leg que
  le Scénario A : sur les collections à frais imposés, Seaport
  route les legs de frais protocole OpenSea et frais créateur
  directement vers leurs destinataires configurés en premier, et
  l'executor passe uniquement les **recettes nettes** (prix de
  vente moins frais place de marché / créateur) dans la cascade du
  diamond. La vente est un remboursement financé par le collatéral, donc le
  diamond règle ce montant net exactement comme le ferait un
  remboursement au moment du remplissage : le prêt devient
  remboursé ; le dû du prêteur (le coupon complet quand le prêt a
  été créé avec `useFullTermInterest = true`, sinon les intérêts
  accumulés jusque-là, plus toute remise sur les frais de rendement
  du prêteur) est placé dans le vault du prêteur et payé au
  détenteur actuel de la position prêteur via le claim prêteur
  ordinaire ; la trésorerie reçoit son prélèvement net de cette
  remise ; et le reste est envoyé au wallet du détenteur actuel de
  la position emprunteur. Si le reste ne peut pas être payé à ce
  wallet, il est retenu et payé via le claim emprunteur ordinaire dans le Claim
  Center. Le prêteur n'est jamais payé dans la vente elle-même, donc
  rien du wallet du prêteur ne peut l'arrêter.

**Avec quoi vous ne pouvez pas le combiner.** Deux classes de
conflit distinctes, surfacées à différentes étapes du protocole :

- *Bloc temps-publication (listing sibling loan-keyed).* Si le
  prêt a déjà un listing parallel-sale reporté de la création de
  l'offre ET que l'emprunteur appelle ensuite
  `NFTPrepayListingFacet.postPrepayListing` (ou
  `updatePrepayListing`) pour poster un SECOND prepay listing
  loan-keyed sur le même prêt, le diamond revert avec
  `SiblingParallelSaleListingLive`. L'approbation conduit pour le
  NFT de l'emprunteur est un seul slot — exécuter les deux
  listings simultanément créerait une approbation ambiguë.
  L'emprunteur voit le revert à l'appel publish/update ; rien ne
  se remplit.
- *Bloc temps-remplissage (offset PrecloseFacet ouvert).* Si le
  prêt a une offre offset PrecloseFacet ouvert ET qu'un
  acheteur essaie ensuite de remplir le listing parallel-sale, le
  `_settleLoanFromParallelSale` du diamond revert avec
  `ParallelSaleBlockedByOpenOffsetOffer`. Le listing reste
  valide sur OpenSea mais toute tentative de remplissage revert
  jusqu'à ce que le lien offset soit effacé. La application ne affiche
  PAS actuellement de bannière / notification dédiée sur la page
  Détails du Prêt pour cette combinaison ; les utilisateurs
  verront les remplissages revert et pourraient avoir besoin
  d'inspecter la raison du revert sur un block explorer pour
  diagnostiquer. Le chemin de nettoyage est la affiche ordinaire
  d'annulation d'offre — appelez
  `OfferCancelFacet.cancelOffer(offsetOfferId)` pour annuler
  l'offre offset, ce qui libère le lien offset et débloque le
  remplissage parallel-sale (PrecloseFacet n'a pas de point
  d'entrée d'annulation séparé ; l'offset est lié à l'offre
  liée, donc annuler l'offre liée l'efface). Une affiche UI
  dédiée pour le conflit est en file d'attente comme suivi UX
  séparé.


<a id="chapter.claim-center"></a>

## Centre de réclamations

<a id="claim-center.claims"></a>

### Fonds réclamables

Les réclamations sont en mode pull par conception — les
événements terminaux laissent les fonds en garde du protocole et
le détenteur du NFT de position appelle réclamer pour les
déplacer. Les deux types de réclamation peuvent coexister dans
le même wallet en même temps. Les onglets spécifiques au rôle
ci-dessous décrivent chacun.

Chaque réclamation brûle le NFT de position du détenteur de manière
atomique. Le NFT *est* l'instrument au porteur — le transférer
avant de réclamer donne au nouveau détenteur le droit
d'encaisser.

<a id="claim-center.claims:lender"></a>

#### Si tu es le prêteur

La réclamation du prêteur rend :

- Ton principal de retour dans ton wallet sur cette chaîne.
- Les intérêts accumulés moins la coupe de trésorerie figée à la
  création de ton prêt (`{liveValue:treasuryFeeBps}`% pour les prêts
  créés au taux actuel). La
  coupe est elle-même réduite par ton accumulateur de remise sur
  frais VPFI pondéré dans le temps quand le consentement est
  activé.

Réclamable dès que le prêt atteint un état terminal (Settled,
Defaulted ou Liquidated). Le NFT de position de prêteur est
brûlé dans la même transaction.

<a id="claim-center.claims:borrower"></a>

#### Si tu es l'emprunteur

La réclamation de l'emprunteur rend, selon la manière dont le
prêt s'est réglé :

- **Remboursement total / preclose / refinance** — ton panier de
  collatéral. Aucun rabais sur la Loan Initiation Fee ne
  l'accompagne : ta remise a déjà été déduite des frais à
  l'acceptation.
- **Une vente prepay qui solde le prêt** — le collatéral part chez
  l'acheteur et ne te revient pas. Tu reçois le prix de vente moins
  le droit du prêteur, la coupe de trésorerie et les frais vendeur
  éventuels de l'annonce, versés au détenteur du NFT de position
  d'emprunteur.
- **Swap-to-repay** — ton collatéral est vendu pour couvrir la
  dette, jusqu'à un plafond que tu fixes. Fixé largement, il peut en
  être consommé plus que la dette n'exigeait strictement ; ce qui ne
  l'est pas te revient. Un excédent dans l'actif du prêt est
  normalement versé directement au détenteur du NFT d'emprunteur au
  lieu d'attendre sous forme de créance — sauf si ce détenteur est
  sous gel pour sanctions, auquel cas il est conservé en créance.
- **Liquidation HF ou défaut** — vérifie quand même, il peut
  rester un excédent. On ne prélève que la valeur nécessaire
  pour couvrir le liquidateur, le prêteur et le trésor, et le reste
  est enregistré comme ta créance. Sa FORME tient à une seule chose : le
  collatéral a-t-il été VENDU ou REMIS ? Vendu — c'est-à-dire
  acheminé au dehors par une place de marché — et le reliquat te
  parvient dans l'actif principal du prêt. Remis, et ce qui reste
  est le collatéral lui-même, grevé dans ton vault. Plus d'une chose le remet, et aucune ne dépend de la clôture par
  laquelle tu es passé : un liquidateur qui prend le collatéral
  directement avec une décote, une clôture appariée en interne contre
  une position opposée au lieu d'être envoyée sur le marché, et une vente qui n'a pas pu aboutir — là tu reçois le collatéral, sauf si le prêteur apporte une cotation
  qui fonctionne au moment de la réclamation — tu es alors payé dans
  l'actif du prêt ; la plupart des réclamations n'en apportent
  aucune. La liquidation ordinaire comme un défaut temporel
  tentent cet appariement interne AVANT de passer par le marché, si
  bien qu'aucune de ces deux voies ne se termine toujours de la même
  façon — c'est pourquoi il faut lire la créance, et non la voie. La
  voie avec décote, elle, est prévisible, mais dans l'autre sens :
  elle ne vend ni n'apparie, donc ce qui te reste est toujours le
  collatéral. Une liquidation
  partielle n'est pas une clôture du tout — le prêt reste ouvert
  et aucune créance n'est créée. Consulte la créance plutôt que
  de supposer laquelle tu as. Sur un défaut portant sur un actif illiquide, tout le
  panier part et il ne reste rien — et sur cette voie c'est la
  règle, non une issue malheureuse.

Le NFT de position d'emprunteur est brûlé au moment où tu
réclames, pas quand le prêt se résout — un excédent laissé par une
liquidation reste donc récupérable ensuite. La survie du NFT ne
prouve pas à elle seule qu'il y a un excédent : si une liquidation
n'a rien laissé, il n'y a rien à récupérer, la réclamation est
refusée, et le NFT peut rester quand même. Lis
la créance, pas le NFT.

---

<a id="chapter.activity"></a>

## Activité

<a id="activity.feed"></a>

### Flux d'activité

Événements on-chain impliquant ton wallet sur la chaîne active,
sourcés en direct depuis les logs du protocole sur une fenêtre
glissante de blocs. Aucun cache backend — chaque chargement
récupère les données à nouveau. Les événements sont regroupés par hash de transaction
pour que les txns multi-événements (par exemple, accept +
initiate dans le même bloc) restent ensemble. Les plus récents
en premier. Affiche offres, prêts, remboursements, réclamations,
liquidations, mints / burns de NFT, et dépôts / retraits de VPFI
en vault.

---

<a id="chapter.vpfi"></a>

## VPFI

<a id="buy-vpfi.overview"></a>

### Obtenir du VPFI

VPFI est librement transférable. Procure-t'en sur le marché ouvert
partout où il s'échange, ou transfère-le par bridge : VPFI est un
token cross-chain Chainlink CCIP, donc il circule entre les chaînes
prises en charge via le bridge officiel et atterrit dans ton wallet
sur la chaîne vers laquelle tu as bridgé.

<a id="buy-vpfi.discount-status"></a>

### Ton statut de remise VPFI

Statut en direct :

- Tier courant (0 à 4).
- Solde VPFI d'vault plus l'écart jusqu'au tier suivant.
- Pourcentage de remise au tier courant.
- Drapeau de consentement au niveau wallet.

Le VPFI en vault compte pour ton tier de remise tant qu'il reste
déposé — il n'y a pas d'action « stake » séparée.

<a id="buy-vpfi.deposit"></a>

### Dépose le VPFI dans ton vault

Une étape de dépôt explicite séparée, depuis ton wallet vers ton
vault sur la même chaîne. Requise sur chaque chaîne — même la
canonique — car le dépôt en vault est toujours une action
explicite de l'utilisateur par spécification. Sur les chaînes
où Permit2 est configuré, l'app préfère la voie en signature
unique au pattern classique approve + deposit ; elle bascule proprement
si Permit2 n'est pas configuré sur cette chaîne.

<a id="buy-vpfi.unstake"></a>

### Désengage le VPFI de ton vault

Retire du VPFI de ton vault vers ton wallet. Pas d'étape
d'approbation — le protocole possède l'vault et se prélève
lui-même. Le retrait déclenche une refixation immédiate du
taux de remise au nouveau solde plus bas, appliqué à chaque
prêt ouvert te concernant. Il n'y a pas de fenêtre de grâce où
l'ancien tier s'applique encore.

<a id="buy-vpfi.cross-chain-tier"></a>

### Comment ton tier VPFI voyage entre les chaînes

Tu détiens tes VPFI dans ton vault sur Base, la chaîne canonique, et
c'est Base qui calcule ton tier. Quand tu empruntes ou prêtes sur une
autre chaîne, celle-ci applique une copie de ton tier, que Base envoie
via Chainlink CCIP après chaque dépôt, retrait ou autre action qui le
modifie.

Trois choses à savoir :

- **Un tier qui monte avec le seul passage du temps a besoin d'une
  action sur Base pour voyager.** Quand ta période de détention se
  termine, ou que ta moyenne rattrape ton solde, sans dépôt ni
  retrait, le chiffre de Base est à jour tout de suite. Les autres
  chaînes l'apprennent avec ton prochain dépôt ou retrait sur Base,
  quel qu'en soit le montant.
- **Un tier plus bas voyage en premier.** Le protocole envoie un tier
  plus bas immédiatement et ne paie un tier plus haut qu'au plus une
  fois par jour et par chaîne. La livraison via CCIP prend ensuite
  quelques minutes en général. Tant qu'elle n'est pas arrivée, la
  chaîne continue d'appliquer ton tier précédent.
- **Une copie peut expirer.** Après 60 jours sans nouvelle copie (la
  valeur par défaut), ou dès qu'un changement de la table des tiers
  atteint cette chaîne, l'ancienne copie ne donne plus de remise sur
  cette chaîne. Une nouvelle copie n'est envoyée que lorsque ton tier
  change.

Les règles complètes, y compris l'interrupteur de remise qu'il te
faut sur Base comme sur la chaîne que tu utilises, sont dans le
chapitre « Comment fonctionnent les remises VPFI » plus bas. La
conception de la livraison est décrite dans le
[document de conception de la livraison des tiers](https://github.com/vaipakam/vaipakam/blob/main/docs/DesignsAndPlans/TierPushDeliveryDesign.md)
(en anglais).

---

<a id="chapter.rewards"></a>

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Le **pool d'interaction** verse une part journalière au prorata
d'une émission journalière fixe, pondérée par ta contribution en
intérêts réglés au volume de prêts du jour. Les fenêtres
journalières finalisent paresseusement à la première réclamation
ou règlement après la fermeture de fenêtre.

Les récompenses sont mintées directement sur la chaîne active — il
n'y a pas d'aller-retour cross-chain pour l'utilisateur.
L'agrégation cross-chain des récompenses se fait uniquement
entre les contrats du protocole.

<a id="rewards.claim"></a>

### Réclamer les récompenses

Une seule transaction réclame tes récompenses accumulées. Les
récompenses d'interaction sont nulles jusqu'à ce que la fenêtre
journalière concernée finalise (finalisation paresseuse
déclenchée par la prochaine réclamation ou règlement non nul sur
cette chaîne). L'UI verrouille le bouton tant que la fenêtre
est encore en cours de finalisation pour que les utilisateurs
ne sous-réclament pas.

<a id="rewards.withdraw-staked"></a>

### Retirer le VPFI de ton vault

Interface identique à « Désengage le VPFI de ton vault » dans la
section VPFI — retire du VPFI de l'vault vers ton wallet. Le VPFI
retiré sort de l'accumulateur de remise immédiatement (refixation
après solde sur chaque prêt ouvert).

---

<a id="chapter.loan-details"></a>

## Détails du prêt

<a id="loan-details.overview"></a>

### Détails du prêt (cette page)

Vue d'un prêt unique dérivée en direct du protocole, plus HF et
LTV en direct du moteur de risque. Affiche les conditions, le
risque de collatéral, les parties, les actions autorisées par ton
rôle et le statut du prêt, ainsi que le statut keeper en ligne.

<a id="loan-details.terms"></a>

### Conditions du prêt

Parties immuables du prêt :

- Principal (actif et montant).
- APR (fixé à la création de l'offre).
- Durée en jours.
- Heure de début et heure de fin (heure de début + durée).
- Intérêts accumulés, calculés en direct depuis les secondes
  écoulées depuis le début.

Le refinancement crée un nouveau prêt plutôt que de modifier ces
valeurs.

<a id="loan-details.collateral-risk"></a>

### Collatéral & Risque

Mathématique de risque en direct.

- **Health Factor** = (valeur USD du collatéral × seuil de
  liquidation) / valeur USD de la dette. Un HF en dessous de
  1,0 rend la position liquidable.
- **LTV** = valeur USD de la dette / valeur USD du collatéral.
- **Seuil de liquidation** = le LTV à partir duquel la position
  devient liquidable ; dépend de la classe de volatilité du
  panier de collatéral. Le déclencheur d'effondrement à haute
  volatilité est de 110% LTV.

Le collatéral illiquide a une valeur USD on-chain de zéro ; HF
et LTV passent à « n/a » et le seul chemin terminal est le
transfert intégral du collatéral en défaut — les deux parties
ont consenti à la création de l'offre via la reconnaissance de
risque illiquide.

<a id="loan-details.collateral-risk:lender"></a>

#### Si tu es le prêteur

Le panier de collatéral sécurisant ce prêt est ta protection. Un
HF au-dessus de 1,0 signifie que la position est surcollatéralisée
par rapport au seuil de liquidation. À mesure que HF dérive vers
1,0, ta protection s'amenuise. Une fois HF
descendu sous 1,0, n'importe qui (toi inclus) peut appeler
liquider, et le protocole enruta le collatéral via le failover
4-DEX vers ton actif principal. La récupération est nette de
slippage.

Pour le collatéral illiquide, en défaut le panier te revient
intégralement au moment du défaut — sa valeur réelle sur le
marché ouvert devient ton risque.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si tu es l'emprunteur

Ton collatéral verrouillé. Garde HF confortablement au-dessus de
1,0 — une cible de marge courante est 1,5 pour absorber la
volatilité. Leviers pour remonter HF :

- **Ajouter du collatéral** — recharger le panier. Action
  réservée à l'utilisateur.
- **Remboursement partiel** — réduit la dette, remonte HF.

Une fois HF descendu sous 1,0, n'importe qui peut déclencher une
liquidation basée sur HF ; le swap vend ton collatéral à des
prix érodés par le slippage pour rembourser le prêteur. Sur
collatéral illiquide, le défaut transfère ton collatéral
intégral au prêteur, et il ne reste rien à réclamer.

<a id="loan-details.parties"></a>

### Parties

Prêteur, emprunteur, vault du prêteur, vault de l'emprunteur
et les deux NFT de position (un pour chaque côté). Chaque NFT
est un ERC-721 avec métadonnées on-chain ; le transférer
transfère le droit de réclamer. Les contrats d'vault sont
déterministes par adresse — même adresse à travers les
déploiements.

<a id="loan-details.actions"></a>

### Actions

Interface d'actions, contrôlée par rôle par le protocole. Les onglets
spécifiques au rôle ci-dessous listent les actions disponibles
de chaque côté. Les actions désactivées affichent un motif au
survol dérivé du verrou (« HF insuffisant », « Pas encore
expiré », « Prêt verrouillé », etc.).

Actions permissionless disponibles à tous quel que soit le rôle :

- **Déclencher la liquidation** — quand HF descend sous 1,0.
- **Marquer en défaut** — quand la période de grâce a expiré
  sans remboursement total.

<a id="loan-details.actions:lender"></a>

#### Si tu es le prêteur

- **Réclamer en tant que prêteur** — uniquement en état terminal. Rend
  principal plus intérêts moins la coupe de trésorerie figée à la
  création de ton prêt (`{liveValue:treasuryFeeBps}`% pour les prêts
  créés au taux actuel ; encore réduite par ta remise yield-fee VPFI
  pondérée dans le temps quand le consentement est activé). Brûle le NFT de
  position de prêteur.
- **Initier un retrait anticipé** — liste le NFT de position de
  prêteur à la vente à un prix que tu choisis. Un acheteur qui
  finalise la vente prend ton côté ; tu reçois le produit.
  Annulable avant exécution de la vente.
- Optionnellement délégable à un keeper détenant la permission
  d'action pertinente — voir Paramètres des keepers.

<a id="loan-details.actions:borrower"></a>

#### Si tu es l'emprunteur

- **Rembourser** — total ou partiel. Le partiel réduit le solde
  restant et remonte HF ; le total déclenche le règlement
  terminal.
- **Preclose direct** — paie le solde restant depuis ton wallet
  maintenant et libère le collatéral.
- **Preclose offset** — vend une partie du collatéral via le
  routeur de swap du protocole, rembourse depuis le produit, et
  retourne le reste. Deux étapes : initier, puis finaliser.
- **Refinancer** — publie une offre d'emprunteur pour de
  nouvelles conditions ; une fois qu'un prêteur accepte,
  finaliser le refinancement échange les prêts atomiquement
  sans que le collatéral ne quitte ton vault.
- **Réclamer en tant qu'emprunteur** — uniquement en état terminal. Rend
  le collatéral en cas de remboursement total ; en défaut ou
  liquidation il peut rester un excédent, car on ne prélève que le
  collatéral qu'exigent la dette et le coût de sa clôture — voir la
  section Claim Center ci-dessus. Brûle le NFT de position
  d'emprunteur.

---

<a id="matching-opensea-offers-on-a-prepay-listing"></a>

### Matcher des offres OpenSea sur un prepay listing

Une fois votre prepay listing en ligne sur le place de marché OpenSea,
les acheteurs occasionnels placeront parfois des **item offers**
directement sur votre token — des offres liés à votre collatéral
spécifique, pas à n'importe quel token de la collection. Vaipakam
affiche ces item offers sur la page Détails du Prêt en temps réel
— un panneau séparé sous "Lister le collatéral sur OpenSea" avec une
ligne par offre entrante. Le panneau applique un **seuil de
buffer** — l'entitlement de règlement du prêteur (qui INCLUT
DÉJÀ le principal plus le coupon complet sur les prêts
full-term-interest ou les intérêts pro-rata sinon — voir
`PrepayListingFacet.getPrepayContext().lenderLeg`), plus le
prélèvement trésorerie, plus un buffer de sécurité — et **grise**
les offres qui ne le passent pas. Vous pouvez voir l'intérêt du
marché à chaque niveau mais ne pouvez Matcher que les offres que
le protocole règlera effectivement.

Les collection-wide / criteria offers (offres que n'importe quel
token dans la collection peut remplir) restent sur OpenSea mais
**n'apparaissent pas** dans le panneau Match de la application — la
consideration multi-leg que le protocole règle ne peut pas être
reconstruite contre une offre criteria sans une plomberie
contract-side qui n'est pas en v1. Si votre seule demande
entrante est collection-wide, le chemin pratique aujourd'hui est
d'attendre un offre item-spécifique OU de laisser le listing à
votre ask fixe et de laisser n'importe quel acheteur le remplir
directement. Vous ne pouvez pas régler manuellement un offre
collection-wide vous-même — le NFT collatéral vit dans votre
vault Vaipakam, et les ordres Seaport côté Vaipakam sont la seule
forme de règlement autorisée.

Sur les collections qui imposent des frais protocole OpenSea
et/ou royalties créateur, la application rend BIEN le panneau d'offres —
le récupération du calendrier de frais depuis l'API OpenSea est traité
comme consultatif ; les données de fulfillment réelles sont
récupérationées AU TEMPS DE CLIC MATCH. Le panneau Match rend
indépendamment du statut du récupération du calendrier de frais ; le
récupération de fulfillment au temps de clic est le verrou. Si ce récupération
échoue (rate limit, panne d'API, ou forme de collection non
supportée), le handler de clic côté application ABANDONNE avant qu'une
transaction `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` ne
soit construite — pas de calldata, pas de prompt de signature,
pas de revert. La fonction on-chain elle-même n'est pas un
sélecteur retournant `bool` ; quand elle s'exécute elle retourne
un orderHash `bytes32` ou revert. Donc le panneau d'une collection
à frais imposés peut afficher des offres que vous pouvez
parcourir mais toutes ne sont pas cliquables-pour-match à un
moment donné.

Quand vous trouvez une offre acceptable et cliquez sur **Match
offer**, la application ouvre le fenêtre de confirmation **Confirmer l’association**, qui répète le
valeur associée (le montant brut de l'offre OpenSea — PAS le
montant net auquel le diamond règle ; sur les collections à
frais imposés `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
calcule `effectiveAsk = offerValue - bidderFeeTotal` avant de
faire tourner le split prêteur / trésorerie / emprunteur, donc le
net que le diamond distribue réellement est plus petit que le
montant principal affiché du fenêtre de confirmation) et donne une explication générique du parcours
atomic-match. Après confirmation, la application envoie une seule
transaction `matchOpenSeaOffer` qui groupe l'offre du soumissionnaire avec
une contre-ordre fraîchement construite côté diamond en un seul
appel Seaport `matchAdvancedOrders` — le fulfillment du soumissionnaire,
le leg côté-listing de la contre-ordre (que vous ayez eu ou non
un prepay listing v1 antérieur en ligne ; le chemin atomic
supporte `existingHash == 0`), et la cascade de règlement du
diamond atterrissent atomiquement en un bloc. La transaction
réussit complètement (prêt clos comme remboursé, NFT transféré, recettes de
vente divisées) ou revert complètement (rien ne bouge), et il
n'y a **pas de fenêtre** entre la rotation de listing et le
règlement dans laquelle un acheteur tiers pourrait intervenir au
prix matched.

> **Pas de race window — atomique par construction.** Ceci est
> la fermeture structurelle du pattern v1 deux-étapes "cancel +
> post" : sous v1 la application ferait tourner le listing comme une
> transaction `updatePrepayListing` séparée, laissant le prix
> tourné en ligne sur OpenSea jusqu'à ce que le `fulfillOrder`
> du soumissionnaire atterrisse dans un bloc ultérieur — quiconque
> surveillant le mempool pourrait snipe le soumissionnaire hors du prix
> qu'il avait offert. Le chemin atomic ferme ce trou en liant
> les deux ordres dans un appel Seaport match : soit le soumissionnaire
> remplit au prix convenu soit toute la transaction revert.

**Ce que vous voulez encore vérifier avant de cliquer Match :**

- **Confirmez le valeur associée dans le fenêtre de confirmation.** Le fenêtre de confirmation affiche
  le montant brut de l'offre OpenSea. Sur les collections à
  frais imposés, le diamond règle contre l'effective ask net
  après les legs de frais place de marché / créateur côté soumissionnaire,
  donc la valeur du fenêtre de confirmation peut être supérieure au montant
  utilisé pour le split prêteur / trésorerie / emprunteur.
  L'adresse du soumissionnaire et le split précis ne sont décomposés ni
  dans le fenêtre de confirmation NI dans la ligne du panneau OpenSea Offers (la
  ligne montre valeur, payment token, type d'offre, soumissionnaire
  tronqué, et end time). Le split est appliqué on-chain par le
  diamond au règlement — le buffer de règlement du protocole
  garantit que l'effective ask couvre l'entitlement de
  règlement du prêteur (qui inclut déjà le principal plus le
  coupon complet sur les prêts full-term-interest ou les
  intérêts pro-rata sinon) plus le prélèvement trésorerie, donc
  le split est toujours au moins neutre pour vous. Si vous
  voulez voir le split projeté avant de confirmer, le diamond
  expose `PrepayListingFacet.getPrepayContext(loanId,
  asOfTimestamp)` comme view appelable — il retourne les legs
  prêteur et trésorerie que la cascade de règlement routera au
  timestamp donné, et le reste vous appartient.
- **Vérifiez la posture de frais OpenSea pour la collection.**
  Si la collection impose des frais protocole OpenSea ou
  royalties créateur, le chemin atomic a besoin d'une plomberie
  SignedZone `extraData` / criteria-resolver que la application récupération
  via le proxy de données fulfillment OpenSea de l'agent (PR
  #349) AU TEMPS DE CLIC MATCH. Le panneau Match rend
  indépendamment du statut du récupération du calendrier de frais ;
  le récupération des données fulfillment au temps de clic est le
  verrou. Si ce récupération échoue (rate limit, panne d'API, forme de
  collection non supportée), le handler de clic côté application
  abandonne avant de construire la transaction on-chain
  `matchOpenSeaOffer` — pas de calldata construit, pas de
  prompt de signature lancé, pas de bannière affichée à
  l'avance. Vous pouvez réessayer le clic plus tard (le récupération
  peut juste avoir été un blip API transitoire), ou remplir le
  listing directement sur OpenSea à l'ask listé en attendant.

---

<a id="chapter.how-liquidation-actually-works"></a>

## Comment fonctionne réellement la liquidation

Les Avertissements de Risque que tu as acceptés au moment de l'offre résument le résultat dans le pire des cas en deux phrases. Cette section explique la mécanique sous-jacente — utile si tu veux comprendre POURQUOI le secours en nature (in-kind fallback) existe, ou laquelle des quatre branches ton prêt prendrait réellement.

La fonction du contrat qui décide de la répartition est `LibFallback.computeFallbackEntitlements`. Elle parcourt quatre cas dans l'ordre ; le PREMIER qui correspond est celui qui s'exécute.

<a id="liquidation-mechanics.case-1"></a>

### Cas 1 — Oracle disponible, collatéral vaut ≥ montant dû

Le chemin sain. Les flux de prix Chainlink sont réactifs, le quorum secondaire Soft 2-sur-N (Tellor + API3 + DIA) n'a pas été en désaccord, et le collatéral saisi couvre le montant dû lorsqu'il est valorisé par l'oracle.

Ce qui se passe :

- Le prêteur reçoit des **actifs de collatéral** d'une valeur de (principal + intérêts accumulés + un bonus de secours de 3 %), valorisés par l'oracle. En effet : le prêteur est indemnisé à sa juste valeur, payé dans l'actif de collatéral plutôt que dans l'actif prêté.
- La trésorerie reçoit une prime de 2 % du principal, également valorisée en collatéral.
- L'emprunteur récupère le **reste** du collatéral. Il s'agit d'un véritable remboursement — c'est la sur-collatéralisation qui n'était pas nécessaire pour couvrir la réclamation du prêteur.

Exemple concret : un prêt de 1000 USDC contre 0,6 WETH (3000 $ de collatéral, 1000 $ de dette). L'oracle évalue l'ETH à 5000 $ / WETH ; dette + intérêts + bonus = 1050 $. Le prêteur reçoit 0,21 WETH (valeur de 1050 $), la trésorerie reçoit 0,004 WETH (valeur de 20 $ de la prime de 2 %), l'emprunteur reçoit les ~0,386 WETH restants.

<a id="liquidation-mechanics.case-2"></a>

### Cas 2 — Oracle disponible, collatéral vaut < montant dû

Le chemin « sous l'eau ». L'oracle fonctionne, mais le collatéral saisi vaut moins que le montant dû, même au prix de l'oracle. Courant lors de krachs d'actifs volatils où la valeur du collatéral chute plus vite que le HF ne peut réagir.

Ce qui se passe :

- Le prêteur reçoit **TOUT** le collatéral saisi, dans l'actif de collatéral.
- La trésorerie ne reçoit rien.
- L'emprunteur ne reçoit rien — il n'y a pas de reste à rembourser.

Le prêteur absorbe le déficit. Aucune autre réclamation n'existe contre l'emprunteur, le protocole ou tout tiers. C'est le cas dont traite spécifiquement la ligne « la récupération peut être inférieure à l'actif prêté » des Avertissements de Risque.

Exemple concret : même prêt de 1000 USDC / 0,6 WETH, mais l'ETH chute à 1500 $ / WETH. Le collatéral vaut maintenant 900 $ ; la dette est de 1050 $. Le prêteur reçoit les 0,6 WETH (valeur de 900 $), trésorerie 0, emprunteur 0.

<a id="liquidation-mechanics.case-3"></a>

### Cas 3 — Quorum de l'oracle NON DISPONIBLE

Le chemin du « quorum noir ». L'obsolescence de Chainlink dépasse le plafond de volatilité ET le quorum secondaire 2-sur-N ne peut pas se mettre d'accord (chaque secondaire est soit hors ligne, soit en désaccord avec le primaire). Le protocole n'a pas de prix fiable pour l'un ou l'autre côté du prêt, il ne peut donc pas calculer une répartition équitable.

Ce qui se passe :

- Le prêteur reçoit **TOUT** le collatéral saisi, dans l'actif de collatéral, **indépendamment de la valeur calculée** (car aucun calcul n'est fiable).
- La trésorerie ne reçoit rien.
- L'emprunteur ne reçoit rien.

Même paiement que dans le Cas 2, mais atteint pour une raison fondamentalement différente : le protocole ne décide pas que « le collatéral vaut moins que la dette » — il décide « Je ne peux faire confiance à aucun chiffre ici, donc le prêteur reçoit l'intégralité du panier saisi et absorbe ce qu'il vaudra sur le marché libre ».

Un événement on-chain différent (`LiquidationFallbackOracleUnavailable`) est émis afin que les auditeurs puissent distinguer les deux chemins dans l'analyse post-mortem.

<a id="liquidation-mechanics.case-4"></a>

### Cas 4 — Actif illiquide d'un côté ou de l'autre

Le chemin des actifs illiquides. L'actif prêté, l'actif de collatéral, ou les deux ne sont pas qualifiés de Liquides dans le classificateur du protocole (pas de flux Chainlink, ou pas de pool de liquidité concentrée de type Uniswap-V3 au-dessus du seuil de volume). Courant pour le collatéral NFT et les jetons à faible liquidité.

Ce qui se passe au moment du défaut :

- Le prêteur reçoit l'**intégralité du collatéral** en nature, indépendamment de la valeur de marché.
- Pas de partition entre « montant dû » et « reste » — l'évaluation par l'oracle ne peut pas être appliquée.
- L'actif peut valoir matériellement plus ou moins que le montant dû. Aucune garantie de reventabilité.

Les deux parties y ont consenti lors de la création de l'offre — la clause relative aux actifs illiquides des Avertissements de Risque couvre exactement ce cas. Tu ne peux pas atteindre cette branche à moins que les deux parties n'aient sciemment choisi de conclure un prêt impliquant un actif illiquide.

<a id="liquidation-mechanics.why-in-kind"></a>

### Pourquoi en nature, pourquoi pas toujours en cash ?

Trois raisons pour lesquelles le protocole paie en unités d'actifs de collatéral plutôt que de toujours échanger contre l'actif prêté :

- **Panne de Séquenceur / DEX** : lorsque le protocole ne peut pas exécuter un swap en toute sécurité (slippage > 6 %, liquidité faible, revers de DEX, séquenceur en panne), l'action la plus sûre est de livrer ce qu'il possède déjà — le collatéral saisi — directement. Forcer un swap à tout prix verrouillerait les pertes.
- **Scénario de cygne noir** : lors de cascades volatiles, un chemin avec oracle disponible peut disparaître en quelques minutes. Maintenir le secours en nature pré-installé permet au protocole de rester fonctionnel même lorsque chaque source de prix est dégradée.
- **Récupération par paire de contreparties** : au moment de la réclamation, le prêteur (ou son bot keeper) obtient une seconde chance via le failover complet de 4 DEX. Si les conditions se sont normalisées d'ici là, ils peuvent vendre le collatéral en nature pour l'actif prêté via la même infrastructure de routage que celle tentée par le chemin lors de la liquidation.

<a id="liquidation-mechanics.claim-time-retry"></a>

### Reprise au moment de la réclamation

`ClaimFacet.claimAsLenderWithRetry` permet au prêteur (ou à un keeper agissant sur le NFT du prêteur) de fournir une liste de tentatives classée d'appels aux adaptateurs de swap (0x → 1inch → Uniswap V3 → Balancer V2) lorsque le prêt est en `FallbackPending`. La bibliothèque parcourt la liste, valide au premier succès, et réécrit les réclamations du prêteur + emprunteur en produits de l'actif principal.

Un échec total laisse intacte la répartition du collatéral enregistrée et fait passer le prêt de manière terminale en Defaulted — point auquel le prêteur prend le collatéral en nature et est libre de lo vendre par n'importe quel canal externe.

<a id="liquidation-mechanics.internal-match-rescue"></a>

### Sauvetage par match interne pré-réclamation

Avant tout swap externe — lors de la liquidation HF, du défaut basé sur le temps, ET au moment de la réclamation — le protocole vérifie d'abord s'il existe un **prêt de direction opposée** capable de régler celui-ci sans aucune intervention de DEX.

Si le prêt A doit vendre du WETH contre de l'USDC et que le prêt B doit vendre de l'USDC contre du WETH, les deux peuvent être appariés directement : le collatéral de A couvre la dette de B et vice-versa, au prix de l'oracle du protocole. Pas d'agrégateur, pas de slippage, pas de frais de swap. L'emprunteur conserve beaucoup plus de son collatéral ; le prêteur est indemnisé au prix de l'oracle.

Ce chemin de match interne s'exécute automatiquement :

- **Lors de la liquidation HF** : lorsqu'un keeper appelle liquider et qu'une contrepartie opposée existe, le protocole règle en interne au lieu de swapper. Le keeper gagne toujours une incitation de matcher.
- **Lors du défaut basé sur le temps** : même vérification avant le swap de défaut.
- **Au moment de la réclamation** : lorsqu'un prêteur réclame un prêt bloqué en `FallbackPending`, le protocole vérifie à nouveau s'il existe une contrepartie opposée. C'est une véritable seconde chance : le pool de prêts appariables croît continuellement, de sorte qu'une contrepartie qui n'existait pas lors de l'échec initial de la liquidation peut exister au moment de ta réclamation.

Un prêt qui s'est retrouvé en `FallbackPending` parce que son swap lors de la liquidation a échoué *de manière transitoire* (un pic de slippage momentané, un revers de DEX, un tick d'oracle obsolète) est un candidat idéal pour le sauvetage — le collatéral sous-jacent est généralement encore parfaitement liquide, et un prêt opposé peut le régler proprement. Le protocole exige seulement que l'oracle puisse encore évaluer l'actif ; il n'exige pas que le DEX ait de la profondeur, car un match interne ne touche jamais un DEX.

Si aucune contrepartie opposée n'existe, le protocole se replie sur le chemin de l'agrégateur externe décrit ci-dessus. Le match interne est une optimisation « mieux si disponible », jamais un bloqueur.

---

<a id="chapter.allowances"></a>

## Allowances

<a id="allowances.list"></a>

### Allowances

Liste chaque allowance ERC-20 que ton wallet a accordée au
protocole sur cette chaîne. Sourcée en scannant une liste
candidate de tokens contre les vues d'allowance on-chain.
Révoquer met l'allowance à zéro.

Conformément à la politique d'approbation au montant exact, le
protocole ne demande jamais d'allowances illimitées, donc la
liste typique de révocation est courte.

Note : les flux de type Permit2 contournent l'allowance par
actif sur le protocole en utilisant une signature unique à la
place, donc une liste propre ici n'empêche pas les dépôts
futurs.

---

<a id="chapter.alerts"></a>

## Alertes

<a id="alerts.overview"></a>

### À propos des alertes

Un watcher off-chain interroge chaque prêt actif impliquant ton
wallet à une cadence de 5 minutes, lit le Health Factor en
direct de chacun, et sur un franchissement de bande dans la
direction dangereuse déclenche une fois via les canaux
configurés. Pas d'état on-chain ni de gas. Les alertes sont
consultatives — elles ne déplacent pas de fonds.

<a id="alerts-inbox"></a>

### La boîte des Alertes

La page Alertes lit la boîte de l'index pour le wallet connecté sur son réseau, les plus récentes d'abord, cinquante lignes à la fois. Une ligne est écrite pour le wallet qui détient la position du prêt au moment de l'écriture : prêt démarré ; remboursement partiel et total, y compris clôture anticipée, refinancement, swap-to-repay et clôture par vente de la garantie ; défaut ou liquidation ; clôture par appariement interne ; un prêt dont l'index a vu la fin sans pouvoir dire comment ; les avis d'échéance à 7 jours et à 1 jour ; entrée et fin du délai de grâce ; et santé sous 1,5, 1,2 et 1,05. Les lignes de santé sont écrites par le keeper du protocole : elles n'arrivent que tant qu'il tourne, et seulement pour les prêts auxquels la santé s'applique. Les lignes de dernier avis et d'expiration d'une entrée de récompense vont à son propriétaire. Une ligne est un pointeur, jamais un montant : la page du prêt lit la chaîne. Une réponse pour un autre réseau ou un autre wallet est refusée, les lignes illisibles sont comptées, et un type inconnu est affiché par son nom. Le compteur de l'en-tête est le décompte fait par l'index lui-même, sur toutes les lignes, des lignes dont l'id dépasse le plus récent noté comme vu dans ce navigateur ; les ids ne font que croître dans l'ordre d'écriture, donc une ligne portant un bloc plus ancien compte aussi. Ouvrir la page note comme vues toutes les lignes écrites jusque-là. La marque de lecture vit dans ce navigateur seulement et ne fait qu'avancer. Telegram, push, les alertes de santé et les rappels de paiement se configurent juste sous la boîte. Une ligne est un historique : elle dit où en était le prêt ou l'entrée quand elle a été écrite, jamais que c'est encore le cas, et une ligne d'expiration de récompense signifie que le retour de l'entrée au programme a commencé, pas qu'il est terminé.

<a id="alerts-channels"></a>

### Telegram, push et alertes

Chaque changement est une signature EIP-191 sur un message en clair qui nomme l'action, le portefeuille, le réseau et l'heure ; le service d'alertes accepte chaque demande signée une fois dans les dix minutes, et un enregistrement ne porte que le réglage qu'il change. Le service stocke le portefeuille, le réseau, les réglages et, une fois lié, l'identifiant de discussion Telegram ; il ne les renvoie pas, donc chaque carte indique ce que ce navigateur a fait. Le lien Telegram n'est prouvé que par une alerte de test qui arrive dans la discussion. Délier avec un portefeuille ordinaire efface tous les réseaux, un compte intelligent seulement le réseau signé, et un réseau en mode protégé garde la discussion jusqu'à la fin du délai de protection. Push n'est proposé que lorsque le statut du service dit que les deux expéditeurs peuvent envoyer sur un même canal ; s'il ne couvre que l'expéditeur des rappels, les alertes peuvent ne pas arriver par push. Les trois lignes de santé valent par défaut 1,5, 1,2 et 1,05 et se modifient ici, chacune au-dessus de la suivante et la dernière au-dessus de 1,0. Lier Telegram et activer push demandent d'abord les Conditions ; désactiver, jamais.

<a id="alerts-paid-push"></a>

### Alertes push payantes

Votre accord est un plafond enregistré sur la chaîne : le maximum de VPFI que vous paierez par côté du prêt. La carte l'affiche avec l'avis du contrat lui-même sur la couverture des frais actuels. En mode Basique, vous acceptez les frais actuels ; en mode Avancé, vous saisissez un plafond entre les frais et la limite du protocole de 50 VPFI, et accepter la limite accepte tous les frais que la gouvernance peut fixer. L'accord n'est proposé que là où le service d'alertes dit facturer, jamais à un portefeuille signalé par le contrôle des sanctions, et demande d'abord les Conditions. La vérification et une simulation viennent d'abord, et les frais sont relus juste avant l'ouverture de votre portefeuille : s'ils ont changé, rien n'est envoyé. Le retrait remet le plafond à zéro et est proposé dès qu'un plafond est enregistré, même protocole en pause ou service d'alertes injoignable. Un déploiement sans registre d'accord ne propose ni l'un ni l'autre, et la carte dit s'il peut encore facturer les frais.

<a id="alerts.threshold-ladder"></a>

### Échelle de seuils

Une échelle de bandes HF configurée par l'utilisateur. Passer
dans une bande plus dangereuse déclenche une fois et arme le
seuil plus profond suivant ; repasser au-dessus d'une bande la
réarme. Par défaut : 1,5 → 1,3 → 1,1. Des nombres plus élevés
sont appropriés pour un collatéral volatil. Le seul rôle de
l'échelle est de te faire sortir avant que HF ne descende sous
1,0 et déclenche la liquidation.

<a id="alerts.delivery-channels"></a>

### Canaux de livraison

Deux canaux :

- **Telegram** — DM bot avec l'adresse courte du wallet,
  l'identifiant du prêt et le HF actuel.
- **Push Protocol** — notification directe au wallet via le
  canal Vaipakam Push.

Les deux partagent l'échelle de seuils ; les niveaux
d'avertissement par canal ne sont volontairement pas exposés
pour éviter la dérive. La publication sur le canal Push est
actuellement stubée en attendant la création du canal.

---

<a id="chapter.nft-verifier"></a>

## Vérificateur de NFT

<a id="nft-verifier.lookup"></a>

### Vérifier un NFT

Étant donné une adresse de contrat NFT et un identifiant de
token, le vérificateur récupère :

- Le propriétaire actuel (o un signal de burn si le token est
  déjà brûlé).
- Les métadonnées JSON on-chain.
- Une vérification croisée avec le protocole : dérive
  l'identifiant de prêt sous-jacent depuis les métadonnées et
  lit les détails du prêt depuis le protocole pour confirmer
  l'état.

Affiche : minté par Vaipakam ? quelle chaîne ? statut du
prêt ? détenteur courant ? Te permet de repérer une
contrefaçon, une position déjà réclamée (brûlée), ou une
position dont le prêt est réglé et en cours de réclamation.

Le NFT de position est l'instrument au porteur — vérifie avant
d'acheter sur un marché secondaire.

---

<a id="chapter.keeper-settings"></a>

## Paramètres des keepers

<a id="keeper-settings.overview"></a>

### À propos des keepers

Une allowlist de keepers par wallet, jusqu'à 5 keepers.
Chaque keeper a un ensemble de permissions d'action autorisant
des appels de maintenance spécifiques sur **ton côté** d'un
prêt. Les chemins de sortie de fonds (rembourser, réclamer, ajouter
du collatéral, liquider) sont réservés à l'utilisateur par
conception et ne peuvent pas être délégués.

Deux gardes supplémentaires s'appliquent au moment de l'action :

1. L'interrupteur principal d'accès keeper — un frein d'urgence
   à un seul basculement qui désactive tous les keepers sans toucher à
   l'allowlist.
2. Un toggle d'opt-in par prêt, réglé sur la surface du Carnet
   d'offres ou des Détails du prêt.

Un keeper ne peut agir que quand les quatre conditions sont
remplies : approuvé, interrupteur principal activé, toggle
par-prêt activé et la permission d'action spécifique configurée
sur ce keeper.

<a id="keeper-settings.approved-list"></a>

### Keepers approuvés

Permissions d'action actuellement exposées :

- **Finaliser une vente de prêt** (côté prêteur, sortie de
  marché secondaire).
- **Finaliser un offset** (côté emprunteur, deuxième étape du
  preclose via vente de collatéral).
- **Initier un retrait anticipé** (côté prêteur, met la
  position en vente).
- **Initier un preclose** (côté emprunteur, lance le flux de
  preclose).
- **Refinancer** (côté emprunteur, échange atomique de prêt
  sur une nouvelle offre d'emprunteur).

Les permissions ajoutées on-chain que le frontend ne reflète
pas encore obtiennent un revert clair de « permission
invalide ». La révocation est instantanée sur tous les prêts —
il n'y a pas de période d'attente.

---

<a id="chapter.public-analytics-dashboard"></a>

## Tableau de bord d'analytique publique

<a id="public-dashboard.overview"></a>

### À propos de Public Analytics

Une page sans wallet, sur une seule chaîne : elle lit la chaîne
vers laquelle pointe l'app (la chaîne de lecture par défaut sans
wallet connecté). Pas d'agrégat multi-chaînes ni d'export ; pour
comparer des chaînes, ouvre la page sur chacune. Deux sources,
chacune signalée là où elle sert :

- l'API de lecture de l'indexeur, sans clé et en CORS ouvert — les
  chiffres des prêts, des offres, du recyclage et du bouclage ;
- les fonctions de lecture du Diamond lui-même via un RPC public —
  les chiffres du jeton VPFI et des frais.

Chaque source peut être interrogée directement pour reproduire ce
que montre la page.

<a id="public-dashboard.loans-offers"></a>

### Prêts et offres

Compteurs de prêts par statut depuis `/loans/stats`, y compris
les catégories règlement en attente, appariés en interne et reste,
pour que les parties fassent le total ; les sous-totaux ERC-20 et
location de NFT, en nommant à part tout prêt actif dont le type
d'actif n'est pas encore lu ; et les compteurs d'offres depuis
`/offers/stats`. Les offres ne sont que la table `offers` — les
ordres signés sans gas ne sont pas comptés — et les offres
annulées sortent de l'index, donc le total des offres n'est pas
un chiffre historique. Un compteur absent affiche « non fourni »
et un compteur impossible « fourni, mais pas un nombre
utilisable » ; aucun n'est affiché comme 0.

<a id="public-dashboard.recycling"></a>

### Compte de recyclage et bouclage

Le compte de recyclage (`/metrics/recycling`) liste pour chaque
jour du programme la réserve, son financement et le prélèvement,
étiquetés par l'index de jour propre au programme ; un jour non
finalisé apparaît sans réserve et un jour non armé est marqué
comme estimation. Le bouclage (`/metrics/loop-closure`) montre,
par jour UTC, ce que les réclamations ont versé, ce qui est resté
dans les vaults et ce qui a été absorbé, au regard du moment
jusqu'où va l'enregistrement. Les montants positifs sous la
précision affichée sont signalés, les parts arrondies vers le bas,
et un chiffre inconnu n'est jamais affiché comme zéro.

<a id="public-dashboard.transparency"></a>

### Transparence & source

L'adresse du Diamond avec un lien d'explorateur, la chaîne, ainsi
que le bloc et l'âge du curseur de l'indexeur. Chaque chiffre de
l'indexeur est à jour autant que ce curseur, pas plus ; quand deux
réponses sont combinées, c'est le curseur le plus ancien qui est
indiqué.

<a id="public-dashboard.vpfi-transparency"></a>

### Jeton VPFI

Depuis `getVPFISnapshot()` sur le Diamond : l'adresse du jeton et
`totalSupply` sur cette chaîne. Sur la chaîne canonique, aussi le
plafond, la marge (`cap − totalSupply`, ce qui peut encore être
émis) et le minter. Sur une chaîne miroir, l'instantané ne porte
ni plafond ni minter — l'offre y arrive par le token pool CCIP —,
donc la page montre l'offre locale et dit que le plafond et le
minter appartiennent à la chaîne canonique, plutôt que d'afficher
des zéros. Un jeton non lié et un instantané illisible sont
signalés séparément.

<a id="public-dashboard.fees"></a>

### Frais et trésorerie

Depuis `getTreasuryMetrics()`, `getTreasury()` et
`getNumeraireSymbol()`, lus dans le même agrégat Multicall3 que
l'instantané et figés sur un bloc, que la page indique avec son
âge :

- les frais depuis le début du registre des frais, et sur les
  dernières 24 heures et 7 jours, chacun évalué dans le numéraire
  à l'enregistrement et jamais réévalué ;
- un frais que le protocole n'a pas pu évaluer à l'enregistrement
  est inscrit à 0, et les sommes de fenêtre parcourent au plus les
  10 000 dernières entrées — les deux ne peuvent que sous-estimer,
  et la page le dit ;
- un changement de numéraire laisse les entrées antérieures dans
  l'ancienne unité, si bien qu'ensuite les totaux additionnent des
  montants en deux unités sous le symbole actuel et peuvent
  s'écarter dans un sens comme dans l'autre ; la page dit que les
  frais antérieurs sont comptés dans l'ancienne unité ;
- l'adresse de trésorerie. Si c'est une adresse externe, les frais
  partent à la perception et aucun solde n'est affiché pour elle.
  Si le Diamond est sa propre trésorerie, le montant détenu est
  affiché, évalué seulement sur les actifs présents dans des
  prêts ouverts et incluant les montants placés ailleurs pour le
  compte de la trésorerie.

Une fonction qui échoue affiche « n'a pas pu être lu » et ne
masque pas les autres.

---

<a id="chapter.refinance"></a>

## Refinancer

Cette page est réservée aux emprunteurs — le refinancement est
initié par l'emprunteur sur son prêt.

<a id="refinance.overview"></a>

### À propos du refinancement

Le refinancement solde atomiquement ton prêt existant depuis un
nouveau principal et ouvre un prêt frais avec les nouvelles
conditions, le tout en une transaction. Le collatéral reste
dans ton vault tout du long — pas de fenêtre non garantie. Le
nouveau prêt doit franchir le verrou HF ≥ 1,5 à
l'initialisation, comme tout autre prêt.

<a id="refinance.position-summary"></a>

### Ta position actuelle

Snapshot du prêt en cours de refinancement — principal courant,
intérêts accumulés à ce stade, HF / LTV et le panier de
collatéral. La nouvelle offre devrait dimensionner au moins le
solde restant (principal + intérêts accumulés) ; tout excédent
sur la nouvelle offre est livré à ton vault comme principal
libre.

<a id="refinance.step-1-post-offer"></a>

### Étape 1 — Publie la nouvelle offre

Publie une offre d'emprunteur avec tes conditions cibles.
L'ancien prêt continue d'accumuler des intérêts pendant
l'attente ; le collatéral reste verrouillé. L'offre apparaît
dans le Carnet d'offres public et n'importe quel prêteur peut
l'accepter. Tu peux annuler avant acceptation.

<a id="refinance.step-2-complete"></a>

### Étape 2 — Finaliser

Règlement atomique après que le nouveau prêteur a accepté :

1. Finance le nouveau prêt depuis le prêteur acceptant.
2. Rembourse l'ancien prêt en totalité (principal + intérêts,
   moins la coupe de trésorerie).
3. Marque l'ancien prêt comme remboursé. Ses NFT de position ne
   sont pas brûlés : les deux restent chez leurs détenteurs, marqués
   Loan Repaid. L'ancien prêteur réclame le remboursement avec le
   sien, et l'ancien NFT emprunteur reste comme reçu.
4. Mint les nouveaux NFT de position.

Revert si HF sous les nouvelles conditions serait inférieur à 1,5.

---

<a id="chapter.preclose"></a>

## Clôture anticipée

Cette page est réservée aux emprunteurs — la clôture anticipée
est initiée par l'emprunteur sur son prêt.

<a id="preclose.overview"></a>

### À propos de la clôture anticipée

Une terminaison anticipée pilotée par l'emprunteur. Deux voies :

- **Direct** — paie le solde restant (principal + intérêts
  accumulés) depuis ton wallet et libère le collatéral.
- **Offset** — initie l'offset pour vendre une partie du
  collatéral via le failover de swap 4-DEX du protocole contre
  l'actif principal, finalise l'offset pour rembourser depuis
  le produit, et le reste du collatéral te revient.

Pas de pénalité forfaitaire de clôture anticipée.

<a id="preclose.position-summary"></a>

### Ta position actuelle

Snapshot du prêt en cours de preclose — principal restant,
intérêts accumulés, HF / LTV courants. Le flux de preclose
**n'exige pas** HF ≥ 1,5 à la sortie (c'est une fermeture, pas
une ré-init).

<a id="preclose.in-progress"></a>

### Offset en cours

État : l'offset a été initié, le swap est en cours d'exécution
(ou la cotation a été consommée mais le règlement final est en
attente). Deux sorties :

- **Finaliser l'offset** — règle le prêt depuis le produit
  réalisé, retourne le reste.
- **Annuler l'offset** — abandonne ; le collatéral reste
  verrouillé, le prêt inchangé. À utiliser quand le swap a
  bougé contre toi entre initier et finaliser.

<a id="preclose.choose-path"></a>

### Choisis une voie

La voie directe consomme la liquidité du wallet dans l'actif
principal. La voie offset consomme le collatéral via swap DEX ;
préférée quand tu n'as pas l'actif principal sous la main ou
que tu veux aussi sortir de la position de collatéral. Le
slippage de l'offset est borné par le même failover 4-DEX
utilisé pour les liquidations (0x → 1inch → Uniswap V3 →
Balancer V2).

---

<a id="chapter.early-withdrawal-lender"></a>

## Retrait anticipé (prêteur)

Cette page est réservée aux prêteurs — le retrait anticipé est
initié par le prêteur sur son prêt.

<a id="early-withdrawal.overview"></a>

### À propos de la sortie anticipée du prêteur

Un mécanisme de marché secondaire pour les positions de prêteur.
Tu listes ton NFT de position en vente à un prix choisi ; à
l'acceptation, l'acheteur paie, la propriété du NFT de prêteur
est transférée à l'acheteur, et l'acheteur devient le prêteur
de référence pour tout règlement futur (claim au terminal,
etc.). Tu reçois le produit de la vente.

Les liquidations restent réservées à l'utilisateur et ne sont
PAS déléguées par la vente — seul le droit de réclamer est
transféré.

<a id="early-withdrawal.position-summary"></a>

### Ta position actuelle

Snapshot — principal restant, intérêts accumulés, temps
restant, HF / LTV courants du côté emprunteur. Cela fixe le
prix juste que le marché des acheteurs attend : le payoff de
l'acheteur est principal plus intérêts au terminal, moins le
risque de liquidation sur le temps restant.

<a id="early-withdrawal.initiate-sale"></a>

### Initier la vente

Liste le NFT de position en vente via le protocole à ton prix
demandé. Un acheteur finalise la vente ; tu peux annuler avant
que la vente ne soit exécutée. Optionnellement délégable à un
keeper détenant la permission « finaliser une vente de prêt » ;
l'étape d'initiation reste réservée à l'utilisateur.

---

<a id="chapter.stuck-token-recovery"></a>

## Récupération de jetons bloqués

Cette section couvre un CAS PARTICULIER dont la plupart des utilisateurs n'auront jamais besoin. Lis tout avant de cliquer sur le lien de récupération en bas — déclarer une source incorrecte peut verrouiller ton vault en vertu de la politique de sanctions du protocole.

<a id="stuck-recovery.what"></a>

### Ce que signifie « jeton bloqué »

Ton proxy Vaipakam Vault est un stockage interne au protocole. Ce n'est PAS une adresse de dépôt. Chaque dépôt pris en charge par le protocole passe par les points d'entrée des facets de Vaipakam, qui retirent des fonds de ton wallet vers ton vault dans le cadre d'une création d'offre, d'une acceptation de prêt ou d'une opération de stake. Les jetons qui arrivent au vault EN DEHORS de ce flux — un transfert direct `IERC20.transfer` depuis un wallet ou un retrait d'un CEX qui a copié-collé l'adresse de ton vault — restent là sans comptabilité du protocole. Le Visionneur d'Actifs les masque en n'affichant que le solde suivi par le protocole.

Deux manières dont les jetons se retrouvent bloqués :

1. **Tu les as envoyés toi-même.** Tu as copié l'adresse de ton vault (depuis le Tableau de bord ou un explorateur de blocs) dans un champ de retrait de CEX ou un formulaire d'envoi de jetons de wallet, et tu as validé. Les jetons ont atterri dans ton vault sans passer par le chemin de dépôt du protocole.

2. **Un tiers les a envoyés (« attaque par poussière » ou dust attack).** Quelqu'un a transféré une petite somme vers ton vault depuis un wallet signalé, dans l'espoir d'associer ton adresse à sa réputation. Il s'agit d'un véritable vecteur d'attaque contre les adresses à haut profil sur les chaînes sans permission.

<a id="stuck-recovery.taint-poisoning"></a>

### À propos de « l'empoisonnement par trace » (taint poisoning)

Si l'expéditeur tiers figure sur une liste de sanctions, les outils génériques d'analyse on-chain peuvent signaler ton vault comme « proche de sanctions » même si tu n'as jamais touché aux jetons entrants. Il n'existe aucun moyen on-chain d'annuler cela — l'événement de transfert est permanent. La comptabilité INTERNE de Vaipakam n'est pas affectée (nous ne suivons que les dépôts médiés par le protocole, la poussière n'entre jamais dans notre décompte), tes prêts / stakes / réclamations continuent donc de fonctionner normalement. Mais les outils externes qui ne comprennent pas notre comptabilité peuvent afficher des avertissements.

<a id="stuck-recovery.dont-recover"></a>

### Quand ne PAS récupérer

Si tu n'as PAS envoyé les jetons toi-même, **ne tente pas de les récupérer**. La récupération nécessite que tu déclare l'adresse de l'expéditeur. Si cette adresse figure sur la liste des sanctions, ton vault sera verrouillé en vertu de la politique de sanctions du protocole jusqu'à ce que la source soit retirée de la liste par l'oracle.

Les jetons que tu n'as pas envoyés ne sont pas les tiens. Les récupérer en déclarant une adresse « propre » que tu ne possèdes pas réellement est également une mauvaise idée — le protocole ne peut pas vérifier la déclaration on-chain, mais les outils d'oracle externes pourraient ne pas être d'accord plus tard.

La décision la plus sûre est d'ignorer la poussière non sollicitée. Cela n'affecte pas ton solde de protocole ni aucun prêt ou offre active.

<a id="stuck-recovery.when-recover"></a>

### Quand récupérer

Tu as envoyé les jetons toi-même par erreur, tu contrôles le wallet source et tu sais que la source ne figure sur aucune liste de sanctions (ton propre EOA, un hot wallet de CEX d'où tu as retiré, etc.).

<a id="stuck-recovery.flow"></a>

### Flux de récupération

1. Visite la [page de récupération](https://defi.vaipakam.com/recover).
2. Entre l'adresse du contrat du jeton, la source d'où tu as envoyé et le montant.
3. Lis attentivement l'avis de réception à l'écran.
4. Tape « CONFIRM » pour activer la signature.
5. Signe l'avis de réception EIP-712 dans ton wallet.
6. Soumets la transaction.

Deux résultats possibles :

- **Source propre** → les jetons sont ajoutés au solde suivi de ton vault. Retire-les de ton vault comme d’habitude ; si le mode compte protégé est actif, son délai de versement s’applique.
- **Source signalée** → les jetons restent dans l'vault, ton vault est verrouillé en vertu de la politique de sanctions du protocole. Le verrou se lève automatiquement si l'adresse est ultérieurement retirée de l'oracle de sanctions.

<a id="stuck-recovery.disown"></a>

### Désavouer des jetons non sollicités (piste d'audit de conformité)

Si tu souhaites un enregistrement public on-chain affirmant qu'un certain solde de jetons dans ton vault n'est PAS le tien, le protocole fournit une fonction `disownUntracked(kind, asset, tokenId)`. Elle émet un événement (`UntrackedDisowned`) et ne change rien d'autre — les jetons restent dans l'vault comme avant. Utile lors de litiges de conformité si un CEX ou un régulateur demande « avez-vous reçu ces fonds ? » : tu peux pointer vers l'événement on-chain.

La fonction disown est exposée uniquement via un appel direct au contrat pour l'instant ; le frontend Vaipakam ne la propose pas sous forme de bouton. Utilise l'interface « Write Contract » d'un explorateur de blocs ou un outil d'interaction avec les contrats pour l'appeler.

<a id="chapter.how-vpfi-discounts-work"></a>

## Comment fonctionnent les remises VPFI

Les VPFI détenus dans ton vault sur Base, la chaîne canonique, te
donnent droit à une remise sur les frais du protocole, sur toutes les
chaînes où la plateforme fonctionne. Plus tu en détiens, et plus
longtemps, plus ton tier est élevé et plus la remise est grande. Les
tiers figurent dans l'[échelle de tiers](#dashboard.fee-discount-consent)
plus haut ; la gouvernance peut les modifier.

Ce que la remise réduit :

- **En tant que prêteur**, la commission de rendement que le protocole
  prélève sur les intérêts que tu gagnes. Elle est lue à chaque
  règlement d'intérêts, par exemple au remboursement, à la clôture
  anticipée ou au refinancement, selon ton tier à ce moment-là, et non
  selon ton tier au début du prêt.
- **En tant qu'emprunteur**, le Loan Initiation Fee prélevé au
  démarrage du prêt. Elle est lue une seule fois, à l'acceptation, et
  reste attachée à ce prêt. Elle ne s'applique que si l'actif prêté est
  liquide ; un prêt illiquide paie les frais complets.

La remise est déduite des frais eux-mêmes, dans l'actif du prêt, et
aucun VPFI ne quitte ton vault pour cela. La seule exception est la
remise du prêteur sur un déploiement qui configure une référence de
prix VPFI : elle peut alors être réglée en VPFI depuis ton vault.
Aucune n'est configurée au lancement. Ce chapitre traite de cette
remise de détention. Un mode de frais payant distinct, « Full », reste
désactivé tant qu'un déploiement ne l'active pas.

<a id="vpfi-discounts.turning-on"></a>

### Activer la remise

La remise est facultative (opt-in). L'interrupteur se trouve sur la
page VPFI, et il y en a un par chaîne, car chaque chaîne garde son
propre réglage :

- **Sur la chaîne où les frais sont prélevés**, l'interrupteur doit
  être activé, sinon cette chaîne prélève les frais complets quel que
  soit ton tier.
- **Sur Base**, l'interrupteur doit aussi être activé, même si tu n'y
  empruntes ni n'y prêtes jamais. Tant qu'il est désactivé, Base envoie
  à toutes les autres chaînes un tier zéro pour toi.

Quand tu désactives la remise sur Base, l'application enchaîne avec une
mise à jour de tier pour que toutes les autres chaînes cessent aussi de
l'appliquer : Base leur envoie alors un tier zéro pour toi. Si cette
deuxième étape échoue, la page le dit, et les autres chaînes gardent ton
dernier tier jusqu'à ce qu'une nouvelle mise à jour soit envoyée. La
désactiver sur une autre chaîne ne change que cette chaîne.

Les VPFI comptent quand le protocole les enregistre dans ton vault :
ceux que tu déposes via la page VPFI, et les récompenses VPFI que le
protocole verse dans ton vault. Les jetons envoyés directement à
l'adresse de ton vault ne sont pas suivis par le protocole et
n'augmentent pas ton tier.

<a id="vpfi-discounts.tier-calculation"></a>

### Comment ton tier est calculé

Ton tier résulte de trois vérifications distinctes, et les trois
doivent passer :

1. **Une période de détention minimale.** Ton tier reste à zéro tant
   que ta détention actuelle n'a pas duré au moins 3 jours. Une
   détention commence au moment où le solde de ton vault passe
   au-dessus de zéro et dure jusqu'à ce qu'il revienne à zéro. Y
   ajouter des VPFI ne remet pas le compteur à zéro ; tout retirer, si.
   (3 jours est la valeur par défaut ; la gouvernance peut la fixer
   entre 2 et 14.)
2. **Une moyenne pondérée vers le récent.** Ton solde est moyenné sur
   les 30 derniers jours, les 7 derniers jours comptant trois fois plus
   que les précédents. La moyenne ne remonte jamais avant le début de
   ta détention actuelle, si bien qu'un nouveau détenteur n'est pas
   pénalisé par des jours où il ne détenait rien. (La fenêtre, le
   nombre de jours récents et le poids sont des paramètres de
   gouvernance ; la fenêtre peut aller de 14 à 30 jours.)
3. **Le tier le plus bas que tu as touché.** Indépendamment de la
   moyenne, ton tier ne peut pas dépasser le tier le plus bas atteint
   par ton solde pendant la détention actuelle, en remontant au plus
   30 jours en arrière. C'est le point le plus bas de chaque jour qui
   compte : une baisse suivie d'une remontée dans la même journée
   compte quand même comme une baisse.

Ce que cela signifie en pratique :

- Un dépôt juste avant le règlement d'un prêt ne relève pas ton tier
  tout de suite. Le montant ajouté doit d'abord entrer dans la
  moyenne, et le point le plus bas que tu as touché te plafonne
  toujours.
- Un retrait qui te fait passer sous le seuil d'un tier fait baisser
  ton tier immédiatement.
- Une baisse vieille de plus de 30 jours ne te plafonne plus.

<a id="vpfi-discounts.other-chains"></a>

### Ton tier sur les autres chaînes

Base calcule ton tier. Toutes les autres chaînes appliquent une copie
que Base leur envoie via Chainlink CCIP. Base met à jour ton
enregistrement de tier quand l'un de ces événements se produit sur Base
: des VPFI entrent dans ton vault ou en sortent (un dépôt, un retrait ou
une récompense versée dedans) ; un prêt démarre avec toi comme prêteur
ou emprunteur ; une étape d'un prêt bloque ou libère des VPFI à toi ; ou
tu fais l'appel de rafraîchissement du tier. Chaque mise à jour envoie
une nouvelle copie aux autres chaînes quand la copie changerait.

Chaque chaîne est livrée séparément. Une chaîne injoignable ne retient
pas les autres, et **une livraison qui ne peut pas partir ne fait
jamais échouer ta propre action** : ton tier sur Base est à jour tout
de suite, et la mise à jour reste due à chaque autre chaîne jusqu'à ce
qu'elle arrive.

Le protocole paie ces livraisons, avec une limite :

- **Un tier plus bas** est envoyé immédiatement, tant que le budget
  peut le payer. En attendant qu'il arrive, la chaîne continue
  d'appliquer ton tier précédent, plus élevé.
- **Un tier plus haut**, ou un changement de la table des tiers, est
  payé au plus une fois par jour et par chaîne (un paramètre de
  gouvernance entre 1 heure et 7 jours). D'ici là, la chaîne garde ton
  tier précédent.
- Une mise à jour retenue par cette attente, ou que le budget n'a pas
  pu payer, **n'est pas renvoyée d'elle-même à la fin de l'attente**. Elle
  part avec la prochaine mise à jour de votre enregistrement de palier sur
  Base, ou lorsque quelqu'un effectue l'appel de livraison pour vous.
- N'importe qui peut effectuer cet appel. Une fois l'attente passée, et
  si le budget peut payer, le protocole paie ; avant cela, l'appelant paie
  les frais cross-chain pour livrer plus tôt. Les contrats proposent cet
  appel ; l'application ne le propose pas encore.

Une copie cesse de compter, et la chaîne ne donne alors aucune remise,
quand :

- elle est plus ancienne que l'âge maximal de la chaîne (60 jours par
  défaut, jamais moins de 30) ; ou
- elle a été faite avec une table des tiers plus ancienne que celle que
  la chaîne connaît désormais.

Une copie n'est renvoyée que si quelque chose en elle changerait : ton
tier, sa remise, sa durée de validité ou la version de la table des
tiers. Après un changement de la table des tiers, la prochaine mise à
jour de ton enregistrement de tier sur Base envoie donc une copie neuve
à chaque chaîne, même si ton tier reste le même, sauf s'il vaut zéro. Si
rien de tout cela n'a changé, une chaîne dont la copie a expiré
n'applique aucune remise jusqu'à ce que quelque chose change.

Si ton tier monte uniquement parce que le temps a passé — la période de
détention est terminée, ou la moyenne a rattrapé ton solde —, rien sur
Base ne s'en aperçoit avant la prochaine mise à jour de ton
enregistrement de tier. L'appel de rafraîchissement du tier fait cette
mise à jour quand tu le veux ; l'application ne le fait pour toi que
lorsque tu désactives la remise.

<a id="vpfi-discounts.operators"></a>

### Pour les opérateurs

La partie cross-chain de la remise nécessite la configuration
suivante. Elle est listée ici pour quiconque exploite son propre
déploiement.

**Sur Base :**

- `VPFITokenFacet.setCanonicalVPFIChain(true)`. Sans cela, Base
  calcule les tiers mais ne les envoie nulle part.
- `RewardReporterFacet.setRewardMessenger` pointant vers le
  `VaipakamRewardMessenger`, et `setBroadcastDestinations` sur le
  messenger, listant toutes les autres chaînes.
- Un budget de diffusion alimenté :
  `ProtocolBroadcastFacet.topUpBroadcastBudget()` (payable). Un budget
  vide ne bloque rien. Chaque livraison qu'il ne peut pas payer reste
  due et émet `TierPushDeferred` avec la raison, et
  `getTierPushStatus(user)` montre l'état de chaque chaîne pour un
  utilisateur. Un budget insuffisant signifie que les autres chaînes
  appliquent d'anciens tiers plus longtemps : surveille les reports et
  réalimente.
- La fenêtre d'espacement des hausses payées : `setTierPushSpacingSec`
  (1 jour par défaut, de 1 heure à 7 jours).

**Sur chaque autre chaîne :**

- `RewardReporterFacet.setRewardMessenger(addr)` : le seul expéditeur
  dont la chaîne accepte les mises à jour de tier.
- `RewardReporterFacet.setBaseChainId(chainId)` : l'identifiant de
  chaîne EVM de Base (8453 sur mainnet, 84532 sur Base Sepolia), et non
  son sélecteur de chaîne CCIP.
- `ConfigFacet.setMirrorTierMaxAgeSec(seconds)` : la durée pendant
  laquelle une copie compte (60 jours par défaut ; les valeurs
  inférieures à 30 jours sont refusées). Une baisse prend effet à la
  lecture suivante.

**Modifier la table des tiers :**

- `setVpfiTierThresholds` et `setVpfiTierDiscountBps` sur Base font
  avancer la version de la table. Une autre chaîne apprend la nouvelle
  version par la première mise à jour de tier qui la porte, quel que
  soit l'utilisateur. À partir de là, toute copie faite avec l'ancienne
  table vaut zéro remise jusqu'à ce que la mise à jour propre à cet
  utilisateur arrive, et ces mises à jour sont des hausses payées au
  plus une fois par fenêtre d'espacement. Alimente le budget avant de
  modifier la table.
- `setTwaMinStakedDays` modifie la période de détention minimale sans
  faire avancer la version. Le changement prend effet à la lecture
  suivante.

<a id="chapter.next-app"></a>

## La prochaine app

La prochaine version de l'app Vaipakam se construit page par page, à
côté de l'actuelle. Une page pas encore construite le dit et renvoie
vers l'app actuelle, qui la sert toujours. Chaque chiffre d'une page
construite est lu sur la chaîne et nomme sa source ; un chiffre
illisible est affiché comme inconnu, jamais comme zéro.

<a id="advanced-mode"></a>

### Basic et Advanced

Basic montre les capacités dont la plupart des gens ont besoin.
Advanced ajoute les outils de sortie et de règlement,
l'automatisation, les ordres signés, la posture des keepers et le
détail comptable. Le mode est un choix d'affichage conservé dans
votre navigateur : il change ce qui est montré, pas ce que le
protocole permet, et ne masque jamais un consentement, un blocage ni
un remède.

<a id="wallet"></a>

### Votre wallet et l'origine de vos chiffres

Votre propre état (loans, offres, vault, claims) est lu sur la
chaîne : d'abord par le fournisseur du wallet, puis par le proxy RPC
en lecture seule, puis par le point d'accès public du réseau. La
ligne de synchronisation nomme la source qui a répondu et l'âge de
la lecture la plus ancienne de la page ; Actualiser les relit toutes.
L'index ne sert qu'aux chiffres globaux (le marché et l'historique),
avec sa hauteur de bloc et son âge. Un wallet sur un réseau non
servi ne voit rien de lui tant qu'il ne change pas. La puce d'adresse ouvre le panneau de compte propre à l'app : l'adresse complète avec une action de copie, le réseau, un passage vers chaque autre réseau desservi, et la déconnexion. Le sélecteur de wallet sert uniquement à se connecter. Une fois connectée, l'app n'effectue aucune recherche dans un service de noms : une session connectée ne lit rien sur le réseau principal d'Ethereum et n'atteint aucun hôte hors de la liste connect-src de la page.

<a id="deployments"></a>

### Ce que le déploiement prend en charge

L'app se lie à un Diamond par chaîne et lit ses sélecteurs routés via
le loupe avant de proposer une action. Après un rafraîchissement de
facets, cet ensemble change ; le lire plutôt que le supposer permet à
l'app de nommer une fonction manquante au lieu d'échouer avec
`FunctionDoesNotExist`. Tant qu'il est illisible, aucune étape de
signature n'est proposée.

<a id="home-start"></a>

### Home : choisir une tâche

Home commence par une tâche, pas par un terme du protocole :
emprunter, prêter, louer un NFT, mettre un NFT en location ou gérer
ce que vous avez. Emprunter et prêter s'ouvrent sur les offres qui
correspondent et mènent sinon à publier la vôtre. La location couvre
les deux côtés d'une location de NFT, le NFT restant dans un vault
tout du long. Un wallet connecté voit aussi trois cartes de démarrage
masquables ; ce choix est gardé dans le navigateur.

<a id="home-status"></a>

### Home : état du protocole

Home lit la pause globale, la fenêtre de pause automatique et la
pause des keepers sur la chaîne que la page décrit, et énonce le
résultat dans tous les cas. Une pause globale arrête les nouvelles
positions, les claims, les retraits, les liquidations, les défauts et
le règlement par les keepers ; le remboursement total et partiel et
l'ajout de collatéral restent ouverts, et le temps de pause est
crédité aux échéances de chaque loan ouvert. Une fenêtre de pause
automatique affiche sa fin ; une pause d'administration, s'il y en a
une, dure plus longtemps, et une nouvelle fenêtre automatique ne
s'ouvre qu'après un délai de carence. Une pause des keepers n'arrête
que les étapes que le service exécute pour vous. Un état illisible, y
compris une relecture échouée après une réponse antérieure, apparaît
en haut comme inconnu. Des actifs isolés peuvent aussi être en
pause ; les parcours concernés le disent.

<a id="home-payouts"></a>

### Home : prêt à encaisser

Home parcourt page par page les vues de claims côté prêteur et côté
emprunteur et nomme chaque paiement par loan et par côté. Il
n'affiche aucun montant : un paiement peut se faire en plusieurs
actifs et par plusieurs voies, et c'est Claims qui indique chaque
montant avant l'encaissement. Si le parcours s'arrête avant la fin,
Home dit qu'il peut en exister davantage.

<a id="home-loans"></a>

### Home : vos loans

Chaque loan Active ou FallbackPending est listé avec son côté, ses
conditions, son collatéral et son étape, par ordre d'urgence : grâce
dépassée, en grâce, fallback, échéance illisible, dû sous trois
jours, en cours. L'échéance et la fin de grâce viennent de l'horloge
des loans du protocole et incluent déjà le temps de pause, affiché
quand il n'est pas nul. Le health factor est la lecture à l'échelle
1e18 de la vue du tableau de bord ; une lecture de 0 signifie aucune
(un actif sans prix ou une lecture échouée) et est affichée comme
telle. Deux loans ou plus ouverts depuis la même offre, du même côté
et dans le même ERC-20, sont regroupés : principal additionné, taux
pondéré par le principal et arrondi vers le bas, et le health factor
le plus bas parmi les loans évalués, les autres étant comptés.

Un loan qui paie des intérêts périodiquement a aussi des échéances intermédiaires, jusqu'à son échéance finale incluse. Les intérêts encore dus à la fin du délai de grâce d'une échéance peuvent être payés en vendant du collatéral, et le loan reste ouvert ; Home montre la prochaine échéance et place en premier une échéance impayée, même si elle tombe à l'échéance finale, car son délai de grâce peut finir avant celui du loan. Le protocole peut désactiver ce règlement ; Home indique alors qu'aucun collatéral n'est vendu à une échéance.

<a id="home-exposure"></a>

### Home : prêté et emprunté

Le principal de chaque loan est évalué dans le numéraire aux prix
actuels par l'unique règle d'évaluation du protocole : une dette
arrondie vers le haut, un loan que vous avez accordé arrondi vers le
bas. Un loan impossible à évaluer (un NFT ou un actif sans prix) est
compté, pas estimé. Le côté le plus grand n'est nommé que si les
loans non évalués ne pourraient pas changer la réponse ; sinon Home
montre les totaux évalués et le décompte.

<a id="home-faucet"></a>

### Home : actifs de test

Sur un testnet dont l'enregistrement de déploiement publie des actifs de test, Home les liste : des ERC-20 de test reliés à un flux de prix et à un pool de test (liquides), d'autres laissés sans l'un ni l'autre à dessein (illiquides : les prêts qui les utilisent ne sont pas valorisés et le défaut se règle en nature), et des NFT de location ERC-4907. Une frappe appelle le contrat du jeton fictif, jamais le Diamond : 1 000 jetons entiers, ou un NFT sous un nouvel identifiant aléatoire vérifié non frappé avant l'ouverture du wallet. Le résultat est mesuré en relisant le solde ou `ownerOf`, et une frappe de jeton propose ensuite `wallet_watchAsset`. Un NFT de test ne peut être brûlé que par son propriétaire ou un opérateur approuvé.

<a id="home-fee-discount"></a>

### Home : remise sur les frais

`setVPFIDiscountConsent` fixe un indicateur par wallet sur le Diamond de cette chaîne. Désactivé, la remise liée à la détention vaut 0. Activé, les frais d'initiation du prêt de l'emprunteur sont réduits à l'acceptation, dans l'actif prêté (la voie de prix du VPFI ne fait jamais partie du parcours emprunteur), et les frais sur le rendement du prêteur sont remisés à chaque règlement selon le niveau effectif alors en vigueur. Le versement suit `getVPFIDiscountConfig` : si le taux du VPFI et son actif de référence sont tous deux définis, les frais remisés sont débités en VPFI du vault du prêteur, qui garde tous les intérêts ; sinon, les frais de trésorerie eux-mêmes sont réduits et aucun VPFI ne bouge. Si ce débit ne peut pas s'exécuter lors d'un règlement (pas de cotation disponible, trop peu de VPFI libre suivi dans le vault, ou ce VPFI bloqué en garantie), les frais de ce règlement ne reçoivent aucune remise liée à la détention. L'appel est `whenNotPaused`, donc la pause globale le ferme dans les deux sens. L'activation est soumise aux Conditions, la désactivation non, et aucune des deux ne diffuse de niveau vers les mirrors. La remise de l'emprunteur ne s'applique que si l'actif prêté est liquide à l'acceptation (un prêt illiquide paie la LIF complète), et toute remise est plafonnée à 50 % des frais.

<a id="home-rewards"></a>

### Home: Récompenses

Le chiffre principal est `RewardClaimFacet.simulateClaimInteractionRewards(user, 2)`, qui exécute le claim avec la destination Vault et revient toujours en arrière : `InteractionRewardsSimulation(paid, fromDay, toDay)` porte le chiffre exact, et tout autre revert est le refus propre du claim (`NoInteractionRewardsToClaim`, `InteractionDayGlobalNotFinalized(day)`, `InteractionDayAwaitingDelivery(day)`, `InteractionEmissionsNotStarted`, `EnforcedPause`, `SanctionedAddress`), affiché par son nom. Ce n'est que lorsqu'aucune source ne peut exécuter l'aperçu que Home lit `previewInteractionRewards`, une borne inférieure, et retient le claim. Un chiffre exact de zéro est tout de même proposé : le protocole n'autorise un claim qui ne paie rien que lorsqu'il dépasse des jours de récompense qui n'ont rien payé, et Home le dit. Home réclame via `claimInteractionRewardsTo(2)`, qui paie au plus `MAX_INTERACTION_CLAIM_DAYS` (30) jours par appel ; lorsqu'un aperçu lu au bloc du claim terminé ou après répond encore par un montant, Home propose le reste. Un claim payé uniquement à partir des entrées de récompense ne nomme aucune plage de jours (0 à 0), et Home le dit au lieu d'afficher des jours. La destination Vault est transmise pour tout compte, wallet de contrat compris, car la destination Default paie un appelant contrat sur son wallet : le vault est crédité, avec repli sur le wallet quand le crédit ne peut aboutir (pas encore de vault). Le résultat est lu dans le reçu : `InteractionRewardsClaimed` donne ce qui a été payé, et les logs `Transfer` de VPFI de la même transaction vers le wallet et vers `getUserVaultAddress(user)` indiquent où il est arrivé ; s'ils ne totalisent pas le montant payé, la destination est déclarée inconnue. Le total réclamé n'est pas affiché : aucune route d'index par utilisateur n'existe encore pour cela.

<a id="home-rewards-expiry"></a>

### Home: Dates de retrait des récompenses

Un `ConfigFacet.getRewardClaimHorizonDays()` égal à 0 signifie que l'horizon est éteint et qu'aucune date n'est affichée. Sinon, Home parcourt `getUserSoonestRewardExpiry(user, offset, 200, 50)` page par page, toutes au même bloc, jusqu'à dix pages ; le parcours est complet quand `nextOffset >= total`, et un parcours qui s'arrête avant est déclaré incomplet, jamais comme « rien n'est dû ». Le dernier avis s'affiche dans les 90 jours précédant l'estimation la plus proche. L'estimation est l'`expiresAt` de l'entrée à ce bloc : le temps où la réclamation n'est pas exécutable repousse le retrait réel, et un changement de gouvernance de l'horizon peut l'avancer. Le montant que retirerait l'entrée n'est pas affiché sur Home.

<a id="home-rewards-held"></a>

### Home: Récompenses retenues

`getSanctionsHeldReward(user)` est le solde retenu et `getRewardSanctionsStatus(user)` sa décision (Deliver, Hold ou Confirmed). Avec un solde et la décision Deliver, Home propose `claimHeldInteractionRewards(2)`, qui paie exactement le solde retenu sans régler quoi que ce soit de nouvellement dû et émet `InteractionRewardsClaimed(user, 0, 0, paid)` ; il revert avec `SanctionedAddress` tant que le portefeuille est interdit. La vérification avant signature relit les deux et simule l'appel en tant qu'expéditeur. Les jours gagnés sous un signalement confirmé sont perdus définitivement.

<a id="borrow-start"></a>

### Borrow: Comment ça marche

Borrow accepte directement une offre de prêteur (`offerType` 0) d'un ERC-20 contre une garantie ERC-20, avec `acceptOffer(offerId, terms, signature)`. En une transaction, il ouvre le vault de l'emprunteur s'il n'en a pas, y place la garantie, livre au wallet le principal moins les frais d'ouverture et émet `LoanInitiated`. Un emprunteur peut aussi publier une demande (`offerType` 1) ; les côtés NFT, les consentements par paire et les options avancées suivront dans des mises à jour ultérieures.

<a id="borrow-pair"></a>

### Borrow: Choisir les tokens

La classe de chaque token est lue en direct : d'abord `getAssetPriceStatus(asset)` (Divergent est lu comme non fiable et ferme les nouveaux prêts), puis `checkLiquidityOnActiveNetwork(asset)` (0 liquide, 1 illiquide). Un revert `OraclePriceDivergence` ou `OracleCrossCheckDivergence` est lu comme non fiable ; tout autre échec est affiché comme illisible, avec sa raison. La liste suggérée est le token natif enveloppé et les tokens de test du registre de déploiement ; une adresse collée n'est vérifiée que dans sa forme.

Le niveau de confiance lit `GET /assets/rankings?chainId=<token chain>` depuis l'index, qui sert la récupération quotidienne par le keeper de deux listes publiques de capitalisation (top 500 chacune) : une entrée par adresse avec le rang, le nom et le symbole de chaque liste, plus le `listFetchedAt` et la dernière exécution de chaque liste. L'application indexe par adresse en minuscules et retient le meilleur rang entre les listes : blue chip au rang ≤ 20 avec `getAssetPriceStatus(asset)` valorisé, puis ≤ 100, 200, 300 et 500. Un symbole qu'une autre liste classe à une autre adresse, sans qu'aucune liste ne classe les deux adresses, rend le jeton non vérifié ; un jeton non classé dont `symbol()` ou `name()` correspond à un symbole ou nom classé est une copie possible ; tout autre est non classé. Un jeton de test du registre de déploiement est marqué test ; une chaîne sans liste stockée se lit comme réseau de test sur un testnet et comme sans liste sur un mainnet. Un `lastRun` en échec après `listFetchedAt` est indiqué. Le niveau sert seulement à l'affichage et ne change aucun traitement on-chain. La recherche compare symboles et noms classés par sous-chaîne, meilleur rang d'abord, puis les jetons suggérés par symbole ; un texte commençant par `0x` est lu comme une adresse.

<a id="borrow-offers"></a>

### Borrow: Choisir une offre

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` donne les ids d'offres ouvertes de la paire et le total. Pour chacune, la page lit `getOffer`, `getOfferState` et, avec un wallet, `previewAccept(offerId, wallet)`, dont le `errorCode` est le refus du protocole. Le ratio prêt-valeur est `calculateLTV` aux prix du jour ; un côté illiquide ou sans prix dit pourquoi il n'y en a pas. Une acceptation directe fixe le `amountMax` du prêteur à `interestRateBps`. Les demandes d'emprunt, les offres avec un côté NFT et les siennes sont comptées, pas listées.

L'application regroupe les lignes par le taux que la prise engage (`interestRateBps`), le plus bas d'abord ; dans un palier, l'ordre de la liste est conservé. Le taux le plus élevé et, en mode Advanced, le ratio prêt-valeur le plus élevé ne font que filtrer les lignes lues ; une ligne dont `calculateLTV` n'est pas un chiffre est gardée et comptée. La ligne des prêteurs prêts lit `getActiveLenderIntents(offset, 50)`, jusqu'à quatre pages, garde les intentions de la paire et retient pour chacune le plus petit de `availableCapital` et de `maxExposure` moins `livePrincipal`, en écartant celle sous `minFillAmount`. Elle affiche le nombre, le plus grand chiffre individuel et le plus bas `minRateBps`, et en mode Advanced les plus hauts `maxDurationDays` et `maxInitLtvBps`. Un service de rapprochement ne remplit une demande sur une intention que dans ces limites, donc un remplissage n'est pas garanti. Cette ligne exige que `getPartialFillEnabled` et `isLenderIntentEnabled` soient tous deux à true, lus au même bloc que chaque page de la liste ; si l'un est à false, la page dit qu'aucune demande n'est remplie contre eux, et si l'un n'est pas lu, elle dit que ce n'est pas connu. Une relecture échouée garde la dernière réponse et dit qu'elle a pu changer. Les intents dont le `owner` est le compte connecté sont écartés (un appariement avec soi-même est refusé comme self-trade). Tout remplissage d'intent exige aussi `useFullTermInterest` de la demande et refuse `allowsPartialRepay` (`LenderIntentFullTermRequired`, `LenderIntentPartialRepayNotAllowed`) ; la voie énonce les deux, et le formulaire de demande signale un choix qui échoue à l'un d'eux à la place du remplissage probable. `keepersPaused()` est lu au même bloc lui aussi : tant qu'il vaut true, le service de rapprochement du protocole ne remplit rien, donc la page le dit à la place du remplissage probable et ajoute qu'un prêteur peut toujours remplir depuis son propre intent et que tout remplisseur peut en remplir un sans `requiresKeeperAuth` ; non lu, elle dit que ce n'est pas connu. Un remplissage d'intent exige aussi que le `periodicInterestCadence` de la demande soit nul, car la tranche de l'intent ne porte aucun calendrier et l'appariement refuse des conditions de cycle de vie différentes (`LifecycleTermsMismatch`) ; le formulaire de demande signale un calendrier choisi à la place du remplissage probable. Les intents avec `requiresKeeperAuth` sont agrégés et présentés à part, et la ligne du remplissage probable ne s'applique jamais à eux : seul le prêteur ou un solver qu'il a autorisé pour `KEEPER_ACTION_SIGNED_FILL` peut en remplir un, et l'autorisation du service de rapprochement n'est pas lue, donc la page dit qu'elle n'est pas connue. Le verdict lit aussi `paused()` et `aggregatorAdaptersPaused()` au même bloc : une pause globale prime sur toute autre barrière et est indiquée comme arrêt, et tant que les agrégateurs sont en pause, chaque propriétaire distinct est vérifié avec `isAggregatorAdapter` à ce bloc et ses intents sont exclus, puisque `matchIntent` les refuse ; une vérification non lue rend le verdict inconnu.

<a id="borrow-review"></a>

### Borrow: Vérifier et signer

La vérification lit l'offre, son état, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, les deux classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, le vault, le solde et l'autorisation du wallet, `previewOfferAcceptBlock` et le consentement de remise, et les relit juste avant l'ouverture du wallet. Le wallet signe l'EIP-712 `AcceptTerms` (domaine `Vaipakam AcceptOffer`, version 1) construit à partir de l'offre enregistrée, avec un nonce neuf de 128 bits et un délai de 30 minutes ; une reconnaissance d'illiquidité ne nomme qu'un côté que la vérification a montré illiquide. Une approbation d'exactement la garantie ne suit que si l'autorisation est insuffisante ; puis `acceptOffer` est simulé avec la signature et envoyé. Si cela s'arrête après l'approbation, l'app remet l'autorisation à sa valeur antérieure si rien d'autre ne l'a changée. Le résultat lit `LoanInitiated` pour cette offre et ce wallet et les logs `Transfer` du reçu. L'autorisation est relue juste avant la première demande du wallet, et c'est cette valeur que restaure une réinitialisation ; une acceptation envoyée qui échoue (revert), ou que le wallet annule ou remplace, reçoit la même réinitialisation du suivi des transactions. La revue indique `allowsPartialRepay`, `allowsPrepayListing`, `allowsParallelSale` avec `parallelSaleOrderHash`, `refinanceTargetLoanId` et le prêt lié, et présente le montant dû comme le cas sans pause, car les intérêts courent pendant une pause tandis que l'échéance se décale. Chaque étape d'approbation est jugée d'après l'autorisation relue au bloc de son reçu, jamais d'après le statut du reçu. Un jeton qui refuse de passer d'une autorisation non nulle à une autre, repéré par une exécution à blanc de `approve`, reçoit d'abord une étape à zéro, que la vérification compte comme une demande de plus. L'acceptation des Conditions est relue juste avant l'ouverture du portefeuille. Les deux voies de vente listent la garantie comme un NFT : sur une garantie en jetons, une autorisation de mise en vente accordée est donc indiquée comme inutilisable pour ce prêt. La vérification ajoute le `getNumeraireValue` du principal et de la garantie aux montants de l'aperçu, en lignes qui n'engagent rien.

<a id="borrow-fee"></a>

### Borrow: Les frais d'ouverture

Les frais sont le `lifEstimate` de `previewAccept` : `getLoanInitiationFeeBps` du principal, dans le token emprunté, déduits de ce qui est livré, réduits par la remise de niveau de détention quand le consentement est actif et que le token emprunté est liquide, avec le niveau fixé à l'acceptation. Cette page ne choisit jamais le tarif Full. Aucun VPFI n'est prélevé pour les frais ni remboursé. La part de l'émetteur, `getLifMatcherFeeBps` des frais, est versée à l'expéditeur, qui dans une acceptation directe est l'emprunteur ; le wallet reçoit donc le principal moins les frais plus cette part.

<a id="borrow-risks"></a>

### Borrow: Risques

Un prêt passé la fin de son délai de grâce (`getEffectiveGraceSeconds` après l'échéance, que le temps de pause décale) peut être mis en défaut par n'importe qui : la garantie liquide est vendue pour le prêteur, la garantie illiquide est transférée telle quelle. Une garantie liquide peut aussi être liquidée dès que le facteur de santé passe sous 1. `useFullTermInterest` facture les intérêts de toute la durée en cas de remboursement anticipé ; un calendrier d'intérêts règle une période manquée par une vente forcée de garantie.

<a id="borrow-request"></a>

### Borrow : Publier votre propre demande

Une demande est `createOffer` avec `offerType` 1, ERC-20 des deux côtés, envoyée depuis le wallet de l'emprunteur. Elle transfère `collateralAmount` dans le vault de l'emprunteur, en le créant s'il n'existe pas, et émet `OfferCreated(offerId, creator, 1)`. Un prêteur l'accepte avec `acceptOffer` : le principal moins les frais va au wallet de l'emprunteur, et la part des frais revenant à l'expéditeur va au prêteur qui l'a envoyée. `cancelOffer` est ouvert au créateur à partir de `MIN_OFFER_CANCEL_DELAY` (5 minutes) après la création, et à tout le monde une fois la demande expirée ; la garantie revient toujours au créateur. Sous chaque montant saisi, le formulaire affiche `getNumeraireValue(asset, amount, roundUp)` (le principal arrondi au-dessus, la garantie en dessous) dans l'unité de `getNumeraireSymbol`, lu dès que la saisie marque une pause ; un actif illiquide s'affiche comme valorisé à rien, un prix contesté comme sans valeur, et une lecture échouée comme non lue.

<a id="borrow-request-terms"></a>

### Borrow : Les conditions de la demande

Basic publie une demande à valeur unique : `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax`, `fillMode` 0, `periodicInterestCadence` 0, `allowsPrepayListing` et `allowsParallelSale` false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` true. Les montants sont convertis exactement en unités de base et le taux vaut au plus 10 000 bps. `durationDays` est plafonné par le maximum configuré, lu dans `getProtocolConfigBundle`. `expiresAt` vaut 0 (ouverte jusqu'à annulation) ou une heure fixée depuis le dernier bloc à l'ouverture de la vérification, au plus `MAX_OFFER_EXPIRY_HORIZON` (365 jours) en avant. `useFullTermInterest` vaut true par défaut et `allowsPartialRepay` false.

<a id="borrow-request-review"></a>

### Borrow : Vérifier et publier une demande

La vérification simule `createOffer` depuis le wallet et lit les deux classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, la durée maximale, le vault, le solde et l'allocation du wallet, et `calculateLTV` quand les deux côtés sont liquides ; elle est relue à chaque bloc et juste avant l'ouverture du wallet. Tant que l'allocation est insuffisante, la simulation n'atteint que le prélèvement de la garantie : une erreur de prélèvement du token ou un revert sans nom d'erreur du protocole est présenté comme l'approbation à donner, et une erreur nommée du protocole est un refus. Après une approbation exacte, `createOffer` est simulé de nouveau puis envoyé ; un arrêt après l'approbation la remet à sa valeur antérieure si rien d'autre ne l'a changée. Le résultat lit `OfferCreated` pour ce wallet et le `Transfer` de la garantie vers le vault.

<a id="borrow-nft-collateral"></a>

### Borrow : un NFT en garantie

La norme de la garantie est lue avec `supportsInterface` (ERC-721 `0x80ac58cd`, ERC-1155 `0xd9b67a26`) ; un revert ne compte pour aucune, et une lecture échouée ne propose aucune demande. Une demande ERC-721 envoie `collateralAssetType` 1, `collateralTokenId` l'identifiant saisi, `collateralQuantity` 1 et `collateralAmount` = `collateralAmountMax` = 0 ; la paire de risque est liée à cet identifiant. La revue lit `ownerOf`, `getApproved` et `isApprovedForAll(wallet, Diamond)` dans un même bloc ; un jeton détenu ailleurs, ou un `ownerOf` qui revert, bloque la demande. Sans aucune autorisation, la simulation s'arrête au `ERC721InsufficientApproval` du jeton, présenté comme l'autorisation à donner. L'autorisation est `approve(Diamond, id)`, comptée seulement quand `getApproved` lit le Diamond au bloc du reçu ; un arrêt ensuite la remet à l'adresse antérieure seulement tant qu'elle lit encore le Diamond et que le portefeuille détient encore le jeton. Pour un ERC-721, `setApprovalForAll` n'est jamais demandé. Le résultat lit `OfferCreated` et le `Transfer` du jeton lui-même (quatre topics) du portefeuille vers le coffre. Une demande ERC-1155 envoie `collateralAssetType` 2, l'identifiant du jeton, `collateralQuantity` égal à la quantité saisie (de 1 à 2^128−1) et les deux montants à 0. La revue lit `balanceOf(wallet, id)` et `isApprovedForAll(wallet, Diamond)` au même bloc ; un solde inférieur à la quantité bloque la demande, et sans l'autorisation la simulation s'arrête sur `ERC1155MissingApprovalForAll`. La seule autorisation est `setApprovalForAll(Diamond, true)`, comptée quand elle se relit au bloc de son reçu, et retirée par `setApprovalForAll(Diamond, false)` après que la demande est minée ou s'arrête (sans jamais lire avant le bloc de l'octroi), sauf si le portefeuille l'avait déjà accordée. Le résultat additionne les `TransferSingle`/`TransferBatch` du jeton du portefeuille vers le coffre. Les offres de prêteurs demandant un NFT passent toujours par l'application actuelle.

<a id="borrow-request-range"></a>

### Borrow: Une demande avec fourchette

Une fourchette envoie `amount` (le plus petit) en dessous de `amountMax` (le plus grand), `interestRateBps` = `interestRateBpsMax` (le taux unique), et `collateralAmount` (le plancher pour le plus petit prêt) inférieur ou égal à `collateralAmountMax` (versé dans le coffre à la publication) ; un plancher vide envoie les deux égaux. Les fourchettes ne sont proposées qu'avec une garantie ERC-20. Un `acceptOffer` direct prête `amount` à `interestRateBpsMax` contre `collateralAmount` et rend `collateralAmountMax − collateralAmount` au portefeuille ; `matchOffers` remplit entre les extrémités tant que `getPartialFillEnabled` est vrai. La simulation de `createOffer` applique la borne de l'offre à l'extrémité la plus grande et refuse avec `MaxLendingAboveCeiling(provided, ceiling)`, dont la vérification affiche le plafond. L'extrémité directe est vérifiée par une seconde simulation d'une demande à valeur unique en (`amount`, `collateralAmount`) ; une réponse qui s'arrête avant la borne est indiquée comme inconnue. Le ratio prêt-valeur de chaque extrémité est `calculateLTV(lending, amount, collateral, collateralAmount)`, et `ZeroCollateral` se lit comme une garantie sans valeur. Le facteur de santé de départ affiché est `getMinHealthFactor` tant que `getDepthTieredLtvEnabled` est faux, et 1,0 tant qu'il est vrai. Un appariement bloque l'exigence au prorata du prêteur, relevée à `collateralAmount` quand la garantie est une fourchette et sinon laissée à l'exigence ; le plus grand appariement est donc affiché à la fois à `collateralAmountMax` et à `collateralAmount` (ou, sans fourchette de garantie, comme pouvant bloquer moins) ; seule la vérification au démarrage du prêt le borne, et une lecture échouée de cette vérification est indiquée, jamais omise. Dans le régime par paliers, la vérification applique aussi le plafond de ratio prêt sur valeur du palier. Tant que `getPartialFillEnabled` est vrai, la garantie qu'un appariement ne bloque pas reste dans le coffre pour les appariements suivants et n'est remboursée qu'à la clôture de la demande (sa capacité restante passe sous `amount`) ou à l'exécution de `cancelOffer`.

<a id="borrow-request-fill"></a>

### Borrow: Le mode de remplissage d'une demande

`fillMode` vaut 0 (Partial), 1 (AON) ou 2 (IOC) et ne peut plus changer après la publication. AON exige `amount` = `amountMax` (`AonRequiresSingleValueAmount`) et IOC exige `expiresAt` ≠ 0 (`IocRequiresExpiry`) ; le formulaire ne propose aucune des formes refusées. Les montants, le taux et la garantie peuvent changer sur une demande ouverte via `setOfferAmount`, `setOfferRate`, `setOfferCollateral` et `modifyOffer`, jamais en dessous de `amountFilled` ou `collateralAmountFilled` ; cette application ne les appelle pas encore.

<a id="borrow-request-cadence"></a>

### Borrow: L'échéancier d'intérêts d'une demande

`periodicInterestCadence` va de 0 (None) à 4 (Annual), avec des périodes de 30, 90, 180 et 365 jours. Le formulaire propose ce qu'admet `previewCadenceAdmission(lendingAsset, amount, assetType, collateralAsset, collateralAssetType, durationDays)`, qui exécute la règle qu'applique `createOffer`, évaluée à `amount` (le plus petit bout d'une fourchette). Chaque refus est indiqué d'après ses données de revert : `PeriodicInterestDisabled`, `CadenceNotAllowedForIlliquid` ou `CadenceNotAllowed(cadence, durationDays, principalNumeraire, threshold)`. Les intérêts d'une période valent `principal × rate × intervalDays / (10000 × 365)`. N'importe qui peut régler une période manquée via `settlePeriodicInterest` une fois passé le délai de grâce `getEffectiveGraceSeconds(intervalDays − 1)` ; cela vend de la garantie et le prêt reste ouvert. L'armement de la passe keeper `periodicSettle` est affiché tel que le service de capacités le rapporte, inconnu par défaut. L'échéancier ne peut plus changer après publication.

<a id="borrow-request-tariff"></a>

### Borrow: Le tarif de frais Full d'une demande

L'adhésion est `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, envoyée par le créateur après `createOffer` et refusée avec `OfferAlreadyAccepted` dès qu'un prêteur a pris la demande ; `maxCStar` doit être supérieur à zéro (`FullTariffMaxCStarRequired`). Le formulaire affiche l'interrupteur de `getFeeEntitlementConfig()` et le tarif de `quoteCStar(lendingAsset, principal, durationDays)`, à `amount` et `amountMax` pour une fourchette ; le plafond par défaut est la cotation à `amountMax`. À chaque acceptation, le prélèvement prend `C*`, calculé sur le principal de ce prêt, seulement si l'interrupteur est activé, le principal a un prix et est liquide, `C* ≤ maxCStar` et les VPFI libres du coffre le couvrent (le solde du coffre plafonné par `getTrackedVPFIBalance`, moins les nantissements actifs, via `getFreeBalance`) ; sinon il échoue avec `FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed` ou `FeeEntitlementTariffAboveAuth`, sauf si `allowDowngrade` laisse le prêt s'ouvrir sans lui. La remise sur les frais de prêt de l'emprunteur augmente de `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000), plafonnée à `MAX_FEE_DISCOUNT_BPS` (5000). La revue bloque un choix sous lequel tout prêt serait refusé, et l'adhésion est mesurée en relisant `getOffer` (`creatorFull`, `creatorMaxCStar`, `creatorAllowFullDowngrade`). Cette application ne propose pas encore de prêt de secours pour les demandes non remplies.

<a id="lend-start"></a>

### Lend: Comment ça marche

Lend prend directement une demande d'emprunt (`offerType` 1) d'un ERC-20 contre une garantie ERC-20, avec `acceptOffer(offerId, terms, signature)` envoyé par le prêteur. En une transaction, le principal est prélevé du portefeuille du prêteur, via une autorisation au Diamond, vers le coffre du prêteur ; l'emprunteur le reçoit moins les frais d'ouverture ; la garantie déjà dans le coffre de l'emprunteur devient celle du prêt ; et `LoanInitiated` est émis, avec un NFT de position pour le prêteur et un pour l'emprunteur. Une offre de prêt (`offerType` 0) se publie depuis la même page ; les côtés NFT arriveront dans une mise à jour ultérieure.

<a id="lend-offers"></a>

### Lend: Choisir une demande

`getActiveOffersByAssetPairRanked(lending, collateral, 0, 20)` donne les identifiants des offres ouvertes de la paire. Pour chacune, la page lit `getOffer`, `getOfferState`, `getOfferLinkedLoanId` et, avec un portefeuille, `previewAccept(offerId, wallet)`, dont le `errorCode` est le refus du protocole. Une prise directe fixe le `amount` de la demande (son minimum) à `interestRateBpsMax`, et le ratio prêt-valeur est `calculateLTV` sur ce montant aux prix du jour. Les offres de prêteurs, les côtés NFT, les demandes du lecteur et les véhicules de vente de position prêteur (une offre côté emprunteur avec un `getOfferLinkedLoanId` non nul) sont comptés, pas listés. L'ordre : finançables d'abord, puis taux décroissant, puis montant décroissant.

<a id="lend-review"></a>

### Lend: Vérifier et signer

La vérification lit ce que lit celle de Borrow (l'offre, son état, `previewAccept`, `getOfferLinkedLoanId`, `getCurrentRiskTermsHash`, les deux classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getLifMatcherFeeBps`, le coffre du portefeuille, `previewOfferAcceptBlock` et le consentement à la remise sur les frais) plus `getTreasuryFeeBps`, et mesure solde et autorisation sur l'actif prêté, le côté que paie le prêteur. Un manque sur celui-ci bloque la signature, de même qu'un véhicule de vente de position prêteur. Le portefeuille signe l'EIP-712 `AcceptTerms` (domaine `Vaipakam AcceptOffer`, version 1), approuve exactement le principal seulement si l'autorisation est insuffisante (avec un passage à zéro d'abord pour un jeton qui refuse un changement entre valeurs non nulles), et `acceptOffer` est simulé puis envoyé ; une autorisation laissée par un parcours interrompu est rétablie comme sur Borrow. Le résultat lit `LoanInitiated` pour cette offre, le `Transfer` du principal hors du portefeuille et le `Transfer` retour de la part de l'apparieur.

<a id="lend-fee"></a>

### Lend: Les frais et la part du protocole

Les frais sont le `lifEstimate` de `previewAccept`, et ils sont à l'emprunteur : `getLoanInitiationFeeBps` du principal dans l'actif prêté, déduits de ce qui est versé à l'emprunteur, réduits à l'acceptation par la remise de palier de détention de l'emprunteur et, quand `creatorFull` est activé et que le prélèvement réussit, par le bonus du tarif Full. La part de celui qui soumet, `getLifMatcherFeeBps` des frais, est versée à l'expéditeur, ici le prêteur. La part du protocole sur les intérêts est `getTreasuryFeeBps`, fixée par prêt à son ouverture (`treasuryFeeBpsAtInit`) ; la remise de palier de détention du prêteur, consentement activé, la réduit au règlement des intérêts. La vérification affiche le taux du jour, et la part à ce taux comme plafond.

<a id="lend-risks"></a>

### Lend: Risques

Un prêt passé la fin de sa grâce (`getEffectiveGraceSeconds` après l'échéance, que le temps en pause décale) peut être mis en défaut par n'importe qui : la garantie liquide est vendue pour le prêteur, la garantie illiquide est transférée telle quelle. Si les deux côtés sont liquides, le prêt peut être liquidé dès que le facteur de santé passe sous 1, et la vente paie le prêteur en premier. Un côté illiquide exclut la liquidation fondée sur le prix, et en cas de défaut le prêteur reçoit toute la garantie. `useFullTermInterest` impose un plancher d'intérêts en cas de remboursement anticipé ; sans lui, les intérêts sont au prorata. Un calendrier d'intérêts périodiques règle une période manquée par une vente forcée de garantie au prêteur. Le NFT de position du prêteur porte la créance : le transférer transfère le prêt.

<a id="lend-offer"></a>

### Lend : Publier votre propre offre

Une offre de prêt est un `createOffer` avec `offerType` 0, ERC-20 des deux côtés, envoyé depuis le portefeuille du prêteur. Il prélève `amountMax` de l'actif prêté dans le coffre du prêteur, en créant le coffre s'il n'existe pas, et émet `OfferCreated(offerId, creator, 0)`. Un emprunteur l'accepte avec `acceptOffer` : sa garantie est prélevée dans son coffre, le principal moins les frais va dans son portefeuille, et la part des frais revenant à l'expéditeur lui va en tant qu'expéditeur. Tant que `getPartialFillEnabled` vaut true, `matchOffers` peut aussi l'associer à la demande d'un emprunteur ; une offre de prêteur à valeur unique prête alors tout son montant à son taux, contre au moins son `collateralAmount`. `cancelOffer` est ouvert au créateur à partir de `MIN_OFFER_CANCEL_DELAY` (5 minutes) après la création, et à tous une fois l'offre expirée ; le montant revient toujours au créateur.

<a id="lend-offer-terms"></a>

### Lend : Les conditions de l'offre

Sans parts, une offre de prêt est à valeur unique : `amount` = `amountMax`, `interestRateBps` = `interestRateBpsMax`, `collateralAmount` = `collateralAmountMax` (l'unique garantie qu'un emprunteur doit bloquer), `fillMode` 0 sauf si Advanced en fixe un autre (section suivante), `periodicInterestCadence` 0 sauf si Advanced fixe un échéancier, `allowsPrepayListing` et `allowsParallelSale` à false, `refinanceTargetLoanId` 0, `creatorRiskAndTermsConsent` à true, et aucun tarif Full sauf si Advanced le choisit. Les montants sont convertis exactement en unités de base et le taux est d'au plus 10 000 bps. `durationDays` est plafonné par le maximum configuré lu dans `getProtocolConfigBundle`. `expiresAt` vaut 0 (ouverte jusqu'à l'annulation) ou une heure fixée depuis le dernier bloc à l'ouverture de la vérification, au plus `MAX_OFFER_EXPIRY_HORIZON` (365 jours) plus tard. `useFullTermInterest` vaut true par défaut et `allowsPartialRepay` false.

<a id="rate-check"></a>

### Comparer votre taux aux prêts récents

Les deux formulaires lisent `/loans/recent` de l'index pour le même actif prêté, le même actif de garantie et la même durée, sans les véhicules de vente des prêteurs, et gardent les prêts ouverts au cours des 30 derniers jours portant un taux convenu que le registre de l'index atteste (un prêt aux conditions non confirmées est écarté). La comparaison porte sur la médiane de ces taux, la plus basse des deux valeurs centrales pour un nombre pair, afin de ne jamais inventer un taux entre deux taux convenus. Un taux à plus de 5 points de pourcentage (500 bps) donne un avertissement qui indique le sens : un prêteur très en dessous, ou un emprunteur très au-dessus, publie l'offre prise en premier quand les taux bougent ; dans l'autre sens, l'offre risque de rester sans preneur. Dans cette marge, c'est une note avec la médiane et le nombre. Une lecture couvre les 100 prêts les plus récents ; si elle atteint cette limite, la note dit que seuls les derniers ont été lus. Une réponse de l'index non limitée à la paire et à la durée demandées est refusée au lieu d'être comparée, une garantie NFT n'est pas comparée, et une lecture en échec le signale. Cela ne bloque jamais la revue. Les prêts de la paire dont l'index n'a pas confirmé les conditions n'appartiennent à aucune durée ; l'index les compte (`unplaced`) et le formulaire indique ce nombre à côté de la comparaison, pour que « aucun prêt confirmé » ne masque jamais des prêts de durée inconnue.

<a id="public-queue"></a>

### Réseaux à file d'attente publique

Sur Ethereum, BNB Chain et Polygon (et BNB Testnet et Polygon Amoy), une transaction envoyée attend dans une file publique avant d'être incluse, et quiconque observe cette file, robots compris, peut la voir et agir avant vous : prendre une offre avant que votre annulation n'arrive, ou agir sur un prêt avant votre remboursement. Sur ces réseaux, la revue de la publication, de la prise ou de l'annulation d'une offre, du remboursement et de l'ajout de garantie le signale donc avant l'ouverture de votre portefeuille. Certains portefeuilles peuvent envoyer une transaction en privé ; regardez dans leurs réglages de réseau ou de sécurité. L'application ne peut pas choisir cette voie pour vous, et l'envoi habituel ne change que qui peut voir la transaction avant qu'elle n'arrive. Base, Arbitrum et Optimism n'ont pas de file publique : rien n'y est affiché. Les réseaux forment une seule règle dans l'application (Ethereum 1, BNB Chain 56, BNB Testnet 97, Polygon 137, Polygon Amoy 80002), et un test échoue si un réseau servi par l'application n'est pas tranché. L'avis apparaît dans la revue, avant la dernière revérification et le portefeuille, pour ces opérations seulement : publier, prendre ou annuler une offre, remboursement total ou partiel, et ajout de garantie. L'aide ne nomme aucun service d'envoi privé, car le protocole ne peut pas vérifier la voie utilisée par un portefeuille, et l'effet de la transaction est le même par l'une ou l'autre voie.

<a id="lend-offer-parts"></a>

### Lend : Une offre en parts

Les parts envoient `amount` (la plus petite part qu'un appariement peut prêter) en dessous de `amountMax` (le montant entier, que `createOffer` verse dans le coffre) ; `collateralAmount` = `collateralAmountMax` reste l'unique exigence, exprimée pour `amountMax` (sinon `LenderCollateralRangeNotAllowed`), et `interestRateBps` = `interestRateBpsMax`. Un `acceptOffer` direct d'une offre de prêt prête `amountMax` contre `collateralAmount`, et seulement tant que `amountFilled` vaut 0 (`OfferPartiallyFilled` après un appariement). Tant que `getPartialFillEnabled` est true, `matchOffers` prête le milieu du recouvrement des montants, au moins `amount`, au milieu du recouvrement des taux, contre au moins `collateralAmount × matchAmount ÷ amountMax` (arrondi vers le bas ; la fourchette de garantie d'un emprunteur peut l'augmenter). Quand `amountMax − amountFilled` passe sous `amount`, le reste est retiré vers le portefeuille du prêteur et l'offre se ferme (`OfferClosed`, motif `Dust` ou `FullyFilled`). `cancelOffer` sur une offre en partie remplie ignore le délai et renvoie `amountMax − amountFilled`. `fillMode` vaut 0, 1 ou 2 comme pour une demande : AON exige `amount` = `amountMax`, IOC exige une expiration, et il ne change pas après la publication. Avec les deux jambes liquides, `createOffer` refuse un `collateralAmount` sous le plancher à `amountMax` avec `MinCollateralBelowFloor(provided, floor)`, dont la vérification montre le plancher. Un seul ratio prêt-valeur est affiché, `calculateLTV` à (`amountMax`, `collateralAmount`) : une part porte le même ratio, à l'arrondi près.

<a id="lend-offer-schedule"></a>

### Lend : Un échéancier d'intérêts sur une offre

Le `periodicInterestCadence` d'une offre de prêt suit la règle de la demande (ci-dessus), avec `previewCadenceAdmission` évalué au `amount` de l'offre : sa plus petite part, ou le montant entier sans parts. `createOffer` l'admet là via `requireCadenceAdmitted`, et l'origination de chaque prêt vérifie à nouveau son propre principal (`requireOriginationCadenceAdmitted`). La revue indique les intérêts d'une période à `amountMax` (une prise directe) et, avec des parts, à `amount`. Une période manquée peut être réglée par n'importe qui via `settlePeriodicInterest` après son délai de grâce : de la garantie est vendue pour payer au prêteur les intérêts de cette période, et le prêt reste ouvert.

<a id="lend-offer-tariff"></a>

### Lend : Le tarif de frais Full sur une offre

L'adhésion du prêteur est le même `setOfferCreatorFullTariff(offerId, true, maxCStar, allowDowngrade)`, envoyé après `createOffer`. Elle est refusée avec `OfferAlreadyAccepted` dès que l'offre est prise en entier ou fermée ; une offre appariée en partie l'accepte encore, pour ses prêts suivants. La cotation est `quoteCStar` à `amount` et `amountMax`, et le plafond prend par défaut la cotation à `amountMax`. Chaque prêt est vérifié seul contre `maxCStar`, au prix de son principal, aux mêmes conditions qu'une demande (`FeeEntitlementDisabled`, `FeeEntitlementFullOptInFailed`, `FeeEntitlementTariffAboveAuth`, ou un déclassement s'il est permis) ; la vérification du prêteur utilise le VPFI libre actuel du coffre. Un tarif perçu marque le `lenderMode` du prêt comme Full, et chaque règlement des frais de rendement du prêteur ajoute alors `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (1000) à la remise du détenteur de la position sur la part du protocole, plafonnée à `MAX_FEE_DISCOUNT_BPS` (5000), avec ou sans le consentement à la remise de détention. Une prolongation sur place (`repriceFeeEntitlementOnExtension`) met la marque à None pour la nouvelle durée.

<a id="lend-offer-review"></a>

### Lend : Vérifier et publier une offre

La vérification simule `createOffer` depuis le portefeuille et lit les deux classes, `getEffectiveGraceSeconds(durationDays)`, `getLoanInitiationFeeBps`, `getTreasuryFeeBps`, la durée maximale, le coffre du portefeuille, son solde et son autorisation sur l'actif prêté (le côté que le prêteur bloque), et `calculateLTV` quand les deux côtés sont liquides ; elle est relue à chaque bloc et juste avant l'ouverture du portefeuille. Tant que l'autorisation est insuffisante, la simulation ne peut atteindre que le prélèvement du montant : une erreur de prélèvement du jeton, `VaultDepositFailed` (l'enveloppe du protocole autour d'un prélèvement annulé sans données, comme le fait WETH quand l'autorisation est insuffisante) ou une annulation sans nom d'erreur du protocole est donc montrée comme l'approbation à donner, selon la même règle que la vérification d'une demande ; toute autre erreur nommée du protocole est un refus. Après une approbation exacte, `createOffer` est simulé de nouveau puis envoyé ; un arrêt après l'approbation remet l'autorisation à sa valeur antérieure si rien d'autre ne l'a modifiée. Le résultat lit `OfferCreated` pour ce portefeuille avec `offerType` 0 et le `Transfer` du montant vers le coffre.

<a id="lend-offer-fee"></a>

### Lend : Les frais de votre offre

`createOffer` ne facture rien au prêteur. Les frais affichés sont ceux de l'emprunteur : `getLoanInitiationFeeBps` du montant dans l'actif prêté, au taux en vigueur quand `acceptOffer` s'exécute, réduits alors par la remise de palier de détention de l'emprunteur et déduits de ce qui lui est versé ; le chiffre affiché utilise le taux d'aujourd'hui. La part du protocole sur les intérêts est `getTreasuryFeeBps`, fixée par prêt à son ouverture (`treasuryFeeBpsAtInit`) ; la remise de palier de détention du prêteur, avec le consentement activé, la réduit au règlement des intérêts. La vérification montre le taux d'aujourd'hui et la part à ce taux comme plafond ; une lecture échouée de `getTreasuryFeeBps` est signalée, et aucune part ni aucun montant de retour n'est affiché.

<a id="positions"></a>

### Positions : comment la liste est lue

Positions lit le même inventaire que Home via un lecteur partagé : `getUserPositionLoansPaginated` parcourt les NFT de position détenus par le wallet, `getLoansBatch` les charge, et chaque côté vient du jeton détenu (`lenderTokenId` ou `borrowerTokenId`), jamais de la partie enregistrée à l'origine. Les prêts au statut Active ou FallbackPending sont en cours, avec les échéances, le facteur de santé et le regroupement décrits sous Home. Tout autre statut est terminé, l'id de prêt le plus récent d'abord, nommé d'après `LoanStatus` : Repaid, Defaulted, Settled ou InternalMatched (clos par un appariement) ; un numéro de statut que l'app ne connaît pas est affiché comme numéro. Les paiements suivent la règle des réclamables décrite sous Home : une position détenue sur un prêt terminé, reçue d'une autre personne, est comptée, pas devinée.

Le choix du côté filtre les paiements et les lignes en cours et terminées selon le côté détenu. « Rien » n'est affiché que lorsque le parcours des positions et celui des paiements sont complets et que la dernière lecture a réussi ; un parcours arrêté à son plafond est déclaré incomplet. Une ligne ouvre `/positions/<id>`, où le verdict d'éligibilité décide de chaque action ; la liste n'envoie aucune transaction.

Avec deux lignes en cours ou plus après le choix du côté, une carte de récapitulatif vient en premier. Par côté, elle additionne `principal` par `principalAsset` ERC-20, jamais entre jetons (la comparaison des valeurs reste à la ligne d'exposition), et compte les lignes à principal NFT comme des locations. La prochaine date est la plus proche encore à venir parmi les étapes que les lignes utilisent : une échéance en cours ou proche (remboursement) ou un point de contrôle périodique à venir (intérêts), l'égalité allant à l'identifiant de prêt le plus bas. Les prêts dont le délai de grâce est terminé (sur l'échéance ou un point de contrôle), les prêts en délai de grâce et les prêts FallbackPending sont listés par identifiant, chacun une seule fois sous son étape la plus grave ; les prêts dont les échéances n'ont pas pu être lues sont comptés. Les intérêts sont exclus. La carte n'utilise que la lecture de la liste elle-même et signale un parcours partiel. Une échéance sur une ligne à principal NFT est la clôture d'une location (`rental-close`), jamais un remboursement : une location se clôt sur son loyer payé d'avance, donc le résumé la nomme comme les lignes.

<a id="position"></a>

### Position : comment un prêt est lu

La page lit `getLoanDetails(loanId)` et le détenteur des NFT de position du prêteur et de l'emprunteur (`ownerOf` sur le contrat PositionNFT qu'enregistre le déploiement, ou sur le Diamond lui-même pour un déploiement antérieur à #3205) ; le rôle est le jeton que le wallet détient maintenant. Pour un prêt en cours (Active ou FallbackPending), elle lit `getLoanDeadlines` (échéance de la période en cours avant crédit de pause, qu'une prolongation ou une reprise par un autre emprunteur réécrit, crédit de pause, échéance, fin du délai de grâce), `previewPeriodicSettle` avec `getPeriodicInterestEnabled` quand le prêt a un calendrier, `isLoanDefaultable` (+ `paused`, `sequencerHealthy`, `defaultKycAdmission`), `calculateHealthFactor` et `calculateLTV` ; pour tout prêt, `getLoanCollateralLien` et `isSaleVehicleLoan`. Chaque lecture est indépendante : une lecture échouée est affichée comme inconnue, jamais comme zéro, et aucune date n'est calculée à partir de `startTime` et `durationDays`.

Pour un prêt doté d'un prix, elle lit aussi `getInternalMatchConfigBundle`. Quand l'appariement interne est actif, un prêt dont le ratio prêt-valeur va de son seuil jusqu'au seuil plus `externalLiquidationPriorityWindowBps` est réservé à un appariement interne et toute voie de liquidation externe refuse (`InternalMatchOnlyBand`) ; la page indique cette bande. Un `loanInitiationFeeBpsAtInit` de 0 (un prêt ouvert avant que le taux soit conservé) est affiché comme non enregistré, et un `treasuryFeeBpsAtInit` de 0 comme le taux historique de 1 % appliqué au règlement. L'avertissement de remise en nature ne vaut que pour un prêt ERC-20 : une location de NFT n'a pas de garantie, et son défaut met fin à l'usage du locataire, verse le loyer prépayé au prêteur moins la part de la trésorerie et envoie la réserve à la trésorerie, ce que la page indique à la place.

Les taux sont des instantanés du prêt : `treasuryFeeBpsAtInit`, `loanInitiationFeeBpsAtInit` (aucun pour un véhicule de vente) et `liquidationLtvBpsAtInit`. Un prêt dont un côté est illiquide (`principalLiquidity` ou `collateralLiquidity`) n'a pas de lecture fondée sur un prix : le protocole refuse `calculateHealthFactor` et `calculateLTV` pour lui, et la page le dit au lieu d'afficher inconnu. `principal` est ce qui reste dû (un remboursement partiel le réduit), et `interestRateBps` et `collateralAmount` peuvent aussi changer, donc les conditions sont affichées telles qu'elles sont maintenant ; un prêt terminé sans capital à son registre indique si un appariement interne l'a couvert, et sinon seulement qu'aucun n'est enregistré ; une location de NFT affiche son loyer par jour (`principal`, en `prepayAsset`) et si un retour anticipé facture encore chaque jour restant (`useFullTermInterest`). Avec `getPeriodicInterestEnabled` à false, la page indique qu'aucune garantie n'est vendue à une échéance. `collateralLiquidity` Illiquid sur un prêt en cours ajoute l'avertissement en nature : un défaut transfère la garantie au prêteur sans vente. Sa première transaction est le remboursement intégral, ci-dessous.

<a id="repay"></a>

### Rembourser intégralement : comment le montant est fixé

L'action suit une règle : `repayLoan` est proposé pour un prêt ERC-20 Active ou FallbackPending à tout portefeuille qui n'est ni `loan.lender` ni `ownerOf(lenderTokenId)` (`LenderCannotRepayOwnLoan`), suspendu après la fin effective du délai de grâce sur un prêt Active (`RepaymentPastGracePeriod`) et tant que la route ouverte de la position emprunteur vaut `SwapToRepayIntent` (`positionRoute(borrowerTokenId)` sur le Diamond, ou `positionLock(borrowerTokenId)` pour un déploiement antérieur à #3205). Une mise en vente par le prêteur, une demande de refinancement et la pause globale ne le suspendent pas. Les locations ne sont pas encore proposées ici.

L'examen lit `calculateRepaymentAmount(loanId)` au dernier bloc, puis à nouveau avec l'heure du bloc remplacée par `min(now + 30 minutes, fin du délai de grâce)` ; la même requête lit l'heure de bloc sous laquelle elle s'est exécutée, et une connexion qui a ignoré le remplacement est écartée. L'approbation est exactement le second chiffre, l'appel est simulé avant l'ouverture du portefeuille et, après le reçu, le statut dans lequel le remboursement a laissé le prêt est lu dans son journal `LoanRepaid` (pas au bloc, où une réclamation ultérieure peut déjà l'avoir soldé), le paiement est mesuré à partir des journaux `Transfer` et l'allowance est remise à sa valeur antérieure quand elle indique l'approbation moins le paiement. Une allowance supérieure à ce chiffre, illimitée comprise, est elle aussi ramenée à ce chiffre, car `repayLoan(loanId)` ne fixe ni maximum ni échéance ; la remise en état rétablit ensuite la valeur plus élevée.

Pendant le délai de grâce (`maturity ≤ now ≤ graceEnd` d'après `getLoanDeadlines`), les vérifications du remboursement total et partiel décomptent jusqu'à `graceEnd` sur l'horloge de la chaîne, estimée comme l'horodatage de bloc lu plus les secondes écoulées depuis. `repayLoan` et `repayPartial` échouent avec `RepaymentPastGracePeriod` dès que `block.timestamp > graceEnd`, et `triggerDefault` est alors ouvert à tous ; un remboursement tardif fait donc la course avec un défaut. À une heure ou moins, l'horloge dit d'envoyer maintenant. Elle ne fait qu'énoncer : le verdict relu avant l'envoi est le verrou, et une pause repousse `graceEnd`. Le bourrage de blocs pour retenir un remboursement au-delà du délai est consigné comme un risque faible accepté dans le modèle de menaces.

<a id="interest-schedule"></a>

### Échéancier des intérêts : comment il est lu

Pour un prêt ERC-20 actif avec une cadence, la carte lit `previewPeriodicSettle(loanId)` (cadence, `periodEndAt`, `graceEndsAt`, `expected`, `paidByBorrower`, `shortfall`, `canSettleNow`), `getPeriodicInterestEnabled()` et `paused()`, et indique l'heure du bloc lu. `expected` correspond à une période entière au `principal` et à l'`interestRateBps` actuels ; `periodEndAt` inclut le crédit de pause du prêt.

Le `canSettleNow` de l'aperçu ignore l'interrupteur et la pause, donc la carte les combine dans l'ordre propre à `settlePeriodicInterest` : coupé (`PeriodicInterestDisabled`), en pause (`whenNotPaused`), puis le temps de la période (`PeriodicSettleNotDue` avant `graceEndsAt`). Une vente n'est annoncée que lorsque l'interrupteur est activé et que le protocole n'est pas en pause ; un interrupteur ou une pause non lus sont indiqués comme inconnus. Avec un manque nul, le règlement ne fait qu'avancer l'échéance. L'armement de `PERIODIC_SETTLE` côté keeper n'est pas transmis à l'app, donc la carte indique que le règlement est ouvert à tous et que l'état du keeper n'est pas connu.

<a id="partial-repay"></a>

### Rembourser une partie d'un prêt : comment le montant est calculé

`repayPartial(loanId, amount)` prend `amount` de principal plus les intérêts courus depuis `interestAccrualStart` (nets de tout crédit périodique). Il paie les intérêts d'abord aux détenteurs précédents à qui des intérêts d'avant une vente restent dus (`paySellersFirst`), puis le détenteur actuel de la position prêteur, part de la trésorerie déduite (pour un détenteur que le protocole doit geler, sa part est déposée bloquée dans le coffre du prêteur, `freezeOrPayActiveLenderFromPayer`) ; il réduit `principal`, redémarre l'horloge des intérêts et crédite la période en cours ; l'échéance ne bouge jamais. Il refuse après la fin du délai de grâce, en dessous de `principal × minPartialBps / 10000` (`getAssetRiskParams`), à hauteur de tout le principal ou au-delà (`PartialWouldRetireFullPrincipal`), en présence d'un engagement d'intention ou d'une demande de refinancement actifs et, pour un prêt liquide, si le facteur de santé se dégraderait.

Aucune vue ne renvoie les intérêts du paiement partiel avant l'appel (#3299) ; la vérification utilise donc `calculateRepaymentAmount` moins `principal`, lu maintenant et à un moment un peu plus tard. C'est exact pour un prêt au prorata jusqu'à l'échéance ; avec `useFullTermInterest` cela inclut le minimum de la durée restante et, après l'échéance, des pénalités de retard, d'où l'affichage « au plus ». L'autorisation est exactement la part plus ce chiffre supérieur. La carte finale mesure le `newPrincipal` du journal `PartialRepaid` du paiement lui-même (pas `principal` au bloc, qu'une transaction ultérieure dans ce bloc peut modifier), la sortie du portefeuille et ensuite `previewPeriodicSettle`. La revue ne refuse le portefeuille que s'il lui manque la part, ou la part plus un intérêt exact ; quand seul le montant maximal dépasse son solde, la simulation faite juste avant l'envoi du paiement tranche.

<a id="add-collateral"></a>

### Ajouter de la garantie : ce qui est vérifié

`addCollateral(loanId, amount)` prélève exactement `amount` du jeton de garantie du prêt chez l'appelant vers le coffre de l'emprunteur, relève `collateralAmount` et le privilège sur la garantie, et émet `CollateralAdded` avec le nouveau facteur de santé et le nouveau LTV. Il refuse un engagement swap-to-repay en cours, un appelant autre que `ownerOf(borrowerTokenId)`, un prêt ni Active ni FallbackPending, une location, un actif de garantie en pause (`isAssetPaused`) et une garantie que `checkLiquidity` ne déclare pas Liquid. Il ne porte pas `whenNotPaused`. Le dépôt va dans le coffre du `loan.borrower` enregistré : un prêt Active consolide d'abord une position transférée sur le détenteur (`consolidateToHolder`), c'est donc le coffre du détenteur ; un prêt FallbackPending n'est consolidé qu'une fois guéri, la revue nomme donc le coffre enregistré. Les jetons ajoutés comptent dans `collateralAmount`, que la liquidation et le défaut consomment, et la revue le dit.

L'application lit ces entrées, les deux vérifications de l'actif en direct plutôt que depuis la classe d'ouverture du prêt, et la simulation donne le dernier mot au protocole. Aucune vue ne renvoie le facteur de santé après un complément : l'examen indique donc `calculateHealthFactor` et `calculateLTV` maintenant, et la carte finale lit les nouveaux chiffres dans le journal `CollateralAdded` de la transaction. Sur un prêt FallbackPending, le complément le rétablit quand le nouveau facteur de santé atteint le minimum du prêt et que le LTV reste dans son plafond d'ouverture ; la carte finale cherche `LoanCuredFromFallback`. Une approbation existante égale ou supérieure au montant est laissée telle quelle, puisque le prélèvement est exactement le montant ; une plus petite est portée exactement au montant et remise en état si le complément n'aboutit pas.

<a id="take-back-collateral"></a>

### Reprendre de la garantie : ce qui est vérifié

`partialWithdrawCollateral(loanId, amount)` envoie `amount` de la garantie du coffre de l'emprunteur vers le portefeuille de l'appelant, réduit `collateralAmount` et le nantissement, et émet `PartialCollateralWithdrawn` avec le nouveau facteur de santé et LTV. Elle porte `whenNotPaused` et refuse, dans l'ordre : un appelant sanctionné, un commit swap-to-repay actif, une demande de refinancement active (`RefinanceRequestOpen`), une mise en vente liée (`SaleListingActive`), un appelant autre que `ownerOf(borrowerTokenId)`, un prêt qui n'est pas Active, un montant supérieur à la garantie, une garantie que `checkLiquidity` ne déclare pas Liquid, et un résultat sous le facteur de santé minimal ou au-dessus du plafond de LTV à l'ouverture.

Le formulaire vérifie le montant contre `calculateMaxWithdrawable`, qui vaut zéro pour un prêt non Active ou une garantie illiquide, et qui baisse à mesure que les intérêts courent. Aucune vue n'expose une mise en vente liée : la revue simule donc le retrait et nomme ce refus ; l'envoi le simule à nouveau. La carte finale lit la garantie restante et les nouveaux chiffres dans le log `PartialCollateralWithdrawn` de la transaction, et le montant reçu dans le `Transfer` du jeton vers le portefeuille. Pour un appelant en mode compte protégé, la porte de paiement du coffre met le retrait en file (`PayoutQueued`) pendant le délai du compte au lieu de le payer ; la revue lit donc `getProtectedAccount` et la carte de fin lit ce log.

<a id="collect-a-payout"></a>

### Encaisser un versement : ce qui est vérifié

`claimAsLender(loanId)` et `claimAsBorrower(loanId)` portent `whenNotPaused` et paient depuis le coffre de la partie enregistrée pour ce côté (`loan.lender` / `loan.borrower`) à l'appelant, qui doit être `ownerOf` du jeton de position de ce côté. Le prêteur peut réclamer sur un prêt Repaid, Defaulted, FallbackPending ou InternalMatched ; l'emprunteur seulement sur Repaid, Defaulted ou InternalMatched. La réclamation du prêteur refuse une ligne déjà réclamée (`AlreadyClaimed`) avant la vérification du détenteur et un côté sans rien d'ouvert (`NothingToClaim`) après ; une ligne qu'une clôture forcée a enregistrée à zéro s'exécute quand même et ferme la position. La réclamation de l'emprunteur ne refuse que si sa ligne de garantie et sa ligne d'excédent sont toutes deux vides ou réclamées, et paie chacune selon son propre indicateur, avec la garantie encore sous le privilège du prêt dans un autre jeton à côté.

L'examen lit `getClaimable` (la ligne du prêteur déjà nette des anciens vendeurs, avec `getSellersShareOfLenderClaim` à côté), `getBorrowerSurplusClaim` et `getLoanCollateralLien`, et simule la réclamation, ce qui applique aussi les contrôles de sanctions. La liste suit le jeton de position : `getUserDashboardClaimables` liste les réclamations de la partie enregistrée, donc une ligne listée n'est gardée que tant que le portefeuille détient ce côté, et pour une position détenue sur un prêt terminé reçue de quelqu'un d'autre la réclamation est lue directement. La carte de fin lit `LenderFundsClaimed` / `BorrowerFundsClaimed`, `BorrowerSurplusClaimed` et `LoanSettled`, ainsi que les transferts du jeton vers le portefeuille ; pour un appelant en mode de compte protégé elle lit `PayoutQueued` (le coffre du compte lui-même), `PayoutHeldInVault` (un compte verrouillé ou une file pleine) ou `PaymentCreditedToVault` (le coffre d'une autre partie). Sur un prêt FallbackPending, la réclamation du prêteur peut lancer un appariement interne qui réécrit la ligne, donc la carte de fin compare les transferts à l'enregistrement du protocole lui-même.

<a id="claim-everything"></a>

### Tout réclamer : ce qui est vérifié

Le lot passe par `multicall(calls)`, qui exécute chaque appel par `delegatecall` dans le protocole lui-même, si bien que `msg.sender` reste votre portefeuille et que chaque appel vérifie ses propres règles. Il accepte au plus 30 appels, et l'app envoie chacun avec `allowFailure`, de sorte qu'un appel refusé revient seul et que le lot continue. Les appels sont `claimAsLender` / `claimAsBorrower(loanId)` ; `claimInteractionRewardsTo(Vault)`, qui libère aussi une récompense retenue, ou `claimHeldInteractionRewards(Vault)` lorsque l'aperçu des récompenses ne peut pas aboutir mais que `getRewardSanctionsStatus` indique Deliver ; `withdrawLenderIntentCapital(account, lendingAsset, collateralAsset, amount)` pour le `availableCapital` de chaque intention issue de `getLenderIntentsByOwner` ; `withdrawVPFIFromVault(amount)` pour le `freeHolding` de VPFI ; et `withdrawSalary(streamId)` pour chaque flux de `getPayrollStream` dont le bénéficiaire est le portefeuille, dimensionné par `getWithdrawableSalary`. Une réclamation de prêteur sur un prêt FallbackPending est laissée de côté, car son appariement au moment de la réclamation décide de ce qu'elle paie. La revue exécute le lot en essai et lit `success` et les données de revert de chaque appel, écarte un appel refusé avec son erreur décodée, et le réexécute à l'envoi. La carte finale lit l'événement propre à chaque appel (`LenderFundsClaimed` / `BorrowerFundsClaimed`, `InteractionRewardsClaimed` with `RewardDeliveredToVault`, `LenderIntentCapitalWithdrawn`, `VPFIWithdrawnFromVault`, `SalaryWithdrawn`) ; un appel sans événement a été ignoré. Les transferts de jetons vers le portefeuille, et `PayoutQueued` / `PayoutHeldInVault` / `PaymentCreditedToVault` en mode protégé, sont additionnés par jeton sur les appels encaissés. La pause (`whenNotPaused` sur chaque appel) et un portefeuille signalé arrêtent le lot avant la signature.

<a id="payout-queue"></a>

### La file de versements : ce qui est vérifié

La liste est `getPendingPayoutIds(account)`, avec `getPendingPayout(id)` et `requestCode(id)` par ligne ; le code est rendu en six caractères base32 par le même moteur partagé que les alertes, et les lignes sont triées par `releaseAt` par rapport à l'horodatage du dernier bloc, non à l'horloge du navigateur. `releasePayout(id)` est sans permission et refusé pendant une pause jusqu'à `isEscapeOpen()`. Une ligne en file dont le destinataire n'est ni le gestionnaire (le compte, ou son contrôleur une fois retiré) ni dans `getAllowlist` est annulée au lieu d'être payée, avant le contrôle du temps ; sinon la ligne doit être due, le compte déverrouillé (`ProtectedVaultLocked`) et, tant que `requireCosign` est actif, cosignée (`CosignRequired`), et le destinataire est de nouveau contrôlé. `cancelPayout(id)` revient au gestionnaire ou à un signataire (`NotManagerOrSigner`), fonctionne pendant une pause et crédite le registre de dépôt afin que l'actif puisse être retiré de nouveau. `cosignPayout(id)` revient à un signataire de `getProtectedSigners` (`NotSigner`) ; l'application ne le propose que tant que le compte l'exige et que la ligne n'est pas encore cosignée. Chaque action est simulée dans l'examen et de nouveau à l'envoi. La carte de fin lit `PayoutReleased` (le montant et le `delivered` mesuré par le protocole), `PayoutCancelled` et `PayoutCosigned` pour cet id. Que le passage `protectedAccount` du keeper libère les lignes dues est la réponse du service de capacités, inconnue par défaut. Un verrouillage annule toutes les lignes en file.

<a id="seller-interest"></a>

### Les intérêts d'une position vendue : ce qui est vérifié

Une vente enregistre les intérêts gagnés et impayés du vendeur comme une créance : `getInterestLedger(loanId)` liste les créances ouvertes, la plus ancienne d'abord, chacune avec son montant brut. `claimAsSeller(loanId)` porte `whenNotPaused` et le contrôle des sanctions. Sur un prêt Repaid, Defaulted, Settled ou InternalMatched avec des créances ouvertes, il répartit d'abord la récupération du prêteur (`getSellersShareOfLenderClaim`), paie chaque créance jusqu'à son montant net (brut moins la part `treasuryFeeBpsAtInit` du prêt, arrondi vers le bas ; le 1 % historique là où le prêt n'en a enregistré aucune) et les ferme toutes ; un prêt FallbackPending ne répartit pas. Il retire ensuite `getSellerInterestHeld(loanId, seller, asset)` pour le jeton du principal et, s'il diffère, pour le jeton de la créance du prêteur, du coffre du vendeur vers son portefeuille, et refuse avec `NothingToClaimAsSeller` quand c'est zéro. L'app liste les prêts à partir de l'activité de l'index classée sous le portefeuille en tant que vendeur (`SellerInterestClaimRecorded`, `SellerInterestPaid`, `SellerInterestClaimClosed`, `SellerInterestWithdrawn`) ; la recherche par numéro lit la chaîne seule. Dans le jeton du principal, la revue déduit exactement la part du portefeuille de la répartition ; dans un autre jeton, la répartition se fait en valeur et est indiquée comme décidée à l'exécution. Le retrait est simulé dans la revue puis à l'envoi. La carte finale lit `SellerInterestClaimClosed` (payé, crédité, payé en entier) et `SellerInterestWithdrawn`, avec `PayoutQueued` ou `PayoutHeldInVault` là où le mode protégé a mis le paiement en file ou l'a conservé.

<a id="frozen-proceeds"></a>

### Paiements gelés : ce qui est vérifié

L'app lit `getSanctionsOracle` (zéro signifie aucun contrôle sur cette chaîne), `sanctionsStatus(wallet)` (Clean, Flagged, ou Unavailable quand le contrôle revert) et `isSanctionsConfirmedFlagged(wallet)`, le registre que `refreshSanctionsFlag` synchronise à partir d'une lecture définitive. Flagged, ou Unavailable avec le portefeuille enregistré, se lit comme gelé ; Unavailable sans enregistrement, non. `claimAsLender` et `claimAsBorrower` contrôlent l'appelant après `whenNotPaused` et laissent passer une panne ; un côté dont le protocole a gelé le paiement pour une partie enregistrée est libéré en fail-closed, avec un revert `SanctionedAddress` ou `SanctionsOracleUnavailable` tant que cette partie ne lit pas Clean, quel que soit alors le détenteur de la position. Le protocole n'offre aucune vue de cette partie enregistrée : l'app s'appuie donc sur la simulation et formule son refus avec les mêmes mots. `claimAsSeller` refuse un vendeur signalé, et un vendeur enregistré pendant une panne. Tant qu'un prêt est en cours, une part du prêteur mise de côté pour un détenteur signalé s'ajoute à `heldForLender` dans `getClaimable(loanId, true)`, réservée dans le coffre du prêteur enregistré jusqu'à ce que le claim du prêteur la paie. Le remboursement reste ouvert pour un emprunteur signalé ; l'ajout de garantie, non.

<a id="extension-reserves"></a>

### Réserves de prolongation : ce qui est vérifié

`fundExtendReserve(loanId, amount)` dépose le jeton de principal du prêt depuis le portefeuille du détenteur de la position d'emprunteur dans son propre coffre et le réserve pour ce prêt. Elle porte `whenNotPaused` et le contrôle des sanctions, et est refusée sauf si le prêt est Active, un prêt ERC-20, sans cadence périodique. `getExtendFunding(loanId, holder)` renvoie le jeton, `reserved`, l'autre solde libre du détenteur et ce qu'une prolongation facturerait maintenant et à la fin de la fenêtre ; une prolongation ne prélève que le coffre du détenteur actuel, la réserve d'abord. `withdrawExtendReserve(account, loanId, amount)` porte `whenNotPaused`, exige que l'appelant soit le gestionnaire du compte (son propre portefeuille, ou son contrôleur après un remplacement), contrôle l'appelant (ouvert en cas de panne) et revient avec `ExtendReserveInsufficient` au-delà de ce qui est réservé ; elle est ouverte quel que soit l'état du prêt. L'app liste les prêts à partir de l'activité de l'index classée sous le portefeuille (`ExtendReserveFunded`, `ExtendReserveWithdrawn`, `ExtendChargeDrawn`) ; la recherche par numéro lit la chaîne seule. Elle retire toute la réserve lue par la revue, exécute l'appel en essai dans la revue puis à l'envoi, et la carte finale lit `ExtendReserveWithdrawn` (le montant, et ce qui reste réservé), avec `PayoutQueued` ou `PayoutHeldInVault` là où le mode protégé a mis le paiement en file ou l'a gardé.

<a id="vault-holdings"></a>

### Votre coffre : ce qui est lu

Le coffre est `VaultFactoryFacet.getUserVaultAddress(wallet)` ; `getOrCreateUserVault(wallet)` le crée (contrôle des sanctions de niveau 1, sans verrou de pause), et la carte de fin lit `UserVaultCreated`. Par actif, à un même bloc : le solde propre du coffre (ERC-20 `balanceOf`, ERC-721 `ownerOf`, ERC-1155 `balanceOf`), `getTrackedHolding`, `withdrawableNow` et `untrackedHolding`. « Dans votre coffre » est le plus petit du solde et de l'avoir suivi ; « Libre à retirer maintenant » est `withdrawableNow` tel que renvoyé (l'avoir de dépôt, plafonné par `freeHolding` : le suivi moins les nantissements moins la réservation du mode protégé) ; « Retenu par vos positions » est le chiffre compté moins celui-ci. Les actifs viennent de `getDepositoryAssets(wallet, offset, limit)`, lu par pages jusqu'au total renvoyé (une page vide avant est lue comme incomplète), le standard de chaque contrat listé étant lu par ERC-165, plus les jambes (actif prêté, garantie, jeton des frais de location prépayés) de chaque prêt de `getUserLoansPaginated(wallet)` et de chaque prêt dont le portefeuille détient la position, chacun lu par `getLoanDetails` au même bloc, et celles de chaque offre qu'il a créée, depuis `getUserOffersPaginated(wallet)`, chacune lue par `getOffer` (le dépôt d'une offre reste dans le vault de son créateur même après le transfert de son NFT de position). S'y ajoute l'actif prêté de chaque offre permanente de `getLenderIntentsByOwner(wallet)`, y compris les offres annulées : en financer une place cet actif dans le vault sans entrée dans le registre des dépôts. L'enregistrement ne garde pas d'identifiants de jetons NFT, donc chaque collection NFT déposée est nommée dans une note, et seul un jeton qu'un prêt ou une offre nomme est listé avec ses chiffres. La poussière est un chiffre compté supérieur à zéro et inférieur à 1e-11 d'un jeton entier.

<a id="vault-deposit"></a>

### Déposer dans votre coffre

Le dépôt est `VaultDepositoryFacet.depositToVault(kind, asset, tokenId, amount)` : kind 0 est ERC-20, 1 ERC-721, 2 ERC-1155 ; l'identifiant est 0 pour un ERC-20 et le montant 1 pour un ERC-721. Il est `whenNotPaused`, contrôle l'appelant (Tier-1) et refuse un portefeuille retiré par un remplacement (`requireManager`). La revue lit, à un même bloc, `getUserVaultAddress`, `paused`, la posture de sanctions, `getProtectedAccount(wallet)` ainsi que le solde et l'approbation du portefeuille ; une pause, un contrôle ou un retrait non lus sont indiqués et l'exécution à blanc tranche. L'approbation est un `approve` ERC-20 exact (deux étapes quand le jeton doit d'abord être remis à zéro), `approve(diamond, tokenId)` pour un ERC-721, ou `setApprovalForAll(diamond, true)` pour un ERC-1155, retirée après le dépôt sauf si elle existait déjà. L'exécution à blanc a lieu après l'approbation ; un ERC-20 est prélevé avec un contrôle d'arrivée exacte (`LibDelivery.pullExact`), donc un jeton à frais de transfert échoue. La carte finale lit `VaultDeposited(account, asset, kind, tokenId, amount)` et les journaux de transfert du jeton vers le coffre. Il n'existe pas de voie permit pour ce dépôt. De `getProtectedAccount(wallet)`, la revue garde aussi `enabled`, `locked`, `delaySeconds` et `requireCosign`, et le reçu indique comment le dépôt peut ressortir : aussitôt, après le délai (avec un signataire secondaire là où il est exigé), ou pas tant que le compte est verrouillé, ce que `depositToVault` ne refuse pas. La dernière vérification avant la signature relit `hasAcceptedCurrentTerms` et refuse une version non acceptée.

<a id="vault-withdraw"></a>

### Retirer de votre coffre

Le retrait est `VaultDepositoryFacet.withdrawFromVault(account, kind, asset, tokenId, amount, recipient)`, avec `account` et `recipient` tous deux égaux au portefeuille connecté. Il est borné par `withdrawableNow(account, kind, asset, tokenId)` (sinon `AmountExceedsFree`), vérifie `requireManager(account)`, contrôle l'appelant (Tier-1) et le destinataire, et est refusé pendant une pause sauf si le compte est protégé et que `isEscapeOpen` est vrai. La revue lit, à un seul bloc, `getUserVaultAddress`, `paused`, `isEscapeOpen`, l'état des sanctions, `getProtectedAccount(wallet)` et `withdrawableNow`, puis exécute l'appel à blanc. Sans le mode protégé, les routes du coffre paient aussitôt le portefeuille ; avec lui, `LibProtectedAccount.queuePayout` met le paiement en file pour `delaySeconds` et refuse `ProtectedVaultLocked`, `RecipientNotAllowlisted` et `TooManyPendingRows`. La carte de fin lit `VaultWithdrawRequested(account, asset, kind, tokenId, amount, recipient, queued)`, `PayoutQueued` et les propres journaux de transfert du jeton du coffre vers le portefeuille. Une collection que le registre de dépôts nomme sans identifiants se retire en saisissant l'identifiant du jeton ; la limite du formulaire est `withdrawableNow` pour ce jeton, relue à chaque bloc.

<a id="vault-safety"></a>

### Sécurité du compte

La carte lit, dans un même bloc, `getProtectedAccount(wallet)`, `getProtectedDelayBounds()`, `paused`, l'état de sanctions et `getPendingPayoutIds(wallet)` ; un revert `FunctionDoesNotExist` se lit comme indisponible. Activer est `enableProtectedMode(delaySeconds, protectNfts)` : immédiat, refusé pendant une pause ou si le mode est déjà actif, le délai dans les bornes (de deux à cinq jours), et il crée le coffre s'il n'existe pas. Verrouiller maintenant est `lockVault(wallet)` : ouvert pendant une pause, il annule chaque ligne en file (`PayoutCancelled`), abandonne chaque changement en attente et annule un remplacement proposé par le gestionnaire. Demander le déverrouillage est `requestUnlock(wallet)`, refusé pendant une pause ou avant `cooldownUntil`, et fixe `pendingUnlockAt` à maintenant plus `delaySeconds`. Appliquer les changements échus est `finalizeSettingChanges(wallet)`, qui applique d'un coup chaque changement échu ; la désactivation attend qu'aucune ligne ne reste ouverte (`PendingRowsExist`). Chaque action est simulée à la revue puis de nouveau avant l'ouverture du portefeuille, et la carte finale lit `ProtectedModeEnabled`, `VaultLocked`, `PayoutCancelled`, `SettingChangeRequested` et `SettingChangeApplied` dans les journaux du Diamond.

<a id="vault-escape"></a>

### Quand le protocole est en pause

L'avis lit, dans un même bloc, `paused`, `VaultPayoutFacet.isEscapeOpen`, `escapeOpensAt` (le début de la pause manuelle plus la période de secours avec laquelle elle a commencé ; zéro si aucune n'est en vigueur ou si le Diamond n'a jamais été lancé) et `getProtectedAccount(wallet)`, et décompte selon l'heure du bloc. En pause avec la voie fermée, `withdrawFromVault` revient sur `EnforcedPause` et la revue dit que la pause l'arrête. Dès que `isEscapeOpen` est vrai, un compte protégé utilise toujours `withdrawFromVault`, qui continue de mettre en file ; le retrait de tout autre portefeuille appelle `escapeWithdraw(kind, asset, tokenId, amount)`, qui refuse un compte protégé (`EscapeNotForProtected`), refuse un destinataire interdit, est borné par le solde de dépôt propre du portefeuille et le chiffre libre, et paie l'appelant. La carte finale lit `EscapeWithdrawal(account, asset, tokenId, amount)` et le transfert du jeton lui-même du coffre vers le portefeuille. Si la pause, la voie ou, voie ouverte, le mode ne peuvent être lus, aucun retrait n'est envoyé.

<a id="protection-addresses"></a>

### Adresses enregistrées

Le carnet est conservé dans `localStorage` par identifiant de chaîne et portefeuille, jamais on-chain. Un portefeuille y entre après avoir signé `AddressControl{account, destination, purpose, nonce, issuedAt}` dans le domaine `{name: 'Vaipakam Address Check', version: '1', chainId, verifyingContract: Diamond}`, avec un nonce aléatoire de 32 octets et une durée de sept jours. La demande voyage sous la forme `/protection?prove=<code>`. La page de signature refuse un réseau ou un Diamond que l'application ne sert pas et une demande expirée, et ne signe que si le compte connecté est cette adresse sur cette chaîne. La réponse collée est vérifiée par `verifyTypedData` via la propre connexion de lecture du portefeuille connecté, de sorte qu'un portefeuille intelligent répond par ERC-1271, et n'est enregistrée que si elle répond à cette même demande. Le champ d'adresse affiche l'adresse complète avec ses premiers et derniers caractères détachés, refuse une somme de contrôle EIP-55 invalide et refuse sans dérogation toute adresse dont les trois premiers et trois derniers chiffres hexadécimaux égalent ceux d'une adresse déjà utilisée (la sienne, les entrées enregistrées et en attente, les destinations actives et en attente, les signataires protégés, les keepers approuvés et le keeper du réseau) alors que le reste diffère. Une adresse nouvelle exige une coche explicite, qu'une modification efface.

<a id="protection-destinations"></a>

### Destinations de paiement

La section lit, en un bloc, `getProtectedAccount`, `getAllowlist`, `getPendingAllowlistAdditions` (chaque demande avec son `maturesAt`), `getProtectedSigners`, `paused` et les paiements en file par destinataire tirés de `getPendingPayoutIds`. Une demande est en attente avant `maturesAt`, prête jusqu'à `maturesAt + delay`, expirée ensuite, selon l'heure du bloc plus les secondes écoulées. Les quatre changements sont `addAllowlisted`, `cancelAddAllowlisted`, `finalizeAddAllowlisted` et `removeAllowlisted`, chacun avec `(account, destination)`. Le récapitulatif est lu en un bloc et refuse avant le portefeuille ce que la facet refuserait : une pause ou un verrouillage (pour ajouter et activer), votre propre portefeuille, une adresse déjà active ou en attente, déjà cinq destinations ou cinq demandes, une adresse signalée, une demande pas encore mûre ou expirée. Chaque appel est simulé, revérifié juste avant l'ouverture du portefeuille et mesuré par son propre log `AllowlistAddRequested`, `AllowlistAddCancelled`, `AllowlistAdded` ou `AllowlistRemoved` ; un retrait compte aussi les logs `PayoutCancelled` qu'il a causés.

<a id="my-offers"></a>

### Vos offres

La liste est l'union de `getUserOffersPaginated(wallet)` (l'index par créateur, qui garde un id annulé) et de `getUserPositionOffersPaginated(wallet)` (les offres dont le portefeuille détient le jeton de position), lues par lots d'au plus 250 via `MetricsDashboardFacet.getOffersWithState`, qui répond position par position. Chaque ligne est associée à l'id demandé : une offre annulée sans exécution a son enregistrement supprimé, la vue rapporte donc l'id 0 avec l'état dérivé Annulée, et la ligne n'affiche aucune condition plutôt que des conditions reconstruites. Une offre annulée après une exécution partielle garde son enregistrement avec `accepted` positionné et se lit comme exécutée. Les compteurs des filtres portent sur les lignes lues ; si l'un des index n'a pas pu être lu jusqu'au bout, la page dit que la liste peut être incomplète.

<a id="offer-book"></a>

### Le carnet d'offres

Le carnet lit `GET /offers/active?chainId&limit=50&before=<offerId>` de l'indexeur, la plus récente d'abord par identifiant d'offre, paginé par `nextBefore`. L'indexeur garde `active` une offre échue (l'expiration est paresseuse sur la chaîne), donc une ligne dont le `expiresAt` est passé est marquée expirée. `isSaleVehicle`, `isOffsetVehicle` et `refinanceTargetLoanId` (null = non lu) marquent le type, et `positionFlow.movedSinceOpened` une position liée qui a bougé (#3205). Chaque champ est analysé exactement ; une ligne qui échoue est comptée comme non lue. L'onglet est `assetType` (0 = un prêt ERC-20, sinon une location), le côté `offerType`. La requête est invalidée par le canal push et relue toutes les 60 s tant qu'elle est visible ; une panne de l'index est signalée, jamais un carnet vide. Le carnet n'est demandé qu'une fois un portefeuille connecté sur un réseau pris en charge ; avant cela, la page en demande un.

<a id="offer-detail"></a>

### La page d'une offre

`/offers/:id` lit, à un même bloc, `OfferCancelFacet.getOffer(id)`, `MetricsFacet.getOfferState(id)` et `getOfferLinkedLoanId(id)`, via le portefeuille connecté ; rien n'est lu avant qu'un portefeuille soit connecté. Un créateur nul signifie que l'enregistrement a été supprimé (une annulation sans rien de pourvu) ou jamais écrit ; le protocole ne tient aucun compte des offres, donc la page ne dit pas lequel. Un prêt lié non nul marque une vente de prêt (offre d'emprunteur) ou une compensation (offre de prêteur) ; le `refinanceTargetLoanId` d'une offre d'emprunteur marque une demande de refinancement. La prise exécute le flux partagé `acceptOffer` (`AcceptTerms` signés, approbation exacte, simulation, résultat mesuré) sous sa propre clé de stockage ; l'annulation et le nettoyage exécutent le flux partagé `cancelOffer`. Les locations, la garantie NFT, les ventes de prêt et les compensations renvoient à l'application actuelle.

<a id="offer-cancel"></a>

### Annuler une offre

La vérification lit, dans un même bloc, `getOffer(id)`, `getOffersWithState([id])`, `getOfferLinkedLoanId(id)`, `paused()` et le `getProtectedAccount` du créateur, puis simule `OfferCancelFacet.cancelOffer(id)`. La facette permet au gestionnaire du créateur d'annuler à tout moment, et à n'importe qui une fois `expiresAt` passé ; elle refuse `OfferAlreadyAccepted`, `OfferAlreadyConsumedBySale`, et `CancelCooldownActive` tant qu'une offre avec `amountFilled == 0` a moins de 300 secondes et n'a pas expiré, et elle est `whenNotPaused`. Le retour est chiffré selon les branches de la facette : une offre de prêt ERC-20 rend `(amountMax ou amount) - amountFilled` de l'actif prêté ; une offre de prêt NFT son jeton, ou sa quantité ERC-1155 ; une demande d'emprunt sa garantie inutilisée `(collateralAmountMax ou collateralAmount) - collateralAmountFilled`, ou son NFT, et rien quand `refinanceCarryOver` garde la garantie dans le prêt ; une demande de location `amount × durationDays` plus la marge à `rentalBufferBpsAtCreate`. Une offre liée à un prêt par `getOfferLinkedLoanId`, ou une demande de location dont la marge enregistrée vaut zéro (le protocole prend alors son taux actuel), n'est pas chiffrée avant la signature. Tout retour quitte le coffre du créateur par le retrait de coffre, donc le mode protégé le met en file, ou le garde dans le coffre tant que le compte est verrouillé. Le jeton de position est retiré. La carte finale lit `OfferCanceled(offerId, creator)`, l'enregistrement de paiement du protocole pour le créateur et le transfert propre du jeton vers le créateur.

<a id="risk-access"></a>

### Risk Access : votre niveau de risque

L'interrupteur est `getRiskAccessGateEnabled`. L'étape dont un parcours a besoin est la réponse du protocole lui-même : pour une acceptation, `previewOfferAcceptBlock` (1 = niveau trop bas, 2 = accord sur la paire, 3 = reconnaissance du mode strict, 4 = la paire illiquide que couvrait autrefois la reconnaissance de l'acceptation ; elle bloque comme 2 et un consentement à la paire la lève) une fois que `previewCreatorBlock` montre que le prêteur n'est pas bloqué ; pour une demande, `RiskTierTooLow`, `IlliquidPairNotConsented` ou `MidTierPairNotAcknowledged` issus de la simulation de `createOffer`. L'étape lit dans un seul bloc `pairRequiredRiskLevel` pour la paire (`acceptMidTierAckPair` pour une offre), `getVaultRiskTier`, `getEffectiveRiskTier`, `getVaultRiskTierVersion` face à `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown` et `getRiskTierMutationNonce`, et pour une paire `isPairConsentPending` avec `hasIlliquidPairConsent`, ou `isMidTierAckPending` avec `midTierStrictBlocked`. Un relèvement est `setVaultRiskTierChecked(level, nonce, termsVersion)` au niveau minimal exigé par la paire ; il est donc refusé, sans rien changer, si une autre écriture de niveau ou un changement de conditions est arrivé après la vérification. Une étape de paire est `setIlliquidPairConsent(pair, true)` ou `setMidTierPairAck(pair)`. Un relèvement encore en attente, ou une étape de paire encore en suspens, n'est pas proposé de nouveau. Aucune lecture ne renvoie quand une étape de paire en suspens prend effet ; l'examen indique donc qu'il ne peut pas lire cette heure ; seule la carte de fin de l'étape elle-même la donne, à partir de l'heure du bloc du reçu plus le délai. Le résultat est relu au bloc du reçu.

<a id="terms-gate"></a>

### La demande d'acceptation des Conditions

`getCurrentTos` renvoie la version et le hash du contenu en vigueur sur la chaîne de l'action ; la version 0 signifie aucune, et rien n'est bloqué. Un wallet dont `hasAcceptedCurrentTerms` vaut false est sollicité avant toute nouvelle exposition, et la demande renvoie vers `/terms/v<N>`, la page figée sur la version, dont le texte ne change jamais. Accepter appelle `acceptTerms(version, hash)` une seule fois. Avant l'ouverture du wallet, la paire est relue : une version plus récente remplace celle affichée, et une acceptation faite dans un autre onglet laisse l'action continuer. Une lecture échouée signifie « impossible à confirmer », avec un nouvel essai, jamais « non accepté ». Les sorties ne sont jamais bloquées.

<a id="settings"></a>

### Paramètres

Les paramètres regroupent ce que vous réglez une fois. Le mode et le thème sont conservés dans le stockage de ce navigateur pour ce site, et la langue l'est là ainsi que dans le cookie `vaipakam_lang` partagé entre les sites de la plateforme ; l'attribut de langue de la page reste l'anglais jusqu'à la sortie d'une traduction. La ligne des Conditions lit `getCurrentTos` et l'acceptation du portefeuille sur le réseau connecté : aucune en vigueur, acceptée avec la version et l'empreinte du texte, ou en vigueur et non acceptée, demandée à la première action soumise à condition. Une lecture échouée signifie « impossible de confirmer », avec un nouvel essai, jamais « non acceptée ». L'interrupteur de remise sur les frais est `setVPFIDiscountConsent`, le même parcours que sur l'accueil. Cette version n'embarque aucune capture de diagnostics. Le navigateur conserve aussi les alertes vues, l'enregistrement des canaux d'alerte, l'heure de la dernière demande d'alerte signée, la dernière paire de jetons, les cartes de démarrage fermées et la dernière connexion du connecteur de portefeuille ; jamais une clé ni une signature. Le téléchargement écrit un fichier JSON des enregistrements propres à l'app (les clés commençant par `app.` ou `alpha05.`, et la langue), nomme les adresses de portefeuille sous lesquelles ces enregistrements sont conservés, et compte sans les copier les éléments de session du connecteur de portefeuille et les bases de données de ce site. L'effacement déconnecte d'abord chaque connexion de portefeuille pour que le connecteur ne réécrive pas ses enregistrements, puis supprime le stockage local et par onglet de ce site, efface ses bases de données quand le navigateur peut les lister, et fait expirer le cookie `vaipakam_lang` sur chaque domaine où il peut être posé ; il recharge ensuite la page et montre, pour cet onglet, ce qui a été supprimé et ce que le navigateur a refusé, avec la raison. Il ne réécrit que les marqueurs « déconnecté » du connecteur de portefeuille, pour que le rechargement ne reconnecte pas un portefeuille qui autorise encore ce site ; si le navigateur ne garde pas le rapport au rechargement, la page reste et l'affiche à la place.

L'accès au risque lit en un bloc `getVaultRiskTier`, `getEffectiveRiskTier`, la version des conditions du niveau face à `getCurrentRiskTermsVersion`, `getRiskTierUnlockAt`, `getRiskAccessUnlockCooldown`, `getRiskStrictMode`, `getStrictModeStrictUntil` et `getRiskAccessGateEnabled`. Il indique le niveau qui compte et pourquoi il diffère du niveau choisi : un relèvement encore en attente (avec l'heure à laquelle il compte) ou un changement de conditions (compte comme blue-chip jusqu'à confirmation). Un changement de niveau est `setVaultRiskTierChecked`, avec le compteur de changements et la version des conditions lus, si bien qu'une écriture venue d'ailleurs ou de nouvelles conditions le refusent sans rien changer ; un relèvement attend le délai et n'est jamais reproposé pendant l'attente ; abaisser est immédiat. Le contrôle ne s'applique qu'à l'origination : abaisser ferme les paires au-dessus aux nouvelles offres et demandes (les vôtres encore ouvertes ne peuvent pas être acceptées) et laisse les prêts ouverts intacts. Le mode strict est `setRiskStrictMode` : activé immédiatement ; désactivé, il s'applique encore pendant le délai, et la page indique jusqu'à quand. Sur un réseau dont le contrôle est désactivé, un changement est enregistré et ne compte que si le contrôle est activé. Les accords et reconnaissances par paire restent dans les parcours qui en ont besoin.

Autorisations lit en un bloc l'`allowance(wallet, Diamond)` de chaque ERC-20, l'`allowance(wallet, token, Diamond)` de Permit2 là où il est déployé (une autorisation expirée n'est pas listée), `isApprovedForAll(wallet, Diamond)` pour chaque collection de NFT et `getApproved` pour chaque jeton ERC-721 qu'une position mentionne et que le portefeuille détient encore. Sont vérifiés les actifs suggérés, chaque actif de `getDepositoryAssets`, les branches de chaque prêt de `getUserLoansPaginated` et de chaque offre de `getUserOffersPaginated`, l'actif prêté de chaque offre permanente et tout contrat que vous ajoutez. Une autorisation égale ou supérieure à 2^255 (2^159 via Permit2) est affichée comme illimitée. Le retrait envoie `approve(Diamond, 0)`, l'`approve(token, Diamond, 0, 0)` de Permit2, `setApprovalForAll(Diamond, false)` ou `approve(0x0, tokenId)` ; la ligne est relue avant l'ouverture du portefeuille et au bloc du reçu. Un registre non lu jusqu'au bout, ou un actif qui ne répond pas, est signalé, jamais affiché comme une absence d'autorisation. L'actif de garantie d'une offre permanente est aussi vérifié, et un jeton détenu par le wallet dont `getApproved` ne répond pas compte comme inconnu. Le reçu lit, au même bloc que la ligne, l'autre autorisation du même actif (`isApprovedForAll` pour un jeton, `getApproved` des jetons trouvés pour une collection, l'`allowance` de Permit2 pour un ERC-20, l'`allowance` ERC-20 pour une autorisation Permit2) et indique qu'elle reste en place, ou qu'elle est inconnue ; un changement avant l'ouverture du wallet arrête la signature.

Keepers lit, en un seul bloc, `getKeeperAccess`, `getApprovedKeepers` et `getKeeperActions` pour chaque keeper approuvé (cinq au plus). Les actions sont les bits du protocole. Finaliser la vente d'une position prêteur (0x01), finaliser une clôture anticipée par compensation (0x02), lancer la vente d'une position prêteur (0x04), lancer une clôture anticipée (0x08) et prolonger dans les limites convenues (0x20) n'agissent sur un prêt que si le prêt ou l'offre active aussi ce keeper ; remplir des offres de prêt permanentes qui exigent un keeper (0x40), remettre l'argent remboursé dans des offres permanentes (0x80) et verrouiller un compte protégé (0x100) agissent pour tout le compte dès que l'accès est activé. Le bit 0x10 est retiré et refusé. Les changements envoient `setKeeperAccess`, `approveKeeper`, `setKeeperActions` ou `revokeKeeper` ; un changement qui donne plus à un keeper demande les Conditions si une version est en vigueur, un retrait jamais, et tout changement, retrait compris, est refusé tant que le protocole est en pause. Le keeper de cette app est nommé d'après l'enregistrement de déploiement.

L'app fournit un manifeste web (`/manifest.webmanifest`) avec les quatre raccourcis et une icône adaptable. Dans Paramètres › Installer l'app, le bouton n'apparaît qu'après que le navigateur a déclenché son événement `beforeinstallprompt`, et il ouvre cette invite ; sinon la page nomme le cas (installée, iOS ou non proposée). Une version déployée enregistre `/sw.js`, écrit à partir de la sortie de cette version : il garde une copie d'un fichier haché de `/assets/` de la version la première fois que la page le demande, répond aux demandes suivantes de ce fichier depuis la copie, supprime les magasins des versions précédentes en prenant la main, et ne répond jamais à une navigation, à une requête vers une autre origine ni à un fichier absent de sa liste. Vos données dans ce navigateur comptent et effacent ces magasins.

<a id="rent-review"></a>

### Louer : louer un NFT

L'examen lit l'offre avec `getOffer` (son `rentalBufferBpsAtCreate`), le verdict du protocole et le tarif journalier avec `previewAccept`, et `getRiskConfig` seulement pour une offre qui n'a enregistré aucune marge propre. Le total est `amount × durationDays` plus cette part, arrondi vers le bas comme le protocole l'arrondit, et l'essai à blanc prouve que les deux concordent. La location est `acceptOffer` avec des `AcceptTerms` signés qui nomment le NFT comme la jambe illiquide reconnue et aucune jambe de garantie ; le droit d'usage est relu dans le coffre du propriétaire au bloc du reçu avec `vaultGetNFTUserOf`, ou `vaultGetNFTQuantity` pour un ERC-1155.

<a id="rent-risks"></a>

### Louer : risques

Tu ne possèdes jamais un NFT loué, et ton droit de l'utiliser prend fin avec la location. Le loyer et la marge restent dans ton coffre pour la location et ne peuvent pas être retirés tant qu'elle est ouverte. Une fois tous les jours convenus réglés, ce que n'importe qui peut faire, la location se clôture d'elle-même et tu peux réclamer ta marge. D'ici là, clôture-la toi-même depuis sa page de position. Clôturer pendant le délai de grâce coûte des frais de retard, pris sur la marge ; après ce délai la location fait défaut, le loyer restant dans ton coffre va au propriétaire et la marge au protocole, et rien ne te revient. Avec un loyer sur la durée complète, toute la durée est due même si tu clôtures plus tôt.

<a id="rent-list"></a>

### Louer : proposer votre NFT à la location

Le formulaire lit le standard de la collection avec ERC-165 `supportsInterface` et la durée la plus longue avec `getProtocolConfigBundle`. L'examen lit le jeton avec `ownerOf`, `getApproved` et `isApprovedForAll` (`balanceOf` pour un ERC-1155), la classe du jeton de paiement avec `getAssetPriceStatus` et le test de liquidité, la part de marge avec `getRiskConfig`, le délai de grâce avec `getEffectiveGraceSeconds` et la part du protocole avec `getTreasuryFeeBps`, puis exécute `createOffer` à blanc avec `assetType` 1 ou 2, `amount` et `amountMax` égaux au tarif journalier, tous les champs de garantie et de taux à zéro et `prepayAsset` le jeton de paiement. La publication enregistre `rentalBufferBpsAtCreate` ; le résultat est lu dans le journal `OfferCreated` de la transaction et dans le propre journal `Transfer` (ou `TransferSingle`) du NFT vers le coffre du propriétaire.

<a id="rent-list-risks"></a>

### Louer : risques de la mise en location

Le NFT reste dans ton coffre tant que l'offre est ouverte et tant qu'il est loué, et tu ne peux pas le retirer avant la fin de l'offre ou de la location. Tant que personne ne l'a loué, tu peux annuler l'offre depuis sa page après ses cinq premières minutes. Une fois loué, le locataire détient le droit d'utiliser le NFT jusqu'à la fin de la location, et tu ne peux pas le reprendre plus tôt. Le loyer arrive dans ton coffre, moins la part du protocole, à mesure que chaque jour écoulé est réglé ; n'importe qui peut le régler. Une fois tous les jours convenus réglés, la location se clôture d'elle-même et le locataire peut réclamer la marge. Avant cela, le locataire peut la clôturer, ou après le délai de grâce n'importe qui peut la clôturer comme défaut. Si le locataire la clôture, tu peux réclamer le loyer pas encore réglé et d'éventuels frais de retard, moins la part du protocole, et le reste de la marge revient au locataire. En cas de défaut, tu peux réclamer le loyer restant, moins cette part, et la marge va au protocole. Une pause arrête le règlement quotidien et repousse les dates des frais de retard et du défaut, mais n'allonge jamais l'usage du locataire. Une offre expirée garde le NFT dans ton coffre jusqu'à sa clôture.

<a id="rent-request"></a>

### Louer : demander à louer un NFT

Le formulaire lit le standard de la collection avec ERC-165 `supportsInterface` et la durée la plus longue dans `getProtocolConfigBundle`. La vérification lit le détenteur du jeton avec `ownerOf` (un ERC-1155 n'a pas de liste de détenteurs), la classe du jeton de paiement dans `getAssetPriceStatus` et le contrôle de liquidité, le `balanceOf` et l'`allowance` du portefeuille pour le jeton de paiement, la part de marge dans `getRiskConfig` et le délai de grâce dans `getEffectiveGraceSeconds`, puis simule `createOffer` avec `offerType` 1, `assetType` 1 ou 2, `amount` et `amountMax` tous deux égaux au tarif journalier, tous les champs de garantie et de taux à zéro et `prepayAsset` égal au jeton de paiement. La publication enregistre `rentalBufferBpsAtCreate` et prélève le tarif journalier multiplié par la durée plus cette part vers le coffre du locataire ; le résultat se lit dans le journal `OfferCreated` de la transaction et le journal `Transfer` du jeton de paiement vers le coffre.

<a id="rent-request-risks"></a>

### Louer : risques d'une demande de location

Le loyer et la marge restent dans ton coffre tant que la demande est ouverte, et tu ne peux pas les retirer avant de l'annuler ou qu'elle prenne fin. Tant qu'aucun propriétaire ne l'a acceptée, tu peux annuler la demande depuis sa page après ses cinq premières minutes, et ils reviennent dans ton portefeuille. Un propriétaire qui l'accepte démarre la location aussitôt à exactement ces conditions : tu détiens le droit d'utiliser le NFT, jamais le NFT lui-même. Une fois tous les jours convenus réglés, ce que n'importe qui peut faire, la location se clôt d'elle-même et tu peux réclamer ta marge ; d'ici là, clôture-la depuis sa page de position. Clôturer en retard coûte des frais de retard pris sur la marge, et en cas de défaut le loyer va au propriétaire et la marge au protocole. Une demande expirée laisse le loyer et la marge dans ton coffre jusqu'à ce qu'elle soit fermée. La part de marge est le réglage du protocole au moment où la demande est enregistrée : s'il change après ta vérification, une part plus élevée est refusée si ton portefeuille a approuvé exactement ce montant, et prélevée si une approbation antérieure la couvre ; le résultat indique ce qui a bougé.

<a id="rent-take"></a>

### Louer : accepter la demande d'un locataire

L'examen lit la demande avec `getOffer` (son `rentalBufferBpsAtCreate`), le verdict du protocole dans `previewAccept`, les réglages de risque des deux côtés, le délai de grâce dans `getEffectiveGraceSeconds`, la part du protocole dans `getTreasuryFeeBps`, et `getRiskConfig` seulement pour une demande sans marge enregistrée. `previewAccept` ne vérifie pas qui détient le NFT, donc l'application le lit avec `ownerOf`, `getApproved` et `isApprovedForAll` (`balanceOf` et `isApprovedForAll` pour un ERC-1155). Accepter, c'est `acceptOffer` avec des `AcceptTerms` signés : le protocole fait passer le NFT du portefeuille du propriétaire à son coffre et inscrit le locataire comme son utilisateur jusqu'à la fin de la durée. Le résultat se lit dans les logs de la transaction (la location ouverte depuis cette demande et le `Transfer` ou `TransferSingle` du NFT vers le coffre du propriétaire) et avec `vaultGetNFTUserOf` au bloc du reçu. Chaque jour écoulé est payé par `autoDeductDaily(loanId)`, que n'importe qui peut appeler tant que le protocole n'est pas en pause, dans le coffre de qui détient le NFT de position du propriétaire ; le reste est réclamé à la clôture.

<a id="rent-take-risks"></a>

### Louer : risques de l'acceptation d'une demande

Le NFT reste dans ton coffre pendant toute la location, et tu ne peux pas le retirer tant qu'elle est ouverte. Le locataire détient le droit de l'utiliser jusqu'à la fin de la location, et tu ne peux pas le lui reprendre plus tôt. Les conditions sont celles de la demande : tu ne peux changer ni le tarif journalier, ni la durée, ni la règle de loyer, ni la marge. Le loyer arrive dans ton coffre, moins la part du protocole, à mesure que chaque jour écoulé est réglé ; n'importe qui peut le régler. Une fois tous les jours convenus réglés, la location se clôture d'elle-même et le locataire peut réclamer la marge. Avant cela, le locataire peut la clôturer, ou après le délai de grâce n'importe qui peut la clôturer comme défaut. Si le locataire la clôture, tu peux réclamer le loyer pas encore réglé et d'éventuels frais de retard, moins la part du protocole, et le reste de la marge revient au locataire. En cas de défaut, tu peux réclamer le loyer restant, moins cette part, et la marge va au protocole. Une pause arrête le règlement quotidien et repousse les dates des frais de retard et du défaut, mais n'allonge jamais l'usage du locataire. Une demande qui n'a enregistré aucune marge propre prend le réglage du jour au début de la location.

<a id="rent-close"></a>

### Louer : clôturer une location

La page d'une location en cours te propose, en tant que locataire, Clôturer la location. La clôture paie le loyer dû et d'éventuels frais de retard sur le loyer et la marge que tu as prépayés dans ton propre coffre : rien n'est pris dans ton portefeuille et il n'y a pas d'autorisation. La revue montre le loyer dû si la clôture a lieu maintenant et à un moment un peu plus tard, compté selon la règle du loyer (au prorata : les jours utilisés depuis le début, un jour entamé compté en entier, moins les jours déjà réglés ; durée complète : chaque jour convenu pas encore réglé), les jours déjà réglés, d'éventuels frais de retard, ce qui te revient sous forme de réclamation et ce que reçoit le propriétaire : le loyer et les frais de retard, moins la part du protocole. Si le prépaiement ne couvre pas la clôture, la revue le dit avant l'ouverture de ton portefeuille. Ton portefeuille te demande ensuite une seule fois de clôturer la location, que l'application essaie d'abord en simulation. Ensuite l'application vérifie sur la chaîne que la location est clôturée, la réclamation enregistrée pour toi et la fin de ton usage. Ce qui te revient s'encaisse sur la page Claims.

La revue lit la location avec `getLoanDetails`, ses dates avec `getLoanDeadlines` et les frais de retard avec `calculateRepaymentAmount`, qui pour une location ne compte que ces frais. Le protocole ne publie aucun chiffre pour le loyer : l'application le compte selon la règle qu'applique `repayLoan`, à partir de `startTime`, `lastDeductTime` et `durationDays`. Clôturer, c'est `repayLoan(loanId)`, que seul le locataire peut appeler, avant la fin du délai de grâce. Le résultat se lit dans le journal `LoanRepaid`, dans `getClaimable(loanId, false)` et dans `vaultGetNFTUserOf` au bloc du reçu.

<a id="rent-close-risks"></a>

### Louer : risques de la clôture

La clôture met fin tout de suite à ton droit d'utiliser le NFT, même s'il reste des jours convenus, et ne peut pas être annulée. Le loyer est compté quand la clôture est confirmée : un jour qui commence avant est payé en entier ; avec une durée complète, chaque jour convenu pas encore réglé est payé, aussi tôt que tu clôtures. Après la fin de la durée, des frais de retard sont pris sur ta marge : 1 % du loyer total plus 0,5 % par jour de retard, au plus 5 % et jamais plus que la marge. Après le délai de grâce, le protocole refuse la clôture ; la location finit alors quand ses jours restants sont réglés un à un, ce que n'importe qui peut faire, ou par un défaut, selon ce qui arrive en premier. Le moment ultérieur que montre la revue n'est ni une échéance ni un plafond : une clôture confirmée plus tard est comptée à ce moment-là, donc plus de loyer ou des frais de retard plus élevés peuvent être pris et moins te revient. Ce qui te revient reste dans ton propre coffre sous forme de réclamation jusqu'à ce que tu l'encaisses.

<a id="rewards-vpfi"></a>

### Récompenses : le VPFI dans le coffre

La page lit le jeton avec `getVPFIToken` ; l'adresse zéro signifie que le VPFI n'est pas configuré sur ce réseau. À un seul bloc, elle lit le `balanceOf` du wallet, le coffre dans `getUserVaultAddress`, le VPFI compté dans `getTrackedVPFIBalance`, le montant libre dans `withdrawableNow` et le `balanceOf` du coffre lui-même. Le retenu est le montant compté moins le libre ; le non compté est le solde du coffre au-delà du compté. « Déposer du VPFI » est le `depositToVault` générique du coffre, et « Retirer du VPFI » son `withdrawFromVault` (`escapeWithdraw` tant que le protocole est en pause et que la voie de secours est ouverte, pour un compte hors mode protégé), et non les entrées propres au VPFI : les voies génériques enregistrent le VPFI pour le niveau de la même façon, et elles seules ont la voie de secours. Chaque examen lit `getTrackedVPFIBalance` et `getVPFIDiscountConsent` à son propre bloc, et le résultat est mesuré à partir de la transaction. `isCanonicalVpfiChain` est lu avec eux : seul le réseau d'origine du VPFI calcule le niveau à partir de son propre VPFI compté, et les autres appliquent une copie en cache de ce niveau, donc là-bas la page et chaque reçu indiquent qu'une opération ne change aucun niveau.

<a id="rewards-vpfi-risks"></a>

### Récompenses : risques du déplacement de VPFI

Le niveau n'est pas ton solde du jour. Il est nul tant que ta détention continue actuelle n'a pas atteint le nombre minimal de jours ; il suit ensuite une moyenne de tes soldes de clôture quotidiens pondérée vers les jours récents ; et il est plafonné au niveau le plus bas que tu as eu un jour de ta détention actuelle, avec un regard en arrière de 30 jours au plus. Ce sont deux regards en arrière distincts. Retirer une partie de ton VPFI compté abaisse le solde le plus bas de ce jour, que lit le plafond, et tout retirer fait repartir ta durée de détention. Un complément ne la fait pas repartir. Le VPFI retenu pour un prêt, une offre, une réclamation ou un versement ne peut être retiré qu'une fois libéré. Le retrait d'un compte protégé ne modifie ton VPFI compté et ton niveau qu'au moment où il est libéré, et un retrait annulé ne modifie ni l'un ni l'autre. Le VPFI dans ton coffre n'est pas une garantie. Le protocole ne vend pas de VPFI, n'en donne aucun prix et ne paie rien pour le détenir.

<a id="rewards-tier"></a>

### Récompenses : le niveau de remise sur les frais

À un seul bloc, la carte lit `getVPFIDiscountConsent`, `isCanonicalVpfiChain` et `getEffectiveDiscount`, qui renvoie le niveau et la remise qu'applique le calcul des frais : zéro tant que l'accord est désactivé, plafonnée à 50 %, et sur les autres réseaux la copie envoyée depuis le réseau d'origine. Sur le réseau d'origine, elle lit aussi `getTrackedVPFIDiscountTier`, le niveau que donne le seul VPFI compté, et indique quand le niveau effectif est plus bas. Le protocole ne dit pas quelle règle de détention le retient, et les réglages de ces règles n'ont pas encore de vue de lecture : ni l'un ni l'autre n'est affiché. Le tableau lit `getVpfiTierThresholds`, `getVpfiTierDiscountBps` et `getFeesConfig` à un seul bloc. Les niveaux 1 à 3 commencent à leur seuil, le niveau 4 au-dessus du sien. Chaque frais est le frais de base multiplié par un moins la remise plafonnée, calculé exactement. Le tableau n'est affiché que sur le réseau d'origine, où les niveaux sont fixés.

<a id="rewards-vpfi-sign"></a>

### Récompenses : signer au lieu d'approuver

À son propre bloc, l'examen lit si Permit2 a du code à son adresse canonique, ainsi que l'`allowance` ERC-20 du portefeuille envers Permit2 pour le jeton VPFI. « Signer au lieu d'approuver » n'est proposé que si Permit2 est déployé et que cette allocation couvre le montant ; sinon, Advanced indique lequel des deux manque. Le portefeuille signe le `PermitTransferFrom` de Permit2 pour le jeton VPFI et exactement le montant, avec le Diamond comme dépensier, un nonce aléatoire vérifié inutilisé dans `nonceBitmap`, et une échéance 30 minutes après le dernier bloc. L'application simule `depositVPFIToVaultWithPermit` avec la signature, puis l'envoie ; le protocole refuse un permis pour tout autre jeton. Le résultat est mesuré à partir de `VPFIDepositedToVault`, que cette entrée émet à la place de `VaultDeposited`, et du transfert du jeton vers le coffre. Les deux voies comptent le VPFI pour le niveau de la même façon.
