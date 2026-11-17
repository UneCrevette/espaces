#!/bin/zsh
# Prépare ce Mac à installer Espaces sur un iPad ou un iPhone : trouve l'équipe Apple (celle de l'identifiant Apple
# ajouté dans Xcode › Réglages › Comptes) et choisit un identifiant d'app à soi. Le résultat va dans ios/equipe.local.
set -euo pipefail
cd "$(dirname "$0")"

# les certificats « Apple Development » de ce Mac portent l'identifiant de leur équipe (le champ OU)
teams=("${(@f)$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
  | awk '/BEGIN CERT/{c=""} {c=c $0 "\n"} /END CERT/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' \
  | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | sort -u)}")
teams=(${teams:#})

if (( ${#teams} == 0 )); then
  cat <<'EOF'
Aucune équipe Apple trouvée sur ce Mac. Une seule fois :
  1. ouvrez Xcode › Réglages… › Comptes, ajoutez votre identifiant Apple (gratuit) ;
  2. ouvrez ios/Espaces.xcodeproj dans Xcode, onglet « Signing & Capabilities », choisissez votre équipe
     (« Votre nom (Personal Team) »), branchez l'iPad ou l'iPhone et lancez une fois avec ▶ ;
  3. relancez ./configurer.sh.
Ou, si vous connaissez l'identifiant de votre équipe (10 caractères) : ./configurer.sh ABCDE12345
EOF
  [[ $# -ge 1 ]] || exit 1
fi
TEAM=${1:-${teams[1]}}
if (( ${#teams} > 1 && $# == 0 )); then
  echo "Plusieurs équipes trouvées : ${teams[*]}. Celle-ci est retenue : $TEAM (pour une autre : ./configurer.sh IDENTIFIANT)."
fi
# un identifiant d'app ne peut appartenir qu'à une équipe : chacun a le sien. Celui déjà réglé ne change jamais
# (un autre identifiant installerait une seconde app, vide, à côté de la première)
OLD_BUNDLE=$( [[ -f equipe.local ]] && sed -n 's/^BUNDLE=//p' equipe.local || true )
BUNDLE=${ESPACES_BUNDLE:-${OLD_BUNDLE:-io.espaces.app.${TEAM:l}}}
printf 'TEAM=%s\nBUNDLE=%s\n' "$TEAM" "$BUNDLE" > equipe.local
echo "OK : équipe $TEAM, app $BUNDLE. Vous pouvez lancer ./installer-sur-ipad.sh ou ./installer-sur-iphone.sh."
