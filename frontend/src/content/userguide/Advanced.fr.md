# Vaipakam — Guide utilisateur (Mode Avancé)

Explications précises et techniquement exactes de chaque carte de
l'application. Chaque section correspond à une icône d'information
`(i)` à côté du titre d'une carte. En mode **Avancé**, le lien "En
savoir plus →" de chaque info-bulle mène ici. Le mode Basique pointe
à la place vers le guide plus accessible.

Les titres ci-dessous correspondent aux titres des cartes dans
l'application. L'ancre HTML cachée sous chacun d'eux correspond à
l'identifiant de la carte, ce qui permet à l'application d'établir
un lien direct vers le paragraphe exact. Les références croisées
vers `README.md`, `TokenomicsTechSpec.md`, `CLAUDE.md` et les
contrats sont en ligne là où elles sont utiles.

Une note sur la langue : les listes prêteur / emprunteur du **Carnet
d'offres** et le flux **Créer une offre** décrivent des situations
où le prêteur et l'emprunteur font des choses différentes sur le
même écran ; ces sections nomment donc explicitement le rôle pour
éviter toute confusion. Les autres sections s'adressent directement
au lecteur.

---

## Tableau de bord

<a id="dashboard.your-escrow"></a>

### Votre Escrow

Un proxy UUPS-upgradable par utilisateur
(`VaipakamEscrowImplementation` derrière un `ERC1967Proxy`) déployé
pour toi la première fois que tu participes à un prêt. Un escrow
par adresse par chaîne. Détient des soldes ERC-20, ERC-721 et
ERC-1155 liés à tes positions de prêt. Aucune mise en commun —
les actifs des autres utilisateurs ne sont jamais dans ce contrat.

Le proxy d'escrow est l'emplacement canonique où résident le
collatéral, les actifs prêtés et le VPFI verrouillé. Le Diamond
s'authentifie auprès de lui à chaque dépôt/retrait ; l'implémentation
est upgradable par le propriétaire du protocole avec un timelock.

<a id="dashboard.your-loans"></a>

### Vos prêts

Chaque prêt impliquant le wallet connecté sur cette chaîne — que tu
sois côté prêteur, côté emprunteur, ou les deux sur des positions
distinctes. Calculé en direct à partir des sélecteurs de vue du
`LoanFacet` du Diamond contre ton adresse. Chaque ligne renvoie
vers la page de position complète avec HF, LTV, intérêts accumulés,
la surface d'actions filtrée par ton rôle + le statut du prêt, et
le `loanId` on-chain que tu peux coller dans un explorateur de
blocs.

<a id="dashboard.vpfi-panel"></a>

### VPFI sur cette chaîne

Comptabilité VPFI en direct pour le wallet connecté sur la chaîne
active :

- Solde du wallet (lu depuis l'ERC-20).
- Solde de l'escrow (lu depuis le proxy d'escrow par utilisateur).
- Ta part de l'offre circulante (après soustraction des soldes
  détenus par le protocole).
- Plafond de minting restant.

Vaipakam transporte VPFI cross-chain via LayerZero V2. **Base est
la chaîne canonique** — `VPFIOFTAdapter` y exécute la sémantique
lock/release. Toute autre chaîne supportée exécute `VPFIMirror`,
un OFT pur qui mint sur les paquets entrants et burn sur les
sortants. L'offre totale sur toutes les chaînes est invariante par
construction sous l'effet du bridging.

La politique DVN est de **3 requis + 2 optionnels, seuil 1 sur 2**
après le durcissement d'avril 2026 (voir `CLAUDE.md` "Cross-Chain
Security Policy"). La configuration DVN 1/1 par défaut est
rejetée à la porte de déploiement.

<a id="dashboard.fee-discount-consent"></a>

### Consentement à la remise sur frais

Drapeau d'opt-in au niveau wallet
(`VPFIDiscountFacet.toggleVPFIDiscountConsent`) qui permet au
protocole de régler la portion remisée d'un frais en VPFI prélevés
sur ton escrow lors des événements terminaux. Par défaut :
désactivé. Désactivé signifie que tu paies 100% de chaque frais
dans l'actif principal ; activé signifie que la remise pondérée
dans le temps s'applique.

Échelle de tiers (`VPFI_TIER_TABLE`) :

| Tier | VPFI minimum en escrow | Remise |
| ---- | ---------------------- | ------ |
| 1    | ≥ 100                  | 10%    |
| 2    | ≥ 1,000                | 15%    |
| 3    | ≥ 5,000                | 20%    |
| 4    | > 20,000               | 24%    |

Le tier est calculé contre le solde d'escrow **post-mutation** via
`LibVPFIDiscount.rollupUserDiscount`, puis pondéré dans le temps
sur la durée de vie de chaque prêt. Un unstake re-tamponne les BPS
au nouveau solde inférieur immédiatement pour chaque prêt ouvert
te concernant (clôt le vecteur de gaming où le code pré-Phase-5
tamponnait au solde pré-mutation).

La remise s'applique au yield-fee du prêteur au moment du
règlement et au Loan Initiation Fee de l'emprunteur (versée comme
rabais VPFI conjointement à `claimAsBorrower`). Voir
`TokenomicsTechSpec.md` §5.2b et §6.

---

## Carnet d'offres

<a id="offer-book.filters"></a>

### Filtres

Filtres côté client sur les listes d'offres de prêteur /
d'emprunteur. Filtre par adresse d'actif, côté, statut, et
quelques autres axes. Les filtres n'affectent pas "Vos offres
actives" — cette liste est toujours affichée intégralement.

<a id="offer-book.your-active-offers"></a>

### Vos offres actives

Offres ouvertes (statut = Active, expiration non encore atteinte)
où `creator == ton adresse`. Annulables à tout moment avant
acceptation via `OfferFacet.cancelOffer(offerId)`. L'acceptation
fait passer le statut de l'offre à `Accepted` et déclenche
`LoanFacet.initiateLoan`, qui mint les deux NFT de position (un
pour le prêteur et un pour l'emprunteur) et ouvre le prêt en état
`Active`.

<a id="offer-book.lender-offers"></a>

### Offres de prêteurs

Offres actives où le créateur est prêt à prêter. L'acceptation est
réalisée par un emprunteur ; passe par
`OfferFacet.acceptOffer` → `LoanFacet.initiateLoan`. Verrou strict
au niveau du Diamond : `MIN_HEALTH_FACTOR = 1.5e18` est appliqué à
l'initialisation contre le panier de collatéral de l'emprunteur en
utilisant la mathématique LTV/HF du `RiskFacet`. La coupe de
trésorerie de 1% sur les intérêts (`TREASURY_FEE_BPS = 100`) est
prélevée au règlement terminal, pas en amont.

<a id="offer-book.borrower-offers"></a>

### Offres d'emprunteurs

Offres actives d'emprunteurs ayant déjà verrouillé leur collatéral
en escrow. L'acceptation est réalisée par un prêteur ; finance le
prêt avec l'actif principal et mint les NFT de position. Même
verrou HF ≥ 1.5 à l'initialisation. L'APR fixe est défini sur
l'offre à la création et immuable durant toute la vie du prêt — le
refinancement crée un nouveau prêt.

---

## Créer une offre

<a id="create-offer.offer-type"></a>

### Type d'offre

Sélectionne le côté de l'offre où se trouve le créateur :

- **Lender** — `OfferFacet.createLenderOffer`. Le prêteur fournit
  l'actif principal et une spécification de collatéral à laquelle
  l'emprunteur doit satisfaire.
- **Borrower** — `OfferFacet.createBorrowerOffer`. L'emprunteur
  verrouille le collatéral à l'avance ; un prêteur accepte et
  finance.
- Sous-type **Rental** — pour les NFT ERC-4907 (ERC-721 louable) et
  ERC-1155 louables. Passe par le flux de location plutôt que par
  un prêt avec dette ; le locataire pré-paie
  `duration × dailyFee × (1 + RENTAL_BUFFER_BPS / 1e4)` où
  `RENTAL_BUFFER_BPS = 500`.

<a id="create-offer.lending-asset"></a>

### Actif prêté

Spécifie `(asset, amount, aprBps, durationDays)` pour une offre de
dette :

- `asset` — adresse du contrat ERC-20.
- `amount` — principal, libellé dans les décimales natives de
  l'actif.
- `aprBps` — APR fixe en basis points (1/10 000). Snapshot à
  l'acceptation ; non réactif.
- `durationDays` — fixe la fenêtre de grâce avant que
  `DefaultedFacet.markDefaulted` ne soit appelable.

L'intérêt accumulé est calculé en continu, à la seconde, à partir
de `loan.startTimestamp` jusqu'au règlement terminal.

<a id="create-offer.lending-asset:lender"></a>

#### Si tu es le prêteur

L'actif principal et le montant que tu es prêt à offrir, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut. Passe par
`OfferFacet.createLenderOffer` ; à l'acceptation, le principal
passe de ton escrow à l'escrow de l'emprunteur dans le cadre de
`LoanFacet.initiateLoan`.

<a id="create-offer.lending-asset:borrower"></a>

#### Si tu es l'emprunteur

L'actif principal et le montant que tu veux du prêteur, plus le
taux d'intérêt (APR en %) et la durée en jours. Le taux est fixé au
moment de l'offre ; la durée définit la fenêtre de grâce avant que
le prêt puisse passer en défaut. Passe par
`OfferFacet.createBorrowerOffer` ; ton collatéral est verrouillé
dans ton escrow au moment de la création de l'offre et reste
verrouillé jusqu'à ce qu'un prêteur accepte et que le prêt s'ouvre
(ou jusqu'à ce que tu annules).

<a id="create-offer.nft-details"></a>

### Détails du NFT

Champs du sous-type Rental. Spécifie le contrat NFT + token id (et
quantité pour ERC-1155), plus `dailyFeeAmount` dans l'actif
principal. À l'acceptation, `OfferFacet` prélève
`duration × dailyFeeAmount × (1 + 500 / 10_000)` depuis l'escrow
du locataire vers la garde ; le NFT lui-même passe en état délégué
via `setUser` d'ERC-4907 (ou le hook équivalent ERC-1155) de sorte
que le locataire a les droits mais ne peut pas transférer le NFT.

<a id="create-offer.collateral"></a>

### Collatéral

Spécification de l'actif de collatéral sur l'offre. Deux classes de
liquidité :

- **Liquide** — flux de prix Chainlink enregistré + ≥ 1 des 3
  factories V3-clones (Uniswap, PancakeSwap, SushiSwap) renvoie un
  pool avec une profondeur ≥ 1M$ au tick courant (3-V3-clone
  OR-logic, Phase 7b.1). Les calculs LTV/HF s'appliquent ; la
  liquidation basée sur HF passe par
  `RiskFacet → LibSwap` (failover sur 4 DEX : 0x → 1inch →
  Uniswap V3 → Balancer V2).
- **Illiquide** — tout ce qui échoue à ce qui précède. Valorisé à
  $0 on-chain. Pas de calcul HF. En défaut, transfert intégral du
  collatéral au prêteur. Les deux parties doivent
  `acceptIlliquidCollateralRisk` à la création / acceptation de
  l'offre pour que celle-ci soit posée.

Quorum d'oracle de prix secondaire (Phase 7b.2) : Tellor + API3 +
DIA, règle de décision soft 2-sur-N. Pyth retiré.

<a id="create-offer.collateral:lender"></a>

#### Si tu es le prêteur

Combien tu veux que l'emprunteur verrouille pour sécuriser le prêt.
Les ERC-20 liquides (flux Chainlink + ≥1M$ de profondeur de pool
v3) relèvent du calcul LTV/HF ; les ERC-20 illiquides et les NFT
n'ont pas de valorisation on-chain et nécessitent que les deux
parties consentent à un scénario de transfert intégral du
collatéral en défaut. Le verrou HF ≥ 1.5e18 sur
`LoanFacet.initiateLoan` est calculé contre le panier de collatéral
que l'emprunteur présente à l'acceptation — dimensionner
l'exigence ici fixe directement la marge HF de l'emprunteur.

<a id="create-offer.collateral:borrower"></a>

#### Si tu es l'emprunteur

Combien tu es prêt à verrouiller pour sécuriser le prêt. Les
ERC-20 liquides (flux Chainlink + ≥1M$ de profondeur de pool v3)
relèvent du calcul LTV/HF ; les ERC-20 illiquides et les NFT n'ont
pas de valorisation on-chain et nécessitent que les deux parties
consentent à un scénario de transfert intégral du collatéral en
défaut. Ton collatéral est verrouillé dans ton escrow au moment de
la création de l'offre sur une offre d'emprunteur ; pour une offre
de prêteur, ton collatéral est verrouillé au moment de
l'acceptation. Dans tous les cas, le verrou HF ≥ 1.5e18 sur
`LoanFacet.initiateLoan` doit être franchi avec le panier que tu
présentes.

<a id="create-offer.risk-disclosures"></a>

### Avertissements de risque

Porte de consentement avant la soumission. La même surface de
risque s'applique aux deux côtés ; les onglets spécifiques au rôle
ci-dessous expliquent comment chacun mord différemment selon le
côté de l'offre que tu signes. Vaipakam est non-custodial ; il
n'existe pas de clé admin pouvant inverser une transaction passée.
Des leviers de pause existent uniquement sur les contrats face à
LZ, gardés par le timelock ; ils ne peuvent pas déplacer d'actifs.

<a id="create-offer.risk-disclosures:lender"></a>

#### Si tu es le prêteur

- **Risque smart contract** — code immuable au runtime ; audité
  mais non vérifié formellement.
- **Risque oracle** — l'obsolescence Chainlink ou la divergence de
  profondeur de pool V3 peut retarder une liquidation basée sur HF
  au-delà du point où le collatéral couvre le principal. Le quorum
  secondaire (Tellor + API3 + DIA, Soft 2-sur-N) attrape les
  dérives importantes mais un petit biais peut encore éroder la
  récupération.
- **Slippage de liquidation** — le failover 4-DEX de `LibSwap`
  (0x → 1inch → Uniswap V3 → Balancer V2) route vers la meilleure
  exécution qu'il puisse trouver, mais ne peut garantir un prix
  spécifique. La récupération est nette de slippage et de la coupe
  de trésorerie de 1% sur les intérêts.
- **Défauts sur collatéral illiquide** — le collatéral te revient
  intégralement au moment de `markDefaulted`. Aucun recours si
  l'actif vaut moins que `principal + accruedInterest()`.

<a id="create-offer.risk-disclosures:borrower"></a>

#### Si tu es l'emprunteur

- **Risque smart contract** — code immuable au runtime ; les bugs
  affectent le collatéral verrouillé.
- **Risque oracle** — obsolescence ou manipulation peut déclencher
  une liquidation basée sur HF contre toi alors que le prix de
  marché réel serait resté sûr. La formule HF est réactive à la
  sortie de l'oracle ; un seul mauvais tick traversant 1.0 suffit.
- **Slippage de liquidation** — quand `RiskFacet → LibSwap` se
  déclenche, le swap peut vendre ton collatéral à des prix érodés
  par le slippage. Le swap est permissionless — n'importe qui peut
  le déclencher dès que HF < 1e18.
- **Défauts sur collatéral illiquide** — `markDefaulted` transfère
  ton collatéral intégral au prêteur. Aucune réclamation
  résiduelle — seulement le rabais VPFI LIF inutilisé via
  `claimAsBorrower`.

<a id="create-offer.advanced-options"></a>

### Options avancées

Réglages moins courants :

- `expiryTimestamp` — l'offre s'auto-annule après cela. Par défaut
  ~7 jours.
- `useFeeDiscountForThisOffer` — surcharge locale du consentement
  au niveau wallet pour cette offre spécifique.
- Options spécifiques au rôle exposées par côté par OfferFacet.

Les valeurs par défaut conviennent à la plupart des utilisateurs.

---

## Centre de réclamations

<a id="claim-center.claims"></a>

### Fonds réclamables

Les réclamations sont en mode pull par conception — les événements
terminaux laissent les fonds en garde du Diamond / escrow et le
détenteur du NFT de position appelle `claimAsLender` /
`claimAsBorrower` pour les déplacer. Les deux types de réclamation
peuvent coexister dans le même wallet en même temps. Les onglets
spécifiques au rôle ci-dessous décrivent chacun.

Chaque réclamation burn le NFT de position du détenteur de manière
atomique. Le NFT _est_ l'instrument au porteur — le transférer
avant de réclamer donne au nouveau détenteur le droit d'encaisser.

<a id="claim-center.claims:lender"></a>

#### Si tu es le prêteur

`ClaimFacet.claimAsLender(loanId)` rend :

- `principal` revient dans ton wallet sur cette chaîne.
- `accruedInterest(loan)` moins la coupe de trésorerie de 1%
  (`TREASURY_FEE_BPS = 100`) — la coupe est elle-même réduite par
  ton accumulateur de remise sur frais VPFI pondéré dans le temps
  (Phase 5) quand le consentement est activé.

Réclamable dès que le prêt atteint un état terminal (Settled,
Defaulted ou Liquidated). Le NFT de position de prêteur est burné
dans la même transaction.

<a id="claim-center.claims:borrower"></a>

#### Si tu es l'emprunteur

`ClaimFacet.claimAsBorrower(loanId)` rend, selon la manière dont
le prêt s'est réglé :

- **Remboursement total / preclose / refinance** — ton panier de
  collatéral, plus le rabais VPFI pondéré dans le temps issu du
  LIF (`s.borrowerLifRebate[loanId].rebateAmount`).
- **Liquidation HF ou défaut** — uniquement le rabais VPFI LIF
  inutilisé (qui sur ces chemins terminaux est zéro à moins d'être
  explicitement préservé). Le collatéral est déjà passé au
  prêteur.

Le NFT de position d'emprunteur est burné dans la même transaction.

---

## Activité

<a id="activity.feed"></a>

### Flux d'activité

Événements on-chain impliquant ton wallet sur la chaîne active,
sourcés en direct depuis les logs du Diamond (`getLogs` sur une
fenêtre glissante de blocs). Aucun cache backend — chaque
chargement re-fetche. Les événements sont regroupés par
`transactionHash` pour que les txns multi-événements (p.ex. accept
+ initiate) restent ensemble. Les plus récents en premier. Affiche
offres, prêts, remboursements, réclamations, liquidations,
mints/burns de NFT, et achats / stakes / unstakes de VPFI.

---

## Acheter VPFI

<a id="buy-vpfi.overview"></a>

### Acheter du VPFI

Deux voies :

- **Canonique (Base)** — appel direct à
  `VPFIBuyFacet.buyVPFIWithETH` sur le Diamond. Mint VPFI
  directement vers ton wallet sur Base.
- **Hors canonique** — `VPFIBuyAdapter.buy()` sur la chaîne locale
  envoie un paquet LayerZero à `VPFIBuyReceiver` sur Base, qui
  appelle le Diamond et OFT-renvoie le résultat. Latence
  end-to-end ~1 min sur les paires L2-vers-L2. Le VPFI atterrit
  dans ton wallet sur la chaîne d'**origine**.

Limites de débit de l'adapter (post-durcissement) : 50k VPFI par
requête, 500k glissants 24h. Réglable via `setRateLimits`
(timelock).

<a id="buy-vpfi.discount-status"></a>

### Votre statut de remise VPFI

Statut en direct :

- Tier courant (0..4, depuis
  `VPFIDiscountFacet.getVPFIDiscountTier`).
- Solde VPFI d'escrow + delta jusqu'au tier suivant.
- Remise BPS au tier courant.
- Drapeau de consentement au niveau wallet.

À noter que le VPFI en escrow accumule aussi 5% APR via le pool
de staking — il n'y a pas d'action "stake" séparée ; déposer en
escrow, c'est staker.

<a id="buy-vpfi.buy"></a>

### Étape 1 — Achète du VPFI avec de l'ETH

Soumet l'achat. Sur les chaînes canoniques, le Diamond mint
directement. Sur les chaînes mirror, l'adapter d'achat encaisse,
envoie un message LZ, et le receiver exécute l'achat sur Base et
OFT-renvoie le VPFI. Le frais de pont + coût DVN est coté en
direct par `useVPFIBuyBridge.quote()` et affiché dans le
formulaire. Le VPFI ne se dépose pas automatiquement en escrow —
l'étape 2 est explicite.

<a id="buy-vpfi.deposit"></a>

### Étape 2 — Dépose le VPFI dans ton escrow

`Diamond.depositVPFIToEscrow(amount)`. Requis sur chaque chaîne —
même canonique — car le dépôt en escrow est toujours une action
explicite de l'utilisateur par spécification. Sur les chaînes avec
Permit2 (Phase 8b), l'app préfère la voie en signature unique
(`depositVPFIToEscrowWithPermit2`) au lieu de approve + deposit.
Retombe gracieusement si Permit2 n'est pas configuré sur cette
chaîne.

<a id="buy-vpfi.unstake"></a>

### Étape 3 — Désengage le VPFI de ton escrow

`Diamond.withdrawVPFIFromEscrow(amount)`. Pas d'étape
d'approbation — le Diamond possède le proxy d'escrow et se
prélève lui-même. L'appel de retrait déclenche
`LibVPFIDiscount.rollupUserDiscount(user, postBalance)` pour que
l'accumulateur BPS de chaque prêt ouvert soit re-tamponné au
nouveau (plus bas) solde immédiatement. Il n'y a aucune fenêtre
de grâce où l'ancien tier s'applique encore.

---

## Récompenses

<a id="rewards.overview"></a>

### À propos des récompenses

Deux flux :

- **Pool de staking** — le VPFI détenu en escrow accumule à 5% APR
  en continu. Composition à la seconde via
  `RewardFacet.pendingStaking`.
- **Pool d'interaction** — part journalière au prorata d'une
  émission journalière fixe, pondérée par ta contribution en
  intérêts réglés au volume de prêts du jour. Les fenêtres
  journalières finalisent paresseusement à la première
  réclamation après la fermeture de fenêtre.

Les deux récompenses sont mintées directement sur la chaîne
active (pas d'aller-retour LZ pour l'utilisateur ; l'agrégation
cross-chain des récompenses se fait sur `VaipakamRewardOApp`
uniquement entre contrats du protocole).

<a id="rewards.claim"></a>

### Réclamer les récompenses

`RewardFacet.claimRewards()` — tx unique, réclame les deux flux.
Le staking est toujours disponible ; l'interaction vaut `0n`
jusqu'à ce que la fenêtre journalière concernée finalise
(finalisation paresseuse déclenchée par la prochaine réclamation
ou règlement non nul sur cette chaîne). L'UI verrouille le bouton
quand `interactionWaitingForFinalization` pour que les
utilisateurs ne sous-réclament pas.

<a id="rewards.withdraw-staked"></a>

### Retirer le VPFI staké

Surface identique à "Étape 3 — Désengage" sur la page Acheter VPFI
— `withdrawVPFIFromEscrow`. Le VPFI retiré sort du pool de
staking immédiatement (les récompenses cessent de s'accumuler
pour ce montant à ce bloc) et sort de l'accumulateur de remise
immédiatement (re-tamponnage du solde post sur chaque prêt
ouvert).

---

## Détails du prêt

<a id="loan-details.overview"></a>

### Détails du prêt (cette page)

Vue d'un prêt unique dérivée de
`LoanFacet.getLoanDetails(loanId)` plus HF/LTV en direct depuis
`RiskFacet.calculateHealthFactor`. Rend les conditions, le risque
de collatéral, les parties, la surface d'actions filtrée par
`getLoanActionAvailability(loan, viewerAddress)`, et le statut
keeper en ligne depuis `useKeeperStatus`.

<a id="loan-details.terms"></a>

### Conditions du prêt

Parties immuables du prêt :

- `principal` (actif + montant).
- `aprBps` (fixé à la création de l'offre).
- `durationDays`.
- `startTimestamp`, `endTimestamp` (= `startTimestamp +
durationDays * 1 days`).
- `accruedInterest()` — fonction view, calcule depuis `now -
startTimestamp`.

Le refinancement crée un nouveau `loanId` plutôt que de muter
ceux-ci.

<a id="loan-details.collateral-risk"></a>

### Collatéral & Risque

Mathématique de risque en direct via `RiskFacet`. Le **Health
Factor** est `(collateralUsdValue × liquidationThresholdBps /
1e4) / debtUsdValue`, mis à l'échelle 1e18. HF < 1e18 déclenche
la liquidation basée sur HF. Le **LTV** est
`debtUsdValue / collateralUsdValue`. Seuil de liquidation = le
LTV à partir duquel la position devient liquidable ; dépend de la
classe de volatilité du panier de collatéral
(`VOLATILITY_LTV_THRESHOLD_BPS = 11000` pour le cas
d'effondrement à haute volatilité).

Le collatéral illiquide a `usdValue == 0` on-chain ; HF/LTV
s'effondrent à n/a et le seul chemin terminal est le transfert
intégral en défaut — les deux parties ont consenti à la création
de l'offre via la reconnaissance de risque illiquide.

<a id="loan-details.collateral-risk:lender"></a>

#### Si tu es le prêteur

Le panier de collatéral sécurisant ce prêt est ta protection.
HF > 1e18 signifie que la position est sur-collatéralisée par
rapport au seuil de liquidation. À mesure que HF dérive vers
1e18, ta protection s'amincit ; une fois HF < 1e18, n'importe qui
(toi inclus) peut appeler
`RiskFacet.triggerLiquidation(loanId)` et `LibSwap` routera le
collatéral via le failover 4-DEX vers ton actif principal. La
récupération est nette de slippage.

Pour le collatéral illiquide, en défaut le panier te revient
intégralement au moment de `markDefaulted` — sa valeur réelle
est ton problème.

<a id="loan-details.collateral-risk:borrower"></a>

#### Si tu es l'emprunteur

Ton collatéral verrouillé. Garde HF confortablement au-dessus de
1e18 — la cible de buffer courante est ≥ 1.5e18 pour absorber la
volatilité. Leviers pour remonter HF :

- `addCollateral(loanId, …)` — recharger le panier ; utilisateur
  uniquement.
- Remboursement partiel via `RepayFacet` — réduit la dette,
  remonte HF.

Une fois HF < 1e18, n'importe qui peut déclencher la liquidation
basée sur HF ; le swap vend ton collatéral à des prix érodés par
le slippage pour rembourser le prêteur. Sur collatéral illiquide,
le défaut transfère ton collatéral intégral au prêteur — il ne
reste à réclamer que le rabais VPFI LIF inutilisé
(`s.borrowerLifRebate[loanId].rebateAmount`).

<a id="loan-details.parties"></a>

### Parties

`(lender, borrower, lenderEscrow, borrowerEscrow,
positionNftLender, positionNftBorrower)`. Chaque NFT est un
ERC-721 avec métadonnées on-chain ; le transférer transfère le
droit de réclamer. Les proxies d'escrow sont déterministes par
adresse (CREATE2) — même adresse à travers les déploiements.

<a id="loan-details.actions"></a>

### Actions

Surface d'actions, gardée par rôle via
`getLoanActionAvailability`. Les onglets spécifiques au rôle
ci-dessous listent les sélecteurs disponibles de chaque côté.
Les actions désactivées affichent un motif au survol dérivé de
la garde (`InsufficientHF`, `NotYetExpired`, `LoanLocked`, etc.).

Actions permissionless disponibles à tous quel que soit le rôle :

- `RiskFacet.triggerLiquidation(loanId)` — quand HF < 1e18.
- `DefaultedFacet.markDefaulted(loanId)` — quand la période de
  grâce a expiré sans remboursement total.

<a id="loan-details.actions:lender"></a>

#### Si tu es le prêteur

- `ClaimFacet.claimAsLender(loanId)` — terminal uniquement. Rend
  principal + intérêts moins la coupe de trésorerie de 1%
  (encore réduite par ta remise yield-fee VPFI pondérée dans le
  temps quand le consentement est activé). Burn le NFT de
  position de prêteur.
- `EarlyWithdrawalFacet.initEarlyWithdrawal(loanId, askPrice)` —
  liste le NFT de prêteur en vente à `askPrice`. Un acheteur
  appelant `completeEarlyWithdrawal(saleId)` prend ton côté ; tu
  reçois le produit. Annulable avant remplissage.
- Optionnellement délégable à un keeper détenant le bit d'action
  pertinent (`COMPLETE_LOAN_SALE`, etc.) — voir Paramètres des
  keepers.

<a id="loan-details.actions:borrower"></a>

#### Si tu es l'emprunteur

- `RepayFacet.repay(loanId, amount)` — total ou partiel. Le
  partiel réduit le solde restant et remonte HF ; le total
  déclenche le règlement terminal, y compris le rabais VPFI LIF
  pondéré dans le temps via
  `LibVPFIDiscount.settleBorrowerLifProper`.
- `PrecloseFacet.precloseDirect(loanId)` — paie le solde restant
  depuis ton wallet maintenant, libère le collatéral, règle le
  rabais LIF.
- `PrecloseFacet.initOffset(loanId, swapParams)` /
  `completeOffset(loanId)` — vend une partie du collatéral via
  `LibSwap`, rembourse depuis le produit, retourne le reste.
- Flux `RefinanceFacet` — publie une offre d'emprunteur pour de
  nouvelles conditions ;
  `completeRefinance(oldLoanId, newOfferId)` échange les prêts
  atomiquement sans que le collatéral ne quitte l'escrow.
- `ClaimFacet.claimAsBorrower(loanId)` — terminal uniquement.
  Rend le collatéral en cas de remboursement total, ou le rabais
  VPFI LIF inutilisé en défaut / liquidation. Burn le NFT de
  position d'emprunteur.

---

## Allowances

<a id="allowances.list"></a>

### Allowances

Liste chaque `allowance(wallet, diamondAddress)` ERC-20 que ton
wallet a accordée au Diamond sur cette chaîne. Sourcée en
scannant une liste candidate de tokens contre des appels view
`IERC20.allowance`. La révocation met l'allowance à zéro via
`IERC20.approve(diamond, 0)`. Conformément à la politique
d'approbation au montant exact, le protocole ne demande jamais
d'allowances illimitées, donc les révocations sont généralement
peu nombreuses.

Note : les flux de type Permit2 (Phase 8b) contournent
l'allowance par actif sur le Diamond en utilisant une signature
unique à la place, donc une liste propre ici n'empêche pas les
dépôts futurs.

---

## Alertes

<a id="alerts.overview"></a>

### À propos des alertes

Worker Cloudflare off-chain (`hf-watcher`) interroge chaque prêt
actif impliquant ton wallet à une cadence de 5 minutes. Lit
`RiskFacet.calculateHealthFactor` pour chacun. Sur un
franchissement de bande dans la direction dangereuse, déclenche
une fois via les canaux configurés. Pas d'état on-chain, pas de
gas. Les alertes sont consultatives — elles ne déplacent pas de
fonds.

<a id="alerts.threshold-ladder"></a>

### Échelle de seuils

Échelle de bandes HF configurée par l'utilisateur. Passer dans
une bande plus dangereuse déclenche une fois et arme le seuil
plus profond suivant. Repasser au-dessus d'une bande la réarme.
Par défaut : `1.5 → 1.3 → 1.1`. Des nombres plus élevés sont
appropriés pour un collatéral volatil ; le seul rôle de l'échelle
est de te faire sortir avant que HF < 1e18 ne déclenche la
liquidation.

<a id="alerts.delivery-channels"></a>

### Canaux de livraison

Deux canaux :

- **Telegram** — DM bot avec l'adresse courte du wallet + loan
  id + HF actuel.
- **Push Protocol** — notification directe au wallet via le
  canal Vaipakam Push.

Les deux partagent l'échelle de seuils ; les warn-levels par
canal ne sont volontairement pas exposés (pour éviter la dérive).
La publication sur le canal Push est stub-ée en attendant la
création du canal — voir notes de Phase 8a.

---

## Vérificateur de NFT

<a id="nft-verifier.lookup"></a>

### Vérifier un NFT

Étant donné `(nftAddress, tokenId)`, fetche :

- `IERC721.ownerOf(tokenId)` (ou burn-selector `0x7e273289` =>
  déjà burné).
- `IERC721.tokenURI(tokenId)` → métadonnées JSON on-chain.
- Vérification croisée Diamond : dérive le `loanId` sous-jacent
  depuis les métadonnées et lit `LoanFacet.getLoanDetails(loanId)`
  pour confirmer l'état.

Fait surface : minté par Vaipakam ? quelle chaîne ? statut du
prêt ? détenteur courant ? Te permet de repérer une contrefaçon,
une position déjà réclamée (burnée), ou une position dont le
prêt est réglé et en cours de réclamation.

Le NFT de position est l'instrument au porteur — vérifie avant
d'acheter sur un marché secondaire.

---

## Paramètres des keepers

<a id="keeper-settings.overview"></a>

### À propos des keepers

Liste blanche de keepers par wallet (`KeeperSettingsFacet`) de
jusqu'à 5 keepers (`MAX_KEEPERS = 5`). Chaque keeper a un bitmask
d'actions (`KEEPER_ACTION_*`) autorisant des appels de
maintenance spécifiques sur **ton côté** d'un prêt. Les chemins
sortie-d'argent (repay, claim, addCollateral, liquidate) sont
réservés à l'utilisateur par conception et ne peuvent pas être
délégués.

Deux gardes supplémentaires s'appliquent au moment de l'action :

1. Interrupteur principal d'accès keeper (frein d'urgence à un
   seul flip ; désactive tous les keepers sans toucher à
   l'allowlist).
2. Toggle d'opt-in par prêt (réglé sur Carnet d'offres / Détails
   du prêt).

Un keeper ne peut agir que quand `(approved, masterOn, perLoanOn,
actionBitSet)` sont tous vrais.

<a id="keeper-settings.approved-list"></a>

### Keepers approuvés

Drapeaux de bitmask actuellement exposés :

- `COMPLETE_LOAN_SALE` (0x01)
- `COMPLETE_OFFSET` (0x02)
- `INIT_EARLY_WITHDRAW` (0x04)
- `INIT_PRECLOSE` (0x08)
- `REFINANCE` (0x10)

Les bits ajoutés on-chain sans que le frontend les reflète
obtiennent un revert `InvalidKeeperActions`. La révocation est
`KeeperSettingsFacet.removeKeeper(addr)` et est instantanée sur
tous les prêts.

---

## Tableau de bord d'analytique publique

<a id="public-dashboard.overview"></a>

### À propos de l'analytique publique

Agrégateur sans wallet calculé en direct à partir d'appels view
on-chain du Diamond sur chaque chaîne supportée. Pas de backend /
base de données. Hooks impliqués : `useProtocolStats`, `useTVL`,
`useTreasuryMetrics`, `useUserStats`, `useVPFIToken`. Export
CSV / JSON disponible ; l'adresse du Diamond + la fonction view
de chaque métrique sont affichées pour la vérifiabilité.

<a id="public-dashboard.combined"></a>

### Combiné — Toutes les chaînes

Rollup cross-chain. L'en-tête rapporte `chainsCovered` et
`chainsErrored` pour qu'un RPC inaccessible au moment du fetch
soit explicite. `chainsErrored > 0` signifie que le tableau par
chaîne signale laquelle — les totaux TVL sont quand même
rapportés mais reconnaissent l'écart.

<a id="public-dashboard.per-chain"></a>

### Détail par chaîne

Ventilation par chaîne des métriques combinées. Utile pour
repérer une concentration de TVL, des offres mirror VPFI
incohérentes (la somme devrait égaler le solde verrouillé de
l'adapter canonique), ou des chaînes à l'arrêt.

<a id="public-dashboard.vpfi-transparency"></a>

### Transparence du token VPFI

Comptabilité VPFI on-chain sur la chaîne active :

- `totalSupply()` — natif ERC-20.
- Offre circulante — `totalSupply()` moins les soldes détenus
  par le protocole (trésorerie, pools de récompenses, paquets LZ
  in-flight).
- Plafond de minting restant — dérivé de
  `MAX_SUPPLY - totalSupply()` sur le canonique ; les chaînes
  mirror rapportent `n/a` pour le plafond (les mints y sont
  pilotés par le pont).

Invariant cross-chain : la somme des `VPFIMirror.totalSupply()`
sur toutes les chaînes mirror == `VPFIOFTAdapter.lockedBalance()`
sur le canonique. Le watcher surveille et alerte sur la dérive.

<a id="public-dashboard.transparency"></a>

### Transparence & Source

Pour chaque métrique, liste :

- Le numéro de bloc utilisé comme snapshot.
- Fraîcheur des données (staleness max parmi les chaînes).
- L'adresse du Diamond et l'appel de fonction view.

N'importe qui peut redériver n'importe quel chiffre de cette page
depuis `(rpcUrl, blockNumber, diamondAddress, fnName)` — c'est le
standard.

---

## Refinancer

Cette page est réservée aux emprunteurs — le refinancement est
initié par l'emprunteur sur le prêt de l'emprunteur.

<a id="refinance.overview"></a>

### À propos du refinancement

`RefinanceFacet` — solde atomiquement ton prêt existant depuis un
nouveau principal et ouvre un prêt frais avec les nouvelles
conditions, le tout en une tx. Le collatéral reste dans ton
escrow tout du long — pas de fenêtre non garantie. Le nouveau
prêt doit franchir `MIN_HEALTH_FACTOR = 1.5e18` à
l'initialisation comme tout autre prêt.

`LibVPFIDiscount.settleBorrowerLifProper(oldLoan)` est appelé sur
l'ancien prêt dans le cadre du swap, donc tout rabais VPFI LIF
inutilisé est crédité correctement.

<a id="refinance.position-summary"></a>

### Votre position actuelle

Snapshot du prêt en cours de refinancement — `loan.principal`,
`accruedInterest()` actuel, HF/LTV, panier de collatéral. La
nouvelle offre doit dimensionner au moins le solde restant
(`principal + accruedInterest()`) ; tout excédent sur la nouvelle
offre est livré à ton escrow comme principal libre.

<a id="refinance.step-1-post-offer"></a>

### Étape 1 — Publie la nouvelle offre

Publie une offre d'emprunteur via
`OfferFacet.createBorrowerOffer` avec tes conditions cibles.
L'ancien prêt continue d'accumuler des intérêts ; le collatéral
reste verrouillé. L'offre apparaît dans le Carnet d'offres public
et n'importe quel prêteur peut l'accepter. Tu peux annuler avant
acceptation.

<a id="refinance.step-2-complete"></a>

### Étape 2 — Finaliser

`RefinanceFacet.completeRefinance(oldLoanId, newOfferId)` —
atomique :

1. Finance le nouveau prêt depuis le prêteur acceptant.
2. Rembourse l'ancien prêt en totalité (principal + intérêts,
   moins la coupe de trésorerie).
3. Burn les anciens NFT de position.
4. Mint les nouveaux NFT de position.
5. Règle le rabais LIF de l'ancien prêt via
   `LibVPFIDiscount.settleBorrowerLifProper`.

Revert si HF < 1.5e18 sur les nouvelles conditions.

---

## Clôture anticipée

Cette page est réservée aux emprunteurs — la clôture anticipée
est initiée par l'emprunteur sur son prêt.

<a id="preclose.overview"></a>

### À propos de la clôture anticipée

`PrecloseFacet` — terminaison anticipée pilotée par
l'emprunteur. Deux voies :

- **Direct** — `precloseDirect(loanId)`. Paie
  `principal + accruedInterest()` depuis ton wallet, libère le
  collatéral. Invoque
  `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
- **Offset** — `initOffset(loanId, swapParams)` puis
  `completeOffset(loanId)`. Vend une partie du collatéral via
  `LibSwap` (failover 4-DEX) contre l'actif principal,
  rembourse depuis le produit, le reste du collatéral te
  revient. Même règlement de rabais LIF.

Pas de pénalité forfaitaire de clôture anticipée. La
mathématique VPFI pondérée dans le temps de Phase 5 gère le
calcul d'équité.

<a id="preclose.position-summary"></a>

### Votre position actuelle

Snapshot du prêt en cours de preclose — principal restant,
intérêts accumulés, HF/LTV courants. Le flux de preclose
**n'exige pas** HF ≥ 1.5e18 à la sortie (c'est une fermeture,
pas une ré-init).

<a id="preclose.in-progress"></a>

### Offset en cours

État : `initOffset` est passé, le swap est en cours d'exécution
(ou la cotation a été consommée mais le règlement final est en
attente). Deux sorties :

- `completeOffset(loanId)` — règle le prêt depuis le produit
  réalisé, retourne le reste.
- `cancelOffset(loanId)` — abandonne ; le collatéral reste
  verrouillé, le prêt inchangé. À utiliser quand le swap a bougé
  contre toi entre init et complete.

<a id="preclose.choose-path"></a>

### Choisis une voie

La voie directe consomme la liquidité du wallet dans l'actif
principal. La voie offset consomme le collatéral via swap DEX ;
préférée quand tu n'as pas l'actif principal sous la main ou que
tu veux aussi sortir de la position de collatéral. Le slippage
de l'offset passe par le failover 4-DEX de `LibSwap` (0x →
1inch → Uniswap V3 → Balancer V2).

---

## Retrait anticipé (prêteur)

Cette page est réservée aux prêteurs — le retrait anticipé est
initié par le prêteur sur son prêt.

<a id="early-withdrawal.overview"></a>

### À propos de la sortie anticipée du prêteur

`EarlyWithdrawalFacet` — mécanisme de marché secondaire pour les
positions de prêteur. Tu listes ton NFT de position en vente à
un prix choisi ; à l'acceptation, l'acheteur paie, la propriété
du NFT de prêteur est transférée à l'acheteur, et l'acheteur
devient le prêteur de référence pour tout règlement futur (claim
au terminal, etc.). Tu repars avec le produit de la vente.

Les liquidations restent réservées à l'utilisateur et ne sont
PAS déléguées par la vente — seul le droit de réclamer est
transféré.

<a id="early-withdrawal.position-summary"></a>

### Votre position actuelle

Snapshot — principal restant, intérêts accumulés, temps
restant, HF/LTV courants du côté emprunteur. Cela fixe le prix
juste que le marché des acheteurs attend : le payoff de
l'acheteur est `principal + interest` au terminal, moins le
risque de liquidation sur le temps restant.

<a id="early-withdrawal.initiate-sale"></a>

### Initier la vente

`initEarlyWithdrawal(loanId, askPrice)`. Liste le NFT de
position en vente via le protocole ;
`completeEarlyWithdrawal(saleId)` est ce qu'un acheteur appelle
pour accepter. Annulable avant remplissage via
`cancelEarlyWithdrawal(saleId)`. Optionnellement délégable à un
keeper détenant le bit d'action `COMPLETE_LOAN_SALE` ; l'init
lui-même reste réservé à l'utilisateur.
