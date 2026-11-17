<p align="center">
  <img src="docs/icone.png" width="128" alt="Icône d'Espaces : une roue de cartes colorées">
</p>

<h1 align="center">Espaces</h1>

<p align="center">
  Un carnet pour écrire, ranger et présenter ses idées, sur Mac, iPad et iPhone.<br>
  Les textes sont des cartes, rangées en roue dans des espaces ; chaque carte peut devenir une présentation.
</p>

---

## Sommaire

- [Ce que fait Espaces](#ce-que-fait-espaces)
- [Installer sur Mac](#installer-sur-mac) — le plus simple, sans rien compiler
- [Installer sur iPad et iPhone](#installer-sur-ipad-et-iphone) — avec un Mac et Xcode
- [Synchroniser ses appareils](#synchroniser-ses-appareils)
- [Travailler à deux sur une note](#travailler-à-deux-sur-une-note)
- [Structure du projet](#structure-du-projet)
- [Comment c'est construit](#comment-cest-construit)
- [Compiler soi-même](#compiler-soi-même)
- [Licence](#licence)

## Ce que fait Espaces

**Écrire.** Un éditeur de texte en blocs : titres, listes, tâches, citations, encadrés, code, tableaux (tri, fusion
de cellules, ligne de total), graphiques (barres, camembert, mapping), images, pages d'un PDF, notes vocales, blocs
dépliables. Tapez `/` pour tout insérer. Correcteur d'orthographe, historique des versions de chaque carte
(et retour à une version précédente), présentation par pages A4.

**Écrire à la main.** Des feuilles manuscrites (lignes, carreaux, points) pour l'Apple Pencil ou le doigt : stylo,
crayon, surligneur, gomme, formes qui se redressent toutes seules (tenez le trait immobile), règle, sélection au lasso,
copier-coller de traits, conversion de l'écriture en texte, recherche dans l'écriture manuscrite, feuille en pleine
largeur (clic droit ou appui long sur la feuille).

**Apprendre et faire jouer.** Des blocs interactifs : quiz, mot à découvrir, trou à compléter, carte à gratter,
énigme, chemin à choix, avant / après, galerie, zone de réponse, pause respiration, liens entre cartes.

**Ranger.** Les cartes vivent dans des espaces et sous-espaces, présentés en roue ; on navigue d'un espace à l'autre,
on déplace, colore, recherche.

**Présenter.** Chaque carte se lit comme une présentation, avec une « mise en scène » au choix (diapositives, film,
machine à écrire, lettre, carnet, album, planète, portes, encre…), une météo (pluie, pétales, lucioles, aurore…),
des notes pour l'orateur (touche `N`), et l'enchaînement direct vers la présentation suivante.

**Partager.** Export d'un espace entier en fichier `.espace` (à ouvrir dans Espaces), export HTML, et notes partagées
avec une autre personne (voir plus bas).

## Installer sur Mac

1. Ouvrez la page [**Releases**](../../releases/latest) de ce dépôt et téléchargez `Espaces-macOS.zip`.
2. Double-cliquez sur le zip, puis glissez **Espaces** dans le dossier **Applications**.
3. La première fois, macOS bloque l'app, parce qu'elle n'est pas signée par un compte développeur payant :
   - ouvrez **Réglages Système › Confidentialité et sécurité**, descendez jusqu'au message sur Espaces et cliquez sur
     **Ouvrir quand même** ;
   - ou faites un clic droit sur l'app › **Ouvrir**.

   Ce n'est demandé qu'une fois.

Il faut macOS 12 (Monterey) ou plus récent. Vos textes sont enregistrés sur votre Mac, dans
`~/Library/Application Support/Espaces/`. Rien n'est envoyé nulle part, sauf si vous activez la synchronisation iCloud.

## Installer sur iPad et iPhone

Espaces n'est pas sur l'App Store : on l'installe soi-même depuis un Mac, gratuitement, avec son identifiant Apple.
Avec un identifiant gratuit, l'app doit être réinstallée tous les **7 jours** (les textes restent, seule l'app est
remplacée).

**Une seule fois :**

1. Installez **Xcode** depuis l'App Store du Mac, ouvrez-le une fois et laissez-le installer ses composants
   (avec la plateforme iOS).
2. Dans Xcode › **Réglages… › Comptes**, ajoutez votre identifiant Apple.
3. Récupérez le projet : bouton vert **Code › Download ZIP** sur cette page (ou `git clone`), puis décompressez-le.
4. Ouvrez `ios/Espaces.xcodeproj` dans Xcode. Dans l'onglet **Signing & Capabilities**, choisissez votre équipe
   (« Votre nom (Personal Team) »).
5. Branchez l'iPad ou l'iPhone, déverrouillez-le et acceptez **Faire confiance à cet ordinateur**. Sur l'appareil,
   activez le **Mode développeur** (Réglages › Confidentialité et sécurité), puis lancez une fois avec ▶ dans Xcode.
6. Sur l'appareil, autorisez votre identifiant : **Réglages › Général › VPN et gestion de l'appareil**.
7. Dans le Terminal, depuis le dossier du projet :

   ```bash
   ios/configurer.sh
   ```

   Il retrouve votre équipe Apple et l'enregistre dans `ios/equipe.local` (propre à votre Mac).

**Ensuite, pour installer ou réinstaller** (appareil branché, ou sur le même Wi-Fi que le Mac, et déverrouillé) :

```bash
ios/installer-sur-ipad.sh
```

```bash
ios/installer-sur-iphone.sh
```

Ou, plus simple, avec l'**Installeur** : une petite app Mac qui fait la même chose en un clic et rappelle quand l'app
va expirer.

```bash
tools/installeur/build.sh
```

Elle s'installe dans `~/Applications/Installeur Espaces.app`.

## Synchroniser ses appareils

Dans Espaces : **Fichier › Synchroniser avec iCloud…**, puis choisissez un dossier dans iCloud Drive (le même sur chaque
appareil). Ce qui est rangé dans l'espace **iCloud** se synchronise ; le reste reste sur l'appareil. Chaque appareil
travaille hors ligne et fusionne les changements carte par carte, la plus récente l'emporte, et une suppression est
retenue pour ne pas revenir.

Quand deux appareils sont proches (même Wi-Fi ou Bluetooth), ils s'échangent aussi les changements en direct.

## Travailler à deux sur une note

Pour écrire à deux sur une même note, chacun avec son propre compte iCloud :

1. Dans le Finder, créez un dossier dans iCloud Drive, puis clic droit › **Partager › Partager le dossier** : invitez
   l'autre personne, avec le droit de modifier.
2. Dans Espaces, ouvrez la note : bouton **Exporter › Travailler à deux › Partager cette note…**, et choisissez ce
   dossier.
3. L'autre personne : **Fichier › Rejoindre une note partagée…**, et elle choisit le même dossier.

Les modifications se fusionnent paragraphe par paragraphe (et mot par mot dans un même paragraphe). À proximité,
chacun voit le curseur de l'autre et les changements arrivent en direct.

## Structure du projet

```
Espaces/
├── web/                    L'app elle-même : la même page sur Mac, iPad et iPhone
│   ├── index.html          La structure de l'interface (espaces, éditeur, lecteur, menus)
│   ├── app.js              Toute la logique : bibliothèque, éditeur, encre, présentations, synchronisation
│   └── styles.css          L'apparence, du Mac à l'iPhone
│
├── native/                 L'app Mac (Swift), qui affiche la page web et lui donne accès au système
│   ├── main.swift          Fenêtre, enregistrement, fichiers, iCloud, notes partagées, impression
│   ├── peer.swift          Lien direct entre appareils proches (partagé avec iOS)
│   ├── pdfexport.swift     Export PDF
│   ├── inktext.swift       Reconnaissance de l'écriture manuscrite
│   ├── spell.swift         Correcteur d'orthographe
│   ├── voice.swift         Notes vocales (partagé avec iOS)
│   ├── icon.swift          Dessine l'icône (la roue de cartes)
│   └── Info.plist
│
├── ios/                    L'app iPad et iPhone
│   ├── Espaces.xcodeproj   Le projet Xcode
│   ├── Espaces/
│   │   ├── AppDelegate.swift   Le pendant iOS de native/main.swift
│   │   ├── Phone.swift         Ce qui est propre à l'iPhone
│   │   └── Assets.xcassets     L'icône
│   ├── configurer.sh       Trouve votre équipe Apple (une seule fois par Mac)
│   ├── reglages.sh         Lu par les deux scripts suivants
│   ├── installer-sur-ipad.sh
│   └── installer-sur-iphone.sh
│
├── tools/installeur/       L'Installeur : une petite app Mac (SwiftUI) pour installer sur iPad et iPhone en un clic
├── build.sh                Construit l'app Mac dans build/Espaces.app
├── docs/                   Images du README
└── LICENSE                 GPL-3.0
```

## Comment c'est construit

Espaces est une seule page web (`web/`), en JavaScript sans bibliothèque ni étape de compilation, affichée dans une
vue web (`WKWebView`) par une petite app native : `native/main.swift` sur Mac, `ios/Espaces/AppDelegate.swift` sur iPad
et iPhone. La page parle à l'app native par messages (`window.webkit.messageHandlers.native`) pour ce qu'un navigateur
ne sait pas faire : enregistrer la bibliothèque, lire et écrire dans iCloud Drive, importer un PDF, reconnaître
l'écriture, enregistrer la voix, joindre les appareils proches.

- **La bibliothèque** est un seul fichier JSON (`library.json`) : les espaces, leurs cartes (le texte en HTML) et
  l'historique des versions. Les images y sont incluses.
- **La synchronisation** passe par un fichier dans un dossier iCloud Drive choisi par l'utilisateur, relu et fusionné
  à chaque changement. Sur iPhone, où la mémoire de la page est comptée, les versions des cartes sont rangées à part
  par l'app native, une carte à la fois.
- **Le lien direct** entre appareils proches utilise Bonjour (`_espaces._tcp`, voir `native/peer.swift`).
- **L'écriture manuscrite** est dessinée en SVG ; la reconnaissance de l'écriture utilise Vision (Apple).

On peut aussi ouvrir `web/index.html` dans un navigateur pour essayer l'app : tout fonctionne, sauf ce qui demande
l'app native (iCloud, PDF, voix…), et la bibliothèque est alors gardée dans le navigateur.

## Compiler soi-même

Il faut les outils en ligne de commande de Xcode (`xcode-select --install`), ou Xcode.

```bash
./build.sh
```

L'app Mac est construite dans `build/Espaces.app`. Pour iPad et iPhone, voir
[Installer sur iPad et iPhone](#installer-sur-ipad-et-iphone).

## Licence

Espaces est un logiciel libre, distribué sous licence [GNU GPL v3](LICENSE) : vous pouvez l'utiliser, l'étudier, le
modifier et le redistribuer, à condition que les versions redistribuées restent libres, sous la même licence.
