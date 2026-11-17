# Réglages communs aux scripts d'installation : l'équipe Apple qui signe l'app, et l'identifiant de l'app.
# Ils viennent de ios/equipe.local (propre à chaque Mac, jamais publié), créé par ./configurer.sh.
if [[ ! -f equipe.local ]]; then
  echo "Première fois sur ce Mac : lancez d'abord ./configurer.sh (il trouve votre équipe Apple)."
  exit 1
fi
source ./equipe.local
if [[ -z "${TEAM:-}" || -z "${BUNDLE:-}" ]]; then echo "ios/equipe.local est incomplet : relancez ./configurer.sh."; exit 1; fi
