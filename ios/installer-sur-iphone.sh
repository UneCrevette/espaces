#!/bin/zsh
# Compile, signe et installe Espaces sur l'iPhone, en USB ou en Wi-Fi (à relancer quand l'app a expiré, tous les 7 jours
# avec un identifiant Apple gratuit). L'iPhone garde ses données : seule l'app est remplacée.
set -euo pipefail
cd "$(dirname "$0")"
source ./reglages.sh
OUT=build-iphone
find_iphone() { xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /iPhone/ && !/unavailable/ && (/ connected / || /available/) { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) print $i }' | head -1 }
DEVICE=$(find_iphone)
for i in {1..20}; do
  [[ -n "$DEVICE" ]] && break
  (( i == 1 )) && echo "En attente de l'iPhone (déverrouillez-le ; en Wi-Fi, il doit être sur le même réseau que le Mac)…"
  sleep 3
  DEVICE=$(find_iphone)
done
if [[ -z "$DEVICE" ]]; then echo "Aucun iPhone trouvé : branchez-le, déverrouillez-le et faites-lui confiance."; exit 1; fi
echo "→ Compilation pour l'iPhone $DEVICE…"
xcodebuild -project Espaces.xcodeproj -scheme Espaces -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath "$OUT" DEVELOPMENT_TEAM=$TEAM PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE -allowProvisioningUpdates -quiet build
echo "→ Installation…"
xcrun devicectl device install app --device "$DEVICE" "$OUT/Build/Products/Release-iphoneos/Espaces.app" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" >/dev/null 2>&1 || true
echo "OK : Espaces est installé sur l'iPhone."
