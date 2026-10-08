# Les deux attentes du clic hors codec

> Où passe le temps d'un clic sur l'hôte natif, entre sa réception et la remise
> de l'image qui le montre (poste A), et dans la page, entre la soumission du
> décodage PyroWave et sa fin (poste B). Plan « attente », lancé le 08/10/2026.
> La cible est l'hôte natif : Windows d'abord, puis Linux et macOS. Ce document
> garde les constats ; le plan détaillé vit hors du dépôt.

## 1. Le point de départ

Banc du 06/10 (POC Ultra, §6.19-6.24 de `ultra-lan-poc.md`) : hôte DualRTX, la
RTX encode, écran virtuel à 120 Hz, client UM790Pro en câble, 456 clics. Entre
la réception du clic par l'hôte et l'image du drapeau capturée : 15,2 ms en
HEVC, 13,0 ms en PyroWave. Côté page, le décodage WebGPU de PyroWave prenait
6,3 ms, dont ~1,8 ms de travail GPU.

Le modèle d'alors pour le poste A : une demi-image d'attente du rafraîchissement
suivant (4,2 ms à 120 Hz), plus une image entre la composition de DWM et la
remise par la capture (8,3 ms). **Le banc 1 l'infirme pour la seconde moitié.**

## 2. L'instrumentation

Tout est sur l'horloge de l'hôte (QueryPerformanceCounter, commune au serveur,
au worker et au drapeau), et tout reste éteint hors banc.

- `clicktrace=1` (`MW_NATIVE_TUNING`) : chaque appui remis à SendInput (début
  et fin de l'appel), chaque réveil de la capture (début d'attente, retour,
  statut ; pour une image, `LastPresentTime` de DDA ou `SystemRelativeTime` brut
  de WGC, `LastMouseUpdateTime`, `AccumulatedFrames`), et le minutage de DWM.
  CSV `click-trace-<pid>-<ms>.csv` à côté du journal du worker. Le relais
  journalise chaque entrée horodatée (reçue, traitée).
- `MW_LATENCY_FLAG_TRACE=1` : la ligne du drapeau porte l'instant de son
  crochet, puis DwmFlush et le minutage de DWM après chaque drapeau.
  `MW_LATENCY_FLAG_SKIP=*` : le drapeau reste armé mais ne se dessine nulle part.
- `tools/click-target` (`mw-click-target`) : le « jeu idéal ». Une fenêtre D3D12
  en flip model, tearing permis, qui dessine le drapeau au clic et présente
  aussitôt.
- Page : `localStorage.mw_ultra_trace=1` garde la chronologie de chaque image
  PyroWave, les horodatages GPU de chaque image, et une passe vide de référence
  une image sur huit.
- Analyse : `scripts/bench/clickpath/hostpath.py` (poste A),
  `gpuwait.py` (poste B). Mode d'emploi dans leur README.

Les passes témoin sans aucune trace donnent les mêmes clics (32,2 et 32,1 ms de
médiane, contre 31,4 et 32,6 tracées) : la trace ne coûte rien de mesurable.

## 3. Banc 1 (08/10/2026)

Hôte DualRTX en `--dev`, la RTX encode, écran virtuel en 1920×1080 à 120 Hz
(le 06/10 était en 2560×1440), client UM790Pro sous Windows en câble, Chrome
avec `--enable-webgpu-developer-features`. 60 clics par passe, cases alternées.

### 3.1 Poste A, avec le drapeau du banc

Médianes sur 120 clics par case, de la réception par le relais à la remise de
l'image qui montre le drapeau :

| Étape | DDA, PyroWave | DDA, HEVC | WGC, HEVC |
|---|---|---|---|
| relais → SendInput appelé | 0,12 | 0,13 | 0,15 |
| SendInput appelé → crochet du drapeau | 4,20 | 4,39 | 4,10 |
| crochet → drapeau peint | 5,58 | 5,25 | 7,06 |
| drapeau peint → image présentée | 3,26 | 3,42 | 9,92 |
| présentée → remise par la capture | 0,07 | 0,10 | 0,00 * |
| **total hôte** (médiane / moyenne) | **14,5 / 16,1** | **14,7 / 17,2** | **22,4 / 25,7** |

\* WGC : l'heure de présentation est ramenée à celle de la remise (elle court en
avance), la remise ne se mesure donc pas.

Ce que ça dit :

- **Pas d'image en plus entre DWM et la capture.** L'image du drapeau est
  présentée au premier rafraîchissement de l'écran virtuel qui suit sa peinture
  (`late` = 0 en médiane), et DDA la remet en 0,1 ms. La demi-image d'attente
  du modèle est bien là (3,3-3,4 ms de médiane, 4,2 de moyenne).
- **Le drapeau lui-même coûte ~10 ms.** SendInput ne rend la main qu'une fois
  tous les crochets souris bas niveau passés, celui du drapeau compris (4,2-4,4 ms
  avant même qu'il s'exécute) ; puis montrer sa fenêtre topmost et layered prend
  5,3-5,6 ms (une moyenne de 6,5-8 ms, une queue à 10-12). C'est un artefact du
  banc.
- **WGC est nettement plus lent.** Sur l'écran virtuel, la capture n'a livré
  qu'environ 46 images par seconde (5 060 en ~110 s, contre ~115 pour DDA),
  l'image du drapeau arrive deux rafraîchissements après le suivant, et le clic
  passe de 32 à 46 ms. La cause n'est pas vérifiée. PyroWave refuse WGC : sa
  route D3D12 exige DDA.
- **Le minutage de DWM ne décrit pas l'écran capturé.** `DwmGetCompositionTimingInfo`
  donnait une période de 6,95 ms (144 Hz, l'horloge d'un autre écran) alors que
  les présentations de l'écran virtuel tombaient sur une grille de 8,33 ms.
  `hostpath.py` tire la grille des présentations elles-mêmes.

### 3.2 Poste A, avec le « jeu idéal » (premier essai de A1)

`mw-click-target` en plein écran sur l'écran virtuel, tearing permis, 240 i/s,
le drapeau de l'hôte éteint (`MW_LATENCY_FLAG_SKIP=*`), HEVC, DDA, 60 clics :

| Étape | Médiane | Moyenne | p90 |
|---|---|---|---|
| relais → SendInput appelé | 0,17 | 0,21 | 0,44 |
| SendInput appelé → WM_LBUTTONDOWN | 0,92 | 1,86 | 4,55 |
| WM_LBUTTONDOWN → Present rendu | 0,34 | 0,44 | 0,88 |
| Present → image présentée (capture) | 5,48 | 5,67 | 12,04 |
| présentée → remise | 0,11 | 0,15 | 0,25 |
| **total hôte** | **7,25** | **8,38** | 14,96 |

Clic total : **27,2 ms de médiane** (32 avec le drapeau). Avec une application
qui réagit vite, la part de l'hôte tombe à ~7 ms, presque toute entre le Present
de l'application et la présentation que DDA voit.

Le même jour, les passes en fenêtre (`--window`) et synchronisée (`--sync 1`)
n'ont reçu aucun clic : 60 appuis injectés, aucun `WM_LBUTTONDOWN`. À
comprendre avant A1. `GetFrameStatistics` ne donne pas de `SyncQPCTime` sur
l'écran virtuel (`displayedUs` nul).

### 3.3 Poste B, l'attente du GPU dans la page (780M, PyroWave)

Deux passes, ~12 200 images chacune, horodatages GPU non arrondis :

| Mesure | Médiane |
|---|---|
| soumission → fin du travail (`onSubmittedWorkDone`) | 5,0-5,2 ms |
| travail GPU : décodage 1,77 + écart 0,13 + affichage 0,31 | 2,2 ms |
| soumission → début du GPU | 0,7-1,4 ms |
| fin du GPU → rappel de Chrome | 1,1-1,8 ms |
| **soumission vide** (aucun travail) → fin | **3,5-3,7 ms** |
| fin → VideoFrame, VideoFrame → dessinée | 0,1, puis 0,3 ms |

L'horloge du GPU du 780M court à +1 935 ppm de celle de la page (16 ms en 8 s) :
`gpuwait.py` retire cette pente avant de recaler, et les bornes du recalage
tiennent alors à 0,6 ms près.

**Le poste B est l'aller-retour de Chrome et de Dawn, pas le GPU** : une
soumission vide coûte déjà 3,6 ms. Le travail du GPU en ajoute ~1,5.

### 3.4 Un bug trouvé en route

Le relais répondait « injection traitée » 40 µs après la réception, avant même
d'injecter. Il construisait sa réponse à partir d'un objet temporaire, dont le
destructeur partait aussitôt. Le `hostInMs` de la sonde lisait donc ~0 ms au
lieu des 5 ms de SendInput. Corrigé (`afb0c445`). Le chiffre « hôte → capturée »
du 06/10 n'en dépendait pas.

## 4. Porte A1 (provisoire) et suite

Le poste A mesuré au drapeau est surtout un artefact du banc : ~10 ms sur 14,5
viennent du drapeau. Avec une application rapide, il reste ~7 ms, dont ~5,5
entre son Present et la présentation que capte DDA. Ce reste est de la
production, et c'est lui que visent les leviers AW2 (écran virtuel plus rapide,
capture sur présentation, flip indépendant). Avant de trancher :

1. comprendre pourquoi les passes en fenêtre et synchronisée ne recevaient pas
   les clics, puis les mesurer ;
2. une passe sous un vrai jeu (RE9, la copie) ;
3. découper le Present → présentation captée (PresentMon : composé ou flip
   indépendant).

Pour le poste B, les hypothèses B1 se resserrent sur l'aller-retour de Chrome :
présenter par le canevas WebGPU sans `onSubmittedWorkDone` (B2.1) devient le
premier levier à essayer.
