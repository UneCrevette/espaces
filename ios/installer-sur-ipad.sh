#!/bin/zsh
# Compile, signe et installe Espaces sur l'iPad, en USB ou en Wi-Fi (à relancer quand l'app a expiré, tous les 7 jours
# avec un identifiant Apple gratuit). L'iPad garde ses données : seule l'app est remplacée.
set -euo pipefail
cd "$(dirname "$0")"
source ./reglages.sh
OUT=build-ipad
# l'iPad, branché en USB ou joignable en Wi-Fi (même réseau que le Mac) ; on lui laisse une minute pour apparaître
find_ipad() { xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /iPad/ && !/unavailable/ && (/ connected / || /available/) { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) print $i }' | head -1 }
DEVICE=$(find_ipad)
for i in {1..20}; do
  [[ -n "$DEVICE" ]] && break
  (( i == 1 )) && echo "En attente de l'iPad (déverrouillez-le ; en Wi-Fi, il doit être sur le même réseau que le Mac)…"
  sleep 3
  DEVICE=$(find_ipad)
done
if [[ -z "$DEVICE" ]]; then echo "Aucun iPad trouvé : branchez-le, ou mettez-le sur le même Wi-Fi que le Mac, déverrouillé."; exit 1; fi
echo "→ Compilation pour l'iPad $DEVICE…"
xcodebuild -project Espaces.xcodeproj -scheme Espaces -configuration Release -destination "id=$DEVICE" \
  -derivedDataPath "$OUT" DEVELOPMENT_TEAM=$TEAM PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE -allowProvisioningUpdates -quiet build
echo "→ Installation…"
xcrun devicectl device install app --device "$DEVICE" "$OUT/Build/Products/Release-iphoneos/Espaces.app" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" >/dev/null 2>&1 || true
echo "OK : Espaces est installé sur l'iPad."
